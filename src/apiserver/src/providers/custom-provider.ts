import {
  AgentProvider,
  DEFAULT_MODEL_BY_PROVIDER,
  antigravityBaseModel,
  isRetiredModel,
  keyDialect,
  modelForProvider,
  OPENCODE_DIALECT_NPM,
  openCodeBaseUrl,
  openCodeKeyOf,
  openCodeKeyProvider,
  providerPreset,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { accountDir, isAccountEngine } from '@orbit/shared';
import { ACCOUNT_CHOICE, accountEnvVar, accountOnRunner } from './account';
import { catalogModels } from './model-catalog';
import { ANTHROPIC_HOST } from './plan-usage';
import { decryptSecret } from './provider-crypto';
import { followsRuntimeCatalog, presetDefaultModel } from './preset-overlay';
import {
  firstRuntimeCatalogModel,
  runtimeCatalogModels,
  savedRuntimeDefaultModel,
} from '../common/runtime-model';

// Built-in, first-class providers ship their own runtime CLI. Any other `provider` value is
// a control-plane-configured ModelProvider that borrows one of these runtimes.
/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug.
 * `providerBuiltin` fences configured `kimi` / `dsh` slugs during rolling
 * deployment; Claude/Codex predate the discriminator, and migrations 0080 and 0367 move any
 * pre-existing custom `opencode` / `antigravity` row (0367: or account pool) aside, so all four
 * remain unambiguous. */
export function isBuiltinProvider(slug?: string | null, providerBuiltin = true): boolean {
  if (!slug || slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX) return true;
  if (slug === AgentProvider.OPENCODE || slug === AgentProvider.ANTIGRAVITY) return true;
  if (slug === AgentProvider.KIMI || slug === AgentProvider.DSH) return providerBuiltin;
  return false;
}

/** The minimal ModelProvider row shape the exec resolver needs (a subset of the Prisma row). */
export interface ModelProviderRow {
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  /** A credential that is stored nowhere: a shared pool's session token, minted for this one build of
   *  the engine's environment (shared-pool.ts sharedPoolExecRow). When set it is the key, and
   *  `apiKeyEnc` is not read. */
  sessionToken?: string;
  defaultModel: string | null;
  /** The vendor preset this row came from, and whether it still owns the model list — when it
   *  does, the default model resolves from the catalogue rather than from the row. */
  presetSlug?: string | null;
  followsPreset?: boolean;
  enabled: boolean;
  /** The row's own model list ([{ value, label, contextWindow?, reasoningLevels? }]). A preset-backed
   *  row's models are the catalogue's; an endpoint with no preset — a self-hosted server — has no
   *  catalogue anywhere, so what its owner wrote here is the only description of it there is. */
  models?: unknown;
}

/** The row's own entry for `model`, as its owner wrote it. */
function ownModel(
  row: ModelProviderRow,
  model: string,
): { value: string; contextWindow?: unknown; reasoningLevels?: unknown } | undefined {
  if (!Array.isArray(row.models)) return undefined;
  return row.models.find(
    (entry): entry is { value: string; contextWindow?: unknown; reasoningLevels?: unknown } =>
      !!entry && typeof entry === 'object' && (entry as { value?: unknown }).value === model,
  );
}

/**
 * The reasoning efforts a configured Claude-runtime model accepts, when its row declares them, or
 * undefined when it declares nothing — which leaves effort exactly as it always was.
 *
 * Declared for an endpoint whose model refuses some of Claude Code's levels. Claude Code sends
 * `output_config.effort` for every model id it does not recognise — `high` when the session names no
 * effort at all (measured on 2.1.283) — and a self-hosted server passes it through to the model: vLLM
 * turns it into `reasoning_effort`, and Qwen3.8's chat template raises on anything but
 * xhigh/medium/low, so every request of such a session is a 400. Nothing the CLI reads can say "this
 * model takes only these" for an Anthropic-compatible endpoint (its per-model capability variables are
 * honoured on Bedrock/Vertex and ignored here), so the declaration lives on the row and dispatch maps
 * the session's effort onto it (normalizeEffortForRuntimeModel). An empty list is a model that takes
 * no effort at all (see injectedEnv).
 */
export function declaredReasoningLevels(
  row: ModelProviderRow | null,
  model: string,
): string[] | undefined {
  if (!row || !row.enabled || runtimeOf(row) !== AgentProvider.CLAUDE) return undefined;
  const levels = ownModel(row, model)?.reasoningLevels;
  if (!Array.isArray(levels)) return undefined;
  return levels.filter((level): level is string => typeof level === 'string');
}

function runtimeOf(row: ModelProviderRow): AgentProvider {
  if (row.runtime === AgentProvider.CLAUDE) return AgentProvider.CLAUDE;
  if (row.runtime === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (row.runtime === AgentProvider.KIMI) return AgentProvider.KIMI;
  if (row.runtime === AgentProvider.ANTIGRAVITY) return AgentProvider.ANTIGRAVITY;
  if (row.runtime === AgentProvider.DSH) return AgentProvider.DSH;
  throw new BadRequestException(`provider runtime not available: "${row.runtime}"`);
}

/**
 * The built-in runtime that will actually execute a provider identity: a live configured row's
 * borrowed runtime, else the built-in ladder (with the same Claude fallback a
 * deleted/disabled slug dispatches under). This is exactly `resolveProviderExec`'s `provider`,
 * answered without resolving a model or decrypting a key — the question a provider switch asks
 * of both sides before deciding whether the session may move.
 */
export function execRuntime(args: {
  declaredProvider?: string | null;
  declaredProviderBuiltin?: boolean;
  customRow: ModelProviderRow | null;
}): AgentProvider {
  if (args.customRow && !args.customRow.enabled && (
    args.customRow.runtime === AgentProvider.DSH ||
    (args.declaredProvider === AgentProvider.DSH && args.customRow.runtime !== AgentProvider.CLAUDE)
  )) {
    throw new BadRequestException('DeepSeek Harness provider is disabled');
  }
  if (args.customRow && args.customRow.enabled) return runtimeOf(args.customRow);
  if (args.declaredProvider === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (args.declaredProvider === AgentProvider.OPENCODE) return AgentProvider.OPENCODE;
  if (args.declaredProvider === AgentProvider.ANTIGRAVITY) return AgentProvider.ANTIGRAVITY;
  if (args.declaredProvider === AgentProvider.KIMI && args.declaredProviderBuiltin !== false) {
    return AgentProvider.KIMI;
  }
  if (args.declaredProvider === AgentProvider.DSH && args.declaredProviderBuiltin !== false) {
    return AgentProvider.DSH;
  }
  return AgentProvider.CLAUDE;
}

/**
 * The configured providers `ownerId` may resolve a slug to: their own, and the shared ones (ownerId
 * NULL, which an admin keeps under /admin/providers) only when `ownerId` is an admin. A session on a
 * configured provider is handed its key — decrypted into the engine's environment (injectedEnv) on the
 * runner the session runs on, which its owner registered themselves — so a shared row any account
 * could resolve would give its key to anybody who can sign up. The owner decided (2026-10-07) that a
 * shared provider is the admins' own: a key is shared with other people through a shared pool, whose
 * owner adds each person and whose gateway keeps the key off their runners (resolveSharedPool).
 *
 * The role is read on every resolution, as AdminRoleGuard reads it, so a promotion or a demotion
 * counts from the next door asked. Every door that resolves a slug to a row asks this, and the claim
 * asks usableProviderSql, its twin in SQL, so no two doors disagree about which rows a session may run
 * on.
 */
export async function usableProviderScope(
  db: Pick<Prisma.TransactionClient, 'user'>,
  ownerId: string,
): Promise<Prisma.ModelProviderWhereInput> {
  return (await isAdmin(db, ownerId)) ? { OR: [{ ownerId: null }, { ownerId }] } : { ownerId };
}

/** usableProviderScope in SQL: `row` names a model_provider row, `ownerId` the id of the account asking. */
export function usableProviderSql(row: string, ownerId: Prisma.Sql): Prisma.Sql {
  const provider = Prisma.raw(row);
  return Prisma.sql`(${provider}."owner_id" = ${ownerId} OR (${provider}."owner_id" IS NULL AND EXISTS (
    SELECT 1 FROM "user" u WHERE u."id" = ${ownerId} AND u."role" = 'ADMIN')))`;
}

/**
 * What a door tells someone who names a shared provider they may not use (usableProviderScope), or null
 * when `slug` names no shared provider or they are an admin. The row exists and only the role keeps it
 * from them, so "not available" would send them looking for a typo.
 */
export async function adminOnlyProviderRefusal(
  db: Pick<Prisma.TransactionClient, 'user' | 'modelProvider'>,
  ownerId: string,
  slug: string,
): Promise<string | null> {
  const shared = await db.modelProvider.findFirst({ where: { slug, ownerId: null }, select: { id: true } });
  if (!shared || (await isAdmin(db, ownerId))) return null;
  return `provider "${slug}" is available to admins only; ask an admin to add you to a shared pool`;
}

async function isAdmin(db: Pick<Prisma.TransactionClient, 'user'>, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === 'ADMIN';
}

/**
 * The built-in runtime a session's turns actually execute on, resolving a configured (BYOK)
 * slug to the runtime it borrows. The ModelProvider lookup happens only for a slug that needs
 * one, so a built-in session costs nothing.
 *
 * Shared rather than re-derived so that everything asking a runtime-shaped question about a
 * session — can it be steered, and may this poller be handed that steer — answers it from the
 * same resolution dispatch itself uses. Two spellings of it would disagree on exactly the
 * sessions that are hardest to notice: the configured ones.
 */
export async function sessionExecRuntime(
  tx: Prisma.TransactionClient,
  session: { provider: string; providerBuiltin?: boolean; ownerId: string },
): Promise<AgentProvider> {
  const builtin = isBuiltinProvider(session.provider, session.providerBuiltin);
  const customRow = builtin
    ? null
    : await tx.modelProvider.findFirst({
        where: { slug: session.provider, ...(await usableProviderScope(tx, session.ownerId)) },
      });
  // A pool holds no provider row: it runs on its own engine — a shared pool on Codex, not the Claude a
  // slug nothing holds falls back to.
  const pool = builtin || customRow ? null : await accountPoolRuntime(tx, session.ownerId, session.provider);
  return (
    pool ??
    execRuntime({
      declaredProvider: session.provider,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow,
    })
  );
}

/**
 * Every provider slug whose sessions run on `runtime` for `ownerId`: the built-in slug itself, and
 * each enabled configured row they may resolve (usableProviderScope) that borrows it, the way a Gemini
 * key runs on Antigravity under a slug of its own. This is what a runner-capability gate has to ask
 * (ADVERTISED_RUNTIMES): a runner that never advertised the runtime is handed that runtime's job
 * whichever of these slugs the session names. A disabled row cannot dispatch, so it is not one of
 * them. The claim SQL (QueueService.trySessionClaim) asks the same question of the same rows;
 * migration 0372's trigger still counts every shared row, which can only refuse a claim the claim SQL
 * never makes.
 */
export async function providerSlugsOn(
  db: Prisma.TransactionClient,
  ownerId: string,
  runtime: AgentProvider,
): Promise<string[]> {
  const borrowing = await db.modelProvider.findMany({
    where: { runtime, enabled: true, ...(await usableProviderScope(db, ownerId)) },
    select: { slug: true },
  });
  return [runtime, ...borrowing.map((row) => row.slug)];
}

/** A dsh keyword collision stays configured: only its row's actual runtime decides its gate. */
export async function providerDispatchWhereOn(
  db: Prisma.TransactionClient,
  ownerId: string,
  runtime: AgentProvider,
): Promise<Prisma.SessionWhereInput> {
  const slugs = await providerSlugsOn(db, ownerId, runtime);
  return runtime === AgentProvider.DSH
    ? { OR: [
        { provider: runtime, providerBuiltin: true },
        { provider: { in: slugs.slice(1) }, providerBuiltin: false },
      ] }
    : { provider: { in: slugs }, ...(slugs.includes(AgentProvider.DSH)
        ? { NOT: { provider: AgentProvider.DSH, providerBuiltin: true } } : {}) };
}

/**
 * The runtime `slug` borrows when it names a pool `ownerId` may dispatch with, else null: one of their own
 * account pools, which runs on the engine it was made on — `claude` runs on whichever member the claim
 * picks (QueueService.resolvePoolMember), and only a Claude subscription is admitted as one
 * (ProvidersService.assertPoolMembers), while `codex` (migration 0323) runs on the ChatGPT logins the
 * server signed in and holds for it (CodexLoginService) — or a Codex pool they are one of the people of:
 * a shared pool (migration 0321), or somebody else's own pool its owner added them to (migration 0358),
 * either of which runs them on its API keys through the pool gateway (QueueService.resolveSharedPool).
 *
 * Asked by the doors that accept a provider slug once no provider holds it. Somebody else's account pool
 * they are not in, and a shared pool `ownerId` is not in, is refused like a slug nothing holds, which is
 * also how the claim treats it.
 */
export async function accountPoolRuntime(
  db: Prisma.TransactionClient,
  ownerId: string,
  slug: string,
): Promise<AgentProvider | null> {
  const own = await db.providerPool.findFirst({ where: { slug, ownerId }, select: { shared: true, engine: true } });
  if (own && !own.shared) return own.engine === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
  // A Codex pool is reached by its people, whoever made it.
  const shared = await db.providerPool.findFirst({
    where: { slug, engine: AgentProvider.CODEX, people: { some: { userId: ownerId } } },
    select: { id: true },
  });
  return shared ? AgentProvider.CODEX : null;
}

/** Whether a row points at Anthropic's own endpoint — compared by hostname, so a path such as
 *  `/anthropic` on a vendor's domain is not mistaken for it. */
function isAnthropicEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === ANTHROPIC_HOST;
  } catch {
    return false;
  }
}

// Env injected so the borrowed runtime CLI talks to the provider's endpoint. Claude runtime →
// Anthropic-compatible vars (Phase 1); codex runtime → OpenAI-compatible (Phase 2); kimi runtime →
// the Kimi CLI's own KIMI_MODEL_* provider; antigravity runtime → agy's GEMINI_API_KEY /
// GOOGLE_GEMINI_BASE_URL.
function injectedEnv(row: ModelProviderRow, model: string): Record<string, string> {
  const apiKey = row.sessionToken ?? decryptSecret(row.apiKeyEnc);
  if (runtimeOf(row) === AgentProvider.DSH) {
    // P2 fixes these in the session overlay, including apiKeyEnv=ORBIT_DSH_API_KEY. A Harness
    // provider never falls through to Claude credentials or the project's ambient DeepSeek key.
    return { ORBIT_DSH_API_KEY: apiKey, ORBIT_DSH_BASE_URL: row.baseUrl };
  }
  if (runtimeOf(row) === AgentProvider.CODEX) {
    return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
  }
  if (runtimeOf(row) === AgentProvider.ANTIGRAVITY) {
    // agy takes a Gemini key from its environment alone: the runner writes the Gemini directory
    // that puts it in API-key mode (`modelProvider: gemini`), and GEMINI_API_KEY is then the whole
    // sign-in. GOOGLE_GEMINI_BASE_URL is the endpoint, to which agy appends
    // /v1beta/models/{model}:streamGenerateContent itself (docs/antigravity-runtime-contract.md
    // §1.1). The model is not here: agy takes it as --model/--effort, which the runner builds from
    // the job's model and effort the same way it does for the built-in engine.
    return { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: row.baseUrl };
  }
  if (runtimeOf(row) === AgentProvider.KIMI) {
    // Kimi has no base-url/key flags: setting KIMI_MODEL_NAME is what makes the CLI synthesize an
    // in-memory provider from these, and it refuses to start with any of the pair missing. The
    // model travels in the environment rather than through ACP's `model` config option, which
    // would switch the session back to the runner's own Kimi sign-in and ignore this key —
    // hence the runner's kimiUsesEnvModel() check. The type pins the protocol the base URL
    // speaks, so a row pointed at a CN/self-hosted Moonshot endpoint stays consistent.
    return {
      KIMI_MODEL_NAME: model,
      KIMI_MODEL_API_KEY: apiKey,
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: row.baseUrl,
    };
  }
  const claudeEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: row.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // The model the session runs, beside the endpoint that serves it. The engine itself is told by
    // --model, which outranks this; what reads it is a command the session runs that must call the
    // same model through a clean Claude Code of its own — `orbit wiki verify` (wiki contract
    // `agentSurface.verify.model`) — and has no --model of the session's to read.
    ANTHROPIC_MODEL: model,
    // Claude Code disables claude.ai connectors on its own once an auth token is set — the
    // token above — and then warns on stderr, every start, that unsetting it would bring them
    // back. Unsetting it is exactly what must not happen here (it IS the provider's key), so
    // turn the feature off explicitly: same outcome, no advice that would break the session.
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    // The built-in Explore agent is declared `inherit` but capped at the opus tier: when the
    // session's model is not one of Claude's own families (deepseek-flash is not), Explore asks
    // for *opus*, and on an endpoint like this one that resolves to the vendor's own top model.
    // Every research subagent then runs — and bills — a generation above the model the user
    // picked and the row defaults to. The CLI's switch for exactly this case makes Explore
    // inherit the session model; `CLAUDE_CODE_SUBAGENT_MODEL` does not (measured on 2.1.278).
    CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: '1',
  };
  // A late tool discovery inside a conversation that has run on Anthropic's own endpoint travels
  // inline — `tool_addition` carrying the whole `tool_definition` — the shape that endpoint's
  // inline-tools beta asks for. Switching that same conversation to a vendor shim replays the
  // recorded blocks, and a shim that implements only the by-name form answers 422; DeepSeek words
  // it "unknown variant `tool_definition`", which the CLI's rejection classifier does not know (it
  // matches Anthropic's own "Input tag 'tool_definition'"), so the CLI's built-in fallback —
  // re-declare the late tools in `tools[]` and reference them by name — never fires, and every
  // turn of that session keeps failing until the model is switched back. With this off the engine
  // takes the by-name path from the start (measured on 2.1.292 against DeepSeek: the conversation
  // that 422s without it completes a turn with it). Injected only where the host is not
  // Anthropic's: there the inline form is served, and the session keeps it.
  if (!isAnthropicEndpoint(row.baseUrl)) {
    claudeEnv.CLAUDE_CODE_INLINE_TOOLS = 'false';
  }
  // A model id the CLI's own catalog doesn't describe gets 200k assumed for it, and auto-compact
  // keeps the session inside that. The endpoint can't correct the CLI — an Anthropic-compatible
  // shim like DeepSeek's serves no /v1/models for it to ask — so the declared window travels as
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS, which the CLI reads as the model's real window. Read from the
  // merged catalog rather than the shipped list: a models.dev refresh adds newer models that carry
  // their own windows (e.g. deepseek-flash), and a preset-backed session may pin one. A model no
  // catalogue describes — any model of a self-hosted endpoint — has only the window its row declares,
  // and a server started with a smaller one (vLLM's --max-model-len) refuses every request past it.
  const preset = providerPreset(row.presetSlug);
  const window =
    (preset ? catalogModels(preset).find((m) => m.value === model)?.contextWindow : undefined) ??
    ownModel(row, model)?.contextWindow;
  if (typeof window === 'number' && window > 0) {
    claudeEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
  }
  // A model declared to take no effort at all. The CLI sends one regardless, and the only thing that
  // stops it is this variable: `unset` is the CLI's own spelling for "send no effort parameter", and it
  // outranks --effort and every later effort frame — which is right here, since there is no level such
  // a model could be moved to.
  if (declaredReasoningLevels(row, model)?.length === 0) {
    claudeEnv.CLAUDE_CODE_EFFORT_LEVEL = 'unset';
  }
  return claudeEnv;
}

