/**
 * When a runner-hosted background job last produced output — the difference between "a process is
 * still up" and "that process is still moving".
 *
 * `Session.runningBgJobs` answers "is a job in flight", off the runner's own `running` report. A
 * job that deadlocks, blocks on a lock nobody holds, or hangs on a socket that will never answer
 * gives that answer just as convincingly as one that is working: the process is up either way, and
 * nothing in the report is about progress. Such a job lights the clients' breathing terminal glyph
 * — and the workspace rail's quiet dot — until it ends, which for a hung job is hours.
 *
 * So the marker's meaning narrows to "there is work in flight AND it moved recently". The runner is
 * the only party that knows when a job last produced output — it tails the job's `.output` file
 * (runner-go background.go) — and it states it as the elapsed time since that moment, on its own
 * clock, on the same `running` report that carries the job's kind. This module is the control
 * plane's half: what it records from those reports, and what it counts as still moving.
 *
 * WHY AN IDLE DURATION RATHER THAN A TIMESTAMP. The runner and the control plane are different
 * machines, and their clocks are not the same clock. Comparing a runner-stamped `lastOutputAt`
 * against the control plane's `now()` is wrong by however far the two disagree — in the direction
 * that keeps a stalled job looking busy (runner behind) or darkens a working one (runner ahead). A
 * duration crosses that boundary intact: `receivedAt - idleMs` restates the last-output instant in
 * the control plane's own timebase, and everything after that is measured by one clock. It also
 * degrades honestly when the runner stops reporting at all (a crash, a machine asleep): the stored
 * instant stays put and the silence goes on growing, so the marker goes dark on its own.
 */

/**
 * How long a job may produce nothing before it stops counting as work in flight.
 *
 * WHAT IT CATCHES: a `bg_run` whose process is up and no longer moving — a deadlock, a wait on a
 * lock or a socket that will never be satisfied, a `wait()` on a child that never exits. Those are
 * precisely the jobs that read as busy for hours today, and the reason a marker built only on "a
 * process is up" is not worth drawing.
 *
 * WHAT IT WRONGLY CATCHES — the known false positive: a job that is working and simply writing
 * nothing. `sleep 300`, a CPU-bound compile or benchmark, anything that buffers its output until it
 * exits. Ten minutes of silence from one of those reads as a stall and the glyph stops. The
 * alternatives were rejected on their merits, not for cost: CPU load and live children do not
 * separate the two cases at all — a deadlocked process can spin a core or hold a dozen live
 * children, and a job blocked on a slow read sits at 0% CPU with none. "Has it written anything" is
 * also the one of the three facts the runner already has, since it tails the file; the others would
 * need a new probe per job per runner, and would still be guessing.
 *
 * WHAT IT COSTS WHEN IT IS WRONG: the job does not disappear. It stays in `runningBgShells` (the
 * process is still up, and the tray still lists it), `bg_output` still reads it, and its terminal
 * report still lands. What stops is one glyph.
 *
 * WHY TEN MINUTES: the runner re-reports a job's silence every minute (runner-go
 * bgJobHeartbeatInterval) and tails its output every two seconds (bgPollInterval), so the
 * measurement underneath is fine-grained and this is a pure threshold on it. It has to be many
 * times the reporting cadence — a threshold near it would flap on one late report — and long enough
 * that an ordinary quiet stretch of a working job (a compile's silent phase, a long fetch) never
 * trips it. Ten minutes is where those meet: ten heartbeat intervals of margin, and a stalled job's
 * marker dark within a coffee break of it actually stalling.
 */
export const BG_JOB_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;

/**
 * Per job, the instant its output last moved — in the CONTROL PLANE's timebase, and only for jobs
 * the session's `runningBgJobs` currently holds. An id with no entry is a job whose progress has
 * never been reported (an older runner, which sends no `idleMs`): unknown, and therefore counted as
 * it was before this column existed rather than assumed stalled.
 */
export type BgJobActivity = Record<string, number>;

