import { Prisma } from '@prisma/client';

/**
 * The runner dispatch pause (docs/runner-link-design.md §11.1, §11.3, decision D8; migration 0442).
 *
 * An administrator turns it on before the runner link cut-over, so that the turns, integration jobs and
 * merges/commits already running can finish before the deploy, and turns it off once the runners are back.
 * While it is on, no runner is handed new work:
 *
 *   - no session is claimed (QueueService.trySessionClaim);
 *   - the inbox hands out no message, shell or reload (RunnerApiController.dequeueTurn). Interrupt, end
 *     and the other control turns still go out, and so does a steer written into the turn already
 *     running. A run that has no turn in flight and a queued one waiting — claimed just before the
 *     switch, or the slot a finished turn passed to its follow-up — is put back in the queue the way an
 *     account pause puts one back, rather than left RUNNING with nothing running;
 *   - no queued integration job is claimed (integration-job-relay.ts, claimOne).
 *
 * What is already running carries on: its events, its completion, its approvals, the re-delivery of a turn
 * to the process that replaced its runner's, and the takeover of an integration job whose claimer stopped
 * reporting. New messages stay PENDING on the server. Turning it off lets the same paths hand the held work
 * out on their next round, and wakes them once (`DispatchPauseService.set`).
 *
 * The row is read inside each statement that would hand the work out (`DISPATCH_PAUSED`), never cached, so
 * every replica obeys a switch the moment it commits, and a deployment that never paused — no row — reads
 * as it did before. The service that reads and switches it is `dispatch-pause.service.ts`; this file only
 * holds what the statements it governs embed, so `queue.service.ts` can import it without a cycle.
 */

/** True while the dispatch pause is on. It binds no parameter, so a statement embedding it binds what it did before. */
export const DISPATCH_PAUSED = Prisma.sql`COALESCE((SELECT dp."paused" FROM "dispatch_pause" dp WHERE dp."id" = 1), false)`;

/**
 * The global claim lock QueueService.trySessionClaim takes before every claim. The switch takes it too, so a
 * claim already inside it commits before the pause does, and every claim after it reads the pause.
 * `dispatch-pause.spec.ts` holds the two to the same key.
 */
export const SESSION_CLAIM_LOCK = 'SELECT pg_advisory_xact_lock(1330792788, 1)';

/** A message or shell turn handed out and not yet answered. */
export interface RunningTurn {
  turnId: string;
  sessionId: string;
  runnerId: string | null;
  kind: string;
  /** When it was handed to the process running it now. */
  deliveredAt: Date | null;
  /** Past it, the runner holding the turn stopped renewing it: a replacement process is handed it again. */
  leaseDeadlineAt: Date | null;
  elapsedSeconds: number | null;
}

/** An integration job a runner has claimed and not yet reported the end of. */
export interface RunningIntegrationJob {
  jobId: string;
  projectId: string;
  kind: string;
  runnerId: string | null;
  phase: string | null;
  /** The current claim: a takeover starts it again. */
  claimedAt: Date | null;
  elapsedSeconds: number | null;
}

/** A merge or commit asked for and not yet settled. */
export interface RunningWorktreeOperation {
  sessionId: string;
  runnerId: string | null;
  operation: 'merge' | 'commit';
  /** A runner process has taken it up. Unclaimed, it is handed out at its runner's next heartbeat. */
  claimed: boolean;
  /**
   * When it was asked for, or — once claimed — when its runner last took it up: every heartbeat while it
   * runs restamps it (realtime.service.ts, drainMergeRequests). The row keeps nothing earlier.
   */
  requestedAt: Date | null;
  elapsedSeconds: number | null;
}

/** GET /api/admin/dispatch-pause. */
export interface DispatchPauseView {
  paused: boolean;
  /** When it was last switched; null while it never was. */
  updatedAt: Date | null;
  /** The administrator who switched it. */
  updatedById: string | null;
  /** What a cut-over waits for (§11.3 step 2), oldest first. Each `elapsedSeconds` is counted on the database's clock. */
  running: {
    turns: RunningTurn[];
    integrationJobs: RunningIntegrationJob[];
    worktreeOperations: RunningWorktreeOperation[];
  };
}