/** A Claude subscription token: Anthropic serves it to its own clients only, so OpenCode never gets
 *  one (plan-usage.ts reads the same prefix for the same reason). */
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Whether an OpenCode session may spend this configured key (shared `openCodeKeys`): enabled, on a
 * dialect OpenCode speaks — every one a configured key can speak — and holding an API key rather than
 * a Claude subscription token. A pool's members are rows too and answer the same way; the pool itself
 * holds no key to hand over, so it is not one.
 */
export function runsOnOpenCode(row: Pick<ModelProviderRow, 'runtime' | 'enabled' | 'apiKeyEnc'>): boolean {
  if (!row.enabled || !keyDialect(row.runtime)) return false;
  try {
    return !decryptSecret(row.apiKeyEnc).trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX);
  } catch {
    return false;
  }
}

/** A configured row with the slug an OpenCode model names it by. */
export type OpenCodeKeyRow = ModelProviderRow & { slug: string };

/**
 * Every configured key `ownerId` could name in an OpenCode model: the rows a session's provider
 * resolves to (usableProviderScope) — their own, and the shared ones only for an admin. Read for an
 * OpenCode session only, and handed to resolveProviderExec, which takes the one the model names.
 */
export async function openCodeKeyRows(
  db: Prisma.TransactionClient,
  ownerId: string,
): Promise<OpenCodeKeyRow[]> {
  return db.modelProvider.findMany({ where: { enabled: true, ...(await usableProviderScope(db, ownerId)) } });
}

