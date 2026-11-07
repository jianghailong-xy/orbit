/**
 * What the lists this tab reads may cost (docs/list-freshness-design.md §4, the list budget).
 *
 * The control-plane stream says when something changed, and the lists are read then (useControlPlane).
 * Besides that:
 * - while the stream is live, a list is read once a minute at most, a safety read for an event lost on
 *   its way (R1). Where a list was polled every few seconds, that poll is now this one.
 * - while the stream is down, every poll backs off together: 4 s, 8 s, 16 s, then every 30 s, each a
 *   little later than the next by its own jitter (R2). The outage ends with the first message a
 *   reopened stream delivers, not when it opens: a stream that opens and dies keeps the polls where
 *   they had got to.
 * - a failed read is not retried while the stream is down: the next poll is its retry.
 *
 * One tab has one stream, so this is module state: ControlPlaneProvider reports to it, and a poll
 * defined far from any React context (a query factory, a card) reads it when its interval is
 * computed.
 */

/** How often a list is read while the stream is live and nothing announced a change to it (R1). */
export const LIVE_FALLBACK_MS = 60_000;

/** The polls' intervals through an outage, from its start: 4 s, 8 s, 16 s, then every 30 s (R2). */
const OUTAGE_STEPS_MS = [4_000, 8_000, 16_000, 30_000] as const;
/** Each poll waits up to this much longer than the step says, its own amount for the whole outage, so
 *  the lists of a tab (and the tabs of every client) don't all ask in the same instant. */
const OUTAGE_JITTER = 0.2;

type StreamState = 'connecting' | 'live' | 'down';
let state: StreamState = 'connecting';
/** When the outage began: the first drop since a message last came down the stream. */
let outageSince: number | null = null;
const jitters = new Map<string, number>();

/** What ControlPlaneProvider tells the budget about its stream. */
export const streamReport = {
  opened(): void {
    state = 'live';
  },
  /** Something came down the stream, which is what ends an outage. */
  message(): void {
    outageSince = null;
    jitters.clear();
  },
  dropped(now = Date.now()): void {
    state = 'down';
    if (outageSince === null) outageSince = now;
  },
  /** The provider is gone (signed out, unmounted): nothing is known about a stream any more. */
  stopped(): void {
    state = 'connecting';
    outageSince = null;
    jitters.clear();
  },
};

/** Whether the stream is down: it dropped, or never opened, and has not opened since. */
export const streamDown = (): boolean => state === 'down';

function outageStep(now: number): number {
  if (outageSince === null) return 0;
  const elapsed = now - outageSince;
  let reached = 0;
  for (let step = 0; step < OUTAGE_STEPS_MS.length - 1; step += 1) {
    reached += OUTAGE_STEPS_MS[step];
    if (elapsed < reached) return step;
  }
  return OUTAGE_STEPS_MS.length - 1;
}

/** One poll's interval at this point of the outage, `key` naming the poll (its query hash). */
export function outagePollMs(key: string, now = Date.now()): number {
  let jitter = jitters.get(key);
  if (jitter === undefined) {
    jitter = Math.random() * OUTAGE_JITTER;
    jitters.set(key, jitter);
  }
  return Math.round(OUTAGE_STEPS_MS[outageStep(now)] * (1 + jitter));
}

/**
 * A list poll's interval: the safety read while the stream is live, the outage backoff while it is
 * not. `floorMs` is the poll's own cadence where that was slower than either.
 */
export function listPollMs(live: boolean, query: { queryHash: string }, floorMs = 0): number {
  return Math.max(floorMs, live ? LIVE_FALLBACK_MS : outagePollMs(query.queryHash));
}

/**
 * `refetchInterval` for a list read where the stream's liveness is not at hand: it is read when the
 * interval is computed, after each read. `floorMs` as in {@link listPollMs}.
 */
export const streamPoll = (floorMs = 0) => (query: { queryHash: string }): number =>
  listPollMs(!streamDown(), query, floorMs);

/**
 * `refetchInterval` for a read of something no realtime event announces while a job is under way on
 * it — a landing or a merge: LANDING sessions publish nothing by contract
 * (docs/project-integration-line-contract.md, LS6), and neither does a merge check. Those keep their
 * own cadence `ms` while `inFlight` says such a job is running, and follow the stream otherwise.
 * A hidden tab reads neither: React Query holds every interval while the tab is hidden.
 */
export const pollWhileInFlight = (ms: number, inFlight: (query: PolledQuery) => boolean) =>
  (query: PolledQuery): number => (inFlight(query) ? ms : listPollMs(!streamDown(), query, ms));

/** What an interval function is handed of its query, as far as these read it. */
interface PolledQuery {
  queryHash: string;
  state: { data?: unknown };
}

/** Whether a merge candidate is being checked or merged right now. */
export const promotionInFlight = (promotion: unknown): boolean => {
  const state = (promotion as { state?: unknown } | null | undefined)?.state;
  return state === 'CHECKING' || state === 'CONFIRMED' || state === 'RECHECKING';
};

/** Whether a project's integration line has a job in flight: a task landing, or a merge into main. */
export const integrationInFlight = (integration: unknown): boolean =>
  typeof integration === 'object' && integration !== null && !Array.isArray(integration)
  && (integration as { inFlight?: unknown }).inFlight != null;

/** `staleTime` for a list the stream keeps current: what it holds stays good to show for the safety
 *  read's minute while the stream is live, so a list mounted on data just read (the splash's) is not
 *  read again. Any event about it marks it stale at once. While the stream is down, every mount reads. */
export const streamStaleTime = (): number => (streamDown() ? 0 : LIVE_FALLBACK_MS);

/** The app's retry rule: once, except while the stream is down, when a failed poll waits for its next
 *  turn rather than asking twice. */
export const retryUnlessStreamDown = (failureCount: number): boolean => failureCount < 1 && !streamDown();
