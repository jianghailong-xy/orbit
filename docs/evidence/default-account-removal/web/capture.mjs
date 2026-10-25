// A runner's card on the Providers page (Infrastructure, where /providers lands) with Codex's Default
// removed from Orbit, and the question asked before it is. The production build, with its own routes,
// components and CSS; only the REST data is synthetic: src/web/ui-migration/fixtures.mjs signs in and
// answers the app's reads, and the runner below is served as the control plane serves it with Default
// removed (usedRunnerEngines: the remaining accounts, `removedDefault`, the engine's sign-in and quota
// theirs).
//
//   cd src/web && npx vite build --outDir /var/tmp/w-default-shots/dist --emptyOutDir
//   FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
//     'ip link set lo up && node docs/evidence/default-account-removal/web/capture.mjs /var/tmp/w-default-shots/dist'
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FIXED_NOW, FIXTURE_IDS, installFixedDate, installFixtures } from '../../../../src/web/ui-migration/fixtures.mjs';

const dist = resolve(process.argv[2] ?? '/var/tmp/w-default-shots/dist');
const out = fileURLToPath(new URL('./screenshots/', import.meta.url));
await mkdir(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  let file = join(dist, decodeURIComponent(new URL(req.url, 'http://local').pathname));
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    file = join(dist, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const now = Date.parse(FIXED_NOW);
const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
/** A Codex login's two windows: 5 hours and a week, `used` percent of each gone. */
const codexUsage = ([five, week]) => ({
  provider: 'codex',
  fetchedAt: at(-4),
  primary: { utilization: five, windowDurationMins: 300, resetsAt: at(137) },
  secondary: { utilization: week, windowDurationMins: 10080, resetsAt: at(3 * 24 * 60 + 200) },
});
const DEFAULT = { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes', fingerprintPrefix: 'cxa1_2b7e9013' };
const WORK = { id: '3fa91c2e', name: 'Work', home: '/root/.orbit/codex-accounts/3fa91c2e', codexHome: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes', fingerprintPrefix: 'cxa1_9f3a41c7' };
const PERSONAL = { id: '7c21de40', name: 'Personal', home: '/root/.orbit/codex-accounts/7c21de40', codexHome: '/root/.orbit/codex-accounts/7c21de40', auth: 'yes', fingerprintPrefix: 'cxa1_4d5c8b26' };
const USED = { default: [41, 23], [WORK.id]: [12, 34], [PERSONAL.id]: [67, 58] };
const accountsUsage = (accounts) => Object.fromEntries(accounts.filter((a) => a.id !== 'default').map((a) => [a.id, codexUsage(USED[a.id])]));

/** The runner as GET /runners serves it, with `codex` as given and its quota beside Claude Code's. */
const runner = (codex, codexPlanUsage) => ({
  id: FIXTURE_IDS.runner,
  name: 'wikova',
  hostname: 'vmi3129740',
  version: '0.1.235',
  online: true,
  maxConcurrent: 4,
  activeSessions: 1,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.287 (Claude Code)' },
    { engine: 'codex', installed: true, version: 'codex-cli 0.156.0', ...codex },
  ],
  planUsage: {
    claude: { provider: 'claude', fetchedAt: at(-4), fiveHour: { utilization: 18, resetsAt: at(95) }, sevenDay: { utilization: 44, resetsAt: at(2 * 24 * 60) } },
    codex: codexPlanUsage,
  },
});
const removedDefault = { home: DEFAULT.home, fingerprintPrefix: DEFAULT.fingerprintPrefix };
const SCENES = {
  // Default and Work, as before the removal: the question Default's Remove account asks.
  before: runner({ auth: 'yes', accounts: [DEFAULT, WORK] }, { ...codexUsage(USED.default), accounts: accountsUsage([WORK]) }),
  // Default removed, two accounts remaining: the engine's quota is only theirs.
  'removed-two': runner({ auth: 'yes', accounts: [WORK, PERSONAL], removedDefault }, { provider: 'codex', accounts: accountsUsage([WORK, PERSONAL]) }),
  // Default removed, one account remaining: its windows are the engine snapshot's own too.
  'removed-one': runner({ auth: 'yes', accounts: [WORK], removedDefault }, { ...codexUsage(USED[WORK.id]), accounts: accountsUsage([WORK]) }),
};

const browser = await chromium.launch({ headless: true, args: ['--disable-features=BackForwardCache'] });
const results = [];
try {
  for (const [name, scene, theme, width, confirm] of [
    ['removed-two-light', 'removed-two', 'light', 1280, false],
    ['removed-one-light', 'removed-one', 'light', 1280, false],
    ['removed-one-dark', 'removed-one', 'dark', 1280, false],
    ['removed-two-phone', 'removed-two', 'light', 390, false],
    ['confirm-remove-default-light', 'before', 'light', 1280, true],
  ]) {
    const phone = width < 700;
    const context = await browser.newContext({
      // Tall enough that the card's Codex group is in view without scrolling, a phone's included.
      viewport: { width, height: phone ? 2400 : 1400 },
      deviceScaleFactor: 2,
      isMobile: phone,
      hasTouch: phone,
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installFixedDate(page);
    const fixtures = await installFixtures(page, { theme });
    // After the fixtures' own init script, which clears storage: this card open, and its Codex accounts.
    await page.addInitScript((id) => {
      localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([id]));
      localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${id}/codex`]));
    }, FIXTURE_IDS.runner);
    await page.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body) => route.fulfill({ status: 200, json: body });
      if (pathname === '/api/runners') return json([SCENES[scene]]);
      if (pathname === `/api/runners/${FIXTURE_IDS.runner}/login`) return json({ status: null, engine: null, url: null, userCode: null, message: null, account: null });
      // The page's API keys: none.
      if (pathname === '/api/providers/mine') return json([]);
      return route.fallback();
    });
    // Bare /providers lands on the page's API keys (#keys); the runner cards head the page itself.
    await page.goto(`${base}/infrastructure`);
    const card = page.locator('.re-runner-card').first();
    await card.locator('.re-row[data-engine="codex"]').waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => document.fonts.ready);
    // The page's other sections load beside the card and move it: measure once it has stopped moving.
    for (let last = null, same = 0; same < 3; ) {
      await page.waitForTimeout(200);
      const now = JSON.stringify(await card.boundingBox());
      same = now === last ? same + 1 : 0;
      last = now;
    }

    // The card from its head to the end of the Codex group: the engines after it say nothing here.
    const cardBox = await card.boundingBox();
    const groupEnd = await card.locator('.re-row[data-engine="codex"] ~ .re-acct').last().boundingBox();
    let clip = { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: groupEnd.y + groupEnd.height - cardBox.y };
    if (confirm) {
      const defaultRow = card.locator('.re-acct').first();
      await defaultRow.getByRole('button', { name: 'More actions' }).click();
      await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Remove account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Remove Default?' });
      await dialog.waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      const box = await dialog.boundingBox();
      const left = Math.min(clip.x, box.x);
      const top = Math.min(clip.y, box.y);
      clip = { x: left, y: top, width: Math.max(clip.x + clip.width, box.x + box.width) - left, height: Math.max(clip.y + clip.height, box.y + box.height) - top };
      results.push({ name, dialog: await dialog.innerText() });
    } else {
      const line = card.locator('.re-removed');
      await line.waitFor({ state: 'visible' });
      results.push({
        name,
        head: await card.locator('.re-row[data-engine="codex"] .re-meta').innerText(),
        accounts: await card.locator('.re-acct:not(.re-removed) .re-name-text').allInnerTexts(),
        removed: await line.innerText(),
      });
    }
    const pad = 12;
    assert.ok(clip.y >= pad && clip.y + clip.height + pad <= page.viewportSize().height, `${name}: the card is not wholly in view`);
    await page.screenshot({
      path: `${out}${name}.png`,
      animations: 'disabled',
      clip: { x: Math.max(0, clip.x - pad), y: Math.max(0, clip.y - pad), width: Math.min(width, clip.width + 2 * pad), height: clip.height + 2 * pad },
    });
    assert.deepEqual(errors, [], `${name}: browser exceptions`);
    results.at(-1).unhandledApiCalls = [...new Set(fixtures.unhandled)];
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(results, null, 2));
