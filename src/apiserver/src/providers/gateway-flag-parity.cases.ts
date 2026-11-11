/**
 * Every kind of credential a session runs on, built the way dispatch builds it: the session's resolution
 * (provider-engine-resolution.ts resolutionOf, compared with sameResolution), the full environment the claim
 * hands the engine (QueueService.buildSession's resolveProviderExec call), and the `engines` list of its
 * credential (engine-provider.ts resolvedCredentialEngines, which is the key's `engines` field on the API).
 *
 * gateway-flag-parity.spec.ts compares what this builds now against fixtures/gateway-flag-parity.json, which this
 * same module wrote on main as it stood before the Claude-Code-on-OpenAI-keys project (ccdef0955). It imports
 * nothing that did not exist there, so it is recorded again by copying it into a checkout of that commit:
 *
 *   cp src/apiserver/src/providers/gateway-flag-parity.cases.ts <pre>/src/apiserver/src/providers/
 *   cd <pre>/src/apiserver && npx tsc -p tsconfig.test.json
 *   node -e "require('./build/providers/gateway-flag-parity.cases').recordParity()" > src/providers/fixtures/gateway-flag-parity.json
 *
 * The one hook is `keyRow`: what the claim does to the key row before it builds the run. Before the project
 * the claim used the row as it was; now it passes through withKeyGatewayToken.
 */
import { AgentProvider } from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { resolveProviderExec, type ModelProviderRow } from './custom-provider';
import { resolvedCredentialEngines, type KeyRow, type ResolvedCredential } from './engine-provider';
import { encryptSecret } from './provider-crypto';
import { resolutionOf, type ResolutionSession, type SessionResolution } from './provider-engine-resolution';
import { sharedPoolExecRow } from './shared-pool';

process.env.PROVIDER_SECRET_KEY ??= 'gateway-flag-parity';
process.env.PUBLIC_ORIGIN = 'https://orbit.parity.invalid';

const OWNER = '0190f3c2-0000-7000-8000-00000000a001';
const WORKSPACE_ENV = { PARITY_WORKSPACE_VAR: 'kept' };

/** The runner the sessions are assigned to: Claude Code signed in on Default and on a second account. */
const RUNNER = {
  runtimeDefaultModels: null,
  modelCatalog: null,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: '7a1b2c3d', name: 'Work', home: '/home/dev/.orbit/claude-accounts/7a1b2c3d', auth: 'yes' }] },
    { engine: 'codex', installed: true, auth: 'yes' },
    { engine: 'opencode', installed: true, auth: 'yes' },
  ],
  defaultRemoved: null,
  accountPauses: null,
  planUsage: null,
};

/** Fake keys, named for what they are; none is a real credential. */
let rowSeq = 0;
function key(slug: string, row: { runtime: string; presetSlug: string | null; baseUrl: string; secret: string }): KeyRow {
  rowSeq += 1;
  return {
    id: `0190f3c2-0000-7000-8000-0000000b${String(rowSeq).padStart(4, '0')}`,
    slug,
    label: slug,
    ownerId: OWNER,
    runtime: row.runtime,
    presetSlug: row.presetSlug,
    baseUrl: row.baseUrl,
    apiKeyEnc: encryptSecret(row.secret),
    defaultModel: null,
    followsPreset: true,
    enabled: true,
    models: [],
  } as unknown as KeyRow;
}

