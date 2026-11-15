// Real-build shots of the managed runner's entry for an existing account
// (docs/managed-runner-existing-account-entry-design.md, board 2), each beside the board.
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration
// fixtures answering every API call and the managed-runner routes answered from the shared state fixture:
//   node src/web/ui-migration/managed-runner-entry.capture.mjs [baseURL]
// Writes into docs/mocks/managed-runner-existing-account-entry/real-build/.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidToBase62 } from '@orbit/shared';
import { PATHS, installFixtures, installFixedDate } from './fixtures.mjs';
import { RUNNER, WORKSPACE } from './session-fixtures.mjs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:4173';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const board = `${repo}docs/mocks/managed-runner-existing-account-entry/`;
const out = `${board}real-build/`;
mkdirSync(out, { recursive: true });

const fixture = JSON.parse(readFileSync(`${repo}src/shared/src/managed-runner-states.fixture.json`, 'utf8'));
const state = (name) => fixture.states.find((s) => s.name === name).status;

// The board's account: a workstation online, a laptop offline, the orbit workspace.
const LAPTOP = { ...RUNNER, id: uuidToBase62('0196e000-0000-7000-8000-000000000031'), name: 'laptop', online: false, activeSessions: 0 };
const WORKSTATION = { ...RUNNER, name: 'workstation' };
const preparing = state('preparing: requested');
const MANAGED = { ...RUNNER, id: preparing.runnerId, name: 'managed', online: false, activeSessions: 0, engines: [] };
// Once it has reported: online, its version and engines, READY.
// It runs the current runner image, so it reports what a current runner does (its resources, DeepSeek Harness).
const MANAGED_READY = {
  ...RUNNER, id: preparing.runnerId, name: 'managed', online: true, activeSessions: 0, version: '0.1.250',
  lastHeartbeatAt: '2026-09-28T11:59:50.000Z', capabilities: ['machine-resources/v1', 'provider:dsh'],
};
const READING = {
  at: '2026-09-28T11:59:50.000Z',
  latest: { cpuPercent: 3, cpuCores: 4, load1: 0.1, memTotalBytes: 8 * 2 ** 30, memAvailableBytes: 7 * 2 ** 30,
    diskTotalBytes: 20 * 2 ** 30, diskFreeBytes: 18 * 2 ** 30 },
  samples: [],
};
let ready = false;
const MANAGED_WORKSPACE = { ...WORKSPACE, id: preparing.workspaceId, name: 'managed', runnerId: MANAGED.id };

async function account(page) {
  await installFixedDate(page);
  const api = await installFixtures(page, { theme: 'light' });
  let status = state('no mapping, offered');
  // Registered after installFixtures, so these answer first.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    const json = (body) => route.fulfill({ status: 200, json: body });
    const mapped = status.runnerId != null;
    if (method === 'GET' && path === '/api/auth/capabilities') return json({ managedRunners: { enabled: true, contractVersion: 1 } });
    if (method === 'GET' && path === '/api/managed-runner') return json(ready ? state('available') : status);
    if (method === 'POST' && path === '/api/managed-runner/ensure') {
      status = preparing;
      return json(status);
    }
    if (method === 'GET' && path === '/api/runners') return json(mapped ? [WORKSTATION, LAPTOP, ready ? MANAGED_READY : MANAGED] : [WORKSTATION, LAPTOP]);
    if (method === 'GET' && path === '/api/workspaces') return json(mapped ? [{ ...WORKSPACE, name: 'orbit' }, MANAGED_WORKSPACE] : [{ ...WORKSPACE, name: 'orbit' }]);
    if (method === 'GET' && path === '/api/providers/mine') return json([{ id: 'k1', slug: 'anthropic', label: 'Anthropic', presetSlug: 'anthropic' }]);
    if (method === 'GET' && path === '/api/providers/pools') return json([]);
    if (method === 'GET' && path.startsWith('/api/workspaces/session-counts')) return json([]);
    if (method === 'GET' && path === `/api/runners/${MANAGED_READY.id}/resources` && ready) return json(READING);
    if (method === 'GET' && /^\/api\/runners\/[^/]+\/resources$/.test(path)) return json({ available: false });
    return route.fallback();
  });
  return api;
}

