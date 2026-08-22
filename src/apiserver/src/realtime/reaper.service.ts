import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunStatus, TaskStatus } from '@prisma/client';
import {
  AgentProvider,
  RunEventType,
  SessionEndReason,
  SessionLifecycleState,
  TRASH_RETENTION_DAYS,
  gracefulEndStatus,
  isApiErrorText,
  isAuthErrorText,
} from '@orbit/shared';
import { randomUUID } from 'crypto';
import { initializesRuntimeDynamically } from '../common/runtime-provider';
import { normalizeRuntimeProvider } from '../common/runtime-provider';
import { runnerOfflineIsFatal } from '../common/session-scheduling';
import { retireSessionInboxGeneration } from '../common/session-inbox-fence';
import { PrismaService } from '../prisma/prisma.service';
import { postRunFailureComment, reclaimStalledTask } from '../tasks/reclaim-stalled-task';
import { RealtimeService } from './realtime.service';

const REAP_INTERVAL_MS = 30_000;
// How often to permanently purge sessions that have sat in Trash past the retention
// window. Coarse (hourly) — the deletion isn't time-critical and the query usually
// removes nothing.
const PURGE_INTERVAL_MS = 60 * 60_000;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60_000;
const OFFLINE_AFTER_MS = 90_000; // runner missed ~3 heartbeats
// A cancel/end a live (online) runner hasn't honored within this window means the
// session is wedged — e.g. the runner restarted and never re-attached (no reclaim),
// so it can't see the inbox 'end' or the heartbeat cancel. Force-finalize the intent.
const CANCEL_GRACE_MS = 2 * 60_000;
const DYNAMIC_RUNTIME_STARTUP_GRACE_MS = 2 * 60_000;
// Codex may need to build the runner-wide SQLite index from a large local history
// before it can report a runtime id. The runner owns a shorter, bounded startup
// timeout; this is only the control-plane backstop for a live-but-wedged runner.
const CODEX_SHARED_STATE_STARTUP_GRACE_MS = 25 * 60_000;

const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
// What one sweep reads. Wider than LIVE by PENDING, and only so the cancel-grace branch can
// reach a queued session: claim requires `cancel_requested_at IS NULL`, so a cancel that lands
// on a PENDING row takes it out of the queue for good, and with LIVE alone nothing would ever
// finalize it — it sits at "Waiting for a free slot" with no owner. Every other branch below
// is guarded on its own status and skips these rows. LIVE stays as it was: it is also
// forceFinalize's default expected-status set, which must not silently widen to PENDING.
const SWEPT: RunStatus[] = [RunStatus.PENDING, ...LIVE];

/**
 * Background sweeper for interactive sessions (Route B). Without it, a session
 * whose runner dies mid-turn would sit RUNNING forever, leaking an active-turn slot.
 * An AWAITING_INPUT session is intentionally independent of runner liveness. v1 is single-replica;
 * for multi-replica this needs a leader lock (deferred to the HA phase).
 */
