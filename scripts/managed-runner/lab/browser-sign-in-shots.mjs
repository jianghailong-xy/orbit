#!/usr/bin/env node
// browser_request_sign_in's card on the lab (board docs/mocks/runner-browser/03-agent-tools.html ①): the web build, served
// by the web image's nginx.conf in front of the lab test server, while a real Claude Code session on the managed runner
// waits in its browser_request_sign_in call.
//
// Headless Chromium signs in by the web's own storage, then:
//   1. Waiting on you: the row "Sign in to SITE" opens the BROWSER_SIGN_IN card; its words are read and it is shot.
//   2. Open browser opens /runners/:id/browser in a new tab, in control, and goes live; the remote Chrome is still on the
//      page the agent was on (its title, read through DevTools inside the Pod). Shot.
//   3. With CLICK_TO_TITLE set: the owner signs in on the remote page, a click on the viewer's middle (the lab's provider
//      page is one button), and the remote Chrome's page comes to that title (the page after the sign-in). Shot.
// Pressing nothing else: the answer is the driver's to give. Shots go to OUTDIR; one JSON object is printed. Tokens come
// from the environment and are never printed.
//
//   ORBIT_ACCESS_TOKEN=... IN_POD='["kubectl",...,"exec","-i","POD","-c","runner","--"]' \
//     node browser-sign-in-shots.mjs http://127.0.0.1:13718 <site> OUTDIR
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const [base, site, out] = process.argv.slice(2);
if (!base || !site || !out || !process.env.ORBIT_ACCESS_TOKEN || !process.env.IN_POD) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... IN_POD=[...] browser-sign-in-shots.mjs http://host:port <site> OUTDIR');
  process.exit(2);
}
const inPod = JSON.parse(process.env.IN_POD);
const report = { steps: [] };
const step = (what, detail = {}) => report.steps.push({ at: new Date().toISOString(), what, ...detail });
const pageTitles = () => {
  const raw = execFileSync(inPod[0], [...inPod.slice(1), 'node', '--input-type=module', '-e',
    "const l=await (await fetch('http://127.0.0.1:9222/json/list')).json();" +
    "console.log(JSON.stringify(l.filter((t)=>t.type==='page').map((t)=>t.title)))"], { encoding: 'utf8', timeout: 60_000 });
  return JSON.parse(raw.trim().split('\n').pop());
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
await context.addInitScript(
  ([access, refresh]) => {
    localStorage.setItem('orbit_token', access);
    if (refresh) localStorage.setItem('orbit_refresh', refresh);
  },
  [process.env.ORBIT_ACCESS_TOKEN, process.env.ORBIT_REFRESH_TOKEN ?? ''],
);
try {
  // ── 1. the card in Waiting on you ──────────────────────────────────────────────────────────────────────────
  const page = await context.newPage();
  await page.goto(`${base}/waiting`, { waitUntil: 'networkidle' });
  const row = page.locator('.owner-inbox-row', { hasText: `Sign in to ${site}` }).first();
  await row.waitFor({ timeout: 60_000 });
  step('Waiting on you lists the request', { row: (await row.locator('.owner-inbox-row-line').innerText()).replace(/\s+/g, ' ') });
  await row.getByRole('button', { name: 'Sign in' }).click();
  const card = row.locator('.owner-inbox-card');
  await card.getByText('Sign in needed · Orbit Cloud browser').waitFor({ timeout: 30_000 });
  const words = (await card.innerText()).replace(/\s+/g, ' ');
  step('the card', {
    words,
    namesSite: words.includes(`Sign in to ${site}`),
    quotesReason: /“[^”]+”/.test(words),
    fromSession: /From session \S/.test(words),
    signsInThemselves: words.includes('You sign in yourself; Orbit never sees your password.'),
    everyAgent: words.includes('The login stays on this runner, and every agent on it can use it.'),
    buttons: await card.getByRole('button').allInnerTexts(),
  });
  await card.screenshot({ path: `${out}/01-sign-in-card.png` });
  await page.screenshot({ path: `${out}/01-waiting-on-you.png` });

  // ── 2. Open browser: the tab, in control, on the agent's page ──────────────────────────────────────────────
  const [tab] = await Promise.all([context.waitForEvent('page'), card.getByRole('button', { name: 'Open browser' }).click()]);
  await tab.waitForSelector('.rb-tab-foot .rb-link.is-live', { timeout: 120_000 });
  await tab.waitForTimeout(1500);
  step('Open browser opened the tab, live', {
    path: new URL(tab.url()).pathname,
    search: new URL(tab.url()).search,
    controlling: await tab.locator('.rb-tab.is-controlling').count(),
    remotePages: pageTitles(),
  });
  await tab.screenshot({ path: `${out}/02-browser-tab-in-control.png` });

  // ── 3. the owner signs in on the remote page, through the viewer ─────────────────────────────────────────────
  const after = process.env.CLICK_TO_TITLE;
  if (after) {
    const screen = tab.locator('.rb-screen canvas').first();
    await screen.waitFor({ timeout: 30_000 });
    await screen.click();
    let titles = [];
    for (let i = 0; i < 60 && !titles.includes(after); i++) {
      await tab.waitForTimeout(1000);
      titles = pageTitles();
    }
    step('the owner clicked on the viewer', { remotePages: titles, reached: titles.includes(after) });
    await tab.waitForTimeout(1500);
    await tab.screenshot({ path: `${out}/03-after-owner-sign-in.png` });
    if (!titles.includes(after)) throw new Error(`the remote page did not come to "${after}"`);
  }
  await tab.close();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.message ?? error);
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
