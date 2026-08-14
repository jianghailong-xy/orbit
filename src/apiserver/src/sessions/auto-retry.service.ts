import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import {
  RunEventType,
  lastUserMessageText,
  planUsageBlockedUntil,
  type PlanUsage,
} from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { deriveSessionCapabilities } from './session-state';
import { SessionsService } from './sessions.service';

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
        assignedRunnerId: true,
        status: true,
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

    const released = new Map<string, number>();
    for (const session of due) {
      // Read once: the row is written below, and the failure path must count from what this
      // sweep started with, not from what it has since stored.
      const attempts = session.retryAttempts;
      try {
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
          await this.rearm(session.id, session.status, blockedUntil, attempts);
          continue;
        }

        if (attempts >= BACKOFF_MS.length) {
          await this.disarm(session.id, session.status, `gave up after ${attempts} attempts`);
          continue;
        }

        const content = await this.messageToResend(session.id, session.prompt, session.numTurns);
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
        const claimed = await this.prisma.session.updateMany({
          where: { id: session.id, retryAt: { not: null } },
          data: { retryAt: null, retryAttempts: attempts + 1 },
        });
        if (claimed.count === 0) continue;
        released.set(quotaKey, (released.get(quotaKey) ?? 0) + 1);

        await this.sessions.resume(session.ownerId, session.id, {
          content,
          clientTurnId: randomUUID(),
        });
        this.log.log(`session ${session.id} resumed (retry ${attempts + 1})`);
      } catch (e) {
        // The resume failed (runner gone, session raced into another state). Back off and
        // try again rather than dropping the retry: the message is still unanswered.
        const spent = attempts + 1;
        const delay = BACKOFF_MS[Math.min(spent, BACKOFF_MS.length) - 1];
        await this.rearm(session.id, session.status, new Date(now.getTime() + delay), spent).catch(
          () => {},
        );
        this.log.warn(
          `auto-retry of ${session.id} failed (attempt ${spent}): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  /** The message this retry re-sends: the session's latest user message. */
  private async messageToResend(
    sessionId: string,
    prompt: string,
    numTurns: number,
  ): Promise<string> {
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
      select: { type: true, payload: true },
    });
    return lastUserMessageText(recent.reverse(), prompt, numTurns);
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
  private async rearm(
    sessionId: string,
    parkedAs: RunStatus,
    at: Date,
    attempts: number,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, status: parkedAs },
      data: { retryAt: at, retryAttempts: attempts },
    });
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
  private async disarm(sessionId: string, parkedAs: RunStatus, why: string): Promise<void> {
    const cleared = await this.prisma.session.updateMany({
      where: { id: sessionId, status: parkedAs },
      data: { retryAt: null },
    });
    this.log.warn(`auto-retry of ${sessionId} disarmed: ${why}`);
    if (cleared.count === 0) return;
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
