// The other-session message card, today vs the bubble proposal, on a real coordinator replay.
// unshare -n ./run-ns2.sh smc-bubble.mjs [scene-prefix]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { launch, settle } from '/var/tmp/coord-fold-mock/lib.mjs';
import { installFixtures, installFixedDate } from '/var/tmp/coord-fold-mock/cur/src/web/ui-migration/fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE, RUNNER } from '/var/tmp/coord-fold-mock/cur/src/web/ui-migration/session-fixtures.mjs';

const D = '/mnt/data/tmp/webdeploy-exfold';
const OUT = '/var/tmp/coord-fold-mock/shots/smc-bubble';
mkdirSync(OUT, { recursive: true });
const events = gunzipSync(readFileSync(`${D}/exfold-01a1bf6f-0ae9-7448-abaf-26b60407437c.jsonl.gz`)).toString('utf8').trim().split('\n').map((l) => {
  const e = JSON.parse(l);
  return { seq: e.seq, type: e.type, payload: e.payload, ts: e.ts, turnId: e.turnId ?? undefined };
});
const title = 'Runner 链路加固：假断线警报、自动升级与搁置问题';
const ws = { ...WORKSPACE, name: 'orbit-develop' };
const row = { ...SESSION, workspace: ws, workspaceId: ws.id, pendingApprovals: 0, engineTurnActive: false, status: 'IDLE', runState: 'IDLE', lifecycleState: 'OPEN', pinnedAt: null, provider: 'claude', tags: [], folderId: null, shared: false, lastUserText: null, lastAssistantText: null, lastTurnAt: events.at(-1).ts, updatedAt: events.at(-1).ts, title };
const BASE = { cur: 'http://127.0.0.1:5874', prop: 'http://127.0.0.1:5875' };
const SCENES = [
  // [name, tree, width, height, dsf, seq, theme]
  ['cur-desktop', 'cur', 2000, 1000, 1, 64, 'dark'],
  ['prop-desktop', 'prop', 2000, 1000, 1, 64, 'dark'],
  ['prop-desktop-short', 'prop', 2000, 1000, 1, 616, 'dark'],
  ['cur-phone', 'cur', 390, 844, 2, 64, 'dark'],
  ['prop-phone', 'prop', 390, 844, 2, 64, 'dark'],
];
const only = process.argv[2];
const browser = await launch();
const boxes = {};
for (const [name, tree, W, H, dsf, seq, theme] of SCENES) {
  if (only && !name.startsWith(only)) continue;
  const phone = W < 500;
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dsf, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(900_000); page.setDefaultNavigationTimeout(900_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (path === `/api${SESSION_PATH}/events/page`) return route.fulfill({ status: 200, json: { events, hasMore: false } });
    if (path === `/api${SESSION_PATH}`) return route.fulfill({ status: 200, json: row });
    if (path === '/api/sessions') return route.fulfill({ status: 200, json: [row] });
    if (path === '/api/runners') return route.fulfill({ status: 200, json: [{ ...RUNNER, name: 'HPC' }] });
    if (path === '/api/workspaces') return route.fulfill({ status: 200, json: [ws] });
    if (path.includes('/session-requests/')) return route.fulfill({ status: 200, json: { requestId: path.split('/').pop(), state: 'REPLIED', fromSessionId: 'x', fromTitle: 'x', toSessionId: 'y', toTitle: 'y', requestPreview: '' } });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE[tree] + SESSION_PATH);
  await page.locator('.orbit-exchanges, .orbit-exchange-root').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.evaluate((s) => { for (const r of document.querySelectorAll('[data-orbit-fold]')) r.dispatchEvent(new CustomEvent('orbit:reveal-exchange', { detail: { seq: s } })); }, seq);
  await page.waitForTimeout(1000);
  const wrap = page.locator('.smc-wrap', { has: page.locator(`[data-seq="${seq}"]`) }).first();
  await wrap.waitFor({ timeout: 30000 });
  await wrap.evaluate((w) => {
    w.scrollIntoView({ block: 'start' });
    let p = w.parentElement;
    while (p && p !== document.body) { if (p.scrollHeight > p.clientHeight + 4 && getComputedStyle(p).overflowY !== 'visible') { p.scrollTop -= 90; break; } p = p.parentElement; }
  });
  await page.mouse.move(2, 2); await page.waitForTimeout(400);
  const b = await wrap.evaluate((w) => { const r = w.getBoundingClientRect(); const c = w.querySelector('.smc').getBoundingClientRect(); const col = w.parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cardW: c.width, cardH: c.height, colX: col.x, colW: col.width }; });
  boxes[name] = b;
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, JSON.stringify(b), errors.slice(0, 2));
  await context.close();
}
writeFileSync(`${OUT}/boxes-${only ?? 'all'}.json`, JSON.stringify(boxes, null, 1));
await browser.close();
