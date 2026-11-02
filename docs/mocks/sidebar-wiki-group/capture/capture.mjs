// Real-page shots of the web sidebar for the Wiki group board: the production build of today's main and
// of the proposal, the repo's ui-migration fixtures, and the 11-01 sidebar board's numbers (13 workspaces,
// 24 projects) plus 3 wikis. The options the owner is asked about are drawn over the proposal's build.
//   DIST_TODAY=<dist> DIST_PROPOSAL=<dist> unshare -n docs/mocks/sidebar-wiki-group/capture/run-ns.sh [scene ...]
// Writes shots/<scene>.png, shots/boxes.json and ../marks.js. Prints one JSON line per shot.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '..');
const W = path.resolve(HERE, '../../../..');
const OUT = `${BOARD}/shots`;
const FONTS = process.env.FONTCONFIG_FILE ?? '/mnt/data/pe-mock/fonts.conf';
const DIST = { today: process.env.DIST_TODAY, proposal: process.env.DIST_PROPOSAL };
const ONLY = process.argv.slice(2);

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${W}/src/shared/dist/index.js`);

const id = (n) => uuidToBase62(`0196e111-0000-7000-8000-${String(n).padStart(12, '0')}`);
const NOW = Date.parse(FIXED_NOW);
const HOUR = 3_600_000;
const earlier = '2026-09-27T10:00:00.000Z';

const RUNNERS = ['build-01', 'cloud-sg', 'mac-mini.local', 'workstation', 'load-test-2', 'laptop']
  .map((name, i) => ({ id: id(i + 1), name, displayName: null, online: true, status: 'ONLINE', maxConcurrent: 8, labels: [], engines: [] }));
const runner = (name) => RUNNERS.find((r) => r.name === name);
const WORKSPACES = [
  ['api-develop', 'build-01'], ['api-prod', 'cloud-sg'], ['ios-app', 'mac-mini.local'], ['data-pipeline', 'workstation'],
  ['web-develop', 'cloud-sg'], ['web-prod', 'cloud-sg'], ['build-01', 'build-01'], ['ml-train', 'workstation'],
  ['docs-site', 'workstation'], ['security-audit', 'build-01'], ['notify-service', 'cloud-sg'], ['load-test', 'load-test-2'],
  ['orbit', 'laptop'],
].map(([name, r], i) => ({ id: id(100 + i), name, createdAt: earlier, position: i, runnerId: runner(r).id, runner: { id: runner(r).id, name: r, displayName: null } }));
const TITLES = ['Checkout page redesign', 'Billing export to CSV', 'Search results ranking', 'Onboarding emails', 'Dark mode for settings',
  'API rate limits', 'Audit log retention', 'Android offline drafts', 'Release notes generator', 'Team invitations by link', 'Image upload resizing',
  'Push notification digest', 'Database index cleanup', 'Error page copy pass', 'SSO for enterprise plans', 'Calendar sync', 'CSV import validation',
  'Usage dashboard charts', 'Webhook retries', 'Accessibility audit fixes', 'Mobile tab bar polish', 'Session timeout settings', 'Slack digest', 'Billing retries'];
const PROJECTS = TITLES.map((title, i) => ({
  id: id(200 + i), title, status: 'OPEN', createdAt: earlier, lastActivityAt: new Date(NOW - (i + 1) * HOUR).toISOString(),
  buckets: { running: [1, 2, 6].includes(i) ? 1 : 0 },
  attention: { ownerItems: i === 0 ? [{ kind: 'COORDINATOR_QUESTION', count: 1, oldestWaitingSince: new Date(NOW - HOUR).toISOString() }] : [] },
  coordinatorActivity: null,
}));
const wiki = (over) => ({
  title: over.slug, repoUrlNorm: `github.com/example/${over.slug}`, rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } }, pendingOps: 0, planWaiting: 0, workspaceIds: [], docs: null, ...over,
});
const ORBIT = wiki({ id: FIXTURE_IDS.space, slug: 'orbit', title: 'Orbit knowledge', docs: { written: 30, total: 35 }, pendingOps: 1, planWaiting: 2 });
const WIKIS = [
  wiki({ id: id(301), slug: 'cbai', docs: { written: 2, total: 9 } }),
  ORBIT,
  wiki({ id: id(302), slug: 'wikova', docs: { written: 5, total: 5 }, pendingOps: 2 }),
];

// The options on the board, drawn over the proposal's build. None of this is in the product.
const fold = (page) => page.locator('.tp-group-wiki .tp-group-head').click();
const openDrawer = async (page) => {
  await page.locator('[aria-label="Open menu"]').click();
  await page.waitForTimeout(400);
};
// [workspaces, gap, wiki, gap, projects] → [workspaces, gap, projects, gap, wiki]
const wikiBelowProjects = (page) => page.evaluate(() => {
  const lists = document.querySelector('.tp-lists');
  const group = lists.querySelector(':scope > .tp-group-wiki');
  const gap = group.nextElementSibling;
  lists.insertBefore(lists.querySelector(':scope > .tp-group-projects'), group);
  lists.insertBefore(gap, group);
});
const noEntry = (page) => page.addStyleTag({ content: '.tp-section .tp-item:nth-child(3), .tp-rail-item[title="Wiki"] { display: none; }' });
// Workspaces stay put, and one scroller under them holds the Wiki group and the Projects.
const wikiScrollsWithProjects = async (page) => {
  await page.addStyleTag({ content: `
    .tp-lists.pin-workspaces > .tp-rest { flex: 1 1 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
    .tp-lists.pin-workspaces > .tp-rest .tp-group-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raised); }
    .tp-rest > .tp-group-projects { overflow: visible; }` });
  await page.evaluate(() => {
    const lists = document.querySelector('.tp-lists');
    const rest = document.createElement('div');
    rest.className = 'tp-rest autohide-scrollbar';
    const group = lists.querySelector(':scope > .tp-group-wiki');
    const gap = group.nextElementSibling;
    const projects = lists.querySelector(':scope > .tp-group-projects');
    lists.insertBefore(rest, group);
    rest.append(group, gap, projects);
    lists.classList.add('pin-workspaces');
  });
};
const scrollTo = (selector, top) => (page) => page.locator(selector).evaluate((el, y) => { el.scrollTop = y; }, top);
const both = (...steps) => async (page) => { for (const step of steps) await step(page); };

const TALL = { width: 1440, height: 1300 };
const WIDE = { width: 1440, height: 1000 };
const MID = { width: 1440, height: 900 };
const LOW = { width: 1440, height: 800 };
const PHONE = { width: 390, height: 844, isMobile: true };

const SCENES = {
  // Today against the proposal.
  'today-wiki': { tree: 'today', vp: TALL, path: '/wiki/orbit' },
  'prop-wiki': { vp: TALL, path: '/wiki/orbit' },
  'prop-window': { vp: WIDE, path: '/wiki/orbit', clip: 'viewport' },
  // The states.
  's-tasks': { vp: WIDE, path: '/tasks' },
  's-review': { vp: WIDE, path: '/wiki/review' },
  's-folded': { vp: WIDE, path: '/wiki/orbit', act: fold },
  's-one': { vp: WIDE, path: '/tasks', wikis: [ORBIT] },
  's-none': { vp: WIDE, path: '/tasks', wikis: [] },
  's-low': { vp: LOW, path: '/wiki/orbit' },
  's-dark': { vp: WIDE, path: '/wiki/orbit', theme: 'dark' },
  's-phone': { vp: PHONE, path: '/wiki/orbit', clip: 'viewport', act: openDrawer },
  's-rail': { vp: WIDE, path: '/wiki/orbit', collapsed: true },
  // Decision 1: where the group stands.
  'p1-a-wide': { vp: WIDE, path: '/tasks' },
  'p1-a-low': { vp: LOW, path: '/tasks' },
  'p1-b-wide': { vp: WIDE, path: '/tasks', act: wikiBelowProjects },
  'p1-b-low': { vp: LOW, path: '/tasks', act: wikiBelowProjects },
  'p1-b-low-end': { vp: LOW, path: '/tasks', act: both(wikiBelowProjects, scrollTo('.tp-lists', 99_999)) },
  // Decision 2: the entry above the groups.
  'p2-b': { vp: WIDE, path: '/tasks', act: noEntry },
  'p2-b-rail': { vp: WIDE, path: '/wiki/orbit', collapsed: true, act: noEntry },
  'p2-b-none': { vp: WIDE, path: '/tasks', wikis: [], act: noEntry },
  // Decision 3: which side of the scroll the group is on when the window runs short.
  'p3-a-rest': { vp: MID, path: '/tasks' },
  'p3-a-scrolled': { vp: MID, path: '/tasks', act: scrollTo('.tp-lists', 430) },
  'p3-b-rest': { vp: MID, path: '/tasks', act: wikiScrollsWithProjects },
  'p3-b-scrolled': { vp: MID, path: '/tasks', act: both(wikiScrollsWithProjects, scrollTo('.tp-rest', 300)) },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const serve = (dist) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
});
const trees = { today: await serve(DIST.today), proposal: await serve(DIST.proposal) };

async function shoot(browser, name) {
  const scene = SCENES[name];
  const theme = scene.theme ?? 'light';
  const { isMobile, ...viewport } = scene.vp;
  const context = await browser.newContext({ viewport, isMobile: !!isMobile, hasTouch: !!isMobile, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  if (scene.collapsed) await page.addInitScript(() => localStorage.setItem('orbit:sidebar-collapsed', '1'));
  const reads = { '/api/runners': RUNNERS, '/api/workspaces': WORKSPACES, '/api/projects/sidebar': PROJECTS, '/api/wiki/spaces': scene.wikis ?? WIKIS, '/api/sessions/counts': [] };
  await page.route('**/api/**', async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && Object.hasOwn(reads, where)) return route.fulfill({ status: 200, json: reads[where] });
    return route.fallback();
  });
  await page.goto(trees[scene.tree ?? 'proposal'].base + scene.path);
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.locator('.app-nav').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.tp-group-projects .tp-item'));
  if ((scene.wikis ?? WIKIS).length > 0 && (scene.tree ?? 'proposal') === 'proposal') await page.waitForFunction(() => document.querySelector('.tp-group-wiki .tp-item'));
  await page.waitForTimeout(250);
  if (scene.act) await scene.act(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  const clip = scene.clip === 'viewport' ? null : '.app-nav';
  const measured = await page.evaluate((clipSelector) => {
    const frame = clipSelector ? document.querySelector(clipSelector).getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? [r.x - frame.x, r.y - frame.y, r.width, r.height].map((n) => Math.round(n * 10) / 10) : undefined;
    };
    const q = (selector) => box(document.querySelector(selector));
    const entry = [...document.querySelectorAll('.tp-section .tp-item')].find((item) => item.querySelector('.tp-label')?.textContent === 'Wiki');
    return {
      clip: { w: frame.width, h: frame.height },
      boxes: {
        nav: q('.tp-section'), entry: box(entry), entryCount: box(entry?.querySelector('.needs-you')),
        ws: q('.tp-group-workspaces'), wsHead: q('.tp-group-workspaces .tp-group-head'),
        wiki: q('.tp-group-wiki'), wikiHead: q('.tp-group-wiki .tp-group-head'), wikiLit: q('.tp-group-wiki .tp-item.active'), wikiCount: q('.tp-group-wiki .needs-you'),
        pj: q('.tp-group-projects'), pjHead: q('.tp-group-projects .tp-group-head'), lists: q('.tp-lists'), rest: q('.tp-rest'), user: q('.tp-user'),
        railWiki: q('.tp-rail-item[title="Wiki"]'), select: q('.wk-select, .wk-space-tag'),
      },
      pinned: document.querySelector('.tp-lists')?.classList.contains('pin-workspaces'),
      lit: [...document.querySelectorAll('.tp-scroll .tp-item.active .tp-label')].map((n) => n.textContent),
      railLit: [...document.querySelectorAll('.tp-rail-item.active')].map((n) => n.getAttribute('title')),
    };
  }, clip);
  const file = `${OUT}/${name}.png`;
  if (clip) await page.locator(clip).first().screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, animations: 'disabled' });
  await context.close();
  console.log(JSON.stringify({ scene: name, pinned: measured.pinned, lit: measured.lit, railLit: measured.railLit, errors, unhandled: api.unhandled }));
  return measured;
}

const boxesFile = `${OUT}/boxes.json`;
const all = fs.existsSync(boxesFile) ? JSON.parse(fs.readFileSync(boxesFile, 'utf8')) : {};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: FONTS }, args: ['--disable-features=BackForwardCache'] });
for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) all[name] = await shoot(browser, name);
await browser.close();
for (const tree of Object.values(trees)) tree.server.close();
fs.writeFileSync(boxesFile, JSON.stringify(all, null, 1));
const marks = Object.fromEntries(Object.entries(all).map(([name, m]) => [name, { w: m.clip.w, h: m.clip.h, boxes: m.boxes }]));
fs.writeFileSync(`${BOARD}/marks.js`, `// Generated by capture/capture.mjs: each shot's size and the element boxes the board's marks ring.\nwindow.SHOT_MARKS = ${JSON.stringify(marks)};\n`);
