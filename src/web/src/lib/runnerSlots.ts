import {
  sessionIsStarting,
  sessionRunStateOf,
  sessionRunStatusOf,
  type SessionStateSource,
} from './sessionState';

export interface SlotSession {
  runStatus?: string | null;
  /** Legacy alias retained for payloads from older servers. */
  status?: string | null;
}

export interface RunnerSlotUsage {
  active: number;
  atCapacity: boolean;
}

// maxConcurrent limits turns that are actively executing. A warm or cold
// AWAITING_INPUT session remains resumable, but it does not hold an active slot.
export function activeSlotCount(sessions: readonly SlotSession[]): number {
  return sessions.filter((session) => sessionRunStatusOf(session) === 'RUNNING').length;
}

export function runnerSlotUsage(
  sessions: readonly SlotSession[],
  maxConcurrent?: number | null,
): RunnerSlotUsage {
  const active = activeSlotCount(sessions);
  return {
    active,
    atCapacity:
      typeof maxConcurrent === 'number' && maxConcurrent > 0 && active >= maxConcurrent,
  };
}

/** Capacity-specific copy. Only correct when the server actually named a capacity gate — see
 *  queuedLabel/queuedTitle, which decide when this is the honest thing to say. */
export const PENDING_SLOT_LABEL = 'Waiting for slot';
export const PENDING_SLOT_TITLE = 'Waiting for a free slot';

/** What a queued session says when no gate is holding it: it is simply not claimed yet. On this
 *  deployment that is the overwhelming majority — and it lasts ~100ms, so it usually never
 *  paints at all. Saying "waiting for a free slot" here sent people to look at capacity for a
 *  wait that had nothing to do with capacity. */
export const QUEUED_LABEL = 'Queued';
// The ordinary runner-pickup queue is normally a transport-sized wait. Giving it the same grace
// period as startup prevents a status card from flashing before the accepted user message lands.
// Explicit gates (offline/capacity/git) bypass this delay; they are actionable explanations.
export const QUEUED_NOTICE_DELAY_MS = 10_000;

/**
 * Copy for a session that holds a slot but whose engine has not spoken for this run yet
 * (sessionIsStarting). Distinct from both neighbours on purpose: unlike Queued nothing is
 * contended and the user cannot shorten it, and unlike Running the agent has not read the
 * prompt yet.
 *
 * It names no cause, because the state it labels is an ABSENCE. One missing `engineStartedAt`
 * covers a cold checkout, a warm process that is simply between turns (every claim clears the
 * column, so a reused runtime lands here too), and an engine compacting a conversation that no
 * longer fits before it can read the message. Naming one of the three is a guess that is wrong
 * in the other two, and the wording this replaced — "bringing its workspace up — checkout,
 * engine, tools" — was that guess: on a warm reuse not one of the three was happening, and on
 * a compaction it sent people to look at a checkout for a wait that had nothing to do with one.
 * What is actually known is who holds the session and what has not happened yet. The duration
 * sentence survives because it is the one thing true of all three, and waitElapsedLabel below
 * carries the rest — a line that cannot move cannot tell three seconds from thirty minutes.
 */
export const STARTING_LABEL = 'Starting';
export const STARTING_TITLE = 'Getting the session ready';
export const STARTING_DESCRIPTION =
  'The runner has this session, but the engine has not started your message yet. Usually seconds — a long conversation can take several minutes to get going.';
// Keep the first ten seconds quiet, then explain the wait only once the startup is long enough
// for this large transcript notice to be useful rather than an immediate flash after Send.
export const STARTING_NOTICE_DELAY_MS = 10_000;

/** Which phase the runner reported for a starting session, if it reported one. */
export interface EnginePhase {
  enginePhase?: string | null;
}

/**
 * Copy for the one phase a runtime names: the engine is compacting a conversation that no longer
 * fits, before it can read the message it was sent.
 *
 * This is allowed to name a cause where STARTING_DESCRIPTION is not, and the difference is the
 * whole point — the runner said so. It is also the case the generic wording served worst: a cold
 * start is seconds, and this is minutes, so "starting" set an expectation that then broke.
 */
export const COMPACTING_LABEL = 'Compacting';
export const COMPACTING_TITLE = 'Compacting the conversation';
export const COMPACTING_DESCRIPTION =
  'The conversation no longer fits, so the engine is summarizing it before it can read your message. This can take a few minutes.';

