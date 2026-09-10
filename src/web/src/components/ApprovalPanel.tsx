import { useEffect, useRef, useState, type JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo, PermissionRule } from '../api';
import { BatchGraph } from './BatchGraph';
import { CardActionButton, CardActions } from './CardAction';
import {
  CONFIRM_LABEL,
  SEND_BACK_LABEL,
  STRIP_LABEL,
  decisionRowKey,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import {
  DECISION_ASK_HEADING,
  DECISION_CONFIRM_ACTION,
  DECISION_SEND_BACK_ACTION,
  EvidenceDecisionActions,
  EvidenceDecisionFacts,
} from './EvidenceDecisionCard';
import { buildBatchGraph, describeShape, shouldDraw } from '../lib/batchGraph';
import { bashCommandRules } from '@orbit/shared';

/**
 * What the card says once nothing is listening for its answer.
 *
 * A card is `answerable={false}` when the turn that raised it is over — see WorkspaceView, which
 * computes it from the same two committed facts the server filters `listApprovals` on. Nothing was
 * written to the approval when that happened (the engine writes nothing at all when it abandons a
 * call), so the row still says PENDING and always will; what changed is that the poll loop which
 * would have carried a decision back died with the turn.
 *
 * The card stays on screen rather than vanishing. It is the only place the question is written
 * down, and a card that silently disappears mid-read is indistinguishable from one somebody else
 * answered. So it keeps its content, loses every action (`CardAction`'s one rule: an action that
 * cannot succeed is `disabled`) and carries this line.
 *
 * It names the pinned strip because the strip still COUNTS what is waiting — and no longer because
 * the strip is somewhere else to answer it. That is the whole of the 2026-09-09 change: the rail
 * was the second decision surface and now it is a pointer, so the sentence that used to send a
 * reader there to press a button says instead that the question comes back.
 */
export const UNANSWERABLE_NOTE =
  `This turn has ended, so an answer here would reach nobody. It is still waiting — ` +
  `"${STRIP_LABEL}" above counts it, and the coordinator session raises it again when it runs.`;

/** The line a dead card carries in place of its actions. */
function UnanswerableNote(): JSX.Element {
  return <p className="approval-stale">{UNANSWERABLE_NOTE}</p>;
}

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
  answerable = true,
  onChatAbout,
  decisions,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  active?: boolean;
  /** Whether an answer to this card can still reach anybody — see UNANSWERABLE_NOTE. */
  answerable?: boolean;
  onChatAbout?: (id: string, question: string) => void;
  /** This session's pending evidence decisions, as the rail reads them. Present only so a question
   *  that IS one of those rows can be rendered FROM the row; every other card ignores it. */
  decisions?: PendingDecisionQueue | null;
}): JSX.Element {
  const isQuestion = approval.toolName === 'AskUserQuestion';
  // A dead card owns no hotkey and shows no shortcut hint: the caller already skips it when
  // choosing the active card, and this holds even when something else calls it directly.
  const armed = active && answerable;
  // "Always allow" — the running session stops asking (claude's engine matches future calls),
  // and the rule is kept on this session's workspace so its other sessions start with it too.
  // Empty for questions/plans and Bash commands with no clean prefix; a compound Bash line
  // yields one rule per distinct sub-command.
  const rules = isQuestion ? [] : rememberRulesFor(approval);
  // Plain card: Enter approves; ⌘/Ctrl + Enter always-allows (only when that option exists).
  // Questions have no submit hotkey — they submit only via the Submit button.
  useApproveHotkey(armed && !isQuestion, () => onDecide(approval.id, 'allow'), { requireMod: false });
  useApproveHotkey(armed && !isQuestion && rules.length > 0, () => {
    if (rules.length) onDecide(approval.id, 'allow', undefined, undefined, rules);
  });
  if (isQuestion) {
    // The one question this file recognises by what it is about rather than by its shape — see
    // EvidenceDecisionForm's header for why there is exactly one, and what it would take to add
    // a second. Everything else, including a two-option question that merely resembles it, is a
    // form over options and is rendered as one.
    const decisionRows = evidenceDecisionRows(approval, decisions);
    return decisionRows ? (
      <EvidenceDecisionForm
        approval={approval}
        rows={decisionRows}
        onDecide={onDecide}
        answerable={answerable}
        onChatAbout={onChatAbout}
      />
    ) : (
      <QuestionForm
        approval={approval}
        onDecide={onDecide}
        answerable={answerable}
        onChatAbout={onChatAbout}
      />
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
      {!answerable && <UnanswerableNote />}
      <CardActions className="approval-actions">
        <CardActionButton
          tone="primary"
          disabled={!answerable}
          onClick={() => onDecide(approval.id, 'allow')}
        >
          {isPlan(approval) ? 'Approve & run' : dag ? 'Apply changes' : batch ? 'Create them' : 'Approve'}
          {armed && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        {rules.length > 0 && (
          <CardActionButton
            tone="accent"
            disabled={!answerable}
            title={`Stop asking about calls like this — here and in this workspace's other sessions: ${ruleNames(rules).join(', ')}. Revocable in the workspace's settings.`}
            onClick={() => onDecide(approval.id, 'allow', undefined, undefined, rules)}
          >
            Always allow <code className="approval-rule">{rememberLabel(rules)}</code>
            {armed && <span className="approval-kbd">{SHORTCUT_HINT}</span>}
          </CardActionButton>
        )}
        <CardActionButton
          tone="secondary"
          disabled={!answerable}
          onClick={() => onDecide(approval.id, 'deny')}
        >
          {isPlan(approval)
            ? 'Keep planning'
            : dag
              ? 'Leave the graph alone'
              : batch
                ? 'Create nothing'
                : 'Reject'}
        </CardActionButton>
      </CardActions>
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
  const tasks = preview.tasks ?? [];
  // Described from the window the card draws, not the whole batch — so the sentence says what the
  // picture shows, and the "+N more" below says what it does not.
  const graph = buildBatchGraph(tasks);
  const shape = describeShape(graph);
  // Drawn only while it stays legible; past that the sentence carries the shape and the list
  // carries the names, which is strictly more readable than a picture scaled into illegibility.
  const hasShape = shouldDraw(graph);
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
            {inert} cannot run — unassigned, no runner, auto-run off, or the list is paused
          </span>
        )}
      </div>
      {(preview.lists?.length ?? 0) > 0 && (
        <p className="dag-approval-foot">
          into {preview.lists!.map((l) => l.title).join(', ')}
          {edges > 0 && ` · ${edges} dependency edge${edges === 1 ? '' : 's'}`}
        </p>
      )}
      <p className="dag-approval-caption">
        Tasks{shape ? ` — ${shape}` : ''}
      </p>
      {hasShape ? (
        // Drawn only when the batch has edges. A chain of ten and ten unrelated tasks produce the
        // same list of titles and behave completely differently, and that is exactly what a
        // picture shows and a list cannot.
        <BatchGraph tasks={tasks} />
      ) : (
        <ul className="dag-approval-ops">
          {tasks.map((t, i) => (
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
      )}
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
  answerable,
  onChatAbout,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  answerable: boolean;
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
                        disabled={!answerable}
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
                  disabled={!answerable}
                  onChange={(e) => onCustom(q, e.target.value, multi)}
                />
                {multi && <div className="chat-q-multi">Multiple choice</div>}
              </div>
            );
          })}
        </div>
      </div>
      {!answerable && <UnanswerableNote />}
      <CardActions className="approval-actions">
        {/* Unanswered questions cannot be submitted, so the control that would submit them is not
            pressable — the same rule the decision card's Confirm is under. */}
        <CardActionButton tone="primary" disabled={!answerable || !complete} onClick={submit}>
          Submit
        </CardActionButton>
        {/* Chatting about it is not a way around a dead card: the reply rides back as a `deny` on
            this same approval, through the same poll loop that is no longer there to read it. */}
        <CardActionButton
          tone="outline"
          disabled={!answerable}
          onClick={() => onChatAbout?.(approval.id, chatLabel)}
        >
          💬 Chat about this
        </CardActionButton>
      </CardActions>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE EVIDENCE-DECISION CARD
   ─────────────────────────────────────────────────────────────────────────────────────────────

   THE GENERIC FORM STAYS THE DEFAULT, AND THIS IS THE ONE EXCEPTION TO IT
   -----------------------------------------------------------------------
   Everything below fires for a single shape: the card `coordinator-evidence-ask.ts` raises so a
   person can answer "is this work finished". Every other AskUserQuestion — including one whose two
   options happen to read alike — falls through to `QuestionForm` above, which is what the tool
   actually is: a form over options nobody has seen before.

   Recognising a question by what it is ABOUT is a cost, and it was taken deliberately rather than
   drifted into. A client that grows one card per kind of question ends up with N surfaces for one
   fact, and this account has already paid for that: two decision surfaces raced on 2026-09-09 and
   the loser came back `EVIDENCE_JUDGMENT_ALREADY_DECIDED`. So the rule is written down here instead
   of left to taste — ONE special case, this one, and a second one needs a better reason than "this
   question would look nicer as a card". What earns this one its exception is that it is not
   multiple choice at all: it is a judgment about a row the server already publishes in full, and
   the generic form was throwing that row away.

   THE CARD READS THE ROW, NOT THE QUESTION TEXT
   ---------------------------------------------
   `evidenceQuestionBody` flattens the claim, the criterion and the gaps into one string because a
   tool input is all AskUserQuestion carries. Rendering THAT is what produced the wall of text this
   card replaces. So the string is used for exactly two things — to say WHICH row is being asked
   about, and, verbatim and folded away, as the full text — while every line above that fold is
   read off `PendingDecisionRow`: the same row `DecisionRail` renders, out of the same
   `?decidingSessionId=` read, scoped by the same server rule. Nothing on the card is summarised,
   re-worded or inferred; each visible string is a field of that row or a count of one.
*/

/* The rest of this card's copy — its heading, the two verdicts, the reason box and the lines drawn
   over a row — lives in `EvidenceDecisionCard.tsx` with the facts and actions that say it, because
   the system card says the same words about the same row. Only what this form alone draws is here. */

/** The third answer, and deliberately the third: not judging yet is useful (it rides back as a
 *  `deny` with a message, exactly as the generic form's does) but it is not a verdict, so it does
 *  not get a verdict's weight. */
export const DECISION_CHAT_ACTION = '💬 先聊聊，暂不裁决';
export const DECISION_FULL_LABEL = '完整证据正文';

/**
 * The identity `evidenceQuestionBody` writes into the end of every decision question.
 *
 * The server puts it there so two rows whose claims read alike cannot collapse onto one `answers`
 * key. It is the ONLY part of that body this file reads, and it is read as a handle: which row is
 * this question about. A question that names no row this session may decide is not a decision card
 * and renders as the ordinary form — which is also what happens if the server ever words that line
 * differently, so the failure is a card that looks like it did yesterday rather than a wrong one.
 */
function askIdentity(row: PendingDecisionRow): string {
  return `task ${row.taskId}, evidence rev ${row.evidenceRevision}`;
}

/** The row one question is about, or null when it is not one of these questions at all. */
function decisionRowFor(question: QItem, rows: PendingDecisionRow[]): PendingDecisionRow | null {
  const labels = (question.options ?? []).map((option) => option?.label ?? '');
  // The two options the server raises, by the labels `DecisionRail` declares and the ask copies.
  if (labels.length !== 2) return null;
  if (!labels.includes(CONFIRM_LABEL) || !labels.includes(SEND_BACK_LABEL)) return null;
  const body = question.question ?? '';
  const matched = rows.filter((row) => body.includes(askIdentity(row)));
  return matched.length === 1 ? matched[0] : null;
}

/**
 * The rows this approval is asking about, or null for every other question in the world.
 *
 * All or nothing on purpose: a card that rendered some of its questions as judgments and the rest
 * as a form would be two cards in one, with one Submit between them. Either the whole ask is the
 * one shape this file knows, or none of it is.
 */
export function evidenceDecisionRows(
  approval: ApprovalInfo,
  decisions: PendingDecisionQueue | null | undefined,
): PendingDecisionRow[] | null {
  if (approval.toolName !== 'AskUserQuestion') return null;
  const questions = questionsOf(approval.input);
  if (questions.length === 0) return null;
  // `pending` and nothing else: those are the rows the door would take an answer to from this
  // session, which is the same set the server built the ask from.
  const rows = decisions?.pending ?? [];
  const matched = questions.map((question) => decisionRowFor(question, rows));
  return matched.every((row) => row !== null) ? (matched as PendingDecisionRow[]) : null;
}

/**
 * Which waiting rows have a decision card on screen that could still be answered.
 *
 * This is the whole answer to "what does the rail's pointer point at when there is no card", and
 * it is one computation rather than four special cases. Every way a row can lack a live card comes
 * out of the same two facts the cards themselves are drawn from:
 *
 *  - the coordinator session is not running, or has not reached the call yet — no approval is held
 *    for it at all, so nothing here adds a key;
 *  - the turn that raised the card is over — the approval is still held but is not in `answerable`
 *    (`WorkspaceView` recomputes that from the session's run state and the tool result), and a card
 *    nobody is listening to is not a place to send a reader;
 *  - it was answered seconds ago and the strip is still holding its 20s-old read — the approval was
 *    dropped optimistically on the answer, so the key goes with it and the stale row loses its
 *    pointer rather than keeping one aimed at a card that is gone.
 *
 * The failure direction is deliberate: an unknown is "no card", which costs a sentence, never a
 * pointer that does nothing when pressed.
 */
export function answerableDecisionCards(
  approvals: ApprovalInfo[],
  answerable: ReadonlySet<string>,
  decisions: PendingDecisionQueue | null | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const approval of approvals) {
    if (!answerable.has(approval.id)) continue;
    for (const row of evidenceDecisionRows(approval, decisions) ?? []) {
      keys.add(decisionRowKey(row));
    }
  }
  return keys;
}

