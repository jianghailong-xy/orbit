// Fake control plane for photographing the DeepSeek balance in the REAL web console (vite dev server
// of this checkout's src/web): just enough of /api for /providers and /providers/:id, with DeepSeek
// keys whose GET /api/providers/mine/:id/balance answers in the server's own shape
// (src/apiserver/src/providers/deepseek-balance.service.ts) and in every state. Nothing here talks to
// DeepSeek and no key exists; every row and number is made up.
//
//   node server.mjs [port]        GET /__set?scenario=pair|states picks the provider list.
//
// pair   — Anthropic, DeepSeek and DeepSeek Harness holding one key (one balance, each naming the
//          other), Kimi.
// states — DeepSeek keys whose balance is: normal, two currencies, too low (is_available=false),
//          rejected (401), unreachable, an upstream error, and one never answered (loading).
// A refresh (?refresh=1) answers with a read made now; every request is logged to stdout.
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 3993);
const ago = (min) => new Date(Date.now() - min * 60_000 - (min ? 5_000 : 0)).toISOString();

const runner = (id, name) => ({
  id, name, online: true, status: 'ONLINE', maxConcurrent: 4, activeSessions: 0, version: '0.1.215',
  capabilities: ['provider:dsh'], lastHeartbeatAt: ago(0), runsAsRoot: false,
  engines: [
    { engine: 'claude', installed: true, version: '2.3.1', auth: 'yes' },
    { engine: 'codex', installed: true, version: '0.80.0', auth: 'yes' },
    { engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { versionCompatible: true } },
  ],
});
const RUNNERS = [runner('34bRunnerWikova0000001', 'wikova'), runner('34bRunnerWorkst0000002', 'workstation'), runner('34bRunnerHPC000000003', 'HPC')];
const WORKSPACES = [
  { id: '34bWorkspaceOrbit00001', name: 'orbit', runnerId: RUNNERS[0].id, createdAt: ago(60 * 24 * 40), lastProvider: 'claude', position: 0, enabled: true },
  { id: '34bWorkspaceDevelop002', name: 'orbit-develop', runnerId: RUNNERS[2].id, createdAt: ago(60 * 24 * 40), lastProvider: 'claude', position: 1, enabled: true },
];

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1000000 },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1000000 },
];
const row = (o) => ({
  followsPreset: true, enabled: true, hasApiKey: true, defaultModel: null, models: [],
  poolRefusal: o.slug === 'anthropic' ? null : { reason: 'not-claude-subscription', message: 'Only Claude subscriptions can pool.' },
  ...o,
});
const ANTHROPIC = row({ id: '34bKeyAnthropic000001', slug: 'anthropic', label: 'Anthropic (Claude)', runtime: 'claude', presetSlug: 'anthropic',
  baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-4-8',
  models: [{ value: 'claude-opus-4-8', label: 'Claude Opus 4.8' }, { value: 'claude-sonnet-4-8', label: 'Claude Sonnet 4.8' }, { value: 'claude-haiku-4-6', label: 'Claude Haiku 4.6' }] });
const DEEPSEEK = row({ id: '34bKeyDeepSeek0000002', slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', presetSlug: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro' });
const HARNESS = row({ id: '34bKeyHarness00000003', slug: 'deepseek-harness', label: 'DeepSeek Harness', runtime: 'dsh', presetSlug: 'deepseek-harness',
  baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: '' });
const KIMI = row({ id: '34bKeyKimi00000000004', slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', presetSlug: 'moonshot',
  baseUrl: 'https://api.moonshot.ai/v1', models: [{ value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }], defaultModel: 'kimi-k2.7-code' });
