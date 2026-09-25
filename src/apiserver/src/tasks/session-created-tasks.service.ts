import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import {
  SESSION_CREATED_TASKS_DEFAULT_LIMIT,
  SESSION_CREATED_TASKS_MAX_LIMIT,
  type SessionCreatedTaskRow,
  type SessionCreatedTasks,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far a supersession chain is followed before the row settles for the task it got to. */
export const SESSION_CREATED_TASKS_MAX_HOPS = 10;

/**
 * Where a row sorts, by the pill it shows: live state first, as `TaskStatusPill` draws it, and the
 * stored status otherwise. Failed → Running → Queued → the rest of the unfinished → Done →
 * Cancelled.
 */
const RUNNING_GROUP = 1;
const QUEUED_GROUP = 2;
const STATUS_GROUP: Readonly<Record<TaskStatus, number>> = {
  [TaskStatus.FAILED]: 0,
  [TaskStatus.OPEN]: 3,
  [TaskStatus.IN_PROGRESS]: 3,
  [TaskStatus.DONE]: 4,
  [TaskStatus.CANCELLED]: 5,
};

function groupOf(row: { status: TaskStatus; running: boolean; queued: boolean }): number {
  if (row.running) return RUNNING_GROUP;
  if (row.queued) return QUEUED_GROUP;
  return STATUS_GROUP[row.status];
}

/** `STATUS_GROUP` in SQL, for the rows nothing is running or queued on. Constants, not input. */
const STATUS_GROUP_SQL = Prisma.raw(
  `CASE l."status" ${Object.entries(STATUS_GROUP)
    .map(([status, group]) => `WHEN '${status}' THEN ${group}`)
    .join(' ')} END`,
);

/** A task another one took over, and names: the only kind whose chain is walked. */
const takenOver = (alias: string) =>
  Prisma.raw(`(${alias}."terminal_reason" = 'SUPERSEDED' AND ${alias}."superseded_by_task_id" IS NOT NULL)`);

interface PickedRow {
  total: number;
  failed: number;
  done: number;
  /** Null only on the one row an empty session answers with, which carries the zero tallies. */
  id: string | null;
  replaces_id: string | null;
}

/**
 * `GET /sessions/:id/created-tasks`: the tasks a session's agent created, as the "Tasks created
 * here" row above its composer draws them. `SessionCreatedTasks` (@orbit/shared) says what a row
 * is; this is how it is read without holding the session's tasks in memory — one pipeline session
 * created 109,874.
 *
 *  - The tallies are aggregates, in the statement.
 *  - Only a task that was taken over has its chain walked, and the walk stops after
 *    SESSION_CREATED_TASKS_MAX_HOPS; a successor that was deleted empties the pointer (SET NULL),
 *    so that task simply draws itself.
 *  - `running`/`queued` are `TasksService.withRunning`'s, the task list's and the link card's. The
 *    statement only has to know which rows COULD be live — the ones with a PENDING or RUNNING
 *    session, as many as the owner has runs live or queued, not as many as the session has tasks —
 *    and returns all of those plus the first `limit` of the rest in status order. Every other row
 *    has no live session, so its group is its status, and the page is exact once the live ones are
 *    placed by the flags.
 */
@Injectable()
export class SessionCreatedTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  async read(ownerId: string, sessionId: string, rawLimit?: string): Promise<SessionCreatedTasks<Date>> {
    const limit = rawLimit === undefined ? SESSION_CREATED_TASKS_DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_CREATED_TASKS_MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer from 1 to ${SESSION_CREATED_TASKS_MAX_LIMIT}`);
    }
    // Another account's session and one that does not exist are the same answer.
    const session = UUID_RE.test(sessionId)
      ? await this.prisma.session.findFirst({ where: { id: sessionId, ownerId }, select: { id: true } })
      : null;
    if (!session) throw new NotFoundException('session not found');

    const picked = await this.prisma.$queryRaw<PickedRow[]>(Prisma.sql`
      WITH RECURSIVE
      -- Started from the task table rather than from the session's rows, so the planner sees the
      -- handful it is (the supersession pointer's own index) and not a guess at half the session.
      -- On the 110k-task session that guess priced the statement into JIT: 128ms of compiling.
      walk ("origin_id", "origin_created_at", "node_id", "depth") AS (
        SELECT t."id", t."created_at", t."superseded_by_task_id", 1
          FROM "task" t
         WHERE t."owner_id" = ${ownerId}::uuid
           AND t."creator_session_id" = ${sessionId}::uuid
           AND ${takenOver('t')}
        UNION ALL
        SELECT w."origin_id", w."origin_created_at", n."superseded_by_task_id", w."depth" + 1
          FROM walk w
          JOIN "task" n ON n."id" = w."node_id"
         WHERE ${takenOver('n')}
           AND w."depth" < ${SESSION_CREATED_TASKS_MAX_HOPS}::int
      ),
      -- Each chain's end, once, with the earliest-created task of this session that reached it.
      -- 0128's trigger keeps a chain inside one owner and free of cycles; the hop limit is here
      -- for the length.
      reached AS (
        SELECT DISTINCT ON (e."head_id") e."head_id", e."origin_id" AS "replaces_id"
          FROM (SELECT DISTINCT ON (w."origin_id")
                       w."origin_id", w."origin_created_at", w."node_id" AS "head_id"
                  FROM walk w
                 ORDER BY w."origin_id", w."depth" DESC) e
         ORDER BY e."head_id", e."origin_created_at", e."origin_id"
      ),
      line AS (
        -- A task of this session that nothing took over is its own row — and may itself be the end
        -- another of this session's tasks reached.
        SELECT t."id", t."status", t."created_at", r."replaces_id"
          FROM "task" t
          LEFT JOIN reached r ON r."head_id" = t."id"
         WHERE t."owner_id" = ${ownerId}::uuid
           AND t."creator_session_id" = ${sessionId}::uuid
           AND ${takenOver('t')} IS NOT TRUE
        UNION ALL
        -- Every other end is a row of its own.
        SELECT t."id", t."status", t."created_at", r."replaces_id"
          FROM reached r
          JOIN "task" t ON t."id" = r."head_id"
         WHERE t."creator_session_id" IS DISTINCT FROM ${sessionId}::uuid
            OR ${takenOver('t')} IS TRUE
      ),
      -- The tasks withRunning could call running or queued: the same sessions it groups.
      busy AS (
        SELECT DISTINCT s."task_id"
          FROM "session" s
         WHERE s."owner_id" = ${ownerId}::uuid
           AND s."task_id" IS NOT NULL
           AND s."status" IN (${RunStatus.PENDING}::run_status, ${RunStatus.RUNNING}::run_status)
      ),
      tally AS (
        SELECT count(*)::int AS "total",
               (count(*) FILTER (WHERE l."status" = ${TaskStatus.FAILED}::task_status))::int AS "failed",
               (count(*) FILTER (WHERE l."status" = ${TaskStatus.DONE}::task_status))::int AS "done"
          FROM line l
      ),
      picked AS (
        SELECT l."id", l."replaces_id"
          FROM line l
         WHERE l."id" IN (SELECT b."task_id" FROM busy b)
        UNION ALL
        (SELECT l."id", l."replaces_id"
           FROM line l
          WHERE l."id" NOT IN (SELECT b."task_id" FROM busy b)
          ORDER BY ${STATUS_GROUP_SQL}, l."created_at" DESC, l."id" DESC
          LIMIT ${limit}::int)
      )
      SELECT y."total", y."failed", y."done", p."id", p."replaces_id"
        FROM tally y
        LEFT JOIN picked p ON true`);

    const { total, failed, done } = picked[0];
    const lines = picked.filter((row): row is PickedRow & { id: string } => row.id !== null);
    const named = await this.prisma.task.findMany({
      where: {
        ownerId,
        id: { in: [...new Set(lines.flatMap((row) => (row.replaces_id ? [row.id, row.replaces_id] : [row.id])))] },
      },
      select: { id: true, title: true, status: true, createdAt: true, projectId: true },
    });
    const byId = new Map(named.map((task) => [task.id, task]));
    // A task deleted since the statement ran is simply not drawn.
    const rows = lines.flatMap((line) => {
      const task = byId.get(line.id);
      if (!task) return [];
      const replaced = line.replaces_id ? byId.get(line.replaces_id) : undefined;
      return [{ ...task, replaces: replaced ? { id: replaced.id, title: replaced.title } : null }];
    });

    const live = await this.tasks.withRunning(ownerId, rows, true);
    const items: SessionCreatedTaskRow<Date>[] = live
      .sort((a, b) =>
        groupOf(a) - groupOf(b)
        || b.createdAt.getTime() - a.createdAt.getTime()
        || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        running: row.running,
        queued: row.queued,
        createdAt: row.createdAt,
        projectId: row.projectId,
        replaces: row.replaces,
      }));

    const projectIds = [...new Set(items.flatMap((row) => (row.projectId ? [row.projectId] : [])))];
    const projects = projectIds.length
      ? await this.prisma.project.findMany({
          where: { ownerId, id: { in: projectIds } },
          select: { id: true, title: true },
        })
      : [];
    const projectOrder = new Map(projectIds.map((id, index) => [id, index]));
    projects.sort((a, b) => projectOrder.get(a.id)! - projectOrder.get(b.id)!);

    return {
      total,
      // Every row that can be running was among `lines`: the statement returned all of them.
      running: live.filter((row) => row.running).length,
      failed,
      done,
      items,
      projects,
    };
  }
}
