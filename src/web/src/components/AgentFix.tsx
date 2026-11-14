import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RunnerAttentionFixResult } from '@orbit/shared';
import { api } from '../api';
import type { AgentFixTarget, AgentFixView } from '../lib/agentFix';
import { runnersQuery } from '../lib/queries';
import { AGENT_FIX_BUTTON, AGENT_FIX_FAILED, AGENT_FIX_OPEN_SESSION, agentFixFixing } from '../lib/runnerCopy';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';

/** One press: the session starts on the machine at once, and the runners re-read shows it fixing. */
export function useAgentFix(runnerId: string) {
  const qc = useQueryClient();
  const message = useToast();
  return useMutation({
    mutationFn: (target: AgentFixTarget) =>
      api<RunnerAttentionFixResult>(`/runners/${runnerId}/attention/${target.kind}/fix`, { method: 'POST', body: target.body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error(AGENT_FIX_FAILED, e.message),
  });
}

/** The button, where the view has one: gone while an agent is fixing it, disabled when none can start. */
export function AgentFixButton({
  view,
  target,
  runnerId,
}: {
  view: AgentFixView | null;
  target: AgentFixTarget;
  runnerId: string;
}) {
  const fix = useAgentFix(runnerId);
  if (!view || view.state === 'fixing') return null;
  return (
    <Button
      size="small"
      disabled={view.state === 'blocked' || fix.isPending}
      loading={fix.isPending}
      onClick={() => fix.mutate(target)}
    >
      {AGENT_FIX_BUTTON}
    </Button>
  );
}

/** The line under it: the agent at work and its session, or why none can start, or where it would run. */
export function AgentFixLine({ view }: { view: AgentFixView | null }) {
  if (!view) return null;
  if (view.state === 'fixing') {
    return (
      <div className="agent-fix-line fixing">
        <span className="agent-fix-dot" aria-hidden />
        {agentFixFixing(view.workspaceName)}
        <Link to={`/sessions/${encodeURIComponent(view.sessionId)}`}>{AGENT_FIX_OPEN_SESSION}</Link>
      </div>
    );
  }
  return view.line ? <div className={`agent-fix-line ${view.state}`}>{view.line}</div> : null;
}
