import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';

// P4.2 data: the Providers page (the engines signed in on three runners, account pools of each kind,
// the API keys table), connecting and editing a provider, a DeepSeek key's account balance, a pool's
// own page, the Runners list, a runner's page with its workspaces and capacity, approving
// `orbit register`, and the administrator's Users table. Registered on top of installFixtures (later
// routes win), so every path not modeled here still falls through to the P0 handler and its
// unhandled-request check. `state` is read on every request, so a test changes an answer before the
// step that asks. Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const P42_IDS = {
  studio: id('3001'), build: id('3002'), laptop: id('3003'),
  web: id('2001'), docs: id('2002'),
  anthropic: id('5001'), anthropicWork: id('5002'), openai: id('5003'), lab: id('5004'),
  claudePool: id('6001'), codexPool: id('6002'), teamPool: id('6003'),
  lin: id('4101'), zhang: id('4102'), dev: id('4103'), ops: id('4104'), former: id('4105'),
  teamKey: id('6101'), linKey: id('6102'), orgKey: id('6103'),
  deepseek: id('5005'), deepseekTeam: id('5006'), deepseekCustom: id('5007'),
};
export const ENROLL_CODE = 'K7QX-M2PD';
export const P42_PATHS = {
  providers: '/providers', connectAnthropic: '/providers/new/anthropic', connectCustom: '/providers/new/custom',
  editOpenai: `/providers/${P42_IDS.openai}`, claudePool: `/providers/pools/${P42_IDS.claudePool}`,
  codexPool: `/providers/pools/${P42_IDS.codexPool}`, teamPool: `/providers/pools/${P42_IDS.teamPool}`,
  runners: '/runners', studio: `/runners/${P42_IDS.studio}`, laptop: `/runners/${P42_IDS.laptop}`,
  register: '/runners/register', enroll: `/enroll?code=${ENROLL_CODE}`, admin: '/admin',
  editDeepseek: `/providers/${P42_IDS.deepseek}`, editDeepseekTeam: `/providers/${P42_IDS.deepseekTeam}`,
  editDeepseekCustom: `/providers/${P42_IDS.deepseekCustom}`,
};
export const ROTATED_TOKEN = 'orbit_rt_uiMigrationFixtureRunnerToken0123456789';
export const STORED_KEY = 'sk-proj-uiMigrationFixtureStoredKey0123456789';
export const PROBE_ERROR = 'The endpoint answered 401: invalid x-api-key';
export const ONE_TIME_PASSWORD = 'tidal-orbit-4821';
export const DEVICE_CODE = { url: 'https://auth.openai.com/codex/device', code: 'WQRT-8KZP' };

const VERSION = '0.1.230';
const checked = { status: 'checked', at: at(-10 * MIN), okAt: at(-10 * MIN) };

