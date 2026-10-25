import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
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
import { sessionEngine } from '../providers/session-engine';
import { runnerOfflineIsFatal } from '../common/session-scheduling';
import { retireSessionInboxGeneration } from '../common/session-inbox-fence';
import { PrismaService } from '../prisma/prisma.service';
import { postRunFailureComment, reclaimStalledTask } from '../tasks/reclaim-stalled-task';
import { RealtimeService } from './realtime.service';
import {
  classifyTransactionFault,
  loggedRetry,
  withTransactionRetry,
} from '../common/transaction-retry';
import {
  CURRENT_WORK_SESSION_REAPED,
  terminalizePendingCurrentWorkSteers,
} from '../sessions/current-work-delivery';
import { CLEARED_RUNNING_WORK } from '../sessions/running-work';
import { deadLetterQueuedWatchWakes } from '../watches/watch-wake-drain';
import { TaskFailureHow, returnQueuedTurns } from '../projects/project-open-item';
import { settleUnrunSessionRequests } from '../sessions/session-request';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { RUNNER_LINK_REVOCATION_WINDOW_MS } from '../runner-api/runner-link-token';
import {
  RUNNER_BEATS,
  RUNNER_OFFLINE_AFTER_MS,
  RunnerPresenceService,
  runnerLastBeatAt,
  type RunnerBeats,
} from '../runners/runner-presence';

const REAP_INTERVAL_MS = 30_000;
// How often to permanently purge sessions that have sat in Trash past the retention
// window. Coarse (hourly) — the deletion isn't time-critical and the query usually
// removes nothing.
const PURGE_INTERVAL_MS = 60 * 60_000;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60_000;
const OFFLINE_AFTER_MS = RUNNER_OFFLINE_AFTER_MS; // runner missed ~3 heartbeats
/**
 * How long after it starts the reaper reaps no session as `runner offline`. Its evidence is the
 * absence of beats in `runner_presence`, an UNLOGGED table a crash or a failover of the primary
 * empties (docs/runner-link-design.md §6.5); a control plane that has just come up — after a deploy,
 * or beside a database that just came back — has not yet had the time to hear every live runner
 * again. Two windows of OFFLINE_AFTER_MS: six heartbeat intervals.
 */
const STARTUP_GRACE_MS = 3 * 60_000;
/**
 * The share of the cell's runners that going quiet together pauses the offline reaping. Machines do
 * not stop a fifth at a time; a link gateway, the network or this control plane does, and the
 * sessions of runners that are only cut off must still be there when they come back.
 */
const MASS_SILENCE_SHARE = 0.2;
/**
 * "Together": crossed the offline line within this long of each other, and of now. It also bounds
 * how long one such silence holds the reaping: a runner quiet for longer than this past the line
 * leaves the count, and its sessions are reaped as anybody's are.
 */
const MASS_SILENCE_WINDOW_MS = 10 * 60_000;
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
 * Whether a runner has stopped answering, as this service reads it.
 *
 * One function rather than an expression at each site because it is asked TWICE about the same
 * session and the two answers have to be the same question: once from the sweep's snapshot, to
 * decide there is something to do, and once inside the transaction that actually writes FAILED,
 * against whatever the row says by then. Two copies of `now - hb > OFFLINE_AFTER_MS` are two
 * copies that can drift, and the whole point of the second ask is that it is the first one's
 * predicate re-run, not a similar one.
 *
 * `status` is not a second opinion: nothing in this control plane ever writes OFFLINE, which only
 * a runner reports about itself on its way out (`runner-api.controller.ts` heartbeat). A crashed
 * machine leaves ONLINE behind, so the heartbeat's age is the whole of the signal.
 *
 * Save for one thing the runner says just as surely: `claimedAt`, the session's own claim of the
 * run (`run_claimed_at`), is the runner process asking for this very run, and one inside the window
 * is presence. A process that has just started claims at once, while its first heartbeat waits for
 * the first tick of its 30-second ticker (runner-go runloop.go), so for that long the runner's last
 * beat is still its predecessor's. A managed runner woken from sleep is exactly that, every
 * time: on the lab's real k3s (task T06, 2026-10-18) the run a woken runner claimed at 00:56:34.7
 * was finalized `runner offline` at 00:56:35.4, its heartbeat six minutes old from before the sleep.
 * The finalizing write asks the same of the row it writes (`claimedLongAgo`), under its lock.
 *
 * The beat is read as every reader of presence reads it (runners/runner-presence.ts): both records
 * of it, selected with RUNNER_BEATS, the later winning.
 */
