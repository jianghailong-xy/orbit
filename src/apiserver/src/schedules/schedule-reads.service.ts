/**
 * The reads of scheduled tasks (docs/scheduled-tasks-design.md §9.1) and the answers the write doors give, shared by
 * the MCP tools' runner doors and the REST doors so both read the same:
 *
 *   * a schedule's list row and its detail (the inspector: read-back, next run, last result, findings, note, this
 *     month's use, history with Undo, the card waiting on it);
 *   * its runs;
 *   * the cards: requests the owner has to answer, the drafts of the Scheduled page (PENDING CREATE requests), and
 *     what one session put up — its cards and the records of the changes it made.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ScheduleChangeOpening, ScheduleRunSessionStatus, ScheduleRunTry, ScheduleWaitingTask } from '@orbit/shared';
import type {
  Prisma,
  Schedule,
  ScheduleChangeRequestKind,
  ScheduleChangeRequestState,
  ScheduleRun,
  ScheduleState,
} from '@prisma/client';

import { MANAGED_RUNNER_GATE, type ManagedRunnerGate } from '../managed-runners/managed-runner-gate';
import { PrismaService } from '../prisma/prisma.service';
import { openingTurnKey } from '../sessions/orbit-authored-turn';
import { sessionCapacityGate } from '../sessions/queued-reason-sql';
import { scheduleRunDeadline } from './schedule-runs.service';
import {
  scheduleCardViews,
  scheduleFindingView,
  scheduleRecordView,
  scheduleRunView,
  scheduleUsageThisMonth,
  scheduleViewNames,
  scheduleReadBack,
  scheduleView,
  workspaceNames,
} from './schedule-views';
import type { ScheduleCreateResult, ScheduleDecisionResult, ScheduleUpdateAnswer } from './schedules.service';

type Tx = Prisma.TransactionClient;

/** The Scheduled page's past runs are today's, in the viewer's zone: today never began more than a day ago. */
const TIMELINE_WINDOW_MS = 24 * 60 * 60_000;
const TIMELINE_RUNS_MAX = 500;

const SCHEDULE_STATES: readonly ScheduleState[] = ['ACTIVE', 'PAUSED', 'HELD', 'ENDED'];
const REQUEST_STATES: readonly ScheduleChangeRequestState[] = ['PENDING', 'ALLOWED', 'DECLINED', 'SUPERSEDED'];

/** What every PENDING answer says in words, so an agent cannot report a card as a schedule (§8.1). */
export const SCHEDULE_PENDING_CREATE_NOTE =
  'Nothing is scheduled yet. The create card is in front of the person; the schedule exists only once they press '
  + 'Create, and pressing Not now leaves nothing behind. Tell them the card is waiting, not that it is scheduled.';

export const SCHEDULE_PENDING_UPDATE_NOTE =
  'Not changed yet: this grows what the schedule may do, so it waits on a card only the person can allow. The '
  + 'schedule runs as it was until they do.';

/** §8.1: the session asked to create a schedule it already created; it is named so the agent changes that one. */
export const SCHEDULE_EXISTS_NOTE =
  'Not created: this session already created this schedule (same workspace, same title or what was asked), so no '
  + 'card was put in front of the person. To change it, call schedule_update with this scheduleId and only the fields '
  + 'that change. If the person really wants a second schedule, give it a title of its own.';

/** §8.2: a change of the time, frequency or limits is not a restated goal; the intent it carried was not written. */
export const SCHEDULE_INTENT_KEPT_NOTE =
  'What was asked (intent) was left as it was: this change only reschedules, and intent changes only when the person '
  + 'restates the goal.';

export const SCHEDULE_RECORD_NOTE =
  'Changed at once (inside what the person allowed). The change is recorded in the schedule\'s history, and the '
  + 'person can undo it.';

function badState(name: string, value: string, allowed: readonly string[]): never {
  throw new BadRequestException({
    code: 'SCHEDULE_FILTER_INVALID',
    message: `${name} "${value}" is not one of ${allowed.join(', ')}.`,
  });
}

@Injectable()
export class ScheduleReadsService {
  constructor(
    private readonly prisma: PrismaService,
    /** The managed-runner switch, for a WHEN card's "Keeps this cloud workspace awake" line. Absent, off. */
    @Optional() @Inject(MANAGED_RUNNER_GATE) private readonly gate?: ManagedRunnerGate,
  ) {}

  private now(): Date {
    return new Date();
  }