const KEYS = {
  anthropic: key('anthropic', { runtime: 'claude', presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com', secret: 'fake-anthropic-key-parity-0001' }),
  deepseek: key('deepseek', { runtime: 'claude', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', secret: 'fake-deepseek-key-parity-0002' }),
  subscription: key('claude-sub', { runtime: 'claude', presetSlug: null, baseUrl: 'https://api.anthropic.com', secret: 'sk-ant-oat01-fake-parity-0003' }),
  openai: key('openai', { runtime: 'codex', presetSlug: 'openai', baseUrl: 'https://api.openai.com/v1', secret: 'fake-openai-key-parity-0004' }),
  moonshot: key('moonshot', { runtime: 'kimi', presetSlug: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1', secret: 'fake-moonshot-key-parity-0005' }),
  gemini: key('gemini', { runtime: 'antigravity', presetSlug: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', secret: 'fake-gemini-key-parity-0006' }),
  cursor: key('cursor-key', { runtime: 'cursor', presetSlug: 'cursor', baseUrl: 'https://api.cursor.com', secret: 'fake-cursor-key-parity-0007' }),
  // The member a Claude account pool hands its session.
  poolMember: key('pool-member', { runtime: 'claude', presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com', secret: 'fake-pool-member-key-parity-0008' }),
};

/** The owner's account pools by slug: a Claude one of keys, and a Codex one of logins and keys. */
const POOLS: Record<string, { shared: boolean; engine: string; dispatches: () => ModelProviderRow }> = {
  'claude-pool': { shared: false, engine: 'claude', dispatches: () => KEYS.poolMember },
  'codex-pool': { shared: false, engine: 'codex', dispatches: () => sharedPoolExecRow('orbit-gwl-parity-session-token') },
};

/** What the reads dispatch makes see: the owner's keys and pools, nothing shared, no aliases. */
export function fakeDb(): Prisma.TransactionClient {
  const rows = Object.values(KEYS).filter((row) => row !== KEYS.poolMember) as unknown as Array<Record<string, unknown>>;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([field, want]) => typeof want === 'object' && want !== null ? true : row[field] === want);
  const db = {
    user: { findUnique: async () => ({ role: 'USER' }) },
    modelProvider: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
    },
    providerSlugAlias: { findUnique: async () => null },
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId?: string } }) => {
        const pool = where.ownerId === OWNER ? POOLS[where.slug] : undefined;
        return pool ? { shared: pool.shared, engine: pool.engine, id: `pool-${where.slug}` } : null;
      },
    },
    // Written only by a token mint, which only the gateway's dispatch does.
    keyGatewayToken: {
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: unknown }) => data,
    },
  };
  return db as unknown as Prisma.TransactionClient;
}

export interface ParityCase {
  /** `<credential kind>/<engine>`. */
  name: string;
  provider: string;
  providerBuiltin: boolean;
  engine: AgentProvider;
  model: string;
  /** The account a built-in session runs on, as the claim passes it. */
  accounts?: { claudeAccount?: string; codexAccount?: string };
  credential: ResolvedCredential;
}

const keyCase = (kind: string, row: KeyRow, engine: AgentProvider, model: string): ParityCase => ({
  name: `${kind}/${engine}`,
  provider: row.slug!,
  providerBuiltin: false,
  engine,
  model,
  credential: { kind: 'key', row, slug: row.slug!, alias: null },
});

export const PARITY_CASES: ParityCase[] = [
  { name: 'runner-login/claude', provider: 'claude', providerBuiltin: true, engine: AgentProvider.CLAUDE, model: 'claude-opus-5-5', credential: { kind: 'login', engine: 'claude' } },
  { name: 'runner-login-account/claude', provider: 'claude', providerBuiltin: true, engine: AgentProvider.CLAUDE, model: 'claude-opus-5-5', accounts: { claudeAccount: '7a1b2c3d' }, credential: { kind: 'login', engine: 'claude' } },
  { name: 'runner-login/codex', provider: 'codex', providerBuiltin: true, engine: AgentProvider.CODEX, model: 'gpt-5.1', credential: { kind: 'login', engine: 'codex' } },
  { name: 'account-pool/claude', provider: 'claude-pool', providerBuiltin: false, engine: AgentProvider.CLAUDE, model: 'claude-opus-5-5', credential: { kind: 'pool', slug: 'claude-pool', engine: AgentProvider.CLAUDE } },
  { name: 'account-pool/codex', provider: 'codex-pool', providerBuiltin: false, engine: AgentProvider.CODEX, model: 'gpt-5.1', credential: { kind: 'pool', slug: 'codex-pool', engine: AgentProvider.CODEX } },
  keyCase('anthropic-key', KEYS.anthropic, AgentProvider.CLAUDE, 'claude-opus-5-5'),
  keyCase('anthropic-key', KEYS.anthropic, AgentProvider.OPENCODE, 'claude-opus-5-5'),
  keyCase('deepseek-key', KEYS.deepseek, AgentProvider.CLAUDE, 'deepseek-chat'),
  keyCase('deepseek-key', KEYS.deepseek, AgentProvider.DSH, 'deepseek-chat'),
  keyCase('deepseek-key', KEYS.deepseek, AgentProvider.OPENCODE, 'deepseek-chat'),
  keyCase('subscription-token', KEYS.subscription, AgentProvider.CLAUDE, 'claude-opus-5-5'),
  keyCase('subscription-token', KEYS.subscription, AgentProvider.OPENCODE, 'claude-opus-5-5'),
  keyCase('openai-key', KEYS.openai, AgentProvider.CODEX, 'gpt-5.1'),
  keyCase('openai-key', KEYS.openai, AgentProvider.OPENCODE, 'gpt-5.1'),
  // Refused before the project; the one combination the gateway flag opens.
  keyCase('openai-key', KEYS.openai, AgentProvider.CLAUDE, 'gpt-5.1'),
  keyCase('moonshot-key', KEYS.moonshot, AgentProvider.KIMI, 'kimi-k2'),
  keyCase('moonshot-key', KEYS.moonshot, AgentProvider.OPENCODE, 'kimi-k2'),
  keyCase('gemini-key', KEYS.gemini, AgentProvider.ANTIGRAVITY, 'gemini-3-pro'),
  keyCase('gemini-key', KEYS.gemini, AgentProvider.OPENCODE, 'gemini-3-pro'),
  keyCase('cursor-key', KEYS.cursor, AgentProvider.CURSOR, 'auto'),
  { name: 'opencode-config/opencode', provider: 'opencode', providerBuiltin: true, engine: AgentProvider.OPENCODE, model: 'anthropic/claude-sonnet-4-5', credential: { kind: 'opencode' } },
];

/** One case as dispatch builds it. `env` is null, and `refusal` says why, where the claim refuses the run. */
export interface ParityResult {
  resolution: SessionResolution;
  env: Record<string, string> | null;
  refusal: string | null;
  engines: string[];
}

export type KeyRowHook = (
  db: Prisma.TransactionClient,
  session: { id: string; ownerId: string },
  engine: AgentProvider,
  row: KeyRow | null,
) => Promise<ModelProviderRow | null>;

export async function buildParity(c: ParityCase, keyRow: KeyRowHook = async (_db, _s, _e, row) => row): Promise<ParityResult> {
  const db = fakeDb();
  const session = {
    id: `0190f3c2-0000-7000-8000-0000000c${c.name.length.toString().padStart(4, '0')}`,
    ownerId: OWNER,
    provider: c.provider,
    providerBuiltin: c.providerBuiltin,
    engine: c.engine,
    model: c.model,
    runtimeSessionId: `runtime-${c.name}`,
    usesRuntimeDefaultModel: true,
    workspace: { env: WORKSPACE_ENV, model: null },
    assignedRunner: RUNNER,
  } as unknown as ResolutionSession;
  const resolution = await resolutionOf(db, session);
  // The claim's row: the key the slug names (wrapped as the claim wraps it), else the pool's.
  const configured = c.credential.kind === 'key' ? c.credential.row : null;
  const pool = POOLS[c.provider];
  const customRow = (await keyRow(db, session, c.engine, configured)) ?? (pool ? pool.dispatches() : null);
  let env: Record<string, string> | null = null;
  let refusal: string | null = null;
  try {
    const exec = resolveProviderExec({
      engine: c.engine,
      declaredProvider: c.provider,
      declaredProviderBuiltin: c.providerBuiltin,
      customRow,
      openCodeKeys: c.provider === AgentProvider.OPENCODE ? (Object.values(KEYS) as unknown as ModelProviderRow[] as never) : undefined,
      sessionModel: c.model,
      usesRuntimeDefaultModel: true,
      runtimeDefaultModels: RUNNER.runtimeDefaultModels,
      workspaceModel: null,
      modelCatalog: RUNNER.modelCatalog,
      workspaceEnv: { ...WORKSPACE_ENV },
      codexAccount: c.accounts?.codexAccount ?? null,
      claudeAccount: c.accounts?.claudeAccount ?? null,
      runner: RUNNER,
    });
    env = exec.env ?? {};
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  return { resolution, env, refusal, engines: resolvedCredentialEngines(c.credential) };
}

/** Every case, keyed by name, as JSON: what the fixture holds. */
export async function recordParity(): Promise<void> {
  const out: Record<string, ParityResult> = {};
  for (const c of PARITY_CASES) out[c.name] = await buildParity(c);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
