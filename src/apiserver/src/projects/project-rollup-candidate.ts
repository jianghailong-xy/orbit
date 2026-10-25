import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { everyPrerequisiteDoneOrRetiredSql } from '../tasks/task-dependencies';
import { verificationSubjectSql } from './project-task-work-state';

/** How often `project_rollup_candidate` is replaced by the exact set it is a superset of. */
export const PROJECT_ROLLUP_CANDIDATE_REBUILD_MS = 10 * 60_000;
/** How often the service looks at the table between rebuilds. */
export const PROJECT_ROLLUP_CANDIDATE_TICK_MS = 60_000;
/**
 * Rows appended since the last rebuild that bring the next one forward. Ordinary work appends a
 * task or ten at a time; a bulk import appends every OPEN task it files, and until a rebuild each of
 * them is classified on every read — on a 20,000-task import a quarter of a second a read
 * (PostgreSQL 16, jit off, 2026-10-25), growing with the import.
 */
export const PROJECT_ROLLUP_CANDIDATE_GROWTH_LIMIT = 1_000;

/**
 * The project tasks whose `GET /projects` lane their stored status may not decide, exactly: OPEN
 * and past the READY guard, or a live verification gate row. `project_rollup_candidate` (0441) is a
 * superset of this, kept by its triggers; this is the set they are a superset OF.
 *
 * Spliced from the classifier's own predicates rather than spelled again, so the set cannot drift
 * from the lanes it stands for: `everyPrerequisiteDoneOrRetiredSql` is the guard the READY lane asks
 * first, and `verificationSubjectSql` is the gate test the AWAITING_VERIFICATION lane asks. A
 * CANCELLED or FAILED gate row is left out because those two lanes are decided before the gate is.
 */
export function projectRollupCandidateRowsSql(alias = 't'): string {
  return `SELECT ${alias}."owner_id", ${alias}."id" FROM "task" ${alias}
     WHERE ${alias}."project_id" IS NOT NULL
       AND ${alias}."status" = 'OPEN'::"task_status"
       AND ${everyPrerequisiteDoneOrRetiredSql(alias)}
    UNION
    SELECT ${alias}."owner_id", ${alias}."id" FROM "task" ${alias}
     WHERE ${alias}."project_id" IS NOT NULL
       AND (${verificationSubjectSql(alias)})
       AND ${alias}."status" NOT IN ('CANCELLED'::"task_status", 'FAILED'::"task_status")`;
}

/**
 * Replace `project_rollup_candidate` with exactly the rows it has to contain.
 *
 * The triggers only ever append, so the table grows by every task that once qualified; this is
 * what takes the ones that no longer do back out. ONE statement, so the DELETE and the INSERT read
 * the same snapshot, and that is the whole argument for why it cannot lose a row:
 *
 *  - a row the DELETE removes was written by a transaction committed before that snapshot, so the
 *    write that caused it is visible to the INSERT, which keeps the task if it still qualifies;
 *  - a row written by a transaction the snapshot does not see — still open, or committed after it —
 *    is invisible to the DELETE and stays.
 *
 * Two of these at once only duplicate rows, which the read folds. It takes no lock a Task or edge
 * writer waits for: the triggers insert new rows, and only this deletes.
 *
 * Owner-agnostic and as costly as one pass over the deployment's OPEN tasks (the cost the list
 * used to pay per request), which is why it runs on a timer and never on a read.
 */
export async function rebuildProjectRollupCandidates(prisma: PrismaService): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    WITH replaced AS (DELETE FROM "project_rollup_candidate")
    INSERT INTO "project_rollup_candidate" ("owner_id", "task_id")
    ${Prisma.raw(projectRollupCandidateRowsSql('t'))}`);
}

/**
 * Runs `rebuildProjectRollupCandidates` at boot, then every ten minutes — or at the next minute's
 * tick once more than `PROJECT_ROLLUP_CANDIDATE_GROWTH_LIMIT` rows have been appended since the last
 * one, so an import is not classified row by row for the rest of the ten minutes.
 */
@Injectable()
export class ProjectRollupCandidateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectRollupCandidateService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private rebuiltAt = 0;
  private rebuiltRows = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // At once, so the seed the migration wrote is replaced by the spliced predicates within
    // seconds of the first boot rather than ten minutes.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), PROJECT_ROLLUP_CANDIDATE_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A rebuild still running when the next tick comes is left to finish; a second one beside it
    // would only write the same rows twice.
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.rebuiltAt < PROJECT_ROLLUP_CANDIDATE_REBUILD_MS) {
        const [{ rows }] = await this.prisma.$queryRaw<Array<{ rows: number }>>`
          SELECT count(*)::int AS "rows" FROM "project_rollup_candidate"`;
        if (rows <= this.rebuiltRows + PROJECT_ROLLUP_CANDIDATE_GROWTH_LIMIT) return;
      }
      this.rebuiltRows = await rebuildProjectRollupCandidates(this.prisma);
      this.rebuiltAt = Date.now();
    } catch (e) {
      // Nothing is lost by a failed rebuild: the table keeps every row it had, which is still a
      // superset, and the next tick tries again.
      this.logger.error(`rebuild failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
