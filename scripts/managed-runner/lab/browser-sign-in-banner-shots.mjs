#!/usr/bin/env node
// The sign-in request's banner in the browser tab on the lab (board docs/mocks/runner-browser/03-agent-tools.html ①,
// notes ④ ⑤): the web build, served by the web image's nginx.conf in front of the lab test server, while a Claude Code
// session on the managed runner waits in its browser_request_sign_in call.
//
// Headless Chromium signs in by the web's own storage, then, as the owner:
//   1. Waiting on you: the card for SITE; Open browser opens /runners/:id/browser in a new tab, in control, live, on the
//      page the agent was on (the remote Chrome's titles, read through DevTools inside the Pod), with the banner above
//      the bar. Shot (banner-in-control.png).
//   2. Done: control stops, the banner stays and the card is still PENDING. Shot (banner-after-done.png).
//   3. Take control, then I'm signed in: the banner goes and the card is DONE. Shot (banner-signed-in.png).
// Shots go to OUTDIR; one JSON object is printed. Tokens come from the environment and are never printed.
//
//   ORBIT_ACCESS_TOKEN=... IN_POD='["kubectl",...,"exec","-i","POD","-c","runner","--"]' \
//     node browser-sign-in-banner-shots.mjs http://127.0.0.1:13718 <site> OUTDIR
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const [base, site, out] = process.argv.slice(2);
if (!base || !site || !out || !process.env.ORBIT_ACCESS_TOKEN || !process.env.IN_POD) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... IN_POD=[...] browser-sign-in-banner-shots.mjs http://host:port <site> OUTDIR');
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
/** The sign-in request for SITE, as the owner reads it. */
const request = async (id) => {
  const r = await fetch(`${base}/api/owner-requests/${id}`, { headers: { Authorization: `Bearer ${process.env.ORBIT_ACCESS_TOKEN}` } });
  return r.json();
};
const openSignIn = async () => {
  const r = await fetch(`${base}/api/owner-requests?state=open`, { headers: { Authorization: `Bearer ${process.env.ORBIT_ACCESS_TOKEN}` } });
  const { requests } = await r.json();
  return requests.find((q) => q.kind === 'BROWSER_SIGN_IN' && q.browserSite === site && q.state === 'PENDING');
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
  const asked = await openSignIn();
  if (!asked) throw new Error(`no open sign-in request for ${site}`);
  report.requestId = asked.id;
  step('the open request', { state: asked.state, site: asked.browserSite, askedBy: asked.askedBySessionTitle });

  // ── 1. the card's Open browser: the tab in control, with the banner ────────────────────────────────────────
  const page = await context.newPage();
  await page.goto(`${base}/waiting`, { waitUntil: 'networkidle' });
  const row = page.locator('.owner-inbox-row', { hasText: `Sign in to ${site}` }).first();
  await row.waitFor({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Sign in' }).click();
  const card = row.locator('.owner-inbox-card');
  await card.getByText('Sign in needed · Orbit Cloud browser').waitFor({ timeout: 30_000 });
  await card.screenshot({ path: `${out}/banner-card.png` });
  const [tab] = await Promise.all([context.waitForEvent('page'), card.getByRole('button', { name: 'Open browser' }).click()]);
  await tab.waitForSelector('.rb-tab-foot .rb-link.is-live', { timeout: 120_000 });
  const banner = tab.locator('.rb-sign-in');
  await banner.waitFor({ timeout: 60_000 });
  await tab.waitForTimeout(2000);
  step('Open browser opened the tab, live, with the banner', {
    path: new URL(tab.url()).pathname,
    controlling: await tab.locator('.rb-tab.is-controlling').count(),
    banner: (await banner.locator('.rb-sign-in-text').innerText()).replace(/\s+/g, ' '),
    bannerButton: await banner.getByRole('button').innerText(),
    bannerAboveBar: await tab.evaluate(() => document.querySelector('.rb-sign-in')?.nextElementSibling?.classList.contains('rb-tab-bar') ?? false),
    remotePages: pageTitles(),
  });
  await tab.screenshot({ path: `${out}/banner-in-control.png` });

  // ── 2. Done alone: control stops, the banner and the card stay ─────────────────────────────────────────────
  await tab.locator('.rb-tab-bar').getByRole('button', { name: 'Done', exact: true }).click();
  await tab.waitForSelector('.rb-tab:not(.is-controlling)', { timeout: 30_000 });
  await tab.waitForTimeout(8000);
  step('Done pressed', {
    controlling: await tab.locator('.rb-tab.is-controlling').count(),
    banners: await tab.locator('.rb-sign-in').count(),
    requestState: (await request(asked.id)).state,
  });
  await tab.screenshot({ path: `${out}/banner-after-done.png` });

  // ── 3. Take control, then I'm signed in: the card DONE, the banner gone ────────────────────────────────────
  await tab.locator('.rb-tab-bar').getByRole('button', { name: 'Take control' }).click();
  await tab.waitForSelector('.rb-tab.is-controlling', { timeout: 30_000 });
  await banner.getByRole('button', { name: 'I’m signed in' }).click();
  await tab.locator('.rb-sign-in').waitFor({ state: 'detached', timeout: 30_000 });
  await tab.waitForTimeout(1500);
  const after = await request(asked.id);
  step('I’m signed in pressed', {
    banners: await tab.locator('.rb-sign-in').count(),
    controlling: await tab.locator('.rb-tab.is-controlling').count(),
    requestState: after.state,
    resolvedBy: after.resolvedByUserId ? 'the owner' : null,
  });
  await tab.screenshot({ path: `${out}/banner-signed-in.png` });
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
