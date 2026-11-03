// Zero-commit landing board: the real confirmation card and the real open-item row, in this worktree's
// web app, drawn from REST fixtures. usage: unshare -n ./run-ns.sh capture.mjs
import fs from 'node:fs';
const W = '/root/.orbit/worktrees/1c275d44-d415-5572-8505-0da4e243125e';
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { CARD_IDS, CARDS_PATH, installCardFixtures } = await import(`${W}/src/web/ui-migration/p43b-cards-fixtures.mjs`);
const BASE = 'http://127.0.0.1:5871';
const OUT = '/var/tmp/zero-commit-mock/shots';
fs.mkdirSync(OUT, { recursive: true });
const now = Date.parse(FIXED_NOW);
const at = (ms) => new Date(now + ms).toISOString();
const BRANCH = 'orbit/task-backfill-order-stats-1b5d7d';
const report = 'Done. 412 rows in the stats table were repaired from the source table. No code was changed.';
const view = (ifConfirmed) => ({
  taskId: CARD_IDS.ownerTask, title: 'Backfill order stats for 09-22 to 10-22', status: 'OPEN', projectId: null,
  completionCriterion: 'OWNER_CONFIRMED',
  acceptanceCriteria: 'Every order in the window is counted once, and the daily totals match the source table.',
  waiting: { requestId: '01920000-0000-7000-8000-0000000000f1', sessionId: CARD_IDS.session, requestedAt: at(-12 * 60_000),
    report: { text: report, reportedAt: at(-12 * 60_000) } },
  decisions: [], ifConfirmed,
});
const starts = [{ id: 'dep-1', title: 'Verify the backfill against the source table', starts: 'NOW' }];
const ends = { sessionId: CARD_IDS.session, runningBgJobs: 0 };
const branch = { name: BRANCH, linesAdded: 0, linesRemoved: 0, files: 0, onMain: 'NO' };
const CARDS = {
  'card-today': { startsTasks: starts, startsAfterLanding: true, branch, landing: 'LINE_THEN_OWNER', endsSession: ends, mainBranch: 'develop' },
  'card-removed': { startsTasks: starts, startsAfterLanding: false, branch: null, landing: 'NONE', endsSession: ends, mainBranch: 'develop' },
  'card-stated': { startsTasks: starts, startsAfterLanding: false, branch, landing: 'NONE', endsSession: ends, mainBranch: 'develop' },
};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/turn-foot-mock/fonts.conf' } });
const log = {};
for (const [name, ifConfirmed] of Object.entries(CARDS)) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2, colorScheme: 'light',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(180_000); page.setDefaultTimeout(90_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  await installCardFixtures(page);
  await page.route(`**/api/tasks/${CARD_IDS.ownerTask}/owner-confirmation`, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, json: view(ifConfirmed) }) : route.fallback());
  await page.goto(`${BASE}${CARDS_PATH}`);
  const card = page.locator('[data-case="owner"] .owner-confirmation').first();
  await card.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.waitForTimeout(150);
  await card.screenshot({ path: `${OUT}/${name}.png` });
  log[name] = { errors, rows: await page.locator('[data-case="owner"] .owner-confirmation-if-row').allInnerTexts() };
  await context.close();
}
fs.writeFileSync('/var/tmp/zero-commit-mock/capture-cards.json', JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1));
await browser.close();
