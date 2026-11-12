// today vs proto frames of a session message card. Writes shots/<tree>-<scene>[-open][-phone].png + boxes.json.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { eventsFor, SCENES } from './data.mjs';
const K = '/var/tmp/smc-attached';
const WT = `${K}/today`;
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXED_NOW } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);
const OUT = `${K}/shots`; mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const PORTS = {};
const serve = (tree) => new Promise((resolve) => {
  const dir = `${K}/dist-${tree}`;
  const s = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let body, type;
    try { body = await readFile(join(dir, p)); type = TYPES[extname(p)] ?? 'application/octet-stream'; }
    catch { body = await readFile(join(dir, 'index.html')); type = 'text/html'; }
    res.writeHead(200, { 'Content-Type': type }); res.end(body);
  });
  s.listen(0, '127.0.0.1', () => { PORTS[tree] = s.address().port; resolve(s); });
});
const session = { ...SESSION, title: 'Coordinator: Optimize job alerts', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN', engineTurnActive: false, lastTurnAt: FIXED_NOW, updatedAt: FIXED_NOW };
const rect = (loc) => loc.evaluate((el) => el.getBoundingClientRect().toJSON());
const boxes = {};
async function shot(browser, tree, key, { open = false, phone = false } = {}) {
  const width = phone ? 390 : 1280;
  const context = await browser.newContext({ viewport: { width, height: 1400 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US',
    timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block', hasTouch: phone, isMobile: phone });
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page); await installFixtures(page, { theme: 'dark' });
  const list = eventsFor(key);
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const p = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    const json = (b) => route.fulfill({ status: 200, json: b });
    if (p === `/api${SESSION_PATH}`) return json(session);
    if (p === `/api${SESSION_PATH}/events/page`) return json({ events: list, hasMore: false });
    if (p === '/api/sessions') return json([session]);
    return route.fallback();
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORTS[tree]}${SESSION_PATH}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  const card = page.locator('.smc').first(); await card.waitFor(); await page.waitForTimeout(600);
  if (open) { const h = page.locator('.smc .chat-injected-head').first(); if (await h.count()) { await h.click(); await page.waitForTimeout(300); } }
  await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
  const c = await rect(card);
  const ans = await rect(page.locator('.chat-assistant').first());
  const pad = phone ? 8 : 16;
  const clip = { x: c.x - pad, y: c.y - pad, width: c.width + 2 * pad, height: Math.min(ans.bottom, ans.y + 80) - c.y + 2 * pad };
  const name = `${tree}-${key}${open ? '-open' : ''}${phone ? '-phone' : ''}`;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  const b = { clip };
  for (const [k, sel] of Object.entries({ meta: '.smc-meta', note: '.smc .chat-injected', head: '.smc .chat-injected-head', panel: '.smc .chat-injected-panel', narrower: '.smc-narrower' })) {
    const l = page.locator(sel).first(); if (!(await l.count())) continue;
    const r = await rect(l); b[k] = { x: r.x - clip.x, y: r.y - clip.y, w: r.width, h: r.height };
  }
  boxes[name] = b;
  if (errors.length) console.log(name, errors);
  await context.close();
}
const servers = await Promise.all(['today', 'proto'].map(serve));
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/44-repo-tiers/fonts.conf' } });
try {
  for (const tree of ['today', 'proto']) for (const key of Object.keys(SCENES)) {
    await shot(browser, tree, key); await shot(browser, tree, key, { open: true });
  }
  await shot(browser, 'today', 'plain', { phone: true }); await shot(browser, 'proto', 'plain', { phone: true });
} finally {
  writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 1));
  await browser.close(); servers.forEach((s) => s.close());
}
console.log('done', Object.keys(boxes).length);
