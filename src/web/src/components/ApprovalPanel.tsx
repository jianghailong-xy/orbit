import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo, PermissionRule } from '../api';
import { bashCommandRules } from '@orbit/shared';

// claude routes plan-mode "exit?" through the same permission tool as any other gated
// call; ExitPlanMode is the one worth a rich render (its input carries the plan).
const isPlan = (a: ApprovalInfo): boolean => a.toolName === 'ExitPlanMode';

// Orbit's own ask, not the engine's permission prompt for a tool call: a batch of dependency
// edits, raised by tasklist_propose_dag with the server-computed impact attached. Rendered richly
// because the ops are not the decision — what results from them is.
const isDagChange = (a: ApprovalInfo): boolean => a.toolName === 'orbit_dag_change';

interface DagPreview {
  listTitle?: string;
  ops?: Array<{
    op: 'add' | 'remove';
    taskTitle?: string;
    dependsOnTitle?: string;
    noop?: boolean;
  }>;
  changes?: Array<{ taskId: string; title?: string; from: string; to: string }>;
  becomingRunnable?: number;
  becomingManual?: number;
  becomingBlocked?: number;
  effectiveCount?: number;
  edgesBefore?: number;
  edgesAfter?: number;
}

/** Orbit's other own ask: a batch of new tasks, which is how a DAG gets built in the first place. */
const isBatch = (a: ApprovalInfo): boolean => a.toolName === 'orbit_task_batch';

interface BatchPreview {
  taskCount?: number;
  startingNow?: number;
  blocked?: number;
  needsManualStart?: number;
  notDispatchable?: number;
  internalEdges?: number;
  externalEdges?: number;
  lists?: Array<{ id: string; title: string }>;
  assignees?: Array<{ id: string; name: string; hasRunner: boolean }>;
  tasks?: Array<{ title: string; dependsOnRefs?: string[]; dependsOnTaskIds?: string[]; ref?: string | null }>;
  titlesTruncated?: number;
}

function batchPreview(input: unknown): BatchPreview {
  const obj = (input ?? {}) as { preview?: BatchPreview };
  return obj.preview ?? {};
}

function dagInput(input: unknown): { preview: DagPreview; note: string } {
  const obj = (input ?? {}) as { preview?: DagPreview; note?: unknown };
  return {
    preview: obj.preview ?? {},
    note: typeof obj.note === 'string' ? obj.note : '',
  };
}

function planText(input: unknown): string {
  if (input && typeof input === 'object' && 'plan' in input) {
    const p = (input as { plan?: unknown }).plan;
    if (typeof p === 'string') return p;
  }
  return '';
}

// Derive the rules for "always allow", or [] when none apply: questions/plans aren't
// repeatable. A Bash line yields one rule per distinct sub-command prefix (so `cd x && git
// add …` remembers both, not just the leading `cd`); other tools get a single tool-wide rule
// (no ruleContent).
function rememberRulesFor(a: ApprovalInfo): PermissionRule[] {
  // A DAG change joins questions and plans in having no repeatable form. "Always allow
  // restructuring this campaign's dependencies" is not a rule anyone means to write, and the
  // whole point of the card is that each batch releases a different set of tasks.
  if (a.toolName === 'AskUserQuestion' || isPlan(a) || isDagChange(a) || isBatch(a)) return [];
  if (a.toolName === 'Bash') {
    const cmd =
      a.input && typeof a.input === 'object'
        ? (a.input as { command?: unknown }).command
        : undefined;
    return typeof cmd === 'string' ? bashCommandRules(cmd) : [];
  }
  return [{ toolName: a.toolName }];
}

// The command prefixes (or tool name for non-Bash) behind a set of remember rules.
function ruleNames(rules: PermissionRule[]): string[] {
  return rules.map((r) =>
    r.toolName === 'Bash' && r.ruleContent ? r.ruleContent.replace(/:\*$/, '') : r.toolName,
  );
}

