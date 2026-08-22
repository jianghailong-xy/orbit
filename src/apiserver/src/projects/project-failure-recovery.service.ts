import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one-shot recovery scan for failures that happened before anything could answer them
 * (v1.18, `PC-CX-66`).
 *
 * What is being recovered
 * -----------------------
 * §7.2's `TASK_FAILURE` and §7.6's delivery landed in units 26 and 27. Every failure that happened
 * BEFORE them followed the same path: `reclaimStalledTask(..., FAILED)` wrote the task, migration
 * 0117's trigger enqueued a `task.updated` signal, the loop consumed that signal — and the binary
 * consuming it had no rule that could produce a turn. §5.1 is the reason this cannot fix itself:
 * **an event is a signal, not a fact**. A consumed signal is gone; the world it pointed at is what
 * remains, and nothing re-emits it.
 *
 * For most of those projects the world is enough — §10.4 keeps a `PLANNING` project's clock at
 * 60s, so the first tick after a deploy re-derives the turn from the task row. The population this
 * scan exists for is the one where it is NOT: §10.4 N-null lets exactly one shape stop its own
 * clock (every open blocker `recovery = HUMAN` and already escalated), and §10.2 W4's backstop
 * deliberately does not fire for it — both correct, and together they mean a project holding one
 * escalated blocker also holds its pre-v1.17 failure forever, with `next_wake_at IS NULL` and
 * nothing that will ever look again.
 *
 * What it does, and what it deliberately does not
 * ----------------------------------------------
 * It re-arms the loop and stops. It does not build a decision, choose a reason, mint a key or write
 * a turn: §7.2's total order, TR1's episode identity and §8.2's permanent keys are the loop's, and
 * a second writer of those would be a second materializer — the one thing §7.8 and §12.3 both
 * refuse. So the recovery is "wake this project now"; the turn it produces is planned, keyed and
 * delivered by exactly the code that plans, keys and delivers every other one.
 *
 * Why it is not a fourth wake path (§10.2 W1)
 * -------------------------------------------
 * W1 counts CLOCKS, and calls a second timer a production incident by name. This is not a timer: it
 * runs once, at boot, and writes `project_runtime.next_wake_at` — which is the SAME column §10.4
 * writes and the SAME scheduled-wake path (W1's first) that then picks it up. Nothing here polls,
 * and nothing here reconciles.
 *
 * Idempotence (AC5)
 * -----------------
 * Three properties, all structural rather than promised:
 *
 *  - the UPDATE's own predicate excludes a row whose wake is already at or before `now`, so a
 *    second run performs **no write at all** — not a write that happens to compute the same value.
 *    That distinction is the whole of the property: `updated_at` is a real column that real readers
 *    (and `ORDER BY updated_at` queries) can see move, so "wrote the same value again" is still a
 *    side effect;
 *  - it only ever moves a wake EARLIER. Even when it does write, a project already due sooner keeps
 *    its own instant and its own reason;
 *  - it writes nothing else. No action row, no blocker, no decision, no event — so there is no key
 *    to collide, no counter to advance, and two apiservers booting together do the same single
 *    thing to the same column.
 *
 * The one-shot latch and the projects it could not answer
 * -------------------------------------------------------
 * A project being reconciled RIGHT NOW is skipped rather than written (the holder publishes
 * `next_wake_at` itself, under a fencing token, so this write would be lost). That makes "ran once"
 * and "answered everything" two different facts, and latching on the first would turn a lease held
 * for one second into a project that is never scanned again in this process's lifetime. So the
 * latch is set only when the scan DEFERRED nothing; a run that skipped a leased project leaves it
 * off, and the next call — the next boot, or an operator calling it — picks that project up.
 *
 * "Covered" is read from the ledger, not inferred: an `OPEN_COORDINATOR_TURN` row whose
 * `detail.turnFacts` contains this episode's `(taskId, dispatchAttempt)` — TF6's identity, the same
 * string `failureEpisodes` builds and `actionDetail` records.
 */
export interface ProjectFailureRecoveryOutcome {
  /** Projects whose wake this scan actually moved earlier, Base62. */
  rearmed: string[];
  /**
   * Projects that hold an unanswered episode but were being reconciled while the scan ran. Nothing
   * was written for them, and the one-shot latch stays off because of them.
   */
  deferred: string[];
}

@Injectable()
export class ProjectFailureRecoveryService implements OnModuleInit {
  private readonly log = new Logger(ProjectFailureRecoveryService.name);
  private ran = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Never awaited and never load-bearing: a deployment must boot whether or not a historical
    // episode can be recovered, and the scan's whole effect is an earlier wake. A failure here is
    // logged and the next boot tries again — which is exactly what "one-shot, idempotent" buys.
    void this.recoverOnce().catch((cause: unknown) => {
      this.log.error(`Project failure recovery scan failed: ${
        cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  /**
   * Run the scan once in this process — where "once" means "once successfully", not "once at all".
   *
   * Public and returning its subjects so a test — and an operator with a REPL — can run it against
   * a fixture and read what it decided, rather than inferring it from a log line.
   */
  async recoverOnce(now = new Date()): Promise<ProjectFailureRecoveryOutcome> {
    if (this.ran) return { rearmed: [], deferred: [] };
    const outcome = await this.scan(now);
    // Only a scan that left nothing behind closes the door. A project that was mid-pass is not an
    // answered project, and latching on it would mean nothing looks at it again until a restart.
    this.ran = outcome.deferred.length === 0;
    return outcome;
  }

  /** The scan itself, re-runnable. Everything it does is idempotent; see the class comment. */
  async scan(now = new Date()): Promise<ProjectFailureRecoveryOutcome> {
    // Candidate episodes: a settled failure (§7.2 TU2's own predicate — `FAILED` with no live
    // Session) inside a project the loop is still responsible for. Deliberately NOT filtered by
    // whether today's rules would open a turn for it: that judgement is `failedTaskDisposition`'s
    // and the loop applies it on a snapshot under a lease. Asking it here would be a second copy
    // of the rule, evaluated against rows nobody locked.
    const episodes = await this.prisma.$queryRaw<Array<{
      projectId: string; taskId: string; dispatchAttempt: bigint;
    }>>(Prisma.sql`
      SELECT t."project_id" AS "projectId", t."id" AS "taskId",
             t."dispatch_attempt" AS "dispatchAttempt"
        FROM "task" t
        JOIN "project" p ON p."id" = t."project_id"
        JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE t."status" = 'FAILED'
         AND p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED'
         -- §7.4 precondition 4 / §4.2 guard 5: somebody is on it, so the failure is not settled.
         AND NOT EXISTS (
           SELECT 1 FROM "session" s
            WHERE s."task_id" = t."id" AND s."deleted_at" IS NULL
              AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
         )
       ORDER BY t."project_id", t."id"
    `);
    if (episodes.length === 0) return { rearmed: [], deferred: [] };

    // TF6's identity, spelled exactly as the planner spells it. Base62 in TS rather than SQL
    // because that is where `uuidToBase62` lives and where `failureEpisodes` builds the same
    // string — one spelling, one place.
    const byProject = new Map<string, Set<string>>();
    for (const episode of episodes) {
      const key = `${uuidToBase62(episode.taskId)}#${episode.dispatchAttempt}`;
      const set = byProject.get(episode.projectId) ?? new Set<string>();
      set.add(key);
      byProject.set(episode.projectId, set);
    }

    const covered = await this.prisma.$queryRaw<Array<{ projectId: string; fact: string }>>(
      Prisma.sql`
        SELECT a."project_id" AS "projectId", fact."value" AS "fact"
          FROM "project_action" a
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(a."detail" -> 'turnFacts') = 'array'
                 THEN a."detail" -> 'turnFacts' ELSE '[]'::jsonb END
          ) AS fact("value")
         WHERE a."project_id" IN (${Prisma.join([...byProject.keys()].map((id) => Prisma.sql`${id}::uuid`))})
           AND a."type"::text = 'OPEN_COORDINATOR_TURN'
           AND a."status"::text = 'APPLIED'
      `);
    for (const row of covered) byProject.get(row.projectId)?.delete(row.fact);

    const uncovered = [...byProject].filter(([, keys]) => keys.size > 0).map(([id]) => id);
    if (uncovered.length === 0) return { rearmed: [], deferred: [] };
    const ids = Prisma.join(uncovered.map((id) => Prisma.sql`${id}::uuid`));

    // Two predicates, and each one is why a repeat run is a no-op rather than a rewrite:
    //
    //   `next_wake_at IS NULL OR > now` — a project already due is already going to be looked at,
    //     so there is nothing to move. Without this the second run writes the same instant again
    //     and `updated_at` moves, which is a side effect however equal the value is.
    //   `lease_holder IS NULL` — a holder mid-pass publishes `next_wake_at` itself under a fencing
    //     token when it commits, so this write would be lost. It is reported as DEFERRED rather
    //     than dropped, and the one-shot latch reads that.
    //
    // RETURNING, so what this call reports is what the database did — not what it intended.
    const rearmed = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      UPDATE "project_runtime" r
         SET "next_wake_at" = ${now},
             "next_wake_reason" = 'recovery: task failure with no coordinator turn',
             "updated_at" = ${now}
       WHERE r."project_id" IN (${ids})
         AND (r."next_wake_at" IS NULL OR r."next_wake_at" > ${now})
         AND r."lease_holder" IS NULL
      RETURNING r."project_id" AS "projectId"
    `);
    const deferred = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      SELECT r."project_id" AS "projectId" FROM "project_runtime" r
       WHERE r."project_id" IN (${ids}) AND r."lease_holder" IS NOT NULL
    `);
    if (rearmed.length > 0) {
      this.log.log(
        `Project failure recovery re-armed ${rearmed.length} project(s) holding a task failure `
        + 'no coordinator turn had answered',
      );
    }
    if (deferred.length > 0) {
      this.log.log(
        `Project failure recovery left ${deferred.length} project(s) to the holder reconciling them`,
      );
    }
    return {
      rearmed: rearmed.map((row) => uuidToBase62(row.projectId)),
      deferred: deferred.map((row) => uuidToBase62(row.projectId)),
    };
  }
}