/**
 * The card: one section per row, and the actions of a judgment rather than of a form.
 *
 * `answers` still goes back the way `evidenceDecisionFromAnswers` reads it — keyed by the question's
 * own text, carrying the server's own option label. What changed is what a reader does to produce
 * it, not what arrives. A send-back carries its reason as the second entry, which is the same shape
 * the generic form has always used for a typed answer beside a picked one.
 */
function EvidenceDecisionForm({
  approval,
  rows,
  onDecide,
  answerable,
  onChatAbout,
}: {
  approval: ApprovalInfo;
  rows: PendingDecisionRow[];
  onDecide: OnDecide;
  answerable: boolean;
  onChatAbout?: (id: string, question: string) => void;
}): JSX.Element {
  const questions = questionsOf(approval.input);
  // Usually there is one row, and then the first press IS the submit. A delivery that found three
  // rows waiting asks about three in one call and a tool call is answered once, so an answer is
  // held until the last one is made rather than sent as a partial the other two are lost from.
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const answer = (question: string, picks: string[]): void => {
    const next = { ...answers, [question]: picks };
    if (questions.every((item) => (next[item.question ?? '']?.length ?? 0) > 0)) {
      onDecide(approval.id, 'allow', next);
      return;
    }
    setAnswers(next);
  };
  return (
    <div className="approval-card decision-ask">
      <div className="approval-head decision-ask-head">{DECISION_ASK_HEADING}</div>
      <div className="approval-body is-questions decision-ask-body">
        {questions.map((question, index) => {
          const body = question.question ?? '';
          return (
            <EvidenceDecisionQuestion
              key={index}
              row={rows[index]}
              body={body}
              index={index}
              total={questions.length}
              picked={answers[body]?.[0] ?? null}
              answerable={answerable}
              onAnswer={(picks) => answer(body, picks)}
              onChat={() => onChatAbout?.(approval.id, rows[index].title)}
            />
          );
        })}
      </div>
      {!answerable && <UnanswerableNote />}
    </div>
  );
}

