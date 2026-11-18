// Real web frames for docs/mocks/task-link-in-place (2026-11-12): today's build and the prototype,
// over the ui-migration fixtures, with a conversation whose reply names a project's task.
// RUN: FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node capture.mjs <outDir>
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const B = '/var/tmp/tlip', TREE = `${B}/proto`, OUT = process.argv[2] ?? '/mnt/data/tmp/tlip-kit/out';
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const fx = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const sf = await import(`${TREE}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${TREE}/src/shared/dist/index.js`);
const id = (s) => uuidToBase62(`0196e000-0000-7000-8000-${s.padStart(12, '0')}`);
const TASK = id('112'), PROJECT = fx.FIXTURE_IDS.project;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
async function serve(dist) {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
const SITES = { today: await serve(`${B}/dist-today`), proto: await serve(`${B}/dist-proto`) };
const T0 = sf.SESSION_TIME, TURN = id('41');
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'Where does the browser baseline work stand?' }, turnId: TURN, ts: T0 },
  { seq: 2, type: 'assistant', payload: { text: `The inventory is done. I filed [Capture browser baselines](orbit-task:${TASK}) under [Orbit UI migration](orbit-project:${PROJECT}); it is ready to run, and **Migrate shared controls** waits on it.\n\nNext I will check the composer's keyboard behaviour against the baseline.` }, turnId: TURN, ts: T0 },
  { seq: 3, type: 'turn_end', payload: {}, turnId: TURN, ts: T0 },
];
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', ignoreDefaultArgs: ['--hide-scrollbars'] });
const marks = {};
async function scene(name, build, { width = 1600, height = 960, steps }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await fx.installFixedDate(page);
  const f = await fx.installFixtures(page, {});
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === `/api${sf.SESSION_PATH}/events/page`) return route.fulfill({ json: { events: EVENTS, hasMore: false } });
    if (p.startsWith('/api/link-preview') || p.startsWith('/api/links')) return route.fulfill({ status: 404, json: {} });
    return route.fallback();
  });
  await page.goto(SITES[build] + sf.SESSION_PATH);
  await page.getByText('The inventory is done').waitFor();
  await page.waitForTimeout(600);
  await steps(page, async (shot, sel) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${name}-${shot}.png` });
    const boxes = {};
    for (const [k, s] of Object.entries(sel ?? {})) boxes[k] = await page.locator(s).first().boundingBox().catch(() => null);
    marks[`${name}-${shot}`] = { url: page.url().replace(SITES[build], ''), w: width, h: height, boxes };
  });
  if (f.unhandled.length) console.log(name, 'unhandled', [...new Set(f.unhandled)].join(' | '));
  await ctx.close();
}
const link = (p) => p.locator('a', { hasText: 'Capture browser baselines' }).first();
for (const build of ['today', 'proto']) {
  await scene(build, build, { steps: async (p, shot) => {
    await shot('1-session', { link: 'a:has-text("Capture browser baselines")' });
    await link(p).click();
    await p.locator('.task-detail-panel').first().waitFor();
    await shot('2-open', { panel: '.task-detail-panel', projectLine: '.tdp-project-line a', close: '.task-detail-panel button[aria-label="Close"]' });
    await p.locator('.task-detail-panel [aria-label="Close"]').first().click();
    await p.waitForTimeout(400);
    await shot('3-closed', {});
  } });
}
await scene('proto-phone', 'proto', { width: 430, height: 900, steps: async (p, shot) => {
  await shot('1-session', { link: 'a:has-text("Capture browser baselines")' });
  await link(p).click();
  await p.locator('.task-detail-panel').first().waitFor();
  await shot('2-open', { close: '.task-detail-panel button[aria-label="Close"]' });
  await p.goBack(); await p.waitForTimeout(400);
  await shot('3-back', {});
} });
writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 1));
await browser.close(); process.exit(0);
