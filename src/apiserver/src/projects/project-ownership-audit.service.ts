/**
 * Unit L6: the recovery scan — the one that finds the mis-filings nobody has tried to run yet.
 *
 * The gate refuses a mis-filed task at the moment something starts it. That is enough to stop the
 * work and not enough to TELL anyone: a task sitting OPEN in the wrong project trips no gate, and
 * it is still counting towards that project's goal, still in its liveness picture, still in what
 * its acceptance will be judged on. So there has to be a pass that looks without being asked.
 *
 * WHAT IT WRITES, AND WHY THAT IS ALL
 * -----------------------------------
 * It re-arms the loop and stops — `ProjectFailureRecoveryService`'s rule, and for the same reason
 * §7.8 and §12.3 both give: the turn, the decision, the idempotency key and the blocker row are the
 * control loop's, and a second writer of those is a second materializer. §11.4's detector
 * (`ownershipMismatchConditions`) is what raises `PROJECT_OWNERSHIP_MISMATCH`, planned and keyed by
 * exactly the code that plans and keys every other blocker. This scan's whole job is to make sure
 * a pass HAPPENS.
 *
 * Not a fourth wake path (§10.2 W1): it is not a timer. It runs once at boot and writes
 * `project_runtime.next_wake_at` — the same column §10.4 writes, picked up by the same scheduled
 * wake W1 already counts.
 *
 * IDEMPOTENCE (AC4)
 * -----------------
 * Structural, not promised, and inherited whole from the failure scan:
 *
 *   - the UPDATE's own predicate excludes a project whose wake is already at or before `now`, so a
 *     second run performs no write at all rather than a write that computes the same value;
 *   - it only ever moves a wake EARLIER;
 *   - it writes nothing else — no action, no blocker, no decision, no event, and above all no TASK.
 *     The scan never files a replacement, so running it twice cannot file two. Replacements exist
 *     only where a person asked for one, and 0156's partial unique index bounds even that at one.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { decideTaskOwnership } from './project-ownership-gate';
import { misfiledTasksQuery, type MisfiledTaskRow } from './project-ownership-read';

/**
 * How many offenders one scan reads. A bound rather than a page loop, because the answer on a
 * healthy deployment is zero and on an unhealthy one the useful information is "there are at least
 * this many, go and look" — not a background job walking a million rows at boot. When it is hit,
 * `truncated` says so out loud rather than the scan quietly reporting a smaller problem.
 */
export const OWNERSHIP_AUDIT_SCAN_LIMIT = 500;

export interface ProjectOwnershipAuditOutcome {
  /** Mis-filed tasks this scan saw, Base62. */
  misfiled: string[];
  /** Projects whose wake it actually moved earlier, so §11.4 raises the rows. */
  rearmed: string[];
  /** Holding an offender but mid-pass: the holder publishes its own wake, so this write would be
   *  lost. Reported rather than dropped, and the one-shot latch reads it. */
  deferred: string[];
  /**
   * Projects holding an offender that NO reconcile pass will look at — settled, or with the
   * coordinator switched off. The gate still refuses to run those tasks; what they will not get is
   * a blocker row, because there is no loop to raise one. Named here rather than silently omitted:
   * a scan that reported only what it could fix would read as "everything is covered".
   */
  unwatched: string[];
  /** True when `OWNERSHIP_AUDIT_SCAN_LIMIT` cut the read short. */
  truncated: boolean;
}

const EMPTY: ProjectOwnershipAuditOutcome = {
  misfiled: [], rearmed: [], deferred: [], unwatched: [], truncated: false,
};

