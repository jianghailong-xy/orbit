// Real-page shots for the Delete wiki board: the production build of today's main and of the prototype
// (prototype.py over a copy of src/web), the repo's ui-migration fixtures, and three wikis named as the owner's
// sidebar names them. The presses are real: the row's menu, the dialog, the DELETE (answered by this file).
//   KIT=/var/tmp/wiki-delete-mock unshare -n docs/mocks/wiki-delete/capture/run-ns.sh [scene ...]
// Writes shots/<scene>.png and marks.js. Prints one JSON line per shot.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '..');
const OUT = `${BOARD}/shots`;
const KIT = process.env.KIT ?? '/var/tmp/wiki-delete-mock';
const W = `${KIT}/new`;
const FONTS = process.env.FONTCONFIG_FILE ?? '/mnt/data/pe-mock/fonts.conf';
const ONLY = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${W}/src/shared/dist/index.js`);

const id = (n) => uuidToBase62(`0196e111-0000-7000-8000-${String(n).padStart(12, '0')}`);
const earlier = '2026-09-27T10:00:00.000Z';
const RUNNER = { id: FIXTURE_IDS.runner, name: 'workstation-gpu', displayName: null, online: true, status: 'ONLINE', maxConcurrent: 8, labels: [], engines: [] };
const WORKSPACES = ['orbit', 'orbit-prod', 'wikova', 'notes'].map((name, i) => ({
  id: id(100 + i), name, createdAt: earlier, position: i, runnerId: RUNNER.id, runner: { id: RUNNER.id, name: RUNNER.name, displayName: null },
}));
const PROJECTS = ['Checkout page redesign', 'Billing export to CSV', 'Search results ranking'].map((title, i) => ({
  id: id(200 + i), title, status: 'OPEN', createdAt: earlier, lastActivityAt: earlier, buckets: { running: 0 }, attention: { ownerItems: [] }, coordinatorActivity: null,
}));
const wiki = (over) => ({
  rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier, pendingOps: 0, planWaiting: 0, workspaceIds: [], docs: null,
  settings: { push: true, autoAcceptReinforce: true, reviewMode: 'tiered', maintenance: { enabled: false } }, ...over,
});
// The list goes by slug, which is why the owner's preview stands after wikova: it has no repository to slug from.
const ORBIT = wiki({ id: id(301), slug: 'github-com-jianghailong-xy-orbit', title: 'orbit', repoUrlNorm: 'github.com/jianghailong-xy/orbit', docs: { written: 30, total: 35 }, entries: 5120, workspaceIds: [WORKSPACES[0].id, WORKSPACES[1].id] });
const WIKOVA = wiki({ id: id(302), slug: 'github-com-jianghailong-xy-wikova', title: 'wikova', repoUrlNorm: 'github.com/jianghailong-xy/wikova', docs: { written: 5, total: 5 }, entries: 318, workspaceIds: [WORKSPACES[2].id] });
const PREVIEW = wiki({ id: id(303), slug: 'orbit-vllm-preview', title: 'orbit · vLLM preview', repoUrlNorm: null, docs: null, entries: 2606 });
const THREE = [ORBIT, WIKOVA, PREVIEW];

const health = (s) => ({ spaceId: s.id, entries: s.entries, maintenance: { look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null, lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null } });
const rowOf = (name) => (page) => page.locator('.tp-group-wiki .tp-item', { hasText: name }).first();
const hoverRow = (name) => async (page) => { await rowOf(name)(page).hover(); };
const openMenu = (name) => async (page) => {
  await rowOf(name)(page).hover();
  await rowOf(name)(page).locator('.tp-workspace-more').click();
  await page.getByRole('menuitem', { name: 'Delete wiki…' }).waitFor();
};
const askFromRow = (name) => async (page) => {
  await openMenu(name)(page);
  await page.getByRole('menuitem', { name: 'Delete wiki…' }).click();
  await page.getByRole('button', { name: 'Delete wiki', exact: true }).waitFor();
};
const confirmIt = async (page) => { await page.getByRole('button', { name: 'Delete wiki', exact: true }).click(); };
// Decision 4's other answer, drawn on the real dialog: none of this is in the prototype.
const typedVariant = (page) => page.evaluate(() => {
  const field = document.createElement('div');
  field.style.cssText = 'margin-top:12px';
  field.innerHTML = '<div style="margin-bottom:6px;font-size:13px;color:var(--text-2)">Type <b>orbit · vLLM preview</b> to confirm.</div><input class="orbit-text-control orbit-input" style="width:100%">';
  document.querySelector('.orbit-overlay-body').append(field);
  [...document.querySelectorAll('.orbit-overlay-footer button')].find((b) => b.textContent.trim() === 'Delete wiki').disabled = true;
});
const both = (...steps) => async (page) => { for (const step of steps) await step(page); };
const waitText = (text) => async (page) => { await page.getByText(text).first().waitFor(); };
const openDrawer = async (page) => {
  await page.locator('[aria-label="Open menu"]').click();
  await page.waitForTimeout(400);
};

const DESK = { width: 1280, height: 780 };
const TALL = { width: 1280, height: 1560 };
const PHONE = { width: 390, height: 844, isMobile: true };
const NAV = { x: 0, y: 0, width: 520, height: 620 };
const BOX = { x: 408, y: 76, width: 464, height: 344 };
const here = (s) => `/wiki/${s.slug}`;

const SCENES = {
  // ① Today.
  'today-row': { tree: 'today', vp: DESK, path: here(PREVIEW), act: hoverRow('vLLM preview'), clip: NAV, marks: { row: '.tp-group-wiki .tp-item:nth-of-type(4)' } },
  'today-settings': { tree: 'today', vp: TALL, path: `${here(PREVIEW)}/settings`, clip: 'tail', settle: '.wk-settings' },
  // ② The row.
  'row-menu': { vp: DESK, path: here(PREVIEW), act: openMenu('vLLM preview'), clip: NAV },
  // ③ The bottom of the settings page.
  'settings-new': { vp: TALL, path: `${here(PREVIEW)}/settings`, clip: 'tail', settle: '.wk-delete' },
  // ④ The dialog.
  'dialog-norepo': { vp: DESK, path: here(PREVIEW), act: askFromRow('vLLM preview') },
  'dialog-repo': { vp: DESK, path: here(ORBIT), clip: BOX, act: askFromRow('orbit') },
  'dialog-error': { vp: DESK, path: here(PREVIEW), clip: BOX, fail: true, act: both(askFromRow('vLLM preview'), confirmIt, waitText('Nothing was deleted')) },
  'dialog-typed': { vp: DESK, path: here(PREVIEW), clip: BOX, act: both(askFromRow('vLLM preview'), typedVariant) },
  // ⑤ After it.
  'after-delete': { vp: DESK, path: here(PREVIEW), act: both(askFromRow('vLLM preview'), confirmIt, waitText('Deleted wiki')) },
  'after-last': { vp: DESK, path: here(PREVIEW), wikis: [PREVIEW], act: both(askFromRow('vLLM preview'), confirmIt, waitText('Deleted wiki')) },
  'after-gone-link': { vp: DESK, path: '/wiki/orbit-vllm-preview', wikis: [ORBIT, WIKOVA] },
  // ⑥ The touch drawer has no hover: every row shows its ⋯, as a workspace's does.
  'phone-menu': {
    vp: PHONE, path: here(PREVIEW),
    act: both(openDrawer, async (page) => {
      await rowOf('vLLM preview')(page).locator('.tp-workspace-more').click();
      await page.getByRole('menuitem', { name: 'Delete wiki…' }).waitFor();
    }),
  },
  'phone-dialog': {
    vp: PHONE, path: here(PREVIEW),
    act: both(openDrawer, async (page) => {
      await rowOf('vLLM preview')(page).locator('.tp-workspace-more').click();
      await page.getByRole('menuitem', { name: 'Delete wiki…' }).click();
      await page.getByRole('button', { name: 'Delete wiki', exact: true }).waitFor();
    }),
  },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const serve = (dist) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
});
const trees = { today: await serve(`${KIT}/dist-today`), proposal: await serve(`${KIT}/dist-new`) };

async function shoot(browser, name) {
  const scene = SCENES[name];
  const theme = scene.theme ?? 'light';
  const { isMobile, ...viewport } = scene.vp;
  const context = await browser.newContext({ viewport, isMobile: !!isMobile, hasTouch: !!isMobile, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); });
  let wikis = scene.wikis ?? THREE;
  const deletes = [];
  const reads = { '/api/runners': [RUNNER], '/api/workspaces': WORKSPACES, '/api/projects/sidebar': PROJECTS, '/api/sessions/counts': [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const where = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'GET' && Object.hasOwn(reads, where)) return route.fulfill({ status: 200, json: reads[where] });
    if (method === 'GET' && where === '/api/wiki/spaces') return route.fulfill({ status: 200, json: wikis });
    if (method === 'GET' && where === '/api/wiki/system-model') return route.fulfill({ status: 404, json: { message: 'not here' } });
    const hit = where.match(/^\/api\/wiki\/spaces\/([^/]+)(\/.*)?$/);
    if (!hit) return route.fallback();
    const space = THREE.find((s) => s.id === decodeURIComponent(hit[1]));
    if (!space) return route.fulfill({ status: 404, json: { message: 'no such wiki space' } });
    const rest = hit[2] ?? '';
    if (method === 'DELETE' && rest === '') {
      deletes.push(space.slug);
      if (scene.fail) return route.fulfill({ status: 503, json: { message: 'Couldn’t reach the server. Nothing was deleted. Try again.' } });
      wikis = wikis.filter((s) => s.id !== space.id);
      return route.fulfill({ status: 200, json: { deleted: true } });
    }
    if (method !== 'GET') return route.fallback();
    const json = {
      '': space,
      '/health': health(space),
      '/entries': [],
      '/timeline': { items: [] },
      '/articles': { spaceId: space.id, categories: [], uncategorized: [] },
      '/docs': { spaceId: space.id, plan: null, docs: { total: space.docs?.total ?? 0, written: space.docs?.written ?? 0 }, categories: [] },
      '/share': { link: null, counts: { documents: 0, footnotes: 0 } },
      '/plan': { spaceId: space.id, confirmed: null, draft: null, proposals: [], job: null },
      '/workspaces': {
        workspaces: WORKSPACES.filter((w) => space.workspaceIds.includes(w.id)).map((w) => ({ id: w.id, name: w.name, runner: RUNNER.name, inWiki: true })),
        addable: space.repoUrlNorm ? [] : [{ id: WORKSPACES[3].id, name: 'notes', runner: RUNNER.name, inWiki: false }],
      },
    }[rest];
    return json === undefined ? route.fallback() : route.fulfill({ status: 200, json });
  });
  await page.goto(trees[scene.tree ?? 'proposal'].base + scene.path);
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.locator('.app-nav').waitFor({ state: 'attached' });
  if (!isMobile) await page.waitForFunction(() => document.querySelector('.tp-group-wiki .tp-item, .tp-group-projects .tp-item'));
  if (scene.settle) await page.locator(scene.settle).first().waitFor();
  await page.waitForTimeout(350);
  if (scene.act) await scene.act(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  // 'tail': the page's foot, from the Maintenance card down, which is all that changes.
  const clip = scene.clip === 'tail'
    ? await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.wk-settings-card')];
      const from = cards.find((c) => c.textContent.startsWith('Maintenance')).getBoundingClientRect();
      const page = document.querySelector('.wk-settings').getBoundingClientRect();
      return { x: page.x - 16, y: from.y - 14, width: page.width + 32, height: page.bottom - from.y + 34 };
    })
    : scene.clip ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const boxes = await page.evaluate((frame) => {
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? [r.x - frame.x, r.y - frame.y, r.width, r.height].map((n) => Math.round(n * 10) / 10) : undefined;
    };
    const q = (selector) => box(document.querySelector(selector));
    // The toast has a hidden live-region twin, so only an element a person can see counts.
    const leaf = (text) => [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.startsWith(text) && el.getBoundingClientRect().width > 20);
    const wikiRow = (text) => box([...document.querySelectorAll('.tp-group-wiki .tp-item')].find((row) => row.textContent.includes(text)));
    const more = [...document.querySelectorAll('.tp-group-wiki .tp-item')].find((row) => row.textContent.includes('vLLM'))?.querySelector('.tp-workspace-more');
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const button = (text) => box([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text));
    return {
      row: wikiRow('vLLM'), rowOrbit: wikiRow('orbit'), more: box(more),
      group: q('.tp-group-wiki'), groupHead: q('.tp-group-wiki .tp-group-head'), wikiEntry: box([...document.querySelectorAll('.tp-section .tp-item')].find((item) => item.querySelector('.tp-label')?.textContent === 'Wiki')),
      menu: q('[role="menu"]'), itemSettings: box(items.find((i) => i.textContent.includes('Wiki settings'))), itemDelete: box(items.find((i) => i.textContent.includes('Delete wiki'))),
      card: q('.wk-delete-card'), cardButton: button('Delete wiki…'), lastCard: box([...document.querySelectorAll('.wk-settings-card')].at(-1)),
      dialog: q('[role="alertdialog"], [role="dialog"]'), confirm: button('Delete wiki'), cancel: button('Cancel'), error: q('.orbit-confirm-error'),
      toast: box(leaf('Deleted wiki')),
      noSpace: box(leaf('No wiki space')?.closest('.orbit-card, [class*="card"]') ?? leaf('No wiki space')),
    };
  }, clip);
  fs.writeFileSync(`${OUT}/${name}.png`, await page.screenshot({ animations: 'disabled', clip }));
  const focus = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 40) ?? null);
  await context.close();
  console.log(JSON.stringify({ scene: name, deletes, focus, errors, unhandled: api.unhandled }));
  return { w: clip.width, h: clip.height, boxes };
}

const marksFile = `${BOARD}/marks.js`;
const all = fs.existsSync(marksFile) ? JSON.parse(fs.readFileSync(marksFile, 'utf8').replace(/^[^]*?window\.SHOT_MARKS = /, '').replace(/;\s*$/, '')) : {};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: FONTS }, args: ['--disable-features=BackForwardCache'] });
for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) all[name] = await shoot(browser, name);
await browser.close();
for (const tree of Object.values(trees)) tree.server.close();
fs.writeFileSync(marksFile, `// Generated by capture/capture.mjs: each shot's size and the element boxes the board's marks ring.\nwindow.SHOT_MARKS = ${JSON.stringify(all)};\n`);