/**
 * The OPENCODE_CONFIG_CONTENT that runs `model` on this key: one provider named for the key, driving
 * its endpoint through the AI SDK package of its dialect with its key — the endpoint and protocol
 * Orbit already runs it on with its own CLI — and declaring the model, which OpenCode refuses to
 * select otherwise. Merged over the workspace's own content, and the runner merges its agent and
 * permission config over this in turn (runner-go openCodeConfigContent).
 */
function openCodeKeyConfig(row: OpenCodeKeyRow, model: string, base?: string): string {
  const dialect = keyDialect(row.runtime)!;
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = base ? JSON.parse(base) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the runner reports the workspace's broken value on its own; this key's provider
    // still goes through.
  }
  const providers =
    config.provider && typeof config.provider === 'object' ? (config.provider as Record<string, unknown>) : {};
  config.provider = {
    ...providers,
    [openCodeKeyProvider(row.slug)]: {
      npm: OPENCODE_DIALECT_NPM[dialect],
      options: { baseURL: openCodeBaseUrl(dialect, row.baseUrl), apiKey: decryptSecret(row.apiKeyEnc) },
      models: { [model]: { name: model } },
    },
  };
  return JSON.stringify(config);
}

/**
 * Resolve how to actually run a (possibly custom) provider at dispatch: the runner-facing
 * built-in runtime, the model to pass, and the process env. For a configured provider
 * the runner never learns its slug — it receives the borrowed runtime with an environment pointing
 * at the provider's endpoint. A configured row can borrow Claude, Codex, Kimi, Antigravity or dsh,
 * but not OpenCode.
 *
 * `customRow` is null only for a built-in runtime at dispatch. Unresolved, disabled and unknown
 * configured runtimes are refused before a runner-facing job can be built.
 */
