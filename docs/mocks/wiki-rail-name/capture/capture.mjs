// Real-page shots of the Wiki rail's top for the "name only" board: today's production build, the
// repo's ui-migration fixtures, three wikis (as the owner's screenshot: a picker). The proposals are drawn
// over today's build at capture time (DOM removed, a style added). None of it is in the product.
//   DIST=<dist> FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n docs/mocks/wiki-rail-name/capture/run-ns.sh [scene ...]
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
  title: over.slug, repoUrlNorm: `github.com/example/${over.slug}`, rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } }, pendingOps: 0, planWaiting: 0, workspaceIds: [], docs: null, ...over,
});
const ORBIT = wiki({ id: FIXTURE_IDS.space, slug: 'orbit', title: 'orbit' });
const WIKIS = [wiki({ id: '1aaaaaaaaaaaaaaaaaaaa1', slug: 'cbai' }), ORBIT, wiki({ id: '1aaaaaaaaaaaaaaaaaaaa2', slug: 'wikova' })];

// The rail without the "Wiki" heading and the search line.
const nameOnly = (page) => page.evaluate(() => {
  document.querySelector('.wk-rail-head > .page-title')?.remove();
  document.querySelector('.wk-rail-top > .wk-search')?.remove();
});
// B: the name in the heading's own type, the picker drawn as the Tasks page's scope title (.tasks-scope-trigger).
const asTitle = async (page) => {
  await nameOnly(page);
  await page.addStyleTag({ content: `
    .wk-rail-head .wk-select, .wk-rail-head .wk-space-tag { height: auto; margin-left: -6px; padding: 2px 6px; gap: 6px; border: 0; border-radius: 6px;
      background: transparent; box-shadow: none; font-size: 20px; font-weight: 600; color: var(--text-1); max-width: none; }
    .wk-rail-head .wk-select .v { max-width: 190px; }
    .wk-rail-head .wk-select .ic.caret { position: static; font-size: 12px; color: var(--text-3); }
    .wk-rail-head .wk-select.b-hover { background: var(--bg-hover); }` });
};
const hover = (page) => page.evaluate(() => document.querySelector('.wk-rail-head .wk-select')?.classList.add('b-hover'));
const both = (...acts) => async (page) => { for (const act of acts) await act(page); };

const VP = { width: 1440, height: 900 };
const SCENES = {
  today: {},
  a: { act: nameOnly },
  b: { act: asTitle },
  'b-hover': { act: both(asTitle, hover) },
  'b-one': { act: asTitle, wikis: [ORBIT] },
  'today-dark': { theme: 'dark' },
  'b-dark': { act: asTitle, theme: 'dark' },
  'today-window': { clip: 'viewport' },
  'b-window': { act: asTitle, clip: 'viewport' },
  // A phone: the head row. Shot on a build, no drawing over it (today's main, or the change).
  phone: { vp: { width: 390, height: 844, isMobile: true }, clip: 'viewport', ready: '.wk-title-row' },
  'phone-one': { vp: { width: 390, height: 844, isMobile: true }, clip: 'viewport', ready: '.wk-title-row', wikis: [ORBIT] },
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
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}.png`;
  if (scene.clip === 'viewport') await page.screenshot({ path: file, animations: 'disabled' });
  else {
    // The rail's top, as the owner's screenshot frames it: the rail from the window's top to under its third row.
    const r = await page.evaluate(() => {
      const col = document.querySelector('.wk-dir-col').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.wk-dir-col .wk-toc-item')];
      const third = (rows[3] ?? rows.at(-1)).getBoundingClientRect();
      return { x: Math.max(0, col.x - 20), y: 0, width: col.width + 60, height: third.bottom + 8 };
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
