import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RunFailureKind } from '@orbit/shared';
import { failureKindIsSql } from '../common/run-failure-kind-filter';
import { releaseWasFailureSql } from '../common/session-release';
import { PrismaService } from '../prisma/prisma.service';

export interface ModelRoutingReportGroup {
  policyVersion: number;
  level: string | null;
  provider: string;
  model: string | null;
  sampleCount: number;
  taskCount: number;
  completedTaskCount: number;
  firstPassTaskCount: number;
  firstPassRate: number | null;
  averageFailureCount: number | null;
  /** `null` when no task completed, or when any completed task ran with unknown usage. */
  tokensPerCompletedTask: number | null;
  /** `null` when no task completed, or when any completed task ran with unknown usage. */
  costUsdPerCompletedTask: number | null;
  /** Completed tasks with a run whose runtime reported no cost or tokens (DeepSeek Harness): their
   *  spend is unknown, not $0 / 0 tokens, so the two per-task averages above are withheld. */
  usageUnknownCompletedTaskCount: number;
  durationP50Ms: number | null;
}

/**
 * Whether a session ran on a runtime that reports no cost or tokens (DeepSeek Harness reports only
 * context occupancy) and nothing was recorded for it anyway. Its `cost_usd` 0 is then a default,
 * not a measurement. The dsh identity is the one queue.service's capability gate uses: the session's
 * recorded engine, whatever key it spends, and the old rule for a row without one.
 */
export function sessionUsageUnreported(session: string): Prisma.Sql {
  const s = Prisma.raw(session);
  return Prisma.sql`(${s}.cost_usd = 0
    AND NOT EXISTS (SELECT 1 FROM usage unreported WHERE unreported.session_id = ${s}.id)
    AND ((${s}.engine IS NOT NULL AND ${s}.engine = 'dsh') OR (${s}.engine IS NULL AND (
      (${s}.provider = 'dsh' AND ${s}.provider_builtin) OR EXISTS (
        SELECT 1 FROM model_provider unreported_mp
         WHERE NOT ${s}.provider_builtin AND unreported_mp.slug = ${s}.provider
           AND unreported_mp.runtime = 'dsh'
           AND (unreported_mp.owner_id IS NULL OR unreported_mp.owner_id = ${s}.owner_id))))))`;
}

/** The failure kinds that say nothing of the model: the runner's kind, else the legacy markers (runFailureKind). */
const LIMIT_FAILURE_KINDS = [RunFailureKind.USAGE_LIMIT, RunFailureKind.CAPACITY] as const;

/**
 * Whether a run failed on a usage limit or a model at capacity: not the model's quality, so neither the report's
 * failure count nor the Model tiers view's first pass counts it, as the router does not.
 */
export function limitFailure(run: string): Prisma.Sql {
  return Prisma.sql`(${releaseWasFailureSql(run)} AND ${failureKindIsSql(run, LIMIT_FAILURE_KINDS)})`;
}

/** One provider × engine × model's done tasks, as the Model tiers view reads them (taskFirstPassByModel). */
export interface TaskFirstPassRow {
  provider: string;
  engine: string;
  model: string;
  completedTaskCount: number;
  firstPassTaskCount: number;
}

/**
 * The done tasks whose first counted run started at or after `since`, by that run's provider × engine × model, and
 * how many passed first time: the report's rule — one run, not FAILED, no FAIL verdict and no send-back in its
 * window — with every run that failed on a usage limit or a model at capacity (limitFailure) left out entirely, so
 * such a run neither takes the task nor makes it a second run. Reads only; routing never calls it.
 */
