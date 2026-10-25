// The sample fleet and keys every cursor-engine frame is drawn from. Names are samples (the repo is
// public). Clock: the fixtures freeze it at 2026-09-28T12:00Z (20:00 in Shanghai).
import { uuidToBase62 } from '/var/tmp/cursor-engine-mock/today/src/shared/dist/index.js';

export const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min) => new Date(NOW + min * 60_000).toISOString();
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);

export const IDS = {
  hpc: id('30'), // the fixtures' RUNNER id, so the fixture workspace/session sit on hpc
  mac: id('a02'), box: id('a03'),
  ws: id('20'),
  keyDeepseek: id('c01'), keyGemini: id('c02'), keyMoonshot: id('c03'), keyGlm: id('c04'), keyCursor: id('c05'), keyCursor2: id('c06'),
};

const checked = () => ({ status: 'checked', at: ago(6), okAt: ago(6) });

/* ── engines as each machine reports them (RunnerEngineHealth) ── */
const claude = {
  engine: 'claude', installed: true, auth: 'yes', version: '2.1.302', update: checked(),
  accounts: [
    { id: 'default', name: 'Personal', home: '/root/.claude', auth: 'yes' },
    { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-accounts/1e84046c', auth: 'yes' },
  ],
};
const codex = { engine: 'codex', installed: true, auth: 'yes', version: '0.164.0', update: checked(),
  accounts: [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' }] };
const kimi = { engine: 'kimi', installed: true, auth: 'yes', version: '2.1.4', update: checked(), kimiRegion: 'global',
  accounts: [{ id: 'default', home: '/root/.kimi-code', auth: 'yes', kimiRegion: 'global' }] };
const antigravity = { engine: 'antigravity', installed: true, auth: 'yes', version: '1.3.4', update: checked(), authSource: 'google',
  accounts: [{ id: 'default', home: '/root/.gemini', auth: 'yes' }] };
const opencode = { engine: 'opencode', installed: true, auth: 'unknown', version: '1.18.40', update: checked() };
const dsh = { engine: 'dsh', installed: true, auth: 'unknown', version: '0.2.0',
  dsh: { versionCompatible: true, credentialPresent: true, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'full' } };

const runner = (over) => ({
  online: true, status: 'ONLINE', maxConcurrent: 8, activeSessions: 0, lastHeartbeatAt: ago(0.3),
  enrolledAt: '2026-06-18T02:00:00Z', minFreeDiskMb: null, runsAsRoot: false, capabilities: [],
  selfUpdate: { state: 'enabled', installDir: '/usr/local/bin' }, commands: [], skills: [], ...over,
});

const planUsage = {
  claude: {
    fiveHour: { utilization: 23, resetsAt: ahead(126) }, sevenDay: { utilization: 41, resetsAt: ahead(3 * 1440) }, fetchedAt: ago(2),
    accounts: { 'slot-2': { fiveHour: { utilization: 57, resetsAt: ahead(64) }, sevenDay: { utilization: 18, resetsAt: ahead(5 * 1440) }, fetchedAt: ago(2) } },
  },
  codex: { primary: { utilization: 12, resetsAt: ahead(200), windowDurationMins: 300 }, secondary: { utilization: 41, resetsAt: ahead(4 * 1440), windowDurationMins: 10080 }, fetchedAt: ago(3) },
};

/** Today's fleet: three machines, none of which knows Cursor. */
export const runners = () => [
  runner({
    id: IDS.hpc, name: 'hpc', displayName: 'hpc', hostname: 'hpc-01', version: '0.1.250', maxConcurrent: 16, activeSessions: 3, position: 0,
    runsAsRoot: false, capabilities: ['provider:dsh', 'antigravity-account-login/v1', 'kimi-account-login/v1', 'kimi-account-remove/v1', 'kimi-account-move/v1'],
    antigravity: { supported: true, installed: true, version: '1.3.4', envKeyAvailable: true, authSource: 'google', googleLogin: 'available' },
    planUsage, engines: [claude, codex, kimi, antigravity, opencode, dsh],
    modelCatalog: {
      claude: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', contextWindow: 1_000_000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-haiku-5-5', label: 'Haiku 5.5', contextWindow: 200_000 },
      ],
      dsh: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }],
    },
    runtimeDefaultModels: { claude: 'claude-opus-5-5', dsh: 'deepseek-v4-pro' },
  }),
  runner({
    id: IDS.mac, name: 'mac-studio.local', displayName: 'mac-studio', hostname: 'mac-studio.local', version: '0.1.236', maxConcurrent: 4, activeSessions: 1, position: 1,
    engines: [{ ...claude, accounts: [claude.accounts[0]] }, codex, { engine: 'kimi', installed: false, auth: 'unknown' }],
  }),
  runner({
    id: IDS.box, name: 'build-box', displayName: 'build-box', hostname: 'build-box', version: '0.1.250', maxConcurrent: 4, activeSessions: 0, position: 2,
    engines: [{ ...claude, accounts: [claude.accounts[0]] }, codex, opencode],
  }),
];

