/**
 * What a session runs on, as dispatch would build it (docs/provider-engine-contract.md §4.1, §7.6): the
 * engine, a fingerprint of the key that engine is handed, the endpoint it is pointed at, the model and the
 * runtime id it resumes. The provider/engine migration (provider-engine-migration.ts) rewrites how sessions
 * name their credential; what it may not change is this, so it reads it for every session it touches before
 * and after, and reports both.
 *
 * Read with the claim's own pieces — the recorded engine (else the old rules' derivation), dispatchKeyRow
 * and resolveProviderExec — and nothing written: no seeded turn, no materialized model, no runtime id
 * minted, no pool member chosen. An account pool picks a member per claim, so a pool session reads as the
 * pool with no key of its own; the migration touches none.
 */
import { createHash } from 'node:crypto';
import { AgentProvider, keyDialect, openCodeBaseUrl, openCodeKeyOf } from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { accountPoolRuntime, isBuiltinProvider, openCodeKeyRows, resolveProviderExec, type ModelProviderRow } from './custom-provider';
import { dispatchKeyRow, keyRowForSlug } from './engine-provider';
import { decryptSecret } from './provider-crypto';
import { legacySessionEngine, recordedEngine } from './session-engine';

/** The session fields, and the workspace and runner facts, that a run is built from. */
export const RESOLUTION_SELECT = {
  id: true,
  ownerId: true,
  provider: true,
  providerBuiltin: true,
  engine: true,
  model: true,
  runtimeSessionId: true,
  usesRuntimeDefaultModel: true,
  workspace: { select: { env: true, model: true } },
  assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true, engines: true } },
} satisfies Prisma.SessionSelect;

export type ResolutionSession = Prisma.SessionGetPayload<{ select: typeof RESOLUTION_SELECT }>;

export interface SessionResolution {
  /** The engine the run is built on; null when nobody can tell (a key gone before one was recorded). */
  engine: string | null;
  /** The slug the session stores — reported, not compared: a rewrite changes it by design. */
  provider: string;
  /** The first 16 hex digits of the SHA-256 of the key the engine is handed, trimmed; null for none. */
  keyFingerprint: string | null;
  /** That key's endpoint, as the engine is pointed at it (normalizedEndpoint); null for none. */
  endpoint: string | null;
  /** The model the engine runs, as a bare id (an OpenCode `orbit-<slug>/<model>` is its `<model>`). */
  model: string | null;
  runtimeSessionId: string | null;
  /** Whether dispatch builds the run at all, and if not, what it refuses it with. */
  dispatchable: boolean;
  refusal: string | null;
}

/** What has to be equal for a session to run the same before and after a rewrite. */
export function sameResolution(a: SessionResolution, b: SessionResolution): boolean {
  return a.engine === b.engine
    && a.keyFingerprint === b.keyFingerprint
    && a.endpoint === b.endpoint
    && a.model === b.model
    && a.runtimeSessionId === b.runtimeSessionId
    && a.dispatchable === b.dispatchable;
}

/**
 * An endpoint as two keys compare it (§7.2): scheme and host lowercased, trailing slashes dropped. Nothing
 * else is normalized: a path or a port that differs is another endpoint.
 */
export function normalizedEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
  const lowered = authority ? `${authority[1].toLowerCase()}${authority[2].toLowerCase()}${authority[3]}` : trimmed;
  return lowered.replace(/\/+$/, '');
}

/** A key as the report may name it: a prefix of its SHA-256, never the key. */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16);
}

/** The bare model id of an OpenCode model naming a key, and any other id as it is. */
function bareModel(model: string | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  return openCodeKeyOf(model)?.model ?? model;
}

/** The variables each engine reads its key and endpoint from (custom-provider.ts injectedEnv). */
const KEY_VARIABLES: Partial<Record<AgentProvider, [key: string, endpoint: string]>> = {
  [AgentProvider.CLAUDE]: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  [AgentProvider.DSH]: ['ORBIT_DSH_API_KEY', 'ORBIT_DSH_BASE_URL'],
  [AgentProvider.CODEX]: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  [AgentProvider.KIMI]: ['KIMI_MODEL_API_KEY', 'KIMI_MODEL_BASE_URL'],
  [AgentProvider.ANTIGRAVITY]: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'],
};

/** The key and endpoint a built run hands its engine: in that engine's variables, or for OpenCode in the
 *  provider its config names for the key its model names. */
