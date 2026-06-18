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

/** An inline allow/deny card for a pending tool-permission request. */
export function ApprovalPanel({
  approval,
  onDecide,
}: {
  approval: ApprovalInfo;
  onDecide: (id: string, behavior: 'allow' | 'deny') => void;
}): JSX.Element {
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
        </button>
        <button className="approval-btn deny" onClick={() => onDecide(approval.id, 'deny')}>
          {isPlan(approval) ? '继续规划' : '拒绝'}
        </button>
      </div>
    </div>
  );
}
