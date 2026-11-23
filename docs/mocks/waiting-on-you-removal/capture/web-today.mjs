// Today's web, on main's real production build (DIST) + the repo's ui-migration fixtures, with the terminal
// reads layered on top. usage: FONTCONFIG_FILE=... unshare -n bash -c 'ip link set lo up && node today.mjs [scene...]'
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const W = process.env.W ?? '/mnt/data/tb-main';
const DIST = process.env.DIST ?? '/mnt/data/tb-dist';
const OUT = process.env.OUT ?? '/mnt/data/tb-shots/out';
const ONLY = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { RUNNER, SESSION } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);

const NOW = Date.parse(FIXED_NOW);
const MIN = 60_000;
const at = (ms) => new Date(NOW + ms).toISOString();
const LAPTOP = { ...RUNNER, name: 'dev-laptop', displayName: 'dev-laptop' };
const req = (id, machineName, code, askedMin) => ({ id, userCode: code, machineName, runnerId: LAPTOP.id, createdAt: at(-askedMin * MIN), expiresAt: at((10 - askedMin) * MIN) });
const ONE = { requests: [req('tl1', 'dev-laptop', '7KQ-4MZ', 3)] };
const TWO = { requests: [req('tl1', 'dev-laptop', '7KQ-4MZ', 3), req('tl2', 'dev-laptop', 'R2T-9PX', 1)] };
const TERMS = { terminals: [{ id: 't1', machineName: 'dev-laptop', runnerId: LAPTOP.id, createdAt: at(-3 * 86400e3), approvedAt: at(-3 * 86400e3), lastUsedAt: at(-2 * 3600e3), expiresAt: at(27 * 86400e3) }] };
const base = { '/api/runners': [LAPTOP], '/api/terminals': TERMS };

const SCENES = {
  // The inbox's Open tab: the card heads it.
  'web-today-inbox-one': { path: '/waiting', reads: { ...base, '/api/terminals/requests': ONE }, ready: '[data-kind="TERMINAL"]', vp: { width: 1280, height: 760 } },
  'web-today-inbox-two': { path: '/waiting', reads: { ...base, '/api/terminals/requests': TWO }, ready: '[data-kind="TERMINAL"]', vp: { width: 1280, height: 900 } },
  // Deny / Approve pressed on a request that expired under the open page: main's answer.
  'web-today-inbox-expired': {
    path: '/waiting', reads: { ...base, '/api/terminals/requests': ONE }, ready: '[data-kind="TERMINAL"]', vp: { width: 1280, height: 860 },
    post: { status: 404, json: { statusCode: 404, message: 'terminal sign-in not found or expired — run `orbit` in the terminal again' } },
    act: async (page) => { await page.getByRole('button', { name: 'Approve' }).first().click(); await page.waitForSelector('.owner-request-card [role="alert"], .owner-request-card .ui-alert, .owner-request-card [class*="alert"]'); },
  },
  // The machine's own page in Settings, today: no terminal requests on it.
  'web-today-machine': { path: `/settings/machines/${LAPTOP.id}`, reads: { ...base, '/api/terminals/requests': ONE }, ready: 'main, .settings-layout', vp: { width: 1280, height: 900 }, wait: 2500 },
  // Settings → Terminals.
  'web-today-terminals': { path: '/settings/terminals', reads: { ...base, '/api/terminals/requests': ONE }, ready: 'main, .settings-layout', vp: { width: 1280, height: 640 }, wait: 1500 },
  // The session page and its list, with a terminal waiting: nothing there says so today.
  'web-today-session': { path: `/sessions/${SESSION.id}`, reads: { ...base, '/api/terminals/requests': ONE }, ready: '.session-row, .workspace-sessions', vp: { width: 1280, height: 800 }, wait: 2500 },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, res) => {
  const url = new URL(q.url, 'http://127.0.0.1');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(5766, '127.0.0.1', r));

const browser = await chromium.launch({ env: { ...process.env }, args: ['--disable-features=BackForwardCache'] });
try {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const context = await browser.newContext({ viewport: scene.vp, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installFixedDate(page);
    const api = await installFixtures(page, { theme: 'light' });
    await page.route('**/api/**', async (route) => {
      const r = route.request();
      const where = new URL(r.url()).pathname;
      if (r.method() === 'POST' && scene.post && where.startsWith('/api/terminals/requests/')) return route.fulfill(scene.post);
      if (r.method() === 'GET' && Object.hasOwn(scene.reads, where)) return route.fulfill({ status: 200, json: scene.reads[where] });
      return route.fallback();
    });
    try {
      await page.goto('http://127.0.0.1:5766' + scene.path);
      await page.locator(scene.ready).first().waitFor();
      await page.waitForFunction(() => !document.getElementById('boot'));
      if (scene.act) await scene.act(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(scene.wait ?? 700);
      await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
      console.log(JSON.stringify({ name, errors, unhandled: api.unhandled, text: (await page.locator('body').innerText()).slice(0, 400) }));
    } catch (e) {
      await page.screenshot({ path: `${OUT}/${name}-FAILED.png` }).catch(() => {});
      console.log(JSON.stringify({ name, failed: String(e.message).slice(0, 300), unhandled: api.unhandled }));
      process.exitCode = 1;
    }
    await context.close();
  }
} finally { await browser.close(); server.close(); }