export async function taskFirstPassByModel(
  db: Prisma.TransactionClient,
  ownerId: string,
  since: Date,
): Promise<TaskFirstPassRow[]> {
  return db.$queryRaw<TaskFirstPassRow[]>(Prisma.sql`
    WITH counted AS (
      SELECT s.id, s.task_id, ${releaseWasFailureSql('s')} AS run_failed, s.created_at, coalesce(s.engine, s.provider) AS engine, s.provider, s.model,
             row_number() OVER history AS ordinal,
             lead(s.created_at) OVER history AS next_created_at
        FROM session s
        JOIN task t ON t.id = s.task_id AND t.owner_id = ${ownerId}::uuid AND t.status = 'DONE'
                   AND t.updated_at >= ${since}
       WHERE s.owner_id = ${ownerId}::uuid AND s.starts_task_work AND NOT ${limitFailure('s')}
      WINDOW history AS (PARTITION BY s.task_id ORDER BY s.created_at, s.id)
    ),
    assessed AS (
      SELECT c.*, (c.run_failed OR EXISTS (
               SELECT 1 FROM task v
                WHERE v.owner_id = ${ownerId}::uuid AND v.verifies_task_id = c.task_id
                  AND v.verdict = 'FAIL' AND v.updated_at >= c.created_at
                  AND (c.next_created_at IS NULL OR v.updated_at < c.next_created_at)
             ) OR EXISTS (
               SELECT 1 FROM task_evidence_decision e
                WHERE e.owner_id = ${ownerId}::uuid AND e.task_id = c.task_id
                  AND e.decision = 'SEND_BACK' AND e.decided_at >= c.created_at
                  AND (c.next_created_at IS NULL OR e.decided_at < c.next_created_at)
             )) AS failed
        FROM counted c
    ),
    per_task AS (
      SELECT task_id, count(*) AS run_count, bool_or(failed) AS failed FROM assessed GROUP BY task_id
    )
    SELECT f.provider, f.engine, f.model, count(*)::int AS "completedTaskCount",
           (count(*) FILTER (WHERE p.run_count = 1 AND NOT p.failed))::int AS "firstPassTaskCount"
      FROM assessed f JOIN per_task p ON p.task_id = f.task_id
     WHERE f.ordinal = 1 AND f.created_at >= ${since} AND f.model IS NOT NULL
     GROUP BY f.provider, f.engine, f.model
  `);
}

/** A report's `since` filter: absent is no lower bound; anything but an ISO timestamp is a 400. */
export function reportSince(since: string | undefined): Date | null {
  const sinceDate = since === undefined ? null : new Date(since);
  if (sinceDate && (typeof since !== 'string' || !Number.isFinite(sinceDate.getTime()))) {
    throw new BadRequestException('since must be an ISO timestamp');
  }
  return sinceDate;
}

@Injectable()
export class TaskModelRoutingReportService {
  constructor(private readonly prisma: PrismaService) {}

