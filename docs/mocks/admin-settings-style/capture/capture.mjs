// Real web frames for docs/mocks/admin-settings-style: today's /admin pages and the prototype (Admin drawn
// as Settings), over the repo's ui-migration fixtures plus sample admin data. Writes <OUT>/<build>-<scene>.png
// and <OUT>/boxes.json.  RUN: node capture.mjs <outDir> [scene,scene]
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const K = '/var/tmp/admin-mock';
const TREE = `${K}/proto`;
const OUT = process.argv[2] ?? `${K}/shots`;
const ONLY = (process.argv[3] ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXED_NOW, FIXTURE_IDS } = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${TREE}/src/shared/dist/index.js`);
const uid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const ago = (ms) => new Date(now - ms).toISOString();
const H = 3600e3, DAY = 24 * H;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
async function serve(dist) {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const SITES = { today: await serve(`${K}/dist-today`), proto: await serve(`${K}/dist-proto`) };

const methods = (password, google) => ({ password, google: google ? { email: google } : null });
const USERS = [
  { id: FIXTURE_IDS.user, email: 'reviewer@example.test', name: 'Baseline Reviewer', role: 'ADMIN', createdAt: ago(200 * DAY),
    signInMethods: methods(true, 'reviewer@example.test'), disabledAt: null, lastActive: { at: ago(2 * 60e3), via: 'WEB' }, avatarUpdatedAt: null, welcomeEmail: null },
  { id: uid(41), email: 'mei.chen@example.test', name: 'Mei Chen', role: 'ADMIN', createdAt: ago(160 * DAY),
    signInMethods: methods(true, null), disabledAt: null, lastActive: { at: ago(3 * H), via: 'IOS' }, avatarUpdatedAt: null, welcomeEmail: null },
  { id: uid(42), email: 'sam.ortiz@example.test', name: 'Sam Ortiz', role: 'MEMBER', createdAt: ago(90 * DAY),
    signInMethods: methods(false, 'sam.ortiz@example.test'), disabledAt: null, lastActive: { at: ago(1 * DAY), via: 'MACOS' }, avatarUpdatedAt: null,
    welcomeEmail: { status: 'SENT', lastError: null, lastAttemptAt: ago(90 * DAY), updatedAt: ago(90 * DAY) } },
  { id: uid(43), email: 'priya.n@example.test', name: 'Priya Nair', role: 'MEMBER', createdAt: ago(30 * DAY),
    signInMethods: methods(true, null), disabledAt: null, lastActive: { at: ago(6 * DAY), via: 'CLI' }, avatarUpdatedAt: null,
    welcomeEmail: { status: 'FAILED', lastError: 'Domain not verified', lastAttemptAt: ago(30 * DAY), updatedAt: ago(30 * DAY) } },
  { id: uid(44), email: 'jonas.weber@example.test', name: 'Jonas Weber', role: 'MEMBER', createdAt: ago(12 * DAY),
    signInMethods: methods(false, null), disabledAt: null, lastActive: null, avatarUpdatedAt: null,
    welcomeEmail: { status: 'SENT', lastError: null, lastAttemptAt: ago(12 * DAY), updatedAt: ago(12 * DAY) } },
  { id: uid(45), email: 'old.contractor@example.test', name: 'Alex Kim', role: 'MEMBER', createdAt: ago(300 * DAY),
    signInMethods: methods(true, null), disabledAt: ago(40 * DAY), lastActive: { at: ago(45 * DAY), via: 'WEB' }, avatarUpdatedAt: null, welcomeEmail: null },
];
const GOOGLE = { enabled: true, clientId: '1234567890-abc.apps.googleusercontent.com', hasSecret: true, secretUnreadable: false,
  signupPolicy: 'EXISTING_ACCOUNTS', redirectUri: 'https://orbit.example.com/api/auth/google/callback' };
const EMAIL = { enabled: true, hasApiKey: true, apiKeyUnreadable: false, fromAddress: 'Orbit <orbit@example.com>', replyTo: '',
  replyToDefault: 'reviewer@example.test', welcomeEnabled: true, on: true, missing: [],
  lastWeek: { sent: 14, failed: 1, failures: [{ email: 'priya.n@example.test', at: ago(2 * DAY), error: 'Domain not verified' }] } };
const FEISHU = { allowed: true, connectedApps: 3, enabledApps: 2 };

let THEME = 'light';
async function routes(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (request.method() !== 'GET') return route.fallback();
    if (p === '/api/users/me') {
      return json({ id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: USERS[0].createdAt,
        avatarUpdatedAt: null, role: 'ADMIN', preferences: { theme: THEME, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } });
    }
    if (p === '/api/admin/users') return json(USERS);
    if (p === '/api/admin/sign-in/google') return json(GOOGLE);
    if (p === '/api/admin/email') return json(EMAIL);
    if (p === '/api/admin/integrations/feishu') return json(FEISHU);
    if (p === '/api/auth/methods') return json({ password: true, google: true, googleSignup: false });
    if (p.startsWith('/api/admin/avatar') || p.match(/^\/api\/users\/[^/]+\/avatar/)) return route.fulfill({ status: 404, body: '' });
    return route.fallback();
  });
}

const SCENES = [
  { name: 'users', build: ['today', 'proto'], url: '/admin' },
  { name: 'signin', build: ['today', 'proto'], url: '/admin/sign-in' },
  { name: 'email', build: ['today', 'proto'], url: '/admin/email', tall: true },
  { name: 'integrations', build: ['today', 'proto'], url: '/admin/integrations' },
  { name: 'settings', build: ['today'], url: '/settings/notifications' },
  { name: 'signin-dark', build: ['proto'], url: '/admin/sign-in', theme: 'dark' },
  { name: 'phone', build: ['proto'], url: '/admin/sign-in', phone: true },
];

const browser = await chromium.launch({
  executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome',
  ignoreDefaultArgs: ['--hide-scrollbars'], timeout: 300000,
  env: { ...process.env, FONTCONFIG_FILE: `${K}/fonts.conf` },
});
const boxes = existsSync(`${OUT}/boxes.json`) ? JSON.parse(readFileSync(`${OUT}/boxes.json`, 'utf8')) : {};
for (const scene of SCENES) {
  if (ONLY.length && !ONLY.includes(scene.name)) continue;
  for (const build of scene.build) {
    const vp = scene.phone ? { width: 393, height: 852 } : { width: 1440, height: scene.tall ? 1100 : 900 };
    const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai', locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(240000);
    await installFixedDate(page);
    await installFixtures(page, { theme: scene.theme ?? 'light' });
    THEME = scene.theme ?? 'light';
    await routes(page);
    await page.goto(SITES[build] + scene.url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => document.fonts.ready);
    const key = `${build}-${scene.name}`;
    await page.screenshot({ path: `${OUT}/${key}.png` });
    boxes[key] = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); };
      return { nav: r('.settings-nav') ?? r('.admin-nav'), column: r('.settings-column') ?? r('.admin-page'), sidebar: r('aside.app-nav') };
    });
    console.log(key, JSON.stringify(boxes[key]));
    await context.close();
  }
}
writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 1));
await browser.close();
process.exit(0);