export function resolveProviderExec(args: {
  declaredProvider?: string | null;
  /** False for a configured identity that collides with a discriminator-aware runtime keyword. */
  declaredProviderBuiltin?: boolean;
  customRow: ModelProviderRow | null;
  sessionModel?: string | null;
  /** True for Sessions created under Runtime-default semantics. False marks a model-less row
   * written by an old API replica during the 0079 rolling deployment. Defaults to true for
   * non-persisted/direct callers. */
  usesRuntimeDefaultModel?: boolean;
  /** Effective default reported by built-in runtimes on the assigned runner. A custom provider's
   * ModelProvider row remains authoritative — except for a vendor that IS the runtime CLI's own
   * endpoint, whose model space this describes (see runtimeCatalogDefault). */
  runtimeDefaultModels?: unknown;
  /**
   * Legacy per-Workspace pin. New clients never write this field, but a model-less Session created
   * or claimed by an old API replica must keep the pre-0079 model through a rolling deployment.
   * The claim path immediately snapshots this fallback onto Session.model.
   */
  workspaceModel?: string | null;
  /** Runtime-reported catalog on the assigned runner; its first model is the final dynamic
   * fallback before the shared static default. Ignored for configured providers, except those on
   * the runtime CLI's own endpoint (see runtimeCatalogDefault). */
  modelCatalog?: unknown;
  workspaceEnv?: Record<string, string> | null;
  /** The Codex account slot this session runs on (Session.codexAccount ?? Workspace.codexAccount). Only a built-in
   *  Codex session reads it: it is resolved against `runnerEngines` into the CODEX_HOME injected
   *  below, and a slot that runner does not report runs on Default (accountOnRunner). */
  codexAccount?: string | null;
  /** The Claude account slot this session runs on (Workspace.claudeAccount today), the sibling of
   *  codexAccount and read the same way: resolved into the CLAUDE_CONFIG_DIR injected below. */
  claudeAccount?: string | null;
  /** The Antigravity Google account slot this session runs on (Session.antigravityAccount ??
   *  Workspace.antigravityAccount), read the same way: resolved into the ORBIT_ANTIGRAVITY_GOOGLE_DIR
   *  injected below, which the runner reads to pick the sign-in the session's agy runs on. */
  antigravityAccount?: string | null;
  /** The Kimi Code account slot this session runs on (Session.kimiAccount ?? Workspace.kimiAccount),
   *  read the same way: resolved into the KIMI_CODE_HOME injected below, the directory Kimi Code keeps
   *  its whole login in. */
  kimiAccount?: string | null;
  /** Runner.engines of the assigned runner: where each account's directory is reported. */
  runnerEngines?: unknown;
  /** The owner's configured keys (openCodeKeyRows), for an OpenCode session whose model names one
   *  (`orbit-<slug>/<model>`): that key is written into the run's OPENCODE_CONFIG_CONTENT. */
  openCodeKeys?: OpenCodeKeyRow[];
}): {
  provider: AgentProvider;
  model: string;
  env?: Record<string, string>;
  /** The session's own model was dropped because the Runtime no longer offers it. The claim path
   *  re-materializes on this, so the row stops naming a model the session isn't running. */
  retiredPin?: boolean;
  /** The efforts the resolved model accepts, when its configured row declares them
   *  (declaredReasoningLevels): what every door that hands the engine an effort maps it onto. */
  reasoningLevels?: string[];
} {
  const { customRow, sessionModel, workspaceModel, workspaceEnv } = args;
  if (customRow && !customRow.enabled) {
    throw new BadRequestException('provider is disabled');
  }
  if (!customRow && !isBuiltinProvider(args.declaredProvider, args.declaredProviderBuiltin)) {
    throw new BadRequestException(`provider not available: "${args.declaredProvider}"`);
  }
  const legacyInheritance = args.usesRuntimeDefaultModel === false;
  if (customRow && customRow.enabled) {
    const runtime = execRuntime(args);
    const pin = nonBlankModel(runtime, sessionModel);
    const retired = retiredPin(customRow, runtime, args, pin);
    // A custom provider's model space is its own; never coerce it through the claude/gpt
    // prefix guard. Workspace.model is only a rolling-deploy bridge for model-less sessions made
    // by old replicas; current clients put their choice directly on Session.model.
    const model =
      (retired ? undefined : pin) ||
      firstNonBlank(legacyInheritance && runtime !== AgentProvider.DSH ? workspaceModel : undefined) ||
      runtimeCatalogDefault(customRow, runtime, args) ||
      (runtime !== AgentProvider.DSH ? presetDefaultModel(customRow) : undefined) ||
      DEFAULT_MODEL_BY_PROVIDER[runtime];
    const reasoningLevels = declaredReasoningLevels(customRow, model);
    return {
      provider: runtime,
      model,
      // Provider env wins over any user-set workspace env (e.g. a hand-typed ANTHROPIC_BASE_URL).
      // The kimi runtime also reads the model from here, so it can only be built once the
      // model above is resolved.
      env: { ...(workspaceEnv ?? {}), ...injectedEnv(customRow, model) },
      ...(retired ? { retiredPin: true } : {}),
      ...(reasoningLevels ? { reasoningLevels } : {}),
    };
  }
  // Built-in: the runtime authenticates itself.
  // each runner carries its own `claude auth login`, and a session that finds it missing surfaces
  // the sign-in card (RunnerSignIn) rather than the control plane holding a credential for it.
  const provider = execRuntime(args);
  // A session on an account other than Default runs in that account's own directory — a Codex
  // CODEX_HOME, a Claude Code CLAUDE_CONFIG_DIR, an Antigravity Google sign-in's Gemini directory, a
  // Kimi Code KIMI_CODE_HOME.
  // Built-in only: a configured provider brings its own key, so no sign-in on the machine is spent.
  // The chosen account replaces any such variable typed into the workspace's env.
  const accountId = isAccountEngine(provider) ? args[ACCOUNT_CHOICE[provider]] : undefined;
  const account = accountOnRunner(provider, accountId, args.runnerEngines);
  const dirVar = accountEnvVar(provider);
  const env =
    account && dirVar
      ? { ...(workspaceEnv ?? {}), [dirVar]: accountDir(account) }
      : (workspaceEnv ?? undefined);
  const pin = nonBlankModel(provider, sessionModel);
  const retired = retiredPin(null, provider, args, pin);
  const explicitSessionModel = retired ? undefined : pin;
  // An explicit per-session selection retains the historical safety behavior: a clearly
  // cross-provider id is coerced straight to the static provider default. During a rolling
  // deployment, old replicas can still create a model-less Session that expects Workspace.model;
  // preserve that one-time inheritance ahead of new Runtime defaults. Queue claim snapshots it
  // onto Session.model, and current Workspace create/update paths never write a new pin.
  const inheritsWorkspace = legacyInheritance && provider !== AgentProvider.DSH;
  const legacyWorkspaceModel = inheritsWorkspace ? firstNonBlank(workspaceModel) : undefined;
  // The rows this provider's own space offers on the assigned runner, where the runner has
  // reported them: what decides an Antigravity id, whose space a prefix cannot describe — a Google
  // sign-in adds `claude-opus-5-5` and `gpt-oss-120b` rows, and dropping one here is exactly the
  // silent fallback to Gemini this passes the catalogue in to stop.
  const offered = runtimeCatalogModels(args.modelCatalog, provider);
  const inheritedModel = inheritsWorkspace
    ? modelForProvider(provider, legacyWorkspaceModel, offered)
    : firstCompatibleModel(
        provider,
        offered,
        savedRuntimeDefaultModel(args.runtimeDefaultModels, provider),
        firstRuntimeCatalogModel(args.modelCatalog, provider),
      );
  const model = modelForProvider(provider, explicitSessionModel ?? inheritedModel, offered);
  // An OpenCode model on one of the owner's configured keys runs on that key, and on nothing else:
  // a key that is gone, disabled or not one OpenCode may spend refuses the run rather than letting
  // OpenCode fall back to whatever this machine's own config holds for that name.
  const key = provider === AgentProvider.OPENCODE ? openCodeKeyOf(model) : null;
  if (key) {
    const row = args.openCodeKeys?.find((candidate) => candidate.slug === key.slug);
    if (!row || !runsOnOpenCode(row)) {
      throw new BadRequestException(`provider not available on OpenCode: "${key.slug}"`);
    }
    return {
      provider,
      model,
      env: { ...(env ?? {}), OPENCODE_CONFIG_CONTENT: openCodeKeyConfig(row, key.model, env?.OPENCODE_CONFIG_CONTENT) },
      ...(retired ? { retiredPin: true } : {}),
    };
  }
  return {
    provider,
    model,
    env,
    ...(retired ? { retiredPin: true } : {}),
  };
}

