// Real-page shots for the wiki Trash board: the production build of 9dced799a (the delete as it ships, built from
// the deploy tree), the repo's ui-migration fixtures, and three wikis named as the owner's sidebar names them. The
// presses are real (the row's menu, the dialog, the DELETE); what the proposal changes is written over the real page
// at capture time with the page's own classes: new copy, the Trash row, the Trash dialog. None of that is in the product.
//   KIT=/var/tmp/wiki-delete-mock DIST=<dist> unshare -n docs/mocks/wiki-trash/capture/run-ns.sh [scene ...]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '..');
const OUT = `${BOARD}/shots`;
const KIT = process.env.KIT ?? '/var/tmp/wiki-delete-mock';
const DIST = process.env.DIST ?? `${KIT}/verify-deploy/dist`;
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
const ORBIT = wiki({ id: id(301), slug: 'github-com-jianghailong-xy-orbit', title: 'orbit', repoUrlNorm: 'github.com/jianghailong-xy/orbit', docs: { written: 30, total: 35 }, entries: 5120, workspaceIds: [WORKSPACES[0].id] });
const WIKOVA = wiki({ id: id(302), slug: 'github-com-jianghailong-xy-wikova', title: 'wikova', repoUrlNorm: 'github.com/jianghailong-xy/wikova', docs: { written: 5, total: 5 }, entries: 318, workspaceIds: [WORKSPACES[2].id] });
const PREVIEW = wiki({ id: id(303), slug: 'orbit-vllm-preview', title: 'orbit · vLLM preview', repoUrlNorm: null, docs: null, entries: 11138 });
const THREE = [ORBIT, WIKOVA, PREVIEW];
const health = (s) => ({ spaceId: s.id, entries: s.entries, maintenance: { look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null, lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null } });

