#!/usr/bin/env node
// Real-page shots of the web build with the managed runner browser switch absent (docs/runner-browser-design.md §2, off
// means absent): the owner's session page on the Orbit Cloud runner, where the Browser chip would be, and Settings → the
// Orbit Cloud runner's page, where the Browser section would be. The web build is served by the web image's nginx.conf
// in front of the lab test server, so every answer, the browser routes' 404 included, is the server's own.
//
// Headless Chromium signs in by the web's own storage (orbit_token, orbit_refresh), opens each page, waits for it to
// settle, and records what the page asked of the browser routes and whether a Browser chip or section is in the DOM.
// Prints one JSON object; the tokens are read from the environment and never printed.
//
//   ORBIT_ACCESS_TOKEN=... ORBIT_REFRESH_TOKEN=... node browser-absent-shots.mjs http://127.0.0.1:13718 <sessionId> <runnerId> OUTDIR
import { chromium } from '@playwright/test';

const [base, sessionId, runnerId, out] = process.argv.slice(2);
if (!base || !sessionId || !runnerId || !out || !process.env.ORBIT_ACCESS_TOKEN) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... browser-absent-shots.mjs http://host:port <sessionId> <runnerId> OUTDIR');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addInitScript(
  ([access, refresh]) => {
    localStorage.setItem('orbit_token', access);
    if (refresh) localStorage.setItem('orbit_refresh', refresh);
  },
  [process.env.ORBIT_ACCESS_TOKEN, process.env.ORBIT_REFRESH_TOKEN ?? ''],
);
const page = await context.newPage();
const browserRoutes = [];
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  if (/^\/api\/runners\/[^/]+\/browser/.test(path)) browserRoutes.push({ path, status: response.status() });
});

async function shot(name, path, ready) {
  const before = browserRoutes.length;
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${name}.png` });
  return {
    path,
    ready,
    url: new URL(page.url()).pathname,
    browserRoutes: browserRoutes.slice(before),
    chips: await page.locator('.rb-chip').count(),
    drawers: await page.locator('.rb-drawer').count(),
    browserSections: await page.locator('.machine-section-browser').count(),
    openBrowserButtons: await page.getByRole('button', { name: 'Open browser' }).count(),
    clearSavedLogins: await page.getByText('Clear saved logins').count(),
    png: `${out}/${name}.png`,
  };
}

const result = { ok: false };
try {
  result.session = await shot('session-page', `/sessions/${sessionId}`, 'textarea');
  result.settings = await shot('settings-runner-page', `/settings/machines/${runnerId}`, '.machine-section-engines');
  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 400);
  await page.screenshot({ path: `${out}/failed.png` }).catch(() => {});
}
await browser.close();
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