/** Studio Mac: online, every CLI current, Claude signed in, two Codex accounts, Kimi missing. */
const studio = () => ({
  id: P42_IDS.studio, name: 'studio-mac', displayName: 'Studio Mac', hostname: 'studio-mac.local', version: VERSION,
  online: true, status: 'ACTIVE', position: 0, labels: ['gpu'], maxConcurrent: 4, activeSessions: 1,
  lastHeartbeatAt: at(-15_000), enrolledAt: '2026-06-18T09:00:00.000Z', runsAsRoot: false, minFreeDiskMb: null,
  reposRoot: '/Users/orbit/orbit-repos', selfUpdate: null,
  engines: [
    { engine: 'claude', installed: true, version: '2.1.290 (Claude Code)', auth: 'yes', update: { ...checked, latest: '2.1.290' } },
    {
      engine: 'codex', installed: true, version: 'codex-cli 0.160.0', auth: 'yes', update: { ...checked, latest: '0.160.0' },
      accounts: [
        { id: 'default', home: '/Users/orbit/.codex', auth: 'yes', fingerprintPrefix: 'a1b2c3' },
        { id: 'work', name: 'Work', home: '/Users/orbit/.orbit/codex-accounts/work', auth: 'yes', fingerprintPrefix: 'd4e5f6' },
      ],
    },
    { engine: 'kimi', installed: false, auth: 'unknown' },
  ],
  antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'available' },
  planUsage: {
    provider: 'claude', fiveHour: { utilization: 14, resetsAt: at(3 * HOUR) }, sevenDay: { utilization: 62, resetsAt: at(3 * DAY) },
    claude: { provider: 'claude', fiveHour: { utilization: 14, resetsAt: at(3 * HOUR) }, sevenDay: { utilization: 62, resetsAt: at(3 * DAY) }, fetchedAt: at(-5 * MIN) },
    codex: {
      provider: 'codex', primary: { utilization: 22, resetsAt: at(2 * HOUR), windowDurationMins: 300 },
      secondary: { utilization: 41, resetsAt: at(4 * DAY), windowDurationMins: 10080 }, fetchedAt: at(-5 * MIN),
      accounts: {
        work: { provider: 'codex', primary: { utilization: 71, resetsAt: at(HOUR), windowDurationMins: 300 }, secondary: { utilization: 35, resetsAt: at(5 * DAY), windowDurationMins: 10080 }, fetchedAt: at(-5 * MIN) },
      },
    },
  },
});
/** build-01: draining, both slots busy, Claude signed out. */
const build = () => ({
  id: P42_IDS.build, name: 'build-01', displayName: null, hostname: 'build-01', version: VERSION,
  online: true, status: 'DRAINING', position: 1, labels: [], maxConcurrent: 2, activeSessions: 2,
  lastHeartbeatAt: at(-20_000), enrolledAt: '2026-07-02T09:00:00.000Z', runsAsRoot: true, minFreeDiskMb: 20480,
  reposRoot: '/root/orbit-repos', selfUpdate: null,
  engines: [
    { engine: 'claude', installed: true, version: '2.1.290 (Claude Code)', auth: 'no', update: { ...checked, latest: '2.1.290' } },
    { engine: 'codex', installed: true, version: 'codex-cli 0.160.0', auth: 'yes', update: { ...checked, latest: '0.160.0' } },
    { engine: 'kimi', installed: true, version: '2.1.1', auth: 'yes', update: { ...checked, latest: '2.1.1' } },
  ],
  planUsage: null,
});
/** old-laptop: offline for two days, an older release it cannot install itself. */
const laptop = () => ({
  id: P42_IDS.laptop, name: 'old-laptop', displayName: null, hostname: 'old-laptop', version: '0.1.201',
  online: false, status: 'OFFLINE', position: 2, labels: ['backup'], maxConcurrent: 1, activeSessions: 0,
  lastHeartbeatAt: at(-2 * DAY - 3 * HOUR), enrolledAt: '2026-05-11T09:00:00.000Z', runsAsRoot: false, minFreeDiskMb: null,
  reposRoot: '/home/orbit/orbit-repos', selfUpdate: null,
  engines: [{ engine: 'claude', installed: true, version: '2.1.271 (Claude Code)', auth: 'yes' }],
  planUsage: null,
});

const workspaces = () => [
  {
    id: P42_IDS.web, name: 'orbit-web', runnerId: P42_IDS.studio, createdAt: '2026-06-20T09:00:00.000Z', position: 0,
    lastProvider: 'claude', provider: 'claude', effort: null, enabled: true, enableWorktree: true, modelRouting: false,
    modelRoutingProviders: [], appendSystemPrompt: null, workDir: '/Users/orbit/orbit', repoUrl: 'https://github.com/example/orbit',
    env: { NODE_ENV: 'development' }, codexAccount: null, claudeAccount: null, antigravityAccount: null,
    workDirExists: true, workDirIsGit: true, workDirProbedAt: at(-MIN),
    workDirFreeBytes: String(412 * 1024 ** 3), workDirTotalBytes: String(994 * 1024 ** 3),
    repoHealth: { root: '/Users/orbit/orbit', state: 'clean', agentIds: [P42_IDS.web] },
  },
  {
    id: P42_IDS.docs, name: 'docs-site', runnerId: P42_IDS.studio, createdAt: '2026-07-01T09:00:00.000Z', position: 1,
    lastProvider: 'codex', provider: 'codex', effort: null, enabled: false, enableWorktree: false, modelRouting: false,
    modelRoutingProviders: [], appendSystemPrompt: 'Write in plain English.', workDir: '/Users/orbit/docs', repoUrl: null,
    env: {}, codexAccount: 'work', claudeAccount: null, antigravityAccount: null,
    workDirExists: true, workDirIsGit: true, workDirProbedAt: at(-MIN),
    workDirFreeBytes: String(412 * 1024 ** 3), workDirTotalBytes: String(994 * 1024 ** 3),
    repoHealth: { root: '/Users/orbit/docs', state: 'clean', agentIds: [P42_IDS.docs] },
  },
];