// ── the proposal, written over the real page ───────────────────────────────────────────────────────
const TRASH_ICON = '<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0 4.4 3.6 8 8 8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z"></path></svg>';
const rowOf = (name) => (page) => page.locator('.tp-group-wiki .tp-item', { hasText: name }).first();
const openMenu = (name) => async (page) => {
  await rowOf(name)(page).hover();
  await rowOf(name)(page).locator('.tp-workspace-more').click();
  await page.getByRole('menuitem', { name: 'Delete wiki…' }).waitFor();
};
const renameMenuItem = (page) => page.evaluate(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes('Delete wiki'));
  const label = item.querySelector('.orbit-menu-label') ?? item;
  label.textContent = 'Move to Trash…';
});
const askFromRow = (name) => async (page) => {
  await openMenu(name)(page);
  await page.getByRole('menuitem', { name: 'Delete wiki…' }).click();
  await page.getByRole('button', { name: 'Delete wiki', exact: true }).waitFor();
};
const rewriteConfirm = (title, lines, confirm) => (page) => page.evaluate(({ title, lines, confirm }) => {
  const dialog = document.querySelector('[role="alertdialog"]');
  const head = dialog.querySelector('.orbit-overlay-title');
  const icon = head.querySelector('svg, .orbit-confirm-icon')?.closest('span, svg');
  head.textContent = '';
  if (icon) head.append(icon);
  head.append(document.createTextNode(title));
  const body = dialog.querySelector('.wk-delete-lines') ?? dialog.querySelector('.orbit-overlay-description');
  body.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
  const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete wiki');
  button.querySelector('span') ? (button.querySelector('span').textContent = confirm) : (button.textContent = confirm);
}, { title, lines, confirm });
const TRASH_LINES = (entries) => [
  'It leaves your wikis now, and sessions stop reading it.',
  `Its ${entries} entries stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.`,
  'Workspaces and sessions are kept.',
];
const confirmIt = async (page) => { await page.getByRole('button', { name: 'Delete wiki', exact: true }).click(); };
const rewriteToast = (text) => (page) => page.evaluate((text) => {
  const leaf = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.startsWith('Deleted wiki') && el.getBoundingClientRect().width > 20);
  if (leaf) leaf.textContent = text;
}, text);
const waitText = (text) => async (page) => { await page.getByText(text).first().waitFor(); };
const trashRow = (count) => (page) => page.evaluate(({ count, icon }) => {
  const group = document.querySelector('.tp-group-wiki');
  const rows = group.querySelectorAll('.tp-item');
  const row = rows[rows.length - 1].cloneNode(true);
  row.classList.remove('active', 'menu-open');
  row.classList.add('b-trash-row');
  row.querySelector('.tp-ico').innerHTML = icon;
  row.querySelector('.tp-label').textContent = 'Trash';
  row.querySelector('.tp-workspace-actions')?.remove();
  row.querySelector('.tp-count')?.remove();
  const n = document.createElement('span');
  n.className = 'tp-count';
  n.textContent = String(count);
  row.append(n);
  row.style.color = 'var(--text-3)';
  group.append(row);
}, { count, icon: TRASH_ICON });
// The Trash dialog: the real dialog's overlay and chrome, its body written as the proposal's list.
// Opened from wikova's row, which every scene lists: only the real overlay is borrowed.
const trashDialog = (rows, { error } = {}) => async (page) => {
  await askFromRow('wikova')(page);
  await page.evaluate(({ rows, error, icon }) => {
    const dialog = document.querySelector('[role="alertdialog"]');
    dialog.style.width = '640px';
    dialog.style.maxWidth = '640px';
    const head = dialog.querySelector('.orbit-overlay-title');
    head.textContent = 'Trash';
    const body = dialog.querySelector('.orbit-overlay-description') ?? dialog.querySelector('.orbit-overlay-body');
    body.innerHTML = `<div style="margin:2px 0 12px;color:var(--text-3);font-size:13px">A wiki stays here for 365 days after it was moved, then it is deleted for good.</div>`
      + rows.map((row) => `
        <div style="display:grid;grid-template-columns:22px minmax(0,1fr) auto;column-gap:12px;row-gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--border-subtle)">
          <span style="color:var(--text-3);font-size:18px;line-height:0">${icon}</span>
          <div style="min-width:0">
            <div style="font-size:14px;color:var(--text-1);font-weight:500">${row.name}</div>
            <div style="font-size:12.5px;color:var(--text-3);margin-top:2px">${row.sub}</div>
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            <button type="button" class="orbit-button orbit-button-default orbit-button-middle"><span>Restore</span></button>
            <button type="button" class="orbit-button orbit-button-text orbit-button-middle orbit-button-danger"><span>Delete permanently…</span></button>
          </div>
          ${row.error ? `<div class="orbit-confirm-error" role="alert" style="grid-column:2 / 4;margin:0">${row.error}</div>` : ''}
        </div>`).join('');
    const footer = dialog.querySelector('.orbit-overlay-footer');
    footer.innerHTML = '<button type="button" class="orbit-button orbit-button-default orbit-button-middle"><span>Close</span></button>';
    dialog.querySelector('.orbit-confirm-error')?.scrollIntoView();
  }, { rows, error, icon: '<span class="b-book"></span>' });
  // A book glyph, as the sidebar draws a wiki.
  await page.evaluate(() => {
    const book = document.querySelector('.tp-group-wiki .tp-ico svg')?.outerHTML ?? '';
    for (const el of document.querySelectorAll('.b-book')) el.outerHTML = book;
  });
};
const purgeConfirm = async (page) => {
  await askFromRow('wikova')(page);
  await rewriteConfirm('Delete permanently?', ['Its 11,138 entries and their history will be permanently deleted. This cannot be undone.'], 'Delete permanently')(page);
};
const settingsTrash = (page) => page.evaluate(() => {
  const card = document.querySelector('.wk-delete')?.closest('.orbit-card');
  card.querySelector('.orbit-card-title').textContent = 'Move to Trash';
  card.querySelector('.wk-delete .wk-maint-d').textContent = 'It stays in Trash for 365 days and can be restored until then.';
  const button = card.querySelector('.wk-delete button');
  button.querySelector('span') ? (button.querySelector('span').textContent = 'Move to Trash…') : (button.textContent = 'Move to Trash…');
  const link = document.createElement('div');
  link.className = 'b-trash-link';
  link.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid var(--border-subtle);font-size:13px;color:var(--text-3)';
  link.innerHTML = 'Trash holds 1 wiki. <a style="color:var(--brand)">Open Trash</a>';
  card.querySelector('.orbit-card-body').append(link);
});
const emptyTrash = (page) => page.evaluate(() => {
  // Under the first-wiki card's lead: what the account had is one press away.
  const leaf = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.startsWith('A wiki is documents for one codebase'));
  const line = document.createElement('div');
  line.style.cssText = 'margin-top:10px;font-size:13px;color:var(--text-3)';
  line.innerHTML = '1 wiki is in Trash. <a style="color:var(--brand)">Open Trash</a>';
  leaf.after(line);
});
const both = (...steps) => async (page) => { for (const step of steps) await step(page); };