/**
 * What a starting session is doing, in the user's terms.
 *
 * The runner names the phase, because only it can — the same division of labour as queuedReason
 * above, where the server names the gate. From a session row there is no way to tell a checkout
 * from a warm handover from a compaction; they are one absent timestamp.
 *
 * An unrecognised phase falls back to the generic copy rather than being shown. A runner
 * self-updates on its own schedule and outlives a release, so it can name a phase this client has
 * never heard of, and printing a word it cannot explain is worse than the honest generic line.
 */
const isCompacting = (session?: EnginePhase | null): boolean =>
  session?.enginePhase === 'compacting';

export function startingTitle(session?: EnginePhase | null): string {
  return isCompacting(session) ? COMPACTING_TITLE : STARTING_TITLE;
}

/** The short chip form of startingTitle, for the session list. */
export function startingLabel(session?: EnginePhase | null): string {
  return isCompacting(session) ? COMPACTING_LABEL : STARTING_LABEL;
}

export function startingDescription(session?: EnginePhase | null): string {
  return isCompacting(session) ? COMPACTING_DESCRIPTION : STARTING_DESCRIPTION;
}

/** A session as the waiting notices read it. Every clock is optional: an older control plane sends
 *  none of them, and then `lastTurnAt` is the only clock there is. */
export interface WaitingSource extends SessionStateSource {
  lastTurnAt?: string | null;
  runClaimedAt?: string | null;
  enginePhaseSince?: string | null;
}

/** Which wait a session is in, and the moment that wait began. */
export interface WaitingNotice {
  kind: 'starting' | 'compacting';
  since: string | null;
}

/**
 * Whether the waiting notice applies to this session, and what it counts from.
 *
 * Compacting is checked first and does not require the starting state. Claude Code sends a per-turn
 * `init` 0.1–0.4s after each message, and `init` stamps engineStartedAt; every pre-turn automatic
 * compaction found on production came after it, so a phase gated on sessionIsStarting stayed hidden
 * for the whole compaction. `RUNNING && enginePhase === 'compacting'` is enough on its own, because
 * the server clears the phase on any engine output: a named phase already means the engine has said
 * nothing since the phase began.
 *
 * Each wait counts from its own start. A compaction can begin hours into a turn, so it counts from
 * `enginePhaseSince`; the starting state counts from the claim. `lastTurnAt` is only the fallback
 * for a server that sends neither.
 */
export function waitingNoticeFor(session?: WaitingSource | null): WaitingNotice | null {
  if (!session) return null;
  if (sessionRunStateOf(session) === 'RUNNING' && isCompacting(session))
    return {
      kind: 'compacting',
      since: session.enginePhaseSince ?? session.runClaimedAt ?? session.lastTurnAt ?? null,
    };
  if (sessionIsStarting(session))
    return { kind: 'starting', since: session.runClaimedAt ?? session.lastTurnAt ?? null };
  return null;
}

/**
 * The reveal scope for a session's waiting notice: one per run.
 *
 * Per run rather than per notice, so a wait that turns from starting into compacting keeps the
 * notice it has already earned instead of hiding it for another ten seconds. Anchored on the claim
 * rather than on `lastTurnAt`, which moves with activity and re-hid the notice each time it did. A
 * new claim is a new run, so the next message still gets its own quiet period.
 */
export function waitingNoticeScope(
  sessionId: string | null,
  session?: WaitingSource | null,
): string | null {
  if (!sessionId) return null;
  return `${sessionId}:${session?.runClaimedAt ?? session?.lastTurnAt ?? ''}`;
}

/**
 * How long the current run has been waiting, for the notices whose whole problem is that a
 * static line reads the same at three seconds and at thirty minutes.
 *
 * `since` comes from waitingNoticeFor, which reads `lastTurnAt` only when the server sends no
 * better clock. `lastTurnAt` looked stable during a wait and is not: ingest moves it on every event
 * that carries a turn id, the runner stamps a turn id on everything once a message is fed, and
 * Claude Code re-sends its compaction status every 30 seconds. Counted from it, this label went
 * back to zero every half minute on exactly the waits it exists for.
 *
 * Null rather than '0s' for a missing, unparseable or future timestamp: a payload from a server
 * too old to send the field and a skewed clock both know nothing about this wait, and a zero
 * would claim they did.
 */
