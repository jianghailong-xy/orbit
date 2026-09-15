import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  RunEventType,
  TASK_PROGRESS_LIMITS,
  type TaskProgressReport,
  type TaskProgressReportResult,
  type TaskProgressView,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * A Task's structured progress (docs/watch-contract.md §12): the one door that writes `task_progress`,
 * and its read.
 *
 * WHAT PROGRESS IS
 * A position the reporter states — a phase, a count, a total — and a message for whoever reads it. It
 * is never derived from anything else: not from a transcript, not from a shell's output, not from the
 * wording of a message. The Watch leaves read the position and when it last changed; none reads the
 * message.
 *
 * REVISION AND lastProgressAt
 * Every accepted change advances `revision`, and a report carrying `expectedRevision` is a
 * compare-and-set on it. `last_progress_at` moves only when the position changes: a message alone is a
 * change but not progress, and a report repeated verbatim is neither, so a reporter that keeps saying
 * "still working" is still seen to stall.
 *
 * EPOCHS
 * The row belongs to the Task's current lifecycle epoch. Reopening a Task — any write that takes it from
 * DONE, CANCELLED or FAILED back to OPEN or IN_PROGRESS — starts the next epoch with nothing reported, in
 * the `task_progress_epoch_advance` trigger rather than here, because that trigger is the one place every
 * such write passes. The revision advances with the epoch, so a report still aimed at the old one loses
 * its compare-and-set.
 *
 * LOCKS
 * The Task row FOR KEY SHARE (rank 50), which a status write's NO KEY UPDATE does not wait on, then the
 * Task's progress row FOR UPDATE (rank 60), made first if the Task never had one. Reports on one Task
 * therefore decide one at a time, each from what the one before it wrote.
 */

/** The statuses a Task can make progress in. */
const OPEN_STATUSES: readonly string[] = ['OPEN', 'IN_PROGRESS'];

interface ProgressRow {
  lifecycleEpoch: number;
  epochStartedAt: Date | null;
  phase: string | null;
  current: number | null;
  total: number | null;
  message: string | null;
  revision: number;
  lastProgressAt: Date | null;
  updatedAt: Date | null;
}

type Reported = Pick<ProgressRow, 'phase' | 'current' | 'total' | 'message'>;

@Injectable()
export class TaskProgressService {
  private readonly logger = new Logger(TaskProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** The Task's progress in its current lifecycle epoch; a Task that never reported reads as epoch 0 with nothing in it. */
  async get(ownerId: string, taskId: string): Promise<TaskProgressView> {
    const view = await readTaskProgress(this.prisma, ownerId, taskId);
    if (!view) throw new NotFoundException('task not found');
    return view;
  }

  /**
   * Apply one report. Each field it names replaces that field, `null` clears one, an absent one is kept;
   * what results must still be a position. A report that changes nothing writes nothing.
   */
  async report(ownerId: string, taskId: string, report: TaskProgressReport): Promise<TaskProgressReportResult> {
    const fields = reportedFields(report);
    const outcome = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [task] = await tx.$queryRaw<Array<{ status: string; createdAt: Date }>>`
          SELECT "status"::text AS "status", "created_at" AT TIME ZONE 'UTC' AS "createdAt"
          FROM "task"
          WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR KEY SHARE`;
        if (!task) throw new NotFoundException('task not found');
        if (!OPEN_STATUSES.includes(task.status)) {
          throw new ConflictException({
            code: 'TASK_NOT_OPEN',
            status: task.status,
            message: `a ${task.status} task makes no progress: reopening it starts a new lifecycle epoch to report into`,
          });
        }
        await tx.$executeRaw`
          INSERT INTO "task_progress" ("task_id") VALUES (${taskId}::uuid)
          ON CONFLICT ("task_id") DO NOTHING`;
        const [current] = await tx.$queryRaw<ProgressRow[]>`
          SELECT "lifecycle_epoch" AS "lifecycleEpoch", "epoch_started_at" AS "epochStartedAt", "phase",
                 "current", "total", "message", "revision", "last_progress_at" AS "lastProgressAt",
                 "updated_at" AS "updatedAt"
          FROM "task_progress"
          WHERE "task_id" = ${taskId}::uuid
          FOR UPDATE`;
        if (report.expectedRevision !== undefined && report.expectedRevision !== current.revision) {
          throw new ConflictException({
            code: 'PROGRESS_REVISION_CONFLICT',
            revision: current.revision,
            lifecycleEpoch: current.lifecycleEpoch,
            message: `the report expected revision ${report.expectedRevision} and the progress is at revision ${
              current.revision}: read it again before reporting`,
          });
        }
        const next: Reported = {
          phase: current.phase,
          current: current.current,
          total: current.total,
          message: current.message,
          ...fields,
        };
        assertPosition(next);
        const progressed = next.phase !== current.phase || next.current !== current.current || next.total !== current.total;
        const changed = progressed || next.message !== current.message;
        if (!changed) return { row: current, taskCreatedAt: task.createdAt, changed, progressed };
        const [written] = await tx.$queryRaw<ProgressRow[]>`
          UPDATE "task_progress"
          SET "phase" = ${next.phase}, "current" = ${next.current}, "total" = ${next.total},
              "message" = ${next.message},
              "revision" = "revision" + 1,
              "last_progress_at" = CASE WHEN ${progressed}::boolean THEN now() ELSE "last_progress_at" END,
              "updated_at" = now()
          WHERE "task_id" = ${taskId}::uuid
          RETURNING "lifecycle_epoch" AS "lifecycleEpoch", "epoch_started_at" AS "epochStartedAt", "phase",
                    "current", "total", "message", "revision", "last_progress_at" AS "lastProgressAt",
                    "updated_at" AS "updatedAt"`;
        return { row: written, taskCreatedAt: task.createdAt, changed, progressed };
      },
      loggedRetry(this.logger, 'tasks.reportProgress'),
    );
    if (outcome.changed) {
      // After the commit, and only a hint: the watches on this Task look again, and a client refetches it.
      this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [taskId], resync: false });
    }
    return {
      ...progressView(taskId, outcome.row, outcome.taskCreatedAt),
      changed: outcome.changed,
      progressed: outcome.progressed,
    };
  }
}

