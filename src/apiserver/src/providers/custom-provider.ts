import {
  AgentProvider,
  DEFAULT_MODEL_BY_PROVIDER,
  ENGINE_CLI_NAMES,
  antigravityBaseModel,
  credentialEngines,
  decodeCursorModel,
  isEngineCompatible,
  isRetiredModel,
  keyDialect,
  isClaudeRoutingVar,
  LOCAL_AUTH_PLACEHOLDER,
  LOCAL_CLAUDE_CLEARED_ENV,
  LOCAL_PROVIDER_MARKER_VAR,
  LOCAL_PROVIDER_ERROR_PREFIX,
  localProviderReadiness,
  localTargetModel,
  modelForProvider,
  OPENCODE_DIALECT_NPM,
  openCodeBaseUrl,
  openCodeDialect,
  openCodeKeyModel,
  openCodeKeyOf,
  openCodeKeyProvider,
  providerPreset,
  type EngineCredential,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { accountDir, isAccountEngine } from '@orbit/shared';
import { ACCOUNT_CHOICE, accountEnvVar, accountOnRunner, type AccountRunner } from './account';
import {
  anthropicGatewayUrl,
  engineTableOptions,
  gatewaySmallModel,
  KEY_GATEWAY_TOKEN_PREFIX,
  runsThroughAnthropicGateway,
} from './key-gateway';
import { codexLoginToken, poolTableOptions } from './codex-login-claude';
import { catalogModels } from './model-catalog';
import { ANTHROPIC_HOST } from './plan-usage';
import { decryptSecret } from './provider-crypto';
import { LANDING_PROVIDER_SLUG } from './provider-slug';
import { followsRuntimeCatalog, presetDefaultModel } from './preset-overlay';
import {
  firstRuntimeCatalogModel,
  runtimeCatalogModels,
  savedRuntimeDefaultModel,
} from '../common/runtime-model';

// A built-in provider is an engine's own sign-in on the runner (or OpenCode's own configuration), named
// by the engine. Any other `provider` value is a credential configured on the control plane — a key
// (ModelProvider) or an account pool — that an engine runs on (docs/provider-engine-contract.md §1.3).
/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug.
 * `providerBuiltin` fences configured `kimi` / `dsh` slugs during rolling
 * deployment; Claude/Codex predate the discriminator, and migrations 0080, 0367 and 0426 move any
 * pre-existing custom `opencode` / `antigravity` / `cursor` row (0367: or account pool; 0426: or
 * retired name) aside, so all five remain unambiguous. */
export function isBuiltinProvider(slug?: string | null, providerBuiltin = true): boolean {
  if (!slug || slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX) return true;
  if (slug === AgentProvider.OPENCODE || slug === AgentProvider.ANTIGRAVITY || slug === AgentProvider.CURSOR) return true;
  // The LANDING session's provider (0436) is the platform's own value, not a configured key: like a
  // built-in engine's slug it is never looked up as one. It has no engine (builtinSessionEngine
  // returns null), but "built-in" is what says no configured row answers to it.
  if (slug === LANDING_PROVIDER_SLUG) return true;
  if (slug === AgentProvider.KIMI || slug === AgentProvider.DSH) return providerBuiltin;
  return false;
}

/**
 * The engine a built-in provider slug names, or null when the slug needs a lookup (a key, a pool, or a
 * configured identity named `kimi`/`dsh`): docs/provider-engine-contract.md §5.4 steps 1–2. `claude`,
 * `codex`, `opencode`, `antigravity` and `cursor` are unambiguous (isBuiltinProvider); `kimi` and `dsh`
 * are the engine only when the row says it is the built-in one. No provider at all is the column default.
 */
export function builtinSessionEngine(
  provider: string | null | undefined,
  providerBuiltin: boolean | null | undefined,
): AgentProvider | null {
  if (!provider) return AgentProvider.CLAUDE;
  if (
    provider === AgentProvider.CLAUDE ||
    provider === AgentProvider.CODEX ||
    provider === AgentProvider.OPENCODE ||
    provider === AgentProvider.ANTIGRAVITY ||
    provider === AgentProvider.CURSOR
  ) {
    return provider;
  }
  if ((provider === AgentProvider.KIMI || provider === AgentProvider.DSH) && providerBuiltin) return provider;
  return null;
}

/** The runtimes a key's row could name before the split, each the engine its sessions ran on. */
const KEY_ROW_ENGINES: ReadonlySet<string> = new Set([
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.KIMI,
  AgentProvider.ANTIGRAVITY,
  AgentProvider.DSH,
  AgentProvider.CURSOR,
]);

/** The engine a key's row ran its sessions on before the split — its runtime, when that is one — and
 *  so the engine a caller naming only that key gets. Null for a runtime no engine speaks. */
export function keyRowEngine(runtime: string | null | undefined): AgentProvider | null {
  return runtime && KEY_ROW_ENGINES.has(runtime) ? (runtime as AgentProvider) : null;
}

/** The minimal ModelProvider row shape the exec resolver needs (a subset of the Prisma row). */
export interface ModelProviderRow {
  /** The row's slug: what an OpenCode session names the key by in its model (openCodeKeyModel).
   *  Absent on a pool's minted row, which no OpenCode session runs on. */
  slug?: string;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  /** A credential that is stored nowhere: a shared pool's session token, minted for this one build of
   *  the engine's environment (shared-pool.ts sharedPoolExecRow). When set it is the key, and
   *  `apiKeyEnc` is not read. */
  sessionToken?: string;
  /** A row minted for a Claude Code session on its owner's own Codex login pool (codex-login-claude.ts
   *  codexLoginClaudeExecRow): the compatibility table reads it as that pool, and `sessionToken` is the
   *  pool's session token, which Claude Code gets with /api/gw/anthropic. */
  codexLogin?: boolean;
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
  /** Migration 0646: `runner` for a model server on one runner's machine (a local Ollama), which runs on
   *  `runnerId` and nowhere else; absent or `account` for every other row and every minted one. */
  scope?: string;
  runnerId?: string | null;
  /** `none`: the endpoint takes no key and none is stored; the engine gets LOCAL_AUTH_PLACEHOLDER. */
  authMode?: string;
  /** What the bound runner's last probe found (migration 0646; phase 2), read by localProviderReadiness. */
  probeState?: string | null;
  probedAt?: Date | string | null;
  instanceModels?: unknown;
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
 *
 * Read for a Claude Code session only (`engine`, the session's; by default the engine the row runs on
 * when nothing else is named): the declaration describes the levels Claude Code sends, and another
 * engine on the same Anthropic-dialect key — OpenCode, DeepSeek Harness — has a vocabulary of its own.
 */
export function declaredReasoningLevels(
  row: ModelProviderRow | null,
  model: string,
  engine: AgentProvider | null = row ? keyRowEngine(row.runtime) : null,
): string[] | undefined {
  if (!row || !row.enabled || engine !== AgentProvider.CLAUDE || keyDialect(row.runtime) !== 'anthropic') {
    return undefined;
  }
  const levels = ownModel(row, model)?.reasoningLevels;
  if (!Array.isArray(levels)) return undefined;
  return levels.filter((level): level is string => typeof level === 'string');
}

/** The engine whose own protocol a key's dialect is: whose model table a key is read by on OpenCode,
 *  which speaks every dialect (§2.2). A legacy `dsh` row speaks Anthropic's, Claude Code's. */
function dialectEngine(runtime: string): AgentProvider {
  switch (keyDialect(runtime)) {
    case 'openai':
      return AgentProvider.CODEX;
    case 'openai-compatible':
      return AgentProvider.KIMI;
    case 'gemini':
      return AgentProvider.ANTIGRAVITY;
    default:
      return AgentProvider.CLAUDE;
  }
}

function runtimeOf(row: ModelProviderRow): AgentProvider {
  if (row.runtime === AgentProvider.CLAUDE) return AgentProvider.CLAUDE;
  if (row.runtime === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (row.runtime === AgentProvider.KIMI) return AgentProvider.KIMI;
  if (row.runtime === AgentProvider.ANTIGRAVITY) return AgentProvider.ANTIGRAVITY;
  if (row.runtime === AgentProvider.DSH) return AgentProvider.DSH;
  if (row.runtime === AgentProvider.CURSOR) return AgentProvider.CURSOR;
  throw new BadRequestException(`provider runtime not available: "${row.runtime}"`);
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
  // The LANDING provider's shared row is the migration's compatibility fence, not a provider any
  // account may be told about (0436).
  if (slug === LANDING_PROVIDER_SLUG) return null;
  const shared = await db.modelProvider.findFirst({ where: { slug, ownerId: null }, select: { id: true } });
  if (!shared || (await isAdmin(db, ownerId))) return null;
  return `provider "${slug}" is available to admins only; ask an admin to add you to a shared pool`;
}

async function isAdmin(db: Pick<Prisma.TransactionClient, 'user'>, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === 'ADMIN';
}

/**
 * The provider slugs under which a session WITHOUT a recorded engine (Session.engine NULL: one an
 * older API replica wrote) runs on `runtime` for `ownerId`, by the old rule: the built-in slug itself,
 * and each enabled configured row they may resolve (usableProviderScope) that borrows it, the way a
 * Gemini key ran on Antigravity under a slug of its own. A disabled row could not dispatch, so it is not
 * one of them. A session with a recorded engine is answered by its engine alone (providerDispatchWhereOn):
 * which slug it names says nothing about the CLI that runs it.
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

/**
 * The sessions of `ownerId` that run on `runtime`: what a runner-capability gate has to ask
 * (ADVERTISED_RUNTIMES) — a runner that never advertised the runtime is handed none of them. A session
 * with a recorded engine is one of them exactly when that engine is `runtime`, whatever its provider;
 * one without is judged by the old rule (providerSlugsOn), where a dsh keyword collision stays
 * configured and only its row's actual runtime decides its gate. The claim SQL
 * (QueueService.trySessionClaim) asks the same question of the same rows.
 */
export async function providerDispatchWhereOn(
  db: Prisma.TransactionClient,
  ownerId: string,
  runtime: AgentProvider,
): Promise<Prisma.SessionWhereInput> {
  const slugs = await providerSlugsOn(db, ownerId, runtime);
  const legacy: Prisma.SessionWhereInput = runtime === AgentProvider.DSH
    ? { OR: [
        { provider: runtime, providerBuiltin: true },
        { provider: { in: slugs.slice(1) }, providerBuiltin: false },
      ] }
    : { provider: { in: slugs }, ...(slugs.includes(AgentProvider.DSH)
        ? { NOT: { provider: AgentProvider.DSH, providerBuiltin: true } } : {}) };
  return { OR: [{ engine: runtime }, { AND: [{ engine: null }, legacy] }] };
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

/** The variable a Cursor key reaches the runner in. */
export const CURSOR_KEY_VAR = 'ORBIT_CURSOR_API_KEY';

/** The fraction of a custom endpoint's window withheld from CLAUDE_CODE_MAX_CONTEXT_TOKENS, so the
 *  CLI's own compaction request still fits the endpoint. See the injection site for the measurement. */
const COMPACTION_RESERVE_FRACTION = 8;

// Env injected so the engine's CLI talks to the key's endpoint, in the variables THAT engine reads
// (docs/provider-engine-contract.md §4.2) — the engine is the session's, and the key only says where
// to send it: Claude Code → the Anthropic-compatible vars (Phase 1); Codex → OpenAI-compatible (Phase
// 2); Kimi Code → the Kimi CLI's own KIMI_MODEL_* provider; Antigravity → agy's GEMINI_API_KEY /
// GOOGLE_GEMINI_BASE_URL; DeepSeek Harness → its own pair; Cursor CLI → ORBIT_CURSOR_API_KEY. The same
// DeepSeek key on Claude Code and on DeepSeek Harness is one endpoint, its baseUrl, read by each in its
// own names. OpenCode is not here: its key travels in its config (openCodeKeyConfig).
function injectedEnv(
  engine: AgentProvider,
  row: ModelProviderRow,
  model: string,
  apiKey: string,
  /** The model's window as the runner's own Codex catalogue reports it, for a `codexLogin` row. */
  catalogWindow?: number,
): Record<string, string> {
  if (engine === AgentProvider.CURSOR) {
    // The runner reads this and starts the CLI with the key as CURSOR_API_KEY, its credentials held in
    // memory only (docs/cursor-runtime-contract.md §8.2, §16.3); the variable itself never reaches the
    // CLI. No endpoint: the CLI trades the key for a token at Cursor's own API, and the row's baseUrl
    // only names it. The model is the session's ACP selection, which the driver sets.
    return { [CURSOR_KEY_VAR]: apiKey };
  }
  if (engine === AgentProvider.DSH) {
    // P2 fixes these in the session overlay, including apiKeyEnv=ORBIT_DSH_API_KEY. A Harness
    // session never falls through to Claude credentials or the project's ambient DeepSeek key.
    return { ORBIT_DSH_API_KEY: apiKey, ORBIT_DSH_BASE_URL: row.baseUrl };
  }
  if (engine === AgentProvider.CODEX) {
    return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
  }
  if (engine === AgentProvider.ANTIGRAVITY) {
    // agy takes a Gemini key from its environment alone: the runner writes the Gemini directory
    // that puts it in API-key mode (`modelProvider: gemini`), and GEMINI_API_KEY is then the whole
    // sign-in. GOOGLE_GEMINI_BASE_URL is the endpoint, to which agy appends
    // /v1beta/models/{model}:streamGenerateContent itself (docs/antigravity-runtime-contract.md
    // §1.1). The model is not here: agy takes it as --model/--effort, which the runner builds from
    // the job's model and effort the same way it does for the built-in engine.
    return { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: row.baseUrl };
  }
  if (engine === AgentProvider.KIMI) {
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
  // An OpenAI key on Claude Code runs through Orbit's own gateway, which holds the key and translates
  // Anthropic Messages to OpenAI Responses (docs/claude-engine-openai-gateway-design.md §4.2). The engine gets
  // the gateway and the session token minted for this build (key-gateway.ts withKeyGatewayToken) — never the
  // key: a build that minted none (a read that dispatches nothing) gets no credential at all.
  const throughGateway = runsThroughAnthropicGateway(AgentProvider.CLAUDE, row);
  // The owner's own Codex login pool (codex-login-claude.ts) goes through the same gateway, on the pool's own
  // session token: the ChatGPT accounts' tokens stay in the API server.
  const claudeEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: throughGateway ? anthropicGatewayUrl() : row.baseUrl,
    ANTHROPIC_AUTH_TOKEN: throughGateway ? (row.codexLogin ? (codexLoginToken(row) ?? '') : gatewayToken(row)) : apiKey,
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
  if (throughGateway || !isAnthropicEndpoint(row.baseUrl)) {
    claudeEnv.CLAUDE_CODE_INLINE_TOOLS = 'false';
  }
  // Claude Code's background requests (WebFetch summaries, side questions) go out on its haiku slot, which on
  // the gateway is the key's small model (design §4.5). A login pool names none: a ChatGPT plan serves the
  // models its Codex catalogue lists, and the CLI then sends the session model there.
  const small = throughGateway && !row.codexLogin ? gatewaySmallModel(row) : undefined;
  if (small) claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
  // A model id the CLI's own catalog doesn't describe gets 200k assumed for it, and auto-compact
  // keeps the session inside that. The endpoint can't correct the CLI — an Anthropic-compatible
  // shim like DeepSeek's serves no /v1/models for it to ask — so the declared window travels as
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS, which the CLI reads as the model's real window. Read from the
  // merged catalog rather than the shipped list: a models.dev refresh adds newer models that carry
  // their own windows (e.g. deepseek-flash), and a preset-backed session may pin one. A model no
  // catalogue describes — any model of a self-hosted endpoint — has only the window its row declares,
  // and a server started with a smaller one (vLLM's --max-model-len) refuses every request past it.
  const preset = providerPreset(row.presetSlug);
  const window = row.codexLogin
    ? catalogWindow
    : (preset ? catalogModels(preset).find((m) => m.value === model)?.contextWindow : undefined) ??
      ownModel(row, model)?.contextWindow;
  if (typeof window === 'number' && window > 0) {
    // Declared short of the endpoint's true maximum, because the CLI's auto-compact path needs room
    // the window alone does not leave it. The CLI compacts when the conversation reaches
    // `window - 32,000` (its output budget), and the compaction request sends the conversation WITH
    // that 32,000 — so at the trigger line the request exactly fills the declared window, and the
    // first token the request carries over the CLI's own measurement puts it past the endpoint's
    // hard cap. That 400 is deliberately non-retryable, and a failed compaction leaves the
    // transcript as large as it was, so the session can never compact again: every later turn
    // repeats the 400 (measured: session 01a005f5 on 2026-11-04 sent 1,081,492 message tokens
    // against a 1,048,576-token cap while its last ordinary request measured 1,015,430; session
    // 01a104c1 on 2026-10-29 sent 1,016,869 + 32,000 against the same cap, 293 over). An eighth of
    // the window in reserve moves the trigger line far enough below the cap to carry both the
    // output budget and that excess, and a session nowhere near the limit never reaches the
    // (earlier) line, so it behaves exactly as before.
    const declared = window - Math.floor(window / COMPACTION_RESERVE_FRACTION);
    claudeEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(declared);
  }
  // A model declared to take no effort at all. The CLI sends one regardless, and the only thing that
  // stops it is this variable: `unset` is the CLI's own spelling for "send no effort parameter", and it
  // outranks --effort and every later effort frame — which is right here, since there is no level such
  // a model could be moved to.
  if (declaredReasoningLevels(row, model, AgentProvider.CLAUDE)?.length === 0) {
    claudeEnv.CLAUDE_CODE_EFFORT_LEVEL = 'unset';
  }
  return claudeEnv;
}

/** The gateway token minted for this build, or nothing: never the key, nor a pool's token. */
function gatewayToken(row: ModelProviderRow): string {
  return row.sessionToken?.startsWith(KEY_GATEWAY_TOKEN_PREFIX) ? row.sessionToken : '';
}

/** A Claude subscription token: Anthropic serves it to its own clients only, so OpenCode never gets
 *  one (plan-usage.ts reads the same prefix for the same reason). */
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

function isSubscriptionToken(apiKey: string): boolean {
  return apiKey.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX);
}

/**
 * The credential `row` is, as the compatibility table reads it (shared providerEngines.ts): its
 * dialect, its preset and endpoint (whether it is a DeepSeek key), and whether the key is a Claude
 * subscription token — which only the server can say, holding the key. `apiKey` is the key when the
 * caller already has it; otherwise it is decrypted here, and a key that cannot be is no subscription
 * token (it runs nowhere anyway: dispatch refuses it when it decrypts it).
 */
export function keyCredential(
  row: Pick<ModelProviderRow, 'runtime' | 'baseUrl' | 'apiKeyEnc' | 'presetSlug' | 'sessionToken' | 'codexLogin' | 'scope'>,
  apiKey?: string,
): EngineCredential {
  // Not a key at all: the owner's own Codex login pool, as dispatch minted its row.
  if (row.codexLogin) return { kind: 'pool', engine: AgentProvider.CODEX, ownLogin: true };
  let key = apiKey ?? row.sessionToken;
  if (key === undefined) {
    try {
      key = decryptSecret(row.apiKeyEnc);
    } catch {
      key = '';
    }
  }
  return {
    kind: 'key',
    runtime: row.runtime,
    presetSlug: row.presetSlug ?? null,
    baseUrl: row.baseUrl,
    subscriptionToken: isSubscriptionToken(key),
    // A local server runs on Claude Code alone (shared providerEngines.ts).
    ...(row.scope === 'runner' ? { local: true } : {}),
  };
}

/**
 * What a session on `engine` is told when its credential is not one that engine can run (§3.7
 * PROVIDER_ENGINE_INCOMPATIBLE) — a key whose protocol was changed under it, a pool of another engine,
 * a DeepSeek Harness session on a key that is not DeepSeek's. The session keeps its engine and waits
 * with this until its credential is one it can run again; it is never moved onto the engine the
 * credential would pick.
 */
export function engineIncompatibleMessage(
  slug: string,
  engine: AgentProvider,
  engines: readonly AgentProvider[],
): string {
  const runsOn = engines.length
    ? `it runs on ${engines.map((candidate) => ENGINE_CLI_NAMES[candidate]).join(', ')}`
    : 'no engine can run it';
  return `provider "${slug}" cannot run on ${ENGINE_CLI_NAMES[engine]}; ${runsOn}`;
}

/** The pattern every engineIncompatibleMessage matches, for the claim that clears it (SQL LIKE). */
export const ENGINE_INCOMPATIBLE_ERROR_LIKE = 'provider "%" cannot run on %';

/** The refusal dispatch raises for a credential the session's engine cannot run. */
export function engineIncompatible(
  slug: string,
  engine: AgentProvider,
  engines: readonly AgentProvider[],
): BadRequestException {
  return new BadRequestException({
    code: 'PROVIDER_ENGINE_INCOMPATIBLE',
    message: engineIncompatibleMessage(slug, engine, engines),
    engine,
    provider: slug,
    engines,
  });
}

/**
 * Whether an OpenCode session may spend this configured key (shared `openCodeKeys`): enabled, on a
 * dialect OpenCode speaks — every one a configured key can speak but a Cursor key's — and holding an API
 * key rather than a Claude subscription token. A pool's members are rows too and answer the same way; the pool itself
 * holds no key to hand over, so it is not one.
 */
export function runsOnOpenCode(row: Pick<ModelProviderRow, 'runtime' | 'enabled' | 'apiKeyEnc'>): boolean {
  if (!row.enabled || !openCodeDialect(row.runtime)) return false;
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
function openCodeKeyConfig(row: OpenCodeKeyRow, model: string, base?: string, apiKey?: string): string {
  const dialect = openCodeDialect(row.runtime)!;
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
      options: { baseURL: openCodeBaseUrl(dialect, row.baseUrl), apiKey: apiKey ?? decryptSecret(row.apiKeyEnc) },
      models: { [model]: { name: model } },
    },
  };
  return JSON.stringify(config);
}

/**
 * Refuse a runner-scoped row (migration 0646) unless the session is on that row's runner. A row whose runner
 * was removed (runner_id SET NULL), a door that names no runner, and any other runner all refuse — the
 * session waits rather than running its local model's work somewhere else or on a cloud engine. The message
 * names the provider, never its endpoint.
 */
export function assertRunnerScope(
  row: Pick<ModelProviderRow, 'scope' | 'runnerId' | 'slug'>,
  runnerId: string | null | undefined,
  declared?: string | null,
): void {
  if (row.scope !== 'runner') return;
  const slug = row.slug ?? declared ?? '';
  if (!row.runnerId) {
    throw new BadRequestException({
      code: 'LOCAL_PROVIDER_NO_RUNNER',
      message: `${LOCAL_PROVIDER_ERROR_PREFIX}"${slug}" runs only on its own runner, and it has none; bind it to one of your runners`,
      provider: slug,
    });
  }
  if (runnerId !== row.runnerId) {
    throw new BadRequestException({
      code: 'LOCAL_PROVIDER_ELSEWHERE',
      message: `${LOCAL_PROVIDER_ERROR_PREFIX}"${slug}" runs only on the runner it is bound to; start this session on that runner`,
      provider: slug,
    });
  }
}

/**
 * Refuse a session on a runner-scoped row unless it may run there now (shared localProviderReadiness): on the
 * row's own runner, that runner new enough to probe, a fresh probe that found Ollama answering, and `model` on
 * the instance with tool calling and enough context. The refusal carries a stable `code` and whether it clears
 * on its own (`transient`); it names the provider and the model, never the endpoint. A row that is not
 * runner-scoped passes untouched.
 */
export function assertLocalProviderReady(
  row: Pick<ModelProviderRow, 'scope' | 'slug' | 'enabled' | 'runnerId' | 'probeState' | 'probedAt' | 'instanceModels'>,
  target: {
    runnerId: string | null | undefined;
    runner: { capabilities?: readonly string[] | null; capabilitiesReportedAt?: Date | string | null } | null | undefined;
    model: string | null | undefined;
  },
  declared?: string | null,
  now: number = Date.now(),
): void {
  if (row.scope !== 'runner') return;
  const slug = row.slug ?? declared ?? '';
  const refusal = localProviderReadiness({ ...row, slug, runnerId: row.runnerId ?? null }, target, now);
  if (refusal) {
    throw new BadRequestException({ code: refusal.code, message: refusal.message, provider: slug, transient: refusal.transient });
  }
}

/**
 * Resolve how to actually run a session at dispatch: the engine the runner is handed, the model to
 * pass, and the process env. The engine is the SESSION's (`engine`, Session.engine — or, for a row
 * that has none yet, what session-engine.ts derived), and the credential only says where it sends its
 * requests: for a key the runner never learns the slug — it receives the engine, with an environment
 * pointing that engine at the key's endpoint in the variables it reads (injectedEnv), and an OpenCode
 * session gets the key as an OpenCode provider of its own (openCodeKeyConfig). Nothing here picks an
 * engine from the credential: a credential the engine cannot run is refused (PROVIDER_ENGINE_INCOMPATIBLE),
 * never re-read as the engine it would pick.
 *
 * `engine` may be omitted only by a caller resolving a credential on the engine it runs on when nothing
 * else is named (a key on its row's own engine, a built-in slug on itself); every door that dispatches
 * a session passes it.
 *
 * `customRow` is null only for a built-in credential at dispatch. Unresolved, disabled and unknown
 * configured runtimes are refused before a runner-facing job can be built.
 */
export function resolveProviderExec(args: {
  /** The engine the session runs on. */
  engine?: AgentProvider;
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
   *  Codex session reads it: it is resolved against `runner`'s report into the CODEX_HOME injected
   *  below, and a slot that runner does not report runs on Default — or, while the owner has removed
   *  Default from Orbit, on Automatic's pick among the accounts that remain (accountOnRunner). */
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
  /** The Cursor CLI account this session runs on (Session.cursorAccount ?? Workspace.cursorAccount),
   *  read the same way: resolved into the ORBIT_CURSOR_ACCOUNT_DIR injected below, which the runner
   *  reads to pick the account the session's CLI signs in with (docs/cursor-runtime-contract.md §16.2). */
  cursorAccount?: string | null;
  /** The assigned runner: its report (Runner.engines), where each account's directory is reported, and
   *  what decides where a session on a Default its owner removed from Orbit runs instead — that record,
   *  the runner's pauses and its quota (AccountRunner). */
  runner?: AccountRunner | null;
  /** The owner's configured keys (openCodeKeyRows), for an OpenCode session whose model names one
   *  (`orbit-<slug>/<model>`): that key is written into the run's OPENCODE_CONFIG_CONTENT. */
  openCodeKeys?: OpenCodeKeyRow[];
  /** The id of the runner the session is assigned to — what a runner-scoped row is checked against. A door
   *  that passes none resolves no runner-scoped row at all (assertRunnerScope). */
  runnerId?: string | null;
}): {
  provider: AgentProvider;
  model: string;
  /** What the runner is handed as the model, when it is not `model` itself: an OpenCode session on a
   *  key names it in OpenCode's own `provider/model` form (openCodeKeyModel), while the session stores
   *  the bare id (§2.2). */
  runnerModel?: string;
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
  if (customRow) {
    // A runner-scoped row runs on its own runner or not at all: never on another machine, never on a
    // cloud engine's sign-in instead.
    assertRunnerScope(customRow, args.runnerId, args.declaredProvider);
    // A runtime no engine speaks is refused in the words it always was, before anything is asked of it.
    const native = runtimeOf(customRow);
    const engine = args.engine ?? native;
    // A key that takes none gets a placeholder an engine's CLI can send, built here and held nowhere: Claude
    // Code given no token at all would send the runner's own Claude sign-in to the endpoint instead.
    const apiKey = customRow.sessionToken
      ?? (customRow.authMode === 'none' ? LOCAL_AUTH_PLACEHOLDER : decryptSecret(customRow.apiKeyEnc));
    const credential = keyCredential(customRow, apiKey);
    const table = customRow.codexLogin ? poolTableOptions() : engineTableOptions(customRow.baseUrl);
    if (!isEngineCompatible(engine, credential, table)) {
      throw engineIncompatible(customRow.slug ?? args.declaredProvider ?? '', engine, credentialEngines(credential, table));
    }
    // The model space is the engine's on this key (§2.2): DeepSeek Harness's own catalogue on a
    // DeepSeek key, the key vendor's table for Claude Code — and for OpenCode, the table the key's
    // vendor has on the engine whose protocol it speaks.
    // Claude Code on a Codex login pool is served by the Codex backend: its model space is Codex's, as the
    // runner's own Codex catalogue lists it for the plan.
    const space = engine === AgentProvider.OPENCODE || customRow.codexLogin ? dialectEngine(customRow.runtime) : engine;
    const pin = nonBlankModel(space, sessionModel);
    const retired = retiredPin(customRow, space, args, pin);
    // A custom provider's model space is its own; never coerce it through the claude/gpt
    // prefix guard. Workspace.model is only a rolling-deploy bridge for model-less sessions made
    // by old replicas; current clients put their choice directly on Session.model.
    const local = customRow.scope === 'runner';
    // A local provider runs a model its instance serves, or nothing: it has no catalogue default, and the
    // built-in Claude default is not a model Ollama has (localTargetModel).
    const model = local
      ? (localTargetModel(customRow, pin) ?? '')
      : (retired ? undefined : pin) ||
        firstNonBlank(legacyInheritance && space !== AgentProvider.DSH ? workspaceModel : undefined) ||
        runtimeCatalogDefault(customRow, space, args) ||
        (space !== AgentProvider.DSH ? presetDefaultModel(customRow) : undefined) ||
        DEFAULT_MODEL_BY_PROVIDER[space];
    // The rest of the gate, now that the model is known: the runner can say whether Ollama is up, it said so
    // recently, and the model is there with what Claude Code needs.
    if (local) assertLocalProviderReady(customRow, { runnerId: args.runnerId, runner: args.runner, model }, args.declaredProvider);
    const reasoningLevels = declaredReasoningLevels(customRow, model, engine);
    if (engine === AgentProvider.OPENCODE) {
      // OpenCode spends the key as a provider of its own, named for it, and is told the model by that
      // provider's name — the same form a model naming a key has always had (openCodeKeys).
      const slug = customRow.slug ?? args.declaredProvider ?? '';
      return {
        provider: engine,
        model,
        runnerModel: openCodeKeyModel(slug, model),
        env: {
          ...(workspaceEnv ?? {}),
          OPENCODE_CONFIG_CONTENT: openCodeKeyConfig(
            { ...customRow, slug },
            model,
            workspaceEnv?.OPENCODE_CONFIG_CONTENT,
            apiKey,
          ),
        },
        ...(retired ? { retiredPin: true } : {}),
      };
    }
    return {
      provider: engine,
      model,
      // Provider env wins over any user-set workspace env (e.g. a hand-typed ANTHROPIC_BASE_URL).
      // The kimi runtime also reads the model from here, so it can only be built once the
      // model above is resolved.
      env: local
        ? localClaudeEnv(workspaceEnv, injectedEnv(engine, customRow, model, apiKey), model)
        : {
          ...(workspaceEnv ?? {}),
          ...injectedEnv(engine, customRow, model, apiKey, customRow.codexLogin ? catalogWindow(args.modelCatalog, model) : undefined),
        },
      ...(retired ? { retiredPin: true } : {}),
      ...(reasoningLevels ? { reasoningLevels } : {}),
    };
  }
  // Built-in: the runtime authenticates itself.
  // each runner carries its own `claude auth login`, and a session that finds it missing surfaces
  // the sign-in card (RunnerSignIn) rather than the control plane holding a credential for it.
  // A built-in credential runs on the engine it names and on no other: a session recorded on another
  // engine is never handed to this one.
  const builtin = builtinSessionEngine(args.declaredProvider, args.declaredProviderBuiltin ?? true)!;
  const provider = args.engine ?? builtin;
  if (provider !== builtin) {
    throw engineIncompatible(args.declaredProvider ?? AgentProvider.CLAUDE, provider, [builtin]);
  }
  // A session on an account other than Default runs in that account's own directory — a Codex
  // CODEX_HOME, a Claude Code CLAUDE_CONFIG_DIR, an Antigravity Google sign-in's Gemini directory, a
  // Kimi Code KIMI_CODE_HOME, a Cursor CLI account's directory.
  // Built-in only: a configured provider brings its own key, so no sign-in on the machine is spent.
  // The chosen account replaces any such variable typed into the workspace's env. A session that would
  // run on a Default its owner removed from Orbit is handed the directory of the account Automatic
  // picks among those that remain instead (accountOnRunner): never one without it.
  const accountId = isAccountEngine(provider) ? args[ACCOUNT_CHOICE[provider]] : undefined;
  const account = accountOnRunner(provider, accountId, args.runner, workspaceEnv);
  const dirVar = accountEnvVar(provider);
  let env =
    account && dirVar
      ? { ...(workspaceEnv ?? {}), [dirVar]: accountDir(account) }
      : (workspaceEnv ?? undefined);
  // A Cursor CLI session on its sign-in spends no key: the variable a Cursor key reaches the runner in is
  // dispatch's alone to set (injectedEnv), never one typed into the workspace's env.
  if (provider === AgentProvider.CURSOR && env && CURSOR_KEY_VAR in env) {
    env = Object.fromEntries(Object.entries(env).filter(([name]) => name !== CURSOR_KEY_VAR));
  }
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
 * A local session's environment (docs/ollama-local-provider-contract.md §7). It reaches the local endpoint and
 * nothing else: the workspace's routing variables are dropped (isClaudeRoutingVar); every known cloud route is
 * named empty (LOCAL_CLAUDE_CLEARED_ENV), so the runner's own environment cannot supply one; the endpoint, the
 * placeholder token and the model are the provider's; Claude Code's background model slots run the session's
 * model, which the instance serves, rather than a Claude model it does not; its nonessential traffic is off; and
 * the job is marked for the runner (LOCAL_PROVIDER_MARKER_VAR), which drops inherited routing and pins all of it
 * in the session's flag settings layer (runner-go/claude_local_provider.go).
 */
function localClaudeEnv(
  workspaceEnv: Record<string, string> | null | undefined,
  injected: Record<string, string>,
  model: string,
): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(workspaceEnv ?? {}).filter(([name]) => !isClaudeRoutingVar(name)));
  const cleared = Object.fromEntries(LOCAL_CLAUDE_CLEARED_ENV.map((name) => [name, '']));
  return {
    ...kept,
    ...cleared,
    ...injected,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    [LOCAL_PROVIDER_MARKER_VAR]: '1',
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
 * the base row is the answer rather than the whole slug reading as retired. A Cursor CLI variant
 * (`claude-opus-5-5[context=1m,fast=true]`) is offered when its model is: the catalogue lists each
 * model once, by its bare name, and the settings a variant names are the runner's to apply.
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
  const retired = (id: string) => isRetiredModel(
    id,
    runtimeCatalogModels(args.modelCatalog, runtime),
    savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime),
  );
  return retired(judged) && (runtime !== AgentProvider.CURSOR || retired(decodeCursorModel(model).model));
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

/**
 * The window the runner's own Codex catalogue reports for `model` (`codex debug models`), which is what the
 * Codex backend serves a ChatGPT plan: Claude Code on a Codex login pool is told it as
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS, or it would assume 200k. Undefined when the runner reported none.
 */
function catalogWindow(modelCatalog: unknown, model: string): number | undefined {
  if (modelCatalog === null || typeof modelCatalog !== 'object' || Array.isArray(modelCatalog)) return undefined;
  const rows = (modelCatalog as Record<string, unknown>)[AgentProvider.CODEX];
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((entry) => entry && (entry as { value?: unknown }).value === model) as { contextWindow?: unknown } | undefined;
  return typeof row?.contextWindow === 'number' && row.contextWindow > 0 ? row.contextWindow : undefined;
}
