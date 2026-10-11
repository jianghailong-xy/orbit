// The account boards 4–8 draw (docs/mocks/provider-engine-decoupling/web-4 … web-8), the same one T6's
// kit draws board 1 with: the runner hpc — Claude Code signed in with two accounts (Default, Work), Codex,
// Antigravity CLI on a Google account, OpenCode, DeepSeek Harness able to run, Kimi Code not installed —
// two DeepSeek keys, Gemini, Kimi and GLM keys, a Claude subscription token and a Claude account pool;
// the workspaces orbit (last on Claude Code with the DeepSeek key) and builds (last on DeepSeek Harness
// with DeepSeek 2), and one session or task per scene. Shaped as GET /runners, /providers,
// /providers/mine, /providers/pools, /workspaces, /sessions and /tasks/:id answer.
import { uuidToBase62 } from '/root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/src/shared/dist/index.js';
import { FIXTURE_IDS } from '/root/.orbit/worktrees/e156eb76-7d94-5654-b980-04356572c73d/src/web/ui-migration/fixtures.mjs';

export const NOW = Date.parse('2026-09-28T12:00:00.000Z'); // ui-migration/fixtures.mjs FIXED_NOW
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const inHours = (hours) => new Date(NOW + hours * 3_600_000).toISOString();
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);

export const IDS = {
  hpc: id(901),
  deepseek: id(911), deepseek2: id(912), gemini: id(913), kimi: id(914), glm: id(915), claudeMax: id(916),
  pool: id(921), poolA: id(922), poolB: id(923),
  orbit: id(931), builds: id(932),
  // Board 5: a DeepSeek Harness session of a task whose newer run is going, a Claude Code one, and a
  // DeepSeek Harness session whose key was deleted.
  dshSwitch: id(941), dshSibling: id(942), claudeEnded: id(943), dshDeleted: id(944),
  // Board 8: no DeepSeek key, a rejected DeepSeek key, the DeepSeek key rejected on Claude Code, and a
  // run that never started for want of a key.
  noKey: id(945), invalidKey: id(946), claudeRejected: id(947), neverStarted: id(948),
  // The task the board-5 session ran; the board-6 task is the ui-migration fixtures' own task id.
  releaseTask: id(953), pinTask: FIXTURE_IDS.task,
};

const PRO = '["deepseek", "deepseek-v4-pro"]';
const FLASH = '["deepseek", "deepseek-v4-flash"]';
const DSH_OK = { versionCompatible: true, credentialPresent: false, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'unknown' };