const anthropicModels = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
const providerRow = (over) => ({
  runtime: 'claude', baseUrl: 'https://api.anthropic.com', models: anthropicModels, defaultModel: 'claude-opus-5-5',
  presetSlug: 'anthropic', followsPreset: true, enabled: true, hasApiKey: true, poolRefusal: null, ...over,
});
const NOT_A_SUBSCRIPTION = { reason: 'METERED', message: 'A metered API key has no 5-hour window to pool' };
const providers = () => [
  providerRow({ id: P42_IDS.anthropic, slug: 'anthropic', label: 'Anthropic (Claude)' }),
  providerRow({ id: P42_IDS.anthropicWork, slug: 'anthropic-2', label: 'Claude Max (work)' }),
  providerRow({
    id: P42_IDS.openai, slug: 'openai', label: 'OpenAI (Codex)', runtime: 'codex', baseUrl: 'https://api.openai.com/v1',
    models: [{ value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }, { value: 'gpt-5.5', label: 'GPT-5.5' }], defaultModel: 'gpt-5.5-codex',
    presetSlug: 'openai', poolRefusal: { reason: 'NOT_ANTHROPIC', message: 'Only Anthropic keys can join an account pool' },
  }),
  providerRow({
    id: P42_IDS.lab, slug: 'lab-gateway', label: 'Lab gateway', baseUrl: 'https://gateway.example.test/anthropic',
    models: [{ value: 'lab-large', label: 'Lab large', contextWindow: 200000 }], defaultModel: 'lab-large',
    presetSlug: null, followsPreset: false, enabled: false, poolRefusal: NOT_A_SUBSCRIPTION,
  }),
];

// DeepSeek keys and their accounts' balances. Not among the rows every test reads (the keys table and
// the pools' pickers would change under them): a test that reads balances adds them.
const deepseekModels = [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }];
export const deepseekRows = () => [
  providerRow({
    id: P42_IDS.deepseek, slug: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic',
    models: deepseekModels, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek', poolRefusal: NOT_A_SUBSCRIPTION,
  }),
  providerRow({
    id: P42_IDS.deepseekTeam, slug: 'deepseek-2', label: 'DeepSeek (team)', baseUrl: 'https://api.deepseek.com/anthropic',
    models: deepseekModels, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek', poolRefusal: NOT_A_SUBSCRIPTION,
  }),
  providerRow({
    id: P42_IDS.deepseekCustom, slug: 'my-deepseek', label: 'My DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    models: deepseekModels, defaultModel: 'deepseek-v4-pro', presetSlug: null, followsPreset: false, poolRefusal: NOT_A_SUBSCRIPTION,
  }),
];
const cny = (total, granted, toppedUp) => ({ currency: 'CNY', totalBalance: total, grantedBalance: granted, toppedUpBalance: toppedUp });
export const DEEPSEEK_LOW = { ok: true, balances: [cny('0.42', '0.00', '0.42')], isAvailable: false, fetchedAt: at(0), sharedWith: [] };
export const deepseekBalances = () => ({
  [P42_IDS.deepseek]: { ok: true, balances: [cny('110.00', '10.00', '100.00')], isAvailable: true, fetchedAt: at(-2 * MIN), sharedWith: [] },
  [P42_IDS.deepseekTeam]: DEEPSEEK_LOW,
  [P42_IDS.deepseekCustom]: {
    ok: false, reason: 'KEY_REJECTED', message: 'DeepSeek rejected this API key (401 Authentication Fails).', fetchedAt: at(-MIN), sharedWith: [],
  },
});

