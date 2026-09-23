/**
 * The running-work sets a session stops having the moment it stops being live.
 *
 * `Session.runningBgShells` / `runningBgJobs` / `runningBgJobActivity` / `runningSubagents` are
 * inferred sets: an id goes in when a launch is seen or a runner reports the job it is hosting,
 * and comes out when that process reports its end — the schema's own note is that they are "only
 * meaningful while live". The report is the normal ending, and for a session that stays open it
 * is the only one needed: the events endpoint admits what its runner sends.
 *
 * The end of the run is the other ending, and there the report can no longer arrive. The control
 * plane writes the terminal status first, which takes the session out of OPEN, and the batch
 * carrying the drain's terminal `background_task` — one the runner DOES send, seconds later — is
 * refused with 409 "session is no longer open". /finalize's own backstop does not cover it
 * either: its write is gated on a LIVE row, which is what the session is no longer. So the ids
 * were retired by nobody and the session read "Background process running…" for the rest of its
 * life over no process at all — production sessions failed by an EXECUTABLE acceptance round, and
 * sessions reaped as `runner offline`, are both this.
 *
 * Hence: every write that takes a session out of OPEN clears them in that same statement. There
 * is nothing left to report — the session has no runtime, and the runner that held its jobs has
 * been told to tear down (cancelRequestedAt) or is gone. The one background process that can
 * outlive its engine, a runner-hosted job handed on across a self-update, is the adoption
 * `running` report's business, and by the time a session is resumed it is OPEN again — which is
 * exactly when that report is admitted. It is the rule the clients already apply to the tray: a
 * shell with no terminal notification on a session that has ended is not running
 * (`classifyShellStatus`, `sessionLive`).
 */
export const CLEARED_RUNNING_WORK = {
  runningBgShells: [],
  runningBgJobs: [],
  runningBgJobActivity: {},
  runningSubagents: [],
};