/** The real-build shot beside the board, as one image. */
async function beside(browser, shot, title) {
  const page = await browser.newPage({ viewport: { width: 2600, height: 1200 } });
  const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  await page.setContent(`<!doctype html><body style="margin:0;font:14px system-ui;background:#fff">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
      <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Board 2 (design)</figcaption>
        <img src="${img(`${board}board-2.png`)}" style="width:100%;border:1px solid #ddd"></figure>
      <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Real build: ${title}</figcaption>
        <img src="${img(`${out}${shot}`)}" style="width:100%;border:1px solid #ddd"></figure>
    </div></body>`);
  await page.screenshot({ path: `${out}${shot.replace('.png', '-beside-board.png')}`, fullPage: true });
  await page.close();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, baseURL, locale: 'en-US', timezoneId: 'UTC' });
await account(page);
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// 1. The entry: first in Machines, its page with the notice and the sentence.
await page.goto('/settings/general');
// The boot splash fades out over the first paint: wait until it is gone.
await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
await page.getByRole('link', { name: /Managed runner/ }).click();
await page.waitForURL('**/settings/machines/managed');
await page.locator('.managed-runner-notice').waitFor();
await page.waitForTimeout(600);
await settle();
await page.screenshot({ path: `${out}1-entry.png` });

// 2. Set up asks first.
await page.locator('.managed-runner-notice').getByRole('button', { name: 'Set up' }).click();
await page.getByText('Set up a managed runner?').waitFor();
await settle();
await page.screenshot({ path: `${out}2-confirmation.png` });

// 3. The answer: the runner's own machine page, its row in the shared words.
// The confirmation is portaled after the page: its Set up is the last one.
await page.getByRole('button', { name: 'Set up', exact: true }).last().click();
await page.waitForURL(`**/settings/machines/${MANAGED.id}`);
await page.locator('.settings-managed-state').waitFor();
await page.locator('.machine-head').waitFor();
await settle();
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}3-after-setup.png` });

// 5. The same runner once it reports: READY, with its version, the ordinary machine page.
ready = true;
await page.reload();
await page.locator('.settings-managed-state[data-kind="available"]').waitFor();
await page.locator('.machine-engines').waitFor();
await page.waitForTimeout(600);
await settle();
await page.screenshot({ path: `${out}5-once-ready.png` });

// 4. Asleep (the owner's 2026-11-14 ask): the fixture session's own runner is the managed one, asleep.
// The sidebar marks its workspace Asleep, never Offline; the composer says sending wakes it.
const asleep = await browser.newPage({ viewport: { width: 1280, height: 800 }, baseURL, locale: 'en-US', timezoneId: 'UTC' });
await installFixedDate(asleep);
await installFixtures(asleep, { theme: 'light' });
const sleeping = { ...state('sleeping'), runnerId: RUNNER.id, workspaceId: WORKSPACE.id };
await asleep.route('**/api/**', async (route) => {
  const { pathname: path } = new URL(route.request().url());
  const json = (body) => route.fulfill({ status: 200, json: body });
  if (path === '/api/auth/capabilities') return json({ managedRunners: { enabled: true, contractVersion: 1 } });
  if (path === '/api/managed-runner') return json(sleeping);
  if (path === '/api/runners') return json([{ ...RUNNER, online: false, activeSessions: 0 }]);
  return route.fallback();
});
await asleep.goto(PATHS.session);
await asleep.locator('.managed-runner-composer-line').waitFor();
await asleep.locator('.tp-workspace-icon-managed').first().hover();
await asleep.waitForTimeout(1500);
await asleep.screenshot({ path: `${out}4-asleep-sidebar-composer.png` });
await asleep.close();

await beside(browser, '1-entry.png', 'Settings → Machines, Managed runner · Set up');
await beside(browser, '2-confirmation.png', 'the confirmation before Set up');
await beside(browser, '3-after-setup.png', 'after Set up: the runner’s machine page, its row Preparing');
await beside(browser, '5-once-ready.png', 'the same runner once it reports: Ready, the ordinary machine page');
await browser.close();
console.log(`wrote ${out}`);