@Injectable()
export class ProjectOwnershipAuditService implements OnModuleInit {
  private readonly log = new Logger(ProjectOwnershipAuditService.name);
  private ran = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Never awaited and never load-bearing, for the failure scan's reason: a deployment must boot
    // whether or not a historical mis-filing can be surfaced, and the scan's whole effect is an
    // earlier wake. The gate is what stops the work, and it does not depend on this having run.
    void this.auditOnce().catch((cause: unknown) => {
      this.log.error(`Project ownership audit scan failed: ${
        cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  /** Once per process, where "once" means "once successfully and with nothing deferred". */
  async auditOnce(now = new Date()): Promise<ProjectOwnershipAuditOutcome> {
    if (this.ran) return EMPTY;
    const outcome = await this.scan(now);
    this.ran = outcome.deferred.length === 0;
    return outcome;
  }

  /** The scan itself, re-runnable. Everything it does is idempotent; see the file comment. */
  async scan(now = new Date()): Promise<ProjectOwnershipAuditOutcome> {
    const rows = await this.prisma.$queryRaw<MisfiledTaskRow[]>(
      misfiledTasksQuery({ limit: OWNERSHIP_AUDIT_SCAN_LIMIT + 1 }),
    );
    const truncated = rows.length > OWNERSHIP_AUDIT_SCAN_LIMIT;
    const scanned = truncated ? rows.slice(0, OWNERSHIP_AUDIT_SCAN_LIMIT) : rows;
    // The SQL narrows; the DECISION is still the same function every start path uses. Re-deciding
    // in TypeScript is not belt-and-braces — the index predicate cannot know about an approved
    // crossing, and a scan that raised blockers on lawful handoffs would teach people to ignore it.
    const offenders = scanned.filter((row) => decideTaskOwnership({
      taskId: row.taskId,
      projectId: row.projectId,
      creatorCoordinatorProjectId: row.creatorCoordinatorProjectId,
      creatorCoordinatorGeneration: row.creatorCoordinatorGeneration,
      approvedCrossing: row.approvedCrossing,
    }).refuses
      // A task that already reached an end is not work anybody is waiting on, and §11.4's detector
      // will not raise a row for it either. Waking a project for one would be a wake with nothing
      // to do, every boot, for ever.
      && row.status !== 'DONE' && row.status !== 'CANCELLED');
    if (offenders.length === 0) return { ...EMPTY, truncated };

    const projectIds = [...new Set(offenders.map((row) => row.projectId!))];
    const ids = Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`));

    // The same two predicates the failure scan uses, and they carry the same two properties: a
    // project already due keeps its own earlier instant, and a project mid-pass is left to its
    // holder rather than having a lost write performed against it.
    const rearmed = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      UPDATE "project_runtime" r
         SET "next_wake_at" = ${now},
             "next_wake_reason" = 'recovery: task filed by another project''s coordinator',
             "updated_at" = ${now}
        FROM "project" p
       WHERE p."id" = r."project_id"
         AND r."project_id" IN (${ids})
         AND p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED'
         AND (r."next_wake_at" IS NULL OR r."next_wake_at" > ${now})
         AND r."lease_holder" IS NULL
      RETURNING r."project_id" AS "projectId"
    `);
    const deferred = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      SELECT r."project_id" AS "projectId" FROM "project_runtime" r
       WHERE r."project_id" IN (${ids}) AND r."lease_holder" IS NOT NULL
    `);
    const unwatched = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      SELECT p."id" AS "projectId" FROM "project" p
       LEFT JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE p."id" IN (${ids})
         AND (p."status" <> 'OPEN' OR p."coordinator_enabled" = false
              OR r."project_id" IS NULL OR r."run_state" = 'SETTLED')
    `);

    if (offenders.length > 0) {
      this.log.warn(
        `Project ownership audit found ${offenders.length} task(s) counting towards a project `
        + `their filing coordinator did not coordinate; re-armed ${rearmed.length} project(s)`
        + (truncated ? `, and stopped reading at ${OWNERSHIP_AUDIT_SCAN_LIMIT}` : ''),
      );
    }
    if (unwatched.length > 0) {
      this.log.warn(
        `Project ownership audit found offenders in ${unwatched.length} project(s) no coordinator `
        + 'pass will look at: those tasks are refused at every start path but will get no blocker',
      );
    }
    return {
      misfiled: offenders.map((row) => uuidToBase62(row.taskId)),
      rearmed: rearmed.map((row) => uuidToBase62(row.projectId)),
      deferred: deferred.map((row) => uuidToBase62(row.projectId)),
      unwatched: unwatched.map((row) => uuidToBase62(row.projectId)),
      truncated,
    };
  }
}
