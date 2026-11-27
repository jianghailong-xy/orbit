import { basename } from 'node:path';
import {
  AgentProvider,
  antigravityBaseModel,
  credentialEngines,
  ENGINE_CLI_NAMES,
  type ProviderModelTier,
  type RunnerModelInfo,
  type ProviderTierRow,
  type SubagentTiersResponse,
  providerPreset,
  type PlanUsageSnapshot,
  type ProviderPreset,
  type ProviderPresetModel,
  type RunnerModelCatalog,
  type SubagentRunCreateRequest,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { modelRoutingEnabled, optimizeForOf } from '../common/model-routing-switch';
import { ACCOUNT_ENGINES, isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import type { PrismaService } from '../prisma/prisma.service';
import { keyCredential, usableProviderScope } from '../providers/custom-provider';
import { catalogModels, presetModelPrice } from '../providers/model-catalog';
import type { UsageProviderRow } from '../providers/plan-usage.service';
import { isPoolCandidate } from '../providers/pool-admission';
import { followsRuntimeCatalog, withPreset } from '../providers/preset-overlay';
import { COMPATIBILITY_GUARD_SLUGS } from '../providers/providers.service';
import {
  familyNewest,
  familyTier,
  MODEL_ROUTING_LEVELS,
  type BuiltinModelTiers,
  type ModelRoutingLevel,
  routeSubagent,
  subagentEngineRows,
  type ModelRoutingEngineState,
  type ModelRoutingOptimizeFor,
  type SubagentEngineReport,
  type SubagentModelRow,
  type SubagentPoolMember,
  type SubagentProvider,
  type SubagentRoutingDecision,
  type SubagentRoutingInput,
  type RoutingHealthEntry,
} from '../tasks/model-routing';
import { subjectKey } from '../providers/account-health';
import { engineState, fullestWindow, quotaTiming, taskRouteReads } from '../tasks/task-route-decision';
import { readModelIdentities, type ModelSighting } from './model-identity';
import { addTally, emptyTally, qualityOf, readModelQuality, type QualityTally } from './model-quality';
import { modelLabels } from './subagent-run';

/** The account-level preference listing the providers SubAgents may not run on (docs/subagent-design.md §6.2). */
export function subagentBlockedProviders(preferences: unknown): string[] {
  const list = (preferences as { subagentBlockedProviders?: unknown } | null)?.subagentBlockedProviders;
  return Array.isArray(list) ? list.filter((slug): slug is string => typeof slug === 'string') : [];
}

/** The account-level preference holding the owner's tiers for built-in engines' models, engine → model → tier
 *  (docs/subagent-design.md §7), with anything that is not a tier dropped. Written only by
 *  PATCH /providers/builtin/:engine/model-tier. */
export function builtinModelTiers(preferences: unknown): BuiltinModelTiers {
  const map = (preferences as { builtinModelTiers?: unknown } | null)?.builtinModelTiers;
  const tiers: Record<string, Record<string, ModelRoutingLevel>> = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return tiers;
  for (const [engine, models] of Object.entries(map)) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [model, tier] of Object.entries(models)) {
      const level = MODEL_TIERS.find((entry) => entry === tier);
      if (level) (tiers[engine] ??= {})[model] = level;
    }
  }
  return tiers;
}

/** A tier row of a key's own list, with where its tier came from (the Tier column reads it; the router ignores it). */
interface KeyModelRow extends SubagentModelRow {
  source: 'catalogue' | 'owner' | null;
  editable: boolean;
}

/** One model of a key's own list as a tier row: the tier its preset ships for it, else the one the owner set
 *  (model_provider.model_tiers), else its family's (familyTier), and its price. */
