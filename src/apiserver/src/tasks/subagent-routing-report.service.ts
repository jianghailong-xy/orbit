import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ENGINE_CLI_NAMES,
  isEngine,
  type RunnerModelCatalog,
  type SubagentReportGroup,
  type SubagentRoutingReport,
  type WorkflowReportGroup,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { withPreset } from '../providers/preset-overlay';
import { modelLabels } from '../runner-api/subagent-run';
import { reportSince } from './task-model-routing-report.service';

type GroupRow = Omit<SubagentReportGroup, 'providerLabel' | 'modelLabel'>;

/**
 * The routing report's SubAgents and Workflows views (docs/subagent-design.md §7, docs/subagent-workflow-design.md §8
 * P4, board docs/mocks/subagent-workflow/08-report.html): the owner's SubAgent runs by the tier, provider and model
 * routing picked, and their Orbit workflows by name. Both count the same `subagent_run` rows, so a workflow's calls,
 * failures and cost are its calls' runs, and the SubAgents view counts every one of them among its runs.
 *
 * `since` dates a run by its workflow's start when it is a workflow call, so a workflow inside the window brings all
 * its calls and one outside it none. `agentId` is the Agent of the session that started the run. Reads only.
 */
@Injectable()
export class SubagentRoutingReportService {
  constructor(private readonly prisma: PrismaService) {}

  async read(ownerId: string, since?: string, agentId?: string): Promise<SubagentRoutingReport> {
    const sinceDate = reportSince(since);
    const agent = agentId ? Prisma.sql`AND s.workspace_id = ${agentId}::uuid` : Prisma.empty;
    const groups = await this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
      WITH runs AS (
        SELECT r.status, r.cost_usd, r.workflow_run_id, r.decision,
               CASE WHEN jsonb_typeof(r.attempts) = 'array' THEN jsonb_array_length(r.attempts) ELSE 0 END AS attempt_count
          FROM subagent_run r
          JOIN session s ON s.id = r.session_id AND s.owner_id = ${ownerId}::uuid
          LEFT JOIN subagent_workflow_run w ON w.id = r.workflow_run_id AND w.owner_id = ${ownerId}::uuid
         WHERE r.owner_id = ${ownerId}::uuid
           ${sinceDate ? Prisma.sql`AND coalesce(w.created_at, r.created_at) >= ${sinceDate}` : Prisma.empty}
           ${agent}
      ),
      picked AS (
        SELECT CASE WHEN decision->>'level' IN ('S', 'M', 'L', 'XL') THEN decision->>'level'
                    WHEN decision->>'tierSource' IN ('named-model', 'definition-model') THEN 'named'
                    ELSE 'not-routed' END AS tier,
               decision->>'provider' AS provider, decision->>'model' AS model,
               decision->>'tierSource' AS tier_source, status, cost_usd, workflow_run_id, attempt_count
          FROM runs
      )
      SELECT tier, provider, model,
             count(*)::int AS runs,
             (count(*) FILTER (WHERE workflow_run_id IS NOT NULL))::int AS "workflowCalls",
             (count(*) FILTER (WHERE status <> 'RUNNING'))::int AS ended,
             (count(*) FILTER (WHERE status = 'DONE'))::int AS done,
             coalesce(sum(cost_usd), 0)::double precision AS "costUsd",
             (count(*) FILTER (WHERE attempt_count > 1))::int AS "movedOn",
             (count(*) FILTER (WHERE tier_source = 'type-default'))::int AS "noSize"
        FROM picked
       GROUP BY tier, provider, model
       ORDER BY array_position(ARRAY['S', 'M', 'L', 'XL', 'named', 'not-routed'], tier), runs DESC,
                provider NULLS LAST, model NULLS LAST
    `);
    const workflows = await this.prisma.$queryRaw<WorkflowReportGroup[]>(Prisma.sql`
      WITH flows AS (
        SELECT w.id, w.name, w.description, w.status, w.created_at, w.ended_at
          FROM subagent_workflow_run w
          JOIN session s ON s.id = w.session_id AND s.owner_id = ${ownerId}::uuid
         WHERE w.owner_id = ${ownerId}::uuid
           ${sinceDate ? Prisma.sql`AND w.created_at >= ${sinceDate}` : Prisma.empty}
           ${agent}
      ),
      calls AS (
        SELECT r.workflow_run_id, count(*) AS calls,
               count(*) FILTER (WHERE r.status NOT IN ('RUNNING', 'DONE')) AS failed,
               sum(r.cost_usd) AS cost
          FROM subagent_run r JOIN flows f ON f.id = r.workflow_run_id
         WHERE r.owner_id = ${ownerId}::uuid
         GROUP BY r.workflow_run_id
      )
      SELECT f.name,
             (array_agg(f.description ORDER BY f.created_at DESC, f.id DESC)
                FILTER (WHERE coalesce(f.description, '') <> ''))[1] AS description,
             count(*)::int AS runs,
             (count(*) FILTER (WHERE f.status = 'RUNNING'))::int AS running,
             coalesce(sum(c.calls), 0)::int AS calls,
             coalesce(sum(c.failed), 0)::int AS "failedCalls",
             coalesce(sum(c.cost), 0)::double precision AS "costUsd",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (f.ended_at - f.created_at)) * 1000)
               FILTER (WHERE f.status <> 'RUNNING' AND f.ended_at IS NOT NULL) AS "durationP50Ms"
        FROM flows f LEFT JOIN calls c ON c.workflow_run_id = f.id
       GROUP BY f.name
       ORDER BY runs DESC, "costUsd" DESC, f.name
    `);
    const labels = groups.length === 0 ? null : await this.labels(ownerId);
    return {
      subagents: groups.map((group) => ({
        ...group,
        providerLabel: group.provider === null ? null : labels?.providers.get(group.provider) ?? group.provider,
        modelLabel: group.model === null ? null : labels?.models.get(group.model) ?? group.model,
      })),
      workflows,
    };
  }

  /**
   * How the account names providers and models: a built-in engine by its CLI's name, a key or account pool by its
   * label; a model as the transcript's SubAgent block does (modelLabels), over every runner catalogue of the owner's.
   */
  private async labels(ownerId: string) {
    const [keys, pools, runners] = await Promise.all([
      this.prisma.modelProvider.findMany({
        where: { OR: [{ ownerId }, { ownerId: null }] },
        orderBy: [{ ownerId: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        select: { slug: true, label: true, runtime: true, presetSlug: true, followsPreset: true, models: true, defaultModel: true },
      }),
      this.prisma.providerPool.findMany({
        where: { OR: [{ ownerId }, { people: { some: { userId: ownerId } } }] },
        select: { slug: true, label: true },
      }),
      this.prisma.runner.findMany({
        where: { ownerId, modelCatalog: { not: Prisma.DbNull } },
        orderBy: [{ lastHeartbeatAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        select: { modelCatalog: true },
      }),
    ]);
    const providers = new Map<string, string>();
    for (const row of [...keys, ...pools]) if (!providers.has(row.slug) && row.label) providers.set(row.slug, row.label);
    const catalogs = runners.flatMap((runner) =>
      Object.values((runner.modelCatalog ?? {}) as RunnerModelCatalog).map((models) => ({ models })));
    return {
      providers: {
        get: (slug: string) => (isEngine(slug) ? ENGINE_CLI_NAMES[slug] : providers.get(slug)),
      },
      models: modelLabels([...keys.map((row) => withPreset(row)), ...catalogs]),
    };
  }
}
