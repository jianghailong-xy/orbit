import type { ReportedEngine, RunnerAgentFix, RunnerAttentionFixKind, RunnerAttentionFixRequest } from '@orbit/shared';
import type { AttentionItem } from './runnerAttention';
import { agentFixSignInAbove, agentFixStartsIn } from './runnerCopy';

/**
 * Fix with an agent (POST /runners/:id/attention/:kind/fix): which warnings offer it, and what to draw.
 * The server decides where a press would run and why it can't (runner.agentFix); this only places it.
 */

/** What a press sends: the warning, its engine, and for the runner's own update the latest release this page knows. */
export interface AgentFixTarget {
  kind: RunnerAttentionFixKind;
  engine: ReportedEngine | null;
  body: RunnerAttentionFixRequest;
}

/** The Needs Attention cards whose fix is work on that machine: an engine that won't update, and a runner
 *  that can't update itself (its install folder, a failed update, or updates turned off). */
export function attentionFixTarget(item: AttentionItem): AgentFixTarget | null {
  if (item.kind === 'engineNotUpdating') {
    const engine = typeof item.params.engine === 'string' ? (item.params.engine as ReportedEngine) : null;
    return engine ? { kind: 'engineNotUpdating', engine, body: { engine } } : null;
  }
  if (item.kind === 'cannotSelfUpdate') {
    const latest = typeof item.params.latest === 'string' ? item.params.latest : undefined;
    return { kind: 'cannotSelfUpdate', engine: null, body: latest ? { latest } : {} };
  }
  return null;
}

/** An engine's Install failed panel. */
export function installFixTarget(engine: ReportedEngine): AgentFixTarget {
  return { kind: 'installFailed', engine, body: { engine } };
}

export type AgentFixView =
  | { state: 'fixing'; workspaceName: string; sessionId: string }
  | { state: 'ready'; line: string | null }
  | { state: 'blocked'; line: string };

/**
 * What one warning draws: the fixing line while its agent is open, else the button — disabled with the
 * reason when none can start. `card` is a Needs Attention card, which draws nothing for an offline
 * machine (the offline card says so); `panel` is an Install failed panel, which also says where it runs.
 */
export function agentFixView(
  fix: RunnerAgentFix | null | undefined,
  target: AgentFixTarget,
  place: 'card' | 'panel',
): AgentFixView | null {
  if (!fix) return null;
  const fixing = fix.fixing.find((f) => f.kind === target.kind && (f.engine ?? null) === target.engine);
  if (fixing) return { state: 'fixing', workspaceName: fixing.workspaceName, sessionId: fixing.sessionId };
  if (fix.blocked) {
    if (place === 'card' && fix.blocked.code === 'offline') return null;
    const signIn = place === 'panel' && fix.blocked.code === 'engineSignedOut' && fix.engineName
      ? agentFixSignInAbove(fix.engineName)
      : '';
    return { state: 'blocked', line: fix.blocked.message + signIn };
  }
  return {
    state: 'ready',
    line: place === 'panel' && fix.workspaceName && fix.engineName ? agentFixStartsIn(fix.workspaceName, fix.engineName) : null,
  };
}
