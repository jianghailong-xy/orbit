// Open the two-run task's panel in the console and read each run's badge from the DOM (TaskDetailPanel `runRow`:
// `a.tdp-session` -> `.tdp-badge`), matched to the seeded runs by the row's link (`/sessions/<public id>`).
// usage: node walk-task.mjs <walk dir> <web origin> <out dir> [playwright module path]
// Reads <walk>/seed.json, <walk>/pw and <walk>/api.json (api-read.mjs's output, for the public ids).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [walk, origin, out, pwModule = '/root/orbit/node_modules/playwright'] = process.argv.slice(2);
if (!walk || !origin || !out) throw new Error('usage: walk-task.mjs <walk dir> <web origin> <out dir> [playwright]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(pwModule);
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const api = JSON.parse(fs.readFileSync(path.join(walk, 'api.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await context.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text().slice(0, 300)}`); });
page.on('response', (res) => {
  const url = new URL(res.url());
  if (url.pathname.startsWith('/api/') && res.status() >= 400) errors.push(`api ${res.status()} ${res.request().method()} ${url.pathname}`);
});
await page.goto(`${origin}/login`);
await page.fill('input[name="email"]', seed.ownerEmail);
await page.fill('input[name="password"]', password);
await page.click('button.login-submit');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

const result = {};
for (const [key, t] of Object.entries(api.tasks ?? {})) {
  await page.goto(`${origin}/tasks/${t.publicId}`);
  await page.waitForSelector('a.tdp-session', { timeout: 30_000 });
  // Read until the rows hold still for 1.5 s.
  let last = null;
  let stableSince = Date.now();
  let rows = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    rows = await page.evaluate(() => [...document.querySelectorAll('a.tdp-session')].map((a) => ({
      href: a.getAttribute('href'),
      title: a.querySelector('.tdp-session-title')?.textContent?.trim() ?? null,
      sub: a.querySelector('.tdp-session-sub')?.textContent?.trim() ?? null,
      badge: a.querySelector('.tdp-badge')?.textContent?.trim() ?? null,
      badgeClass: a.querySelector('.tdp-badge')?.getAttribute('class') ?? null,
      dotClass: a.querySelector('.tdp-dot')?.getAttribute('class') ?? null,
    })));
    const k = JSON.stringify(rows);
    if (k !== last) { last = k; stableSince = Date.now(); }
    if (rows.length > 0 && Date.now() - stableSince >= 1500) break;
    await page.waitForTimeout(250);
  }
  const runs = {};
  for (const [runKey, run] of Object.entries(t.runs)) {
    runs[runKey] = rows.find((r) => r.href === `/sessions/${run.publicId}`) ?? null;
  }
  // The runs sit in the panel's activity list; bring the first one into view before the picture.
  await page.locator('a.tdp-session').first().scrollIntoViewIfNeeded();
  await page.mouse.move(10, 880);
  await page.screenshot({ path: path.join(out, `task-${key}.png`) });
  result[key] = { url: new URL(page.url()).pathname, rows, runs };
  for (const [runKey, r] of Object.entries(runs)) console.log(`${key}/${runKey}: badge=${JSON.stringify(r?.badge ?? null)} (${r?.badgeClass ?? 'no row'})`);
}
fs.writeFileSync(path.join(out, 'task.json'), JSON.stringify({ result, errors }, null, 2));
if (errors.length) console.log(errors.join('\n'));
await browser.close();