function keyModelRow(model: ProviderPresetModel, shipped: readonly ProviderPresetModel[], ownerTiers: unknown): KeyModelRow {
  const preset = shipped.find((entry) => entry.value === model.value);
  const set = ownerTiers && typeof ownerTiers === 'object' ? (ownerTiers as Record<string, unknown>)[model.value] : undefined;
  const owner = MODEL_TIERS.find((tier) => tier === set) ?? null;
  const family = preset?.tier || owner ? null : familyTier(model.value);
  return {
    model: model.value,
    effort: null,
    level: preset?.tier ?? owner ?? family,
    outputPricePerMTok: model.outputPricePerMTok ?? preset?.outputPricePerMTok ?? null,
    // A family's tier reads as the catalogue's, and stays the owner's to change.
    source: preset?.tier || family ? 'catalogue' : owner ? 'owner' : null,
    // The catalogue's word stands; a model it does not tier is the owner's to tier (docs/subagent-design.md §7).
    editable: !preset?.tier,
  };
}

const MODEL_TIERS = ['S', 'M', 'L', 'XL'] as const;

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
  args: SubagentRouteArgs,
): Promise<SubagentRoutingDecision> {
  return routeSubagent(await subagentRouteInput(db, args));
}

export interface SubagentRouteArgs {
  ownerId: string;
  /** The workspace and runner the SubAgent runs on: the parent's, or a remote SubAgent's target (§10.3). */
  workspaceId: string | null;
  runnerId: string | null;
  dto: SubagentRunCreateRequest;
  parent: { engine: string; provider: string; model: string; effort: string | null };
  /** Pool members' quota, as dispatch reads it (QueueService.accountPool); absent, every member reads unknown. */
  planUsage?: SubagentPlanUsageReader | null;
  now?: Date;
  /** routeSubagent's `runnerLabel` and `strictNamedModel`, which a remote SubAgent sets. */
  runnerLabel?: string;
  strictNamedModel?: boolean;
  /** The owner's live account health by subject key (routingHealthIndex); absent, it is read here. */
  health?: ReadonlyMap<string, RoutingHealthEntry[]>;
}

/** A built-in provider's credential, as the region check reads it: the engine's own sign-in, OpenCode's own
 *  configuration, or DeepSeek Harness's default key, which is DeepSeek's. */
function builtinCredential(slug: AgentProvider): SubagentProvider['credential'] {
  if (isLoginEngine(slug)) return { kind: 'login', engine: slug };
  return slug === AgentProvider.OPENCODE ? { kind: 'opencode' } : { kind: 'key', presetSlug: null };
}

