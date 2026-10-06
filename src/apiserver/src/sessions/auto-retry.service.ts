import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, ProjectStatus, RunStatus } from '@prisma/client';
import {
  RunEventType,
  isAuthErrorText,
  isRetryableApiErrorText,
  isUsageLimitErrorText,
  planUsageBlockedUntil,
  withEnginePlanUsage,
  type PlanUsage,
  type SessionMessageCard,
} from '@orbit/shared';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { postgresSqlState, taskRetirement } from '../tasks/task-supersession';
import {
  TaskCompletionPolicyValue,
  taskStartOwnedByCompletion,
} from '../projects/task-aggregation';
import { RealtimeService } from '../realtime/realtime.service';
import { deriveSessionCapabilities } from './session-state';
import { SessionsService, type SessionResumeAnswer } from './sessions.service';
import { isBackgroundWakeTurn } from '../runner-api/background-job-wake';
import { readSessionMessageCard } from './session-message';
import {
  attachHeldReplies,
  hasHeldSessionReplies,
  isSessionReplyTurn,
  moveSessionRequestToTurn,
  NothingHeldToResend,
  readTurnRequestIds,
  retryRecords,
  RETRY_CLAIM_WINDOW_MS,
  SESSION_REPLY_TURN_PREFIX,
} from './session-request';
import { AUTO_RETRY_TURN_KEY_PREFIX } from './watch-turn-key';
import {
  confirmationReviewRetryTurnId,
  isConfirmationReviewContentTurn,
} from '../tasks/owner-confirmation-review-turn';
import { runAccount } from '../providers/plan-usage-accounts';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import {
  classifyTransactionError,
  loggedRetry,
  withTransactionRetry,
} from '../common/transaction-retry';

const SWEEP_INTERVAL_MS = 30_000;
// How long a session armed by the reaper waits for its runner to come back. Covers the
// ordinary reasons a runner drops mid-turn — a restart, a self-update's drain, a deploy, a
// brief partition — all of which resolve in low single-digit minutes. Past this the machine
// is not coming back on its own, and a session silently waiting on it forever is worse than
// one that says so: it disarms and the transcript's own note becomes the honest state again.
const MAX_OFFLINE_WAIT_MS = 30 * 60_000;
// How long to wait after each *dispatch* failure — the resume itself not going through, which
// is about this deployment (runner gone, session raced elsewhere) rather than about the
// provider. The provider-side waits are decided when the retry is armed: a quota's own reset
// time, or API_ERROR_RETRY_BACKOFF_MS. Past the last step here the session is handed back.
//
// It is also how long a retry is ARMED for after a failure that has no provider-side moment of its
// own — see `nextAutoRetryAt` — which is why it is exported: a class armed on a schedule of its own
// would be a second opinion about how many tries there are.
export const BACKOFF_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);
// One session per (runner, provider) per sweep. Both failures this retries are shared facts —
// one account's quota, one provider's outage — so releasing a whole fleet at the first moment
// it might be over is how you spend the quota again, or reproduce the overload.
const PER_QUOTA_PER_SWEEP = 1;

/**
 * When the next re-send of a failure goes out, or null once the ladder is spent.
 *
 * Exported because ARMING decides it too, and there is one ladder: the wait a retry is armed with
 * and the count this sweep gives up after are the same list, so a fourth failure class cannot be
 * armed on a schedule this sweep would only disarm on its next tick. `runner-api.controller` uses
 * it for a turn that produced nothing at all (`retryArmAt` there) — a failure whose whole fix is
 * re-sending the message, which is exactly what the sweep below does.
 *
 * Null is a decision, not a missing value: past the last step the session is left saying what
 * failed rather than handed another countdown.
 */
export function nextAutoRetryAt(attempts: number, now: Date): Date | null {
  const step = BACKOFF_MS[attempts];
  return step == null ? null : new Date(now.getTime() + step);
}
// Nothing here is worth waking a scheduler for at a fixed cost forever: read a bounded page,
// and let a backlog drain over consecutive sweeps.
const MAX_PER_SWEEP = 50;

/** What a retry re-sends (`AutoRetryService.messageToResend`). */
interface ResendMessage {
  content: string;
  attachmentsOf: string | null;
  senderSessionId: string | null;
  turnId: string | null;
  sessionReplies?: true;
  /** The key of a failed confirmation-review or return turn, which is re-sent as itself. */
  confirmationReviewTurn?: string;
}

/**
 * The namespace the failure card's Retry writes in, and the FAILED message its key names (§2.1).
 * Spelled apart from the sweep's own `auto-retry:` keys so a turn under it can be read back as the
 * press that wrote it, and for the message it re-sent (`resendRetryMessage`'s `pressAlreadyOut`).
 */
const MANUAL_RETRY_TURN_KEY_PREFIX = `${AUTO_RETRY_TURN_KEY_PREFIX}retry-message:`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §2.1, §8 criterion 19: the key the failure card's Retry writes its turn under, DERIVED from the
 * FAILED message rather than minted by the caller for every click. Two clicks on one failure — a
 * double tap, or a response lost and pressed again — are one turn: the second call replays the key
 * the first committed, and `resume` answers the turn it already queued (with the copies of the files
 * that went out with it); a fresh key per click instead queued a second, signed, uncharged copy of
 * the same message. A message that fails again IS a new failed message, so the next click derives a
 * key of its own and really does go out again.
 *
 * A message whose words never became a turn row — a pre-attribution echo, the seeded opening prompt —
 * is keyed by the words themselves: the same text typed twice and failing twice then collapses onto
 * one turn, which is the safe direction for a door whose whole promise is "once".
 */
export function manualRetryTurnKey(message: { turnId: string | null; content: string }): string {
  const source = message.turnId
    ?? createHash('sha256').update(message.content).digest('hex').slice(0, 32);
  return `${MANUAL_RETRY_TURN_KEY_PREFIX}${source}`;
}

/** The refusal of a Retry pressed when the session is not stopped on a failure (§8 criterion 22). */
const NOTHING_FAILED =
  'this session is not stopped on a failure: there is nothing for Retry to re-send';

/**
 * The re-send a sweep claimed is no longer its to write (§8 criteria 24 and 25): the claim was taken
 * back — the owner turned the retry off, armed it for a later instant, or sent a message of their own —
 * or it outlived its lease and was given up (`RETRY_CLAIM_WINDOW_MS`). Thrown inside the transaction
 * that would have written the turn, so nothing of it lands.
 */
export class RetryClaimLost extends Error {}

