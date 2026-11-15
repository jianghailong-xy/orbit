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
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Schedule, ScheduleChangeRequestKind, ScheduleChangeRequestState, ScheduleState } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  scheduleCardViews,
  scheduleFindingView,
  scheduleRecordView,
  scheduleRunView,
  scheduleUsageThisMonth,
  scheduleViewNames,
  scheduleView,
  workspaceNames,
} from './schedule-views';
import type { ScheduleCreateResult, ScheduleDecisionResult, ScheduleUpdateResult } from './schedules.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
    };
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
    const [names, viewNames, runs, findings, revisions, pending, creation, usage] = await Promise.all([
      workspaceNames(tx, ownerId, [schedule.workspaceId, schedule.envelopeWorkspaceId]),
      scheduleViewNames(tx, ownerId, [schedule]),
      tx.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'desc' }, take: 10 }),
      tx.scheduleFinding.findMany({ where: { scheduleId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      tx.scheduleRevision.findMany({ where: { scheduleId }, orderBy: { revision: 'desc' }, take: 50 }),
      tx.scheduleChangeRequest.findMany({ where: { scheduleId, state: 'PENDING' }, orderBy: { createdAt: 'desc' } }),
      tx.scheduleChangeRequest.findFirst({ where: { scheduleId, kind: 'CREATE', state: 'ALLOWED' } }),
      scheduleUsageThisMonth(tx, schedule, now),
    ]);
    const undone = new Map<number, number>();
    for (const r of revisions) if (r.undoOfRevision !== null) undone.set(r.undoOfRevision, r.revision);
    const ended = runs.find((r) => r.endedAt !== null) ?? null;
    const proposed = creation?.proposed as { readBack?: string | null } | undefined;
    return {
      schedule: scheduleView(schedule, names, viewNames),
      readBack: proposed?.readBack ?? schedule.intent,
      lastRun: ended ? scheduleRunView(ended) : null,
      recentRuns: runs.map(scheduleRunView),
      findings: findings.map(scheduleFindingView),
      usage,
      history: revisions.map((r) => scheduleRecordView(schedule.id, schedule.title, r, undone.get(r.revision) ?? null)),
      pendingCards: await scheduleCardViews(tx, ownerId, pending, now),
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
    return { requests: await scheduleCardViews(this.prisma, ownerId, rows, this.now()) };
  }

  async request(ownerId: string, requestId: string) {
    const row = await this.prisma.scheduleChangeRequest.findFirst({ where: { id: requestId, ownerId } });
    if (!row) throw new NotFoundException({ code: 'SCHEDULE_REQUEST_NOT_FOUND', message: 'No such schedule request.' });
    const [card] = await scheduleCardViews(this.prisma, ownerId, [row], this.now());
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
      select: { id: true, runSource: true, scheduleRunId: true },
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
    const undoneBy = await this.undoneBy(revisions.map((r) => ({ scheduleId: r.scheduleId, revision: r.revision })));
    return {
      run: run ? scheduleRunView(run) : null,
      cards: requests,
      records: revisions.map((r) =>
        scheduleRecordView(r.schedule.id, r.schedule.title, r, undoneBy.get(`${r.scheduleId}:${r.revision}`) ?? null)),
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
    const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now());
    return { outcome: 'PENDING' as const, scheduled: false, note: SCHEDULE_PENDING_CREATE_NOTE, card };
  }

  async updateAnswer(ownerId: string, result: ScheduleUpdateResult) {
    if (result.outcome === 'PENDING') {
      const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now());
      return { outcome: 'PENDING' as const, changed: false, note: SCHEDULE_PENDING_UPDATE_NOTE, card };
    }
    const schedule = await this.rowView(ownerId, result.schedule);
    if (result.outcome === 'UNCHANGED') return { outcome: 'UNCHANGED' as const, changed: false, schedule };
    return { outcome: 'APPLIED' as const, changed: true, note: SCHEDULE_RECORD_NOTE, schedule, record: await this.record(result.schedule, result.revision) };
  }

  async decisionAnswer(ownerId: string, result: ScheduleDecisionResult) {
    const [card] = await scheduleCardViews(this.prisma, ownerId, [result.request], this.now());
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