  /**
   * `GET /api/schedules`: not ENDED unless asked; newest first. With `timeline` (the REST door) the answer also carries
   * what the Scheduled page draws beyond the rows, so the page is one read: when each paused schedule was paused, and
   * the runs of the shown window (every run under way, and the ended runs planned in the last day, which holds the
   * viewer's today in any zone), each with whether its finding was new and whether the owner was told.
   */
  async list(ownerId: string, filter: { state?: string; workspaceId?: string; timeline?: boolean } = {}) {
    const states = filter.state === 'all'
      ? [...SCHEDULE_STATES]
      : filter.state
        ? filter.state.split(',').map((s) => {
            const st = s.trim().toUpperCase() as ScheduleState;
            if (!SCHEDULE_STATES.includes(st)) badState('state', s, [...SCHEDULE_STATES, 'all']);
            return st;
          })
        : (['ACTIVE', 'PAUSED', 'HELD'] as ScheduleState[]);
    const rows = await this.prisma.schedule.findMany({
      where: { ownerId, state: { in: states }, ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}) },
      orderBy: [{ nextDueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 200,
    });
    const names = await workspaceNames(this.prisma, ownerId, rows.map((r) => r.workspaceId));
    const viewNames = await scheduleViewNames(this.prisma, ownerId, rows);
    const lastRuns = rows.length
      ? await this.prisma.scheduleRun.findMany({
          where: { scheduleId: { in: rows.map((r) => r.id) }, endedAt: { not: null } },
          orderBy: { endedAt: 'desc' },
          distinct: ['scheduleId'],
        })
      : [];
    const last = new Map(lastRuns.map((r) => [r.scheduleId, r]));
    const schedules = rows.map((r) => ({
      ...scheduleView(r, names, viewNames),
      lastRun: last.has(r.id) ? scheduleRunView(last.get(r.id)!) : null,
    }));
    if (!filter.timeline) return { schedules };
    const timeline = await this.timeline(rows);
    return {
      schedules: schedules.map((s) => ({ ...s, pausedAt: timeline.pausedAt.get(s.id) ?? null })),
      runs: timeline.runs,
      waitingTasks: await this.waitingTasks(ownerId, filter.workspaceId),
    };
  }

  /**
   * The OPEN tasks waiting for their startWhen condition (docs/condition-triggers-design.md §9): the page's "Waiting
   * for a condition" group lists them beside the WHEN schedules, with the newest reading and its age. Not fired and
   * not ended: a fired condition has started its task, or will within the minute.
   */
  private async waitingTasks(ownerId: string, workspaceId?: string): Promise<ScheduleWaitingTask[]> {
    const tasks = await this.prisma.task.findMany({
      where: {
        ownerId,
        status: 'OPEN',
        // Stated on the task row as well as implied by the relation: without it the planner walks the
        // owner's tasks newest first looking for 200 with a live condition, and when there are none it
        // reads every one (production, 2026-11-19: 109,840 rows, 115,834 buffers, 285 ms). With it the
        // entry is task_start_when_condition_id_key, which holds only tasks that have a condition.
        startWhenConditionId: { not: null },
        startWhenCondition: { state: { not: 'ENDED' }, firedAt: null },
        ...(workspaceId ? { assigneeId: workspaceId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        title: true,
        assigneeId: true,
        startWhenCondition: {
          select: { id: true, text: true, unit: true, state: true, lastValue: true, lastSampleAt: true, workspaceId: true },
        },
      },
    });
    const names = await workspaceNames(this.prisma, ownerId, tasks.map((t) => t.startWhenCondition!.workspaceId));
    return tasks.map((t) => {
      const c = t.startWhenCondition!;
      return {
        id: t.id,
        title: t.title,
        workspaceId: c.workspaceId,
        workspaceName: names.get(c.workspaceId) ?? null,
        condition: {
          id: c.id,
          text: c.text,
          unit: c.unit,
          state: c.state,
          lastValue: c.lastValue,
          lastSampleAt: c.lastSampleAt?.toISOString() ?? null,
        },
      };
    });
  }

  /** The list's timeline part; `rows` are already the caller's own, so every read below is scoped by them. */
  private async timeline(rows: Schedule[]) {
    const ids = rows.map((r) => r.id);
    const paused = rows.filter((r) => r.state === 'PAUSED').map((r) => r.id);
    if (ids.length === 0) return { pausedAt: new Map<string, string>(), runs: [] };
    const since = new Date(this.now().getTime() - TIMELINE_WINDOW_MS);
    const [runs, pauses] = await Promise.all([
      this.prisma.scheduleRun.findMany({
        where: {
          scheduleId: { in: ids },
          OR: [{ state: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] } }, { plannedAt: { gte: since } }],
        },
        orderBy: [{ plannedAt: 'desc' }, { id: 'desc' }],
        take: TIMELINE_RUNS_MAX,
      }),
      paused.length
        ? this.prisma.scheduleRevision.findMany({
            where: { scheduleId: { in: paused }, fields: { path: ['after', 'state'], equals: 'PAUSED' } },
            orderBy: { revision: 'desc' },
            distinct: ['scheduleId'],
            select: { scheduleId: true, createdAt: true },
          })
        : [],
    ]);
    const findings = runs.length
      ? await this.prisma.scheduleFinding.findMany({
          where: { scheduleId: { in: ids }, firstRunId: { in: runs.map((r) => r.id) } },
          select: { key: true, firstRunId: true, notifiedAt: true },
        })
      : [];
    const firstFound = new Map(findings.map((f) => [f.firstRunId!, f]));
    return {
      pausedAt: new Map(pauses.map((p) => [p.scheduleId, p.createdAt.toISOString()])),
      runs: runs.map((run) => {
        const finding = firstFound.get(run.id);
        const newFinding = Boolean(finding && run.key !== null && finding.key === run.key);
        return { ...scheduleRunView(run), newFinding, notified: newFinding && finding!.notifiedAt !== null };
      }),
    };
  }

