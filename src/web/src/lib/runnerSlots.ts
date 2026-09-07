import { sessionRunStatusOf } from './sessionState';

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

/**
 * How long the current run has been waiting, for the notices whose whole problem is that a
 * static line reads the same at three seconds and at thirty minutes.
 *
 * `since` is the session's `lastTurnAt`: the claim writes it, and for the rest of a starting
 * stretch nothing moves it again — the events such a run does produce are session-level
 * `system` ones, which the control plane deliberately does not count as activity.
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
