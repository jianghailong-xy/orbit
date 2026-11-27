// A/B for the RUNNING-reads-parked finding: the same console and server, but every /api/sessions* JSON answer has
// `activity` nulled on rows stored RUNNING (nothing else touched). If the control then reads "Running" and the
// approval card becomes answerable, the list row's `activity: "TURN"` is what turns them into a parked reading.
// usage: node walk-ab.mjs <walk dir> <web origin> <out dir> [playwright module path]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [walk, origin, out, pwModule = '/root/orbit/node_modules/playwright'] = process.argv.slice(2);
if (!walk || !origin || !out) throw new Error('usage: walk-ab.mjs <walk dir> <web origin> <out dir> [playwright]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(pwModule);
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const api = JSON.parse(fs.readFileSync(path.join(walk, 'api.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();

let rewritten = 0;
const nullRunningActivity = (node) => {
  if (Array.isArray(node)) { node.forEach(nullRunningActivity); return; }
  if (!node || typeof node !== 'object') return;
  if (node.status === 'RUNNING' && typeof node.activity === 'string') { node.activity = null; rewritten += 1; }
  Object.values(node).forEach(nullRunningActivity);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
// The list and the detail only (`/api/sessions`, `/api/sessions/<id>`): never the `/events` stream, which never ends.
await context.route(/\/api\/sessions(\/[^/?]+)?(\?.*)?$/, async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const type = res.headers()['content-type'] ?? '';
  if (!type.includes('application/json')) return route.fulfill({ response: res });
  const body = await res.json();
  nullRunningActivity(body);
  return route.fulfill({ response: res, json: body });
});
const page = await context.newPage();
await page.goto(`${origin}/login`);
await page.fill('input[name="email"]', seed.ownerEmail);
await page.fill('input[name="password"]', password);
await page.click('button.login-submit');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
await page.waitForSelector('.session-row', { timeout: 30_000 });

const result = {};
for (const key of ['control-running', 'approval']) {
  const c = api.cases[key];
  await page.goto(`${origin}/sessions/${c.publicId}`);
  await page.waitForFunction((t) => document.querySelector('.workspace-name')?.textContent?.trim() === t, c.title, { timeout: 30_000 });
  // The transcript has loaded once its empty-state line or a card is drawn; then let the reads settle.
  await page.waitForSelector('.approval-stale, button:has-text("Approve"), :text("Waiting for the workspace")', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
  result[key] = await page.evaluate((t) => {
    const row = [...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-title')?.textContent?.trim() === t);
    return {
      rowLine: row?.querySelector('.session-preview')?.textContent?.trim() ?? null,
      headerSub: document.querySelector('.workspace-sub:not([data-fork-source])')?.textContent?.trim() ?? null,
      approveButtonDisabled: [...document.querySelectorAll('button')].find((b) => (b.textContent?.trim() ?? '').startsWith('Approve'))?.disabled ?? null,
      approvalStaleNote: document.querySelector('.approval-stale')?.textContent?.trim() ?? null,
    };
  }, c.title);
  await page.mouse.move(1400, 880);
  await page.screenshot({ path: path.join(out, `ab-${key}.png`) });
  console.log(`${key.padEnd(16)} ${JSON.stringify(result[key])}`);
}
console.log(`rows rewritten: ${rewritten}`);
fs.writeFileSync(path.join(out, 'ab.json'), JSON.stringify({ rewritten, result }, null, 2));
await browser.close();