const window5h = (utilization, resetsAt) => ({ provider: 'claude', fiveHour: { utilization, resetsAt }, sevenDay: { utilization: Math.min(100, utilization + 20), resetsAt: at(3 * DAY) }, fetchedAt: at(-5 * MIN) });
const member = (row, over) => ({
  id: row.id, slug: row.slug, label: row.label, presetSlug: row.presetSlug, enabled: true, pausedUntil: null,
  planUsage: null, state: 'AVAILABLE', resetsAt: null, next: false, ...over,
});
const people = { me: FIXTURE_IDS.user };
const spend = (costUsd) => ({ inputTokens: 0, outputTokens: 0, costUsd });
/** The reader's own ChatGPT account in their Codex pool. */
const login = (over) => ({
  userId: people.me, state: 'ACTIVE', email: 'reviewer@example.test', plan: 'plus', fingerprint: '…9F3K', lastError: null,
  expiresAt: at(5 * DAY), linkedAt: '2026-09-20T10:00:00.000Z', pausedUntil: null,
  usage: { provider: 'codex', primary: { utilization: 31, resetsAt: at(2 * HOUR), windowDurationMins: 300 }, secondary: { utilization: 58, resetsAt: at(4 * DAY), windowDurationMins: 10080 } },
  usageUnavailable: null, ...over,
});
const pools = (rows) => [
  {
    id: P42_IDS.claudePool, slug: 'claude-accounts', label: 'Claude accounts', engine: 'claude', resetsAt: null, unavailable: null,
    members: [
      member(rows[0], { planUsage: window5h(36, at(2 * HOUR)), next: true }),
      member(rows[1], { planUsage: window5h(100, at(90 * MIN)), state: 'SPENT', resetsAt: at(90 * MIN) }),
    ],
  },
  { id: P42_IDS.codexPool, slug: 'my-codex', label: 'My Codex', engine: 'codex', resetsAt: null, unavailable: null, members: [], login: login(), logins: [login()] },
];
const person = (userId, name, over) => ({ userId, name, role: 'MEMBER', creator: false, you: false, keys: 0, sessions: 0, usage: spend(0), ...over });
const poolKey = (keyId, label, fingerprint, contributor, over) => ({
  id: keyId, label, fingerprint, state: 'ACTIVE', enabled: true, pausedUntil: null, shareCap: null, spentUntil: null, contributor,
  usage: { ...spend(0), othersCostUsd: 0 }, running: false, next: false, ...over,
});
const window = { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };
/** Who can use My Codex: the reader, who owns it, and Lin Wei, whom they added; an API key of each. */
const codexAccess = () => {
  const me = { userId: people.me, name: 'Baseline Reviewer', you: true };
  const lin = { userId: P42_IDS.lin, name: 'Lin Wei', you: false };
  return {
    id: P42_IDS.codexPool, slug: 'my-codex', label: 'My Codex', engine: 'codex', shared: false,
    logins: [{ ...login(), next: true }], membersCanAdd: true, membersCanAddAccounts: false, ownKeyFirst: true, viewerRole: 'ADMIN', window,
    people: [
      person(people.me, 'Baseline Reviewer', { role: 'ADMIN', creator: true, you: true, keys: 1, sessions: 14, usage: spend(6.2) }),
      person(P42_IDS.lin, 'Lin Wei', { keys: 1, sessions: 5, usage: spend(2.6) }),
    ],
    keys: [
      poolKey(P42_IDS.orgKey, 'orbit-org', 'sk-…AB12', me, { shareCap: 40, usage: { ...spend(9.1), othersCostUsd: 2.6 } }),
      poolKey(P42_IDS.linKey, 'lin-proj', 'sk-…7K2P', lin, { usage: { ...spend(2.6), othersCostUsd: 2.6 }, state: 'INVALID' }),
    ],
  };
};
/** Team keys: a pool Zhang Min made on the shared pools page and added the reader to. */
const teamPool = () => {
  const zhang = { userId: P42_IDS.zhang, name: 'Zhang Min', you: false };
  return {
    id: P42_IDS.teamPool, slug: 'team-keys', label: 'Team keys', engine: 'codex', shared: true, logins: [],
    membersCanAdd: true, membersCanAddAccounts: false, ownKeyFirst: true, viewerRole: 'MEMBER', window,
    people: [
      person(P42_IDS.zhang, 'Zhang Min', { role: 'ADMIN', creator: true, keys: 1, sessions: 21, usage: spend(11.4) }),
      person(people.me, 'Baseline Reviewer', { you: true, sessions: 3, usage: spend(1.2) }),
    ],
    keys: [poolKey(P42_IDS.teamKey, 'team-main', 'sk-…Q9WE', zhang, { shareCap: 100, usage: { ...spend(12.6), othersCostUsd: 1.2 }, next: true })],
  };
};