/** What planSubagentRoute hands routeSubagent, read the same way: for a remote SubAgent's own checks (§10.3). */
export async function subagentRouteInput(
  db: Prisma.TransactionClient,
  args: SubagentRouteArgs,
): Promise<SubagentRoutingInput> {
  const { ownerId, dto } = args;
  const reads = taskRouteReads(db as unknown as PrismaService, ownerId, args.now ?? new Date());
  const owner = await reads.owner();
  const agent = args.workspaceId ? await reads.workspace(args.workspaceId) : null;
  const runner = args.runnerId ? await reads.runner(args.runnerId) : null;
  // What account health learned of every account the owner has, read once (docs/routing-account-health-design.md §7.1).
  const healthIndex = args.health ?? await reads.health();

  // The runner's word on each engine; for every engine that keeps accounts, the account a run there would use, as a
  // task run reads it: its sign-in and its quota.
  const health = sanitizeRunnerEngines(runner?.engines);
  const states: Record<string, ModelRoutingEngineState> = {};
  if (agent && runner) {
    for (const engine of ACCOUNT_ENGINES) {
      states[engine] = engineState(engine, agent, runner, reads.now, healthIndex);
    }
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
    credential: builtinCredential(slug),
    engines: [{ engine: slug }],
    ...(states[slug] ? {
      account: {
        quota: states[slug].quota ?? null, paused: states[slug].paused === true, unreadable: states[slug].quotaUnread === true,
        expiresAt: states[slug].expiresAt ?? null, expiryWindowMins: states[slug].expiryWindowMins ?? null,
        nearLimit: states[slug].nearLimit === true,
        opusUtilization: states[slug].opusUtilization ?? null,
        ...(states[slug].health ? { health: states[slug].health } : {}),
      },
    } : {}),
  }));

  const catalog = (runner?.modelCatalog ?? null) as RunnerModelCatalog | null;
  const configured = await readConfiguredProviders(db, ownerId, {
    catalog, planUsage: args.planUsage ?? null, now: reads.now, health: healthIndex,
  });

  const optimizeFor: ModelRoutingOptimizeFor = optimizeForOf(owner);
  const ownerTiers = builtinModelTiers(owner?.preferences);
  const level = (value: unknown) => (['S', 'M', 'L', 'XL'] as const).find((entry) => entry === value) ?? null;
  return {
    type: dto.type,
    definitionName: dto.definitionSource === 'builtin' ? dto.type : basename(dto.definitionSource),
    caller: { model: dto.model ?? null, size: level(dto.size), sizeReason: dto.sizeReason ?? null },
    definition: { model: dto.definitionModel ?? null, size: level(dto.definitionSize) },
    optimizeFor,
    parent: args.parent,
    providers: [...builtins, ...configured.map((entry) => entry.provider)],
    blockedProviders: subagentBlockedProviders(owner?.preferences),
    smartSelection: modelRoutingEnabled(owner),
    engines,
    modelCatalog: catalog,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
    now: reads.now.getTime(),
    ...(Object.keys(ownerTiers).length > 0 ? { builtinModelTiers: ownerTiers } : {}),
    ...(args.runnerLabel ? { runnerLabel: args.runnerLabel } : {}),
    ...(args.strictNamedModel ? { strictNamedModel: true } : {}),
  };
}

/** A configured provider (a key or an account pool) as routing reads it, with what the Tier column shows of it. */
interface ConfiguredProvider {
  provider: SubagentProvider;
  label: string;
  kind: 'key' | 'pool';
  /** A key of the owner's own, which the tier write takes; null for a shared key or a pool. */
  providerId: string | null;
}

/**
 * The owner's keys and account pools in provider_list's order, as routeSubagent reads them: with which
 * engines each runs and the tier rows of each. Shared providers are read too, so one outside
 * usableProviderScope is recorded as removed rather than missing. Reads only.
 */
