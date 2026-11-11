import { basename } from 'node:path';
import {
  AgentProvider,
  credentialEngines,
  providerPreset,
  type PlanUsageSnapshot,
  type ProviderPreset,
  type ProviderPresetModel,
  type RunnerModelCatalog,
  type SubagentRunCreateRequest,
} from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import type { PrismaService } from '../prisma/prisma.service';
import { keyCredential, usableProviderScope } from '../providers/custom-provider';
import { catalogModels, presetModelPrice } from '../providers/model-catalog';
import type { UsageProviderRow } from '../providers/plan-usage.service';
import { isPoolCandidate } from '../providers/pool-admission';
import { followsRuntimeCatalog, withPreset } from '../providers/preset-overlay';
import { COMPATIBILITY_GUARD_SLUGS } from '../providers/providers.service';
import {
  routeSubagent,
  type ModelRoutingEngineState,
  type ModelRoutingOptimizeFor,
  type SubagentEngineReport,
  type SubagentModelRow,
  type SubagentPoolMember,
  type SubagentProvider,
  type SubagentRoutingDecision,
} from '../tasks/model-routing';
import { engineState, fullestWindow, taskRouteReads } from '../tasks/task-route-decision';

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

/** What the reads take of ProviderPlanUsageService: a pool member's cached quota and how its last read ended. */
export interface SubagentPlanUsageReader {
  snapshot(row: UsageProviderRow): PlanUsageSnapshot | null;
  usageStanding(row: UsageProviderRow): string | null;
}

/** The models.dev price of each model a runner reports for `engine`, where the preset knows one. */
function catalogPrices(preset: ProviderPreset | undefined, catalog: RunnerModelCatalog | null, engine: string): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const row of catalog?.[engine as AgentProvider] ?? []) {
    const price = preset ? presetModelPrice(preset, row.value) : undefined;
    if (price !== undefined) prices[row.value] = price;
  }
  return prices;
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
    /** Pool members' quota, as dispatch reads it (QueueService.accountPool); absent, every member reads unknown. */
    planUsage?: SubagentPlanUsageReader | null;
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
  const catalog = (runner?.modelCatalog ?? null) as RunnerModelCatalog | null;
  const keys: SubagentProvider[] = rows.map((row) => {
    const credential = keyCredential(row);
    const runsOn = credentialEngines(credential);
    const shipped = providerPreset(row.presetSlug);
    const own = withPreset(row).models as unknown as ProviderPresetModel[];
    const presetModels = shipped ? catalogModels(shipped) : [];
    const subscription = credential.kind === 'key' && credential.subscriptionToken;
    // A subscription token's quota is the credential's own, read through the same cache as a pool member's.
    const usage = subscription ? args.planUsage?.snapshot(row) ?? null : null;
    const standing = subscription ? args.planUsage?.usageStanding(row) ?? null : null;
    return {
      slug: row.slug,
      billing: subscription ? 'subscription' : 'key',
      ...(subscription ? {
        account: {
          quota: fullestWindow(usage, reads.now),
          refused: standing === 'KEY_REFUSED',
          unreadable: usage === null || standing === 'USAGE_UNKNOWN',
        },
      } : {}),
      inScope: usable.has(row.id),
      engines: runsOn.map((engine, index) => (
        // On its native engine a vendor that IS that engine's endpoint has the engine's own catalogue (ownModelSpace).
        // Priced from models.dev like every other preset (an Anthropic key on Claude Code, an OpenAI key on Codex).
        index === 0 && row.runtime !== AgentProvider.DSH && followsRuntimeCatalog(row)
          ? { engine, prices: catalogPrices(shipped, catalog, engine) }
          : { engine, models: (Array.isArray(own) ? own : []).map((model) => keyModelRow(model, presetModels)) }
      )),
    };
  });

  // Account pools (provider_list lists them after the keys). A Claude pool spends its members' subscription
  // keys, read through the same cache dispatch chooses a member by; a Codex pool of one's own its ChatGPT
  // logins, whose readings the pool gateway stores; a shared Codex pool runs on OpenAI API keys, billed per token.
  const now = reads.now;
  const pools = await db.providerPool.findMany({
    where: { OR: [{ ownerId, shared: false }, { engine: AgentProvider.CODEX, people: { some: { userId: ownerId } } }] },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, slug: true, shared: true, engine: true,
      members: { where: { ownerId }, orderBy: { provider: { slug: 'asc' } }, select: { provider: true, pausedUntil: true } },
    },
  });
  const logins = await db.poolCodexLogin.findMany({
    where: { poolId: { in: pools.filter((pool) => !pool.shared).map((pool) => pool.id) }, state: 'ACTIVE' },
    orderBy: { accountId: 'asc' },
  });
  const later = (at: Date | null) => at !== null && at > now;
  const openai = providerPreset('openai');
  const poolProviders: SubagentProvider[] = pools.map((pool): SubagentProvider => {
    if (pool.shared) {
      return { slug: pool.slug, billing: 'key', inScope: true,
        engines: [{ engine: AgentProvider.CODEX, prices: catalogPrices(openai, catalog, AgentProvider.CODEX) }] };
    }
    const members: SubagentPoolMember[] = pool.engine === AgentProvider.CODEX
      ? logins.filter((login) => login.poolId === pool.id).map((login) => {
        const usage = login.usage as PlanUsageSnapshot | null;
        const spent = later(login.spentUntil);
        return {
          label: login.email ?? login.accountId,
          quota: spent ? { utilization: 100, window: 'usage limit' } : fullestWindow(usage, now),
          paused: later(login.pausedUntil) || later(login.throttledUntil),
          unreadable: !spent && !usage,
        };
      })
      : pool.members
        .map((member) => ({ ...member.provider, pausedUntil: member.pausedUntil }))
        .filter(isPoolCandidate)
        .map((row) => {
          const standing = args.planUsage?.usageStanding(row) ?? null;
          const usage = args.planUsage?.snapshot(row) ?? null;
          return {
            label: row.label,
            quota: fullestWindow(usage, now),
            paused: later(row.pausedUntil),
            refused: standing === 'KEY_REFUSED',
            unreadable: standing === 'USAGE_UNKNOWN' || usage === null,
          };
        });
    return { slug: pool.slug, billing: 'subscription', inScope: true, engines: [{ engine: pool.engine }], pool: { members } };
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
    providers: [...builtins, ...keys, ...poolProviders],
    blockedProviders: subagentBlockedProviders(owner?.preferences),
    engines,
    modelCatalog: catalog,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
  });
}