/**
 * The read behind `TaskProgressService.get`, for a reader that holds a prisma rather than the service:
 * the task detail (`TasksService.loadDetail`, what task_get returns) carries it as `progress`, so that
 * detail and task_progress_report's read answer from one query. Null for an id the owner lacks.
 */
export async function readTaskProgress(
  prisma: PrismaService,
  ownerId: string,
  taskId: string,
): Promise<TaskProgressView | null> {
  const [row] = await prisma.$queryRaw<Array<ProgressRow & { taskCreatedAt: Date }>>`
    SELECT t."created_at" AT TIME ZONE 'UTC' AS "taskCreatedAt",
           COALESCE(p."lifecycle_epoch", 0) AS "lifecycleEpoch", p."epoch_started_at" AS "epochStartedAt",
           p."phase", p."current", p."total", p."message", COALESCE(p."revision", 0) AS "revision",
           p."last_progress_at" AS "lastProgressAt", p."updated_at" AS "updatedAt"
    FROM "task" t
    LEFT JOIN "task_progress" p ON p."task_id" = t."id"
    WHERE t."id" = ${taskId}::uuid AND t."owner_id" = ${ownerId}::uuid`;
  return row ? progressView(taskId, row, row.taskCreatedAt) : null;
}

/** The fields a report names, each held to its own bounds; what they add up to is checked once merged. */
function reportedFields(report: TaskProgressReport): Partial<Reported> {
  const fields: Partial<Reported> = {};
  if (report.phase !== undefined) fields.phase = text(report.phase, 'phase', TASK_PROGRESS_LIMITS.maxPhaseChars);
  if (report.current !== undefined) fields.current = count(report.current, 'current', 0);
  if (report.total !== undefined) fields.total = count(report.total, 'total', 1);
  if (report.message !== undefined) fields.message = text(report.message, 'message', TASK_PROGRESS_LIMITS.maxMessageChars);
  if (report.expectedRevision !== undefined && !(Number.isInteger(report.expectedRevision) && report.expectedRevision >= 0)) {
    throw new BadRequestException('expectedRevision is the non-negative integer revision the report was based on');
  }
  return fields;
}

function text(value: unknown, field: string, max: number): string | null {
  // Counted in code points, as PostgreSQL's char_length counts the CHECK that holds the same bound.
  if (value === null || (typeof value === 'string' && value.length > 0 && [...value].length <= max)) return value;
  throw new BadRequestException(`${field} is a string of 1 to ${max} characters, or null to clear it`);
}

function count(value: unknown, field: string, min: number): number | null {
  if (value === null || (Number.isInteger(value) && (value as number) >= min && (value as number) <= TASK_PROGRESS_LIMITS.maxCount)) {
    return value as number | null;
  }
  throw new BadRequestException(`${field} is an integer from ${min} to ${TASK_PROGRESS_LIMITS.maxCount}, or null to clear it`);
}

/** What a report leaves behind is a position: a phase or a count, and a total only over a count it bounds. */
function assertPosition(position: Reported): void {
  if (position.phase === null && position.current === null) {
    throw new BadRequestException('progress is a position: a report leaves a phase, a current count, or both');
  }
  if (position.total !== null && position.current === null) {
    throw new BadRequestException('a total bounds a count: report current with it');
  }
  if (position.total !== null && position.current !== null && position.current > position.total) {
    throw new BadRequestException(`current ${position.current} is past total ${position.total}`);
  }
}

function progressView(taskId: string, row: ProgressRow, taskCreatedAt: Date): TaskProgressView {
  return {
    taskId,
    lifecycleEpoch: row.lifecycleEpoch,
    epochStartedAt: (row.epochStartedAt ?? taskCreatedAt).toISOString(),
    phase: row.phase,
    current: row.current,
    total: row.total,
    message: row.message,
    revision: row.revision,
    lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}
