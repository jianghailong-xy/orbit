import { AgentProvider } from './enums';

/**
 * How a built-in runtime's engine process is driven across a session's turns. This mirrors
 * the runner's own table (`src/runner-go/provider_runtime.go`), which is where the answer is
 * actually acted on; it exists here because the control plane has to decide, before the
 * runner ever sees the turn, whether a message can be written into the turn already running.
 */
export type ProviderTransport = 'stream-json' | 'json-rpc' | 'one-shot';

export const PROVIDER_TRANSPORTS: Record<AgentProvider, ProviderTransport> = {
  // One process for the whole session, spoken to in stream-json JSONL over a stdin that
  // stays open: a `result` is a turn boundary, not an exit, so a frame written while the
  // engine is mid-turn reaches the process that is already working.
  [AgentProvider.CLAUDE]: 'stream-json',
  // Also one resident process, but driven by a JSON-RPC conversation whose turn call is
  // outstanding until the turn ends — there is no second frame to hand it in between.
  [AgentProvider.CODEX]: 'json-rpc',
  [AgentProvider.KIMI]: 'json-rpc',
  // One process per turn, carrying that turn's prompt and exiting with it.
  [AgentProvider.OPENCODE]: 'one-shot',
};

/**
 * Whether a message sent while this runtime is mid-turn can be written INTO that turn
 * (filed as a `steer`) instead of queued behind its result.
 *
 * Only the stream-json transport can take one: its stdin stays open across the turn. For
 * every other runtime a mid-turn message stays an ordinary queued `message` — which is
 * exactly what it always was, and what its client already knows how to show. Asking this
 * BEFORE filing the turn is what keeps a steer from being handed to a session loop that has
 * no case for it; the runner refuses one anyway (see refuseUnsupportedSteer), so a control
 * plane and a runner that disagree produce a visible failure rather than a lost message.
 *
 * The argument is a RUNTIME, not a session's declared provider: a configured (BYOK) provider
 * borrows a built-in runtime, so resolve it with `execRuntime` first.
 */
export function supportsMidTurnSteer(runtime: string): boolean {
  return PROVIDER_TRANSPORTS[runtime as AgentProvider] === 'stream-json';
}