const deepseekKey = (id, slug, label, extra = {}) => row({ id, slug, label, runtime: 'claude', presetSlug: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic', models: DEEPSEEK_MODELS, defaultModel: 'deepseek-v4-pro', ...extra });
const INTL = deepseekKey('34bKeyIntl00000000005', 'deepseek-2', 'DeepSeek Intl');
const TEAM = deepseekKey('34bKeyTeam00000000006', 'deepseek-3', 'DeepSeek Team');
const OLD = deepseekKey('34bKeyOldKey000000007', 'deepseek-4', 'DeepSeek Old key');
// A custom provider (no preset) on DeepSeek's own host is a DeepSeek key too.
const DIRECT = deepseekKey('34bKeyDirect000000008', 'deepseek-direct', 'DeepSeek Direct', { presetSlug: null, followsPreset: false });
const BUSY = deepseekKey('34bKeyBusy00000000009', 'deepseek-5', 'DeepSeek Busy');
const SLOW = deepseekKey('34bKeySlow00000000010', 'deepseek-6', 'DeepSeek Slow');

const SCENARIOS = { pair: [ANTHROPIC, DEEPSEEK, HARNESS, KIMI], states: [DEEPSEEK, INTL, TEAM, OLD, DIRECT, BUSY, SLOW] };
let scenario = 'pair';
const refreshed = new Map();

const CNY = { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' };
const USD = { currency: 'USD', totalBalance: '5.00', grantedBalance: '0.00', toppedUpBalance: '5.00' };
const ok = (balances, isAvailable, min, sharedWith = []) => (fetched) =>
  ({ ok: true, balances, isAvailable, fetchedAt: fetched ?? ago(min), sharedWith });
const failed = (reason, message, min) => (fetched) => ({ ok: false, reason, message, fetchedAt: fetched ?? ago(min), sharedWith: [] });
/** DeepSeek and DeepSeek Harness hold one key: one read on the server, so a refresh of either is both's. */
const SAME_KEY = [DEEPSEEK.id, HARNESS.id];
const BALANCES = {
  [DEEPSEEK.id]: (f) => ok([CNY], true, 2, scenario === 'pair' ? [{ id: HARNESS.id, label: 'DeepSeek Harness' }] : [])(f),
  [HARNESS.id]: ok([CNY], true, 2, [{ id: DEEPSEEK.id, label: 'DeepSeek' }]),
  [INTL.id]: ok([CNY, USD], true, 2),
  [TEAM.id]: ok([{ currency: 'CNY', totalBalance: '0.42', grantedBalance: '0.00', toppedUpBalance: '0.42' }], false, 0),
  [OLD.id]: failed('KEY_REJECTED', 'DeepSeek rejected this API key (401 Authentication Fails).', 0),
  [DIRECT.id]: failed('NETWORK', "Couldn't reach api.deepseek.com — the request timed out after 10 s. The key itself wasn't checked.", 1),
  [BUSY.id]: failed('UPSTREAM_ERROR', "DeepSeek answered 503 Server Overloaded. The key itself wasn't checked.", 0),
};

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(t));
    return;
  }
  console.log(new Date().toISOString(), req.method, url.pathname + url.search);
  if (url.pathname === '/__set') {
    scenario = url.searchParams.get('scenario') ?? scenario;
    refreshed.clear();
    return json(res, { scenario });
  }
  const balance = /^\/providers\/mine\/([^/]+)\/balance$/.exec(p);
  if (balance) {
    const id = balance[1];
    // Not answered while the page is photographed: it is still loading. Given up after 45 s.
    if (id === SLOW.id) return void setTimeout(() => json(res, { statusCode: 504, message: 'the fixture never answers this one' }, 504), 45_000);
    if (!BALANCES[id]) return json(res, { statusCode: 400, message: 'only a DeepSeek key has an account balance' }, 400);
    if (url.searchParams.get('refresh') === '1') {
      const now = new Date().toISOString();
      for (const other of SAME_KEY.includes(id) ? SAME_KEY : [id]) refreshed.set(other, now);
    }
    return json(res, BALANCES[id](refreshed.get(id)));
  }
  if (p === '/auth/setup-status') return json(res, { needsSetup: false });
  if (p === '/users/me') return json(res, { id: '34bUserOwner000000001', email: 'owner@example.com', name: 'Owner', createdAt: ago(60 * 24 * 90), preferences: {}, isAdmin: true, role: 'ADMIN' });
  if (p === '/runners') return json(res, RUNNERS);
  if (p === '/workspaces') return json(res, WORKSPACES);
  if (p === '/providers/mine') return json(res, SCENARIOS[scenario]);
  if (p === '/providers/presets') return json(res, {});
  if (p === '/providers/pools' || p === '/providers/shared-pools' || p.startsWith('/shared-pools')) return json(res, []);
  if (p === '/sessions/counts') return json(res, WORKSPACES.map((w) => ({ workspaceId: w.id, active: 0, running: 0, jobs: 0, approvals: 0, open: 3 })));
  if (p.startsWith('/tasks/evidence-decisions/pending')) return json(res, { decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
  if (p.startsWith('/tasks/page')) return json(res, { items: [], nextCursor: null });
  if (p.startsWith('/tasks')) return json(res, { items: [], total: 0, counts: {} });
  return json(res, []);
}).listen(PORT, '127.0.0.1', () => console.log('fake api on', PORT));
