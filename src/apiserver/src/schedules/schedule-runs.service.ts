/**
 * A schedule's runs (docs/scheduled-tasks-design.md §5–§7): firing due slots, starting runs, watching them, and
 * ending them by a report or a failure. ScheduleWorker drives the four passes; the run report, Run now and Stop
 * this run are the doors S4's tools and REST call.
 *
 * FIRING (§5)
 * ===========
 * One transaction per due schedule, under the per-account lock and the schedule row FOR UPDATE (the order
 * SchedulesService takes them in): the slots from `nextDueAt` up to now are read from the rule; the latest is the
 * one that runs — SCHEDULED when it is on time, CATCH_UP (with its own `plannedAt`) when it is late — and every
 * earlier one is written MISSED; a latest slot older than one period (24 hours for ONCE, one interval for EVERY) is MISSED too. The new run
 * is QUEUED, and an older QUEUED run is SKIPPED, so at most one waits. `nextDueAt` moves to the first slot after now,
 * and a rule with none left ENDS the schedule (END_REACHED). The slot's unique index is the belt to the lock: two
 * workers, or one after a restart, write one run for a slot.
 *
 * STARTING (§6)
 * =============
 * A QUEUED run starts when nothing of its schedule is RUNNING or AWAITING_APPROVAL and its `notBeforeAt` (a retry's
 * wait) has passed. The start checks run first (schedule-start-check.ts); a failure HOLDS the run and the schedule,
 * which then fires nothing until it is resumed. Then the weekly budget (§4): a run that is not MANUAL, on a schedule
 * that already started `envelopeRunsPerWeek` runs planned in the 7 days before its own slot, is MISSED
 * (OVER_BUDGET) and the schedule goes on. A run that passes is marked RUNNING with the id of the session it is
 * about to open, in the same transaction, and the session is opened after it commits with that id, `runSource =
 * SCHEDULE` and `scheduleRunId` set; its first turn is the scheduled-run block and the prompt (schedule-run-block.ts).
 *
 * WATCHING AND ENDING (§6.4, §7)
 * ==============================
 * `schedule_run_report` ends a run, once, from the session serving it. Without one, what the session does decides:
 * an engine that ended, or whose session's phase is IDLE (no SubAgent, `bg_run` job or engine turn executing) with no
 * turn still to answer and nothing set to wake it (a scheduled wake-up, a RESUME_SESSION watch, an armed retry), is
 * NO_REPORT, which (like ENGINE_CRASHED) a report from that session still replaces once a person has written to it
 * (`acceptsLateReport`);
 * a run past its limit is interrupted, RUN_LIMIT; a card nobody
 * answered for two hours interrupts it, APPROVAL_TIMEOUT. Whether the run reached its engine is read from its first
 * turn's `delivered_at`: a run that never did (RUNNER_UNAVAILABLE, QUOTA, ENGINE_CRASHED_BEFORE_START) has its
 * session retired and is retried after 1, 5 and 15 minutes, then hourly, inside its catch-up window, and is MISSED
 * past it (§5.2: a slot not run, not a failure); one that did is never retried. A runner that is offline at the
 * start leaves the run waiting without an attempt. A session a full runner, run or batch holds keeps waiting for a
 * slot, with no 10-minute limit and no new attempt, until the catch-up deadline, then is MISSED (RUNNER_FULL). One run never has two live sessions (`start`, `fail`). `consecutiveFailures` counts
 * and nothing pauses. A NO_CHANGE run's session is completed; CHANGED and FAILED ones stay open.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SCHEDULE_COPY, scheduleFill, RunFailureKind, runFailureIs } from '@orbit/shared';
import { Prisma, type Schedule, type ScheduleRun } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { sessionExecutingOutsideTurnSql } from '../common/session-working';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { openingTurnKey } from '../sessions/orbit-authored-turn';
import { sessionHeldByCapacity } from '../sessions/queued-reason-sql';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import {
  SCHEDULE_NOTIFIER,
  approvalCopy,
  approvalPattern,
  closeScheduleItems,
  failedCopy,
  fileScheduleItem,
  findingCollapseId,
  findingCopy,
  heldCopy,
  onceMissedCopy,
  overBudgetCopy,
  plannedEndCopy,
  reportedLateCopy,
  runReasonText,
  scheduleHomeSession,
  sendAlerts,
  type ScheduleAlert,
  type ScheduleNotifier,
} from './schedule-attention';
import { closeUnknownItems } from '../conditions/condition-attention';
import type { ConditionFiring } from '../conditions/conditions.service';
import { sampleHolds } from '../conditions/condition-evaluation';
import { RUN_BLOCK_MAX_SAMPLES, scheduledRunTurn, type RunBlockFiring } from './schedule-run-block';
import { readRunSessions, releasedByFailure } from './schedule-run-session-reading';
import type { SessionPhaseReading } from '../sessions/session-phase';
import {
  scheduleAgentPressStarts,
  scheduleOverBudget,
  scheduleOverBudgetMessage,
  scheduleRunsStarted,
  scheduleStartCheck,
  type StartPlan,
} from './schedule-start-check';
import { nextDueAt, parseRule, type ScheduleRule } from './schedule-time';
import {
  SCHEDULE_CLOCK,
  SCHEDULE_LOCK_NAMESPACE,
  assertRunSessionScope,
  runSessionScheduleId,
  type ScheduleActor,
} from './schedules.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A retry waits this long after each failed attempt that never reached its engine: at most three retries. */
export const SCHEDULE_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
/** A card nobody answers for this long fails its run (§6.4). */
export const SCHEDULE_APPROVAL_TIMEOUT_MS = 2 * HOUR;
/**
 * A run whose first turn has not reached its engine this long after the start (or after a full runner last held
 * it) never will: RUNNER_UNAVAILABLE. A session a full runner, run or batch holds is not timed by it (§7.2).
 */
export const SCHEDULE_UNDELIVERED_LIMIT_MS = 10 * MINUTE;
/** A slot fired within this of its time is SCHEDULED; later, it is a CATCH_UP. */
export const SCHEDULE_LATE_GRACE_MS = 10 * MINUTE;
/** Catch-up reaches back one period; a ONCE rule's is a day (§5.2). */
export const SCHEDULE_ONCE_CATCH_UP_MS = 24 * HOUR;
/**
 * Once a run that never reached its engine has used its three retries, it waits this long between attempts for as
 * long as its catch-up window lasts (§5.2: the runner, the dispatch or the quota is expected back), then is MISSED.
 */
export const SCHEDULE_RECOVERY_WAIT_MS = HOUR;
/** A run met an offline runner at its start: it looks again this soon, without spending an attempt. */
export const SCHEDULE_RUNNER_WAIT_MS = MINUTE;
/** A run, or a schedule, whose pass threw is left out of the passes for this long, so the rest go ahead. */
export const SCHEDULE_ERROR_COOLDOWN_MS = 5 * MINUTE;
/** Slots one firing reads at most: a year of daily slots, so an outage of any length ends in one pass. */
const MAX_SLOTS_PER_FIRING = 400;

/** §7.2's closed set. */
export type ScheduleFailureReason =
  | 'RUNNER_UNAVAILABLE'
  | 'RUNNER_FULL'
  | 'QUOTA'
  | 'ENGINE_CRASHED_BEFORE_START'
  | 'REPORTED_FAILED'
  | 'NO_REPORT'
  | 'ENGINE_CRASHED'
  | 'APPROVAL_TIMEOUT'
  | 'RUN_LIMIT'
  | 'CANCELLED_BY_OWNER'
  | 'LANDING_FAILED';

/** The reasons of a run that never reached its engine: the only ones retried. */
export const RETRIED_FAILURES: ReadonlySet<ScheduleFailureReason> = new Set([
  'RUNNER_UNAVAILABLE',
  // Only ever written past the catch-up deadline, so it settles as MISSED (or CANCELLED / SKIPPED), never a retry.
  'RUNNER_FULL',
  'QUOTA',
  'ENGINE_CRASHED_BEFORE_START',
]);

export type ScheduleReportOutcome = 'NO_CHANGE' | 'CHANGED' | 'FAILED';

export interface ScheduleRunReport {
  outcome: ScheduleReportOutcome;
  key?: string | null;
  summary: string;
  links?: string[];
  /** Replaces the schedule's note; null clears it; omitted keeps it. */
  note?: string | null;
}

/** What the run's session is opened with. */
export interface OpenRunSession {
  ownerId: string;
  sessionId: string;
  scheduleRunId: string;
  workspaceId: string;
  title: string;
  prompt: string;
  permissionMode: string;
  /** CHECK_ONLY runs need no worktree (§6.2). */
  noWorktree: boolean;
  engine: string | null;
  provider: string | null;
}

/** The session doors a run needs, so the passes can be driven in a spec without a runner. */
export interface ScheduleRunSessionPort {
  open(input: OpenRunSession): Promise<void>;
  /** Queue the ordinary Merge-to-main path, including its merge check. */
  land(ownerId: string, sessionId: string): Promise<void>;
  interrupt(ownerId: string, sessionId: string): Promise<void>;
  complete(ownerId: string, sessionId: string): Promise<void>;
  /** Retire the session: no auto-retry, ended; one already ended or never written counts as retired. */
  end(ownerId: string, sessionId: string): Promise<void>;
}

export const SCHEDULE_RUN_SESSIONS = Symbol('SCHEDULE_RUN_SESSIONS');

/** Where a run's session stands, as its history shows it (§7.4). */
export interface RunSessionView {
  id: string;
  state: 'OPEN' | 'COMPLETED' | 'TRASH' | 'GONE';
}

export type FireOutcome = 'FIRED' | 'MISSED' | 'SETTLED_ELSEWHERE';
/** How a failure was settled: retried, waiting, MISSED, CANCELLED (its schedule paused), SKIPPED or FAILED. */
export type FailOutcome = 'RETRY' | 'FAILED' | 'MISSED' | 'CANCELLED' | 'SKIPPED';
export type StartOutcome = 'STARTED' | 'HELD' | 'WAITING' | 'SETTLED_ELSEWHERE' | FailOutcome;
export type ReconcileOutcome =
  | 'UNCHANGED'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'SETTLED_ELSEWHERE'
  /** The run's session could not be retired yet: the run is left as it was for the next pass. */
  | 'DEFERRED'
  | FailOutcome;

/**
 * A run's session that may still run (§7.2: one run never has two live sessions), read from the session's published
 * state (schedule-run-session-reading.ts): held, whatever it is doing, an end still to be honoured included; or
 * released with something that will revive it (an armed retry, a wake-up on a failure release). A released one that
 * a wake-up would revive cannot be retired by an end, which a released session swallows: the start waits until the
 * wake-up revives it, and the next pass retires it then. A stray is the session of a run that never reached its
 * engine, so no agent ever ran there to ask for one.
 */
function mayStillRun(session: SessionPhaseReading): boolean {
  return !session.fields.released || session.wakes;
}

type Tx = Prisma.TransactionClient;

