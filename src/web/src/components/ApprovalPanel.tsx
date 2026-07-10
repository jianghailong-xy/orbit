import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo, PermissionRule } from '../api';
import { bashCommandRules } from '../lib/bashRules';

// claude routes plan-mode "exit?" through the same permission tool as any other gated
// call; ExitPlanMode is the one worth a rich render (its input carries the plan).
const isPlan = (a: ApprovalInfo): boolean => a.toolName === 'ExitPlanMode';

function planText(input: unknown): string {
  if (input && typeof input === 'object' && 'plan' in input) {
    const p = (input as { plan?: unknown }).plan;
    if (typeof p === 'string') return p;
  }
  return '';
}

// Derive the session-scoped rules for "allow + remember same kind", or [] when none
// apply: questions/plans aren't repeatable. A Bash line yields one rule per distinct
// sub-command prefix (so `cd x && git add …` remembers both, not just the leading `cd`);
// other tools get a single tool-wide rule (no ruleContent).
function rememberRulesFor(a: ApprovalInfo): PermissionRule[] {
  if (a.toolName === 'AskUserQuestion' || isPlan(a)) return [];
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
  // "Allow + remember same kind" for the rest of the session (claude's engine matches
  // future calls). Empty for questions/plans and Bash commands with no clean prefix; a
  // compound Bash line yields one rule per distinct sub-command.
  const rules = isQuestion ? [] : rememberRulesFor(approval);
  // Plain card: Enter approves; ⌘/Ctrl + Enter approves-and-remembers (only when that
  // option exists). Questions have no submit hotkey — they submit only via the Submit button.
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
  return (
    <div className="approval-card">
      <div className="approval-head">
        {isPlan(approval)
          ? '📋 Confirm: exit plan mode and proceed with this plan?'
          : `🔓 Approve tool call: ${approval.toolName}`}
      </div>
      <div className={`approval-body${plan ? ' is-plan' : ''}`}>
        {plan ? (
          <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
        ) : (
          <pre className="approval-input">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
        )}
      </div>
      <div className="approval-actions">
        <button className="approval-btn approve" onClick={() => onDecide(approval.id, 'allow')}>
          {isPlan(approval) ? 'Approve & run' : 'Approve'}
          {active && <span className="approval-btn-kbd">{ENTER_HINT}</span>}
        </button>
        {rules.length > 0 && (
          <button
            className="approval-btn approve-always"
            title={`Auto-approve calls like this for the rest of this session: ${ruleNames(rules).join(', ')}`}
            onClick={() => onDecide(approval.id, 'allow', undefined, undefined, rules)}
          >
            Approve, and auto-allow future <code className="approval-rule">{rememberLabel(rules)}</code>
            {active && <span className="approval-btn-kbd">{SHORTCUT_HINT}</span>}
          </button>
        )}
        <button className="approval-btn deny" onClick={() => onDecide(approval.id, 'deny')}>
          {isPlan(approval) ? 'Keep planning' : 'Reject'}
        </button>
      </div>
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
  // in the main composer (handled by AgentView via onChatAbout). The reply still rides back
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