function runnerLooksOffline(
  runner: ({ status: string } & RunnerBeats) | null | undefined,
  now: number,
  claimedAt?: Date | null,
): boolean {
  if (!runner) return true;
  if (claimedAt && now - claimedAt.getTime() <= OFFLINE_AFTER_MS) return false;
  if (runner.status === 'OFFLINE') return true;
  return now - (runnerLastBeatAt(runner)?.getTime() ?? 0) > OFFLINE_AFTER_MS;
}

/** `runnerLooksOffline`'s claim clause as the finalizing write's WHERE: not claimed inside the window. */
function claimedLongAgo(now: number) {
  return { OR: [{ runClaimedAt: null }, { runClaimedAt: { lt: new Date(now - OFFLINE_AFTER_MS) } }] };
}

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
  /**
   * Whether the PREVIOUS sweep watched the database refuse a unit of work.
   *
   * Carried across the sweep boundary because the verdict is about a span, not an instant: a
   * session is called offline on 90s of silence, and sweeps are 30s apart, so the silence a sweep
   * is reading overlaps the sweeps before it. A refusal in any of them is a refusal that could
   * have produced the silence. One sweep the database answers in full clears it — this is
   * disqualified evidence, not a latch, or the first storm would stop the reaper for the life of
   * the process.
   */
  private databaseRefusedWorkLastSweep = false;
  /** When the reaper started (onModuleInit): the clock STARTUP_GRACE_MS runs on. */
  private startedAt: number | null = null;
  /**
   * Until when the offline reaping stays held for the last mass silence a sweep saw: OFFLINE_AFTER_MS
   * past that sweep, so the runners whose beats were lost in it get a whole window to be heard again.
   */
  private massSilenceHeldUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    /** Hands the exception items this sweep opens to whoever is responsible for them (§4.4). */
    @Optional() private readonly openItems?: ProjectOpenItemService,
    /**
     * Whether heartbeat writes have been landing, and how much of the cell has gone quiet at once
     * (runners/runner-presence.ts) — two of the reasons a runner's silence is not evidence
     * (`silenceHold`). RealtimeModule provides it beside this service, so production always has it;
     * `@Optional()` for the specs that build the reaper by hand about something else.
     */
    @Optional() private readonly presence?: RunnerPresenceService,
  ) {}

  onModuleInit(): void {
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.log.error('sweep failed: ' + (e as Error).message));
    }, REAP_INTERVAL_MS);
    this.timer.unref(); // don't keep the process alive just for the reaper
    this.purgeTimer = setInterval(() => {
      this.purgeTrash().catch((e) => this.log.error('trash purge failed: ' + (e as Error).message));
      this.purgeLapsedLinkRevocations().catch((e) =>
        this.log.error('runner link revocation purge failed: ' + (e as Error).message));
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

  /**
   * Delete the runner link revocations older than a connection token's lifetime (migration 0443):
   * every token minted with those credentials has expired, so they can refuse nothing. Runs whether
   * or not the link is configured, because the trigger that writes them runs either way.
   */
  private async purgeLapsedLinkRevocations(): Promise<void> {
    const cutoff = new Date(Date.now() - RUNNER_LINK_REVOCATION_WINDOW_MS);
    await this.prisma.runnerLinkRevocation.deleteMany({ where: { revokedAt: { lt: cutoff } } });
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const sessions = await this.prisma.session.findMany({
      // A LANDING row is platform-driven and has no runner: it must never read as a dropped run,
      // be force-finalized or be armed for a retry (§2.9 LS6).
      where: { status: { in: SWEPT }, sessionKind: 'CONVERSATION' },
      select: {
        id: true,
        taskId: true,
        assignedRunnerId: true,
        status: true,
        provider: true,
        providerBuiltin: true,
        engine: true,
        ownerId: true,
        runtimeSessionId: true,
        lastTurnAt: true,
        // The claim of the current run: presence as much as a heartbeat (runnerLooksOffline).
        runClaimedAt: true,
        cancelRequestedAt: true,
        endReason: true,
        // §13.6 SU6: whether this run is DOING the task's work or looking at it. Only the first
        // follows the task's lifecycle; see `shouldEndTerminalTask`.
        startsTaskWork: true,
        // `autoRunWhenReady` is read for the offline branch below: it is the column every
        // auto-run candidate scan requires, so it is the column that says whether the retry
        // this reaper stands aside for exists at all.
        task: { select: { status: true, autoRunWhenReady: true } },
        assignedRunner: { select: { status: true, ...RUNNER_BEATS } },
      },
    });
    // Whether THIS sweep has watched the database refuse a unit of work; see the field above for
    // why the answer outlives the sweep. Read together with it, so a refusal fences the rest of
    // this sweep as well as the next one.
    let databaseRefusedWork = false;
    const heartbeatEvidenceIsDisqualified = () =>
      databaseRefusedWork || this.databaseRefusedWorkLastSweep;
    // Whether runner silence is evidence at all this sweep (`silenceHold`). Asked once, and only when
    // some session would be reaped for it: most sweeps find none. A reading the database refused is a
    // hold too, and fences the next sweep like any other refusal.
    let hold: Promise<string | null> | undefined;
    const silenceHeld = () => (hold ??= this.silenceHold(now).catch((e: unknown) => {
      if (classifyTransactionFault(e).family === 'RESOURCE') databaseRefusedWork = true;
      return `the cell's presence could not be read (${(e as Error).message})`;
    }));
    const held: string[] = [];
    for (const s of sessions) {
      try {
        const offline = runnerLooksOffline(s.assignedRunner, now, s.runClaimedAt);
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
            // "Offline" is read off the ABSENCE of a heartbeat write, so it is only a fact about
            // the runner while the writes this control plane takes were landing. Once they were
            // not, the silence is as likely to be ours; leave the session for a sweep that can
            // tell the difference. Named in the log, because the whole reason this exists is that
            // `runner offline` sent the 2026-09-15 investigation to the machines.
            if (heartbeatEvidenceIsDisqualified()) {
              this.log.warn(
                `not reaping ${s.id}: this control plane could not reach its own database within ` +
                  `the window its ${OFFLINE_AFTER_MS}ms of runner silence was read from`,
              );
              continue;
            }
            // The same rule, widened to the rest of what makes silence ours (`silenceHold`): just
            // started, heartbeat writes failing, or a fifth of the cell gone quiet at once. Logged
            // once for the sweep below — a mass silence holds every such session at once.
            if (await silenceHeld()) {
              held.push(s.id);
              continue;
            }
            await this.forceFinalize(s.id, s.assignedRunnerId, s.taskId, 'runner offline', {
              expectedStatuses: [RunStatus.RUNNING],
              onlyIfNotCancelling: true,
              // The verdict above came from ONE snapshot taken at the top of this sweep, and this
              // write happens a transaction-per-session later. Re-ask inside the transaction.
              requireRunnerStillOffline: true,
              // Losing the runner says nothing about the work — the same message succeeds on
              // a plain re-send — so this is the one finalize here that auto-retry can undo
              // by itself. A task-bound session stands aside for the task scheduler instead:
              // reclaimStalledTask just put its task back in the actionable pool, and the
              // scheduler picking it up again IS its retry. Arming both would be two of them.
              //
              // That substitute is CONDITIONAL, and this is where the condition is checked. All
              // three auto-run candidate scans require `t.auto_run_when_ready = true`
              // (tasks.service.ts AUTO_RUN_READY_SQL, PROJECT_INDEPENDENT_READY_SQL,
              // AUTO_RUN_RETRY_CANDIDATE_SQL), as does the instant edge that dispatches a
              // dependent when its prerequisite completes — so a reclaimed task that does not
              // opt in is retried by NOBODY. It used to be excluded here for having a task at
              // all, which handed it to a scheduler that would never select it: two of the four
              // sessions reaped on 2026-09-15 were left that way, one of them holding 88
              // uncommitted lines that only a hand-exported patch saved. The stand-down now
              // names the retry it is standing aside for, and happens only when there is one.
              //
              // Arming the other case does NOT put two retries on one task if the opt-in flips
              // to true in between. `session_task_execution_claim_idx` (migration 0130) is a
              // partial UNIQUE index on `session(task_id)` over exactly the TASK_OCCUPYING
              // statuses, so a task can hold ONE live session and no more: whichever starts
              // first is seen by the scans' own `NOT EXISTS (occupying session)` clause, and a
              // resume that races past that read loses at the index — a 23505 the transaction
              // classifier calls permanent, so auto-retry takes its ordinary backoff rather than
              // spinning. Neither §13.6 SU6 nor §13.1 AG6 answers this one; they are about
              // supersession and aggregate parents, and neither looks at who else is running.
              //
              // Arming is also the outcome that keeps the work. Auto-retry resumes THIS session,
              // and the runner keys a checkout by session id (runner-go/worktree.go), so it
              // re-attaches the same worktree on the same branch; a fresh dispatch is a new
              // session id, and therefore a new worktree and a new branch, with the uncommitted
              // work left behind in the old one.
              armRetry: !s.taskId || !s.task?.autoRunWhenReady,
              taskFailure: 'ATTEMPT_LOST_RUNNER_OFFLINE',
            });
          }
          continue;
        }
        // The engine the session runs on — its own (Session.engine), not the one its slug reads as:
        // a Codex, Kimi, OpenCode, Antigravity or Harness session on a key or a pool initializes its
        // runtime the same way the built-in one does, and stalls the same way. One nobody can place
        // (its credential gone before an engine was recorded) is not judged here.
        const provider =
          s.status === RunStatus.RUNNING && !s.runtimeSessionId ? await sessionEngine(this.prisma, s) : null;
        const lastTurn = s.lastTurnAt?.getTime() ?? 0;
        const runtimeStartupGrace =
          provider === AgentProvider.CODEX
            ? CODEX_SHARED_STATE_STARTUP_GRACE_MS
            : DYNAMIC_RUNTIME_STARTUP_GRACE_MS;
        if (
          provider &&
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
            {
              expectedStatuses: [RunStatus.RUNNING],
              onlyIfNotCancelling: true,
              taskFailure: 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED',
            },
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
              taskFailure: 'REAPED_API_ERROR',
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
        // Isolate per-session failures so one doesn't skip the rest; retried next sweep. A failure
        // that was the DATABASE refusing the work — rather than the data answering — also fences
        // the offline branch above, for this sweep and the next.
        if (classifyTransactionFault(e).family === 'RESOURCE') databaseRefusedWork = true;
        this.log.error(`reap of ${s.id} failed: ${(e as Error).message}`);
      }
    }
    this.databaseRefusedWorkLastSweep = databaseRefusedWork;
    if (held.length > 0) {
      const named = held.slice(0, 10).join(', ') + (held.length > 10 ? ` and ${held.length - 10} more` : '');
      this.log.warn(`not reaping ${held.length} session(s) whose runner looks offline (${named}): ${await hold}`);
    }
  }

  /**
   * Why a runner's silence is not evidence that it died, this sweep — or null when it is.
   *
   * "Offline" is read off the ABSENCE of a beat in `runner_presence`, so it says something about the
   * runner only while this control plane could have heard one. The database rule in `sweep`
   * (`databaseRefusedWorkLastSweep`) is one case of that; these are the rest (docs/runner-link-design.md
   * §6.5), and each holds the offline reaping whole:
   *
   *  - The reaper started less than STARTUP_GRACE_MS ago. The presence table is UNLOGGED, so a crash
   *    or a failover of the primary empties it, and a process that has just come up — after a deploy,
   *    or beside a database that just came back — has not yet had the time to hear every live runner.
   *  - A heartbeat write failed in this process within OFFLINE_AFTER_MS: the beat that would have
   *    answered may be one the database refused, here.
   *  - A fifth of the cell's runners crossed the offline line together (MASS_SILENCE_SHARE,
   *    MASS_SILENCE_WINDOW_MS). Read again every sweep that needs it, and held for OFFLINE_AFTER_MS
   *    past the last sweep that saw it, so the runners whose beats were lost get a whole window to be
   *    heard again before their silence counts.
   *
   * None of them is a latch. The grace ends; a failed write ages out; a silence that does not lift
   * leaves the count MASS_SILENCE_WINDOW_MS past the line, and its sessions are then reaped like any
   * others. Nothing else here waits on it: a cancel or an end the runner never honored is still
   * finalized, since that verdict is not read from silence.
   */
  private async silenceHold(now: number): Promise<string | null> {
    const s = (ms: number) => `${Math.round(ms / 1000)}s`;
    if (this.startedAt !== null && now - this.startedAt < STARTUP_GRACE_MS) {
      return `the reaper started ${s(now - this.startedAt)} ago, inside its ${s(STARTUP_GRACE_MS)} startup grace`;
    }
    if (!this.presence) return null;
    const lostAt = this.presence.lastBeatNotRecordedAt();
    if (lostAt !== null && now - lostAt <= OFFLINE_AFTER_MS) {
      return `a heartbeat write failed ${s(now - lostAt)} ago, inside the ${s(OFFLINE_AFTER_MS)} runner silence is read from`;
    }
    const fleet = await this.presence.fleetSilence(MASS_SILENCE_WINDOW_MS);
    if (fleet.heard > 0 && fleet.silent / fleet.heard >= MASS_SILENCE_SHARE) {
      this.massSilenceHeldUntil = now + OFFLINE_AFTER_MS;
      return `${fleet.silent} of the ${fleet.heard} runners heard from in the last `
        + `${s(OFFLINE_AFTER_MS + MASS_SILENCE_WINDOW_MS)} have been silent for over ${s(OFFLINE_AFTER_MS)} at once`;
    }
    if (now < this.massSilenceHeldUntil) {
      return `a fifth of the cell's runners went silent together less than ${s(OFFLINE_AFTER_MS)} ago`;
    }
    return null;
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
      /** Re-ask `runnerLooksOffline` inside this transaction before writing. Only the offline
       *  branch sets it: it is the one decision here made about a row OTHER than the session's,
       *  read from a snapshot this write can be a whole sweep younger than. */
      requireRunnerStillOffline?: boolean;
      /** Hand this session to AutoRetryService instead of leaving it for the user to
       *  re-send by hand. Only for a finalize that says nothing about the work itself. */
      armRetry?: boolean;
      /**
       * How this attempt ended, for the project's exception item (contract §4.3 D). Present on every
       * branch that ends a run badly — including the two that put the task back in the pool rather
       * than writing FAILED, because an attempt that was lost is still an attempt that failed and
       * the task going quiet is exactly what nobody hears about. Absent for a cancel somebody asked
       * for: that ending says nothing about the work.
       */
      taskFailure?: TaskFailureHow;
    } = {},
  ): Promise<void> {
    const status = opts.status ?? RunStatus.FAILED;
    const failed = status === RunStatus.FAILED;
    // Due immediately (see below), and carried on the published STATUS so that event says the
    // same thing the row does: this end is one the server means to undo, not a settlement.
    const retryAt = opts.armRetry ? new Date() : null;
    const resetTaskTo = opts.resetTaskTo ?? TaskStatus.OPEN;
    // Retried whole. The reaper re-reads the session under its row lock and decides from that read,
    // so a re-run either finds the same stalled run or finds that somebody finished it first.
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      // Before anything is written: is the thing this decision was made ABOUT still true? The
      // sweep's verdict came from one snapshot read at the top of a loop that awaits a transaction
      // per session, so under the database stress that produces "no heartbeat for 90s" in the
      // first place, this write can be minutes younger than the read that authorised it — and a
      // runner that came back inside that gap was killed by a fact that had expired. The row lock
      // this takes is the session's, not the runner's: a heartbeat committing between this read
      // and the update below still wins the old way, but that window is a statement rather than a
      // sweep, and locking runners against their own heartbeats would be the more expensive bug.
      if (opts.requireRunnerStillOffline) {
        const runner = runnerId
          ? await tx.runner.findUnique({
              where: { id: runnerId },
              select: { status: true, ...RUNNER_BEATS },
            })
          : null;
        if (!runnerLooksOffline(runner, Date.now())) {
          return { ok: false, taskReclaimed: false, currentWorkTerminalized: 0, recanted: true };
        }
      }
      const res = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: { in: opts.expectedStatuses ?? LIVE },
          ...(opts.onlyIfNotCancelling ? { cancelRequestedAt: null } : {}),
          // The claim half of the re-ask above, on the row this writes: a run claimed inside the
          // window — since the sweep looked, too — is a runner answering.
          ...(opts.requireRunnerStillOffline ? claimedLongAgo(Date.now()) : {}),
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
          // Every status this writes is terminal, so the run this reaps stops being live here and
          // what it had running goes with it (CLEARED_RUNNING_WORK). A runner that is merely
          // unreachable — the partition this sweep's own comment describes — drains its jobs when
          // it comes back and finds the session closed, and that report is refused for exactly the
          // reason this row is: not OPEN any more.
          ...CLEARED_RUNNING_WORK,
        },
      });
      if (res.count === 0) return { ok: false, taskReclaimed: false, currentWorkTerminalized: 0 };
      await retireSessionInboxGeneration(tx, sessionId);
      const currentWork = await terminalizePendingCurrentWorkSteers(tx, sessionId, {
        includeInFlight: true,
        inFlightOutcome: 'UNCONFIRMED',
        code: CURRENT_WORK_SESSION_REAPED,
        reason:
          `Delivery could not be confirmed because the runner disappeared before acknowledgement; `
          + `the session was reaped as ${status}.`,
      });
      const currentWorkTerminalized = currentWork.terminalizedTurnIds.length;
      // A Watch wake still queued goes with the drain below, unrun: its delivery stops reading
      // DELIVERED first (watches/watch-wake-drain.ts).
      await deadLetterQueuedWatchWakes(tx, sessionId, {
        code: 'OBSERVER_SESSION_ENDED',
        ending: `reaped as ${status}: ${reason}`,
      });
      // And an exception item queued for this conversation (projects/project-open-item.ts).
      await returnQueuedTurns(tx, sessionId, { code: 'SESSION_ENDED', ending: true });
      // And what rides on session requests: the status write above has already closed what the end
      // closes, so what is left is a run with a retry armed (sessions/session-request.ts) — the turn
      // still in flight included, since the drain below answers it without its engine finishing it.
      await settleUnrunSessionRequests(tx, sessionId, {
        code: 'SESSION_ENDED',
        closesRequests: true,
        retryArmed: retryAt != null,
      });
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      // Reclaim a now-stalled IN_PROGRESS task so it stops showing as running.
      const taskReclaimed = taskId && status !== RunStatus.SUCCEEDED
        ? await reclaimStalledTask(
            tx,
            taskId,
            resetTaskTo,
            opts.taskFailure
              ? { sessionId, how: opts.taskFailure, error: opts.failureDetail ?? reason }
              : undefined,
          )
        : false;
      // For a genuine failure, record it on the task timeline (independent of whether
      // the task was IN_PROGRESS, so a run that never reached IN_PROGRESS is covered).
      if (taskId && failed && resetTaskTo === TaskStatus.FAILED) {
        await postRunFailureComment(tx, taskId, opts.failureDetail ?? reason);
      }
      return { ok: true, taskReclaimed, currentWorkTerminalized };
    }, loggedRetry(this.log, 'reaper.forceFinalize'));
    if (!outcome.ok) {
      if ('recanted' in outcome) {
        this.log.log(`not reaping ${sessionId}: its runner answered again before the write landed`);
      }
      return;
    }
    // The session summary refreshes the task's own running/queued overlay. A reclaimed status also
    // changes prerequisite dependents, whose complete reverse fan-out is not known here; the
    // compatibility helper deliberately emits an explicit resync for that rare abnormal path.
    if (outcome.taskReclaimed && taskId) {
      this.realtime.publishTaskChanged(sessionId, taskId);
      // And the exception item this sweep opened goes to whoever is responsible for it (§4.4 X-D4 1).
      await this.openItems?.deliverForTasks([taskId]);
    }
    if (outcome.currentWorkTerminalized > 0) {
      this.realtime.publishQueuedTurnsChanged(sessionId);
    }
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
    // Retried whole, for the same reason as forceFinalize above.
    const done = await withTransactionRetry(this.prisma, async (tx) => {
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
    }, loggedRetry(this.log, 'reaper.endParked'));
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