/**
 * The default for a provider whose vendor IS the runtime CLI's own endpoint: what that CLI reports
 * on the assigned runner, so a model-less session runs the newest model it offers the day it ships.
 *
 * The preset's `models`/`defaultModel` are a shipped fallback for those vendors, not a catalogue —
 * without this, dispatch materializes that fallback onto the session and a BYOK Anthropic provider
 * keeps starting on last generation's Opus while every picker already offers the new one. Precedence
 * mirrors the clients exactly (web `defaultModelForProvider`, Swift `effectiveDefaultModel`):
 * runtime-reported default, then the first row of its catalogue.
 *
 * Undefined for everyone else — the runner probes its own CLI, which says nothing about what a
 * third-party vendor (DeepSeek, Moonshot, GLM…) serves.
 */
function runtimeCatalogDefault(
  row: ModelProviderRow,
  runtime: AgentProvider,
  args: { runtimeDefaultModels?: unknown; modelCatalog?: unknown },
): string | undefined {
  if (runtime !== AgentProvider.DSH && !followsRuntimeCatalog(row)) return undefined;
  if (runtime === AgentProvider.DSH) {
    return savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime) ??
      firstRuntimeCatalogModel(args.modelCatalog, runtime);
  }
  return firstNonBlank(
    savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime),
    firstRuntimeCatalogModel(args.modelCatalog, runtime),
  );
}

