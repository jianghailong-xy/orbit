import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo } from '../api';

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

type OnDecide = (
  id: string,
  behavior: 'allow' | 'deny',
  answers?: Record<string, string[]>,
  message?: string,
) => void;

// The hotkey accepts metaKey || ctrlKey on every platform; only the hint label is
// platform-specific — ⌘ on macOS, Ctrl elsewhere.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const SHORTCUT_HINT = IS_MAC ? '⌘ + Enter' : 'Ctrl + Enter';

/** ⌘/Ctrl + Enter fires the card's primary action while it's the active card (the first
 *  pending one). Skipped while typing in an input so it doesn't clash with the composer. */
function useApproveHotkey(active: boolean, onTrigger: () => void): void {
  const fn = useRef(onTrigger);
  fn.current = onTrigger;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      e.preventDefault();
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

/** An inline card for a pending tool-permission request: an interactive multiple-choice
 *  form for AskUserQuestion, otherwise a plain allow/deny (with a rich render for plans). */
export function ApprovalPanel({
  approval,
  onDecide,
  active = false,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  active?: boolean;
}): JSX.Element {
  const isQuestion = approval.toolName === 'AskUserQuestion';
  // The plain card approves on ⌘/Ctrl + Enter; questions submit via QuestionForm's own hook.
  useApproveHotkey(active && !isQuestion, () => onDecide(approval.id, 'allow'));
  if (isQuestion) {
    return <QuestionForm approval={approval} onDecide={onDecide} active={active} />;
  }
  const plan = isPlan(approval) ? planText(approval.input) : '';
  return (
    <div className="approval-card">
      <div className="approval-head">
        {isPlan(approval)
          ? '📋 待确认：退出 plan 模式并按此计划实施？'
          : `🔓 待批准工具调用：${approval.toolName}`}
      </div>
      <div className="approval-body">
        {plan ? (
          <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
        ) : (
          <pre className="approval-input">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
        )}
      </div>
      <div className="approval-actions">
        <button className="approval-btn approve" onClick={() => onDecide(approval.id, 'allow')}>
          {isPlan(approval) ? '批准并实施' : '批准'}
          {active && <span className="approval-btn-kbd">{SHORTCUT_HINT}</span>}
        </button>
        <button className="approval-btn deny" onClick={() => onDecide(approval.id, 'deny')}>
          {isPlan(approval) ? '继续规划' : '拒绝'}
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
  active = false,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  active?: boolean;
}): JSX.Element {
  const questions = questionsOf(approval.input);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  // Free-text answers, keyed by question text — claude's AskUserQuestion always lets
  // the user type their own answer instead of picking a listed option.
  const [custom, setCustom] = useState<Record<string, string>>({});
  // "Chat about this" mode: instead of answering, reply conversationally. The text
  // rides back as a `deny` message, so claude reads it as in-turn feedback and keeps
  // going without being forced to pick one of its listed options.
  const [chatting, setChatting] = useState(false);
  const [chatText, setChatText] = useState('');
  const chatRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (chatting) chatRef.current?.focus();
  }, [chatting]);

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

  const sendChat = () => {
    const msg = chatText.trim();
    if (!msg) return;
    onDecide(approval.id, 'deny', undefined, msg);
  };

  // ⌘/Ctrl + Enter submits once every question has a pick — but not while chatting,
  // where the same chord sends the reply instead (handled on the textarea).
  useApproveHotkey(active && complete && !chatting, submit);

  return (
    <div className="approval-card">
      <div className="approval-head">❓ Claude 有问题需要你回答</div>
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
                  placeholder="或输入你自己的回答…"
                  value={custom[q] ?? ''}
                  onChange={(e) => onCustom(q, e.target.value, multi)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && complete) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                {multi && <div className="chat-q-multi">可多选</div>}
              </div>
            );
          })}
        </div>
        {chatting && (
          <textarea
            ref={chatRef}
            className="chat-q-reply"
            placeholder="和 Claude 聊聊这个问题…（它会读到你的话并继续，而不强制你选某个选项）"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && chatText.trim()) {
                e.preventDefault();
                sendChat();
              }
            }}
          />
        )}
      </div>
      {chatting ? (
        <div className="approval-actions">
          <button className="approval-btn approve" disabled={!chatText.trim()} onClick={sendChat}>
            发送
            {active && chatText.trim() && <span className="approval-btn-kbd">{SHORTCUT_HINT}</span>}
          </button>
          <button
            className="approval-btn deny"
            onClick={() => {
              setChatting(false);
              setChatText('');
            }}
          >
            返回
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          <button className="approval-btn approve" disabled={!complete} onClick={submit}>
            提交
            {active && complete && <span className="approval-btn-kbd">{SHORTCUT_HINT}</span>}
          </button>
          <button className="approval-btn chat" onClick={() => setChatting(true)}>
            💬 聊聊这个
          </button>
          <button className="approval-btn deny" onClick={() => onDecide(approval.id, 'deny')}>
            不回答
          </button>
        </div>
      )}
    </div>
  );
}
