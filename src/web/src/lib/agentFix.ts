import type { ReportedEngine, RunnerAgentFix, RunnerAttentionFixKind, RunnerAttentionFixRequest } from '@orbit/shared';
import type { AttentionItem } from './runnerAttention';
import { agentFixSignInAbove, agentFixSignInBelow, agentFixSignInOnMachinePage, agentFixStartsIn } from './runnerCopy';

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
    return engine ? engineNotUpdatingFixTarget(engine) : null;
  }
  if (item.kind === 'cannotSelfUpdate') {
    const latest = typeof item.params.latest === 'string' ? item.params.latest : undefined;
    return { kind: 'cannotSelfUpdate', engine: null, body: latest ? { latest } : {} };
  }
  return null;
}

/** An engine that won't update: its Needs Attention card, and the warning panel on its engine row. */
export function engineNotUpdatingFixTarget(engine: ReportedEngine): AgentFixTarget {
  return { kind: 'engineNotUpdating', engine, body: { engine } };
}

/** An engine's Install failed panel. */
export function installFixTarget(engine: ReportedEngine): AgentFixTarget {
  return { kind: 'installFailed', engine, body: { engine } };
}

/** The Update engines report with failed lines: the machine's, whichever engines failed. */
export const ENGINE_UPDATE_FIX_TARGET: AgentFixTarget = { kind: 'engineUpdateFailed', engine: null, body: {} };

/** The engine whose sandbox names the missing package, in the transcript's warning
 *  (docs/mocks/codex-sandbox-fix-with-agent). */
export const SANDBOX_FIX_ENGINE: ReportedEngine = 'codex';

/** The missing-bubblewrap warning a session's transcript caught: one press installs what Codex wants. */
export function sandboxFixTarget(engine: ReportedEngine = SANDBOX_FIX_ENGINE): AgentFixTarget {
  return { kind: 'sandboxMissing', engine, body: { engine } };
}

export type AgentFixView =
  | { state: 'fixing'; workspaceName: string; sessionId: string }
  | { state: 'ready'; line: string | null }
  | { state: 'blocked'; line: string };

/** A transcript row's warning has no runner-reported card: it is the warning itself, so it draws the
 *  agent at work, the one that already finished with it, or the button. */
export type SandboxFixView =
  | { state: 'fixing'; workspaceName: string; sessionId: string }
  | { state: 'handled'; workspaceName: string; sessionId: string }
  | { state: 'ready'; line: string | null }
  | { state: 'blocked'; line: string };

/**
 * What the transcript's sandbox warning draws. The handled line comes before the button so a history
 * row that already handed the work to an agent does not offer a second one; a later warning is a new
 * row, and this one's session is over.
 */
export function sandboxFixView(fix: RunnerAgentFix | null | undefined): SandboxFixView | null {
  if (!fix) return null;
  const isSandbox = (f: { kind: RunnerAttentionFixKind; engine: ReportedEngine | null }) =>
    f.kind === 'sandboxMissing' && f.engine === SANDBOX_FIX_ENGINE;
  const fixing = fix.fixing.find(isSandbox);
  if (fixing) return { state: 'fixing', workspaceName: fixing.workspaceName, sessionId: fixing.sessionId };
  const handled = fix.handled.find(isSandbox);
  if (handled) return { state: 'handled', workspaceName: handled.workspaceName, sessionId: handled.sessionId };
  if (fix.blocked) {
    const signIn = fix.blocked.code === 'engineSignedOut' && fix.engineName
      ? agentFixSignInOnMachinePage(fix.engineName)
      : '';
    return { state: 'blocked', line: fix.blocked.message + signIn };
  }
  return {
    state: 'ready',
    line: fix.workspaceName && fix.engineName ? agentFixStartsIn(fix.workspaceName, fix.engineName) : null,
  };
}

/**
 * What one warning draws: the fixing line while its agent is open, else the button — disabled with the
 * reason when none can start. `card` is a Needs Attention card, which draws nothing for an offline
 * machine (the offline card says so); `panel` is an Install failed panel, which also says where it runs;
 * `report` is the Update engines report, which says it the same way but sits above the engine rows.
 */
export function agentFixView(
  fix: RunnerAgentFix | null | undefined,
  target: AgentFixTarget,
  place: 'card' | 'panel' | 'report',
): AgentFixView | null {
  if (!fix) return null;
  const fixing = fix.fixing.find((f) => f.kind === target.kind && (f.engine ?? null) === target.engine);
  if (fixing) return { state: 'fixing', workspaceName: fixing.workspaceName, sessionId: fixing.sessionId };
  if (fix.blocked) {
    if (place === 'card' && fix.blocked.code === 'offline') return null;
    const signIn = place !== 'card' && fix.blocked.code === 'engineSignedOut' && fix.engineName
      ? (place === 'panel' ? agentFixSignInAbove : agentFixSignInBelow)(fix.engineName)
      : '';
    return { state: 'blocked', line: fix.blocked.message + signIn };
  }
  return {
    state: 'ready',
    line: place !== 'card' && fix.workspaceName && fix.engineName ? agentFixStartsIn(fix.workspaceName, fix.engineName) : null,
  };
}