/**
 * §7.1: the failures the server inferred from the run's session, which a late report from that session may replace.
 * RUN_LIMIT, APPROVAL_TIMEOUT and the owner's stop end the run on purpose and stay final.
 */
/**
 * §7.1: how long a delivered run's session must read idle, with nothing executing, queued or set to wake it, before
 * the run is failed NO_REPORT. A job's end reaches the session a moment before the wake it files; four watch passes
 * cover that gap many times over and cost a run that really ended without a report a minute.
 */
export const SCHEDULE_IDLE_SETTLE_MS = 60_000;

const LATE_REPORT_FAILURES: ReadonlySet<string> = new Set<ScheduleFailureReason>(['NO_REPORT', 'ENGINE_CRASHED']);

const IN_PROGRESS = ['RUNNING', 'AWAITING_APPROVAL'] as const;

/**
 * A run that is not over yet, as §8.5's planned-end push waits for it: waiting (QUEUED, a retry's wait included), under
 * way, or reported on a LAND schedule and still landing, whose landing may yet fail it (LANDING_FAILED).
 */
const RUN_NOT_OVER = {
  OR: [{ state: { in: ['QUEUED', ...IN_PROGRESS] } }, { landingStatus: { in: ['WAITING', 'MERGING'] } }],
} satisfies Prisma.ScheduleRunWhereInput;

