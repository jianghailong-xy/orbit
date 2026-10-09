// The account the T0 boards draw (docs/mocks/provider-engine-decoupling/web-1-infrastructure.html):
// three machines — hpc online and able to run DeepSeek Harness, old-mac on runner v0.1.198 (before
// Harness) with Codex signed out, build-box without Harness installed — two DeepSeek keys (one of them
// made from the retired Harness preset), Gemini, Kimi and GLM keys, a Claude subscription token and a
// Claude account pool. Shaped as GET /runners and GET /providers/mine answer (T3: `engines` per key).
import { uuidToBase62 } from '/root/.orbit/worktrees/bb16742c-7745-5a29-83ab-f4bde58a11b0/src/shared/dist/index.js';

export const NOW = Date.parse('2026-09-28T12:00:00.000Z'); // ui-migration/fixtures.mjs FIXED_NOW
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const inHours = (hours) => new Date(NOW + hours * 3_600_000).toISOString();
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);

export const IDS = {
  hpc: id(901), oldMac: id(902), buildBox: id(903), macStudio: id(904),
  deepseek: id(911), deepseek2: id(912), gemini: id(913), kimi: id(914), glm: id(915), claudeMax: id(916),
  pool: id(921), poolA: id(922), poolB: id(923),
};

const DSH_OK = { versionCompatible: true, credentialPresent: false, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'unknown' };
const PRO = '["deepseek", "deepseek-v4-pro"]';
const FLASH = '["deepseek", "deepseek-v4-flash"]';

const hpc = {
  id: IDS.hpc, name: 'hpc', online: true, status: 'ONLINE', maxConcurrent: 16, activeSessions: 3, position: 0,
  hostname: 'hpc-01', version: '0.1.240', lastHeartbeatAt: ago(0.2), runsAsRoot: false,
  capabilities: ['provider:dsh', 'provider:antigravity', 'provider:opencode'],
  engines: [
    {
      engine: 'claude', installed: true, auth: 'yes', version: '2.1.290 (Claude Code)',
      accounts: [
        { id: 'default', home: '/root/.claude', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-accounts/slot-2', auth: 'yes' },
      ],
    },
    { engine: 'codex', installed: true, auth: 'yes', version: 'codex-cli 0.162.0' },
    { engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google', version: 'agy 1.3.2' },
    { engine: 'kimi', installed: false, auth: 'unknown' },
    { engine: 'opencode', installed: true, auth: 'yes', version: '1.18.35' },
    { engine: 'dsh', installed: true, auth: 'unknown', version: '0.2.0-rc.2', dsh: DSH_OK },
  ],
  antigravity: { supported: true, installed: true, version: 'agy 1.3.2', envKeyAvailable: false, authSource: 'google', googleLogin: 'available' },
  planUsage: {
    claude: {
      provider: 'claude', fiveHour: { utilization: 23, resetsAt: inHours(3) }, fetchedAt: ago(2),
      accounts: { 'slot-2': { provider: 'claude', fiveHour: { utilization: 8, resetsAt: inHours(4) }, fetchedAt: ago(2) } },
    },
    codex: { provider: 'codex', secondary: { utilization: 41, resetsAt: inHours(80), windowDurationMins: 10080 }, fetchedAt: ago(2) },
  },
  modelCatalog: { dsh: [{ value: PRO, label: 'DeepSeek V4 Pro' }, { value: FLASH, label: 'DeepSeek V4 Flash' }] },
  runtimeDefaultModels: { dsh: PRO },
};
const oldMac = {
  id: IDS.oldMac, name: 'old-mac', online: true, status: 'ONLINE', maxConcurrent: 4, activeSessions: 1, position: 1,
  hostname: 'old-mac.local', version: '0.1.198', lastHeartbeatAt: ago(0.3), capabilities: [],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.280 (Claude Code)' },
    { engine: 'codex', installed: true, auth: 'no', version: 'codex-cli 0.150.0' },
  ],
  antigravity: { supported: false, installed: null, version: null, envKeyAvailable: false, googleLogin: 'needs_update' },
};
const buildBox = {
  id: IDS.buildBox, name: 'build-box', online: true, status: 'ONLINE', maxConcurrent: 4, activeSessions: 0, position: 2,
  hostname: 'build-box', version: '0.1.240', lastHeartbeatAt: ago(0.1), capabilities: ['provider:dsh', 'provider:antigravity'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.290 (Claude Code)' },
    { engine: 'codex', installed: true, auth: 'yes', version: 'codex-cli 0.162.0' },
    { engine: 'dsh', installed: false, auth: 'unknown', dsh: { ...DSH_OK, versionCompatible: false } },
  ],
  antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false, googleLogin: 'available' },
};
const macStudio = {
  id: IDS.macStudio, name: 'mac-studio', online: true, status: 'ONLINE', maxConcurrent: 4, activeSessions: 0, position: 3,
  hostname: 'mac-studio.local', version: '0.1.240', lastHeartbeatAt: ago(0.1), capabilities: ['provider:dsh'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.290 (Claude Code)' },
    { engine: 'dsh', installed: false, auth: 'unknown', installationError: 'DSH_PLATFORM_UNSUPPORTED: darwin arm64' },
  ],
  antigravity: { supported: false, installed: null, version: null, envKeyAvailable: false, googleLogin: 'unsupported_platform' },
};