async function readConfiguredProviders(
  db: Prisma.TransactionClient,
  ownerId: string,
  { catalog, planUsage, now, health }: {
    catalog: RunnerModelCatalog | null; planUsage: SubagentPlanUsageReader | null; now: Date;
    /** Live account health by subject key; absent, every account reads healthy (the Tier column's view). */
    health?: ReadonlyMap<string, RoutingHealthEntry[]>;
  },
): Promise<ConfiguredProvider[]> {
  const healthOf = (key: string) => {
    const entries = health?.get(key);
    return entries?.length ? { health: entries } : {};
  };
  const rows = await db.modelProvider.findMany({
    where: { enabled: true, slug: { notIn: COMPATIBILITY_GUARD_SLUGS }, OR: [{ ownerId }, { ownerId: null }] },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const usable = new Set((await db.modelProvider.findMany({
    where: { id: { in: rows.map((row) => row.id) }, ...(await usableProviderScope(db, ownerId)) },
    select: { id: true },
  })).map((row) => row.id));
  const keys = rows.map((row): ConfiguredProvider => {
    const credential = keyCredential(row);
    const runsOn = credentialEngines(credential);
    const shipped = providerPreset(row.presetSlug);
    const overlaid = withPreset(row);
    const own = overlaid.models as unknown as ProviderPresetModel[];
    const presetModels = shipped ? catalogModels(shipped) : [];
    const subscription = credential.kind === 'key' && credential.subscriptionToken;
    // A subscription token's quota is the credential's own, read through the same cache as a pool member's.
    const usage = subscription ? planUsage?.snapshot(row) ?? null : null;
    const standing = subscription ? planUsage?.usageStanding(row) ?? null : null;
    // A key's health is one row for the owner (§6.1): `provider:<id>`, on a subscription token and a metered key alike.
    const keyHealth = healthOf(subjectKey({ type: 'provider', providerId: row.id }));
    const provider: SubagentProvider = {
      slug: row.slug,
      billing: subscription ? 'subscription' : 'key',
      ...(subscription ? {
        account: {
          quota: fullestWindow(usage, now),
          ...quotaTiming(usage, now),
          refused: standing === 'KEY_REFUSED',
          unreadable: usage === null || standing === 'USAGE_UNKNOWN',
          ...keyHealth,
        },
      } : 'health' in keyHealth ? { account: keyHealth } : {}),
      inScope: usable.has(row.id),
      credential,
      engines: runsOn.map((engine, index) => (
        // On its native engine a vendor that IS that engine's endpoint has the engine's own catalogue (ownModelSpace).
        // Priced from models.dev like every other preset (an Anthropic key on Claude Code, an OpenAI key on Codex).
        index === 0 && row.runtime !== AgentProvider.DSH && followsRuntimeCatalog(row)
          ? { engine, prices: catalogPrices(shipped, catalog, engine) }
          : {
            engine,
            models: (Array.isArray(own) ? own : []).map((model) => keyModelRow(model, presetModels, row.modelTiers)),
            defaultModel: overlaid.defaultModel,
          }
      )),
    };
    return { provider, label: row.label, kind: 'key', providerId: row.ownerId === ownerId ? row.id : null };
  });

  // Account pools (provider_list lists them after the keys). A Claude pool spends its members' subscription
  // keys, read through the same cache dispatch chooses a member by; a Codex pool of one's own its ChatGPT
  // logins, whose readings the pool gateway stores; a shared Codex pool runs on OpenAI API keys, billed per token.
  const pools = await db.providerPool.findMany({
    where: { OR: [{ ownerId, shared: false }, { engine: AgentProvider.CODEX, people: { some: { userId: ownerId } } }] },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, slug: true, label: true, shared: true, engine: true,
      members: { where: { ownerId }, orderBy: { provider: { slug: 'asc' } }, select: { provider: true, pausedUntil: true } },
    },
  });
  const logins = await db.poolCodexLogin.findMany({
    where: { poolId: { in: pools.filter((pool) => !pool.shared).map((pool) => pool.id) }, state: 'ACTIVE' },
    orderBy: { accountId: 'asc' },
  });
  const later = (at: Date | null) => at !== null && at > now;
  const openai = providerPreset('openai');
  const poolProviders = pools.map((pool): ConfiguredProvider => {
    if (pool.shared) {
      return { label: pool.label, kind: 'pool', providerId: null, provider: { slug: pool.slug, billing: 'key', inScope: true,
        credential: { kind: 'pool', engine: pool.engine },
        engines: [{ engine: AgentProvider.CODEX, prices: catalogPrices(openai, catalog, AgentProvider.CODEX) }] } };
    }
    const members: SubagentPoolMember[] = pool.engine === AgentProvider.CODEX
      ? logins.filter((login) => login.poolId === pool.id).map((login) => {
        const usage = login.usage as PlanUsageSnapshot | null;
        const spent = later(login.spentUntil);
        return {
          label: login.email ?? login.accountId,
          quota: spent ? { utilization: 100, window: 'usage limit' } : fullestWindow(usage, now),
          ...quotaTiming(usage, now),
          paused: later(login.pausedUntil) || later(login.throttledUntil),
          unreadable: !spent && !usage,
          ...healthOf(subjectKey({ type: 'pool-login', poolId: pool.id, accountId: login.accountId })),
        };
      })
      : pool.members
        .map((member) => ({ ...member.provider, pausedUntil: member.pausedUntil }))
        .filter(isPoolCandidate)
        .map((row) => {
          const standing = planUsage?.usageStanding(row) ?? null;
          const usage = planUsage?.snapshot(row) ?? null;
          return {
            label: row.label,
            quota: fullestWindow(usage, now),
            ...quotaTiming(usage, now),
            paused: later(row.pausedUntil),
            refused: standing === 'KEY_REFUSED',
            unreadable: standing === 'USAGE_UNKNOWN' || usage === null,
            ...healthOf(subjectKey({ type: 'provider', providerId: row.id })),
          };
        });
    return { label: pool.label, kind: 'pool', providerId: null,
      provider: { slug: pool.slug, billing: 'subscription', inScope: true, credential: { kind: 'pool', engine: pool.engine },
        engines: [{ engine: pool.engine }], pool: { members } } };
  });
  return [...keys, ...poolProviders];
}

/** Marks each untiered model of a built-in engine whose family's newest model is tiered there: routing uses the
 *  newest on purpose, so the page reads "Older · uses <newest>", not "Not set". An owner's tier makes a model
 *  tiered, so it is never marked. Display only; no routing decision reads this. */
export function markSuperseded(models: readonly ProviderModelTier[], catalog: readonly RunnerModelInfo[]): void {
  for (const model of models) {
    if (model.levels.length > 0) continue;
    const newest = familyNewest(model.model, catalog);
    if (newest && newest !== model.model && models.some((row) => row.model === newest && row.levels.length > 0)) {
      model.supersededBy = newest;
    }
  }
}

/**
 * The Providers page's Tier column and the SubAgents settings' provider list (docs/subagent-design.md §7): every
 * provider routeSubagent considers, in its order, each with the tiers the router reads for its models. The
 * runner catalogue is the owner's most recently heard-from runner's that reported one, so the built-in table's
 * rows name the models a SubAgent would get there. A built-in engine lists every model of that catalogue, each
 * the owner's to tier (PATCH /providers/builtin/:engine/model-tier); a key lists its own models. Reads only.
 *
 * A model's Quality is pooled over every provider and engine it ran on, by its identity (model-identity.ts), so
 * `claude-sonnet-5-5` reads the same on Claude Code and on Antigravity. `learn` is handed every model id the view
 * saw, for the ids nobody has decided to be asked about off the request (learnModelIdentities).
 */
export async function subagentTierView(
  db: Prisma.TransactionClient,
  ownerId: string,
  now = new Date(),
  learn?: (sightings: ModelSighting[]) => void,
): Promise<SubagentTiersResponse> {
  const runner = await db.runner.findFirst({
    where: { ownerId, modelCatalog: { not: Prisma.DbNull } },
    orderBy: [{ lastHeartbeatAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    select: { modelCatalog: true, runtimeDefaultModels: true },
  });
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { preferences: true } });
  const ownerTiers = builtinModelTiers(owner?.preferences);
  const catalogInput = {
    modelCatalog: (runner?.modelCatalog ?? null) as RunnerModelCatalog | null,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
    builtinModelTiers: ownerTiers,
  };
  const configured = await readConfiguredProviders(db, ownerId, { catalog: catalogInput.modelCatalog, planUsage: null, now });
  // Display only (docs/subagent-design.md §7.1): read beside the tiers, never handed to routeSubagent.
  const tallies = await readModelQuality(db, ownerId, now);
  const labels = modelLabels([], catalogInput.modelCatalog);
  const builtins: ConfiguredProvider[] = Object.values(AgentProvider).map((slug) => ({
    label: ENGINE_CLI_NAMES[slug],
    kind: 'key',
    providerId: null,
    provider: {
      slug, billing: isLoginEngine(slug) ? 'subscription' : 'key', inScope: true, credential: builtinCredential(slug), engines: [{ engine: slug }],
    },
  }));
  const label = (model: string) => labels.get(model) ?? model;
  const providers = [...builtins, ...configured]
      .filter(({ provider }) => provider.inScope)
      .map((entry, index): ProviderTierRow => {
        const builtin = index < builtins.length;
        const models = new Map<string, ProviderModelTier>();
        for (const engine of entry.provider.engines) {
          const rows = subagentEngineRows(engine, catalogInput) as Array<SubagentModelRow & Partial<KeyModelRow>>;
          // A built-in engine lists its whole catalogue, the models no row tiers as Not set; a key on that catalogue
          // lists only its tiered rows, since the tier is the engine's to set, not the key's.
          const listed: Array<SubagentModelRow & Partial<KeyModelRow>> = builtin
            ? [...rows, ...(catalogInput.modelCatalog?.[engine.engine as AgentProvider] ?? [])
              .filter((model) => !rows.some((row) => row.model === model.value))
              .map((model): SubagentModelRow => ({ model: model.value, effort: null, level: null }))]
            : engine.models ? rows : rows.filter((row) => row.level);
          const owned = engine.models ? undefined : ownerTiers[engine.engine];
          for (const row of listed) {
            const seen = models.get(row.model) ?? {
              model: row.model,
              levels: [],
              source: null,
              editable: false,
              outputPricePerMTok: null,
              // Pooled by identity below, once every row is known.
              quality: qualityOf(emptyTally(), label),
            };
            if (row.level && !seen.levels.includes(row.level)) seen.levels.push(row.level);
            seen.source = seen.source ?? row.source ?? (owned?.[row.model] ? 'owner' : row.level ? 'catalogue' : null);
            seen.editable = seen.editable || builtin || (row.editable === true && entry.providerId !== null);
            seen.outputPricePerMTok = seen.outputPricePerMTok ?? row.outputPricePerMTok ?? null;
            models.set(row.model, seen);
          }
        }
        for (const model of models.values()) {
          model.levels.sort((a, b) => MODEL_ROUTING_LEVELS.indexOf(a) - MODEL_ROUTING_LEVELS.indexOf(b));
        }
        // A built-in engine's older family models sort after its tiered ones and before the plain Not set ones.
        if (builtin) markSuperseded([...models.values()], catalogInput.modelCatalog?.[entry.provider.slug as AgentProvider] ?? []);
        const ordered = [...models.values()];
        if (builtin) {
          const rank = (model: ProviderModelTier) => (model.levels.length > 0 ? 0 : model.supersededBy ? 1 : 2);
          ordered.sort((a, b) => rank(a) - rank(b));
        }
        return {
          slug: entry.provider.slug,
          label: entry.label,
          kind: builtin ? 'builtin' : entry.kind,
          providerId: entry.providerId,
          billing: entry.provider.billing,
          models: ordered,
        };
      });

  const listed = providers.flatMap((provider) => provider.models.map((model) => ({ provider: provider.slug, model })));
  const ran = [...tallies].map(([key, tally]) => {
    const [provider, engine, model] = key.split('\u0000');
    // Antigravity's ids may carry their level (`claude-opus-5-5-high`): the same model as its base row. Only here, where
    // the engine is known: elsewhere a trailing `-max` is part of the name (`qwen3.7-max`).
    return { provider, model: engine === AgentProvider.ANTIGRAVITY ? antigravityBaseModel(model) : model, tally };
  });
  const identities = await readModelIdentities(db, [...listed.map(({ model }) => model.model), ...ran.map(({ model }) => model)]);
  const pooled = new Map<string, QualityTally>();
  for (const { model, tally } of ran) {
    const key = identities.get(model)!.key;
    const sum = pooled.get(key) ?? emptyTally();
    addTally(sum, tally);
    pooled.set(key, sum);
  }
  for (const { model } of listed) {
    model.identity = identities.get(model.model)!;
    model.quality = qualityOf(pooled.get(model.identity.key) ?? emptyTally(), label);
  }
  learn?.([
    ...listed.map(({ provider, model }) => ({ model: model.model, label: labels.get(model.model) ?? null, provider })),
    ...ran.map(({ provider, model }) => ({ model, provider })),
  ]);
  return { providers };
}