function refusal(kind: 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND', code: string, message: string): Error {
  const body = { code, message };
  if (kind === 'BAD_REQUEST') return new BadRequestException(body);
  if (kind === 'CONFLICT') return new ConflictException(body);
  if (kind === 'FORBIDDEN') return new ForbiddenException(body);
  return new NotFoundException(body);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long cards kept a session waiting: the union of each card's open interval, up to now. */
export function waitedOnCards(cards: Array<{ createdAt: Date; decidedAt: Date | null; status: string }>, now: Date): number {
  let waited = 0;
  let reach = -Infinity;
  for (const c of [...cards].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const from = Math.max(c.createdAt.getTime(), reach);
    const to = c.status === 'PENDING' ? now.getTime() : (c.decidedAt ?? c.createdAt).getTime();
    if (to > from) waited += to - from;
    reach = Math.max(reach, to);
  }
  return waited;
}

/** How far back a slot may still be caught up, or retried: one period of its rule. */
export function catchUpWindowMs(rule: ScheduleRule, timezone: string, slot: Date): number {
  // A WHEN run's slot is its firing: like a ONCE slot, it may start for a day, and is MISSED after.
  if (rule.kind === 'ONCE' || rule.kind === 'WHEN') return SCHEDULE_ONCE_CATCH_UP_MS;
  // An EVERY rule's period is its interval, also for a day's last slot, whose next one is the next morning.
  if (rule.kind === 'EVERY') return rule.minutes * MINUTE;
  const next = nextDueAt(rule, timezone, slot);
  return next ? next.getTime() - slot.getTime() : 7 * 24 * HOUR;
}

/** The last instant a run's slot may still start: its plannedAt plus one period of its rule (§5.2). */
export function scheduleRunDeadline(schedule: Pick<Schedule, 'rule' | 'timezone'>, run: Pick<ScheduleRun, 'plannedAt'>): number {
  try {
    return run.plannedAt.getTime() + catchUpWindowMs(parseRule(schedule.rule), schedule.timezone, run.plannedAt);
  } catch {
    // A rule that no longer reads is what can make a start throw on every pass: a day, as for ONCE.
    return run.plannedAt.getTime() + SCHEDULE_ONCE_CATCH_UP_MS;
  }
}

@Injectable()
export class ScheduleRunsService {
  private readonly logger = new Logger(ScheduleRunsService.name);
  private readonly clock: () => Date;
  /** Schedules and runs whose last pass threw, until when they are left out (SCHEDULE_ERROR_COOLDOWN_MS). */
  private readonly cooling = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCHEDULE_RUN_SESSIONS) private readonly sessions: ScheduleRunSessionPort,
    @Optional() @Inject(SCHEDULE_CLOCK) clock?: () => Date,
    /** Who hears (§7.3). Absent, the rows are written and nothing is pushed. */
    @Optional() @Inject(SCHEDULE_NOTIFIER) private readonly notifier?: ScheduleNotifier,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  private async alert(alerts: readonly ScheduleAlert[]): Promise<void> {
    await sendAlerts(this.notifier, alerts, (m) => this.logger.warn(m));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Firing (§5)
  // -------------------------------------------------------------------------------------------------------------

  /** Fire up to `batch` due schedules, the longest-due first. */
  async fireDue(batch = 25): Promise<Array<{ scheduleId: string; outcome: FireOutcome }>> {
    const due = await this.prisma.schedule.findMany({
      where: { state: 'ACTIVE', nextDueAt: { lte: this.clock() }, id: { notIn: this.cooled() } },
      orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ scheduleId: string; outcome: FireOutcome }> = [];
    for (const { id } of due) {
      try {
        outcomes.push({ scheduleId: id, outcome: await this.fire(id) });
      } catch (error) {
        this.coolDown(id);
        this.logger.error(`schedule ${id} did not fire: ${messageOf(error)}`);
      }
    }
    return outcomes;
  }

  /** Fire one schedule's due slots, in one transaction. */
  async fire(scheduleId: string): Promise<FireOutcome> {
    const alerts: ScheduleAlert[] = [];
    const fired = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        const schedule = await this.lock(tx, scheduleId);
        const now = this.clock();
        if (!schedule || schedule.state !== 'ACTIVE' || !schedule.nextDueAt || schedule.nextDueAt > now) {
          return 'SETTLED_ELSEWHERE' as const;
        }
        const rule = parseRule(schedule.rule);
        const window = { startAt: schedule.startAt, endAt: schedule.endAt };
        const slots = [schedule.nextDueAt];
        for (let t = schedule.nextDueAt; slots.length < MAX_SLOTS_PER_FIRING; ) {
          const n = nextDueAt(rule, schedule.timezone, t, window);
          if (!n || n > now) break;
          slots.push(n);
          t = n;
        }
        const latest = slots[slots.length - 1];
        const caughtUp = now.getTime() - latest.getTime() <= catchUpWindowMs(rule, schedule.timezone, latest);
        const missed = caughtUp ? slots.slice(0, -1) : slots;
        for (const slot of missed) {
          const id = await this.insertSlotRun(tx, schedule, slot, 'SCHEDULED', 'MISSED', now);
          if (id && rule.kind === 'ONCE') alerts.push(this.onceMissed(schedule, id));
        }
        let outcome: FireOutcome = 'MISSED';
        if (caughtUp) {
          const trigger = now.getTime() - latest.getTime() <= SCHEDULE_LATE_GRACE_MS ? 'SCHEDULED' : 'CATCH_UP';
          const taken = await tx.scheduleRun.findFirst({
            where: { scheduleId, plannedAt: latest, trigger: { in: ['SCHEDULED', 'CATCH_UP'] } },
            select: { id: true },
          });
          if (taken) {
            outcome = 'SETTLED_ELSEWHERE';
          } else {
            await this.skipQueued(tx, scheduleId, now);
            const id = await this.insertSlotRun(tx, schedule, latest, trigger, 'QUEUED', null);
            outcome = id ? 'FIRED' : 'SETTLED_ELSEWHERE';
          }
        }
        const next = nextDueAt(rule, schedule.timezone, now, window);
        await tx.schedule.update({
          where: { id: scheduleId },
          data: next
            ? { nextDueAt: next }
            : { nextDueAt: null, state: 'ENDED', endedReason: 'END_REACHED', endedAt: now },
        });
        return outcome;
      },
      loggedRetry(this.logger, 'scheduleRuns.fire'),
    );
    await this.alert(alerts);
    return fired;
  }

  /**
   * A WHEN schedule's condition fired (docs/condition-triggers-design.md §5.2), inside the transaction that fired it,
   * which holds the condition's row lock: one firing, one run. The run is CONDITION, planned at the firing sample's
   * time, QUEUED under the overlap rule; from there it is any run's — the start checks, the weekly budget (a firing
   * over it is MISSED OVER_BUDGET at its start), the report, findings and who hears. A schedule that is not ACTIVE
   * (HELD) starts nothing, as a held schedule fires no slot; the condition waits for its re-arm either way. Returns the
   * run's id, written on the FIRED event, or null.
   */
  async fireCondition(tx: Tx, firing: ConditionFiring): Promise<string | null> {
    const scheduleId = firing.condition.scheduleId;
    if (!scheduleId) return null;
    const schedule = await this.lock(tx, scheduleId);
    if (!schedule || schedule.state !== 'ACTIVE') return null;
    const rule = schedule.rule as unknown as ScheduleRule;
    if (rule.kind !== 'WHEN' || rule.conditionId !== firing.condition.id) return null;
    await this.skipQueued(tx, scheduleId, this.clock());
    const id = randomUUID();
    await tx.scheduleRun.create({
      data: {
        id, scheduleId, scheduleRevision: schedule.revision, plannedAt: firing.at, trigger: 'CONDITION', state: 'QUEUED',
      },
    });
    await tx.conditionEvent.update({ where: { id: firing.eventId }, data: { runId: id } });
    return id;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Starting (§6)
  // -------------------------------------------------------------------------------------------------------------

  /** Start the QUEUED runs that may start now: nothing of theirs in progress, and their wait over. */
  async startDue(batch = 25, scheduleId?: string): Promise<Array<{ runId: string; outcome: StartOutcome }>> {
    const now = this.clock();
    const queued = await this.prisma.scheduleRun.findMany({
      where: {
        state: 'QUEUED',
        ...(scheduleId ? { scheduleId } : {}),
        OR: [{ notBeforeAt: null }, { notBeforeAt: { lte: now } }],
        schedule: { runs: { none: { state: { in: [...IN_PROGRESS] } } } },
      },
      orderBy: [{ plannedAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ runId: string; outcome: StartOutcome }> = [];
    for (const { id } of queued) {
      try {
        outcomes.push({ runId: id, outcome: await this.start(id) });
      } catch (error) {
        this.logger.error(`schedule run ${id} did not start: ${messageOf(error)}`);
        await this.deferAfterError(id);
      }
    }
    return outcomes;
  }

  /**
   * Start one QUEUED run: the checks, then RUNNING and its session.
   *
   * One run never has two live sessions. A session an earlier attempt left alive (a process that died between
   * re-queueing a run and retiring its session, or a create that committed after its caller gave up) is found by
   * `scheduleRunId` under the schedule lock and retired before a new one is opened; one that cannot be retired
   * holds the start back. A create that fails after its INSERT committed keeps that session as the run's.
   */
  async start(runId: string, retiredStrays = false): Promise<StartOutcome> {
    const step = await withTransactionRetry(
      this.prisma,
      async (tx): Promise<{
        outcome: StartOutcome;
        open?: OpenRunSession;
        strays?: Array<{ id: string; ownerId: string }>;
        alerts?: ScheduleAlert[];
      }> => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        if (!head) return { outcome: 'SETTLED_ELSEWHERE' };
        const schedule = await this.lock(tx, head.scheduleId);
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        const now = this.clock();
        if (!schedule || !run || run.state !== 'QUEUED') return { outcome: 'SETTLED_ELSEWHERE' };
        if (run.notBeforeAt && run.notBeforeAt > now) return { outcome: 'WAITING' };
        const busy = await tx.scheduleRun.count({ where: { scheduleId: schedule.id, state: { in: [...IN_PROGRESS] } } });
        if (busy > 0) return { outcome: 'WAITING' };
        if (
          (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED')
          || (schedule.state === 'PAUSED' && run.trigger !== 'MANUAL')
        ) {
          // §8.4: pausing or deleting cancels the run waiting; a retry put back after the pause is that run too.
          await tx.scheduleRun.update({ where: { id: runId }, data: { state: 'CANCELLED', endedAt: now, notBeforeAt: null } });
          return { outcome: 'CANCELLED' };
        }
        if (schedule.state === 'HELD') {
          await this.holdRun(tx, run, schedule.heldReason ?? 'HELD', now);
          return { outcome: 'HELD' };
        }
        if (schedule.maxRuns !== null && (await scheduleRunsStarted(tx, schedule.id)) >= schedule.maxRuns) {
          // §8.5: the planned end by count is reached; nothing starts past it.
          await tx.scheduleRun.update({ where: { id: runId }, data: { state: 'CANCELLED', endedAt: now, notBeforeAt: null } });
          return { outcome: 'CANCELLED' };
        }
        // Computed under the lock, so a session another replica opens for this run after this commits is never one.
        const named = await tx.session.findMany({ where: { scheduleRunId: runId }, select: { id: true, ownerId: true } });
        const readings = await readRunSessions(tx, named.map((session) => session.id));
        const strays = named.filter((session) => {
          const reading = readings.get(session.id);
          return reading !== undefined && mayStillRun(reading);
        });
        if (strays.length > 0) return { outcome: 'WAITING', strays };
        const check = await scheduleStartCheck(tx, schedule);
        if (!check.ok) {
          await this.holdRun(tx, run, check.reason, now);
          const alerts: ScheduleAlert[] = [];
          if (schedule.state !== 'ENDED') {
            await tx.schedule.update({
              where: { id: schedule.id },
              data: { state: 'HELD', heldReason: check.reason, nextDueAt: null },
            });
            await this.fileHeld(tx, schedule, run, check.reason, alerts);
          }
          return { outcome: 'HELD', alerts };
        }
        // §4: the envelope's runs per week bound the automatic runs that start, not only the rule, counted on the
        // slots they were planned for. A slot over budget is MISSED (OVER_BUDGET) and the schedule goes on. A MANUAL
        // run was checked when it was pressed (runNow), and no Run now counts here.
        if (run.trigger !== 'MANUAL' && (await scheduleOverBudget(tx, schedule, run.plannedAt))) {
          return { outcome: 'MISSED', alerts: await this.missOverBudget(tx, schedule, run, now) };
        }
        const workspace = await tx.workspace.findUnique({
          where: { id: schedule.workspaceId },
          select: { runner: { select: { status: true, ...RUNNER_BEATS, managedRunner: { select: { id: true } } } } },
        });
        // §5.2: a runner that is not there is a slot missed, not a failure. The run waits, without spending an
        // attempt, and starts once the runner is back inside its catch-up window; past it, it is MISSED. A managed
        // runner asleep is not absent: opening the session wakes it (SessionsService.create).
        const runner = workspace?.runner;
        if (!runner?.managedRunner && !runnerIsOnline(runner, now.getTime())) {
          if (now.getTime() > this.deadline(schedule, run)) {
            await tx.scheduleRun.update({
              where: { id: runId },
              data: { state: 'MISSED', failureReason: 'RUNNER_UNAVAILABLE', endedAt: now, notBeforeAt: null },
            });
            return { outcome: 'MISSED', alerts: this.onceMissedIf(schedule, run) };
          }
          await tx.scheduleRun.update({
            where: { id: runId },
            data: { notBeforeAt: new Date(now.getTime() + SCHEDULE_RUNNER_WAIT_MS), failureReason: 'RUNNER_UNAVAILABLE' },
          });
          return { outcome: 'WAITING' };
        }
        const sessionId = randomUUID();
        const prompt = await this.firstTurn(tx, schedule, run, now);
        await tx.scheduleRun.update({
          where: { id: runId },
          // The level the run starts with is the one its session is held to (schedule-access.ts runAccessLevel).
          data: { state: 'RUNNING', startedAt: now, sessionId, notBeforeAt: null, accessLevel: schedule.accessLevel },
        });
        // §8.5: the start that reaches maxRuns ends the schedule, in this transaction and under the lock the count was
        // read under. The run itself goes on.
        if (schedule.maxRuns !== null && schedule.state !== 'ENDED' && (await scheduleRunsStarted(tx, schedule.id)) >= schedule.maxRuns) {
          await this.endAtMaxRuns(tx, schedule, now);
        }
        return { outcome: 'STARTED', open: this.openInput(schedule, run, sessionId, prompt, check.plan) };
      },
      loggedRetry(this.logger, 'scheduleRuns.start'),
    );
    if (step.alerts) await this.alert(step.alerts);
    if (step.strays) {
      for (const stray of step.strays) {
        try {
          await this.sessions.end(stray.ownerId, stray.id);
        } catch (error) {
          this.logger.warn(`run ${runId} waits: its earlier session ${stray.id} could not be retired: ${messageOf(error)}`);
          return 'WAITING';
        }
      }
      return retiredStrays ? 'WAITING' : this.start(runId, true);
    }
    if (!step.open) return step.outcome;
    try {
      await this.sessions.open(step.open);
      return 'STARTED';
    } catch (error) {
      this.logger.warn(`run ${runId} could not open its session: ${messageOf(error)}`);
      // A create that threw after its INSERT committed (it wakes a managed runner afterwards) did open the
      // session: it is the run's, and the watch pass reads it like any other.
      const opened = await this.prisma.session.findUnique({ where: { id: step.open.sessionId }, select: { id: true } });
      if (opened) return 'STARTED';
      // Refused before anything was written: the request itself cannot be served, which a retry will not change.
      if (error instanceof HttpException && error.getStatus() < 500) {
        return this.holdRefused(runId, step.open.sessionId);
      }
      const failed = await this.fail(runId, 'RUNNER_UNAVAILABLE', { sessionId: step.open.sessionId });
      return failed === 'DEFERRED' ? 'WAITING' : failed;
    }
  }

  /** A create door refused the run's session: the run and its schedule are HELD (SESSION_REFUSED) for the owner. */
  private async holdRefused(runId: string, sessionId: string): Promise<StartOutcome> {
    const alerts: ScheduleAlert[] = [];
    const outcome = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        if (!schedule || !run || run.state !== 'RUNNING' || run.sessionId !== sessionId) return 'SETTLED_ELSEWHERE' as const;
        const now = this.clock();
        await this.holdRun(tx, run, 'SESSION_REFUSED', now);
        if (schedule.state !== 'ENDED') {
          await tx.schedule.update({
            where: { id: schedule.id },
            data: { state: 'HELD', heldReason: 'SESSION_REFUSED', nextDueAt: null },
          });
          await this.fileHeld(tx, schedule, run, 'SESSION_REFUSED', alerts);
        }
        return 'HELD' as const;
      },
      loggedRetry(this.logger, 'scheduleRuns.holdRefused'),
    );
    await this.alert(alerts);
    return outcome;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Watching (§6.4, §7.1, §7.2)
  // -------------------------------------------------------------------------------------------------------------

  /** Read every run in progress against its session, and end the ones whose session says they are over. */
  async reconcile(batch = 100): Promise<Array<{ runId: string; outcome: ReconcileOutcome }>> {
    const runs = await this.prisma.scheduleRun.findMany({
      where: { state: { in: [...IN_PROGRESS] }, id: { notIn: this.cooled() } },
      orderBy: { startedAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    const outcomes: Array<{ runId: string; outcome: ReconcileOutcome }> = [];
    for (const { id } of runs) {
      try {
        outcomes.push({ runId: id, outcome: await this.reconcileRun(id) });
      } catch (error) {
        this.coolDown(id);
        this.logger.error(`schedule run ${id} was not reconciled: ${messageOf(error)}`);
      }
    }
    return outcomes;
  }

  async reconcileRun(runId: string): Promise<ReconcileOutcome> {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      include: {
        schedule: {
          select: {
            runLimitMinutes: true, ownerId: true, rule: true, timezone: true, state: true, endedReason: true,
          },
        },
      },
    });
    if (!run || (run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL')) return 'SETTLED_ELSEWHERE';
    const now = this.clock();
    const startedAt = run.startedAt ?? now;
    const sessionId = run.sessionId;
    const session = sessionId ? (await readRunSessions(this.prisma, [sessionId])).get(sessionId) ?? null : null;
    if (!session || !sessionId) {
      // The start committed and its session never followed: the process that was to open it died between the two.
      if (now.getTime() - startedAt.getTime() >= SCHEDULE_UNDELIVERED_LIMIT_MS) {
        return this.fail(runId, 'ENGINE_CRASHED_BEFORE_START', { sessionId });
      }
      return 'UNCHANGED';
    }
    const opening = await this.prisma.conversationTurn.findFirst({
      where: { sessionId, clientTurnId: openingTurnKey(sessionId) },
      select: { deliveredAt: true, status: true },
    });
    const deliveredAt = opening?.deliveredAt ?? null;
    const delivered = deliveredAt !== null;

    // Released before its first turn reached the engine: the run never started, and it is retried in a fresh session
    // now, whatever might revive this one. By a failure it is QUOTA or ENGINE_CRASHED_BEFORE_START, named from the
    // failure the session recorded (only the label, once the reading has decided); any other release (a retire that
    // committed before its re-queue did, among others) is retried like a run that met no runner.
    if (!delivered && session.fields.released) {
      if (!releasedByFailure(session.fields)) return this.fail(runId, 'RUNNER_UNAVAILABLE', { sessionId });
      const failure = await this.prisma.session.findUnique({
        where: { id: sessionId }, select: { error: true, failureKind: true },
      });
      const quota = failure != null && runFailureIs(failure, [RunFailureKind.USAGE_LIMIT]);
      return this.fail(runId, quota ? 'QUOTA' : 'ENGINE_CRASHED_BEFORE_START', { sessionId });
    }
    // Released after delivery, with nothing to revive it. An end that was asked for, or one asked for and not honoured,
    // counts only once the session is released (the reaper's end_not_honored release bounds the wait): until then the
    // session reads as what it is doing.
    if (session.reading === 'FAILED') return this.fail(runId, 'ENGINE_CRASHED', { sessionId });
    if (session.reading === 'ENDED') return this.fail(runId, 'NO_REPORT', { sessionId });

    if (!delivered) {
      // §7.2: a full runner, run or batch is not a runner that is not coming. The session keeps its place in the
      // queue until a slot frees, however long that takes, up to the slot's catch-up deadline; past it the slot is
      // MISSED (RUNNER_FULL). A schedule paused (a MANUAL run aside), held or deleted retires it now, as a retry
      // would have been.
      if (await sessionHeldByCapacity(this.prisma, sessionId)) {
        const schedule = run.schedule;
        const stopped = schedule.state === 'HELD'
          || (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED')
          || (schedule.state === 'PAUSED' && run.trigger !== 'MANUAL');
        if (stopped || now.getTime() > this.deadline(schedule, run)) {
          return this.fail(runId, 'RUNNER_FULL', { sessionId });
        }
        return this.noteCapacityHeld(runId, sessionId, now);
      }
      // Held by nothing the server can name: the runner is not taking it. Counted from the start, or from the last
      // time a full runner held it, so a slot that has just freed is given the same 10 minutes to be claimed.
      const since = Math.max(startedAt.getTime(), run.capacityHeldAt?.getTime() ?? 0);
      if (now.getTime() - since >= SCHEDULE_UNDELIVERED_LIMIT_MS) {
        return this.fail(runId, 'RUNNER_UNAVAILABLE', { sessionId });
      }
      return 'UNCHANGED';
    }
    const cards = await this.prisma.approval.findMany({
      where: { sessionId, createdAt: { gte: deliveredAt } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, decidedAt: true, status: true },
    });
    // The limit is the engine's working time: time spent waiting on a person's card is not the run's to spend, or a
    // two-hour card could never time out under a run limit of at most two hours (§12).
    const working = now.getTime() - deliveredAt.getTime() - waitedOnCards(cards, now);
    if (working >= run.schedule.runLimitMinutes * MINUTE) {
      return this.fail(runId, 'RUN_LIMIT', { sessionId, interrupt: true });
    }
    const card = cards.find((c) => c.status === 'PENDING')
      ?? await this.prisma.approval.findFirst({
        where: { sessionId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, decidedAt: true, status: true },
      });
    if (card && now.getTime() - card.createdAt.getTime() >= SCHEDULE_APPROVAL_TIMEOUT_MS) {
      return this.fail(runId, 'APPROVAL_TIMEOUT', { sessionId, interrupt: true });
    }
    // §6.4: each card the run stopped at waits in Waiting on you until it is answered; an answered one leaves it.
    const filed = card ? 1 : await this.prisma.ownerRequest.count({
      where: { scheduleRunId: runId, kind: 'SCHEDULE_APPROVAL', state: 'PENDING' },
    });
    if (filed > 0 && !(await this.syncApprovalItems(runId, sessionId))) return 'SETTLED_ELSEWHERE';
    // Idle is not finished while the run still has work coming back to it, which the reading says
    // (schedule-run-session-reading.ts): WORKING while anything executes for it (a turn, the engine's own turn, a
    // SubAgent, a `bg_run` job silent or not) or a turn is queued, WILL_WAKE while a `schedule_wakeup`, the watch a
    // `task_await` or `session_await` leaves, or an armed retry will give it one. Its working time still counts
    // toward RUN_LIMIT above. A job's end is reported a moment before the wake it files, so IDLE fails the run only
    // once it has read so for SCHEDULE_IDLE_SETTLE_MS (`idleSeenAt`).
    const idle = !card && session.reading === 'IDLE' && opening?.status === 'ANSWERED';
    if (idle && run.idleSeenAt && now.getTime() - run.idleSeenAt.getTime() >= SCHEDULE_IDLE_SETTLE_MS) {
      return this.fail(runId, 'NO_REPORT', { sessionId });
    }
    if (idle !== (run.idleSeenAt !== null)) await this.noteIdle(runId, sessionId, idle ? now : null);
    if (idle) return 'UNCHANGED';
    if (card) {
      if (run.state === 'RUNNING') return this.moveInProgress(runId, 'RUNNING', 'AWAITING_APPROVAL');
      return 'UNCHANGED';
    }
    if (run.state === 'AWAITING_APPROVAL') return this.moveInProgress(runId, 'AWAITING_APPROVAL', 'RUNNING');
    return 'UNCHANGED';
  }

  /** The run's session read idle with nothing to wake it since `at`, or (null) it no longer does (§7.1). */
  private async noteIdle(runId: string, sessionId: string, at: Date | null): Promise<void> {
    await this.prisma.scheduleRun.updateMany({
      where: { id: runId, sessionId, state: { in: [...IN_PROGRESS] } },
      data: { idleSeenAt: at },
    });
  }

  /** A full runner holds the run's session: when it was last seen so, for the 10-minute limit once it no longer is. */
  private async noteCapacityHeld(runId: string, sessionId: string, now: Date): Promise<'UNCHANGED'> {
    await this.prisma.scheduleRun.updateMany({
      where: { id: runId, sessionId, state: 'RUNNING' },
      data: { capacityHeldAt: now },
    });
    return 'UNCHANGED';
  }

  /** LAND reports wait for the turn, then use the owner's merge path and its durable receipt. */
  async landReportedRuns(batch = 25): Promise<void> {
    const pending = await this.prisma.scheduleRun.findMany({
      where: { accessLevel: 'LAND', state: { in: ['CHANGED', 'NO_CHANGE'] }, landingStatus: { in: ['WAITING', 'MERGING'] } },
      orderBy: { endedAt: 'asc' }, take: batch,
    });
    for (const run of pending) {
      try {
        await this.landRun(run);
      } catch (error) {
        this.logger.error(`schedule run ${run.id} landing pass failed: ${messageOf(error)}`);
      }
    }
  }

  private async landRun(run: ScheduleRun): Promise<void> {
    // The session row for its merge facts (branch, base, merge status); what it is doing comes from its published
    // state alone (schedule-run-session-reading.ts).
    const session = run.sessionId ? await this.prisma.session.findUnique({ where: { id: run.sessionId } }) : null;
    const state = session ? (await readRunSessions(this.prisma, [session.id])).get(session.id) : undefined;
    // Released for anything but its work finishing (decision D5, design §12.3: the end reason, never the terminal
    // status), an engine that exited by itself included, or an end somebody asked for (Complete, Trash, End: its
    // reason is written with the request), is a run that ended unsuccessfully. A run the owner stopped mid-turn after
    // it reported still lands: the report stands, and the commits are its (owner decision 2026-11-26).
    if (!session || !state
        || ((state.fields.released || state.fields.endReason !== null) && !state.fields.workFinished)) {
      await this.settleLanding(run.id, 'FAILED', null, 'The run session ended unsuccessfully; nothing was landed.');
      return;
    }
    // The tool reports during the turn. A commit and its final worktree report may still be on the way while anything
    // executes for the session (a turn, the engine's own, a SubAgent, a background job) or a turn is queued. The
    // worker's next pass looks again; the run limit bounds the wait. A watch or wake-up left behind after the report
    // does not hold it: the report said the work is done.
    if (state.reading === 'WORKING') {
      // Reporting does not exempt the rest of a LAND run from its run limit.
      const opening = await this.prisma.conversationTurn.findFirst({
        where: { sessionId: session.id, clientTurnId: openingTurnKey(session.id) }, select: { deliveredAt: true },
      });
      if (opening?.deliveredAt) {
        const schedule = await this.prisma.schedule.findUniqueOrThrow({ where: { id: run.scheduleId } });
        const cards = await this.prisma.approval.findMany({ where: { sessionId: session.id, createdAt: { gte: opening.deliveredAt } } });
        const now = this.clock();
        const working = now.getTime() - opening.deliveredAt.getTime() - waitedOnCards(cards, now);
        if (working >= schedule.runLimitMinutes * MINUTE) {
          await this.sessions.interrupt(session.ownerId, session.id);
          await this.settleLanding(run.id, 'FAILED', null, 'The run exceeded its working-time limit after reporting.', 'RUN_LIMIT');
        }
      }
      return;
    }
    if (!session.branchSha || !session.baseSha) {
      await this.settleLanding(run.id, 'FAILED', null, 'The runner did not report the branch and base commits.');
      return;
    }
    const receipt = await this.prisma.sessionMergeReceipt.findFirst({
      where: { ownerId: session.ownerId, sessionId: session.id, sourceSha: session.branchSha,
        targetBranch: 'main', result: { in: ['MERGED', 'ALREADY_MERGED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (receipt?.targetShaAfter) {
      await this.settleLanding(run.id, 'LANDED', receipt.targetShaAfter);
      return;
    }
    if (session.branchSha === session.baseSha) {
      await this.settleLanding(run.id, 'NO_COMMITS');
      return;
    }
    if (session.mergeStatus === 'pending') {
      await this.settleLanding(run.id, 'MERGING');
      return;
    }
    if (session.mergeStatus === 'error' || session.mergeStatus === 'conflict') {
      await this.settleLanding(run.id, 'FAILED', null, session.mergeError ?? 'The merge check refused the landing.');
      return;
    }
    try {
      await this.sessions.land(session.ownerId, session.id);
    } catch (error) {
      await this.settleLanding(run.id, 'FAILED', null, messageOf(error));
      return;
    }
    // Replaying after a crash queues the same session operation; mergeToMain is idempotent while pending.
    await this.settleLanding(run.id, 'MERGING');
  }

  private async settleLanding(
    runId: string, status: 'MERGING' | 'LANDED' | 'NO_COMMITS' | 'FAILED', sha: string | null = null, reason?: string,
    failureReason: ScheduleFailureReason = 'LANDING_FAILED',
  ): Promise<void> {
    const alerts: ScheduleAlert[] = [];
    await withTransactionRetry(this.prisma, async (tx) => {
      alerts.length = 0;
      const ref = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
      if (!ref) return;
      const schedule = await this.lock(tx, ref.scheduleId);
      const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
      if (!schedule || !run || (run.state !== 'CHANGED' && run.state !== 'NO_CHANGE')
          || (run.landingStatus !== 'WAITING' && run.landingStatus !== 'MERGING')) return;
      const failed = status === 'FAILED';
      const suffix = status === 'LANDED' ? scheduleFill(SCHEDULE_COPY.landing.landed, { sha: sha! })
        : failed ? scheduleFill(SCHEDULE_COPY.landing.failed, { reason: reason! }) : null;
      const summary = suffix ? `${run.summary ?? ''}\n${suffix}`.trim() : run.summary;
      await tx.scheduleRun.update({ where: { id: runId }, data: {
        landingStatus: status, landedSha: sha, summary,
        ...(failed ? { state: 'FAILED', failureReason } : {}),
      } });
      if (status !== 'MERGING') {
        await tx.schedule.update({ where: { id: schedule.id }, data: { consecutiveFailures: failed ? { increment: 1 } : 0 } });
        await this.settleItems(tx, schedule, run, failed ? 'FAILED' : 'SUCCEEDED', this.clock(), alerts, {
          reason: failureReason, summary: reason ?? null, consecutiveFailures: failed ? schedule.consecutiveFailures + 1 : 0,
        });
      }
    }, loggedRetry(this.logger, 'scheduleRuns.settleLanding'));
    await this.alert(alerts);
  }

  /**
   * §8.5's one push, "Stopped as planned after N runs", for each schedule ENDED (END_REACHED) by its endAt or maxRuns
   * once no run of it is waiting, under way or still landing, so the last run's own push comes first. `plannedEndToldAt`,
   * set under the schedule lock in the transaction that decides the push, keeps it to one. A ONCE rule, whose end is
   * its only slot, is marked told and sends none.
   */
  async tellPlannedEnds(batch = 25): Promise<string[]> {
    const ended = await this.prisma.schedule.findMany({
      where: { state: 'ENDED', endedReason: 'END_REACHED', plannedEndToldAt: null, runs: { none: RUN_NOT_OVER } },
      orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true },
    });
    const told: string[] = [];
    for (const { id } of ended) {
      const alerts: ScheduleAlert[] = [];
      try {
        await withTransactionRetry(
          this.prisma,
          async (tx) => {
            alerts.length = 0;
            const schedule = await this.lock(tx, id);
            if (!schedule || schedule.state !== 'ENDED' || schedule.endedReason !== 'END_REACHED' || schedule.plannedEndToldAt) return;
            if ((await tx.scheduleRun.count({ where: { scheduleId: id, ...RUN_NOT_OVER } })) > 0) return;
            await tx.schedule.update({ where: { id }, data: { plannedEndToldAt: this.clock() } });
            if ((schedule.rule as { kind?: string } | null)?.kind === 'ONCE') return;
            alerts.push({
              kind: 'PLANNED_END',
              ownerId: schedule.ownerId,
              scheduleId: id,
              runId: null,
              opens: { scheduleId: id },
              ownerRequestId: null,
              ...plannedEndCopy(schedule.title, await scheduleRunsStarted(tx, id)),
              collapseId: `schedule-planned-end-${id}`,
            });
          },
          loggedRetry(this.logger, 'scheduleRuns.tellPlannedEnds'),
        );
      } catch (error) {
        this.logger.error(`the planned end of schedule ${id} was not told: ${messageOf(error)}`);
        continue;
      }
      await this.alert(alerts);
      if (alerts.length > 0) told.push(id);
    }
    return told;
  }

  /**
   * §7.4: a NO_CHANGE run's session is completed once nothing is working in it any more (its reading is not WORKING:
   * idle, set to wake, or released). Only the run's own session, never an earlier one a retry retired, and the rest
   * of the conditions are in the query too, so rows this pass would skip cannot fill its batch: no turn queued or in
   * flight (session-turn-state.ts) and none of the shared outside-turn facts (common/session-working.ts) are the
   * prefilter, the reading confirms each.
   * `completed_at` and `deleted_at` say only that it was completed or trashed already.
   */
  async completeNoChangeSessions(batch = 25): Promise<string[]> {
    const sessions = await this.prisma.$queryRaw<Array<{ id: string; ownerId: string }>>(Prisma.sql`
      SELECT s."id" AS "id", s."owner_id"::text AS "ownerId"
        FROM "schedule_run" r
        JOIN "session" s ON s."id" = r."session_id" AND s."schedule_run_id" = r."id"
       WHERE r."state" = 'NO_CHANGE'
         AND (r."landing_status" IS NULL OR r."landing_status" IN ('LANDED', 'NO_COMMITS'))
         AND s."completed_at" IS NULL AND s."deleted_at" IS NULL
         AND ${sessionTurnStateSql('s')} IS DISTINCT FROM 'QUEUED'
         AND ${sessionTurnStateSql('s')} IS DISTINCT FROM 'IN_FLIGHT'
         AND NOT ${Prisma.raw(sessionExecutingOutsideTurnSql('s'))}
       ORDER BY r."ended_at" ASC, r."id" ASC
       LIMIT ${batch}`);
    const readings = await readRunSessions(this.prisma, sessions.map((session) => session.id));
    const completed: string[] = [];
    for (const s of sessions) {
      if (readings.get(s.id)?.reading === 'WORKING') continue;
      try {
        await this.sessions.complete(s.ownerId, s.id);
        completed.push(s.id);
      } catch (error) {
        this.logger.warn(`session ${s.id} of a NO_CHANGE run was not completed: ${messageOf(error)}`);
      }
    }
    return completed;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The report (§7.1)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * `schedule_run_report`, from the session serving a run: once per run, and it ends the run. A run the server failed
   * by its reading of the session (LATE_REPORT_FAILURES) takes a late one when the owner stepped back in
   * (`acceptsLateReport`): the report then replaces the failure as if it had come in time.
   */
  async report(
    ownerId: string,
    sessionId: string,
    input: ScheduleRunReport,
  ): Promise<{ run: ScheduleRun; newFinding: boolean }> {
    const report = this.checkReport(input);
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const session = await tx.session.findFirst({
          where: { id: sessionId, ownerId },
          select: { scheduleRunId: true },
        });
        if (!session?.scheduleRunId) {
          throw refusal('FORBIDDEN', 'SCHEDULE_RUN_REPORT_NOT_A_RUN', 'Only a session serving a scheduled run can report it.');
        }
        const head = await tx.scheduleRun.findUnique({ where: { id: session.scheduleRunId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: session.scheduleRunId } });
        if (!schedule || !run || run.sessionId !== sessionId) {
          throw refusal('FORBIDDEN', 'SCHEDULE_RUN_REPORT_NOT_A_RUN', 'This session no longer serves its run.');
        }
        const inferred = run.state === 'FAILED' && LATE_REPORT_FAILURES.has(run.failureReason ?? '');
        const late = inferred && (await this.acceptsLateReport(tx, schedule, run));
        if (!late && run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') {
          const reported = run.state === 'NO_CHANGE' || run.state === 'CHANGED' || run.failureReason === 'REPORTED_FAILED';
          throw refusal(
            'CONFLICT',
            reported ? 'SCHEDULE_RUN_ALREADY_REPORTED' : 'SCHEDULE_RUN_ENDED',
            reported ? 'This run has already been reported; a run reports once.'
              : inferred ? `This run has already ended (FAILED, ${run.failureReason}). It takes a late report only after the `
                + 'owner writes in this session, and only until a newer run of the schedule starts.'
              : `This run has already ended (${run.state}).`,
          );
        }
        // A late report undoes the failure the server counted; no newer run has counted anything since.
        const failures = late ? Math.max(0, schedule.consecutiveFailures - 1) : schedule.consecutiveFailures;
        const now = this.clock();
        const alerts: ScheduleAlert[] = [];
        const waitsForLanding = run.accessLevel === 'LAND' && report.outcome !== 'FAILED';
        const ended = await tx.scheduleRun.update({
          where: { id: run.id },
          data: {
            state: report.outcome,
            landingStatus: waitsForLanding ? 'WAITING' : null,
            key: report.key,
            summary: report.summary,
            links: report.links as Prisma.InputJsonValue,
            failureReason: report.outcome === 'FAILED' ? 'REPORTED_FAILED' : null,
            endedAt: now,
          },
        });
        await tx.schedule.update({
          where: { id: schedule.id },
          data: {
            ...(report.note !== undefined ? { note: report.note } : {}),
            ...(waitsForLanding
              ? (late ? { consecutiveFailures: failures } : {})
              : { consecutiveFailures: report.outcome === 'FAILED' ? failures + 1 : 0 }),
          },
        });
        let newFinding = false;
        if (report.outcome === 'CHANGED' && report.key) {
          const known = await tx.scheduleFinding.findUnique({
            where: { scheduleId_key: { scheduleId: schedule.id, key: report.key } },
          });
          if (known) {
            const links = [...new Set([...((known.links as string[] | null) ?? []), ...report.links])];
            await tx.scheduleFinding.update({
              where: { id: known.id },
              data: { lastSeenRunId: run.id, links: links as Prisma.InputJsonValue },
            });
          } else {
            // Told once, now: `notifiedAt` is written with the finding, so a replay of this report finds it known.
            await tx.scheduleFinding.create({
              data: {
                scheduleId: schedule.id,
                key: report.key,
                summary: report.summary,
                firstRunId: run.id,
                lastSeenRunId: run.id,
                links: report.links as Prisma.InputJsonValue,
                notifiedAt: now,
                createdAt: now,
              },
            });
            newFinding = true;
            alerts.push({
              kind: 'FINDING',
              ownerId: schedule.ownerId,
              scheduleId: schedule.id,
              runId: run.id,
              opens: { sessionId },
              ownerRequestId: null,
              ...findingCopy(schedule.title, report.summary),
              collapseId: findingCollapseId(schedule.id, report.key),
            });
          }
        }
        if (!waitsForLanding) await this.settleItems(tx, schedule, run, report.outcome === 'FAILED' ? 'FAILED' : 'SUCCEEDED', now, alerts, {
          reason: 'REPORTED_FAILED',
          summary: report.summary,
          consecutiveFailures: report.outcome === 'FAILED' ? failures + 1 : 0,
          late,
        });
        // The failure was pushed; a late success replaces its banner (a late FAILED's own push does).
        if (late && report.outcome !== 'FAILED') {
          alerts.push({
            kind: 'REPORTED_LATE',
            ownerId: schedule.ownerId,
            scheduleId: schedule.id,
            runId: run.id,
            opens: { sessionId },
            ownerRequestId: null,
            ...reportedLateCopy(schedule.title, report.summary),
            collapseId: `schedule-failed-${run.id}`,
          });
        }
        return { run: ended, newFinding, scheduleId: schedule.id, alerts };
      },
      loggedRetry(this.logger, 'scheduleRuns.report'),
    );
    await this.alert(result.alerts);
    // A NO_CHANGE session is completed by the worker's pass once nothing works in it (completeNoChangeSessions).
    await this.startNext(result.scheduleId);
    return { run: result.run, newFinding: result.newFinding };
  }

  /**
   * §7.1: NO_REPORT and ENGINE_CRASHED are the server's reading of the session, not the agent's word, and the
   * session can come back after either. When a person has written to the run's session since the run was failed so, they decided the run is not over, and a report from that session
   * still counts, until a newer run of the schedule starts (one run's result never lands over the next one's). A
   * schedule that was deleted takes none.
   */
  private async acceptsLateReport(tx: Tx, schedule: Schedule, run: ScheduleRun): Promise<boolean> {
    if (!run.sessionId || !run.endedAt || !run.startedAt) return false;
    if (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED') return false;
    const stepIn = await tx.conversationTurn.count({
      where: { sessionId: run.sessionId, byPerson: true, createdAt: { gt: run.endedAt } },
    });
    if (stepIn === 0) return false;
    const newer = await tx.scheduleRun.count({
      where: { scheduleId: schedule.id, id: { not: run.id }, startedAt: { gt: run.startedAt } },
    });
    return newer === 0;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Direct controls (§8.4)
  // -------------------------------------------------------------------------------------------------------------

  /** Run now: a MANUAL run under the overlap rule. Allowed when PAUSED, refused when ENDED or HELD. */
  async runNow(actor: ScheduleActor, scheduleId: string): Promise<ScheduleRun> {
    const run = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const schedule = await this.lock(tx, scheduleId, actor.ownerId);
        if (!schedule) throw refusal('NOT_FOUND', 'SCHEDULE_NOT_FOUND', 'No such schedule.');
        assertRunSessionScope(await runSessionScheduleId(tx, actor), scheduleId, 'CONTROL');
        if (schedule.state === 'ENDED') throw refusal('CONFLICT', 'SCHEDULE_ENDED', 'The schedule has ended.');
        if (schedule.state === 'HELD') {
          throw refusal('CONFLICT', 'SCHEDULE_HELD', `The schedule is held (${schedule.heldReason}); resume it first.`);
        }
        const now = this.clock();
        // §8.4: the owner's own press (the owner-interactive channel) counts toward no budget. A session's or a personal
        // access token's (what an agent with a shell on the runner holds) counts toward a budget of its own, kept apart
        // from the automatic runs', so it never takes a slot's place. The run it would write is planned at now.
        const byOwner = actor.kind === 'OWNER';
        if (!byOwner) {
          const started = await scheduleAgentPressStarts(tx, schedule, now);
          if (started >= schedule.envelopeRunsPerWeek) {
            throw refusal(
              'CONFLICT',
              'SCHEDULE_OVER_BUDGET',
              scheduleOverBudgetMessage(started, schedule.envelopeRunsPerWeek),
            );
          }
        }
        await this.skipQueued(tx, scheduleId, now);
        return tx.scheduleRun.create({
          data: { scheduleId, scheduleRevision: schedule.revision, plannedAt: now, trigger: 'MANUAL', state: 'QUEUED', byOwner },
        });
      },
      loggedRetry(this.logger, 'scheduleRuns.runNow'),
    );
    await this.startNext(scheduleId);
    return run;
  }

  /**
   * Stop this run: CANCELLED (CANCELLED_BY_OWNER) and its session interrupted, or ended when its first turn never
   * reached the engine (a session still waiting for a slot would otherwise start once one frees). The schedule is
   * unchanged.
   */
  async stopRun(actor: ScheduleActor, runId: string): Promise<ScheduleRun> {
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId, actor.ownerId) : null;
        const run = schedule ? await tx.scheduleRun.findUnique({ where: { id: runId } }) : null;
        if (!schedule || !run) throw refusal('NOT_FOUND', 'SCHEDULE_RUN_NOT_FOUND', 'No such run.');
        assertRunSessionScope(await runSessionScheduleId(tx, actor), schedule.id, 'CONTROL');
        if (run.state !== 'QUEUED' && run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') {
          throw refusal('CONFLICT', 'SCHEDULE_RUN_NOT_ACTIVE', `This run has already ended (${run.state}).`);
        }
        const stopped = await tx.scheduleRun.update({
          where: { id: runId },
          data: { state: 'CANCELLED', failureReason: 'CANCELLED_BY_OWNER', endedAt: this.clock() },
        });
        await closeScheduleItems(
          tx,
          { scheduleId: schedule.id, kinds: ['SCHEDULE_APPROVAL'], scheduleRunId: runId },
          { state: 'WITHDRAWN', note: 'You stopped the run.', now: this.clock() },
        );
        return { stopped, interrupt: run.state !== 'QUEUED' ? run.sessionId : null, ownerId: schedule.ownerId };
      },
      loggedRetry(this.logger, 'scheduleRuns.stop'),
    );
    if (result.interrupt) {
      const sessionId = result.interrupt;
      const opening = await this.prisma.conversationTurn.findFirst({
        where: { sessionId, clientTurnId: openingTurnKey(sessionId) },
        select: { deliveredAt: true },
      });
      if (opening?.deliveredAt) await this.quietly(() => this.sessions.interrupt(result.ownerId, sessionId), 'interrupt');
      else await this.quietly(() => this.sessions.end(result.ownerId, sessionId), 'end');
    }
    await this.startNext(result.stopped.scheduleId);
    return result.stopped;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Ending without a report
  // -------------------------------------------------------------------------------------------------------------

  /**
   * End an in-progress run with a failure. A run that never reached its engine (RETRIED_FAILURES) has its session
   * retired FIRST — auto-retry cancelled and the session ended — and only then is the run put back, so a process
   * that dies between the two leaves an ended session and a run still RUNNING, which the next pass settles the same
   * way, never two live sessions. A session that cannot be retired leaves the run as it was (DEFERRED). Then the
   * session is interrupted when asked, and a queued run may start.
   */
  async fail(
    runId: string,
    reason: ScheduleFailureReason,
    opts: { sessionId: string | null; interrupt?: boolean },
  ): Promise<FailOutcome | 'SETTLED_ELSEWHERE' | 'DEFERRED'> {
    if (RETRIED_FAILURES.has(reason) && opts.sessionId) {
      const owner = await this.prisma.scheduleRun.findUnique({
        where: { id: runId },
        select: { schedule: { select: { ownerId: true } } },
      });
      if (owner) {
        try {
          await this.sessions.end(owner.schedule.ownerId, opts.sessionId);
        } catch (error) {
          this.logger.warn(`run ${runId} stays as it is: session ${opts.sessionId} could not be retired: ${messageOf(error)}`);
          return 'DEFERRED';
        }
      }
    }
    const alerts: ScheduleAlert[] = [];
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        if (!schedule || !run || (run.state !== 'RUNNING' && run.state !== 'AWAITING_APPROVAL') || run.sessionId !== opts.sessionId) {
          return { outcome: 'SETTLED_ELSEWHERE' as const, ownerId: null, scheduleId: head?.scheduleId ?? null };
        }
        const outcome = await this.failLocked(tx, schedule, run, reason, this.clock(), alerts);
        return { outcome, ownerId: schedule.ownerId, scheduleId: schedule.id };
      },
      loggedRetry(this.logger, 'scheduleRuns.fail'),
    );
    await this.alert(alerts);
    if (result.outcome !== 'SETTLED_ELSEWHERE' && result.ownerId && opts.sessionId && opts.interrupt) {
      const ownerId = result.ownerId;
      const sessionId = opts.sessionId;
      await this.quietly(() => this.sessions.interrupt(ownerId, sessionId), 'interrupt');
    }
    if (result.scheduleId) await this.startNext(result.scheduleId);
    return result.outcome;
  }

  /**
   * Settle a failed attempt (§5.2, §7.2). A run that started is FAILED, counted, never retried. One that never
   * reached its engine is a slot not yet run: retried after 1, 5 and 15 minutes, then once an hour, for as long as
   * its catch-up window lasts; past it, MISSED, which is not a failure. It is CANCELLED instead when its schedule is
   * paused (a MANUAL run aside), held or deleted, and SKIPPED when a newer run already waits in its place.
   */
  private async failLocked(
    tx: Tx,
    schedule: Schedule,
    run: ScheduleRun,
    reason: ScheduleFailureReason,
    now: Date,
    alerts: ScheduleAlert[],
  ): Promise<FailOutcome> {
    const end = (state: 'FAILED' | 'MISSED' | 'CANCELLED' | 'SKIPPED') =>
      tx.scheduleRun.update({
        where: { id: run.id },
        data: { state, failureReason: reason, endedAt: now, notBeforeAt: null },
      });
    // Whatever happens to the run, the cards of the session it had are no longer a question (§6.4).
    await closeScheduleItems(
      tx,
      { scheduleId: schedule.id, kinds: ['SCHEDULE_APPROVAL'], scheduleRunId: run.id },
      { state: 'WITHDRAWN', note: 'The run ended.', now },
    );
    if (!RETRIED_FAILURES.has(reason)) {
      await end('FAILED');
      // Counted, never acted on: a schedule is not paused by its failures (§7.2, owner decision).
      await tx.schedule.update({ where: { id: schedule.id }, data: { consecutiveFailures: { increment: 1 } } });
      await this.settleItems(tx, schedule, run, 'FAILED', now, alerts, {
        reason,
        summary: null,
        consecutiveFailures: schedule.consecutiveFailures + 1,
      });
      return 'FAILED';
    }
    const stopped = schedule.state === 'HELD'
      || (schedule.state === 'ENDED' && schedule.endedReason === 'DELETED')
      || (schedule.state === 'PAUSED' && run.trigger !== 'MANUAL');
    if (stopped) {
      await end('CANCELLED');
      return 'CANCELLED';
    }
    const waiting = await tx.scheduleRun.count({ where: { scheduleId: schedule.id, state: 'QUEUED', id: { not: run.id } } });
    if (waiting > 0) {
      await end('SKIPPED');
      return 'SKIPPED';
    }
    const wait = run.attempt <= SCHEDULE_RETRY_DELAYS_MINUTES.length
      ? SCHEDULE_RETRY_DELAYS_MINUTES[run.attempt - 1] * MINUTE
      : SCHEDULE_RECOVERY_WAIT_MS;
    const retryAt = new Date(now.getTime() + wait);
    if (retryAt.getTime() > this.deadline(schedule, run)) {
      await end('MISSED');
      alerts.push(...this.onceMissedIf(schedule, run));
      return 'MISSED';
    }
    await tx.scheduleRun.update({
      where: { id: run.id },
      data: { state: 'QUEUED', attempt: run.attempt + 1, notBeforeAt: retryAt, sessionId: null, startedAt: null, failureReason: reason },
    });
    return 'RETRY';
  }

  private deadline(schedule: Pick<Schedule, 'rule' | 'timezone'>, run: Pick<ScheduleRun, 'plannedAt'>): number {
    return scheduleRunDeadline(schedule, run);
  }

  /**
   * A QUEUED run whose start threw: moved out of the due set for a while, so the runs behind it go ahead, and MISSED
   * once its catch-up window has passed, so no run waits for ever.
   */
  private async deferAfterError(runId: string): Promise<void> {
    try {
      const run = await this.prisma.scheduleRun.findUnique({ where: { id: runId }, include: { schedule: true } });
      if (!run || run.state !== 'QUEUED') return;
      const now = this.clock();
      const missed = now.getTime() > this.deadline(run.schedule, run);
      const moved = await this.prisma.scheduleRun.updateMany({
        where: { id: runId, state: 'QUEUED' },
        data: missed
          ? { state: 'MISSED', endedAt: now, notBeforeAt: null }
          : { notBeforeAt: new Date(now.getTime() + SCHEDULE_ERROR_COOLDOWN_MS) },
      });
      if (missed && moved.count === 1) await this.alert(this.onceMissedIf(run.schedule, run));
    } catch (error) {
      this.coolDown(runId);
      this.logger.error(`schedule run ${runId} could not be put aside: ${messageOf(error)}`);
    }
  }

  private cooled(): string[] {
    const now = this.clock().getTime();
    for (const [id, until] of this.cooling) if (until <= now) this.cooling.delete(id);
    return [...this.cooling.keys()];
  }

  private coolDown(id: string): void {
    this.cooling.set(id, this.clock().getTime() + SCHEDULE_ERROR_COOLDOWN_MS);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inside
  // -------------------------------------------------------------------------------------------------------------

  /**
   * What a run's end settles in Waiting on you (§7.3). A failure is pushed and waits there — one item per schedule,
   * the newest, so three failures in a row are one item that says so — and a run that succeeded closes it.
   */
  private async settleItems(
    tx: Tx,
    schedule: Schedule,
    run: ScheduleRun,
    how: 'FAILED' | 'SUCCEEDED',
    now: Date,
    alerts: ScheduleAlert[],
    failure: { reason: string; summary: string | null; consecutiveFailures: number; late?: boolean },
  ): Promise<void> {
    await closeScheduleItems(
      tx,
      { scheduleId: schedule.id, kinds: ['SCHEDULE_APPROVAL'], scheduleRunId: run.id },
      { state: 'WITHDRAWN', note: 'The run ended.', now },
    );
    await closeScheduleItems(
      tx,
      { scheduleId: schedule.id, kinds: ['SCHEDULE_FAILED'] },
      {
        state: 'WITHDRAWN',
        note: failure.late ? 'The run reported after all.' : how === 'FAILED' ? 'A later run failed too.' : 'A later run succeeded.',
        now,
      },
    );
    if (how !== 'FAILED') return;
    // An ended or deleted schedule has nothing left to wait on the owner for: a run that outlived it and then failed is
    // still pushed, but files no item nothing would ever close.
    const file = schedule.state !== 'ENDED';
    const copy = failedCopy({
      title: schedule.title,
      consecutiveFailures: failure.consecutiveFailures,
      failureReason: failure.reason,
      summary: failure.summary,
      plannedAt: run.plannedAt,
      timezone: schedule.timezone,
    });
    const askedBy = file ? (run.sessionId ?? (await scheduleHomeSession(tx, schedule))) : null;
    const itemId = askedBy
      ? await fileScheduleItem(tx, {
          kind: 'SCHEDULE_FAILED',
          ownerId: schedule.ownerId,
          askedBySessionId: askedBy,
          scheduleId: schedule.id,
          scheduleRunId: run.id,
          workspaceId: schedule.workspaceId,
          // A late report's failure replaces the item of the failure just withdrawn, so it is keyed apart from it.
          key: `schedule-failed:${run.id}${failure.late ? ':reported' : ''}`,
          title: copy.title,
          why: copy.why,
        })
      : null;
    alerts.push({
      kind: 'FAILED',
      ownerId: schedule.ownerId,
      scheduleId: schedule.id,
      runId: run.id,
      opens: run.sessionId ? { sessionId: run.sessionId } : { scheduleId: schedule.id },
      ownerRequestId: itemId,
      title: copy.title,
      body: copy.body,
      collapseId: `schedule-failed-${run.id}`,
    });
  }

  /** A schedule moved to HELD by this run's start: pushed, and waiting on the owner until it is resumed (§6.1). */
  private async fileHeld(tx: Tx, schedule: Schedule, run: ScheduleRun, reason: string, alerts: ScheduleAlert[]): Promise<void> {
    // The hold names what holds it: 'the agent "auditor" in workspace web is disabled'.
    const [agent, workspace] = await Promise.all([
      schedule.agentId ? tx.agent.findUnique({ where: { id: schedule.agentId }, select: { name: true, ownerId: true } }) : null,
      tx.workspace.findUnique({ where: { id: schedule.workspaceId }, select: { name: true, ownerId: true } }),
    ]);
    const copy = heldCopy({
      title: schedule.title,
      reason,
      plannedAt: run.plannedAt,
      agentName: agent?.ownerId === schedule.ownerId ? agent.name : null,
      workspaceName: workspace?.ownerId === schedule.ownerId ? workspace.name : null,
      now: this.clock(),
      timezone: schedule.timezone,
    });
    const askedBy = await scheduleHomeSession(tx, schedule);
    const itemId = askedBy
      ? await fileScheduleItem(tx, {
          kind: 'SCHEDULE_HELD',
          ownerId: schedule.ownerId,
          askedBySessionId: askedBy,
          scheduleId: schedule.id,
          scheduleRunId: run.id,
          workspaceId: schedule.workspaceId,
          key: `schedule-held:${run.id}`,
          title: copy.title,
          why: copy.why,
        })
      : null;
    alerts.push({
      kind: 'HELD',
      ownerId: schedule.ownerId,
      scheduleId: schedule.id,
      runId: run.id,
      opens: { scheduleId: schedule.id },
      ownerRequestId: itemId,
      title: copy.title,
      body: copy.body,
      collapseId: `schedule-held-${run.id}`,
    });
  }

  /**
   * A slot over budget: MISSED (OVER_BUDGET), never started. The owner is told once for the new reason: not again
   * while the run before it ended the same way.
   */
  private async missOverBudget(tx: Tx, schedule: Schedule, run: ScheduleRun, now: Date): Promise<ScheduleAlert[]> {
    const previous = await tx.scheduleRun.findFirst({
      where: { scheduleId: schedule.id, id: { not: run.id }, endedAt: { not: null } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      select: { state: true, failureReason: true },
    });
    await tx.scheduleRun.update({
      where: { id: run.id },
      data: { state: 'MISSED', failureReason: 'OVER_BUDGET', endedAt: now, notBeforeAt: null },
    });
    // A ONCE schedule's only slot follows §5.2's missed-ONCE rule: one push saying nothing else will run (fire has
    // already ended the schedule, END_REACHED); the run list carries why.
    const once = this.onceMissedIf(schedule, run);
    if (once.length > 0) return once;
    if (previous?.state === 'MISSED' && previous.failureReason === 'OVER_BUDGET') return [];
    return [{
      kind: 'OVER_BUDGET',
      ownerId: schedule.ownerId,
      scheduleId: schedule.id,
      runId: run.id,
      opens: { scheduleId: schedule.id },
      ownerRequestId: null,
      ...overBudgetCopy(schedule.title, schedule.envelopeRunsPerWeek),
      collapseId: `schedule-over-budget-${schedule.id}`,
    }];
  }

  /** §5.2: a missed ONCE notifies, because nothing else will run. A MANUAL run is not its slot. */
  private onceMissedIf(schedule: Schedule, run: ScheduleRun): ScheduleAlert[] {
    try {
      if (parseRule(schedule.rule).kind !== 'ONCE' || run.trigger === 'MANUAL') return [];
    } catch {
      return [];
    }
    return [this.onceMissed(schedule, run.id)];
  }

  private onceMissed(schedule: Schedule, runId: string): ScheduleAlert {
    return {
      kind: 'ONCE_MISSED',
      ownerId: schedule.ownerId,
      scheduleId: schedule.id,
      runId,
      opens: { scheduleId: schedule.id },
      ownerRequestId: null,
      ...onceMissedCopy(schedule.title),
      collapseId: `schedule-once-missed-${schedule.id}`,
    };
  }

  /**
   * One item per card the run's session is waiting on, filed once and pushed once; a card no longer PENDING closes
   * its item — DONE when it was answered. Under the schedule lock, and only while the run is still in progress with
   * this session, so an item is never filed for a run that has already ended. False when it no longer is.
   */
  private async syncApprovalItems(runId: string, sessionId: string): Promise<boolean> {
    const alerts: ScheduleAlert[] = [];
    const live = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        const head = await tx.scheduleRun.findUnique({ where: { id: runId }, select: { scheduleId: true } });
        const schedule = head ? await this.lock(tx, head.scheduleId) : null;
        const run = await tx.scheduleRun.findUnique({ where: { id: runId } });
        if (!schedule || !run || !(IN_PROGRESS as readonly string[]).includes(run.state) || run.sessionId !== sessionId) {
          return false;
        }
        const now = this.clock();
        const pending = await tx.approval.findMany({
          where: { sessionId, status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, toolName: true, input: true, createdAt: true },
        });
        const workspace = pending.length
          ? await tx.workspace.findUnique({ where: { id: schedule.workspaceId }, select: { name: true } })
          : null;
        await closeScheduleItems(
          tx,
          { scheduleId: schedule.id, kinds: ['SCHEDULE_APPROVAL'], scheduleRunId: runId, approvalIdsNotIn: pending.map((c) => c.id) },
          { state: 'DONE', note: 'The approval was answered.', byUserId: schedule.ownerId, now },
        );
        for (const card of pending) {
          const copy = approvalCopy({
            title: schedule.title,
            deadline: new Date(card.createdAt.getTime() + SCHEDULE_APPROVAL_TIMEOUT_MS),
            nextAt: schedule.nextDueAt,
            pattern: approvalPattern(card.toolName, card.input, (run.accessLevel ?? schedule.accessLevel) === 'CHECK_ONLY'),
            workspaceName: workspace?.name ?? '',
            now,
            timezone: schedule.timezone,
          });
          const itemId = await fileScheduleItem(tx, {
            kind: 'SCHEDULE_APPROVAL',
            ownerId: schedule.ownerId,
            askedBySessionId: sessionId,
            scheduleId: schedule.id,
            scheduleRunId: runId,
            approvalId: card.id,
            workspaceId: schedule.workspaceId,
            key: `schedule-approval:${card.id}`,
            title: copy.title,
            why: copy.why,
          });
          if (!itemId) continue;
          alerts.push({
            kind: 'AWAITING_APPROVAL',
            ownerId: schedule.ownerId,
            scheduleId: schedule.id,
            runId,
            opens: { sessionId },
            ownerRequestId: itemId,
            title: copy.title,
            body: copy.body,
            collapseId: `owner-request-${itemId}`,
          });
        }
        return true;
      },
      loggedRetry(this.logger, 'scheduleRuns.syncApprovalItems'),
    );
    await this.alert(alerts);
    return live;
  }

  /**
   * A schedule's runs, newest first, each with where its session stands (§7.4): OPEN, COMPLETED, TRASH, or GONE when
   * the session was purged — the run is kept and still names it. Null for a run that never had one.
   */
  async history(
    ownerId: string,
    scheduleId: string,
    take = 50,
  ): Promise<Array<ScheduleRun & { session: RunSessionView | null; reasonText: string | null }>> {
    const schedule = await this.prisma.schedule.findFirst({ where: { id: scheduleId, ownerId }, select: { id: true } });
    if (!schedule) throw refusal('NOT_FOUND', 'SCHEDULE_NOT_FOUND', 'No such schedule.');
    const list = await this.prisma.scheduleRun.findMany({
      where: { scheduleId },
      orderBy: [{ plannedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(take, 1), 200),
    });
    const ids = list.flatMap((r) => (r.sessionId ? [r.sessionId] : []));
    const sessions = ids.length
      ? await this.prisma.session.findMany({
          where: { id: { in: ids }, ownerId },
          select: { id: true, completedAt: true, archivedAt: true, deletedAt: true },
        })
      : [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return list.map((r) => {
      const reasonText = runReasonText(r);
      if (!r.sessionId) return { ...r, session: null, reasonText };
      const s = byId.get(r.sessionId);
      const state: RunSessionView['state'] = !s
        ? 'GONE'
        : s.deletedAt
          ? 'TRASH'
          : (s.completedAt ?? s.archivedAt)
            ? 'COMPLETED'
            : 'OPEN';
      return { ...r, session: { id: r.sessionId, state }, reasonText };
    });
  }

  /** The per-account lock, then the schedule row FOR UPDATE: SchedulesService's order. */
  private async lock(tx: Tx, scheduleId: string, ownerId?: string): Promise<Schedule | null> {
    const head = await tx.schedule.findUnique({ where: { id: scheduleId }, select: { ownerId: true } });
    if (!head || (ownerId && head.ownerId !== ownerId)) return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCHEDULE_LOCK_NAMESPACE}::int, hashtext(${head.ownerId}))`;
    await tx.$queryRaw`SELECT "id" FROM "schedule" WHERE "id" = ${scheduleId}::uuid FOR UPDATE`;
    return tx.schedule.findUnique({ where: { id: scheduleId } });
  }

  /** One slot's run; null when the slot already has one (another worker, or this one before a restart). */
  private async insertSlotRun(
    tx: Tx,
    schedule: Schedule,
    plannedAt: Date,
    trigger: 'SCHEDULED' | 'CATCH_UP',
    state: 'QUEUED' | 'MISSED',
    endedAt: Date | null,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "schedule_run" ("id", "schedule_id", "schedule_revision", "planned_at", "trigger", "state", "ended_at")
      VALUES (${randomUUID()}::uuid, ${schedule.id}::uuid, ${schedule.revision}, ${plannedAt},
              ${trigger}::"schedule_run_trigger", ${state}::"schedule_run_state", ${endedAt})
      ON CONFLICT ("schedule_id", "planned_at") WHERE "trigger" IN ('SCHEDULED', 'CATCH_UP') DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  /** The overlap rule: the run already waiting gives its place to the newer one. */
  private async skipQueued(tx: Tx, scheduleId: string, now: Date): Promise<void> {
    await tx.scheduleRun.updateMany({
      where: { scheduleId, state: 'QUEUED' },
      data: { state: 'SKIPPED', endedAt: now, notBeforeAt: null },
    });
  }

  /**
   * §8.5: a start reached the schedule's maxRuns. ENDED (END_REACHED) in that start's transaction, under the schedule
   * lock the count was read under, so two replicas cannot both start a last run; no next slot, and a WHEN rule's
   * condition ended as syncCondition ends it. No other run is QUEUED (schedule_run_one_queued_key: the one queued was
   * the one starting), and start() cancels any run that would start past the count. The run that reached it goes on;
   * tellPlannedEnds pushes once it is over.
   */
  private async endAtMaxRuns(tx: Tx, schedule: Schedule, now: Date): Promise<void> {
    await tx.schedule.update({
      where: { id: schedule.id },
      data: { state: 'ENDED', endedReason: 'END_REACHED', endedAt: now, nextDueAt: null },
    });
    const rule = schedule.rule as unknown as ScheduleRule;
    if (rule.kind === 'WHEN' && rule.conditionId) {
      const ended = await tx.condition.updateMany({
        where: { id: rule.conditionId, state: { not: 'ENDED' } },
        data: { state: 'ENDED', endedAt: now, trueSince: null, repeatFrom: null },
      });
      if (ended.count > 0) await closeUnknownItems(tx, rule.conditionId, now);
    }
  }

  private async holdRun(tx: Tx, run: ScheduleRun, reason: string, now: Date): Promise<void> {
    await tx.scheduleRun.update({
      where: { id: run.id },
      data: { state: 'HELD', heldReason: reason, endedAt: now, notBeforeAt: null },
    });
  }

  private async moveInProgress(
    runId: string,
    from: 'RUNNING' | 'AWAITING_APPROVAL',
    to: 'RUNNING' | 'AWAITING_APPROVAL',
  ): Promise<ReconcileOutcome> {
    const moved = await this.prisma.scheduleRun.updateMany({ where: { id: runId, state: from }, data: { state: to } });
    return moved.count === 1 ? to : 'SETTLED_ELSEWHERE';
  }

  /** The run's first turn: the scheduled-run block, then the prompt (§6.3). */
  private async firstTurn(tx: Tx, schedule: Schedule, run: ScheduleRun, now: Date): Promise<string> {
    const started = await tx.scheduleRun.count({
      where: { scheduleId: schedule.id, startedAt: { not: null }, id: { not: run.id } },
    });
    const previous = await tx.scheduleRun.findMany({
      where: { scheduleId: schedule.id, state: { in: ['NO_CHANGE', 'CHANGED', 'FAILED'] }, endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
      take: 1,
      select: { state: true, endedAt: true },
    });
    const findings = await tx.scheduleFinding.findMany({
      where: { scheduleId: schedule.id },
      orderBy: { createdAt: 'asc' },
      select: { key: true, firstRunId: true, createdAt: true },
    });
    const last = previous[0];
    return scheduledRunTurn({
      runNumber: started + 1,
      title: schedule.title,
      intent: schedule.intent,
      prompt: schedule.prompt,
      timezone: schedule.timezone,
      plannedAt: run.plannedAt,
      startedAt: now,
      lastRun: last ? { state: last.state as 'NO_CHANGE' | 'CHANGED' | 'FAILED', endedAt: last.endedAt! } : null,
      // The baselines first (what the creating agent saw), then in the order they were first reported.
      findings: [...findings.filter((f) => !f.firstRunId), ...findings.filter((f) => f.firstRunId)]
        .map((f) => ({ key: f.key, firstSeenAt: f.firstRunId ? f.createdAt : null })),
      note: schedule.note,
      accessLevel: schedule.accessLevel,
      runLimitMinutes: schedule.runLimitMinutes,
      firing: run.trigger === 'CONDITION' ? await this.firingOf(tx, schedule, run) : null,
    });
  }

  /**
   * What a CONDITION run's block says about its firing (docs/condition-triggers-design.md §6.1): the condition, the
   * reading that fired it, since when the comparison held (the oldest of the unbroken true readings up to the firing;
   * a failed check neither breaks nor starts it), and the recent samples up to the firing, newest first.
   */
  private async firingOf(tx: Tx, schedule: Schedule, run: ScheduleRun): Promise<RunBlockFiring | null> {
    const rule = schedule.rule as unknown as ScheduleRule;
    if (rule.kind !== 'WHEN' || !rule.conditionId) return null;
    const condition = await tx.condition.findUnique({ where: { id: rule.conditionId } });
    if (!condition) return null;
    const samples = await tx.conditionSample.findMany({
      where: { conditionId: condition.id, at: { lte: run.plannedAt } },
      orderBy: { at: 'desc' },
      take: 200,
    });
    const fired = samples[0] && samples[0].at.getTime() === run.plannedAt.getTime() ? samples[0] : null;
    let since: Date | null = null;
    for (const sample of samples) {
      const held = sampleHolds(condition.compareOp, condition.compareValue, sample);
      if (held === false) break;
      if (held) since = sample.at;
    }
    return {
      text: condition.text,
      unit: condition.unit,
      at: run.plannedAt,
      value: fired ? (condition.compareOp === 'EXIT_ZERO' ? fired.exitCode : fired.value) : null,
      since,
      samples: samples.slice(0, RUN_BLOCK_MAX_SAMPLES).map((s) => ({
        at: s.at,
        value: condition.compareOp === 'EXIT_ZERO' ? (s.outcome === 'EXIT' ? s.exitCode : null) : s.outcome === 'VALUE' ? s.value : null,
        outcome: s.outcome,
      })),
      repeat: await this.repeatOf(tx, condition.id, run),
    };
  }

  /**
   * A repeat firing's line (docs/condition-triggers-design.md §5.1): the crossing it follows, the newest FIRED that is
   * not a repeat up to it, and the runs of this schedule's condition that started from then until this one. Null when
   * the run's firing is a crossing.
   */
  private async repeatOf(tx: Tx, conditionId: string, run: ScheduleRun): Promise<{ firstFiredAt: Date; runsSince: number } | null> {
    const event = await tx.conditionEvent.findFirst({ where: { conditionId, runId: run.id, kind: 'FIRED' }, select: { at: true, repeat: true } });
    if (!event?.repeat) return null;
    const first = await tx.conditionEvent.findFirst({
      where: { conditionId, kind: 'FIRED', repeat: false, at: { lte: event.at } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { at: true },
    });
    if (!first) return null;
    const runsSince = await tx.scheduleRun.count({
      where: {
        scheduleId: run.scheduleId, trigger: 'CONDITION', id: { not: run.id }, startedAt: { not: null },
        plannedAt: { gte: first.at, lt: run.plannedAt },
      },
    });
    return { firstFiredAt: first.at, runsSince };
  }

  private openInput(schedule: Schedule, run: ScheduleRun, sessionId: string, prompt: string, plan: StartPlan): OpenRunSession {
    return {
      ownerId: schedule.ownerId,
      sessionId,
      scheduleRunId: run.id,
      workspaceId: schedule.workspaceId,
      title: schedule.title,
      prompt,
      permissionMode: plan.mode,
      noWorktree: schedule.accessLevel === 'CHECK_ONLY',
      engine: plan.engine,
      provider: plan.provider,
    };
  }

  /** A run ended: the one queued behind it may start (§5). */
  private async startNext(scheduleId: string): Promise<void> {
    try {
      await this.startDue(1, scheduleId);
    } catch (error) {
      this.logger.warn(`the next run of schedule ${scheduleId} did not start yet: ${messageOf(error)}`);
    }
  }

  private async quietly(action: () => Promise<void>, what: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(`a run's session ${what} failed: ${messageOf(error)}`);
    }
  }

  private checkReport(input: ScheduleRunReport): Required<Omit<ScheduleRunReport, 'note'>> & { key: string | null; note?: string | null } {
    const outcome = input?.outcome;
    if (outcome !== 'NO_CHANGE' && outcome !== 'CHANGED' && outcome !== 'FAILED') {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_OUTCOME_INVALID', 'outcome is NO_CHANGE, CHANGED or FAILED.');
    }
    const key = input.key == null || input.key === '' ? null : input.key;
    if (key !== null && (typeof key !== 'string' || key.length > 200)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_KEY_INVALID', 'A key is a string of at most 200 characters.');
    }
    if (outcome === 'CHANGED' && key === null) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_KEY_REQUIRED', 'A CHANGED report names the key of what changed.');
    }
    if (typeof input.summary !== 'string' || input.summary.trim().length === 0 || input.summary.length > 4000) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_SUMMARY_INVALID', 'A summary is a non-empty string of at most 4000 characters.');
    }
    const links = input.links ?? [];
    if (!Array.isArray(links) || links.length > 20 || links.some((l) => typeof l !== 'string' || l.length > 2000)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_LINKS_INVALID', 'links are at most 20 strings.');
    }
    if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 2000)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_REPORT_NOTE_INVALID', 'A note is a string of at most 2000 characters.');
    }
    return { outcome, key, summary: input.summary, links, ...(input.note !== undefined ? { note: input.note } : {}) };
  }
}