/** A reply of the workspace's own, as text: a sub-agent's report (`parentToolUseId`) is nobody's reply. */
function workspaceReplyText(row: { payload: unknown }): string {
  const payload = (row.payload ?? {}) as { text?: unknown; parentToolUseId?: unknown };
  if (payload.parentToolUseId) return '';
  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

/**
 * The list pause, asked where a retry is RELEASED rather than where it was armed.
 *
 * `task.dispatch_hold` is a paused list projected onto the task row, and every other automatic
 * starter in the deployment reads it: all four candidate scans (tasks.service.ts
 * AUTO_RUN_READY_SQL, PROJECT_INDEPENDENT_READY_SQL, AUTO_RUN_RETRY_CANDIDATE_SQL,
 * SCHEDULED_DUE_SQL) and the manual Run door. This sweep did not, and the result was one pause
 * with two answers: a task that opts into auto-run has the reaper stand aside for the scheduler
 * (`armRetry` in reaper.service.ts) and the scan that would re-select it asks the column, so the
 * pause held; a task that does not opt in is retried HERE, and the pause did not. Nothing about
 * that difference is a policy — it is which mechanism happens to own the retry.
 *
 * Stated positively and read off the task's own column, which is the shape AUTO_RUN_READY_SQL's
 * comment insists on after deleting 112 paused-able lists released 55,513 tasks: a veto that
 * cannot be expressed reads as permission.
 *
 * Only the TASK'S WORK is held. A salvage conversation (`starts_task_work = false`) is somebody
 * asking about a run that already happened, and re-sending the words a quota killed answers that
 * person — pausing a campaign is not an instruction to stop answering them. It is the same line
 * §13.1 AG6 draws between a session doing a task's work and one held about it.
 *
 * Applied at the due read and again in the claim, and deliberately NOWHERE ELSE — not at either
 * place a retry is armed (the reaper's offline branch, ingestion's quota branch). A person pauses
 * a list when things are already going wrong, so at the moment those two arm, the hold usually
 * does not exist yet: a check there is a veto asked before the fact it is about, and an arm that
 * was never written cannot be reconsidered when the pause lifts. Asked here it is asked against
 * the world at the instant of the resume, once, for every arming path there is.
 */
const NOT_DISPATCH_HELD: Prisma.SessionWhereInput = {
  OR: [
    { taskId: null },
    { startsTaskWork: false },
    { task: { dispatchHold: false } },
  ],
};

/**
 * The other standing veto on starting a task's work: its project was cancelled
 * (projectNotCancelledSql, which every automatic door applies). Asked where the hold is asked and
 * for the same reason — against the world at the instant of the resume, so a project cancelled
 * after the retry was armed is honoured, and one reopened before it comes due is not held.
 */
const NOT_IN_CANCELLED_PROJECT: Prisma.SessionWhereInput = {
  OR: [
    { taskId: null },
    { startsTaskWork: false },
    { task: { projectId: null } },
    { task: { project: { status: { not: ProjectStatus.CANCELLED } } } },
  ],
};

/**
 * Re-sends messages that a self-healing failure killed, once it is likely to work.
 *
 * Four failures qualify. Two arrive as the entire reply: the account's provider quota running
 * out, and the provider being briefly unable to answer ("API Error: 529 … overloaded_error"). The
 * third arrives as no reply at all — the runner went away mid-turn and the reaper finalized the
 * session as 'runner offline'. The fourth is the engine that never came up: the turn produced
 * nothing at all, no runtime turn ran and nothing was billed for one, and /turn-complete arms it
 * (runner-api.controller's `retryArmAt`) for the ladder below. None of the four says anything
 * about the work, and all four succeed on the same message being sent again.
 *
 * `Session.retryAt` is armed on event ingestion (runner-api.controller) for the first two, by the
 * reaper for the third, and by /turn-complete for the fourth. This service is the other half: it
 * waits for that moment, confirms the thing that failed is actually available again — the
 * provider's quota, or the runner itself — and re-sends. It exists as its own sweeper rather than
 * as another branch of the reaper because the reaper's job is ending things that are stuck — this
 * one starts things that are merely waiting, and must not inherit "finalize it" as a fallback
 * behaviour.
 *
 * Single-replica, like the reaper: two of these would double-send. The armed row is claimed
 * with a conditional update before the resume, so a concurrent user message or a second
 * sweep loses the race rather than producing a second turn.
 */
/**
 * What one §13.1 AG6 settle concluded.
 *
 * Three answers, not a row count, because the caller has to do three different things. `SETTLED`
 * wrote — the retry is over. `RELEASED` means the world moved (the shape lifted, the row changed
 * hands, the claim is not the one this sweep observed) and the session is an ordinary due row
 * again. `BUSY` means nothing was judged at all: somebody else holds a lock, so the sweep must
 * leave the arm exactly as it found it rather than treat "could not look" as "nothing there".
 */
type AggregateSettleOutcome = 'SETTLED' | 'RELEASED' | 'BUSY';

@Injectable()
export class AutoRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AutoRetry');
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeService,
    /**
     * An account pool's quota (QueueService.accountPoolResumesAt): a pool's slug is in no runner's
     * snapshot. `@Optional()` for the specs that build this service directly; QueueModule is global, so
     * Nest always has one.
     */
    @Optional() private readonly queue?: QueueService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      // A claim whose re-send was never written — the process stopped between the two, or the
      // backoff after a failed resume could not be written — is given up once its lease has run out,
      // so that what was held for its turn is said by where the session stands then (§8 criterion
      // 24). First, and on its own: a failure there must not cost the due rows their pass.
      this.releaseExpiredClaims()
        .catch((e) => this.log.error('expired retry claims were not given up: ' + (e as Error).message))
        .then(() => this.sweep())
        .catch((e) => this.log.error('sweep failed: ' + (e as Error).message));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    // Parked waiting for someone to say something, and that someone is us. That state has two
    // spellings. AWAITING_INPUT is the session that simply idled, which is where a quota-killed
    // turn stops; FAILED is what a turn killed by a provider error settles as — turn-complete
    // fails the run so the list shows the failure instead of a silent idle row, and sets
    // cancelRequestedAt to reclaim the runner slot the still-running process holds. Both of
    // those are set by the same event a retry is armed for, so matching only the first matched
    // none of the sessions this service exists for — and requiring `cancelRequestedAt: null` of
    // a FAILED row excludes every one of them by construction. A FAILED session stays resumable
    // (resume() revives it and clears the cancel), so the honest condition is "still in the
    // state it was armed in", not "not failed". Anything live is already working, and anything
    // trashed, completed or mid-cancel has an owner who moved on.
    const due = await this.prisma.session.findMany({
      where: {
        retryAt: { lte: now },
        deletedAt: null,
        completedAt: null,
        OR: [
          { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
          { status: RunStatus.FAILED },
        ],
        // A held task's work is not a candidate at all (see NOT_DISPATCH_HELD). Filtered here
        // rather than skipped in the loop, and that is not only tidiness: a row skipped in the
        // loop keeps the retry_at it was armed with, which is among the OLDEST in the system, so
        // it would hold its place at the front of this bounded page on every sweep for as long as
        // the pause lasted — the pause would starve the retries that CAN run. Left out of the
        // page, its arm simply waits, and the sweep after the pause lifts finds it due.
        AND: [NOT_DISPATCH_HELD, NOT_IN_CANCELLED_PROJECT],
      },
      orderBy: { retryAt: 'asc' },
      take: MAX_PER_SWEEP,
      select: {
        id: true,
        ownerId: true,
        provider: true,
        prompt: true,
        numTurns: true,
        retryAttempts: true,
        // The instant this sweep saw armed. It goes into the settle's compare-and-set: a cancel
        // followed by a re-arm to a NEW time is a different retry, and clearing it on the strength
        // of the old reading would delete a countdown somebody just set. G3 owns the full durable
        // generation; this is the narrow version that keeps THIS path from adding the same bug.
        retryAt: true,
        assignedRunnerId: true,
        status: true,
        // §13.6 SU6's two columns, so the sweep can answer "is this task's work still this task's
        // to do" itself instead of finding out from a trigger that refuses the write.
        taskId: true,
        // §13.1 AG6 applies to a retry of the task's WORK and to nothing else. A salvage or
        // conversation session that happens to hang off a roll-up node is a legitimate run and
        // keeps the ordinary retry semantics.
        startsTaskWork: true,
        task: {
          select: {
            terminalReason: true,
            supersededByTaskId: true,
            // §13.6 SU6's derived half: a retry of a check whose subject was replaced would resume
            // a run that can never conclude about anything.
            verifies: { select: { terminalReason: true, supersededByTaskId: true } },
          },
        },
        // When the reaper gave up on this session — the clock MAX_OFFLINE_WAIT_MS runs on.
        finishedAt: true,
        // The rest of what deriveSessionCapabilities reads, so the runner-liveness question
        // is answered by the same function that gates resume() rather than by a fourth
        // hand-rolled heartbeat comparison that can drift from it.
        endReason: true,
        completedAt: true,
        deletedAt: true,
        cancelRequestedAt: true,
        startedAt: true,
        runtimeSessionId: true,
        assignedRunner: {
          select: { planUsage: true, engines: true, status: true, lastHeartbeatAt: true },
        },
        // Which of the runner's Codex, Claude or Antigravity accounts the run spends, whose quota alone
        // can hold it back: the one picked for the session, else its workspace's.
        codexAccount: true,
        claudeAccount: true,
        antigravityAccount: true,
        workspace: { select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true } },
      },
    });
    if (due.length === 0) return;

    // §13.1 AG6's first clause, for this whole batch, in ONE query and in the canonical spelling.
    //
    // Not a Prisma `children: { take: 1 }` include: a parent's children are the tasks that share
    // its OWNER (that is the scope `collectAggregationScope` walks), and `take: 1` cannot express
    // that — it would return whatever row came first, so a cross-owner child written by raw SQL
    // would read as "this is an aggregate parent" and permanently disarm a retry that is perfectly
    // legal. Filtering after `take: 1` is the same bug with an extra step. The correlated EXISTS
    // below is the same predicate the guard, the pass and the commit gate all use.
    const workTaskIds = [...new Set(due
      .filter((session) => session.startsTaskWork && session.taskId)
      .map((session) => session.taskId!))];
    const aggregateParents = new Set(workTaskIds.length === 0 ? [] : (
      await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT t."id" FROM "task" t
         WHERE t."id" IN (${Prisma.join(workTaskIds.map((id) => Prisma.sql`${id}::uuid`))})
           AND t."completion_policy"::text <> 'MANUAL'
           AND EXISTS (SELECT 1 FROM "task" c
                        WHERE c."parent_task_id" = t."id" AND c."owner_id" = t."owner_id")
      `)
    ).map((row) => row.id));

    const released = new Map<string, number>();
    for (const session of due) {
      // Read once: the row is written below, and the failure path must count from what this
      // sweep started with, not from what it has since stored.
      const attempts = session.retryAttempts;
      // This sweep's claim on the row, once it has one: every write after the claim is a
      // compare-and-set on it, so none of them lands on a retry somebody has since taken back.
      let claimedAt: Date | null = null;
      try {
        // §13.6 SU6 FIRST, ahead of every resource question below.
        //
        // Those are all deferrals — the runner is rebooting, the quota resets at four, the provider
        // is down — and each of them re-arms and waits. This is not a deferral: the task's work is
        // being done by the attempt that replaced it, and no amount of waiting changes that. Asked
        // after the offline branch (where it was first written) a retired session on a runner that
        // stays down would show "Retrying" and renew itself for the whole offline grace period,
        // which is a promise the sweep cannot keep. An unrecoverable fact outranks a temporary one.
        //
        // DISARMED rather than skipped: leaving `retry_at` set means selecting this row on every
        // sweep forever, either silently or by being refused at the write and logging each time.
        // No attempt is spent — `retryAttempts` is the budget for failures of the RUN, and this
        // retry never happened.
        const retirement = session.task
          ? (taskRetirement(session.task)
            ?? (session.task.verifies ? taskRetirement(session.task.verifies) : null))
          : null;
        if (retirement) {
          await this.disarm(session.id, session.status,
            `task was ${retirement.toLowerCase()}; the attempt that replaced it holds this work`);
          continue;
        }
        // §13.1 AG6, in the same position and disarmed for the same reason: this is not a deferral.
        // The task's completion belongs to its subtasks now, so `resume` will refuse this run on
        // every sweep from here to the end of time. Re-arming would spend the whole retry budget on
        // a refusal that cannot lift, and each spent attempt is one the RUN never got.
        //
        // The failed Session keeps its real FAILED status and its error — this only stops the
        // retry, and AG6-d's recomputation is what moves the TASK on.
        if (session.taskId && aggregateParents.has(session.taskId)) {
          const outcome = session.retryAt == null ? 'RELEASED' as const
            : await this.disarmIfStillAggregateParent(
                session.id, session.status, session.taskId, attempts, session.retryAt,
              );
          if (outcome === 'SETTLED') {
            this.log.warn(`auto-retry of ${session.id} disarmed: task is completed by `
              + 'aggregating its subtasks, so it has no work of its own to retry');
            this.announceSettled(session.id, session.status);
            continue;
          }
          // ANY other answer leaves this row exactly as it was found and waits for the next sweep
          // (at most one interval away). Falling through to claim it would be reading "I could not
          // judge this" and "the world moved" as "go ahead", and the claim below only asserts
          // `retry_at IS NOT NULL` — so a cancel followed by a re-arm to a FUTURE instant would be
          // stolen by this pass on the strength of a decision made about the retry it replaced.
          continue;
        }

        // What this sweep read, for every write below that has NOT claimed the row: a deferral
        // must not overwrite a cancel-and-re-arm, a rebind or a demotion that landed in between.
        const observed = {
          taskId: session.taskId ?? null,
          startsTaskWork: session.startsTaskWork,
          retryAt: session.retryAt,
          retryAttempts: attempts,
        };
        const quotaKey = `${session.assignedRunnerId ?? 'none'}:${session.provider}`;
        if ((released.get(quotaKey) ?? 0) >= PER_QUOTA_PER_SWEEP) continue;

        // Is the runner back? Asked before the quota, because a resume into an absent runner
        // cannot succeed for any provider reason — resume() itself refuses one (RUNNER_OFFLINE)
        // and that refusal would land in the catch below and spend an attempt on a session
        // whose only problem is that a machine is still rebooting. A deferral, not a failure:
        // re-armed for the next sweep with the attempt count untouched, which is what turns
        // this into "waiting for the runner" instead of five backoffs and a give-up.
        const capabilities = deriveSessionCapabilities(session, now.getTime());
        if (capabilities.resumeBlockedReason === 'RUNNER_OFFLINE') {
          const waited = session.finishedAt ? now.getTime() - session.finishedAt.getTime() : 0;
          if (waited > MAX_OFFLINE_WAIT_MS) {
            await this.disarm(session.id, session.status, 'runner never came back');
          } else {
            await this.rearm(
              session.id,
              session.status,
              new Date(now.getTime() + SWEEP_INTERVAL_MS),
              attempts,
              observed,
            );
          }
          continue;
        }


        // The authoritative answer to "is the account able to run at all", checked as late as
        // possible: for a quota retry the reset time it was armed with came from the runtime's
        // own prose, and the snapshot has had until now to catch up. For a provider-error retry
        // this is a free extra guard — re-sending into a quota known to be spent would waste
        // the attempt. Still blocked → re-arm for the time it now reports and spend no attempt;
        // this is a deferral, not a failure.
        // An account pool is its members' quota, not the runner's (QueueService.accountPoolResumesAt):
        // room on any of them re-sends now, and every one spent waits for the first to reset.
        const poolResumesAt = await this.queue?.accountPoolResumesAt(
          session.ownerId,
          session.provider,
          now,
        );
        const blockedUntil = poolResumesAt
          ? (poolResumesAt > now ? poolResumesAt : null)
          : planUsageBlockedUntil(
              withEnginePlanUsage(
                session.assignedRunner?.planUsage as PlanUsage | null,
                sanitizeRunnerEngines(session.assignedRunner?.engines),
              ),
              session.provider,
              now,
              runAccount(
                session.provider,
                session.workspace?.env,
                {
                  codexAccount: session.codexAccount ?? session.workspace?.codexAccount,
                  claudeAccount: session.claudeAccount ?? session.workspace?.claudeAccount,
                  antigravityAccount: session.antigravityAccount ?? session.workspace?.antigravityAccount,
                },
                session.assignedRunner?.engines,
              ),
            );
        if (blockedUntil) {
          await this.rearm(session.id, session.status, blockedUntil, attempts, observed);
          continue;
        }

        if (attempts >= BACKOFF_MS.length) {
          await this.disarm(session.id, session.status, `gave up after ${attempts} attempts`);
          continue;
        }

        const message = await this.messageToResend(session.id, session.prompt, session.numTurns);
        const { content, attachmentsOf } = message;
        // A failed turn that handed back the outcomes of this session's own requests is re-sent as
        // what it was: a reply turn, nobody's words, the outcomes its failure held for this session
        // taken onto it as it is written (sessions/session-request.ts). Only while some are held —
        // with none, it would wake the session to say nothing.
        const resendsReplies = !!message.sessionReplies && await hasHeldSessionReplies(this.prisma, session.id);
        // A failed confirmation review or return turn is re-sent as itself, its block rendered again
        // from the rows (tasks/owner-confirmation-review-turn.ts) — nobody's words either.
        const resendsReview = message.confirmationReviewTurn
          ? confirmationReviewRetryTurnId(message.confirmationReviewTurn, randomUUID())
          : null;
        if (!content && !resendsReplies && !resendsReview) {
          // Nothing to re-send (no user message, no opening prompt to fall back on). Sending
          // an invented "continue" would be us writing in the user's voice.
          await this.disarm(session.id, session.status, 'nothing to re-send');
          continue;
        }

        // Claim before acting: whoever clears retryAt first owns this retry. resume() clears it
        // again on success, which is harmless — this update is what makes a user message that
        // lands mid-sweep win instead of producing a second turn. The attempt is spent here and
        // NOT refunded on success: only a reply that is no longer one of these failures resets
        // the count (runner-api.controller retryPlanFor), which is what bounds a provider
        // failing the retry exactly as it failed the original.
        // The claim carries §13.6 SU6 as well as the retry's own condition: a supersession that
        // commits between the check above and this write makes it match zero rows, which is
        // already the "somebody else owns this retry" path — no new branch, and no revive of
        // replaced work. `retry_at` is cleared by that same statement only when it wins, so a
        // loser leaves the row for the next sweep, which disarms it above.
        // A row whose arm has already gone is not this sweep's to claim. `due` selects on
        // `retry_at <= now`, so in production this is only reachable when the claim was lost
        // between that read and here — and claiming on a null would match exactly the row somebody
        // else just took.
        if (session.retryAt == null) continue;
        // The claim's own instant, not the sweep's `now`: a sweep releases its rows one after another,
        // each behind the resume before it, and a claim stamped with the moment the sweep began could
        // be past its lease by the time it is written (RETRY_CLAIM_WINDOW_MS).
        const claim = new Date();
        claimedAt = claim;
        const claimed = await this.prisma.session.updateMany({
          where: {
            id: session.id,
            // The EXACT instant this sweep saw, not merely "some arm". A cancel and a re-arm to
            // a new time is a different retry, and claiming it here would spend an attempt on a
            // countdown somebody had just replaced. (G3's durable generation supersedes this; it is
            // the narrow version that keeps this path honest in the meantime.)
            retryAt: session.retryAt,
            // ...and the rest of the row this sweep decided about. A claim that asserted only the
            // instant could still land on a session that had been re-pointed at another task,
            // demoted to a salvage conversation, or moved to a different parked status in between.
            status: session.status,
            retryAttempts: attempts,
            taskId: session.taskId ?? null,
            startsTaskWork: session.startsTaskWork,
            OR: [
              { taskId: null },
              { task: { terminalReason: null, supersededByTaskId: null } },
            ],
            // ...and the pause, carried here for the same reason SU6 is: a list paused between
            // the due read above and this write must not have its campaign resumed on the
            // strength of a reading taken before it. Zero rows is already the "somebody else owns
            // this retry" path — the arm is left standing, no attempt is spent, and the sweep
            // after the pause lifts decides.
            AND: [NOT_DISPATCH_HELD, NOT_IN_CANCELLED_PROJECT],
          },
          // `retry_claimed_at` is what tells the claim apart from a retry given up while the resume
          // below is in flight: both leave the session parked with `retry_at` NULL, and a reader of
          // the second as the first writes the asker a comment saying its request will never be
          // answered, then says the outcome again on the retry's turn (migration 0354, §8 criterion
          // 20). Cleared by the turn the resume writes, and by every path below that re-arms,
          // disarms or hands the attempt back.
          data: { retryAt: null, retryAttempts: attempts + 1, retryClaimedAt: claim },
        });
        if (claimed.count === 0) continue;
        released.set(quotaKey, (released.get(quotaKey) ?? 0) + 1);

        // Everything the user sent WITH those words. Copied here rather than when the message was
        // chosen, so a sweep that loses the claim above leaves no orphan blobs behind, and inside
        // the try so a failed copy takes the ordinary backoff instead of escaping the sweep.
        const attachmentIds: string[] = [];
        try {
          if (attachmentsOf) {
            attachmentIds.push(...(await this.copyAttachments(session.id, attachmentsOf)));
          }
          await this.sessions.resume(
            session.ownerId,
            session.id,
            {
              content,
              attachmentIds,
              // The platform's own key space (watch-turn-key.ts): a turn under it is always the
              // platform's re-send, never a message anybody sent again. A reply turn's re-send is one
              // again, so its outcomes are found, merged and drawn as what they are.
              clientTurnId: resendsReplies
                ? `${SESSION_REPLY_TURN_PREFIX}retry:${randomUUID()}`
                : resendsReview ?? `${AUTO_RETRY_TURN_KEY_PREFIX}${randomUUID()}`,
            },
            {
              ...this.resendCarrying(session.id, message, resendsReplies),
              // Written only under the claim it was claimed for (§8 criteria 24 and 25).
              participateSendTransaction: this.whileClaimHeld(session.id, claim),
            },
          );
        } catch (error) {
          // Nothing was re-sent, so the copies made for it are not history — just bytes. Dropped
          // before anything else in this catch, which has paths that rethrow and paths that end
          // the retry, and would leak a copy of every image on each of them otherwise.
          await this.discardCopies(attachmentIds);
          // The claim was taken back before the re-send could be written: the owner turned the
          // retry off or re-armed it, a message of their own took its place, or the claim outlived
          // its lease and was given up. Whoever took it has already said what becomes of this retry,
          // so there is nothing to re-arm and no attempt to hand back — and doing either would
          // overwrite that answer (the owner's "off" re-armed behind their back, an outcome said again).
          if (error instanceof RetryClaimLost) {
            this.log.log(`session ${session.id} retry not re-sent: ${error.message}`);
            continue;
          }
          // The reply turn this was re-sending would have said nothing: since the look before the
          // claim, another turn of the session took the outcomes it held. That turn said them, so
          // there is nothing left to retry — and the attempt the claim spent goes back, which is what
          // says the retry is over rather than under way (`giveUpClaim`).
          if (error instanceof NothingHeldToResend) {
            await this.giveUpClaim(session.id, session.status, attempts, claim, 'its outcomes were said on another turn');
            continue;
          }
          // §13.6 SU6, at the only point left where it can still surprise this sweep: the claim
          // above and the resume below are two transactions, so a supersession can commit between
          // them. The resume is then refused — correctly — but the ordinary catch would treat it as
          // a transient failure, re-arm for two minutes and keep the attempt it spent. Both are
          // wrong: nothing was retried, and nothing will be. The retry ends here instead.
          //
          // Re-read rather than pattern-matched on the message, so this cannot be fooled by a
          // refusal that merely mentions the word, and refunded with a compare-and-set that names
          // the attempt count this sweep wrote — a concurrent writer that moved it on wins, and
          // this refunds nothing rather than overwriting somebody else's number.
          const [current] = await this.prisma.$queryRaw<Array<{
            terminalReason: string | null; supersededByTaskId: string | null;
            subjectTerminalReason: string | null; subjectSupersededByTaskId: string | null;
            completionPolicy: string; completionCriterion: string; verifiesTaskId: string | null;
            hasDirectChildren: boolean; startsTaskWork: boolean;
          }>>(Prisma.sql`
            SELECT t."terminal_reason" AS "terminalReason",
                   t."superseded_by_task_id" AS "supersededByTaskId",
                   subject."terminal_reason" AS "subjectTerminalReason",
                   subject."superseded_by_task_id" AS "subjectSupersededByTaskId",
                   t."completion_policy"::text AS "completionPolicy",
                   t."completion_criterion"::text AS "completionCriterion",
                   t."verifies_task_id" AS "verifiesTaskId",
                   EXISTS (SELECT 1 FROM "task" c
                            WHERE c."parent_task_id" = t."id" AND c."owner_id" = t."owner_id")
                     AS "hasDirectChildren",
                   -- Re-read, never taken from the due-snapshot. Between that read and this
                   -- catch the row's own role can change: a session promoted to the task's work
                   -- would be re-armed on a stale false and quietly spend attempts, and one
                   -- demoted to a salvage conversation would be PERMANENTLY disarmed on a stale
                   -- true for a transient error that had nothing to do with AG6.
                   s."starts_task_work" AS "startsTaskWork"
              FROM "task" t
              JOIN "session" s ON s."task_id" = t."id"
              LEFT JOIN "task" subject ON subject."id" = t."verifies_task_id"
             WHERE s."id" = ${session.id}::uuid
          `);
          const retiredNow = current
            ? (taskRetirement(current)
              ?? taskRetirement({
                supersededByTaskId: current.subjectSupersededByTaskId,
                terminalReason: current.subjectTerminalReason,
              }))
            : null;
          // §13.1 AG6's commit-race half. The claim and the resume are two transactions, so the
          // task can become an aggregate parent between them — and then `resume` refuses, correctly,
          // while the ordinary catch below would call it transient, re-arm for two minutes and keep
          // the attempt it spent. Re-read rather than matched on the message, exactly as the
          // supersession branch is and for the same reason: a refusal that merely mentions the words
          // must not be able to end a retry.
          const aggregateNow = current != null && current.startsTaskWork && taskStartOwnedByCompletion({
            completionPolicy: current.completionPolicy as TaskCompletionPolicyValue,
            completionCriterion: current.completionCriterion as 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT',
            verifiesTaskId: current.verifiesTaskId,
            hasDirectChildren: current.hasDirectChildren,
          });
          if (!retiredNow && !aggregateNow && !(session.startsTaskWork && session.taskId)) {
            throw error;
          }
          // The same TOCTOU as the pre-claim branch, and closed the same way. `retiredNow` is a
          // fact that cannot un-happen, but the aggregate shape can be RELEASED between the re-read
          // above and this refund — and refunding on a stale reading would leave a row with no
          // claim, no countdown and an attempt silently handed back, which reads as a retry that
          // never existed. So when the aggregate shape is what ended this retry, the shape is
          // re-asserted inside the write; a retirement keeps the plain compare-and-set it had.
          // The locked helper decides the aggregate question, not the unlocked re-read above: a
          // shape that reads MANUAL here and becomes aggregating a moment later would otherwise be
          // re-armed and charged an attempt for a refusal that is about to be permanent. So any
          // non-retired, task-linked WORK session goes through it and takes its answer.
          const settle = !retiredNow && session.taskId && session.startsTaskWork
            ? await this.refundIfStillAggregateParent(
                session.id, session.taskId, attempts, session.status,
              )
            : 'RELEASED' as const;
          if (settle === 'BUSY') {
            // Judged nothing at all — somebody else holds a lock. The claim above already cleared
            // `retry_at` and spent an attempt, so leaving it there would strand the row. Put both
            // back, compare-and-set on exactly what this sweep wrote, and let the next tick decide.
            if (session.retryAt != null) {
              await this.rearm(session.id, session.status, session.retryAt, attempts, {
                taskId: session.taskId ?? null,
                startsTaskWork: session.startsTaskWork,
                retryAt: null,
                retryAttempts: attempts + 1,
                retryClaimedAt: claim,
              });
            }
            continue;
          }
          if (settle === 'RELEASED' && !retiredNow) {
            // Not an aggregate parent after all, under the lock. This is an ordinary transient
            // failure and gets the ordinary backoff, with the attempt it spent.
            throw error;
          }
          const refundedCount = settle === 'SETTLED' ? 1
            : (await this.prisma.session.updateMany({
                where: {
                  id: session.id,
                  status: session.status,
                  taskId: session.taskId ?? null,
                  startsTaskWork: session.startsTaskWork,
                  retryAt: null,
                  retryAttempts: attempts + 1,
                  retryClaimedAt: claim,
                },
                // The attempt handed back and the claim dropped in one statement: this retry is over,
                // and the session must stop reading as on its way to a turn (migration 0354).
                data: { retryAttempts: attempts, retryClaimedAt: null },
              })).count;
          const refunded = { count: refundedCount };
          this.log.log(`session ${session.id} retry abandoned: ${retiredNow
            ? `task was ${retiredNow.toLowerCase()}`
            : 'task is completed by aggregating its subtasks'}`);
          // The same settlement `disarm` publishes, and for the same reason: the clients have been
          // drawing this row as "Retrying" off a `retryAt` the claim above already removed, and no
          // future sweep will select it again. Without this the card waits forever for a countdown
          // that has ended. Guarded on the CAS so a concurrent writer that moved the row on is not
          // announced over, and so a re-entry publishes nothing twice.
          if (refunded.count > 0) {
            if (session.status === RunStatus.FAILED) {
              this.realtime.publish(session.id, {
                seq: Number.MAX_SAFE_INTEGER,
                type: RunEventType.STATUS,
                ts: new Date().toISOString(),
                payload: { status: RunStatus.FAILED, final: true },
              });
            } else {
              this.realtime.publishSessionUpdated(session.id);
            }
          }
          continue;
        }
        this.log.log(`session ${session.id} resumed (retry ${attempts + 1})`);
      } catch (e) {
        // The resume failed (runner gone, session raced into another state). Back off and
        // try again rather than dropping the retry: the message is still unanswered.
        const spent = attempts + 1;
        const delay = BACKOFF_MS[Math.min(spent, BACKOFF_MS.length) - 1];
        // The claim above wrote `retry_at = NULL, retry_attempts = spent` and its own instant;
        // anything else on the row now is somebody else's, and this backoff must not land on top
        // of it. A backoff that cannot be written leaves the claim standing, and its lease running
        // out is what gives the retry up (`releaseExpiredClaims`).
        await this.rearm(session.id, session.status, new Date(now.getTime() + delay), spent, {
          taskId: session.taskId ?? null,
          startsTaskWork: session.startsTaskWork,
          retryAt: null,
          retryAttempts: spent,
          retryClaimedAt: claimedAt,
        }).catch(() => 0);
        this.log.warn(
          `auto-retry of ${session.id} failed (attempt ${spent}): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  /**
   * The same question, asked by the card instead of by the sweep: what would a manual Retry
   * re-send?
   *
   * Both clients paint a session from a 200-event tail window and worked this out themselves, by
   * looking for a user message inside it. That is the answer for a conversation and the wrong one
   * for a run: one task session is a single message followed by thousands of tool events, so the
   * message the retry exists to re-send sits outside the window and the button vanished — on
   * exactly the sessions a provider outage kills. The clients cannot fix that by reading further
   * back without paging the whole history onto a phone.
   *
   * So it is answered here, by `messageToResend` itself. Not merely to avoid a third
   * implementation: the button PROMISES what the sweep would do, and any second chooser is a
   * promise that can differ from the act.
   *
   * Empty text when there is nothing to re-send — the same conclusion that disarms a sweep, and
   * the clients offer no button rather than a dead one.
   *
   * When the words are another Orbit session's, the card their echo carries comes with them
   * (`sessionMessage`, session-message.ts): a client whose window does not hold that echo learns
   * from it that the retry is not the owner's to send, and asks the server to re-send instead
   * (`resendRetryMessage`, contract §2.1).
   */
  async retryMessage(
    ownerId: string,
    id: string,
  ): Promise<{ text: string; sessionMessage?: SessionMessageCard }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true, prompt: true, numTurns: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const message = await this.messageToResend(session.id, session.prompt, session.numTurns);
    if (!message.content || !message.senderSessionId) return { text: message.content };
    const requestId = message.turnId
      ? (await readTurnRequestIds(this.prisma, session.id, [message.turnId])).get(message.turnId)
      : undefined;
    const card = await readSessionMessageCard(this.prisma, ownerId, message.senderSessionId, requestId);
    return card ? { text: message.content, sessionMessage: card } : { text: message.content };
  }

  /**
   * The failure card's Retry, when what it re-sends is another session's message (§2.1, §8 criterion
   * 15): re-sent now by the server, as the sweep would re-send it, and not through the owner's own
   * door — which would say the words again in the owner's name, signed by nobody. Here they keep their
   * sender, the request they were moves onto the new turn, and nothing is charged: not that pair's
   * hour (§2.4), not a steer.
   *
   * Idempotent on the FAILED message (§2.1, §8 criteria 19 and 22): the key is derived from the turn
   * whose failure the session is stopped on (`manualRetryTurnKey`), never minted per click. So a double
   * tap, or a response lost and pressed again, queues one turn for one failure; and a re-send that fails
   * in its turn is a failure of its own, whose press really does go out again — even when it failed
   * before the runner could echo it, which is how a Claude message the engine never took fails: the
   * chooser finds it by the runner's receipt (`messageToResend`).
   *
   * A press over a session that is NOT stopped on a failure re-sends nothing (`stoppedOnFailure`). It is
   * a press already answered — its re-send still on the way, or already through and only its response
   * lost — and it answers with that turn (`pressAlreadyOut`); anything else is refused, because a turn
   * written then would be a second copy of a message that did not fail. The same question is asked
   * again under the session's lock in the transaction that would write a new turn, so a revive landing
   * in between cannot be overtaken by a press decided a moment before it.
   *
   * The message is the one `retryMessage` answers with, chosen by the sweep's own chooser at the
   * moment of the click. The files it went out with go with it, by the ids they already have — the
   * re-send copies them as any resend of a file does (`SessionsService.assertLinkableAttachments`), so
   * a replay of this request under the same key names the same copies. NEXT_TURN, never a steer: a
   * re-send is a turn of its own.
   */
  async resendRetryMessage(
    ownerId: string,
    id: string,
    // The composer's pending pick, when Retry was pressed after choosing one — see RetryIdentityDto.
    identity: { provider?: string; account?: string } = {},
  ): Promise<SessionResumeAnswer> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true, prompt: true, numTurns: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const message = await this.messageToResend(session.id, session.prompt, session.numTurns);
    if (!message.content) {
      throw new ConflictException('this session has no message for a retry to re-send');
    }
    const press = (await this.stoppedOnFailure(this.prisma, session.id))
      ? { key: manualRetryTurnKey(message), attachmentsOf: message.attachmentsOf }
      : await this.pressAlreadyOut(session.id, message);
    if (!press) throw new ConflictException(NOTHING_FAILED);
    const attachmentIds = press.attachmentsOf
      ? (await this.prisma.attachment.findMany({
          where: { sessionId: session.id, turnId: press.attachmentsOf },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })).map((attachment) => attachment.id)
      : [];
    return this.sessions.resume(
      ownerId,
      session.id,
      {
        content: message.content,
        attachmentIds,
        clientTurnId: press.key,
        intent: 'NEXT_TURN',
        // What the composer had picked when Retry was pressed. The session moves onto it here, as it
        // would have had the person sent a message instead — which is the whole point of the button.
        ...(identity.provider ? { provider: identity.provider, account: identity.account } : {}),
      },
      {
        ...this.resendCarrying(session.id, message, false),
        // Reached only by a NEW turn — a replay of a key already written answers with its turn before
        // this — so it is the one question a new re-send has to answer, asked under the lock.
        participateSendTransaction: async (tx: Prisma.TransactionClient) => {
          if (!(await this.stoppedOnFailure(tx, session.id))) throw new ConflictException(NOTHING_FAILED);
        },
      },
    );
  }

  /**
   * Whether the session is stopped on a failure — what a NEW re-send by the failure card's Retry needs
   * (§8 criterion 22), and the moment the message it would re-send is the failed one. A run that FAILED
   * is; so is one parked idle with a retry armed or claimed for it, or whose latest reply is one of the
   * failures the card offers Retry on — a spent quota, a provider that could not answer, a sign-in that
   * lapsed — read the way the transcript reads them (`isUsageLimitErrorText`, `isRetryableApiErrorText`,
   * `isAuthErrorText`). Anything else is not: a session working on a turn, the re-send of a press among
   * them, or one whose latest message was answered.
   */
  private async stoppedOnFailure(
    db: Pick<Prisma.TransactionClient, 'session' | 'runEvent'>,
    sessionId: string,
  ): Promise<boolean> {
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { status: true, retryAt: true, retryClaimedAt: true, cancelRequestedAt: true },
    });
    if (!session) return false;
    if (session.status === RunStatus.FAILED) return true;
    if (session.status !== RunStatus.AWAITING_INPUT || session.cancelRequestedAt) return false;
    if (session.retryAt != null) return true;
    if (session.retryClaimedAt && Date.now() - session.retryClaimedAt.getTime() < RETRY_CLAIM_WINDOW_MS) {
      return true;
    }
    const replies = await db.runEvent.findMany({
      where: { sessionId, type: RunEventType.ASSISTANT },
      orderBy: { seq: 'desc' },
      take: 50,
      select: { payload: true },
    });
    const latest = replies.map(workspaceReplyText).find((text) => text);
    return !!latest && (isUsageLimitErrorText(latest) || isRetryableApiErrorText(latest) || isAuthErrorText(latest));
  }

  /**
   * The press a Retry over a session NOT stopped on a failure can only be a repeat of (§8 criteria 19 and
   * 22): its key, and the turn whose files the press that wrote it carried, or null when there is none.
   *
   *   - The failed message's re-send, still on its way and not echoed yet: the turn under the key a
   *     press over that message wrote.
   *   - The latest message IS a re-send of this door's — still running, or gone through and only its
   *     response lost. Its own key names the press that wrote it, and that press carried the files of
   *     the message it re-sent, which the key names too (a message with no turn row has no files here).
   */
  private async pressAlreadyOut(
    sessionId: string,
    message: ResendMessage,
  ): Promise<{ key: string; attachmentsOf: string | null } | null> {
    const overIt = manualRetryTurnKey(message);
    const resent = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId, clientTurnId: overIt } },
      select: { id: true },
    });
    if (resent) return { key: overIt, attachmentsOf: message.attachmentsOf };
    if (!message.turnId) return null;
    const turn = await this.prisma.conversationTurn.findFirst({
      where: { id: message.turnId, sessionId },
      select: { clientTurnId: true },
    });
    if (!turn?.clientTurnId.startsWith(MANUAL_RETRY_TURN_KEY_PREFIX)) return null;
    const source = turn.clientTurnId.slice(MANUAL_RETRY_TURN_KEY_PREFIX.length);
    return { key: turn.clientTurnId, attachmentsOf: UUID.test(source) ? source : null };
  }

  /**
   * What a re-send carries beside its words, the sweep's and the failure card's alike (§2.1, §8
   * criteria 14 and 17). A failed reply turn is re-sent as a reply turn that takes the outcomes it is
   * re-sent for in the transaction that writes it (`attachHeldReplies`). Another session's message
   * keeps its sender — without it the recipient reads it as the account owner's — and the request it
   * was moves onto the new turn (`moveSessionRequestToTurn`), so the block the engine reads asks for a
   * reply and the card names the request. Nothing else is passed: this is the platform's re-send,
   * charged neither against that pair's hourly limit nor as a steer. (Both callers do hand `resume` a
   * `participateSendTransaction` — the slot those charges ride in for the session-to-session doors — but
   * theirs only reads the session and refuses: the sweep's claim, the card's failure. It writes nothing.)
   */
  private resendCarrying(sessionId: string, message: ResendMessage, resendsReplies: boolean) {
    if (resendsReplies) {
      return {
        onTurnWritten: (tx: Prisma.TransactionClient, turn: { clientTurnId: string }) =>
          attachHeldReplies(tx, sessionId, turn.clientTurnId),
      };
    }
    if (!message.senderSessionId) return undefined;
    const carriedBy = message.turnId;
    return {
      senderSessionId: message.senderSessionId,
      ...(carriedBy
        ? {
            onTurnWritten: (tx: Prisma.TransactionClient, turn: { id: string }) =>
              moveSessionRequestToTurn(tx, sessionId, carriedBy, turn.id),
          }
        : {}),
    };
  }

  /**
   * The message this retry re-sends: the session's latest user-authored message, whole.
   *
   * `attachmentsOf` is the turn that message was sent on, because the words are only half of
   * it — a screenshot the user sent with them is a row hanging off that turn, and a retry that
   * re-sent the text alone asked the model about a picture it was never shown. Null when there
   * is nothing to carry.
   *
   * `senderSessionId` is who sent it, when that turn was another Orbit session's message
   * (session-message.ts): the re-send is still that session's, and delivered without its sender it
   * would read as the account owner's. Null for every message nobody's session sent.
   *
   * `turnId` is the turn those words are read off, when they are a turn's: the request they were, if
   * they were one, sits on it and moves with the re-send (`moveSessionRequestToTurn`).
   *
   * `sessionReplies` says the latest turn handed back the outcomes of this session's own requests: it
   * has no words to re-send, and the sweep re-sends it as a reply turn when its outcomes are held.
   */
  private async messageToResend(
    sessionId: string,
    prompt: string,
    numTurns: number,
  ): Promise<ResendMessage> {
    // What the runner recorded of the messages it took, read the way the drain that keeps a failed
    // turn's request for this re-send reads it (session-request.ts `retryRecords`). The user echoes
    // themselves, not a tail of the whole stream, which on a long turn holds none; the receipts of the
    // messages it could not give the engine at all — a Claude message the runtime refused before writing
    // it fails with no echo, and read by echoes alone the message before it was re-sent, an answered
    // one, while the request the failed one carried stayed on it (§8 criteria 22 and 23); and the one it
    // took and went away with before recording anything of it, reaped as offline (§8 criterion 27). A
    // receipt, or the claim's stamp, stands for its turn exactly as an echo does; neither carries words,
    // so the turn's own are the ones re-sent.
    const events = await retryRecords(this.prisma, sessionId);
    // A turn nobody sent — a background agent or workflow reporting in — failing is not the
    // person's message failing. When theirs had already been answered there is nothing to re-send,
    // for the reason a background job's wake has none (below): stepping past it re-sends a
    // question already answered. The runtime still holds the notification that woke that turn and
    // hands it over with the next message it is sent. (A message the runner went away with was
    // answered by nothing, so nothing failed after its answer.)
    const latest = events[events.length - 1];
    if (latest?.seq != null && await this.failureFollowsAnsweredMessage(sessionId, { turnId: latest.turnId, seq: latest.seq })) {
      return { content: '', attachmentsOf: null, senderSessionId: null, turnId: null };
    }

    // A provider's user event echoes exactly what the runner received, including delivery-time
    // #reference/list expansion and a promoted coordinator's standing role. The durable turn is
    // the source of truth for what the person actually typed. Besides preventing those generated
    // blocks from becoming a new persisted message on every retry, this keeps an image-only turn
    // image-only: coordinator context in its echo must not make it win as authored text.
    const turnIds = [...new Set(events.flatMap((event) => event.turnId ? [event.turnId] : []))];
    const turns = turnIds.length > 0
      ? await this.prisma.conversationTurn.findMany({
          where: { sessionId, id: { in: turnIds } },
          select: {
            id: true,
            clientTurnId: true,
            kind: true,
            sendIntent: true,
            targetTurnId: true,
            deliveryStatus: true,
            content: true,
            senderSessionId: true,
            // A CURRENT_WORK USER can be the newest authored event when the executable it joined
            // fails. That adjustment is not a new executable. Follow its durable address back to
            // the exact message whose provider run failed, even if that message's USER fell
            // outside the bounded event lookup.
            targetTurn: {
              select: {
                id: true,
                kind: true,
                sendIntent: true,
                deliveryStatus: true,
                content: true,
                senderSessionId: true,
              },
            },
          },
        })
      : [];
    type RetryTurn = {
      id: string;
      kind: string;
      sendIntent: string | null;
      deliveryStatus: string | null;
      content: string | null;
      senderSessionId: string | null;
    };
    const durableTurns = new Map<string, RetryTurn>();
    for (const turn of turns) {
      durableTurns.set(turn.id, turn);
      if (turn.targetTurn) durableTurns.set(turn.targetTurn.id, turn.targetTurn);
    }
    // Each turn's own sender beside its words: the one re-sent is the one whose words are re-sent,
    // which for an addressed steer is the message it joined rather than the steer.
    const durableContent = new Map([...durableTurns.values()].map((turn) => [turn.id, {
      id: turn.id,
      content: turn.content ?? '',
      senderSessionId: turn.senderSessionId ?? null,
    }]));

    const executableFor = (turnId: string) => {
      const observed = durableTurns.get(turnId);
      if (!observed) return undefined;
      // A steer is authored input but never an independently retryable turn. Explicit
      // CURRENT_WORK has an exact target, so use that executable; a legacy unaddressed steer can
      // only be skipped in favour of the preceding executable USER event.
      const candidate = observed.kind === 'steer'
        ? turns.find((turn) => turn.id === observed.id)?.targetTurn ?? undefined
        : observed;
      if (
        !candidate
        || candidate.kind !== 'message'
        || candidate.sendIntent === 'CURRENT_WORK'
        || candidate.deliveryStatus != null
      ) return undefined;
      return durableContent.get(candidate.id);
    };

    let chosen: (typeof events)[number] | undefined;
    let chosenDurable: { id: string; content: string; senderSessionId: string | null } | undefined;
    let content = '';
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.turnId && durableTurns.has(event.turnId)) {
        // A background job's wake (runner-api/background-job-wake.ts) carries nobody's words, and
        // stepping past it would re-send what the person said before it — a message already
        // answered. There is nothing to re-send; the job's end stays in its durable event. A turn
        // handing back the outcomes of session requests carries nobody's words either, and stepping
        // past it is wrong for the same reason; what it said is on the request rows, where its
        // failure held it, and the sweep re-sends it as a reply turn (sessions/session-request.ts).
        // Not a wake or reply STEER: it joined a turn that was running, and that turn is what
        // failed — the steer is followed to it below, as any CURRENT_WORK steer is. What a reply
        // steer carried and its engine never confirmed is held for the turn that re-sends it.
        const turnOfEvent = turns.find((turn) => turn.id === event.turnId);
        const keyOfTurn = turnOfEvent?.clientTurnId;
        if (isSessionReplyTurn(keyOfTurn) && turnOfEvent?.kind !== 'steer') {
          return { content: '', attachmentsOf: null, senderSessionId: null, turnId: null, sessionReplies: true };
        }
        // A confirmation request handed to its reviewer, or a reviewer's return handed to the run
        // (tasks/owner-confirmation-review-turn.ts), is re-sent as itself: stepping past it would
        // re-send a message the session already answered.
        if (keyOfTurn && isConfirmationReviewContentTurn(keyOfTurn)) {
          return { content: '', attachmentsOf: null, senderSessionId: null, turnId: null, confirmationReviewTurn: keyOfTurn };
        }
        if (isBackgroundWakeTurn(keyOfTurn) && turnOfEvent?.kind !== 'steer') break;
        const original = executableFor(event.turnId);
        if (original?.content.trim()) {
          chosen = event;
          chosenDurable = original;
          content = original.content;
          break;
        }
        // The row either says the person supplied no words or identifies a non-executable
        // CURRENT_WORK/terminal receipt. Do not fall back to its echoed delivery text and turn an
        // adjustment into a fresh executable retry.
        continue;
      }
      // Old events can predate turn attribution, and a retained event can outlive a missing turn
      // in recovered data. Preserve their previous behaviour as a compatibility fallback.
      const echoed = (event.payload as { text?: unknown } | undefined)?.text;
      if (typeof echoed === 'string' && echoed.trim()) {
        chosen = event;
        content = echoed;
        break;
      }
    }
    let seeded: { id: string; content: string } | null = null;
    if (!content && numTurns === 0) {
      seeded = await this.seededTurnForRetry(sessionId);
      const opening = seeded?.content || prompt;
      if (opening.trim()) content = opening;
    }
    if (!content) return { content: '', attachmentsOf: null, senderSessionId: null, turnId: null };
    // The turn THAT message came from, never merely the session's latest turn: pairing these words
    // with a later turn's images would re-send a message the user never wrote.
    return {
      content,
      // No user event means the text above is the opening-prompt fallback, which the runner
      // never got to announce. Its uploads are the compose page's, and the claim parked them
      // on the seeded first turn.
      attachmentsOf: chosenDurable?.id ?? (chosen ? chosen.turnId : seeded?.id ?? null),
      // Read off the same durable turn as the words. An echo with no turn row behind it, and the
      // opening prompt, are nobody's session's message.
      senderSessionId: chosenDurable?.senderSessionId ?? null,
      // ...and so is the request those words were, when they were one: it sits on that turn.
      turnId: chosenDurable?.id ?? null,
    };
  }

  /**
   * Is the reply a retry would answer a turn the runtime started for itself, failing after the
   * person's latest message had been answered?
   *
   * Read off the workspace's own replies (sub-agents' reports carry parentToolUseId and are not
   * replies to anyone): the newest one belongs to no turn — the "turn nobody delivered" the spend
   * fuse also reads — while the latest message's own turn got an answer that is not one of the
   * self-healing failures. Both halves matter: when that message's turn itself died on the quota
   * or an outage, it is still owed its retry however many background turns failed after it. A
   * message with no turn id predates turn attribution, which leaves nothing to compare, so it
   * keeps the old reading.
   */
  private async failureFollowsAnsweredMessage(
    sessionId: string,
    latest: { turnId: string | null; seq: number } | undefined,
  ): Promise<boolean> {
    if (!latest?.turnId) return false;
    const replyText = workspaceReplyText;
    const select = { payload: true, turnId: true, seq: true } as const;
    const after = await this.prisma.runEvent.findMany({
      where: { sessionId, type: RunEventType.ASSISTANT, seq: { gt: latest.seq } },
      orderBy: { seq: 'desc' },
      take: 50,
      select,
    });
    const newest = after.find((row) => replyText(row));
    if (!newest || newest.turnId != null) return false;
    const own = await this.prisma.runEvent.findMany({
      where: { sessionId, type: RunEventType.ASSISTANT, turnId: latest.turnId },
      orderBy: { seq: 'desc' },
      take: 50,
      select,
    });
    const answer = own.map(replyText).find((text) => text);
    return !!answer && !isRetryableApiErrorText(answer) && !isUsageLimitErrorText(answer);
  }

  /** The opening turn, found by the fixed seed id. */
  private async seededTurnForRetry(sessionId: string): Promise<{
    id: string;
    content: string;
  } | null> {
    const seed = await this.prisma.conversationTurn.findUnique({
      where: {
        sessionId_clientTurnId: {
          sessionId,
          clientTurnId: SessionsService.initialTurnClientId(sessionId),
        },
      },
      select: { id: true, content: true },
    });
    return seed ? { id: seed.id, content: seed.content ?? '' } : null;
  }

  /**
   * The attachments sent with the message being re-sent, copied for the turn this retry is
   * about to write. Returns the copies' ids, in the shape `resume` links: owned by the same
   * person, scoped to the session, not yet on a turn.
   *
   * Copies rather than re-points, even though it duplicates the bytes. An attachment belongs to
   * exactly one turn and cascade-deletes with it, and the turn a retry writes is a QUEUED one —
   * an interrupt, a withdrawal or an end deletes it. Moving the rows would put the only copy of
   * the user's image behind that, so the failed attempt's bubble would lose its picture the
   * first time a retry was cancelled. The copies die with the session either way.
   */
  private async copyAttachments(
    sessionId: string,
    turnId: string,
  ): Promise<string[]> {
    const sent = await this.prisma.attachment.findMany({
      where: { sessionId, turnId },
      orderBy: { createdAt: 'asc' },
    });
    const copies: string[] = [];
    for (const a of sent) {
      const copy = await this.prisma.attachment.create({
        data: {
          ownerId: a.ownerId,
          sessionId,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          fileName: a.fileName,
          data: a.data,
        },
        select: { id: true },
      });
      copies.push(copy.id);
    }
    return copies;
  }

  /** Drop copies made for a re-send that did not happen. `turnId: null` is the whole guard:
   *  one that did reach a turn is that turn's image now, not this sweep's to delete. */
  private async discardCopies(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.prisma.attachment.deleteMany({
        where: { id: { in: ids }, turnId: null },
      });
    } catch {
      // Bytes nobody will ever see, in the failure path of a retry that still has a backoff to
      // arm. Losing the cleanup must not lose that too; the session's deletion collects them.
    }
  }

  /**
   * Push the retry out to `at`. Gated on the session still being parked rather than on it
   * still being armed: the failure path runs *after* the claim has already cleared retryAt, so
   * an "is it still armed" guard here would silently drop every backoff and strand the session
   * forever. `parkedAs` is the status the sweep read, so the gate says "no one has taken over
   * since" for either shape of parked — a session whose user has since replied is no longer
   * waiting on us. Passing it in rather than re-asserting one status is what keeps a FAILED
   * row's backoff from being dropped by a filter it can never satisfy.
   */
  /**
   * @param expect the row this sweep believes it is writing to, when it has already CLAIMED it.
   *
   * `id + status` alone is not enough after a claim. Between clearing `retry_at` and putting a new
   * one back, the row can be re-pointed at another task, demoted to a salvage conversation, or
   * armed by hand to a future instant — and a rearm that asserts only the status would overwrite
   * any of those with a decision made about the retry they replaced. The deferral paths that run
   * BEFORE the claim pass nothing and keep their old behaviour, because there the arm they are
   * preserving is still the one they read.
   *
   * The full durable retry generation is G3's; this is the narrow compare-and-set that keeps the
   * paths H0 touches from writing over somebody else's newer fact.
   *
   * `retryClaimedAt` is the claim itself (§8 criterion 25): the owner turning the retry off mid-claim
   * leaves `retry_at` NULL and the attempt count as the claim wrote them, so without it a backoff after
   * a resume that failed would re-arm a retry the owner had just turned off — and its turn would say
   * again what the "off" had already had said.
   */
  private async rearm(
    sessionId: string,
    parkedAs: RunStatus,
    at: Date,
    attempts: number,
    expect?: {
      taskId: string | null; startsTaskWork: boolean;
      retryAt: Date | null; retryAttempts: number;
      /** Only after a claim: the deferrals before one read an arm, and an armed row has no claim. */
      retryClaimedAt?: Date | null;
    },
  ): Promise<number> {
    const claimed = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        status: parkedAs,
        ...(expect
          ? {
              taskId: expect.taskId,
              startsTaskWork: expect.startsTaskWork,
              retryAt: expect.retryAt,
              retryAttempts: expect.retryAttempts,
              ...(expect.retryClaimedAt !== undefined ? { retryClaimedAt: expect.retryClaimedAt } : {}),
            }
          : {}),
      },
      // Re-armed: whatever the claim was, this is a retry waiting for a LATER instant, not one on its
      // way to a turn (migration 0354).
      data: { retryAt: at, retryAttempts: attempts, retryClaimedAt: null },
    });
    return claimed.count;
  }

  /**
   * Stop retrying. The session keeps its transcript, keeps the status it was parked in and
   * stays resumable; the card in the UI flips to a manual retry. `retryAttempts` is left where
   * it stopped so the card can say how many tries it took to get here.
   *
   * A task-bound session is deliberately NOT failed here. That is what it already does today
   * when a quota kills a turn, the task scheduler has its own quota gate (tasks.service
   * quotaBlockedRunners) that resumes such work on its own, and failing the task would hand it
   * to the auto-run backoff — a second retry mechanism racing this one.
   */
  /**
   * §13.1 AG6's stand-down, decided under the lock that the release directions have to take.
   *
   * `disarm` below clears `retry_at` on the strength of a decision made earlier in the sweep. That
   * is a weaker guarantee than it looks — a retirement can be undone and a session can be re-armed
   * or re-pointed between the batch read and the clear, so the retirement path has the same class
   * of window. Closing it properly needs a durable retry generation, which is G3's unit and is
   * deliberately NOT rebuilt here; what this path owes is not to ADD another instance of it.
   *
   * The aggregate shape makes that duty concrete: switching the policy back to MANUAL and deleting
   * the last
   * same-owner child are both ordinary, supported writes (§13.1 AG6-c calls them the release
   * directions), and so is demoting the session to a salvage conversation or re-arming it by hand.
   * Clearing `retry_at` on a stale reading throws away a retry that is legal again, permanently,
   * with no attempt spent and nothing left to re-arm it.
   *
   * A single conditional `UPDATE ... WHERE EXISTS (SELECT ... FROM task)` does NOT close that, and
   * it is worth being exact about why, because it reads as though it should: one statement has one
   * snapshot, but it takes no lock on `task`, and the row it updates is not the row that changed —
   * so there is no EPQ re-evaluation. A release committing after that snapshot is simply invisible,
   * and the clear lands anyway. READ COMMITTED gives atomicity of the WRITE, never linearizability
   * across two tables.
   *
   * So this takes the same lock the release directions must: `project` then `task`, the order
   * §7.7 and 0132 both impose, and `FOR UPDATE` on the task because that is the mode
   * `task_aggregate_parent_shape_guard` conflicts with. Whichever of the two gets there first
   * commits, and the other reads its committed effect. Every acquisition is NOWAIT, like the rest
   * of that protocol — a sweep that cannot have the row simply leaves the retry armed and looks
   * again next tick, which is strictly better than waiting inside a background pass.
   *
   * Zero rows is the normal outcome whenever the world moved, not an error.
   */
  /**
   * The refund half of the same rule, under the same lock and for the same reason.
   *
   * The claim and the resume are two transactions, so the aggregate shape can be released between
   * the re-read that ended this retry and the refund that records it. Handing the attempt back on a
   * stale reading leaves a row with no claim, no countdown and a budget quietly restored — a retry
   * that reads as though it never existed.
   */
  private async refundIfStillAggregateParent(
    sessionId: string,
    taskId: string,
    attempts: number,
    parkedAs: RunStatus,
  ): Promise<AggregateSettleOutcome> {
    return this.underAggregateParentLock(
      taskId, sessionId,
      { parkedAs, attempts: attempts + 1, observedRetryAt: null, requireArmed: false },
      (tx) => tx.$executeRaw(Prisma.sql`
        UPDATE "session" SET "retry_attempts" = ${attempts}, "retry_claimed_at" = NULL,
                             "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${sessionId}::uuid
      `),
    );
  }

  private async disarmIfStillAggregateParent(
    sessionId: string,
    parkedAs: RunStatus,
    taskId: string,
    attempts: number,
    observedRetryAt: Date,
  ): Promise<AggregateSettleOutcome> {
    return this.underAggregateParentLock(
      taskId, sessionId,
      { parkedAs, attempts, observedRetryAt, requireArmed: true },
      (tx) => tx.$executeRaw(Prisma.sql`
        UPDATE "session" SET "retry_at" = NULL, "retry_claimed_at" = NULL,
                             "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${sessionId}::uuid
      `),
    );
  }

  /**
   * project -> task -> session, and NOWAIT at EVERY step including the session row.
   *
   * The session lock is not decoration. A plain `UPDATE "session" ... WHERE id = ...` at the end of
   * this walk takes a row lock by WAITING, and a concurrent writer that goes session-first — a
   * resume, a status write, an arm — would then hold the session and wait for this task, while this
   * transaction holds the task and waits for that session. That is a real `40P01`, and catching it
   * here does not repair it: PostgreSQL may pick the OTHER transaction as the victim, so a
   * background sweep would be killing a user's request. Taking the session `FOR UPDATE NOWAIT`
   * first turns the same situation into "somebody else has it, look again next tick".
   *
   * Everything the caller's compare-and-set depends on is re-read INSIDE these locks — the task's
   * project (so a task moved between the scope read and the lock cannot leave this holding the old
   * project), the task's shape, and the session's own task, role, status and claim. `null` means
   * the world moved; the caller leaves the retry armed.
   */
  private async underAggregateParentLock(
    taskId: string,
    sessionId: string,
    expect: {
      parkedAs: RunStatus; attempts: number; observedRetryAt: Date | null;
      requireArmed: boolean;
    },
    write: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<AggregateSettleOutcome> {
    try {
      // Through the shared retry, which is what puts this unit in the conflict counters under a
      // name — a unit that opted out would absorb conflicts invisibly, which is the whole point of
      // `db-conflict-metrics`.
      //
      // The two kinds of failure below are answered differently, and only one of them is a retry.
      // A `55P03` is a NOWAIT that declined to wait: somebody is writing these rows right now, and
      // the answer is to leave the retry armed for the next tick rather than to spend attempts
      // re-earning it — `classifyTransactionError` agrees, and does not call it transient. A
      // `40P01`/`40001` is the server throwing the transaction away, and re-running is correct:
      // every fact this closure decides on is re-read inside it.
      return await withTransactionRetry(this.prisma, async (tx) => {
        const [scope] = await tx.$queryRaw<Array<{ projectId: string | null }>>(Prisma.sql`
          SELECT t."project_id" AS "projectId" FROM "task" t WHERE t."id" = ${taskId}::uuid
        `);
        if (!scope) return 'RELEASED';
        // The project is taken first even though nothing here reads it: 0132's shape guard takes it
        // before the task, and an acquisition order that disagreed would be the inversion the whole
        // protocol exists to avoid.
        if (scope.projectId) {
          await tx.$queryRaw(Prisma.sql`
            SELECT 1 FROM "project" p WHERE p."id" = ${scope.projectId}::uuid
             FOR NO KEY UPDATE NOWAIT
          `);
        }
        // TAKE the row first, and read the predicate in a SEPARATE statement afterwards. Both in
        // one `SELECT ... FOR UPDATE` would evaluate the predicate against that statement's
        // snapshot, which was taken BEFORE the lock was granted — so a release that committed while
        // this was waiting would be invisible and the stale answer would win. A second statement
        // gets a fresh snapshot, and by then the lock is held, so what it reads cannot move.
        const [locked] = await tx.$queryRaw<Array<{ projectId: string | null }>>(Prisma.sql`
          SELECT t."project_id" AS "projectId" FROM "task" t WHERE t."id" = ${taskId}::uuid
           FOR UPDATE NOWAIT
        `);
        if (!locked) return 'RELEASED';
        const [task] = await tx.$queryRaw<Array<{ projectId: string | null; aggregate: boolean }>>(
          Prisma.sql`
            SELECT t."project_id" AS "projectId",
                   -- taskStartOwnedByCompletion, spelled in SQL because this one has to be read
                   -- under the lock. The gate row is the POLICY's, not the criterion's: a task that
                   -- declares VERIFICATION and does its own work is an ordinary work row, and
                   -- answering true for it here would refund and permanently disarm a retry that
                   -- the unlocked predicate above had already called transient.
                   ((t."completion_policy"::text = 'VERIFICATION_PASSED'
                     AND t."verifies_task_id" IS NULL)
                    OR (t."completion_policy"::text <> 'MANUAL'
                        AND EXISTS (SELECT 1 FROM "task" c
                                     WHERE c."parent_task_id" = t."id"
                                       AND c."owner_id" = t."owner_id"))) AS "aggregate"
              FROM "task" t WHERE t."id" = ${taskId}::uuid
          `,
        );
        if (!task?.aggregate) return 'RELEASED';
        // The scope read above was a guess: the task could have been re-filed between it and this
        // lock, leaving this transaction holding the OLD project while the guard takes the new one.
        if (task.projectId !== scope.projectId) return 'RELEASED';

        const [session] = await tx.$queryRaw<Array<{
          taskId: string | null; startsTaskWork: boolean; status: string; retryAt: Date | null;
          retryAttempts: number;
        }>>(Prisma.sql`
          SELECT s."task_id" AS "taskId", s."starts_task_work" AS "startsTaskWork",
                 s."status"::text AS "status", s."retry_at" AS "retryAt",
                 s."retry_attempts" AS "retryAttempts"
            FROM "session" s WHERE s."id" = ${sessionId}::uuid
           FOR UPDATE NOWAIT
        `);
        if (!session) return 'RELEASED';
        if (session.taskId !== taskId || !session.startsTaskWork) return 'RELEASED';
        if (session.status !== expect.parkedAs) return 'RELEASED';
        if (session.retryAttempts !== expect.attempts) return 'RELEASED';
        // A cancel followed by a re-arm to a NEW instant is a different retry, and the claim this
        // sweep observed is what says so. (The full durable generation is G3's; this is the narrow
        // version that keeps THIS path from adding the same class of mis-clear.)
        if (expect.requireArmed) {
          if (session.retryAt == null || expect.observedRetryAt == null) return 'RELEASED';
          if (session.retryAt.getTime() !== expect.observedRetryAt.getTime()) return 'RELEASED';
        } else if (session.retryAt != null) {
          return 'RELEASED';
        }
        return (await write(tx)) > 0 ? 'SETTLED' : 'RELEASED';
      }, loggedRetry(this.log, 'sessions.autoRetry.aggregateParentSettle'));
    } catch (error) {
      // `lock_not_available` (55P03) and a serialization failure both mean the same thing here:
      // somebody else is writing one of these rows right now. Leave the retry armed and look again.
      //
      // Read through the repo's extractor rather than off `error.code`: Prisma wraps a failed raw
      // query as `P2010` and carries the driver's SQLSTATE in `meta`, so a bare `code` comparison
      // recognises the shape a test sees through `pg` and NOT the one production raises.
      // One extractor for all three shapes this stack can put a SQLSTATE in — in particular
      // Prisma 7's adapter, which buries it under `meta.driverAdapterError.cause`.
      // A NOWAIT that declined to wait is a decision, not a fault, so it is read straight off the
      // SQLSTATE — `classifyTransactionError` deliberately excludes it from the transient set.
      if (postgresSqlState(error) === '55P03') return 'BUSY';
      // The two the SERVER threw the transaction away for are read through the one module that
      // decides what transient means. A private copy here is how a conflict ends up retried by one
      // layer and answered 500 by another; `db-write-inventory.spec` fails the build for it.
      if (classifyTransactionError(error).retryable) return 'BUSY';
      throw error;
    }
  }

  /**
   * End a retry this sweep has already claimed, because its re-send turned out to have nothing to say.
   * The claim cleared `retry_at` and spent an attempt in one statement — the shape migrations 0350 and
   * 0352 read as a retry going ahead — so handing the attempt back is what says it was given up: the
   * requests waiting on a failed session close, and outcomes held for its retry are said on its task.
   * A compare-and-set on exactly what the claim wrote, so a session revived in between is left alone.
   */
  private async giveUpClaim(
    sessionId: string,
    parkedAs: RunStatus,
    attempts: number,
    claimedAt: Date,
    why: string,
  ): Promise<void> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, status: parkedAs, retryAt: null, retryAttempts: attempts + 1, retryClaimedAt: claimedAt },
      // The attempt goes back in the same statement that drops the claim: from here the sweep is not
      // going to write the turn, so the session must not read as on its way to one (migration 0354).
      data: { retryAttempts: attempts, retryClaimedAt: null },
    });
    this.log.warn(`auto-retry of ${sessionId} given up after its claim: ${why}`);
    if (count > 0) this.announceSettled(sessionId, parkedAs);
  }

  /**
   * The claim's lease, held to the transaction that writes the re-send (§8 criteria 24 and 25): handed
   * to `resume` as the check it runs under the session's lock just before the turn is written, it lets
   * the turn through only while the session still carries the claim THIS sweep wrote and the claim is
   * inside the window every reader believes it for (`RETRY_CLAIM_WINDOW_MS`).
   *
   * Anything else is somebody else's answer about this retry, and a re-send written over it says the
   * same thing twice. The owner turned the retry off, or armed it for later, or sent a message of their
   * own — each clears the claim — and an outcome held for the retry's turn has meanwhile been marked for
   * the request worker (0352's trigger, and 0366's for an asker parked idle), which tells it where the
   * asker stands: a re-sent turn would say it again. Or the claim outlived its lease, and readers have
   * stopped believing it: such a claim is given up (`releaseExpiredClaims`) and what was held for it is
   * said elsewhere. Reads only.
   */
  private whileClaimHeld(sessionId: string, claimedAt: Date) {
    return async (tx: Prisma.TransactionClient): Promise<void> => {
      const row = await tx.session.findUnique({ where: { id: sessionId }, select: { retryClaimedAt: true } });
      if (row?.retryClaimedAt?.getTime() !== claimedAt.getTime()) {
        throw new RetryClaimLost('its claim was taken back before the re-send was written');
      }
      if (Date.now() - claimedAt.getTime() >= RETRY_CLAIM_WINDOW_MS) {
        throw new RetryClaimLost('its claim outlived its lease before the re-send was written');
      }
    };
  }

  /**
   * §8 criterion 24: a claim whose re-send was never written is a retry given up, once its lease has run
   * out (`RETRY_CLAIM_WINDOW_MS`). The claim and the re-send are two transactions, and the process can
   * stop between them — a deploy does not wait for a sweep — or the backoff after a failed re-send can
   * fail to be written; either way the claim is left on a parked session with nobody coming back for it.
   * Readers stop believing it at the end of its lease, but nothing was SAID: an outcome held for the
   * retry's turn stayed held, unmarked, for a turn that was never going to come.
   *
   * So it is given up the way `giveUpClaim` gives one up: the attempt the claim spent handed back and the
   * claim cleared, in one compare-and-set on the claim as it was read, on a session still parked with no
   * retry armed. That statement is what the triggers read: 0352/0366's marks what was held for the asker
   * — and the request worker says it where the asker stands now, §4.3's comment for one that has ended,
   * §4.2's reply turn for one that is merely idle — and 0350's closes what was asked of a run that, with
   * no retry left, has ended. A session revived, re-armed or ended in the meantime matches nothing.
   */
  async releaseExpiredClaims(now: Date = new Date()): Promise<string[]> {
    const lapsed = await this.prisma.session.findMany({
      where: {
        retryClaimedAt: { lte: new Date(now.getTime() - RETRY_CLAIM_WINDOW_MS) },
        retryAt: null,
        deletedAt: null,
        completedAt: null,
        status: { in: [RunStatus.FAILED, RunStatus.AWAITING_INPUT] },
      },
      orderBy: { retryClaimedAt: 'asc' },
      take: MAX_PER_SWEEP,
      select: { id: true, status: true, retryAttempts: true, retryClaimedAt: true },
    });
    const released: string[] = [];
    for (const session of lapsed) {
      const { count } = await this.prisma.session.updateMany({
        where: {
          id: session.id,
          status: session.status,
          retryAt: null,
          retryAttempts: session.retryAttempts,
          retryClaimedAt: session.retryClaimedAt,
        },
        data: { retryAttempts: Math.max(0, session.retryAttempts - 1), retryClaimedAt: null },
      });
      if (count === 0) continue;
      released.push(session.id);
      this.log.warn(`auto-retry of ${session.id} given up: its claim's re-send was never written`);
      this.announceSettled(session.id, session.status);
    }
    return released;
  }

  private async disarm(sessionId: string, parkedAs: RunStatus, why: string): Promise<void> {
    const cleared = await this.prisma.session.updateMany({
      where: { id: sessionId, status: parkedAs },
      // The retry is over, so nothing is on its way to a turn any more: a claim that had not been
      // resolved yet ends here too (migration 0354).
      data: { retryAt: null, retryClaimedAt: null },
    });
    this.log.warn(`auto-retry of ${sessionId} disarmed: ${why}`);
    if (cleared.count === 0) return;
    this.announceSettled(sessionId, parkedAs);
  }

  /** What a row that has stopped waiting owes its clients; see `disarm` for why it is published. */
  private announceSettled(sessionId: string, parkedAs: RunStatus): void {
    // Giving up is the moment the failure becomes the outcome, so this is where it is announced.
    // The row moves no status — it has been FAILED since the turn died — but the clients have
    // been drawing it as "Retrying" off the `retryAt` that just went away, so they need to be
    // told that the wait is over as much as the owner's phone does. Publishing the STATUS does
    // both: `final` with no `retryAt` beside it is exactly the settlement signal the failing
    // turn withheld, and RealtimeService.publish turns it into the one push notification.
    if (parkedAs === RunStatus.FAILED) {
      this.realtime.publish(sessionId, {
        seq: Number.MAX_SAFE_INTEGER,
        type: RunEventType.STATUS,
        ts: new Date().toISOString(),
        payload: { status: RunStatus.FAILED, final: true },
      });
      return;
    }
    // The other spelling of parked is a session that simply idled (a quota killed the turn
    // before it could fail one), which is not a failure and never was: nothing to announce and
    // nothing terminal to declare — only a row whose card just lost its countdown.
    this.realtime.publishSessionUpdated(sessionId);
  }
}
