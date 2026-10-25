// The sample fleet and keys every infra-focus frame is drawn from, after the owner's own Infrastructure
// page on 2026-10-25 (4 machines, 6 keys under 5 vendors, one Codex pool, four engines signed out).
// Names are samples (the repo is public). Clock: the fixtures freeze it at 2026-09-28T12:00Z.
import { uuidToBase62 } from '/var/tmp/infra-focus-mock/today/src/shared/dist/index.js';

export const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min) => new Date(NOW + min * 60_000).toISOString();
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const D = 1440;

export const IDS = {
  wikova: id('30'), workstation: id('a02'), mac: id('a03'), hpc: id('a04'),
  ws: id('20'), wsHpc: id('21'), wsMac: id('22'),
  keyKimi: id('c01'), keyDeepseek: id('c02'), keyClaude1: id('c03'), keyClaude2: id('c04'), keyVllm: id('c05'), keyGemini: id('c06'),
  pool: id('d01'),
};

const checked = (min = 6) => ({ status: 'checked', at: ago(min), okAt: ago(min) });
/** An engine whose updater has been failing for days: the warning note, and the card's attention line. */
const failing = (latest, days = 9) => ({ status: 'failed', at: ago(25), okAt: ago(days * D), behindSince: ago(days * D), latest, message: 'npm ERR! network request failed' });

