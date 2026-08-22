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
  // Also one resident process, driven by a JSON-RPC conversation. Its turn call is
  // outstanding until the turn ends, but the conversation itself stays open beside it —
  // whether a second frame can join that turn is the engine's own question, not the
  // transport's (see MID_TURN_STEER).
  [AgentProvider.CODEX]: 'json-rpc',
  [AgentProvider.KIMI]: 'json-rpc',
  // One process per turn, carrying that turn's prompt and exiting with it.
  [AgentProvider.OPENCODE]: 'one-shot',
};

/**
 * The runner capability a codex steer must be declared under, in the header every runner
 * sends (`X-Orbit-Runner-Capabilities`, stored on `Runner.capabilities` each heartbeat).
 *
 * Codex mid-turn delivery is `turn/steer`, which arrived long after the `steer` kind did:
 * every runner already in the field answers one for codex by refusing it. Filing a codex
 * steer for a runner that has not said this word would turn today's quiet queueing into a
 * visible failure on every mid-turn message — see docs/codex-turn-steer-contract.md §6.1.
 */
export const SESSION_CODEX_STEER_V1 = 'session-codex-steer-v1';

/** No declaration needed: this runtime's mid-turn delivery shipped with the `steer` kind
 *  itself, so asking for one would withdraw it from the entire installed fleet. */
const ALWAYS = null;
/** Nothing to fold a message into — a mid-turn message here stays an ordinary queued turn. */
const NEVER = false;

/**
 * Per runtime, whether a message sent mid-turn can be written INTO the running turn, and
 * what the runner holding the session must have declared before one is filed.
 *
 * Keyed on the RUNTIME rather than its transport, because the transport does not answer the
 * question: codex and kimi are both driven over JSON-RPC and only one of them can take a
 * mid-turn message (codex app-server has `turn/steer`; ACP has nothing that corresponds).
 */
const MID_TURN_STEER: Record<AgentProvider, string | typeof ALWAYS | typeof NEVER> = {
  [AgentProvider.CLAUDE]: ALWAYS,
  [AgentProvider.CODEX]: SESSION_CODEX_STEER_V1,
  [AgentProvider.KIMI]: NEVER,
  [AgentProvider.OPENCODE]: NEVER,
};

/**
 * Whether a message sent while this runtime is mid-turn can be written INTO that turn
 * (filed as a `steer`) instead of queued behind its result.
 *
 * For every other runtime a mid-turn message stays an ordinary queued `message` — which is
 * exactly what it always was, and what its client already knows how to show. Asking this
 * BEFORE filing the turn is what keeps a steer from being handed to a session loop that has
 * no case for it: the turn is leased and never re-leased, so a steer nobody consumes is a
 * message gone for good.
 *
 * `declaredCapabilities` is what the runner that will execute this session says it can do.
 * "This runtime can be steered" and "the runner holding this session can steer it" are
 * different questions, and only the second one is safe to deploy a control plane ahead of:
 * absent capabilities mean not declared, so an unknown can only ever withhold a steer and
 * leave the message queueing exactly as it does today — never invent one.
 *
 * The first argument is a RUNTIME, not a session's declared provider: a configured (BYOK)
 * provider borrows a built-in runtime, so resolve it with `execRuntime` first.
 */
export function supportsMidTurnSteer(runtime: string, declaredCapabilities?: readonly string[]): boolean {
  const required = MID_TURN_STEER[runtime as AgentProvider];
  if (required === ALWAYS) return true;
  if (required === NEVER || required === undefined) return false;
  return (declaredCapabilities ?? []).some((value) => value.trim().toLowerCase() === required);
}