// The human-readable scope shown on the "remember" button, capped so a long compound
// line stays readable (the full list rides along in the button's title).
function rememberLabel(rules: PermissionRule[]): string {
  const names = ruleNames(rules);
  return names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} +${names.length - 4}`;
}

type OnDecide = (
  id: string,
  behavior: 'allow' | 'deny',
  answers?: Record<string, string[]>,
  message?: string,
  rememberRules?: PermissionRule[],
) => void;

// The modifier hotkey accepts metaKey || ctrlKey on every platform; only the hint label
// is platform-specific — ⌘ on macOS, Ctrl elsewhere. Plain Enter has no modifier.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const SHORTCUT_HINT = IS_MAC ? '⌘ + Enter' : 'Ctrl + Enter';
const ENTER_HINT = 'Enter';

/** Fires the card's action on Enter while it's the active card (the first pending one).
 *  By default requires ⌘/Ctrl + Enter; pass { requireMod: false } for a plain Enter — and
 *  then the modifier chord is ignored, so a separate mod-Enter binding can own it. Skipped
 *  while a field is focused (so it never clashes with the composer); plain Enter also yields
 *  to a focused button so it doesn't double-fire with that button's own Enter. */
function useApproveHotkey(active: boolean, onTrigger: () => void, opts?: { requireMod?: boolean }): void {
  const requireMod = opts?.requireMod ?? true;
  const fn = useRef(onTrigger);
  fn.current = onTrigger;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      const hasMod = e.metaKey || e.ctrlKey;
      if (requireMod ? !hasMod : hasMod) return;
      const el = document.activeElement;
      const isField =
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      const isButton = el instanceof HTMLElement && el.tagName === 'BUTTON';
      if (isField || (!requireMod && isButton)) return;
      e.preventDefault();
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, requireMod]);
}

/** An inline card for a pending tool-permission request: an interactive multiple-choice
 *  form for AskUserQuestion, otherwise a plain allow/deny (with a rich render for plans). */
export function ApprovalPanel({
  approval,
  onDecide,
  active = false,
  onChatAbout,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  active?: boolean;
  onChatAbout?: (id: string, question: string) => void;
}): JSX.Element {
  const isQuestion = approval.toolName === 'AskUserQuestion';
  // "Always allow" — the running session stops asking (claude's engine matches future calls),
  // and the rule is kept on this session's workspace so its other sessions start with it too.
  // Empty for questions/plans and Bash commands with no clean prefix; a compound Bash line
  // yields one rule per distinct sub-command.
  const rules = isQuestion ? [] : rememberRulesFor(approval);
  // Plain card: Enter approves; ⌘/Ctrl + Enter always-allows (only when that option exists).
  // Questions have no submit hotkey — they submit only via the Submit button.
  useApproveHotkey(active && !isQuestion, () => onDecide(approval.id, 'allow'), { requireMod: false });
  useApproveHotkey(active && !isQuestion && rules.length > 0, () => {
    if (rules.length) onDecide(approval.id, 'allow', undefined, undefined, rules);
  });
  if (isQuestion) {
    return (
      <QuestionForm approval={approval} onDecide={onDecide} onChatAbout={onChatAbout} />
    );
  }
  const plan = isPlan(approval) ? planText(approval.input) : '';
  const dag = isDagChange(approval) ? dagInput(approval.input) : null;
  const batch = isBatch(approval) ? batchPreview(approval.input) : null;
  return (
    <div className="approval-card">
      <div className="approval-head">
        {isPlan(approval)
          ? '📋 Confirm: exit plan mode and proceed with this plan?'
          : dag
            ? `🔗 Confirm: restructure dependencies in ${dag.preview.listTitle ?? 'this list'}?`
            : batch
              ? `🧩 Confirm: create ${batch.taskCount ?? 0} task${batch.taskCount === 1 ? '' : 's'}?`
              : `🔓 Approve tool call: ${approval.toolName}`}
      </div>
      <div className={`approval-body${plan ? ' is-plan' : ''}`}>
        {plan ? (
          <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
        ) : dag ? (
          <DagChangeBody note={dag.note} preview={dag.preview} />
        ) : batch ? (
          <BatchCreateBody preview={batch} />
        ) : (
          <pre className="approval-input">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
        )}
      </div>
      <div className="approval-actions">
        <button className="approval-btn approve" onClick={() => onDecide(approval.id, 'allow')}>
          {isPlan(approval) ? 'Approve & run' : dag ? 'Apply changes' : batch ? 'Create them' : 'Approve'}
          {active && <span className="approval-btn-kbd">{ENTER_HINT}</span>}
        </button>
        {rules.length > 0 && (
          <button
            className="approval-btn approve-always"
            title={`Stop asking about calls like this — here and in this workspace's other sessions: ${ruleNames(rules).join(', ')}. Revocable in the workspace's settings.`}
            onClick={() => onDecide(approval.id, 'allow', undefined, undefined, rules)}
          >
            Always allow <code className="approval-rule">{rememberLabel(rules)}</code>
            {active && <span className="approval-btn-kbd">{SHORTCUT_HINT}</span>}
          </button>
        )}
        <button className="approval-btn deny" onClick={() => onDecide(approval.id, 'deny')}>
          {isPlan(approval)
            ? 'Keep planning'
            : dag
              ? 'Leave the graph alone'
              : batch
                ? 'Create nothing'
                : 'Reject'}
        </button>
      </div>
    </div>
  );
}

/**
 * What a batch would create, led by how much of it starts running.
 *
 * The titles are the least useful part and the most eye-catching, so they come last and only a
 * window of them. The decision is the counts: fifty tasks of which forty-eight wait on each other
 * costs two runs, and fifty independent ones costs fifty.
 */
function BatchCreateBody({ preview }: { preview: BatchPreview }): JSX.Element {
  const starting = preview.startingNow ?? 0;
  const blocked = preview.blocked ?? 0;
  const manual = preview.needsManualStart ?? 0;
  const inert = preview.notDispatchable ?? 0;
  const edges = (preview.internalEdges ?? 0) + (preview.externalEdges ?? 0);
  return (
    <div className="dag-approval">
      <div className="dag-approval-impact">
        <span className={`dag-impact${starting > 0 ? ' dag-impact--run' : ''}`}>
          {starting} start{starting === 1 ? 's' : ''} running within the minute
        </span>
        {blocked > 0 && <span className="dag-impact">{blocked} wait on a prerequisite</span>}
        {manual > 0 && (
          // Every root of a new DAG. Auto-run starts a task when a prerequisite finishes, so one
          // with no prerequisites is never picked up however unblocked it looks — saying "will
          // start" here is what this card got wrong before it was ever used.
          <span className="dag-impact">
            {manual} need{manual === 1 ? 's' : ''} a manual start — nothing will trigger {manual === 1 ? 'it' : 'them'}
          </span>
        )}
        {inert > 0 && (
          // Not the same as blocked: nothing finishing will release these. They sit until a
          // person assigns them, so a batch that is silently all of these did nothing at all.
          <span className="dag-impact dag-impact--block">
            {inert} cannot run — unassigned, no runner, or auto-run off
          </span>
        )}
      </div>
      {(preview.lists?.length ?? 0) > 0 && (
        <p className="dag-approval-foot">
          into {preview.lists!.map((l) => l.title).join(', ')}
          {edges > 0 && ` · ${edges} dependency edge${edges === 1 ? '' : 's'}`}
        </p>
      )}
      <p className="dag-approval-caption">Tasks</p>
      <ul className="dag-approval-ops">
        {(preview.tasks ?? []).map((t, i) => (
          <li key={i} className="dag-op">
            <span className="dag-op-verb">+</span>
            <span className="dag-op-text">{t.title}</span>
            {((t.dependsOnRefs?.length ?? 0) + (t.dependsOnTaskIds?.length ?? 0)) > 0 && (
              <span className="dag-op-noop">
                waits on {(t.dependsOnRefs?.length ?? 0) + (t.dependsOnTaskIds?.length ?? 0)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {(preview.titlesTruncated ?? 0) > 0 && (
        <p className="dag-approval-foot">+{preview.titlesTruncated} more</p>
      )}
    </div>
  );
}

/**
 * What a dependency restructure would do, in the order a person decides in.
 *
 * The consequence leads, because it is the part that is not visible in the ops. A batch reading
 * "remove 4 edges" is unremarkable until you know it releases 40 tasks, and the sweep collects
 * those within the minute — the edges are what is written, the released tasks are what happens.
 */
function DagChangeBody({ note, preview }: { note: string; preview: DagPreview }): JSX.Element {
  const runnable = preview.becomingRunnable ?? 0;
  const manual = preview.becomingManual ?? 0;
  const blocked = preview.becomingBlocked ?? 0;
  const ops = preview.ops ?? [];
  return (
    <div className="dag-approval">
      {note && <p className="dag-approval-note">{note}</p>}
      <div className="dag-approval-impact">
        {runnable > 0 && (
          <span className="dag-impact dag-impact--run">
            {runnable} task{runnable === 1 ? '' : 's'} become runnable — these start on the next sweep
          </span>
        )}
        {blocked > 0 && (
          <span className="dag-impact dag-impact--block">
            {blocked} task{blocked === 1 ? ' stops' : 's stop'} being runnable
          </span>
        )}
        {manual > 0 && (
          // Freed from waiting and still not going anywhere: losing your last prerequisite means
          // nothing is left to trigger you.
          <span className="dag-impact">
            {manual} stop{manual === 1 ? 's' : ''} waiting, but now need{manual === 1 ? 's' : ''} a manual start
          </span>
        )}
        {runnable === 0 && blocked === 0 && manual === 0 && (
          <span className="dag-impact">No task changes state — this only rewrites edges</span>
        )}
      </div>
      {ops.length > 0 && <p className="dag-approval-caption">Edges written</p>}
      <ul className="dag-approval-ops">
        {ops.map((o, i) => (
          <li key={i} className={`dag-op dag-op--${o.op}${o.noop ? ' is-noop' : ''}`}>
            <span className="dag-op-verb">{o.op === 'add' ? '+' : '−'}</span>
            <span className="dag-op-text">
              {o.taskTitle} {o.op === 'add' ? 'waits on' : 'no longer waits on'} {o.dependsOnTitle}
            </span>
            {o.noop && <span className="dag-op-noop">already so</span>}
          </li>
        ))}
      </ul>
      {(preview.changes?.length ?? 0) > 0 && (
        <>
        <p className="dag-approval-caption">Tasks that change state as a result</p>
        <ul className="dag-approval-changes">
          {preview.changes!.map((c) => (
            <li key={c.taskId}>
              <span className="dag-change-title">{c.title ?? c.taskId}</span>
              <span className="dag-change-move">
                {c.from} → {c.to}
              </span>
            </li>
          ))}
        </ul>
        </>
      )}
      <p className="dag-approval-foot">
        {preview.edgesBefore} → {preview.edgesAfter} edges
      </p>
    </div>
  );
}

type QOption = { label?: string; description?: string };
type QItem = { question?: string; header?: string; options?: QOption[]; multiSelect?: boolean };

function questionsOf(input: unknown): QItem[] {
  if (input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions)) {
    return (input as { questions: QItem[] }).questions;
  }
  return [];
}

/** AskUserQuestion: pick option(s) per question and submit, like Claude's TUI. The picks
 *  ride back to claude as `answers` (question text → labels) on an `allow`. */
function QuestionForm({
  approval,
  onDecide,
  onChatAbout,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  onChatAbout?: (id: string, question: string) => void;
}): JSX.Element {
  const questions = questionsOf(approval.input);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  // Free-text answers, keyed by question text — claude's AskUserQuestion always lets
  // the user type their own answer instead of picking a listed option.
  const [custom, setCustom] = useState<Record<string, string>>({});
  // "Chat about this": rather than picking an option, the user replies conversationally
  // in the main composer (handled by WorkspaceView via onChatAbout). The reply still rides back
  // as a `deny` message so claude reads it as in-turn feedback instead of a forced option.
  const chatLabel = questions[0]?.header || questions[0]?.question || '';

  const toggle = (q: string, label: string, multi: boolean) => {
    setSel((prev) => {
      const cur = prev[q] ?? [];
      if (multi) {
        return { ...prev, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q]: cur.includes(label) ? [] : [label] };
    });
    // Single-select: a listed option and free text are mutually exclusive.
    if (!multi) setCustom((prev) => (prev[q] ? { ...prev, [q]: '' } : prev));
  };

  const onCustom = (q: string, value: string, multi: boolean) => {
    setCustom((prev) => ({ ...prev, [q]: value }));
    // Single-select: typing a custom answer clears any picked option.
    if (!multi && value.trim()) setSel((prev) => (prev[q]?.length ? { ...prev, [q]: [] } : prev));
  };

  // A question is answered once it has a picked option or non-empty typed text.
  const answered = (qq: QItem): boolean => {
    const q = qq.question ?? '';
    return (sel[q]?.length ?? 0) > 0 || (custom[q]?.trim().length ?? 0) > 0;
  };
  const complete = questions.length > 0 && questions.every(answered);

  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string[]> = {};
    for (const qq of questions) {
      const q = qq.question ?? '';
      const picks = [...(sel[q] ?? [])];
      const typed = custom[q]?.trim();
      if (typed) picks.push(typed);
      if (q && picks.length) answers[q] = picks;
    }
    onDecide(approval.id, 'allow', answers);
  };

  return (
    <div className="approval-card">
      <div className="approval-head">❓ Claude has a question for you</div>
      <div className="approval-body is-questions">
        <div className="chat-questions">
          {questions.map((qq, k) => {
            const q = qq.question ?? '';
            const multi = !!qq.multiSelect;
            const picked = sel[q] ?? [];
            return (
              <div className="chat-q" key={k}>
                {qq.header && <div className="chat-q-header">{qq.header}</div>}
                {q && <div className="chat-q-text">{q}</div>}
                <div className="chat-q-opts">
                  {(qq.options ?? []).map((o, j) => {
                    const label = o?.label ?? '';
                    const on = picked.includes(label);
                    return (
                      <button
                        type="button"
                        className={`chat-q-opt chat-q-opt-btn${on ? ' is-picked' : ''}`}
                        key={j}
                        onClick={() => toggle(q, label, multi)}
                      >
                        <span className="chat-q-opt-label">{label}</span>
                        {o?.description && <span className="chat-q-opt-desc">{o.description}</span>}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="chat-q-custom"
                  placeholder="Or type your own answer…"
                  value={custom[q] ?? ''}
                  onChange={(e) => onCustom(q, e.target.value, multi)}
                />
                {multi && <div className="chat-q-multi">Multiple choice</div>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="approval-actions">
        <button className="approval-btn approve" disabled={!complete} onClick={submit}>
          Submit
        </button>
        <button className="approval-btn chat" onClick={() => onChatAbout?.(approval.id, chatLabel)}>
          💬 Chat about this
        </button>
      </div>
    </div>
  );
}