export function waitElapsedLabel(since: string | null | undefined, now: number): string | null {
  if (!since) return null;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${pad(seconds % 60)}s`
    : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** Which gate the server found holding a queued session, with the numbers it judged on. */
export interface QueuedGate {
  queuedReason?: string | null;
  queuedActive?: number | null;
  queuedLimit?: number | null;
}

/** Whether the transcript's queue notice should be visible at this instant. A missing reason is
 *  also delayed: it is commonly the detail-first frame before the authoritative list row arrives,
 *  and an old payload has not proved there is a real gate worth flashing immediately. */
export function queuedNoticeVisible(
  gate: QueuedGate | null | undefined,
  delayedVisible: boolean,
): boolean {
  return gate?.queuedReason != null || delayedVisible;
}

/**
 * Why this session has not started, in the user's terms.
 *
 * The server names the gate, because only it can: a session can sit queued while the runner it
 * belongs to is half idle — its own run is full, or the batch it was dispatched with is — and
 * from one workspace's page of the list there is no way to tell. Falls back to the runner-capacity
 * reading for payloads from a server that predates the field.
 */
export function pendingSlotDescription(
  active: number,
  maxConcurrent?: number | null,
  gate?: QueuedGate | null,
): string {
  const starts = 'This session starts as soon as a slot frees up.';
  const counted =
    typeof gate?.queuedActive === 'number' && typeof gate?.queuedLimit === 'number'
      ? ` (${gate.queuedActive}/${gate.queuedLimit})`
      : '';
  switch (gate?.queuedReason) {
    case 'tree_at_capacity':
      // Deliberately says "run", not "tree": the user started one piece of work that spawned
      // helpers, and that whole thing is what is full — not the machine.
      return `This run is already using all its slots${counted}. The next sub-session starts as one finishes.`;
    case 'batch_at_capacity':
      return `This batch is running its maximum${counted}. ${starts}`;
    case 'runner_at_capacity':
      return `Runner at capacity${counted}. ${starts}`;
    case 'runner_offline':
      // Named first by the server because it subsumes the rest: no count explains anything
      // while nothing is polling for work. This is the one queued state with an action
      // attached, and it used to read as "waiting for a free slot" on an idle machine.
      return 'The assigned runner is offline. This session starts when it comes back.';
    case 'worktree_op_pending':
      return 'A merge or commit is finishing on this session’s checkout. It starts as soon as that settles.';
    // The server checked every gate and found none: nothing is contended, it simply has not been
    // picked up yet — normally one long-poll round trip. See queuedTitle for why this may not
    // collapse into the `undefined` case below.
    case null:
      return 'Waiting for the runner to pick it up.';
  }
  // Only a payload from a server that predates queuedReason reaches here, where the absence says
  // "not reported" rather than "not gated" and the old local capacity reading is all there is.
  return typeof maxConcurrent === 'number' && maxConcurrent > 0 && active >= maxConcurrent
    ? `Runner at capacity (${active}/${maxConcurrent}). ${starts}`
    : starts;
}

/**
 * The headline for a queued session. "Waiting for a free slot" only when a slot is what it is
 * actually waiting for.
 *
 * `null` and `undefined` are different answers and neither may be folded into the other: null is
 * the server saying it checked and found no gate, while undefined is a server too old to have
 * been asked. Only the first can be reported as a plain queue; the second keeps the capacity
 * wording it has always had, because there is nothing better to say about it.
 */
export function queuedTitle(gate?: QueuedGate | null): string {
  switch (gate?.queuedReason) {
    case 'runner_offline':
      return 'Runner offline';
    case 'worktree_op_pending':
      return 'Waiting for a git operation';
    case null:
      return QUEUED_LABEL;
    default:
      return PENDING_SLOT_TITLE;
  }
}

/** The short chip form of queuedTitle, for the session list. */
export function queuedLabel(gate?: QueuedGate | null): string {
  switch (gate?.queuedReason) {
    case 'runner_offline':
      return 'Runner offline';
    case null:
      return QUEUED_LABEL;
    default:
      return PENDING_SLOT_LABEL;
  }
}