// The signed-in reviewer is the administrator (no Disable on their own row); one account is disabled.
const adminUsers = () => [
  { id: FIXTURE_IDS.user, email: 'reviewer@example.test', name: 'Baseline Reviewer', role: 'ADMIN', createdAt: '2026-05-02T09:00:00.000Z', signInMethods: { password: true, google: null }, disabledAt: null },
  { id: P42_IDS.dev, email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-08-29T12:00:00.000Z', signInMethods: { password: true, google: { email: 'dev.orbit@gmail.com' } }, disabledAt: null },
  { id: P42_IDS.ops, email: 'ops@example.test', name: '', role: 'MEMBER', createdAt: '2026-09-21T12:00:00.000Z', signInMethods: { password: false, google: null }, disabledAt: null },
  { id: P42_IDS.former, email: 'former@example.test', name: 'Former Teammate', role: 'MEMBER', createdAt: '2026-07-14T12:00:00.000Z', signInMethods: { password: true, google: null }, disabledAt: at(-2 * DAY) },
];
export const HISTORY_DIR = '/Users/orbit/notes';
const history = {
  workDir: HISTORY_DIR, windowDays: 30, conversations: 14, bytes: 9_437_184, events: 3120,
  transcripts: [
    { claudeSessionId: '4e453ab7-f37c-494d-8017-bb4e9beffeef', title: 'Tidy the release notes', lastActiveAt: at(-2 * HOUR), messages: 48 },
    { claudeSessionId: '7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', title: 'Draft the changelog', lastActiveAt: at(-3 * DAY), messages: 22 },
  ],
};
const device = () => ({ userCode: ENROLL_CODE, name: 'gpu-box', hostname: 'gpu-box-07', labels: ['gpu', 'cuda'], maxConcurrent: 4, status: 'PENDING', nameConflict: false });

/** A promise the test resolves to let a held answer through. */
export function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

export async function installP42Fixtures(page, { theme = 'light' } = {}) {
  const rows = providers();
  const state = {
    account: { id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: '2026-09-27T10:00:00.000Z',
      avatarUpdatedAt: null, role: 'ADMIN', preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } },
    runners: [studio(), build(), laptop()], holdRunners: null,
    workspaces: workspaces(),
    providers: rows, holdProviders: null, probe: { ok: false, message: PROBE_ERROR }, balances: {}, holdBalance: null,
    pools: pools(rows), sharedPools: [teamPool()], access: { [P42_IDS.codexPool]: codexAccess(), [P42_IDS.teamPool]: teamPool() },
    users: adminUsers(), holdUsers: null, google: true, disableRefusals: {},
    device: device(), holdDevice: null, deviceError: null,
  };
  const requests = [];
  // Which runner cards and account groups start open (RunnerEngines keeps both in localStorage, which
  // installFixtures clears on every load).
  await page.addInitScript(({ studioId }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([studioId]));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${studioId}/codex`]));
  }, { studioId: P42_IDS.studio });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData(); } };
    const note = () => requests.push({ method, path: path + (searchParams.size ? `?${searchParams}` : ''), body: method === 'GET' ? undefined : body() });
    const runner = path.match(/^\/api\/runners\/([^/]+)(\/.*)?$/);
    const workspace = path.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);

    if (method === 'GET' && path === '/api/users/me') return json(state.account);
    if (method === 'GET' && path === '/api/auth/methods') return json({ password: true, google: state.google, googleSignup: false });

    // Runners and their workspaces.
    if (method === 'GET' && path === '/api/runners') {
      if (state.holdRunners) await state.holdRunners.promise;
      return json(state.runners);
    }
    if (method === 'POST' && path === '/api/runners/reorder') {
      note();
      const ids = request.postDataJSON().ids;
      state.runners = ids.map((runnerId, position) => ({ ...state.runners.find((r) => r.id === runnerId), position }));
      return json(state.runners);
    }
    if (method === 'GET' && path.startsWith('/api/runners/device/')) {
      if (state.holdDevice) await state.holdDevice.promise;
      if (state.deviceError) return json({ message: state.deviceError }, 404);
      return json(state.device);
    }
    if (method === 'POST' && path === `/api/runners/device/${ENROLL_CODE}/approve`) {
      note();
      state.device = { ...state.device, status: 'APPROVED' };
      return json({ ok: true });
    }
    if (runner && runner[1] !== 'device') {
      const [, runnerId, rest = ''] = runner;
      const target = state.runners.find((r) => r.id === runnerId);
      if (method === 'PATCH' && !rest && target) {
        note();
        Object.assign(target, request.postDataJSON());
        return json(target);
      }
      if (method === 'DELETE' && !rest && target) {
        note();
        state.runners = state.runners.filter((r) => r !== target);
        return json({ ok: true });
      }
      if (method === 'POST' && rest === '/rotate-token') { note(); return json({ token: ROTATED_TOKEN }); }
      // What Claude Code history a directory holds: answered on the first poll, for HISTORY_DIR only.
      if (rest === '/claude-history') {
        const workDir = method === 'POST' ? request.postDataJSON().workDir : searchParams.get('workDir');
        if (method === 'POST') { note(); return json({ workDir, status: 'pending' }); }
        return json({ workDir, status: 'done', requestedAt: at(-MIN), result: workDir === HISTORY_DIR ? history : null });
      }
      if (method === 'POST' && ['/engine-update', '/refresh-models', '/self-update', '/install'].includes(rest)) { note(); return json({ ok: true }); }
      if (method === 'DELETE' && rest === '/install') { note(); return json({ ok: true }); }
      const account = rest.match(/^\/accounts\/([a-z]+)\/([^/]+)(\/pause)?$/);
      if (account) {
        note();
        if (method === 'DELETE') return json({ engine: account[1], account: account[2], status: 'pending' });
        return json({ ok: true });
      }
    }
    if (method === 'GET' && path === '/api/workspaces') return json(state.workspaces);
    if (method === 'POST' && path === '/api/workspaces') {
      note();
      const created = { ...state.workspaces[0], ...request.postDataJSON(), id: id('2099'), name: request.postDataJSON().name };
      state.workspaces = [...state.workspaces, created];
      return json(created);
    }
    if (workspace) {
      const [, workspaceId, rest = ''] = workspace;
      if (method === 'GET' && rest === '/permission-rules') return json([]);
      if (method === 'PATCH' && !rest) {
        note();
        state.workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, ...request.postDataJSON() } : w));
        return json(state.workspaces.find((w) => w.id === workspaceId));
      }
      if (method === 'DELETE' && !rest) {
        note();
        state.workspaces = state.workspaces.filter((w) => w.id !== workspaceId);
        return json({ ok: true });
      }
    }
    if (method === 'GET' && path === '/api/sessions/imported') return json({ count: 0 });
    if (method === 'POST' && path === '/api/sessions/import-batch') {
      note();
      return json({ imported: request.postDataJSON().transcripts.length, sessionIds: [], skipped: [] });
    }

    // Providers: the user's keys, the vendor catalogue, the connect probe.
    if (method === 'GET' && path === '/api/providers/mine') {
      if (state.holdProviders) await state.holdProviders.promise;
      return json(state.providers);
    }
    if (method === 'GET' && path === '/api/providers/presets') return json({});
    if (method === 'POST' && path === '/api/providers/test') { note(); return json(state.probe); }
    if (method === 'POST' && path === '/api/providers/mine') { note(); return json({ ...state.providers[0], id: id('5099'), ...request.postDataJSON() }); }
    // A DeepSeek key's account balance, and the same read again when a refresh asks (?refresh=1).
    const balance = path.match(/^\/api\/providers\/mine\/([^/]+)\/balance$/);
    if (method === 'GET' && balance && state.balances[balance[1]]) {
      if (searchParams.has('refresh')) note();
      if (state.holdBalance) await state.holdBalance.promise;
      return json(state.balances[balance[1]]);
    }
    const mine = path.match(/^\/api\/providers\/mine\/([^/]+)(\/key)?$/);
    if (mine) {
      if (method === 'GET' && mine[2]) return json({ apiKey: STORED_KEY });
      note();
      if (method === 'DELETE') state.providers = state.providers.filter((p) => p.id !== mine[1]);
      return json({ ok: true });
    }

    // Account pools, of the user's own and shared.
    if (method === 'GET' && path === '/api/providers/pools') return json(state.pools);
    if (method === 'GET' && path === '/api/providers/shared-pools') return json(state.sharedPools);
    const access = path.match(/^\/api\/providers\/shared-pools\/([^/]+)$/);
    if (method === 'GET' && access && state.access[access[1]]) return json(state.access[access[1]]);
    if (method === 'POST' && path === `/api/providers/pools/${P42_IDS.codexPool}/codex-login`) {
      note();
      return json({ status: 'PENDING', verificationUrl: DEVICE_CODE.url, userCode: DEVICE_CODE.code, expiresAt: at(15 * MIN) });
    }
    if (method === 'GET' && path === `/api/providers/pools/${P42_IDS.codexPool}/codex-login`) {
      return json({ status: 'PENDING', verificationUrl: DEVICE_CODE.url, userCode: DEVICE_CODE.code, expiresAt: at(15 * MIN), account: null });
    }
    if (path.startsWith('/api/providers/pools') || path.startsWith('/api/providers/shared-pools')) {
      note();
      return json({ ok: true });
    }

    // The administrator's Users page.
    if (method === 'GET' && path === '/api/admin/users') {
      if (state.holdUsers) await state.holdUsers.promise;
      return json(state.users);
    }
    if (method === 'POST' && path === '/api/admin/users') {
      note();
      const asked = request.postDataJSON();
      return json({ email: asked.email, reset: !!asked.force, generatedPassword: asked.passwordless ? undefined : ONE_TIME_PASSWORD });
    }
    // Disabling an account and enabling it again: the server answers the account as it now is, or refuses
    // with its message (`disableRefusals`, by id).
    const disabling = path.match(/^\/api\/admin\/users\/([^/]+)\/disabled$/);
    if (method === 'PATCH' && disabling) {
      note();
      const target = state.users.find((u) => u.id === disabling[1]);
      const refusal = state.disableRefusals[disabling[1]];
      if (refusal || !target) return json({ statusCode: 404, message: refusal ?? 'user not found' }, 404);
      target.disabledAt = request.postDataJSON().disabled ? at(0) : null;
      const { signInMethods: _, ...answer } = target;
      return json(answer);
    }
    if (path.startsWith('/api/admin/users/') && method !== 'GET') { note(); return json({ ok: true }); }
    if (method !== 'GET') note();
    return route.fallback();
  });
  return { state, requests };
}
