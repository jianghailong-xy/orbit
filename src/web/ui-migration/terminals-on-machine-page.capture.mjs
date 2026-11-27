// Real-build shots of a machine page's approved Terminals (docs/mocks/terminals-on-machine-page/01-board.html), each beside
// the board: a machine with two approved terminals (and one waiting), a machine with none, and the first after a Revoke.
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration fixtures answering
// every API call and /terminals answered here:
//   node src/web/ui-migration/terminals-on-machine-page.capture.mjs <outDir> <boardPng> [baseURL]
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, installFixtures, installFixedDate } from './fixtures.mjs';
import { RUNNER, WORKSPACE } from './session-fixtures.mjs';

const [out = '/tmp/terminals-shots/', boardPng, baseURL = 'http://127.0.0.1:4173'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const DAY = 86_400_000;
const at = (ms) => new Date(Date.parse(FIXED_NOW) + ms).toISOString();
// The board's two machines: dev-laptop with two approved terminals and one waiting, build-box with none.
const DEV = { ...RUNNER, name: 'dev-laptop', hostname: 'dev-laptop.local', version: '0.1.261', lastHeartbeatAt: at(-12_000) };
const BUILD = {
  ...RUNNER, id: uuidToBase62('0196e000-0000-7000-8000-000000000031'), name: 'build-box', hostname: 'build-box',
  version: '0.1.261', lastHeartbeatAt: at(-4_000), activeSessions: 0, maxConcurrent: 8,
};
const terminal = (id, approvedAgo, lastUsedAgo, expiresIn) => ({
  id, machineName: 'dev-laptop', runnerId: DEV.id, createdAt: at(-approvedAgo), approvedAt: at(-approvedAgo),
  lastUsedAt: lastUsedAgo == null ? null : at(-lastUsedAgo), expiresAt: at(expiresIn),
});
let terminals = [terminal('34term-old', 4 * DAY, 3 * 3_600_000, 26 * DAY), terminal('34term-new', DAY, null, 29 * DAY)];
const request = {
  id: '34req1', userCode: '7KQ-4MZ', machineName: 'dev-laptop', runnerId: DEV.id, createdAt: at(-60_000), expiresAt: at(9 * 60_000),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, baseURL, locale: 'en-US', timezoneId: 'UTC' });
await installFixedDate(page);
await installFixtures(page, { theme: 'light' });
// Registered after installFixtures, so these answer first.
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const { pathname: path } = new URL(req.url());
  const method = req.method();
  const json = (body) => route.fulfill({ status: 200, json: body });
  if (method === 'GET' && path === '/api/runners') return json([DEV, BUILD]);
  if (method === 'GET' && path === '/api/workspaces') return json([{ ...WORKSPACE, name: 'orbit', runnerId: DEV.id }]);
  if (method === 'GET' && path === '/api/terminals') return json({ terminals });
  if (method === 'GET' && path === '/api/terminals/requests') return json({ requests: [request] });
  if (method === 'DELETE' && path.startsWith('/api/terminals/')) {
    const id = path.slice('/api/terminals/'.length);
    terminals = terminals.filter((t) => t.id !== id);
    return json({ id });
  }
  if (method === 'GET' && /^\/api\/runners\/[^/]+\/resources$/.test(path)) return json({ available: false });
  return route.fallback();
});
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The page scrolls in its own column: bring Workspaces → Terminals → About into view, its top under the window's top. */
const toWorkspaces = () => page.locator('.machine-section-workspaces').evaluate((el) => el.scrollIntoView({ block: 'start' }));

async function shoot(path, name, ready) {
  await page.goto(path);
  await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
  await page.locator('.machine-section-about').waitFor();
  await ready();
  await page.waitForTimeout(600);
  await settle();
  await page.screenshot({ path: `${out}${name}` });
}

// A: dev-laptop, two approved terminals (newest first) and one waiting under the title.
// Its top first: the waiting card under the title, unchanged, with the approve card's new sentence.
await shoot(`/settings/machines/${DEV.id}`, 'web-0-top-waiting.png', () => page.locator('.machine-section-terminals').waitFor());
await page.locator('.machine-section-terminals').waitFor();
await toWorkspaces();
await settle();
await page.screenshot({ path: `${out}web-1-approved.png` });
// B: build-box, none approved: no section.
await shoot(`/settings/machines/${BUILD.id}`, 'web-2-none.png', async () => {
  if (await page.locator('.machine-section-terminals').count()) throw new Error('build-box drew a Terminals section');
  await toWorkspaces();
});
// C: dev-laptop after revoking the older terminal: today's confirm, then the row leaves and the toast says so.
await shoot(`/settings/machines/${DEV.id}`, 'web-3-revoke-confirm.png', async () => {
  await toWorkspaces();
  await page.locator('[data-setting-anchor="terminal-34term-old"]').getByRole('button', { name: 'Revoke' }).click();
  await page.getByText('Revoke the terminal on dev-laptop?').waitFor();
});
await page.getByRole('button', { name: 'Revoke', exact: true }).last().click();
await page.locator('[data-setting-anchor="terminal-34term-old"]').waitFor({ state: 'detached' });
await page.getByText('Terminal revoked').waitFor();
await settle();
await page.screenshot({ path: `${out}web-4-after-revoke.png` });

if (boardPng) {
  const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  for (const [shot, title] of [
    ['web-1-approved.png', 'A — dev-laptop: two approved terminals, one waiting'],
    ['web-2-none.png', 'B — build-box: no approved terminal, no section'],
    ['web-4-after-revoke.png', 'After Revoke: the older terminal is gone'],
  ]) {
    const side = await browser.newPage({ viewport: { width: 2600, height: 1200 } });
    await side.setContent(`<!doctype html><body style="margin:0;font:14px system-ui;background:#fff">
      <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
        <figure style="margin:0;flex:1.4"><figcaption style="margin-bottom:8px;color:#555">Board (design, 264b0b556)</figcaption>
          <img src="${img(boardPng)}" style="width:100%;border:1px solid #ddd"></figure>
        <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Real build: ${title}</figcaption>
          <img src="${img(`${out}${shot}`)}" style="width:100%;border:1px solid #ddd"></figure>
      </div></body>`);
    await side.screenshot({ path: `${out}${shot.replace('.png', '-beside-board.png')}`, fullPage: true });
    await side.close();
  }
}
await browser.close();
console.log(`wrote ${out}`);
