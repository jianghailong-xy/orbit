// Real-build shots of the composer's `@` sessions and `#` projects popup, round 2
// (docs/mocks/session-at-references/board-at-menu.html, parts 1 to 3).
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration fixtures
// answering every API call and the search and project routes answered here:
//   node src/web/ui-migration/session-at-menu.capture.mjs [baseURL]
// Writes into docs/mocks/session-at-references/real/.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures } from './fixtures.mjs';
import { SESSION, SESSION_PATH } from './session-fixtures.mjs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:4173';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = `${repo}docs/mocks/session-at-references/real/`;
mkdirSync(out, { recursive: true });

const NOW = Date.parse('2026-11-28T10:42:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const id = (n) => uuidToBase62(`0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a${String(n).padStart(2, '0')}`);

/** Recent sessions, newest first: the current one and a task run among them, as on production. */
const HITS = [
  { id: SESSION.id, title: SESSION.title, agent: { id: 'w1', name: 'orbit-ws01' }, taskId: null, phase: 'RUNNING', lastTurnAt: ago(0) },
  { id: id(1), title: '会话列表状态展示设计', agent: { id: 'w1', name: 'orbit-ws01' }, taskId: null, phase: 'RUNNING', lastTurnAt: ago(0) },
  { id: id(2), title: 'Task: Android: complete asks first when a question waits', agent: { id: 'w2', name: 'orbit-android' }, taskId: id(90), phase: 'RUNNING', lastTurnAt: ago(2) },
  { id: id(3), title: 'Deploy main to staging', agent: { id: 'w3', name: 'orbit-prod' }, taskId: null, phase: 'IDLE', lastTurnOutcome: 'FAILED', lastTurnAt: ago(12) },
  { id: id(4), title: 'Coordinator · Runner link hardening', agent: { id: 'w4', name: 'orbit-ws04' }, taskId: null, phase: 'IDLE', waitingOn: 'PERSON', lastTurnAt: ago(60) },
  { id: id(5), title: '优化 Task 卡片渲染效果', agent: { id: 'w1', name: 'orbit-ws01' }, taskId: null, phase: 'IDLE', lastTurnAt: ago(180) },
  { id: id(6), title: '[运维·常驻] 夜间清理僵尸会话 v2（每 10 分钟一次）', agent: { id: 'w5', name: 'orbit-data' }, taskId: null, phase: 'IDLE', lastTurnAt: ago(1500) },
  { id: id(7), title: 'Upgrade compose stack', agent: { id: 'w4', name: 'orbit-ws04' }, taskId: null, phase: 'IDLE', lastTurnAt: ago(7200), branch: 'orbit/deploy-fix' },
];

const PROJECTS = [
  { id: id(20), title: 'Runner link hardening', status: 'OPEN', createdAt: ago(9000), lastActivityAt: ago(5), buckets: { running: 1 }, taskCounts: { done: 11, failed: 1, total: 14 } },
  { id: id(21), title: 'Claude region check', status: 'OPEN', createdAt: ago(9000), lastActivityAt: ago(60), buckets: { running: 0 }, taskCounts: { done: 4, failed: 0, total: 6 } },
  { id: id(22), title: 'Drive directory sync', status: 'OPEN', createdAt: ago(9000), lastActivityAt: ago(4000), buckets: { running: 0 }, taskCounts: { done: 2, failed: 0, total: 9 } },
];

function search(q) {
  const needle = q.toLowerCase();
  const hits = HITS.filter((hit) => !needle || hit.title.toLowerCase().includes(needle) || (hit.branch ?? '').includes(needle))
    .map(({ branch, ...hit }) => ({
      status: 'IDLE', runStatus: 'IDLE', sessionState: 'IDLE', runState: 'IDLE', lifecycleState: 'OPEN', filingState: 'OPEN',
      runnerId: 'r1', taskTitle: null, listedAt: hit.lastTurnAt, createdAt: ago(10000), completedAt: null, archivedAt: null,
      deletedAt: null, endReason: null, sessionKind: 'CONVERSATION', ...hit,
      // As the server answers: a match on the branch names it, a blank query is recents.
      ...(!needle ? { matchField: 'recent', snippet: null }
        : hit.title.toLowerCase().includes(needle) ? { matchField: 'title', snippet: null }
          : { matchField: 'branch', snippet: branch }),
    }));
  return { q, contentSearched: false, total: hits.length, hits };
}

async function scene(browser, dark = false) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 820 }, deviceScaleFactor: 2, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  await page.clock.install({ time: NOW });
  await installFixtures(page, { theme: dark ? 'dark' : 'light' });
  await page.route('**/api/**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === '/api/sessions/search') return route.fulfill({ status: 200, json: search(searchParams.get('q') ?? '') });
    if (pathname === '/api/projects/sidebar') return route.fulfill({ status: 200, json: PROJECTS });
    return route.fallback();
  });
  await page.goto(SESSION_PATH);
  await page.locator('.composer-field textarea').waitFor();
  return page;
}

/** The composer and the popup above it. */
async function shoot(page, name) {
  const box = await page.locator('.composer-box').boundingBox();
  const menu = await page.locator('.composer-ref-menu').boundingBox().catch(() => null);
  const top = Math.min(box.y, menu?.y ?? box.y) - 16;
  await page.screenshot({ path: `${out}${name}.png`, clip: { x: box.x - 16, y: top, width: box.width + 32, height: box.y + box.height - top + 16 } });
}

const browser = await chromium.launch();
const type = async (page, text) => {
  const area = page.locator('.composer-field textarea');
  await area.fill('');
  await area.pressSequentially(text, { delay: 15 });
  await page.waitForTimeout(400);
};

for (const dark of [false, true]) {
  const page = await scene(browser, dark);
  const suffix = dark ? '-dark' : '';
  await type(page, 'why does this still show Running? @');
  await shoot(page, `1-at-recent${suffix}`);
  if (!dark) {
    await type(page, 'compare with @dep');
    await shoot(page, '2-at-search');
    await type(page, 'compare with @zzz');
    await shoot(page, '3-at-nothing');
    await type(page, 'what is left in #');
    await shoot(page, '4-hash-projects');
    // Pick, then one Backspace takes the whole chip.
    await type(page, 'see @Deploy');
    await page.keyboard.press('Enter');
    await page.keyboard.type('why?');
    await page.waitForTimeout(200);
    await shoot(page, '5-chip-before-backspace');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    await shoot(page, '6-chip-after-backspace');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(200);
    await shoot(page, '7-chip-after-undo');
  }
  await page.close();
}
await browser.close();
console.log(`wrote ${out}`);