/** What one `running` report says about its job's output: how long it has been silent, in ms. */
export type BgJobIdleReport = { id: string; idleMs: number | null };

/** The stored column, as `unknown` — it is jsonb, and nothing here trusts its shape. */
export function readBgJobActivity(value: unknown): BgJobActivity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const activity: BgJobActivity = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    const instant = typeof at === 'number' ? at : Number.NaN;
    if (id !== '' && Number.isFinite(instant)) activity[id] = instant;
  }
  return activity;
}

/**
 * The activity map to store for a session whose live job set is `jobs`, after one batch of reports
 * arrived at `receivedAtMs`: what is already known about a job still in that set, with this batch
 * applied.
 *
 * `receivedAtMs - idleMs` is where the report places the job's last output, and it is taken as
 * stated: a report is the freshest evidence the control plane has about that job, and the silence it
 * states is what the readers age from the moment they read. While a job is quiet the value it lands
 * on does not move (the silence grows exactly as the time since the last report does); when the job
 * writes, it jumps to now. So the sequence is monotone in ordinary operation and needs no help.
 *
 * The one clamp is against the FUTURE: a report cannot know about output that had not happened when
 * it was sent, so an instant later than the report's own arrival is not evidence of anything. A
 * negative `idleMs` — a runner clock that stepped backwards while its job was writing — otherwise
 * lands in the future and pins the marker on until that future arrives. Two claims for one job in
 * one batch resolve to the later instant of the two, the more recent observation winning.
 *
 * Anything not in `jobs` is dropped, which is what keeps this map the size of the session's live
 * jobs: the reports for a `service` (never work in flight) and for a job that ended in this same
 * batch are read out of the same event list, and neither has anything left to describe.
 */
export function bgJobActivityAfterReports(
  stored: unknown,
  jobs: readonly string[],
  reports: readonly BgJobIdleReport[],
  receivedAtMs: number,
): BgJobActivity {
  const known = readBgJobActivity(stored);
  const reported = new Map<string, number>();
  for (const report of reports) {
    if (report.id === '' || typeof report.idleMs !== 'number' || !Number.isFinite(report.idleMs)) continue;
    const instant = Math.min(receivedAtMs, receivedAtMs - Math.max(0, report.idleMs));
    const previous = reported.get(report.id);
    reported.set(report.id, previous === undefined ? instant : Math.max(previous, instant));
  }
  const activity: BgJobActivity = {};
  for (const id of jobs) {
    const instant = reported.get(id) ?? known[id];
    if (instant !== undefined) activity[id] = instant;
  }
  return activity;
}

/**
 * Whether two activity maps say the same thing. What they say is which job last moved when, so key
 * order is not part of it — and it does differ between a stored map (ordered by the live set of the
 * batch that wrote it) and a recomputed one (ordered by the live set now). Only used to keep a
 * heartbeat that carried nothing new from writing the hot Session row.
 */
export function sameBgJobActivity(a: unknown, b: unknown): boolean {
  const left = readBgJobActivity(a);
  const right = readBgJobActivity(b);
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every((id) => right[id] === left[id]);
}

/**
 * The subset of a session's live jobs that is still moving: its output moved within the threshold,
 * or nobody has said when it last moved (see `BgJobActivity`). `nowMs` is a parameter so the
 * verdict is reproducible where it is asserted, and so every reader in one response decides against
 * the same instant.
 *
 * This is the ONE place the threshold is applied. It is deliberately not a stored answer: staleness
 * is a fact about `now`, so a column holding "is it fresh" would be wrong the moment it was
 * written, and would need a writer awake for every job that ever stalls — which, by definition, is
 * the case where nothing is being written.
 */
export function freshRunningBgJobs(
  jobs: readonly string[],
  activity: unknown,
  nowMs: number = Date.now(),
): string[] {
  const known = readBgJobActivity(activity);
  return jobs.filter((id) => {
    const lastMovedAt = known[id];
    return lastMovedAt === undefined || nowMs - lastMovedAt < BG_JOB_ACTIVITY_STALE_AFTER_MS;
  });
}
