// Wiki Trash entry board: real sidebar frames from two builds (today, proto) over the ui-migration fixtures.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const B = '/var/tmp/wtrash';
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${B}/proto/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${B}/proto/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${B}/proto/src/shared/dist/index.js`);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
async function serve(dist) {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const SITES = { today: await serve(`${B}/dist-today`), proto: await serve(`${B}/dist-proto`) };
const id = (n) => uuidToBase62(`00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`);
const earlier = '2026-09-20T12:00:00.000Z';
const base = { rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier, pendingOps: 0,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } }, usage: { days: 7, sessionsPushed: 12, searches: 4, gets: 3, entries: [] } };
const wikova = { ...base, id: id(9101), slug: 'wikova', title: 'wikova', repoUrlNorm: 'github.com/example/wikova' };
const trash = { spaces: [
  { id: id(9201), slug: 'orbit-old', title: 'orbit-old', repoUrlNorm: null, deletedAt: '2026-09-25T08:00:00.000Z', purgeAt: '2027-09-25T08:00:00.000Z', entries: 412 },
  { id: id(9202), slug: 'scratch', title: 'scratch', repoUrlNorm: null, deletedAt: '2026-09-21T08:00:00.000Z', purgeAt: '2027-09-21T08:00:00.000Z', entries: 9 },
] };
const SCENES = {
  't-side': { build: 'today', path: '/wiki/orbit' },
  'p-side': { build: 'proto', path: '/wiki/orbit' },
  'p-menu': { build: 'proto', path: '/wiki/orbit', menu: 'wikova' },
  'settings': { build: 'proto', path: '/wiki/orbit/settings', settings: true },
  'dialog': { build: 'proto', path: '/wiki/orbit', menu: 'wikova', pick: 'Trash (2)' },
};
const VIEW = { width: 1080, height: 760 };
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const report = {}; const marks = {};
for (const [name, sc] of Object.entries(SCENES)) {
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  const fx = await installFixtures(page, { theme: 'light' });
  let spaceRow = null;
  await page.route('**/api/wiki/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (p === '/api/wiki/trash') return route.fulfill({ json: trash });
    if (p === '/api/wiki/spaces') {
      // the fixtures' one space, plus a second
      return route.fulfill({ json: [{ ...base, id: FIXTURE_IDS.space, slug: 'orbit', title: 'orbit', repoUrlNorm: 'github.com/example/orbit' }, wikova] });
    }
    return route.fallback();
  });
  await page.goto(`${SITES[sc.build].origin}${sc.path}`);
  try {
    await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30000 });
    await page.waitForSelector('.tp-group-wiki', { timeout: 20000 });
    await page.waitForTimeout(1500);
  } catch (e) { errors.push(String(e)); }
  await page.evaluate(() => document.fonts.ready);
  if (sc.menu) {
    const row = page.locator('.tp-group-wiki .tp-item', { hasText: sc.menu }).first();
    await row.click({ button: 'right' });
    await page.waitForSelector('[role="menuitem"]', { timeout: 10000 }).catch((e) => errors.push(String(e)));
    await page.waitForTimeout(400);
    if (sc.pick) { await page.locator('[role="menuitem"]', { hasText: sc.pick }).first().click(); await page.waitForTimeout(900); }
  }
  if (sc.settings) {
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.startsWith('Trash holds') && e.children.length < 3); el?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
  marks[name] = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); };
    return {
      group: box(document.querySelector('.tp-group-wiki')),
      trashRow: box(document.querySelector('.tp-wiki-trash')),
      item: box([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.startsWith('Trash ('))),
      menu: box(document.querySelector('[role="menu"]')),
      link: box([...document.querySelectorAll('button,a,span')].find((e) => /^Trash holds/.test(e.textContent ?? ''))),
      dialog: box(document.querySelector('[role="dialog"]')),
    };
  });
  report[name] = { errors, unhandled: [...new Set(fx.unhandled)].slice(0, 8) };
  await page.close();
}
await browser.close(); for (const { server } of Object.values(SITES)) server.close();
writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 1));
console.log(JSON.stringify(report, null, 1)); console.log(JSON.stringify(marks));