/**
 * Whether the Runtime has retired the session's own model — if so it is dropped, and the session
 * falls through to the provider's current default exactly as a model-less one would.
 *
 * A pin only survives because the model still exists. When it stops being offered, honouring it
 * keeps the session a generation behind forever, and the pickers (which draw the same catalogue)
 * would have to render a dead id nobody can select back. The claim path re-materializes what
 * dispatch resolved, so the row stops carrying the retired value too.
 *
 * Judged only against a runtime CLI's own catalogue — a built-in runtime, or a vendor whose
 * endpoint IS that CLI's. A configured third-party keeps its pin: its list is a document we mirror
 * (models.dev) or one the user maintains, and neither retires an id reliably enough to overrule a
 * deliberate choice. OpenCode is out too: it owns model selection, and the ids it reports are a
 * slice of a multi-provider space rather than the whole of it. Antigravity is judged like the rest,
 * against the base models its runner folds `agy models` into — and the full level-suffixed slug a
 * caller typed (`gemini-3.8-flash-high`, `claude-sonnet-5-5-medium`) is that same base model, so
 * the base row is the answer rather than the whole slug reading as retired.
 */
function retiredPin(
  row: ModelProviderRow | null,
  runtime: AgentProvider,
  args: { runtimeDefaultModels?: unknown; modelCatalog?: unknown },
  model: string | undefined,
): boolean {
  if (!model) return false;
  if (runtime === AgentProvider.OPENCODE) return false;
  if (row && runtime !== AgentProvider.DSH && !followsRuntimeCatalog(row)) return false;
  if (runtime === AgentProvider.DSH) {
    const offered = runtimeCatalogModels(args.modelCatalog, runtime);
    return !!offered?.length && model !== savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime)
      && !offered.some((entry) => entry.value === model);
  }
  // agy's catalogue reports each base model once, while the slug its CLI also accepts carries its
  // level (`claude-sonnet-5-5-medium`): the base row is the same model's answer, so a
  // level-suffixed id is judged by it rather than dropped as an id agy no longer lists.
  const judged = runtime === AgentProvider.ANTIGRAVITY ? antigravityBaseModel(model) : model;
  return isRetiredModel(
    judged,
    runtimeCatalogModels(args.modelCatalog, runtime),
    savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime),
  );
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function nonBlankModel(runtime: AgentProvider, value?: string | null): string | undefined {
  if (runtime === AgentProvider.DSH) return typeof value === 'string' && value.trim() ? value : undefined;
  return firstNonBlank(value);
}

function firstCompatibleModel(
  provider: AgentProvider,
  offered: Array<{ value: string }> | undefined,
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const model = nonBlankModel(provider, value);
    if (model && modelForProvider(provider, model, offered) === model) return model;
  }
  return undefined;
}