export const HPC = {
  id: IDS.hpc, name: 'hpc', online: true, status: 'ONLINE', maxConcurrent: 16, activeSessions: 1, position: 0,
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
      accounts: { 'slot-2': { provider: 'claude', fiveHour: { utilization: 57, resetsAt: inHours(4) }, fetchedAt: ago(2) } },
    },
    codex: { provider: 'codex', secondary: { utilization: 41, resetsAt: inHours(80), windowDurationMins: 10080 }, fetchedAt: ago(2) },
  },
  commands: [{ name: 'review', description: 'Review the current changes', provider: 'claude' }],
  skills: [],
  modelCatalog: {
    claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-haiku-4-5', label: 'Haiku 4.5' }],
    dsh: [{ value: PRO, label: 'DeepSeek V4 Pro' }, { value: FLASH, label: 'DeepSeek V4 Flash' }],
  },
  runtimeDefaultModels: { claude: 'claude-opus-5-5', dsh: PRO },
};

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
];
const key = (over) => ({
  runtime: 'claude', engines: ['claude', 'opencode'], models: [], defaultModel: null, followsPreset: true,
  enabled: true, hasApiKey: true, poolRefusal: null, ...over,
});
/** GET /providers/mine: every key of the user's, as T3 serves it (`engines` per key). */
export const KEYS = [
  key({ id: IDS.deepseek, slug: 'deepseek', label: 'DeepSeek', engines: ['claude', 'opencode', 'dsh'], baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek' }),
  key({ id: IDS.deepseek2, slug: 'deepseek-2', label: 'DeepSeek 2', engines: ['claude', 'opencode', 'dsh'], baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro', presetSlug: 'deepseek' }),
  key({ id: IDS.gemini, slug: 'gemini', label: 'Gemini', runtime: 'antigravity', engines: ['antigravity', 'opencode'], baseUrl: 'https://generativelanguage.googleapis.com', models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }], defaultModel: 'gemini-3.8-flash', presetSlug: 'gemini' }),
  key({ id: IDS.kimi, slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', engines: ['kimi', 'opencode'], baseUrl: 'https://api.moonshot.ai/v1', models: [{ value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }], defaultModel: 'kimi-k2.7-code', presetSlug: 'moonshot' }),
  key({ id: IDS.glm, slug: 'glm', label: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', models: [{ value: 'glm-5.2', label: 'GLM-5.2' }, { value: 'glm-4.7', label: 'GLM-4.7' }], defaultModel: 'glm-5.2', presetSlug: 'glm' }),
  // A Claude subscription token: the server says it runs on Claude Code alone.
  key({ id: IDS.claudeMax, slug: 'anthropic', label: 'Claude Max', engines: ['claude'], baseUrl: 'https://api.anthropic.com', models: [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }], defaultModel: 'claude-opus-5-5', presetSlug: 'anthropic' }),
];

/** `nodeepseek`: board 4's last case, an account with no DeepSeek key at all. */
export const keys = (scenario) => (scenario === 'nodeepseek' ? KEYS.filter((k) => !k.engines.includes('dsh')) : KEYS);

/** GET /providers (ProvidersService.listPublic): the enabled keys, keyless and endpointless. */
export const providers = (scenario) =>
  keys(scenario)
    .filter((k) => k.enabled)
    .map(({ slug, label, runtime, models, defaultModel, presetSlug, engines }) => ({
      slug, label, runtime, models, defaultModel, presetSlug, engines, planUsage: null, runsOnOpenCode: engines.includes('opencode'),
    }));

const member = (n, label) => ({
  id: n, slug: label.toLowerCase().replace(/\W+/g, '-'), label, presetSlug: 'anthropic', enabled: true,
  planUsage: null, state: 'NO_QUOTA', resetsAt: null, next: n === IDS.poolA,
});
export const POOLS = [
  { id: IDS.pool, slug: 'claude-accounts', label: 'Claude accounts', engine: 'claude', resetsAt: null, unavailable: null,
    members: [member(IDS.poolA, 'Claude Team A'), member(IDS.poolB, 'Claude Team B')] },
];

const workspace = (n, name, over) => ({
  id: n, name, runnerId: IDS.hpc, createdAt: ago(60 * 24 * 30), workDir: `/root/${name}`, enableWorktree: true,
  enabled: true, provider: null, model: null, effort: null, modelRouting: false, modelRoutingProviders: [],
  appendSystemPrompt: '', env: {}, ...over,
});
export const WORKSPACES = [
  workspace(IDS.orbit, 'orbit', { lastEngine: 'claude', lastProvider: 'deepseek' }),
  workspace(IDS.builds, 'builds', { lastEngine: 'dsh', lastProvider: 'deepseek-2' }),
];
const [ORBIT] = WORKSPACES;

const session = (n, title, over) => ({
  id: n, workspaceId: ORBIT.id, workspace: ORBIT, runnerId: IDS.hpc, assignedRunnerId: IDS.hpc, title,
  engine: 'claude', provider: 'claude', model: null, effort: null, taskId: null,
  status: 'COMPLETED', runState: 'ENDED', lifecycleState: 'OPEN', error: null, numTurns: 1,
  createdAt: ago(95), updatedAt: ago(12), startedAt: ago(95), engineStartedAt: ago(95), lastTurnAt: ago(12),
  shareToken: null, ...over,
});
const failed = { status: 'FAILED', runState: 'FAILED', updatedAt: ago(12), lastTurnAt: ago(12) };
export const SESSIONS = [
  session(IDS.dshSwitch, 'Tidy the release notes', { engine: 'dsh', provider: 'deepseek', model: PRO, taskId: IDS.releaseTask }),
  // The task's newer run, going: what makes a provider pick on the session above land on the next turn.
  session(IDS.dshSibling, 'Tidy the release notes', { engine: 'dsh', provider: 'deepseek', model: PRO, taskId: IDS.releaseTask, status: 'RUNNING', runState: 'RUNNING', createdAt: ago(5), updatedAt: ago(0.5), startedAt: ago(5), engineStartedAt: ago(5), lastTurnAt: ago(0.5) }),
  session(IDS.claudeEnded, 'Review the Go changes', {}),
  // Its key was deleted after it ran (board 5 ④): `deepseek-harness`, the retired Harness preset's slug.
  session(IDS.dshDeleted, 'Fix the flaky worktree test', { engine: 'dsh', provider: 'deepseek-harness', model: PRO }),
  session(IDS.noKey, 'No key', { engine: 'dsh', provider: 'deepseek-harness', model: PRO, ...failed }),
  session(IDS.invalidKey, 'Invalid key', { engine: 'dsh', provider: 'deepseek-2', model: PRO, ...failed }),
  session(IDS.claudeRejected, 'Invalid key', { provider: 'deepseek', model: 'deepseek-v4-pro', ...failed }),
  session(IDS.neverStarted, 'No key', {
    engine: 'dsh', provider: 'deepseek-harness', model: PRO, ...failed, engineStartedAt: null, numTurns: 0,
    error: 'DSH_CREDENTIAL_MISSING: DeepSeek Harness runs on a DeepSeek API key, and this session has none; connect one in Orbit (runner and workspace .env credentials are not used)',
  }),
];

const turn = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(9000 + n).padStart(12, '0')}`);
const user = (seq, n, text) => ({ seq, type: 'user', payload: { text }, turnId: turn(n), ts: ago(14) });
const said = (seq, n, text) => ({ seq, type: 'assistant', payload: { text }, turnId: turn(n), ts: ago(13) });
const end = (seq, n) => ({ seq, type: 'turn_end', payload: {}, turnId: turn(n), ts: ago(12) });
const error = (seq, n, message) => ({ seq, type: 'error', payload: { message }, turnId: turn(n), ts: ago(12) });
const WHY = 'Why is CI red?';

/** GET /sessions/:id/events/page, per session. */
export const EVENTS = {
  [IDS.dshSwitch]: [user(1, 1, 'Tidy the release notes for 0.1.240.'), said(2, 1, 'Done: the notes are grouped by area, and the two duplicate entries are gone.'), end(3, 1)],
  [IDS.dshSibling]: [user(1, 2, 'Tidy the release notes for 0.1.240.')],
  [IDS.claudeEnded]: [user(1, 3, 'Review the Go changes on this branch.'), said(2, 3, 'The changes look right. One nit: `drainCap` is read twice in `settle`.'), end(3, 3)],
  [IDS.dshDeleted]: [user(1, 4, 'The worktree test fails one run in ten. Find out why.'), said(2, 4, 'It races the cleanup of the previous run. A fix is on the branch.'), end(3, 4)],
  [IDS.noKey]: [user(1, 5, WHY), error(2, 5, 'DSH_CREDENTIAL_MISSING: DeepSeek Harness runs on a DeepSeek API key, and this session has none; connect one in Orbit (runner and workspace .env credentials are not used)'), end(3, 5)],
  [IDS.invalidKey]: [user(1, 6, WHY), error(2, 6, 'dsh session/prompt (-32603): Authentication Fails, Your api key: ****0000 is invalid'), end(3, 6)],
  [IDS.claudeRejected]: [user(1, 7, WHY), error(2, 7, 'Failed to authenticate. API Error: 401 {"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error"}}'), end(3, 7)],
  [IDS.neverStarted]: [],
};

// The task shape TaskDetailPanel reads, as ui-migration/fixtures.mjs serves its own task.
const TASK_BASE = {
  status: 'OPEN', outcome: 'OPEN', description: 'It fails about one run in ten on CI.', acceptanceCriteria: null,
  acceptanceCommand: null, acceptanceExpectedExitCode: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL',
  createdAt: ago(60 * 24), updatedAt: ago(60), dueDate: null, runAt: null, parentTaskId: null,
  assignee: { id: ORBIT.id, name: 'orbit' }, assigneeId: ORBIT.id,
  engine: null, provider: null, model: null, modelHint: null, modelHintReason: null,
  project: null, list: null, listId: null, projectId: null, labels: [],
  autoRunWhenReady: false, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'READY', childCount: 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [], comments: [],
};

/** The board-6 task, assigned to orbit: unpinned, or (`migrated`) the pin T4 rewrote off `deepseek-harness`. */
export const pinTask = (scenario) => ({
  ...TASK_BASE, id: IDS.pinTask, title: 'Fix the flaky worktree test',
  engine: scenario === 'migrated' ? 'dsh' : null,
  provider: scenario === 'migrated' ? 'deepseek' : null,
});

/** The task the board-5 sessions ran. */
export const releaseTask = () => ({
  ...TASK_BASE, id: IDS.releaseTask, title: 'Tidy the release notes', status: 'IN_PROGRESS', engine: 'dsh',
});
