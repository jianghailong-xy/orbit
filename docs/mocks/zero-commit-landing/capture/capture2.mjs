// The real open-item row on the real project page, for the old-runner item: what the server serves
// today, and what it would serve. usage: unshare -n ./run-ns.sh capture2.mjs
import fs from 'node:fs';
const W = '/root/.orbit/worktrees/01a19d00-fe53-77b5-b996-8f5ce8217f56';
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const BASE = 'http://127.0.0.1:5871';
const OUT = '/var/tmp/zero-commit-mock/shots';
const PROJECT = FIXTURE_IDS.project;
const at = new Date(Date.parse(FIXED_NOW) - 42 * 60_000).toISOString();
const row = (over) => ({
  itemId: '4BLRNxGq7TOI1lIiOh4g1j', kind: 'INTEGRATION_ERROR',
  title: 'Integration error: merging the project branch into develop', detailLine: '',
  assignee: 'OWNER', assigneeReason: 'DEFAULT', waitingSince: at, escalateAt: null, escalatedAt: null,
  taskId: null, sessionId: null, promotionId: '01920000-0000-7000-8000-0000000000aa', fuseEpisodeId: null,
  delivery: { state: 'NOT_APPLICABLE', sessionId: null, at: null },
  actions: ['RERUN'], primaryAction: 'RERUN', question: null,
  facts: { task: null, targetRef: 'refs/heads/develop', targetSha: null, files: [], nothingLanded: true, check: null,
    branchUnchanged: false, errorCode: 'SOURCE_BRANCH_MISSING', failure: null },
  ...over,
});
const ROWS = {
  'item-today': row({}),
  'item-proposed': row({
    title: 'Integration error: merging “Backfill order stats for 09-22 to 10-22” into develop',
    detailLine: 'Runner DeskMac is out of date: update it, then run this check again.',
    requiredAction: 'Update runner DeskMac, then run this check again.',
  }),
};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/turn-foot-mock/fonts.conf' } });
const log = {};
for (const [name, item] of Object.entries(ROWS)) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2, colorScheme: 'light',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(180_000); page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  await page.route(`**/api/projects/${PROJECT}/open-items`, (route) => route.fulfill({ status: 200,
    json: { needsYou: [item], withCoordinator: [], settled: [], doneRequest: null, startRequest: null } }));
  await page.goto(`${BASE}/projects/${PROJECT}`);
  const list = page.locator('.project-open-items').first();
  await list.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await list.screenshot({ path: `${OUT}/${name}.png` });
  log[name] = { errors, text: await list.innerText() };
  // Open it, for the facts the row carries.
  const head = page.locator('.project-open-item-row').first();
  await context.close();
}
console.log(JSON.stringify(log, null, 1));
await browser.close();