  async read(ownerId: string, since?: string, agentId?: string) {
    const sinceDate = reportSince(since);
    const rows = await this.prisma.$queryRaw<Array<ModelRoutingReportGroup & { applied: boolean }>>(Prisma.sql`
      WITH routed_runs AS (
        SELECT d.policy_version, d.level, d.applied, s.provider, s.model,
               s.id AS session_id, s.task_id,
               -- The run failed: released by a failure (common/session-release.ts), never null: false for a run still
               -- held.
               ${releaseWasFailureSql('s')} AS run_failed, s.effort,
               s.created_at, s.finished_at, t.status AS task_status, t.completion_criterion
          FROM task_route_decision d
          JOIN task t ON t.id = d.task_id AND t.owner_id = ${ownerId}::uuid
          JOIN session s ON s.id = d.session_id AND s.task_id = t.id
                        AND s.owner_id = ${ownerId}::uuid AND s.starts_task_work
         WHERE d.owner_id = ${ownerId}::uuid
           ${sinceDate ? Prisma.sql`AND d.created_at >= ${sinceDate}` : Prisma.empty}
           ${agentId ? Prisma.sql`AND s.workspace_id = ${agentId}::uuid` : Prisma.empty}
      ),
      -- Filters choose samples, never cut short the history that determines the first run or cost.
      work_runs AS (
        SELECT s.id, s.task_id, ${releaseWasFailureSql('s')} AS run_failed,
               s.error, s.failure_kind, s.cost_usd, s.created_at,
               ${sessionUsageUnreported('s')} AS usage_unknown,
               row_number() OVER history AS ordinal,
               lead(s.created_at) OVER history AS next_created_at
          FROM session s
          JOIN (SELECT DISTINCT task_id FROM routed_runs) relevant ON relevant.task_id = s.task_id
         WHERE s.owner_id = ${ownerId}::uuid AND s.starts_task_work
        WINDOW history AS (PARTITION BY s.task_id ORDER BY s.created_at, s.id)
      ),
      assessed_runs AS (
        SELECT w.*,
               NOT (w.run_failed AND ${failureKindIsSql('w', LIMIT_FAILURE_KINDS)})
               AND (w.run_failed OR EXISTS (
                 SELECT 1 FROM task v
                  WHERE v.owner_id = ${ownerId}::uuid AND v.verifies_task_id = w.task_id
                    AND v.verdict = 'FAIL' AND v.updated_at >= w.created_at
                    AND (w.next_created_at IS NULL OR v.updated_at < w.next_created_at)
               ) OR EXISTS (
                 SELECT 1 FROM task_evidence_decision e
                  WHERE e.owner_id = ${ownerId}::uuid AND e.task_id = w.task_id
                    AND e.decision = 'SEND_BACK' AND e.decided_at >= w.created_at
                    AND (w.next_created_at IS NULL OR e.decided_at < w.next_created_at)
               )) AS failed
          FROM work_runs w
      ),
      usage_totals AS (
        SELECT u.session_id,
               sum(u.input_tokens::bigint + u.output_tokens::bigint
                   + u.cache_read_input_tokens::bigint + u.cache_creation_input_tokens::bigint) AS tokens
          FROM usage u JOIN work_runs w ON w.id = u.session_id
         GROUP BY u.session_id
      ),
      task_totals AS (
        SELECT w.task_id, count(*) AS run_count, count(*) FILTER (WHERE w.failed) AS failures,
               sum(coalesce(u.tokens, 0)) AS tokens, sum(w.cost_usd) AS cost_usd,
               bool_or(w.usage_unknown) AS usage_unknown
          FROM assessed_runs w LEFT JOIN usage_totals u ON u.session_id = w.id
         GROUP BY w.task_id
      ),
      task_stats AS (
        SELECT r.policy_version, r.level, r.applied, r.provider, r.model,
               count(*)::int AS task_count,
               (count(*) FILTER (WHERE r.task_status = 'DONE'))::int AS completed_task_count,
               (count(*) FILTER (WHERE r.task_status = 'DONE' AND totals.run_count = 1
                                 AND totals.failures = 0 AND NOT r.run_failed))::int AS first_pass_task_count,
               avg(totals.failures)::double precision AS average_failure_count,
               (count(*) FILTER (WHERE r.task_status = 'DONE' AND totals.usage_unknown))::int
                 AS usage_unknown_completed_task_count,
               CASE WHEN bool_or(totals.usage_unknown) FILTER (WHERE r.task_status = 'DONE') THEN NULL
                    ELSE (sum(totals.tokens) FILTER (WHERE r.task_status = 'DONE'))::double precision
                         / nullif(count(*) FILTER (WHERE r.task_status = 'DONE'), 0)
               END AS tokens_per_completed_task,
               CASE WHEN bool_or(totals.usage_unknown) FILTER (WHERE r.task_status = 'DONE') THEN NULL
                    ELSE sum(totals.cost_usd) FILTER (WHERE r.task_status = 'DONE')
                         / nullif(count(*) FILTER (WHERE r.task_status = 'DONE'), 0)
               END AS cost_usd_per_completed_task
          FROM routed_runs r
          JOIN work_runs first_run ON first_run.id = r.session_id AND first_run.ordinal = 1
          JOIN task_totals totals ON totals.task_id = r.task_id
         GROUP BY r.policy_version, r.level, r.applied, r.provider, r.model
      ),
      run_stats AS (
        SELECT policy_version, level, applied, provider, model, count(*)::int AS sample_count,
               percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch FROM (finished_at - created_at)) * 1000
               ) AS duration_p50_ms
          FROM routed_runs
         GROUP BY policy_version, level, applied, provider, model
      )
      SELECT r.policy_version AS "policyVersion", r.level, r.applied, r.provider, r.model,
             r.sample_count AS "sampleCount", coalesce(t.task_count, 0) AS "taskCount",
             coalesce(t.completed_task_count, 0) AS "completedTaskCount",
             coalesce(t.first_pass_task_count, 0) AS "firstPassTaskCount",
             t.first_pass_task_count::double precision / nullif(t.task_count, 0) AS "firstPassRate",
             t.average_failure_count AS "averageFailureCount",
             t.tokens_per_completed_task AS "tokensPerCompletedTask",
             t.cost_usd_per_completed_task AS "costUsdPerCompletedTask",
             coalesce(t.usage_unknown_completed_task_count, 0) AS "usageUnknownCompletedTaskCount",
             r.duration_p50_ms AS "durationP50Ms"
        FROM run_stats r LEFT JOIN task_stats t
          ON t.policy_version = r.policy_version AND t.applied = r.applied AND t.provider = r.provider
         AND t.level IS NOT DISTINCT FROM r.level AND t.model IS NOT DISTINCT FROM r.model
       ORDER BY r.applied, r.policy_version, r.level NULLS FIRST, r.provider, r.model NULLS FIRST
    `);
    const report: { shadow: ModelRoutingReportGroup[]; applied: ModelRoutingReportGroup[] } = {
      shadow: [], applied: [],
    };
    for (const { applied, ...group } of rows) report[applied ? 'applied' : 'shadow'].push(group);
    return report;
  }
}
