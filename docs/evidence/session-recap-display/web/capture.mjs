// Real-UI captures of the recap change in the built web app (vite build of the session worktree), driven by Playwright
// over the repo's ui-migration fixtures with the session list and the opened session's detail answered here.
// Usage (in a private netns): node capture.mjs <out-dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const WT = '/root/.orbit/worktrees/01a15b62-6824-71bd-8386-7893a31ffa71';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, WORKSPACE, RUNNER } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);
const DIST = '/var/tmp/recap-web-dist';
const OUT = process.argv[2] || '/var/tmp/recap-web-shot/out';
fs.mkdirSync(OUT, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(5931, '127.0.0.1');

const TAG = { id: 'tag-performance', name: 'Performance', color: '#AF52DE', isSystem: false, position: 0 };
const recapped = {
  ...SESSION, title: 'Research other coding agents',
  recapText: 'Research done: integrate GitHub Copilot CLI first; Droid, CodeBuddy and Qoder next. Waiting on you to file the probe task.',
  recapAt: '2026-09-28T11:44:00.000Z', lastAssistantText: 'Next: shall I file a protocol probe task for Copilot CLI?', tags: [TAG],
};
const row = (n, title, extra) => ({ ...SESSION, id: `${SESSION.id.slice(0, -1)}${n}`, title, lastTurnAt: '2026-09-28T10:00:00.000Z', ...extra });
const LIST = [
  recapped,
  row('A', 'Disk space cleanup', { recapText: 'Deleted 10 old model repositories and freed 258G; 319G free. Next: clear 164 old worktrees.', recapAt: '2026-09-27T11:31:00.000Z', tags: [{ ...TAG, id: 'tag-hw', name: 'Hardware', color: '#007AFF' }] }),
  row('B', 'Drawer shadow fix', { lastAssistantText: 'Fixed the drawer shadow on iPad; web and iOS are merged.' }),
  row('C', 'Rebuilding the transcript page', { status: 'RUNNING', runState: 'RUNNING', lastToolUse: 'Bash', recapText: 'An older recap that the running line outranks.', recapAt: '2026-09-28T09:00:00.000Z' }),
];

const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache'] });
async function shoot(name, { theme, width, height, mobile }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await context.newPage();
  await installFixedDate(page);
  const fixtures = await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const p = pathname.replace(/^\/api/, '');
    if (route.request().method() === 'GET' && p === '/sessions') return route.fulfill({ status: 200, json: LIST });
    if (route.request().method() === 'GET' && p === `/sessions/${SESSION.id}`) return route.fulfill({ status: 200, json: recapped });
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:5931/sessions/${SESSION.id}`);
  await page.waitForSelector('.chat-recap', { timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
  const lines = await page.$$eval('.session-row .session-preview', (els) => els.map((e) => e.textContent));
  const tags = await page.$$eval('.session-row', (els) => els.map((e) => e.textContent).filter((t) => /Performance|Hardware/.test(t)));
  const card = await page.$eval('.chat-recap', (e) => e.textContent);
  console.log(JSON.stringify({ name, lines, rowsMentioningTags: tags.length, card, unhandled: fixtures?.unhandled?.length ?? null }));
  await context.close();
}
try {
  await shoot('desktop-light', { theme: 'light', width: 1440, height: 900 });
  await shoot('desktop-dark', { theme: 'dark', width: 1440, height: 900 });
  await shoot('phone-light', { theme: 'light', width: 390, height: 844, mobile: true });
} finally {
  await browser.close();
  server.close();
}
