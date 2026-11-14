// Real-page shots of the Wiki's space menu for its board: the production build of the working tree (the proposal as
// code), the repo's ui-migration fixtures, three wikis as the owner's 11-14 screenshot (orbit with 2 waiting). Option A
// (one line a row) is the same build with the second line hidden at capture time.
//   DIST=<dist> FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n docs/mocks/wiki-space-menu/capture/run-ns.sh [scene ...]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? path.resolve(HERE, '../shots');
const W = path.resolve(HERE, '../../../..');
const FONTS = process.env.FONTCONFIG_FILE ?? '/mnt/data/pe-mock/fonts.conf';
const ONLY = process.argv.slice(2);

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);

const earlier = '2026-09-27T10:00:00.000Z';
const wiki = (over) => ({
  title: over.slug, repoUrlNorm: `github.com/wikova/${over.slug}`, rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } }, pendingOps: 0, planWaiting: 0, workspaceIds: [], docs: null, ...over,
});
const ORBIT = wiki({ id: FIXTURE_IDS.space, slug: 'orbit', title: 'orbit', docs: { written: 30, total: 35 }, pendingOps: 1, planWaiting: 1 });
const WIKIS = [ORBIT, wiki({ id: '1aaaaaaaaaaaaaaaaaaaa2', slug: 'wikova', docs: { written: 5, total: 12 } }),
  wiki({ id: '1aaaaaaaaaaaaaaaaaaaa1', slug: 'cbai' })];

const open = (page) => page.locator('.wk-name-title .wk-select:visible').first().click();
const oneLine = (page) => page.addStyleTag({ content: '.wk-space-row-text .s { display: none; } .wk-space-menu .orbit-menu-item { align-items: center; padding-top: 5px; padding-bottom: 5px; } .wk-space-menu .orbit-menu-icon { padding-top: 0; }' });
const hoverRow = (n) => (page) => page.locator('.wk-space-menu .orbit-menu-item').nth(n).hover();
const both = (...acts) => async (page) => { for (const act of acts) await act(page); };
const PHONE = { width: 390, height: 844, isMobile: true };

const VP = { width: 1440, height: 900 };
const SCENES = {
  b: { act: open },
  'b-hover': { act: both(open, hoverRow(1)) },
  a: { act: both(oneLine, open) },
  'b-dark': { act: open, theme: 'dark' },
  'b-phone': { vp: PHONE, ready: '.wk-title-row', act: open, clip: 'viewport' },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const DIST = process.env.DIST;
const server = http.createServer((req, res) => {
  let file = path.join(DIST, new URL(req.url, 'http://x').pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function shoot(browser, name) {
  const scene = SCENES[name];
  const theme = scene.theme ?? 'light';
  const { isMobile, ...viewport } = scene.vp ?? VP;
  const context = await browser.newContext({ viewport, isMobile: !!isMobile, hasTouch: !!isMobile, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && where === '/api/wiki/spaces') return route.fulfill({ status: 200, json: scene.wikis ?? WIKIS });
    return route.fallback();
  });
  await page.goto(`${base}/wiki/orbit`);
  await page.waitForFunction(() => !document.getElementById('boot'));
  if (scene.ready) await page.locator(scene.ready).first().waitFor();
  else await page.waitForFunction(() => document.querySelector('.wk-rail-head .wk-select, .wk-rail-head .wk-space-tag') && document.querySelector('.wk-dir-col .wk-toc-item'));
  if (scene.act) await scene.act(page);
  if (scene.clip === 'viewport') { await page.locator('.wk-space-menu').waitFor(); await page.waitForTimeout(300); }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}.png`;
  if (scene.clip === 'viewport') await page.screenshot({ path: file, animations: 'disabled' });
  else {
    // The rail's top and the open menu over it.
    await page.locator('.wk-space-menu').waitFor();
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const col = document.querySelector('.wk-dir-col').getBoundingClientRect();
      const menu = document.querySelector('.wk-space-menu').getBoundingClientRect();
      return { x: Math.max(0, col.x - 20), y: 0, width: Math.max(col.width + 60, menu.right - col.x + 60), height: menu.bottom + 90 };
    });
    await page.screenshot({ path: file, clip: r, animations: 'disabled' });
  }
  await context.close();
  console.log(JSON.stringify({ scene: name, errors, unhandled: api.unhandled }));
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: FONTS }, args: ['--disable-features=BackForwardCache'] });
for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) await shoot(browser, name);
await browser.close();
server.close();
