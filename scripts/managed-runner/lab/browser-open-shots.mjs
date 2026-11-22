#!/usr/bin/env node
// browser_open on the lab with the switch on (board docs/mocks/runner-browser/03-agent-tools.html ②): the tab address
// browser_open answered, opened in headless Chromium signed in by the web's own storage, as the owner would open it.
// It waits for the viewer to go live on the runner's Chrome and takes a shot of what the remote Chrome shows.
// One JSON object is printed. Tokens come from the environment and are never printed.
//
//   ORBIT_ACCESS_TOKEN=... node browser-open-shots.mjs http://127.0.0.1:13718 /runners/<id>/browser OUTDIR NAME
import { chromium } from '@playwright/test';

const [base, tabPath, out, name] = process.argv.slice(2);
if (!base || !tabPath || !out || !name || !process.env.ORBIT_ACCESS_TOKEN) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... browser-open-shots.mjs http://host:port /runners/<id>/browser OUTDIR NAME');
  process.exit(2);
}
const browser = await chromium.launch();
const report = {};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('orbit_token', access);
      if (refresh) localStorage.setItem('orbit_refresh', refresh);
    },
    [process.env.ORBIT_ACCESS_TOKEN, process.env.ORBIT_REFRESH_TOKEN ?? ''],
  );
  const tab = await context.newPage();
  await tab.goto(`${base}${tabPath}`, { waitUntil: 'networkidle' });
  await tab.waitForSelector('.rb-tab-foot .rb-link.is-live', { timeout: 120_000 });
  // Let the first full frame of the remote screen arrive.
  await tab.waitForTimeout(3000);
  report.path = new URL(tab.url()).pathname;
  report.title = await tab.title();
  report.bar = await tab.locator('.rb-tab-title').first().textContent();
  report.live = true;
  await tab.screenshot({ path: `${out}/${name}.png` });
  report.shot = `${name}.png`;
} catch (err) {
  report.error = String(err && err.message ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
console.log(JSON.stringify(report));