  /** `GET /api/schedules/:id`: the inspector. ENDED schedules are readable: their history stays. */
  async get(ownerId: string, scheduleId: string) {
    return this.detail(this.prisma, ownerId, scheduleId);
  }

  async detail(tx: Tx, ownerId: string, scheduleId: string) {
    const schedule = await tx.schedule.findFirst({ where: { id: scheduleId, ownerId } });
    if (!schedule) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'No such schedule.' });
    const now = this.now();
    const [names, viewNames, runs, findings, revisions, pending, usage] = await Promise.all([
      workspaceNames(tx, ownerId, [schedule.workspaceId, schedule.envelopeWorkspaceId]),
      scheduleViewNames(tx, ownerId, [schedule]),
      tx.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'desc' }, take: 10 }),
      tx.scheduleFinding.findMany({ where: { scheduleId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      tx.scheduleRevision.findMany({ where: { scheduleId }, orderBy: { revision: 'desc' }, take: 50 }),
      tx.scheduleChangeRequest.findMany({ where: { scheduleId, state: 'PENDING' }, orderBy: { createdAt: 'desc' } }),
      scheduleUsageThisMonth(tx, schedule, now),
    ]);
    const undone = new Map<number, number>();
    for (const r of revisions) if (r.undoOfRevision !== null) undone.set(r.undoOfRevision, r.revision);
    const ended = runs.find((r) => r.endedAt !== null) ?? null;
    return {
      schedule: scheduleView(schedule, names, viewNames),
      readBack: scheduleReadBack(schedule),
      lastRun: ended ? scheduleRunView(ended) : null,
      recentRuns: runs.map(scheduleRunView),
      findings: findings.map(scheduleFindingView),
      usage,
      history: revisions.map((r) => scheduleRecordView(schedule.id, schedule.title, r, undone.get(r.revision) ?? null)),
      pendingCards: await scheduleCardViews(tx, ownerId, pending, now, this.gate),
    };
  }

  /** `GET /api/schedules/:id/runs`: newest first, `before` a plannedAt to page back from. */
  async runs(ownerId: string, scheduleId: string, opts: { limit?: number; before?: string } = {}) {
    const schedule = await this.prisma.schedule.findFirst({ where: { id: scheduleId, ownerId }, select: { id: true } });
    if (!schedule) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'No such schedule.' });
    const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 200);
    const before = opts.before ? new Date(opts.before) : null;
    const rows = await this.prisma.scheduleRun.findMany({
      where: { scheduleId, ...(before && !Number.isNaN(before.getTime()) ? { plannedAt: { lt: before } } : {}) },
      orderBy: [{ plannedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return { runs: rows.map(scheduleRunView) };
  }

  /**
   * The owner's cards: `GET /api/schedule-requests`, PENDING by default. A run's request to widen its envelope is one
   * of them (askedBy RUN): the card the owner is waiting on.
   */
  async requests(ownerId: string, filter: { state?: string; kind?: string; sessionId?: string } = {}) {
    const state = (filter.state ?? 'PENDING').toUpperCase() as ScheduleChangeRequestState;
    if (filter.state !== 'all' && !REQUEST_STATES.includes(state)) badState('state', filter.state!, [...REQUEST_STATES, 'all']);
    const kind = filter.kind?.toUpperCase() as ScheduleChangeRequestKind | undefined;
    if (kind && kind !== 'CREATE' && kind !== 'UPDATE') badState('kind', filter.kind!, ['CREATE', 'UPDATE']);
    const rows = await this.prisma.scheduleChangeRequest.findMany({
      where: {
        ownerId,
        ...(filter.state === 'all' ? {} : { state }),
        ...(kind ? { kind } : {}),
        ...(filter.sessionId ? { askedBySessionId: filter.sessionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { requests: await scheduleCardViews(this.prisma, ownerId, rows, this.now(), this.gate) };
  }

  async request(ownerId: string, requestId: string) {
    const row = await this.prisma.scheduleChangeRequest.findFirst({ where: { id: requestId, ownerId } });
    if (!row) throw new NotFoundException({ code: 'SCHEDULE_REQUEST_NOT_FOUND', message: 'No such schedule request.' });
    const [card] = await scheduleCardViews(this.prisma, ownerId, [row], this.now(), this.gate);
    return card;
  }

  /**
   * The Scheduled page's drafts (§8.1): every PENDING create card of the account, each naming the session that put it
   * up, so its inspector can offer Create, Not now and Open conversation.
   */
  async drafts(ownerId: string) {
    const { requests } = await this.requests(ownerId, { state: 'PENDING', kind: 'CREATE' });
    return { drafts: requests };
  }

  /**
   * What one session put up (§9.2 "Sessions"): the cards it asked for, and the records of the changes it made with
   * Undo. A client draws them where the session's tool calls are. A scheduled run's session also gets its run (and
   * through it the schedule), however old, so its crumb, strip and report need nothing else to find it.
   */
  async sessionCards(ownerId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true, runSource: true, scheduleRunId: true, changeScheduleId: true, scheduleChangeOpening: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const [{ requests }, revisions, run] = await Promise.all([
      this.requests(ownerId, { state: 'all', sessionId }),
      this.prisma.scheduleRevision.findMany({
        where: { sessionId, schedule: { ownerId } },
        orderBy: { createdAt: 'asc' },
        take: 200,
        include: { schedule: { select: { id: true, title: true } } },
      }),
      session.runSource === 'SCHEDULE' && session.scheduleRunId
        ? this.prisma.scheduleRun.findFirst({ where: { id: session.scheduleRunId, schedule: { ownerId } } })
        : null,
    ]);
    const [undoneBy, runStatus] = await Promise.all([
      this.undoneBy(revisions.map((r) => ({ scheduleId: r.scheduleId, revision: r.revision }))),
      run ? this.runStatus(sessionId, run) : null,
    ]);
    return {
      run: run ? scheduleRunView(run) : null,
      runStatus,
      // The opening it was drawn with keeps the schedule's id even once the schedule is deleted (the column is SET NULL).
      change: session.scheduleChangeOpening ? (session.scheduleChangeOpening as unknown as ScheduleChangeOpening) : null,
      cards: requests,
      records: revisions.map((r) =>
        scheduleRecordView(r.schedule.id, r.schedule.title, r, undoneBy.get(`${r.scheduleId}:${r.revision}`) ?? null)),
    };
  }

  /**
   * Where a run stands for one of its sessions (board docs/mocks/scheduled-run-not-started ②③④): every try it made
   * (the sessions that name it, oldest first) and whether each reached its engine — its first turn delivered, as the
   * run's own watch pass reads it (ScheduleRunsService.reconcileRun) — when it gave up, its next try, the schedule's
   * next run, and, while a full runner, run or batch holds its current session, that gate and the deadline it waits to.
   */
  private async runStatus(sessionId: string, run: ScheduleRun): Promise<ScheduleRunSessionStatus> {
    const [sessions, schedule] = await Promise.all([
      this.prisma.session.findMany({
        where: { scheduleRunId: run.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, createdAt: true, startedAt: true },
      }),
      this.prisma.schedule.findUniqueOrThrow({
        where: { id: run.scheduleId },
        select: { rule: true, timezone: true, nextDueAt: true },
      }),
    ]);
    const delivered = sessions.length === 0
      ? []
      : await this.prisma.conversationTurn.findMany({
          where: {
            OR: sessions.map((s) => ({ sessionId: s.id, clientTurnId: openingTurnKey(s.id) })),
            deliveredAt: { not: null },
          },
          select: { sessionId: true },
        });
    const reached = new Set(delivered.map((t) => t.sessionId));
    const tries: ScheduleRunTry[] = sessions.map((s) => ({
      sessionId: s.id,
      startedAt: s.createdAt.toISOString(),
      claimed: s.startedAt !== null,
      reachedEngine: reached.has(s.id),
    }));
    const index = tries.findIndex((t) => t.sessionId === sessionId);
    const ended = run.state === 'MISSED' || run.state === 'CANCELLED' || run.state === 'SKIPPED';
    const gate = run.state === 'RUNNING' && run.sessionId && !reached.has(run.sessionId)
      ? await sessionCapacityGate(this.prisma, run.sessionId)
      : null;
    return {
      tries,
      thisTry: index < 0 ? null : index + 1,
      gaveUpAt: ended && tries.every((t) => !t.reachedEngine) ? run.endedAt?.toISOString() ?? null : null,
      notBeforeAt: run.state === 'QUEUED' ? run.notBeforeAt?.toISOString() ?? null : null,
      nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
      queue: gate
        ? {
            queuedReason: gate.reason,
            queuedActive: gate.active,
            queuedLimit: gate.limit,
            queuedHeldByJobs: gate.heldByJobs,
            since: gate.since.toISOString(),
            deadline: new Date(scheduleRunDeadline(schedule, run)).toISOString(),
          }
        : null,
    };
  }

  private async undoneBy(keys: Array<{ scheduleId: string; revision: number }>): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();
    const rows = await this.prisma.scheduleRevision.findMany({
      where: { scheduleId: { in: [...new Set(keys.map((k) => k.scheduleId))] }, undoOfRevision: { not: null } },
      select: { scheduleId: true, revision: true, undoOfRevision: true },
    });
    return new Map(rows.map((r) => [`${r.scheduleId}:${r.undoOfRevision}`, r.revision]));
  }

  // -----------------------------------------------------------------------------------------------------------------
  // The answers of the write doors
  // -----------------------------------------------------------------------------------------------------------------

  async createAnswer(ownerId: string, result: ScheduleCreateResult) {
    if (result.outcome === 'CREATED') return { outcome: 'CREATED' as const, schedule: await this.rowView(ownerId, result.schedule) };
    if (result.outcome === 'EXISTS') {
      const schedule = await this.rowView(ownerId, result.schedule);
      return { outcome: 'EXISTS' as const, scheduled: false, note: SCHEDULE_EXISTS_NOTE, scheduleId: schedule.id, schedule };
    }
    const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now(), this.gate);
    return { outcome: 'PENDING' as const, scheduled: false, note: SCHEDULE_PENDING_CREATE_NOTE, card };
  }

  async updateAnswer(ownerId: string, result: ScheduleUpdateAnswer) {
    const kept = result.intentKept ? ` ${SCHEDULE_INTENT_KEPT_NOTE}` : '';
    const intentKept = result.intentKept ? { intentKept: true as const } : {};
    if (result.outcome === 'PENDING') {
      const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now(), this.gate);
      return { outcome: 'PENDING' as const, changed: false, note: SCHEDULE_PENDING_UPDATE_NOTE + kept, ...intentKept, card };
    }
    const schedule = await this.rowView(ownerId, result.schedule);
    if (result.outcome === 'UNCHANGED') {
      return { outcome: 'UNCHANGED' as const, changed: false, ...(kept ? { note: kept.trim() } : {}), ...intentKept, schedule };
    }
    return {
      outcome: 'APPLIED' as const,
      changed: true,
      note: SCHEDULE_RECORD_NOTE + kept,
      ...intentKept,
      schedule,
      readBack: scheduleReadBack(result.schedule),
      record: await this.record(result.schedule, result.revision),
    };
  }

  async decisionAnswer(ownerId: string, result: ScheduleDecisionResult) {
    const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now(), this.gate);
    return {
      outcome: result.outcome,
      card,
      schedule: result.schedule ? await this.rowView(ownerId, result.schedule) : null,
    };
  }

  /** A control's answer: the schedule as it is now, with the record of the revision it wrote. */
  async controlAnswer(ownerId: string, schedule: Schedule) {
    return { schedule: await this.rowView(ownerId, schedule), record: await this.record(schedule, schedule.revision) };
  }

  async rowView(ownerId: string, schedule: Schedule) {
    return scheduleView(
      schedule,
      await workspaceNames(this.prisma, ownerId, [schedule.workspaceId]),
      await scheduleViewNames(this.prisma, ownerId, [schedule]),
    );
  }

  private async record(schedule: Schedule, revision: number) {
    const row = await this.prisma.scheduleRevision.findUnique({
      where: { scheduleId_revision: { scheduleId: schedule.id, revision } },
    });
    return row ? scheduleRecordView(schedule.id, schedule.title, row, null) : null;
  }
}
