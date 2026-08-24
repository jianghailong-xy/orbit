import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import {
  RunEventType,
  lastUserMessage,
  lastUserMessageText,
  planUsageBlockedUntil,
  type PlanUsage,
} from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { postgresSqlState, taskRetirement } from '../tasks/task-supersession';
import { TaskCompletionPolicyValue, isAggregateParent } from '../projects/task-aggregation';
import { RealtimeService } from '../realtime/realtime.service';
import { deriveSessionCapabilities } from './session-state';
import { SessionsService } from './sessions.service';
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
const BACKOFF_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);
// One session per (runner, provider) per sweep. Both failures this retries are shared facts —
// one account's quota, one provider's outage — so releasing a whole fleet at the first moment
// it might be over is how you spend the quota again, or reproduce the overload.
const PER_QUOTA_PER_SWEEP = 1;
// Nothing here is worth waking a scheduler for at a fixed cost forever: read a bounded page,
// and let a backlog drain over consecutive sweeps.
const MAX_PER_SWEEP = 50;

/**
 * Re-sends messages that a self-healing failure killed, once it is likely to work.
 *
 * Three failures qualify. Two arrive as the entire reply: the account's provider quota running
 * out, and the provider being briefly unable to answer ("API Error: 529 … overloaded_error").
 * The third arrives as no reply at all — the runner went away mid-turn and the reaper finalized
 * the session as 'runner offline'. None of the three says anything about the work, and all
 * three succeed on a plain re-send of the same message.
 *
 * `Session.retryAt` is armed on event ingestion (runner-api.controller) for the first two, and
 * by the reaper for the third. This service is the other half: it waits for that moment,
 * confirms the thing that failed is actually available again — the provider's quota, or the
 * runner itself — and re-sends. It exists as its own sweeper rather than as another branch of
 * the reaper because the reaper's job is ending things that are stuck — this one starts things
 * that are merely waiting, and must not inherit "finalize it" as a fallback behaviour.
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
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.log.error('sweep failed: ' + (e as Error).message));
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
          select: { planUsage: true, status: true, lastHeartbeatAt: true },
        },
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
        const blockedUntil = planUsageBlockedUntil(
          session.assignedRunner?.planUsage as PlanUsage | null,
          session.provider,
          now,
        );
        if (blockedUntil) {
          await this.rearm(session.id, session.status, blockedUntil, attempts, observed);
          continue;
        }

        if (attempts >= BACKOFF_MS.length) {
          await this.disarm(session.id, session.status, `gave up after ${attempts} attempts`);
          continue;
        }

        const { content, attachmentsOf } = await this.messageToResend(
          session.id,
          session.prompt,
          session.numTurns,
        );
        if (!content) {
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
          },
          data: { retryAt: null, retryAttempts: attempts + 1 },
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
          await this.sessions.resume(session.ownerId, session.id, {
            content,
            attachmentIds,
            clientTurnId: randomUUID(),
          });
        } catch (error) {
          // Nothing was re-sent, so the copies made for it are not history — just bytes. Dropped
          // before anything else in this catch, which has paths that rethrow and paths that end
          // the retry, and would leak a copy of every image on each of them otherwise.
          await this.discardCopies(attachmentIds);
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
            completionPolicy: string; hasDirectChildren: boolean; startsTaskWork: boolean;
          }>>(Prisma.sql`
            SELECT t."terminal_reason" AS "terminalReason",
                   t."superseded_by_task_id" AS "supersededByTaskId",
                   subject."terminal_reason" AS "subjectTerminalReason",
                   subject."superseded_by_task_id" AS "subjectSupersededByTaskId",
                   t."completion_policy"::text AS "completionPolicy",
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
          const aggregateNow = current != null && current.startsTaskWork && isAggregateParent({
            completionPolicy: current.completionPolicy as TaskCompletionPolicyValue,
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
                },
                data: { retryAttempts: attempts },
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
        // The claim above wrote `retry_at = NULL, retry_attempts = spent`; anything else on the row
        // now is somebody else's, and this backoff must not land on top of it.
        await this.rearm(session.id, session.status, new Date(now.getTime() + delay), spent, {
          taskId: session.taskId ?? null,
          startsTaskWork: session.startsTaskWork,
          retryAt: null,
          retryAttempts: spent,
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
   * The message this retry re-sends: the session's latest user message, whole.
   *
   * `attachmentsOf` is the turn that message was sent on, because the words are only half of
   * it — a screenshot the user sent with them is a row hanging off that turn, and a retry that
   * re-sent the text alone asked the model about a picture it was never shown. Null when there
   * is nothing to carry.
   */
  private async messageToResend(
    sessionId: string,
    prompt: string,
    numTurns: number,
  ): Promise<{ content: string; attachmentsOf: string | null }> {
    // The user events themselves, not a tail of the whole stream: the latest one is near the
    // end only on a short turn. One workspace turn emits hundreds of tool/system events after the
    // message that provoked it — 400+ on the sessions that surfaced this — so a fixed window
    // of the end misses the very message a retry exists to re-send, and the session is
    // disarmed as "nothing to re-send" while the card, which reads the entire stream, is still
    // promising it. A handful of events covers a run of image-only turns, which carry no text.
    const recent = await this.prisma.runEvent.findMany({
      where: { sessionId, type: RunEventType.USER },
      orderBy: { seq: 'desc' },
      take: 20,
      select: { type: true, payload: true, turnId: true },
    });
    const events = recent.reverse();
    const content = lastUserMessageText(events, prompt, numTurns);
    if (!content) return { content: '', attachmentsOf: null };
    // The turn THAT message came from — the same event `lastUserMessageText` took the words
    // from, never merely the session's latest turn: pairing this text with a later turn's
    // images would re-send a message the user never wrote.
    const chosen = lastUserMessage(events);
    return {
      content,
      // No user event means the text above is the opening-prompt fallback, which the runner
      // never got to announce. Its uploads are the compose page's, and the claim parked them
      // on the seeded first turn.
      attachmentsOf: chosen ? chosen.turnId : await this.seededTurnId(sessionId),
    };
  }

  /** The turn the opening prompt was seeded as, found by the fixed id both seed paths use. */
  private async seededTurnId(sessionId: string): Promise<string | null> {
    const seed = await this.prisma.conversationTurn.findUnique({
      where: {
        sessionId_clientTurnId: {
          sessionId,
          clientTurnId: SessionsService.initialTurnClientId(sessionId),
        },
      },
      select: { id: true },
    });
    return seed?.id ?? null;
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
  private async copyAttachments(sessionId: string, turnId: string): Promise<string[]> {
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
      await this.prisma.attachment.deleteMany({ where: { id: { in: ids }, turnId: null } });
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
   */
  private async rearm(
    sessionId: string,
    parkedAs: RunStatus,
    at: Date,
    attempts: number,
    expect?: {
      taskId: string | null; startsTaskWork: boolean;
      retryAt: Date | null; retryAttempts: number;
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
            }
          : {}),
      },
      data: { retryAt: at, retryAttempts: attempts },
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
        UPDATE "session" SET "retry_attempts" = ${attempts}, "updated_at" = CURRENT_TIMESTAMP
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
        UPDATE "session" SET "retry_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
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
                   (t."completion_policy"::text <> 'MANUAL'
                    AND EXISTS (SELECT 1 FROM "task" c
                                 WHERE c."parent_task_id" = t."id"
                                   AND c."owner_id" = t."owner_id")) AS "aggregate"
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

  private async disarm(sessionId: string, parkedAs: RunStatus, why: string): Promise<void> {
    const cleared = await this.prisma.session.updateMany({
      where: { id: sessionId, status: parkedAs },
      data: { retryAt: null },
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