const claudeAccounts = (n) => [
  { id: 'default', name: 'Personal', home: '/root/.claude', auth: 'yes' },
  { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-accounts/1e84046c', auth: 'yes' },
  { id: 'slot-3', name: 'Team', home: '/root/.orbit/claude-accounts/7b2d90aa', auth: 'yes' },
].slice(0, n);
const claude = (n = 1, auth = 'yes') => ({ engine: 'claude', installed: true, auth, version: '2.1.302', update: checked(), accounts: auth === 'yes' ? claudeAccounts(n) : [{ id: 'default', name: 'Personal', home: '/root/.claude', auth: 'no' }] });
const codex = (n = 1, auth = 'yes', update = checked()) => ({ engine: 'codex', installed: true, auth, version: '0.164.0', update,
  accounts: auth === 'yes'
    ? [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' }, { id: 'slot-2', name: 'Work', home: '/root/.orbit/codex-accounts/2', codexHome: '/root/.orbit/codex-accounts/2', auth: 'yes' }].slice(0, n)
    : [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'no' }] });
const kimi = (auth = 'yes') => ({ engine: 'kimi', installed: true, auth, version: '2.1.4', update: checked(), kimiRegion: 'global',
  accounts: [{ id: 'default', home: '/root/.kimi-code', auth, kimiRegion: 'global' }] });
const antigravity = () => ({ engine: 'antigravity', installed: true, auth: 'yes', version: '1.3.4', update: checked(), authSource: 'google',
  accounts: [{ id: 'default', home: '/root/.gemini', auth: 'yes' }] });
const opencode = (auth = 'unknown', update = checked()) => ({ engine: 'opencode', installed: true, auth, version: '1.18.40', update });
const dsh = () => ({ engine: 'dsh', installed: true, auth: 'unknown', version: '0.2.0',
  dsh: { versionCompatible: true, credentialPresent: true, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'full' } });
const missing = (engine) => ({ engine, installed: false, auth: 'unknown' });

const runner = (over) => ({
  online: true, status: 'ONLINE', maxConcurrent: 8, activeSessions: 0, lastHeartbeatAt: ago(0.3),
  enrolledAt: '2026-06-18T02:00:00Z', minFreeDiskMb: null, runsAsRoot: false, capabilities: [],
  selfUpdate: { state: 'enabled', installDir: '/usr/local/bin' }, commands: [], skills: [], install: null, ...over,
});
const google = { supported: true, installed: true, version: '1.3.4', envKeyAvailable: true, authSource: 'google', googleLogin: 'available' };
const LOGIN_CAPS = ['antigravity-account-login/v1', 'kimi-account-login/v1', 'kimi-account-remove/v1', 'kimi-account-move/v1'];

const planUsage = {
  claude: {
    fiveHour: { utilization: 23, resetsAt: ahead(126) }, sevenDay: { utilization: 41, resetsAt: ahead(3 * D) }, fetchedAt: ago(2),
    accounts: {
      'slot-2': { fiveHour: { utilization: 57, resetsAt: ahead(64) }, sevenDay: { utilization: 18, resetsAt: ahead(5 * D) }, fetchedAt: ago(2) },
      'slot-3': { fiveHour: { utilization: 4, resetsAt: ahead(201) }, sevenDay: { utilization: 66, resetsAt: ahead(2 * D) }, fetchedAt: ago(2) },
    },
  },
  codex: { primary: { utilization: 12, resetsAt: ahead(200), windowDurationMins: 300 }, secondary: { utilization: 41, resetsAt: ahead(4 * D), windowDurationMins: 10080 }, fetchedAt: ago(3) },
};

const claudeCatalog = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', contextWindow: 1_000_000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

/** The fleet: wikova (Kimi signed out, an install in flight, OpenCode's updater failing), workstation
 *  (Claude Code and Codex signed out, Codex's updater failing), the Mac mini (nothing signed in, disk
 *  nearly full) and hpc (everything but Cursor CLI, which it knows and hasn't installed). */
export const runners = () => [
  runner({
    id: IDS.wikova, name: 'wikova', displayName: 'wikova', hostname: 'vmi3129740', version: '0.1.236', maxConcurrent: 12, activeSessions: 0, position: 0,
    capabilities: ['provider:dsh', ...LOGIN_CAPS], antigravity: google, planUsage,
    install: { status: 'installing', engine: 'opencode', command: 'npm i -g opencode-ai@latest', message: null, mode: 'install' },
    engines: [claude(3), codex(2), kimi('no'), antigravity(), opencode('yes', failing('1.19.2')), dsh()],
    modelCatalog: { claude: claudeCatalog, dsh: [{ value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] },
    runtimeDefaultModels: { claude: 'claude-opus-5-5', dsh: 'deepseek-v4-flash' },
  }),
  runner({
    id: IDS.workstation, name: 'workstation', displayName: 'workstation', hostname: 'gateway', version: '0.1.236', maxConcurrent: 8, activeSessions: 1, position: 1,
    capabilities: [...LOGIN_CAPS], antigravity: google,
    engines: [claude(1, 'no'), codex(1, 'no', failing('0.165.0', 12)), missing('kimi'), antigravity()],
  }),
  runner({
    id: IDS.mac, name: 'mac-mini.local', displayName: null, hostname: 'mac-mini.local', version: '0.1.236', maxConcurrent: 16, activeSessions: 0, position: 2,
    antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'unavailable' },
    engines: [claude(1, 'no'), missing('codex'), missing('kimi')],
  }),
  runner({
    id: IDS.hpc, name: 'HPC', displayName: 'HPC', hostname: 'workstation', version: '0.1.235', maxConcurrent: 16, activeSessions: 5, position: 3,
    capabilities: ['provider:dsh', 'provider:cursor', ...LOGIN_CAPS], antigravity: google, planUsage,
    engines: [claude(3), codex(1), kimi(), antigravity(), opencode(), dsh(), missing('cursor')],
    modelCatalog: { claude: claudeCatalog, dsh: [{ value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] },
    runtimeDefaultModels: { claude: 'claude-opus-5-5', dsh: 'deepseek-v4-flash' },
  }),
];

/* ── keys (ProviderRow), in the list's own order ── */
const key = (over) => ({
  followsPreset: true, enabled: true, hasApiKey: true, poolRefusal: { reason: 'NOT_SUBSCRIPTION', message: 'Only Claude subscription tokens can be pooled.' }, lastUsedAt: ago(90), ...over,
});
const claudeModels = [{ value: 'claude-opus-5', label: 'Claude Opus 5' }, { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { value: 'claude-haiku-5', label: 'Claude Haiku 5' }];
export const providers = () => [
  key({ id: IDS.keyKimi, slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', engines: ['kimi', 'opencode'],
    baseUrl: 'https://api.moonshot.ai/v1', presetSlug: 'moonshot', defaultModel: 'kimi-k3.1-pro', lastUsedAt: ago(16 * D),
    models: [{ value: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro' }, { value: 'kimi-k3.1', label: 'Kimi K3.1' }, { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }, { value: 'kimi-k2.7', label: 'Kimi K2.7' }, { value: 'kimi-k2.5-turbo', label: 'Kimi K2.5 Turbo' }, { value: 'kimi-k2.5', label: 'Kimi K2.5' }] }),
  key({ id: IDS.keyDeepseek, slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', engines: ['claude', 'opencode', 'dsh'],
    baseUrl: 'https://api.deepseek.com/anthropic', presetSlug: 'deepseek', defaultModel: 'deepseek-v4.1-flash-1017', lastUsedAt: ago(130),
    models: [{ value: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash 1017' }, { value: 'deepseek-v4.1-pro', label: 'DeepSeek V4.1 Pro' }] }),
  key({ id: IDS.keyClaude1, slug: 'anthropic', label: 'Personal Max', runtime: 'claude', engines: ['claude'], poolRefusal: null,
    baseUrl: 'https://api.anthropic.com', presetSlug: 'anthropic', defaultModel: 'claude-opus-5', models: claudeModels, lastUsedAt: ago(3 * D) }),
  key({ id: IDS.keyClaude2, slug: 'anthropic-2', label: 'Work', runtime: 'claude', engines: ['claude'], poolRefusal: null,
    baseUrl: 'https://api.anthropic.com', presetSlug: 'anthropic', defaultModel: 'claude-opus-5', models: claudeModels, lastUsedAt: ago(26 * 60) }),
  key({ id: IDS.keyVllm, slug: 'local-vllm', label: 'Local vLLM', runtime: 'claude', engines: ['claude', 'opencode'], followsPreset: false,
    baseUrl: 'http://10.0.0.8:8000/v1', presetSlug: null, defaultModel: 'qwen3.8-27b-fp8', lastUsedAt: ago(5 * D),
    models: [{ value: 'qwen3.8-27b-fp8', label: 'Qwen3.8 27B Uncensored FP8' }] }),
  key({ id: IDS.keyGemini, slug: 'gemini', label: 'Gemini', runtime: 'antigravity', engines: ['antigravity', 'opencode'],
    baseUrl: 'https://generativelanguage.googleapis.com', presetSlug: 'gemini', defaultModel: 'gemini-3.8-flash', lastUsedAt: ago(D),
    models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { value: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro' }] }),
];

export const balance = () => ({ ok: true, balances: [{ currency: 'CNY', totalBalance: '36.20', grantedBalance: '0.00', toppedUpBalance: '36.20' }], isAvailable: true, fetchedAt: ago(2), sharedWith: [] });

/* ── the owner's Codex pool: one ChatGPT account, kept to themselves ── */
const login = { state: 'ACTIVE', pausedUntil: null, email: 'you@example.com', userId: 'u-owner', plan: 'pro', fingerprint: '…7F3A', lastError: null,
  expiresAt: ahead(20 * D), linkedAt: ago(40 * D), usage: { provider: 'codex', primary: { utilization: 28, resetsAt: ahead(140), windowDurationMins: 300 }, secondary: { utilization: 61, resetsAt: ahead(3 * D), windowDurationMins: 10080 }, fetchedAt: ago(4) }, usageUnavailable: null };
export const pools = () => [{ id: IDS.pool, slug: 'codex-pool', label: 'Codex Pool', engine: 'codex', resetsAt: null, unavailable: null, members: [], logins: [login], login }];
export const poolAccess = () => ({
  id: IDS.pool, slug: 'codex-pool', label: 'Codex Pool', engine: 'codex', shared: false, logins: [{ ...login, next: true }],
  membersCanAdd: false, membersCanAddAccounts: false, ownKeyFirst: false, viewerRole: 'ADMIN',
  window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
  people: [{ userId: 'u-owner', name: 'Wikova', role: 'ADMIN', creator: true, you: true, keys: 0, sessions: 14, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }],
  keys: [],
});

const ws = (over) => ({ createdAt: '2026-07-01T00:00:00Z', lastProvider: null, lastEngine: null, provider: 'claude', model: null, effort: null, enableWorktree: true, workDirExists: true, workDirIsGit: true, ...over });
export const workspaces = () => [
  ws({ id: IDS.ws, name: 'orbit', runnerId: IDS.wikova, runner: { id: IDS.wikova, name: 'wikova', displayName: 'wikova' }, workDir: '/root/orbit', lastProvider: 'claude', lastEngine: 'claude' }),
  ws({ id: IDS.wsHpc, name: 'orbit-develop', runnerId: IDS.hpc, runner: { id: IDS.hpc, name: 'HPC', displayName: 'HPC' }, workDir: '/root/orbit', lastProvider: 'claude', lastEngine: 'claude' }),
  ws({ id: IDS.wsMac, name: 'orbit-mac', runnerId: IDS.mac, runner: { id: IDS.mac, name: 'mac-mini.local', displayName: null }, workDir: '/Users/me/orbit',
    workDirFreeBytes: '80000000000', workDirTotalBytes: '994000000000' }),
];

/** Every route the Infrastructure page asks, answered from the above. */
export const infraRoutes = ({ runnerList = runners, keys = providers, poolList = pools } = {}) => () => ({
  'GET /api/runners': runnerList(),
  'GET /api/providers/mine': keys(),
  'GET /api/providers': keys(),
  'GET /api/workspaces': workspaces(),
  'GET /api/providers/pools': poolList(),
  'GET /api/providers/shared-pools': [],
  [`GET /api/providers/shared-pools/${IDS.pool}`]: poolAccess(),
  [`GET /api/providers/mine/${IDS.keyDeepseek}/balance`]: balance(),
  ...Object.fromEntries([IDS.wikova, IDS.workstation, IDS.mac, IDS.hpc].map((id) => [`GET /api/runners/${id}/login`, { status: null, engine: null, url: null, userCode: null, message: null }])),
});
