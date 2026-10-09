// Screenshot /infrastructure against browser-side API fixtures shaped like
// docs/mocks/infrastructure-page/02-after-infrastructure.png.
// Usage: node shot.cjs <webDir> <baseUrl> <out.png> [theme] [width] [signin] [scale]
//   webDir: src/web of the checkout (Playwright is resolved from there); baseUrl: a running
//   `npx vite` of it. `signin` opens the in-place sign-in under the first signed-out line and
//   captures the top of the page.
const [webDir, base, out, theme = 'light', width = '1440', signin = '', scale = '1'] = process.argv.slice(2);
const { chromium } = require(require.resolve('@playwright/test', { paths: [webDir] }));

// Public ids as the app holds them (base62 of a UUID), without importing the shared TS source.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const id = (n) => {
  let v = BigInt('0x' + `0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`.replace(/-/g, ''));
  let s = '';
  while (v > 0n) { s = ALPHABET[Number(v % 62n)] + s; v /= 62n; }
  return s;
};
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MAC = id(31), HPC = id(32), THINKPAD = id(33), USER = id(40), POOL = id(90);
const google = { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'available' };
const runners = [
  { id: MAC, name: 'Mac Studio', online: true, activeSessions: 2, maxConcurrent: 4, hostname: 'mac-studio.local', version: '0.1.240',
    lastHeartbeatAt: iso(NOW - 20_000), position: 0, antigravity: google, capabilities: [],
    engines: [
      { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4 (Claude Code)', accounts: [
        { id: 'default', name: 'Personal Max', home: '/Users/me/.orbit/default', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/Users/me/.orbit/slot-2', auth: 'yes' } ] },
      { engine: 'codex', installed: true, auth: 'no', version: 'codex-cli 0.160.0' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ] },
  { id: HPC, name: 'HPC', online: true, activeSessions: 5, maxConcurrent: 8, hostname: 'hpc-01', version: '0.1.240',
    lastHeartbeatAt: iso(NOW - 10_000), position: 1, antigravity: google, capabilities: [],
    engines: [
      { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4 (Claude Code)' },
      { engine: 'codex', installed: true, auth: 'yes', version: 'codex-cli 0.160.0', accounts: [
        { id: 'default', home: '/root/.codex', auth: 'yes' }, { id: 'slot-2', name: 'Team', home: '/root/.orbit/codex-2', auth: 'yes' } ] },
      { engine: 'kimi', installed: true, auth: 'yes', version: '1.4.0' },
    ] },
  { id: THINKPAD, name: 'ThinkPad', online: false, activeSessions: 0, maxConcurrent: 3, hostname: 'thinkpad', version: '0.1.231',
    lastHeartbeatAt: iso(NOW - 26 * 3600_000), position: 2, capabilities: [],
    engines: [ { engine: 'claude', installed: true, auth: 'yes' }, { engine: 'codex', installed: true, auth: 'no' }, { engine: 'kimi', installed: true, auth: 'yes' } ] },
];
const claudeModels = [ { value: 'claude-opus-5', label: 'Claude Opus 5' }, { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' } ];
const key = (n, label, over = {}) => ({ id: id(100 + n), slug: `key-${n}`, label, runtime: 'claude', baseUrl: 'https://api.anthropic.com',
  models: claudeModels, defaultModel: 'claude-opus-5', presetSlug: 'anthropic', followsPreset: true, enabled: true, hasApiKey: true, poolRefusal: null, ...over });
const keys = [
  key(1, 'Anthropic (Claude)'),
  key(2, 'Anthropic · Work', { defaultModel: 'claude-sonnet-5' }),
  key(3, 'DeepSeek', { baseUrl: 'https://api.deepseek.com/anthropic', presetSlug: 'deepseek',
    poolRefusal: { reason: 'NOT_ANTHROPIC_ENDPOINT', message: 'Endpoint is not api.anthropic.com' },
    models: [ { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' } ], defaultModel: 'deepseek-v4-pro' }),
];
const member = (k, over = {}) => ({ id: k.id, slug: k.slug, label: k.label, presetSlug: k.presetSlug, enabled: true, planUsage: null, state: 'NO_QUOTA', resetsAt: null, next: false, ...over });
const pools = [ { id: POOL, slug: 'claude-keys', label: 'Claude keys', engine: 'claude', resetsAt: null, unavailable: null,
  members: [ member(keys[0], { next: true }), member(keys[1]) ] } ];
const workspaces = [
  { id: id(21), name: 'orbit', createdAt: iso(NOW - 9e8), position: 0, runnerId: MAC, runner: { id: MAC, name: 'Mac Studio' } },
  { id: id(22), name: 'orbit-develop', createdAt: iso(NOW - 8e8), position: 1, runnerId: HPC, runner: { id: HPC, name: 'HPC' } },
];
const me = { id: USER, name: 'Wikova', email: 'wikova@example.test', createdAt: iso(NOW - 9e9), avatarUpdatedAt: null, role: 'MEMBER',
  preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(width), height: 1700 }, deviceScaleFactor: Number(scale) });
  await page.addInitScript(({ user, theme, mac }) => {
    localStorage.clear();
    localStorage.setItem('orbit_token', `shot.${btoa(JSON.stringify({ sub: user, exp: 4102444800 }))}.fixture`);
    localStorage.setItem('orbit-theme', theme);
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([mac]));
  }, { user: USER, theme, mac: MAC });
  const unknown = new Set();
  await page.route('**/dl/version.json', (r) => r.fulfill({ status: 200, json: { version: '0.1.240' } }));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (p === '/api/events' || p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\nretry: 3600000\n\n' });
    if (m !== 'GET') { unknown.add(`${m} ${p}`); return json({}); }
    if (p === '/api/users/me') return json(me);
    if (p === '/api/auth/setup-status') return json({ needsSetup: false });
    if (p === '/api/runners') return json(runners);
    if (p === '/api/workspaces') return json(workspaces);
    if (p === '/api/providers/mine') return json(keys);
    if (p === '/api/providers/pools') return json(pools);
    if (p === '/api/providers/shared-pools') return json([]);
    if (p === '/api/providers') return json([]);
    if (/\/api\/runners\/[^/]+\/login$/.test(p)) return json({ status: null, engine: null, url: null, userCode: null, message: null, account: null });
    if (p === '/api/tasks/counts') return json({ total: 0, open: 0, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: 0 });
    if (p === '/api/tasks/active') return json({ items: [], total: 0, truncated: false });
    if (p === '/api/tasks/labels') return json({ items: [], labelTotal: 0, truncated: false });
    unknown.add(`${m} ${p}`);
    return json([]);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/infrastructure`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.infra-engines', { timeout: 30_000 });
  await page.waitForTimeout(800);
  if (signin === 'signin') {
    await page.locator('.infra-attn-row', { hasText: 'is signed out on' }).getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: Number(width), height: 900 } });
  } else {
    await page.screenshot({ path: out, fullPage: true });
  }
  console.log(JSON.stringify({ out, unknown: [...unknown], errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
