// Walk the built web console (vite preview, /api proxied to the real apiserver) through the seven seeded sessions:
// sign in with the real form, open each session, read the list row's line and the header's word from the DOM, and
// screenshot the console.
// usage: node walk.mjs <walk dir> <web origin> <out dir> [playwright module path]
// Reads <walk>/seed.json, <walk>/pw and <walk>/api.json (api-read.mjs's output, for the public ids).
// Writes <out>/<case>.png, <out>/00-signed-in.png, <out>/dom.json and <out>/walk.log. Never prints the password.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [walk, origin, out, pwModule = '/root/orbit/node_modules/playwright'] = process.argv.slice(2);
if (!walk || !origin || !out) throw new Error('usage: walk.mjs <walk dir> <web origin> <out dir> [playwright]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(pwModule);
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const api = JSON.parse(fs.readFileSync(path.join(walk, 'api.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') logLines.push(`console.error: ${msg.text().slice(0, 300)}`); });
page.on('response', (res) => {
  const url = new URL(res.url());
  if (url.pathname.startsWith('/api/') && res.status() >= 400) logLines.push(`api ${res.status()} ${res.request().method()} ${url.pathname}`);
});

// The real sign-in form.
await page.goto(`${origin}/login`);
await page.fill('input[name="email"]', seed.ownerEmail);
await page.fill('input[name="password"]', password);
await page.click('button.login-submit');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
await page.waitForSelector('.session-row', { timeout: 30_000 }).catch(async (err) => {
  // Keep what the page showed instead of the list, then fail as before.
  await page.screenshot({ path: path.join(out, '00-no-session-list.png') });
  fs.writeFileSync(path.join(out, 'walk.log'), `no session list 30 s after sign-in, at ${new URL(page.url()).pathname}\n`);
  throw err;
});
await page.screenshot({ path: path.join(out, '00-signed-in.png') });
log(`signed in; landed on ${new URL(page.url()).pathname}`);

/** What the page says for one session, read until it holds still for 1.5 s (the detail read can land after the row). */
async function readCase(title) {
  let last = null;
  let stableSince = Date.now();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('.session-row')]
        .filter((r) => r.querySelector('.session-title')?.textContent?.trim() === t);
      const row = rows[0] ?? null;
      const preview = row?.querySelector('.session-preview') ?? null;
      const name = document.querySelector('.workspace-name')?.textContent?.trim() ?? null;
      const sub = document.querySelector('.workspace-sub:not([data-fork-source])')?.textContent?.trim() ?? null;
      return {
        rowsWithTitle: rows.length,
        rowActive: row?.classList.contains('active') ?? null,
        rowLine: preview?.textContent?.trim() ?? null,
        rowLineClass: preview?.className ?? null,
        rowLineTitle: preview?.getAttribute('title') ?? null,
        headerName: name,
        headerSub: sub,
        // The approval card, where there is one: whether it can be answered, and the line a dead card carries.
        approveButtonDisabled: [...document.querySelectorAll('button')].find((b) => (b.textContent?.trim() ?? '').startsWith('Approve'))?.disabled ?? null,
        approvalStaleNote: document.querySelector('.approval-stale')?.textContent?.trim() ?? null,
        // The composer's Stop (WorkspaceView `showStop`), and the row glyph: its icon class, and whether it spins.
        stopVisible: (() => {
          const stop = document.querySelector('button[aria-label="Stop"]');
          return !!stop && stop.getClientRects().length > 0;
        })(),
        rowGlyph: row?.querySelector('.session-icon .anticon')?.getAttribute('class') ?? row?.querySelector('.session-icon > *')?.getAttribute('class') ?? null,
        rowSpinner: !!row?.querySelector('.session-icon .anticon-spin, .session-icon .anticon-loading'),
        // The list group the row sits in: its <section>'s head (sessionTimeSections: Needs you, Working, Today, ...).
        rowSection: row?.closest('section')?.querySelector(':scope > .session-section-head')?.textContent?.trim() ?? null,
      };
    }, title);
    const key = JSON.stringify(now);
    if (key !== last) { last = key; stableSince = Date.now(); }
    const ready = now.rowsWithTitle > 0 && now.headerName === title && now.headerSub && now.headerSub !== 'Starting…';
    if (ready && Date.now() - stableSince >= 1500) return now;
    if (Date.now() > deadline) return { ...now, timedOut: true };
    await page.waitForTimeout(250);
  }
}

/** The row glyph's tooltip: hover the row's status icon and read the tooltip that appears (best effort). */
async function glyphWord(title) {
  const row = page.locator('.session-row', { has: page.locator('.session-title', { hasText: title }) }).first();
  const icon = row.locator('.session-icon').first();
  try {
    await icon.hover({ timeout: 3_000 });
    const tip = page.locator('[role="tooltip"]:visible, .ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner').last();
    await tip.waitFor({ state: 'visible', timeout: 2_000 });
    const text = (await tip.textContent())?.trim() ?? null;
    await page.mouse.move(1400, 880);
    return text;
  } catch {
    await page.mouse.move(1400, 880);
    return null;
  }
}

const dom = {};
for (const [key, c] of Object.entries(api.cases)) {
  const publicId = c.publicId;
  await page.goto(`${origin}/sessions/${publicId}`);
  const read = await readCase(c.title);
  await page.mouse.move(1400, 880);
  await page.screenshot({ path: path.join(out, `${key}.png`) });
  const glyph = await glyphWord(c.title);
  const headerWord = read.headerSub ? read.headerSub.split(' · ')[0] : null;
  dom[key] = { title: c.title, publicId, url: new URL(page.url()).pathname, ...read, headerWord, glyphTooltip: glyph };
  log(`${key.padEnd(14)} row=${JSON.stringify(read.rowLine)} header=${JSON.stringify(read.headerSub)} glyph=${JSON.stringify(glyph)}${read.timedOut ? ' TIMED OUT' : ''}`);
}

fs.writeFileSync(path.join(out, 'dom.json'), JSON.stringify(dom, null, 2));
fs.writeFileSync(path.join(out, 'walk.log'), `${logLines.join('\n')}\n`);
await browser.close();