function handedOver(
  engine: AgentProvider,
  env: Record<string, string> | undefined,
  runnerModel: string,
): { key: string | null; endpoint: string | null } {
  if (engine === AgentProvider.OPENCODE) {
    const named = openCodeKeyOf(runnerModel);
    if (!named || !env?.OPENCODE_CONFIG_CONTENT) return { key: null, endpoint: null };
    try {
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { provider?: Record<string, { options?: { apiKey?: unknown; baseURL?: unknown } }> };
      const options = config.provider?.[`orbit-${named.slug}`]?.options;
      return {
        key: typeof options?.apiKey === 'string' ? options.apiKey : null,
        endpoint: typeof options?.baseURL === 'string' ? options.baseURL : null,
      };
    } catch {
      return { key: null, endpoint: null };
    }
  }
  const variables = KEY_VARIABLES[engine];
  if (!variables || !env) return { key: null, endpoint: null };
  return { key: env[variables[0]] ?? null, endpoint: env[variables[1]] ?? null };
}

/** The key and endpoint a credential row would hand `engine`, for a run dispatch refuses to build. */
function rowHandsOver(engine: AgentProvider, row: ModelProviderRow): { key: string | null; endpoint: string | null } {
  let key: string | null;
  try {
    key = decryptSecret(row.apiKeyEnc);
  } catch {
    key = null;
  }
  const dialect = keyDialect(row.runtime);
  const endpoint = engine === AgentProvider.OPENCODE && dialect ? openCodeBaseUrl(dialect, row.baseUrl) : row.baseUrl;
  return { key, endpoint };
}

/** The session's resolution, read now. */
export async function sessionResolution(db: Prisma.TransactionClient, sessionId: string): Promise<SessionResolution> {
  return resolutionOf(db, await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: RESOLUTION_SELECT }));
}

export async function resolutionOf(db: Prisma.TransactionClient, session: ResolutionSession): Promise<SessionResolution> {
  const facts = { ownerId: session.ownerId, provider: session.provider, providerBuiltin: session.providerBuiltin };
  const engine = recordedEngine(session.engine) ?? (await legacySessionEngine(db, { ...facts, engine: session.engine }));
  const base = { provider: session.provider, runtimeSessionId: session.runtimeSessionId };
  if (!engine) {
    return {
      ...base, engine: null, keyFingerprint: null, endpoint: null, model: bareModel(session.model),
      dispatchable: false, refusal: `provider not available: "${session.provider}"`,
    };
  }
  const workspaceEnv = (session.workspace?.env ?? null) as Record<string, string> | null;
  const row = await dispatchKeyRow(db, facts, workspaceEnv);
  const builtin = isBuiltinProvider(session.provider, session.providerBuiltin);
  if (!builtin && !row && (await accountPoolRuntime(db, session.ownerId, session.provider))) {
    // A pool picks its member when it is claimed: no key of its own to name here.
    return { ...base, engine, keyFingerprint: null, endpoint: null, model: bareModel(session.model), dispatchable: true, refusal: null };
  }
  const openCodeKeys = session.provider === AgentProvider.OPENCODE ? await openCodeKeyRows(db, session.ownerId) : undefined;
  try {
    const exec = resolveProviderExec({
      engine,
      declaredProvider: session.provider,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow: row,
      openCodeKeys,
      sessionModel: session.model,
      usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
      runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
      workspaceModel: session.workspace?.model,
      modelCatalog: session.assignedRunner?.modelCatalog,
      workspaceEnv,
      runnerEngines: session.assignedRunner?.engines,
    });
    const { key, endpoint } = handedOver(exec.provider, exec.env, exec.runnerModel ?? exec.model);
    return {
      ...base,
      engine: exec.provider,
      keyFingerprint: key ? keyFingerprint(key) : null,
      endpoint: endpoint ? normalizedEndpoint(endpoint) : null,
      model: bareModel(exec.model),
      dispatchable: true,
      refusal: null,
    };
  } catch (error) {
    // Refused — a key turned off, gone, or one the engine cannot run. Still named by the key it would
    // spend, so a refusal before and after is the same refusal of the same key.
    const named = row ?? (engine === AgentProvider.OPENCODE ? await openCodeEncodedRow(db, session) : null);
    const { key, endpoint } = named ? rowHandsOver(engine, named) : { key: null, endpoint: null };
    return {
      ...base,
      engine,
      keyFingerprint: key ? keyFingerprint(key) : null,
      endpoint: endpoint ? normalizedEndpoint(endpoint) : null,
      model: bareModel(session.model),
      dispatchable: false,
      refusal: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The key an old OpenCode model names (`orbit-<slug>/<model>`), whatever its state. */
async function openCodeEncodedRow(db: Prisma.TransactionClient, session: ResolutionSession): Promise<ModelProviderRow | null> {
  const named = openCodeKeyOf(session.model);
  return named ? keyRowForSlug(db, session.ownerId, named.slug) : null;
}