const DESK = { width: 1280, height: 780 };
const TALL = { width: 1280, height: 1560 };
const NAV = { x: 0, y: 0, width: 520, height: 700 };
const BOX = { x: 408, y: 76, width: 464, height: 360 };
const WIDE_BOX = { x: 296, y: 60, width: 688, height: 560 };
const here = (s) => `/wiki/${s.slug}`;

const SCENES = {
  menu: { path: here(PREVIEW), clip: NAV, act: both(openMenu('vLLM preview'), renameMenuItem) },
  confirm: { path: here(PREVIEW), act: both(askFromRow('vLLM preview'), rewriteConfirm('Move wiki “orbit · vLLM preview” to Trash?', TRASH_LINES('11,138'), 'Move to Trash')) },
  'confirm-repo': {
    path: here(ORBIT), clip: BOX,
    act: both(askFromRow('orbit'), rewriteConfirm('Move wiki “orbit” to Trash?', [
      'It leaves your wikis now, and sessions stop reading it.',
      'Its 5,120 entries and 30 documents stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.',
      'Until you restore it, the next session on github.com/jianghailong-xy/orbit to use the wiki starts a new, empty one.',
      'Workspaces and sessions are kept.',
    ], 'Move to Trash')),
  },
  toast: { path: here(PREVIEW), act: both(askFromRow('vLLM preview'), confirmIt, waitText('Deleted wiki'), rewriteToast('Moved wiki “orbit · vLLM preview” to Trash'), trashRow(1)) },
  sidebar: { path: here(ORBIT), wikis: [ORBIT, WIKOVA], clip: NAV, act: trashRow(1) },
  trash: {
    path: here(ORBIT), wikis: [ORBIT, WIKOVA], clip: WIDE_BOX,
    act: both(trashRow(1), trashDialog([{ name: 'orbit · vLLM preview', sub: 'Moved to Trash Nov 7, 2026 · 11,138 entries · deleted for good Nov 7, 2027' }])),
  },
  'trash-conflict': {
    path: here(WIKOVA), wikis: [ORBIT, WIKOVA], clip: WIDE_BOX,
    act: both(trashDialog([
      { name: 'orbit · vLLM preview', sub: 'Moved to Trash Nov 7, 2026 · 11,138 entries · deleted for good Nov 7, 2027' },
      { name: 'orbit', sub: 'Moved to Trash Oct 2, 2026 · 5,120 entries · deleted for good Oct 2, 2027', error: 'A newer wiki for github.com/jianghailong-xy/orbit is in your wikis now. Move it to Trash first, then restore this one.' },
    ])),
  },
  purge: { path: here(ORBIT), wikis: [ORBIT, WIKOVA], clip: BOX, act: purgeConfirm },
  settings: { vp: TALL, path: `${here(PREVIEW)}/settings`, clip: 'tail', settle: '.wk-delete', act: settingsTrash },
  empty: { path: '/wiki', wikis: [], act: emptyTrash },
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
const site = await serve(DIST);

async function shoot(browser, name) {
  const scene = SCENES[name];
  const viewport = scene.vp ?? DESK;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installFixedDate(page);
  const api = await installFixtures(page, { theme: 'light' });
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); });
  let wikis = scene.wikis ?? THREE;
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
      wikis = wikis.filter((s) => s.id !== space.id);
      return route.fulfill({ status: 200, json: { spaceId: space.id } });
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
      '/workspaces': { workspaces: [], addable: [] },
    }[rest];
    return json === undefined ? route.fallback() : route.fulfill({ status: 200, json });
  });
  await page.goto(site.base + scene.path);
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.locator('.app-nav').waitFor({ state: 'attached' });
  if ((scene.wikis ?? THREE).length > 0) await page.waitForFunction(() => document.querySelector('.tp-group-wiki .tp-item'));
  if (scene.settle) await page.locator(scene.settle).first().waitFor();
  await page.waitForTimeout(350);
  if (scene.act) await scene.act(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  const clip = scene.clip === 'tail'
    ? await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.wk-settings-card')];
      const from = cards.find((c) => c.textContent.startsWith('Maintenance')).getBoundingClientRect();
      const box = document.querySelector('.wk-settings').getBoundingClientRect();
      return { x: box.x - 16, y: from.y - 14, width: box.width + 32, height: box.bottom - from.y + 34 };
    })
    : scene.clip ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  fs.writeFileSync(`${OUT}/${name}.png`, await page.screenshot({ animations: 'disabled', clip }));
  await context.close();
  console.log(JSON.stringify({ scene: name, w: clip.width, h: clip.height, errors, unhandled: api.unhandled }));
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: FONTS }, args: ['--disable-features=BackForwardCache'] });
for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) await shoot(browser, name);
await browser.close();
site.server.close();