/* ── keys (ProviderRow) ── */
const key = (over) => ({
  followsPreset: true, enabled: true, hasApiKey: true, poolRefusal: { reason: 'NOT_SUBSCRIPTION', message: 'Only Claude subscription tokens can be pooled.' }, lastUsedAt: ago(90), ...over,
});
export const providers = () => [
  key({ id: IDS.keyDeepseek, slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', engines: ['claude', 'opencode', 'dsh'],
    baseUrl: 'https://api.deepseek.com/anthropic', presetSlug: 'deepseek', defaultModel: 'deepseek-v4-pro',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }] }),
  key({ id: IDS.keyGemini, slug: 'gemini', label: 'Gemini', runtime: 'antigravity', engines: ['antigravity', 'opencode'],
    baseUrl: 'https://generativelanguage.googleapis.com', presetSlug: 'gemini', defaultModel: 'gemini-3.8-flash',
    models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }] }),
  key({ id: IDS.keyMoonshot, slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', engines: ['kimi', 'opencode'],
    baseUrl: 'https://api.moonshot.ai/v1', presetSlug: 'moonshot', defaultModel: 'kimi-k2.7-code',
    models: [{ value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }] }),
  key({ id: IDS.keyGlm, slug: 'glm', label: 'Z.AI (GLM)', runtime: 'claude', engines: ['claude', 'opencode'], lastUsedAt: null,
    baseUrl: 'https://api.z.ai/api/anthropic', presetSlug: 'glm', defaultModel: 'glm-5.2',
    models: [{ value: 'glm-5.2', label: 'GLM-5.2' }, { value: 'glm-5.2-air', label: 'GLM-5.2 Air' }] }),
];

export const workspaces = () => [{
  id: IDS.ws, name: 'orbit', runnerId: IDS.hpc, runner: { id: IDS.hpc, name: 'hpc', displayName: 'hpc' }, createdAt: '2026-07-01T00:00:00Z',
  lastProvider: 'claude', provider: 'claude', model: null, effort: null, enableWorktree: true, workDirExists: true, workDirIsGit: true, workDir: '/root/orbit',
}];

/* ── the proposal: the same fleet once runners and the control plane know Cursor CLI ── */
export const CURSOR_PIN = '2026.10.14-941492e';
export const CURSOR_TEAM = '5c2e91a0';
const cursorAccounts = (defaultAuth = 'yes') => [
  { id: 'default', home: '/root/.orbit/cursor/default', auth: defaultAuth },
  { id: CURSOR_TEAM, name: 'Team', home: `/root/.orbit/cursor-accounts/${CURSOR_TEAM}`, auth: 'yes' },
];
export const cursorHealth = (over = {}) => ({
  engine: 'cursor', installed: true, auth: 'yes', version: CURSOR_PIN,
  update: { status: 'pinned', at: ago(6), okAt: ago(6) }, accounts: cursorAccounts(), ...over,
});
/** Cursor's per-account reading (contract §11): Default is on the Free plan, whose request limit no
 *  dashboard call reports; Team is on Pro, whose included usage reads as a share of the billing cycle. */
export const cursorUsage = () => ({
  planName: 'Free', unavailable: 'free-plan', fetchedAt: ago(4),
  accounts: { [CURSOR_TEAM]: { planName: 'Pro', month: { utilization: 34, resetsAt: ahead(5 * 1440 + 4 * 60), label: 'Monthly limit' }, fetchedAt: ago(4) } },
});
export const cursorCatalog = () => [
  { value: 'default', label: 'Auto', priority: 0 },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', priority: 1, contextWindow: 300_000, contextOptions: ['300k', '1m'], reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningLevel: 'medium', cursorFast: true },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', priority: 2, contextWindow: 300_000, contextOptions: ['300k', '1m'], reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'medium', cursorFast: true },
  { value: 'gpt-5.5', label: 'GPT-5.5', priority: 3, contextWindow: 272_000, reasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoningLevel: 'medium', cursorFast: true },
  { value: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', priority: 4, contextWindow: 1_000_000, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' },
  { value: 'grok-4.7', label: 'Grok 4.7', priority: 5, contextWindow: 256_000, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high', cursorFast: true },
  { value: 'composer-2.5', label: 'Composer 2.5', priority: 6, cursorFast: true },
];

export const runnersProposal = ({ cursor = cursorHealth(), hpcCaps = [] } = {}) => {
  const [hpc, mac, box] = runners();
  return [
    { ...hpc, version: '0.1.262', capabilities: [...hpc.capabilities, 'provider:cursor', 'cursor-account-login/v1', 'cursor-account-remove/v1', ...hpcCaps],
      engines: [...hpc.engines, cursor], planUsage: { ...hpc.planUsage, cursor: cursorUsage() },
      modelCatalog: { ...hpc.modelCatalog, cursor: cursorCatalog() }, runtimeDefaultModels: { ...hpc.runtimeDefaultModels, cursor: 'default' } },
    mac,
    { ...box, version: '0.1.262', capabilities: ['provider:cursor'], engines: [...box.engines, { engine: 'cursor', installed: false, auth: 'unknown' }] },
  ];
};

export const cursorKey = (over = {}) => key({
  id: IDS.keyCursor, slug: 'cursor-api', label: 'Cursor', runtime: 'cursor', engines: ['cursor'], lastUsedAt: ago(35),
  baseUrl: 'https://api2.cursor.sh', presetSlug: 'cursor', defaultModel: 'default', models: cursorCatalog().map(({ value, label }) => ({ value, label })), ...over,
});
export const providersProposal = (extra = []) => [...providers(), cursorKey(), ...extra];