/** The boards' machines; `states` adds the Mac whose platform DeepSeek Harness does not run on. */
export const runners = (scenario) => (scenario === 'states' ? [hpc, oldMac, buildBox, macStudio] : [hpc, oldMac, buildBox]);

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
];
const key = (over) => ({
  runtime: 'claude', engines: ['claude', 'opencode'], models: [], defaultModel: null, followsPreset: true,
  enabled: true, hasApiKey: true, poolRefusal: null, ...over,
});
export const KEYS = [
  key({ id: IDS.deepseek, slug: 'deepseek', label: 'DeepSeek', engines: ['claude', 'opencode', 'dsh'], baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek' }),
  key({ id: IDS.deepseek2, slug: 'deepseek-2', label: 'DeepSeek 2', engines: ['claude', 'opencode', 'dsh'], baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek' }),
  key({ id: IDS.gemini, slug: 'gemini', label: 'Gemini', runtime: 'antigravity', engines: ['antigravity', 'opencode'], baseUrl: 'https://generativelanguage.googleapis.com', models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }], defaultModel: 'gemini-3.8-flash', presetSlug: 'gemini' }),
  key({ id: IDS.kimi, slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', engines: ['kimi', 'opencode'], baseUrl: 'https://api.moonshot.ai/v1', models: [{ value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }], defaultModel: 'kimi-k2.7-code', presetSlug: 'moonshot' }),
  key({ id: IDS.glm, slug: 'glm', label: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', models: [{ value: 'glm-5.2', label: 'GLM-5.2' }, { value: 'glm-4.7', label: 'GLM-4.7' }], defaultModel: 'glm-5.2', presetSlug: 'glm' }),
  // A Claude subscription token: the server says it runs on Claude Code alone.
  key({ id: IDS.claudeMax, slug: 'anthropic', label: 'Claude Max', engines: ['claude'], baseUrl: 'https://api.anthropic.com', models: [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }], defaultModel: 'claude-opus-5-5', presetSlug: 'anthropic' }),
];

/** Without a DeepSeek key, or one OpenCode can run: the boards' two Not set up cards. */
export const keys = (scenario) =>
  scenario === 'none' ? [] : scenario === 'nodeepseek' ? KEYS.filter((k) => !k.engines.includes('dsh')) : KEYS;

const member = (n, label) => ({
  id: n, slug: label.toLowerCase().replace(/\W+/g, '-'), label, presetSlug: 'anthropic', enabled: true,
  planUsage: null, state: 'NO_QUOTA', resetsAt: null, next: n === IDS.poolA,
});
export const POOLS = [
  { id: IDS.pool, slug: 'claude-accounts', label: 'Claude accounts', engine: 'claude', resetsAt: null, unavailable: null,
    members: [member(IDS.poolA, 'Claude Team A'), member(IDS.poolB, 'Claude Team B')] },
];

export const balance = (keyId) => ({
  ok: true,
  providerId: keyId,
  balances: [keyId === IDS.deepseek
    ? { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }
    : { currency: 'CNY', totalBalance: '36.20', grantedBalance: '0.00', toppedUpBalance: '36.20' }],
  isAvailable: true,
  fetchedAt: ago(2),
  sharedWith: [],
});

/** GET /providers/mine/:id/usage: the boards' numbers on the first DeepSeek key, nothing elsewhere. */
export const usage = (keyId) =>
  keyId === IDS.deepseek
    ? { providerId: keyId, engines: [{ engine: 'claude', sessions: 2, tasks: 1 }, { engine: 'dsh', sessions: 1, tasks: 0 }], sessions: 3, tasks: 1 }
    : { providerId: keyId, engines: [], sessions: 0, tasks: 0 };

/** PATCH refused as T3 refuses an endpoint change under open use (contract §3.7). */
export const DIALECT_IN_USE = {
  code: 'PROVIDER_DIALECT_IN_USE',
  message: 'provider "DeepSeek" is in use on Claude Code, DeepSeek Harness by 3 open sessions and 1 task pins; its endpoint can\'t change while they use it',
  engines: ['claude', 'dsh'],
  sessions: 3,
  tasks: 1,
};
