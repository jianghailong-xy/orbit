import { basename } from 'node:path';
import {
  AgentProvider,
  credentialEngines,
  providerPreset,
  type ProviderPresetModel,
  type RunnerModelCatalog,
  type SubagentRunCreateRequest,
} from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import type { PrismaService } from '../prisma/prisma.service';
import { keyCredential, usableProviderScope } from '../providers/custom-provider';
import { catalogModels } from '../providers/model-catalog';
import { followsRuntimeCatalog, withPreset } from '../providers/preset-overlay';
import { COMPATIBILITY_GUARD_SLUGS } from '../providers/providers.service';
import {
  routeSubagent,
  type ModelRoutingEngineState,
  type ModelRoutingOptimizeFor,
  type SubagentEngineReport,
  type SubagentModelRow,
  type SubagentProvider,
  type SubagentRoutingDecision,
} from '../tasks/model-routing';
import { engineState, taskRouteReads } from '../tasks/task-route-decision';

/** The account-level preference listing the providers SubAgents may not run on (docs/subagent-design.md §6.2). */
export function subagentBlockedProviders(preferences: unknown): string[] {
  const list = (preferences as { subagentBlockedProviders?: unknown } | null)?.subagentBlockedProviders;
  return Array.isArray(list) ? list.filter((slug): slug is string => typeof slug === 'string') : [];
}

/** One model of a key's own list as a tier row: its tier and price, else those its preset ships for it. */
function keyModelRow(model: ProviderPresetModel, shipped: readonly ProviderPresetModel[]): SubagentModelRow {
  const preset = shipped.find((entry) => entry.value === model.value);
  return {
    model: model.value,
    effort: null,
    level: model.tier ?? preset?.tier ?? null,
    outputPricePerMTok: model.outputPricePerMTok ?? preset?.outputPricePerMTok ?? null,
  };
}

/**
 * Read what routeSubagent decides from (§4.2) and call it: the owner's providers in provider_list's order —
 * the built-in engines, then the configured keys by position — with which engines each runs, the tier rows
 * of each, and the parent's runner's report on each engine, through the same reads a task run's route uses
 * (taskRouteReads, engineState). Shared providers are read too, so one outside usableProviderScope is
 * recorded as removed rather than missing. Reads only; nothing here is written.
 */
export async function planSubagentRoute(
  db: Prisma.TransactionClient,
  args: {
    ownerId: string;
    workspaceId: string | null;
    runnerId: string | null;
    dto: SubagentRunCreateRequest;
    parent: { engine: string; provider: string; model: string; effort: string | null };
    now?: Date;
  },
): Promise<SubagentRoutingDecision> {
  const { ownerId, dto } = args;
  const reads = taskRouteReads(db as unknown as PrismaService, ownerId, args.now ?? new Date());
  const owner = await reads.owner();
  const agent = args.workspaceId ? await reads.workspace(args.workspaceId) : null;
  const runner = args.runnerId ? await reads.runner(args.runnerId) : null;

  // The runner's word on each engine; for Claude and Codex the account a run there would use, as a task run reads it.
  const health = sanitizeRunnerEngines(runner?.engines);
  const states: Record<string, ModelRoutingEngineState> = {};
  if (agent && runner) {
    for (const engine of [AgentProvider.CLAUDE, AgentProvider.CODEX] as const) states[engine] = engineState(engine, agent, runner, reads.now);
  }
  const engines: Record<string, SubagentEngineReport> | null = health
    ? Object.fromEntries(health.map((entry) => {
      const state = states[entry.engine];
      return [entry.engine, {
        installed: entry.installed,
        // The account a run there would use, or the CLI's own answer when that is plainly no.
        signedOut: state?.signedOut === true || entry.auth === 'no',
        ...(state?.regionBlocked ? { regionBlocked: true } : {}),
      }];
    }))
    : null;

  const builtins: SubagentProvider[] = Object.values(AgentProvider).map((slug) => ({
    slug,
    // A sign-in spends its subscription; OpenCode's own config and DeepSeek Harness's default key are billed per token.
    billing: isLoginEngine(slug) ? 'subscription' : 'key',
    inScope: true,
    engines: [{ engine: slug }],
    ...(states[slug] ? { account: { quota: states[slug].quota ?? null, paused: states[slug].paused === true } } : {}),
  }));

  const rows = await db.modelProvider.findMany({
    where: { enabled: true, slug: { notIn: COMPATIBILITY_GUARD_SLUGS }, OR: [{ ownerId }, { ownerId: null }] },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const usable = new Set((await db.modelProvider.findMany({
    where: { id: { in: rows.map((row) => row.id) }, ...(await usableProviderScope(db, ownerId)) },
    select: { id: true },
  })).map((row) => row.id));
  const keys: SubagentProvider[] = rows.map((row) => {
    const credential = keyCredential(row);
    const runsOn = credentialEngines(credential);
    const shipped = providerPreset(row.presetSlug);
    const own = withPreset(row).models as unknown as ProviderPresetModel[];
    const presetModels = shipped ? catalogModels(shipped) : [];
    return {
      slug: row.slug,
      billing: credential.kind === 'key' && credential.subscriptionToken ? 'subscription' : 'key',
      inScope: usable.has(row.id),
      engines: runsOn.map((engine, index) => (
        // On its native engine a vendor that IS that engine's endpoint has the engine's own catalogue (ownModelSpace).
        index === 0 && row.runtime !== AgentProvider.DSH && followsRuntimeCatalog(row)
          ? { engine }
          : { engine, models: (Array.isArray(own) ? own : []).map((model) => keyModelRow(model, presetModels)) }
      )),
    };
  });

  const mode = agent?.modelRoutingOptimizeFor;
  const optimizeFor: ModelRoutingOptimizeFor = mode === 'balance' || mode === 'intelligence' ? mode : 'cost';
  const level = (value: unknown) => (['S', 'M', 'L', 'XL'] as const).find((entry) => entry === value) ?? null;
  return routeSubagent({
    type: dto.type,
    definitionName: dto.definitionSource === 'builtin' ? dto.type : basename(dto.definitionSource),
    caller: { model: dto.model ?? null, size: level(dto.size), sizeReason: dto.sizeReason ?? null },
    definition: { model: dto.definitionModel ?? null, size: level(dto.definitionSize) },
    optimizeFor,
    parent: args.parent,
    providers: [...builtins, ...keys],
    blockedProviders: subagentBlockedProviders(owner?.preferences),
    engines,
    modelCatalog: (runner?.modelCatalog ?? null) as RunnerModelCatalog | null,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
  });
}