/** One row, in the order a person decides in: what is claimed, what is admitted missing, what was
 *  checked for them, and only then the full text they can go and read. */
function EvidenceDecisionQuestion({
  row,
  body,
  index,
  total,
  picked,
  answerable,
  onAnswer,
  onChat,
}: {
  row: PendingDecisionRow;
  /** The question's own text — the identity of this question on the way back, and the card's
   *  bottom fold. Never the source of anything above it. */
  body: string;
  index: number;
  total: number;
  /** The option label already chosen for this row, while the card waits on its other rows. */
  picked: string | null;
  answerable: boolean;
  onAnswer: (picks: string[]) => void;
  onChat: () => void;
}): JSX.Element {
  const [fullOpen, setFullOpen] = useState(false);

  return (
    // Where the rail's pointer lands. The handle is `decisionRowKey` of the row this section was
    // built from, so the strip computes it from its own copy of the same row and there is no map
    // between the two to fall out of step. Per QUESTION rather than per card: an ask raised over
    // three rows is one card, and a pointer for one of them must arrive at that one.
    <section className="decision-ask-q" data-decision-row={decisionRowKey(row)}>
      <div className="decision-ask-chip">{`证据 ${index + 1}/${total}`}</div>
      <EvidenceDecisionFacts row={row} />

      {/* Last, and folded: the string the tool actually carries. Nothing above it is derived from
          this — it is here so that "the card shows less" never means "the card hides something". */}
      <div className="decision-ask-full">
        <button
          type="button"
          className="decision-ask-toggle"
          aria-expanded={fullOpen}
          onClick={() => setFullOpen(!fullOpen)}
        >
          {DECISION_FULL_LABEL}
          <span className="decision-ask-caret" aria-hidden="true">{fullOpen ? '▴' : '▾'}</span>
        </button>
        {fullOpen && <pre className="decision-ask-full-body">{body}</pre>}
      </div>

      {picked !== null ? (
        <div className="decision-ask-picked">
          {`已选「${picked === CONFIRM_LABEL ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION}」`}
        </div>
      ) : (
        <EvidenceDecisionActions
          disabled={!answerable}
          onConfirm={() => onAnswer([CONFIRM_LABEL])}
          onSendBack={(note) => onAnswer([SEND_BACK_LABEL, note])}
        >
          <CardActionButton tone="outline" disabled={!answerable} onClick={onChat}>
            {DECISION_CHAT_ACTION}
          </CardActionButton>
        </EvidenceDecisionActions>
      )}
    </section>
  );
}