@Injectable()
export class ReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Reaper');
  private timer?: ReturnType<typeof setInterval>;
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.log.error('sweep failed: ' + (e as Error).message));
    }, REAP_INTERVAL_MS);
    this.timer.unref(); // don't keep the process alive just for the reaper
    this.purgeTimer = setInterval(() => {
      this.purgeTrash().catch((e) => this.log.error('trash purge failed: ' + (e as Error).message));
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /**
   * Permanently delete sessions that have sat in Trash (deletedAt) past the retention
   * window. The DB-level ON DELETE CASCADE drops each session's events, turns, tool calls,
   * usage, approvals, diff and session-scoped attachments along with it. This is the only
   * path that actually removes session data — soft-delete just hides it.
   */
  private async purgeTrash(): Promise<void> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
    const res = await this.prisma.session.deleteMany({ where: { deletedAt: { lt: cutoff } } });
    if (res.count > 0) {
      this.log.log(`purged ${res.count} trashed session(s) past ${TRASH_RETENTION_DAYS}-day retention`);
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const sessions = await this.prisma.session.findMany({
      where: { status: { in: SWEPT } },
      select: {
        id: true,
        taskId: true,
        assignedRunnerId: true,
        status: true,
        provider: true,
        providerBuiltin: true,
        runtimeSessionId: true,
        lastTurnAt: true,
        cancelRequestedAt: true,
        endReason: true,
        // §13.6 SU6: whether this run is DOING the task's work or looking at it. Only the first
        // follows the task's lifecycle; see `shouldEndTerminalTask`.
        startsTaskWork: true,
        task: { select: { status: true } },
        assignedRunner: { select: { lastHeartbeatAt: true, status: true } },
      },
    });
    for (const s of sessions) {
      try {
        const hb = s.assignedRunner?.lastHeartbeatAt?.getTime() ?? 0;
        const offline =
          !s.assignedRunner || s.assignedRunner.status === 'OFFLINE' || now - hb > OFFLINE_AFTER_MS;
        // A runner that hasn't honored a cancel/end in time is wedged. Handle this
        // before ordinary offline liveness so a graceful end remains graceful even if
        // the runner disappeared while tearing down.
        const cancelAt = s.cancelRequestedAt?.getTime() ?? 0;
        if (cancelAt && now - cancelAt > CANCEL_GRACE_MS) {
          const graceful = gracefulEndStatus(s.endReason);
          // A session still PENDING never reached a runner: no work could have failed, and
          // there is no process that could have honored the cancel. It settles CANCELLED —
          // the same terminal state transitionEnd gives a cancel that lands while the
          // session is still queued — rather than FAILED with a "not honored" error blaming
          // a runner that was never handed it.
          const queued = !graceful && s.status === RunStatus.PENDING;
          const status = graceful ?? (queued ? RunStatus.CANCELLED : undefined);
          await this.forceFinalize(
            s.id,
            s.assignedRunnerId,
            s.taskId,
            graceful
              ? `${s.endReason} end not honored`
              : queued
                ? 'cancelled while queued'
                : 'cancel not honored',
            status
              ? { status, expectedStatuses: [s.status] }
              : { expectedStatuses: [s.status] },
          );
          continue;
        }
        // A cancel/end still inside its grace window gets the same chance to settle
        // cleanly even if the runner heartbeat has just gone stale. Once the grace
        // expires the branch above applies the intended (including graceful) outcome.
        if (cancelAt) continue;
        const taskEndReason =
          s.task?.status === TaskStatus.DONE
            ? SessionEndReason.TASK_DONE
            : s.task?.status === TaskStatus.CANCELLED
              ? SessionEndReason.TASK_CANCELLED
              : null;
        // §13.6 SU6: only a run that is DOING the task's work follows the task's lifecycle.
        //
        // A salvage session — `startsTaskWork = false`, which is what an explicit session_create
        // against a task writes — is somebody reading a run that already happened. Migration 0130
        // permits exactly that against a retired (and therefore CANCELLED or FAILED) task, and
        // ending it here on the next sweep would make the permission worthless: the conversation
        // gets one tick, is closed as TASK_CANCELLED, and the categorical revive rule then refuses
        // to bring it back. A window that closes itself is not a window.
        const shouldEndTerminalTask =
          s.status === RunStatus.AWAITING_INPUT && taskEndReason !== null && s.startsTaskWork;
        if (offline && !shouldEndTerminalTask) {
          // RUNNING is an active turn and cannot survive losing its runner. An idle
          // AWAITING_INPUT/INTERRUPTED session consumes no slot and remains resumable;
          // its next message simply waits in PENDING until this runner is online.
          if (runnerOfflineIsFatal(s.status)) {
            await this.forceFinalize(s.id, s.assignedRunnerId, s.taskId, 'runner offline', {
              expectedStatuses: [RunStatus.RUNNING],
              onlyIfNotCancelling: true,
              // Losing the runner says nothing about the work — the same message succeeds on
              // a plain re-send — so this is the one finalize here that auto-retry can undo
              // by itself. A task-bound session is deliberately excluded: reclaimStalledTask
              // just put its task back in the actionable pool, and the task scheduler picking
              // it up again IS its retry. Arming here too would race that with a second one.
              armRetry: !s.taskId,
            });
          }
          continue;
        }
        // Session.provider is NOT NULL, so there is nothing to inherit here — and a workspace
        // holds no provider to inherit from (workspace-provider.ts).
        const provider = normalizeRuntimeProvider(s.provider, s.providerBuiltin);
        const lastTurn = s.lastTurnAt?.getTime() ?? 0;
        const runtimeStartupGrace =
          provider === AgentProvider.CODEX
            ? CODEX_SHARED_STATE_STARTUP_GRACE_MS
            : DYNAMIC_RUNTIME_STARTUP_GRACE_MS;
        if (
          initializesRuntimeDynamically(provider) &&
          s.status === RunStatus.RUNNING &&
          !s.runtimeSessionId &&
          now - lastTurn > runtimeStartupGrace
        ) {
          await this.forceFinalize(
            s.id,
            s.assignedRunnerId,
            s.taskId,
            `${provider} runtime not initialized`,
            { expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true },
          );
          continue;
        }
        // Backstop for a task run whose last turn ended in a Claude API error (e.g.
        // content filtering) or an expired sign-in: the SDK reports it as a successful
        // turn, so an older runner parks the session at AWAITING_INPUT and the task stays
        // IN_PROGRESS with nothing watching. (Current runners flag the turn FAILED at the
        // source, so this only catches sessions a stale runner left behind — which outlive
        // a release, since a runner only self-updates at startup.) Finalize FAILED and
        // reclaim the task as FAILED. Task-bound, online, not-being-cancelled only.
        if (s.status === RunStatus.AWAITING_INPUT && s.taskId && !s.cancelRequestedAt) {
          const last = await this.prisma.runEvent.findFirst({
            where: { sessionId: s.id, type: RunEventType.ASSISTANT },
            orderBy: { seq: 'desc' },
            select: { payload: true },
          });
          const text = (last?.payload as { text?: string } | null)?.text;
          if (isApiErrorText(text) || isAuthErrorText(text)) {
            const why = isAuthErrorText(text) ? 'run failed (sign-in expired)' : 'run failed (API error)';
            await this.forceFinalize(s.id, s.assignedRunnerId, s.taskId, why, {
              resetTaskTo: TaskStatus.FAILED,
              failureDetail: text,
              expectedStatuses: [RunStatus.AWAITING_INPUT],
              onlyIfNotCancelling: true,
            });
            continue;
          }
        }
        // A task-bound runtime has no more work once its task is terminal. This is a
        // business completion, not idle expiry: DONE moves its execution session to
        // Completed, while a cancelled task and ordinary AWAITING_INPUT sessions stay Open.
        // Terminal tasks deliberately reach this point even with an offline runner: the
        // durable end claim starts the cancel grace timer, whose later sweep can finalize
        // without that runner. Ordinary parked sessions still returned above.
        if (shouldEndTerminalTask) {
          await this.endParked(s.id, s.assignedRunnerId, taskEndReason);
        }
      } catch (e) {
        // Isolate per-session failures so one doesn't skip the rest; retried next sweep.
        this.log.error(`reap of ${s.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Finalize a stalled live session, drain queued turns, signal + publish terminal.
   * `status` is FAILED for a genuine breakdown — `reason` is then recorded as the session's
   * error — or the benign terminal state a graceful end would have reached (CANCELLED/
   * SUCCEEDED) when the runner merely never acknowledged that end; there `reason` is only a
   * log/publish detail and no error is written. `resetTaskTo` is how a now-stalled
   * IN_PROGRESS task is reclaimed: OPEN for a retryable end (dead/partitioned runner,
   * unhonored cancel) or FAILED for a genuine run failure. A SUCCEEDED finish leaves the
   * task alone — the workspace owns DONE.
   */
  private async forceFinalize(
    sessionId: string,
    runnerId: string | null,
    taskId: string | null,
    reason: string,
    opts: {
      status?: RunStatus;
      resetTaskTo?: TaskStatus;
      // Detail recorded on the task comment for a genuine failure (resetTaskTo=FAILED);
      // defaults to `reason`. Lets the API-error backstop surface the actual error text.
      failureDetail?: string;
      /** State observed by the sweep; prevents a stale decision finalizing a newer turn. */
      expectedStatuses?: RunStatus[];
      /** Non-cancel decisions must not overwrite an end/cancel that won the race. */
      onlyIfNotCancelling?: boolean;
      /** Hand this session to AutoRetryService instead of leaving it for the user to
       *  re-send by hand. Only for a finalize that says nothing about the work itself. */
      armRetry?: boolean;
    } = {},
  ): Promise<void> {
    const status = opts.status ?? RunStatus.FAILED;
    const failed = status === RunStatus.FAILED;
    // Due immediately (see below), and carried on the published STATUS so that event says the
    // same thing the row does: this end is one the server means to undo, not a settlement.
    const retryAt = opts.armRetry ? new Date() : null;
    const resetTaskTo = opts.resetTaskTo ?? TaskStatus.OPEN;
    const ok = await this.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: { in: opts.expectedStatuses ?? LIVE },
          ...(opts.onlyIfNotCancelling ? { cancelRequestedAt: null } : {}),
        },
        // Set cancelRequestedAt too so the heartbeat cancel-drain tells a runner
        // recovering from a partition to stop (the session is already finalized here).
        data: {
          status,
          ...(failed ? { error: reason } : {}),
          // Due immediately: AutoRetryService's own sweep is what waits for the runner to
          // come back, so arming for "now" makes the first sweep after this the first check
          // rather than a fixed delay guessing when the runner returns.
          ...(retryAt ? { retryAt } : {}),
          finishedAt: new Date(),
          cancelRequestedAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      await retireSessionInboxGeneration(tx, sessionId);
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      // Reclaim a now-stalled IN_PROGRESS task so it stops showing as running.
      if (taskId && status !== RunStatus.SUCCEEDED) {
        await reclaimStalledTask(tx, taskId, resetTaskTo);
      }
      // For a genuine failure, record it on the task timeline (independent of whether
      // the task was IN_PROGRESS, so a run that never reached IN_PROGRESS is covered).
      if (taskId && failed && resetTaskTo === TaskStatus.FAILED) {
        await postRunFailureComment(tx, taskId, opts.failureDetail ?? reason);
      }
      return true;
    });
    if (!ok) return;
    if (runnerId) this.realtime.requestCancel(runnerId, sessionId);
    this.realtime.publish(sessionId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status, final: true, reason, ...(retryAt ? { retryAt: retryAt.toISOString() } : {}) },
    });
    const msg = `reaped session ${sessionId} -> ${status} (${reason})`;
    if (failed) this.log.warn(msg);
    else this.log.log(msg);
  }

  /**
   * Gracefully tear down a session parked at AWAITING_INPUT (inbox 'end' turn +
   * cancel). Triggered only when the session's task is already terminal; a DONE task
   * atomically files its execution session in Completed as part of the claim. Ordinary
   * process-idle expiry is runner-local and leaves the Session AWAITING_INPUT.
   */
  private async endParked(
    sessionId: string,
    runnerId: string | null,
    reason: SessionEndReason,
  ): Promise<void> {
    const taskStatus =
      reason === SessionEndReason.TASK_DONE ? TaskStatus.DONE : TaskStatus.CANCELLED;
    // Claim the teardown atomically: re-evaluate the trigger at execution time and put
    // the cancelRequestedAt flip + the 'end' turn in ONE transaction so a seq P2002
    // rolls BOTH back (no half-ended, wedged session). Retried next sweep if so. The
    // re-check mirrors sweep() — still parked and its task is terminal — so a turn
    // that arrived since the sweep read doesn't get cut off.
    const done = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: RunStatus.AWAITING_INPUT,
          cancelRequestedAt: null,
          // Re-check the exact terminal outcome, not merely "some terminal state": a
          // stale sweep must never turn a cancelled task into task_done/SUCCEEDED.
          task: { status: taskStatus },
          // Trash remains authoritative over Completed even for an anomalous live row.
          ...(reason === SessionEndReason.TASK_DONE ? { deletedAt: null } : {}),
        },
        data: {
          cancelRequestedAt: now,
          endReason: reason,
          ...(reason === SessionEndReason.TASK_DONE
            ? { completedAt: now, archivedAt: now }
            : {}),
        },
      });
      if (claimed.count === 0) return false;
      const last = await tx.conversationTurn.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.conversationTurn.create({
        data: {
          sessionId,
          seq: (last?.seq ?? 0) + 1,
          clientTurnId: randomUUID(),
          kind: 'end',
          status: 'PENDING',
        },
      });
      return true;
    });
    if (!done) return;
    if (reason === SessionEndReason.TASK_DONE) {
      this.realtime.publishSessionLifecycleChanged(
        sessionId,
        RunStatus.AWAITING_INPUT,
        reason,
        SessionLifecycleState.COMPLETED,
      );
    }
    if (runnerId) this.realtime.requestCancel(runnerId, sessionId);
    this.realtime.notifyInbox(sessionId);
    this.log.log(`recycling parked session ${sessionId}`);
  }
}
