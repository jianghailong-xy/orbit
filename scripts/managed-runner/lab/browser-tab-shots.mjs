#!/usr/bin/env node
// The managed runner browser in a tab of its own, on the lab with the switch on (docs/runner-browser-design.md §5,
// board docs/mocks/runner-browser/02-control-view frames ② and ③). The web build is served by the web image's
// nginx.conf in front of the lab test server; the runner is a real managed runner Pod with its Xvfb, Chrome and x11vnc.
//
// Headless Chromium signs in by the web's own storage, then:
//   1. Settings → the runner → Open browser opens /runners/:id/browser in a new tab, in control; it goes Live.
//   2. The remote Chrome is sent to a page with two fields (DevTools, from inside the Pod); the viewer clicks the first
//      through VNC, the local clipboard gets PASTE_TEXT, ⌘V/Ctrl+V is pressed in the viewer, and the field's value is
//      read back from inside the Pod: it must be PASTE_TEXT exactly, once.
//   3. The second field is selected in the remote Chrome and Ctrl+C pressed through the viewer: its text must reach the
//      local clipboard.
//   4. 100% and Fit; Done: view only, and a paste then reaches nothing.
//   5. With a session id: the session's drawer (a view-only quick look) hands its stream to the tab with Open in new tab.
// Shots go to OUTDIR; one JSON object is printed. Tokens come from the environment and are never printed.
//
//   ORBIT_ACCESS_TOKEN=... IN_POD='["kubectl",...,"exec","-i","POD","-c","runner","--"]' \
//     node browser-tab-shots.mjs http://127.0.0.1:13718 <runnerId> OUTDIR [sessionId]
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const [base, runnerId, out, sessionId] = process.argv.slice(2);
if (!base || !runnerId || !out || !process.env.ORBIT_ACCESS_TOKEN || !process.env.IN_POD) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... IN_POD=[...] browser-tab-shots.mjs http://host:port <runnerId> OUTDIR [sessionId]');
  process.exit(2);
}
const PASTE_TEXT = '密码 Pässwörd 🔑';
const COPY_TEXT = 'Copied in the runner';
const inPod = JSON.parse(process.env.IN_POD);
const report = { steps: [] };
const step = (what, detail = {}) => {
  report.steps.push({ at: new Date().toISOString(), what, ...detail });
};

// One DevTools command on the runner Chrome's shown page, run by node inside the Pod (Chrome listens on its loopback).
const DEVTOOLS = `
const [method, params] = JSON.parse(process.argv[1]);
// Chrome may still be starting: the viewer goes live on x11vnc before its DevTools listen.
let pages = [];
for (let i = 0; i < 120 && !pages.length; i++) {
  try { pages = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => t.type === 'page'); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!pages.length) throw new Error('no page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method, params }));
const answer = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }; });
ws.close();
console.log(JSON.stringify(answer));`;
function devtools(method, params) {
  const raw = execFileSync(inPod[0], [...inPod.slice(1), 'node', '--input-type=module', '-e', DEVTOOLS, JSON.stringify([method, params])], {
    encoding: 'utf8',
    timeout: 90_000,
  });
  const answer = JSON.parse(raw.trim().split('\n').pop());
  if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result;
}
const evaluate = (expression) =>
  devtools('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }).result.value;
const inPodShell = (cmd) => execFileSync(inPod[0], [...inPod.slice(1), 'sh', '-c', cmd], { encoding: 'utf8', timeout: 30_000 });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
await context.addInitScript(
  ([access, refresh]) => {
    localStorage.setItem('orbit_token', access);
    if (refresh) localStorage.setItem('orbit_refresh', refresh);
  },
  [process.env.ORBIT_ACCESS_TOKEN, process.env.ORBIT_REFRESH_TOKEN ?? ''],
);
const until = async (what, ms, check) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const live = (tab) => tab.waitForSelector('.rb-tab-foot .rb-link.is-live', { timeout: 120_000 });
const text = (tab, selector) => tab.locator(selector).first().textContent();

try {
  // ── 1. Settings → Open browser ─────────────────────────────────────────────────────────────────────────────
  const settings = await context.newPage();
  await settings.goto(`${base}/settings/machines/${runnerId}`, { waitUntil: 'networkidle' });
  const open = settings.getByRole('button', { name: 'Open browser' });
  await open.waitFor({ timeout: 60_000 });
  const [tab] = await Promise.all([context.waitForEvent('page'), open.click()]);
  await live(tab);
  step('the tab opened from Settings is live', {
    path: new URL(tab.url()).pathname,
    search: new URL(tab.url()).search,
    title: await tab.title(),
    bar: await text(tab, '.rb-tab-title'),
    controlling: await tab.locator('.rb-tab.is-controlling').count(),
  });
  report.chromeArgs = inPodShell("ps -eo args | grep -E '^[^ ]*chrom' | head -1").trim().split(' ').filter((a) => a.startsWith('--'));
  step('the remote Chrome runs with --no-sandbox and --test-type', {
    noSandbox: report.chromeArgs.includes('--no-sandbox'),
    testType: report.chromeArgs.includes('--test-type'),
  });

  // ── 2. paste into a field of the remote Chrome ────────────────────────────────────────────────────────────
  const field = (id, value = '') =>
    `<p style="margin:18px 0 6px">${id === 'paste' ? 'Paste here' : 'Copy from here'}</p>` +
    `<input id="${id}" value="${value}" style="font:26px sans-serif;width:880px;padding:10px;border:2px solid #888;border-radius:8px">`;
  const pageHtml =
    '<!doctype html><meta charset="utf-8"><title>Orbit paste check</title>' +
    '<body style="font:20px sans-serif;margin:40px"><h2>Orbit paste check</h2>' +
    field('paste') +
    field('copy', COPY_TEXT) +
    '</body>';
  devtools('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}` });
  await until('the remote page', 20_000, () => evaluate("document.title === 'Orbit paste check'"));
  await tab.waitForTimeout(1500);
  // Where the first field is on the runner's screen, and so on the viewer's canvas.
  const at = evaluate(`(() => { const r = document.getElementById('paste').getBoundingClientRect();
    return { x: window.screenX + r.left + 40, y: window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2 }; })()`);
  const canvas = tab.locator('.rb-screen canvas');
  const box = await canvas.boundingBox();
  const scale = box.width / 1280;
  await tab.mouse.click(box.x + at.x * scale, box.y + at.y * scale);
  await until('the field focused through VNC', 10_000, () => evaluate("document.activeElement && document.activeElement.id === 'paste'"));
  step('the viewer clicked the remote field through VNC', { screen: at, scale: Math.round(scale * 100) });
  await tab.evaluate((t) => navigator.clipboard.writeText(t), PASTE_TEXT);
  await tab.keyboard.press('ControlOrMeta+V');
  const pasted = await until('the paste in the remote field', 20_000, () => {
    const value = evaluate("document.getElementById('paste').value");
    return value ? { value } : null;
  });
  await tab.waitForTimeout(1500);
  const after = evaluate("document.getElementById('paste').value");
  report.paste = { sent: PASTE_TEXT, readBack: after, exact: after === PASTE_TEXT, firstSeen: pasted.value };
  step('the remote field holds the pasted text', report.paste);
  await tab.waitForTimeout(800);
  await tab.screenshot({ path: `${out}/tab-in-control.png` });
  report.inControl = {
    bar: await text(tab, '.rb-tab-title'),
    foot: await text(tab, '.rb-tab-foot'),
    pasteError: await tab.locator('.rb-paste-error').count(),
  };

  // ── 3. copy in the remote, to the local clipboard ─────────────────────────────────────────────────────────
  await tab.evaluate(() => navigator.clipboard.writeText('-'));
  evaluate("(() => { const c = document.getElementById('copy'); c.focus(); c.select(); return true; })()");
  await canvas.focus();
  await tab.keyboard.press('Control+C');
  const copied = await until('the remote copy in the local clipboard', 20_000, async () => {
    const value = await tab.evaluate(() => navigator.clipboard.readText());
    return value === COPY_TEXT ? value : null;
  }).catch((error) => ({ error: error.message }));
  report.copyBack = { expected: COPY_TEXT, localClipboard: copied };
  step('the remote copy reached the local clipboard', report.copyBack);

  // ── 4. 100% and Fit; Done ─────────────────────────────────────────────────────────────────────────────────
  await tab.getByRole('button', { name: '100%' }).click();
  await tab.waitForTimeout(1500);
  report.actualSize = { size: await text(tab, '.rb-size'), canvasWidth: (await canvas.boundingBox()).width };
  await tab.screenshot({ path: `${out}/tab-100-percent.png` });
  // The remote screen at 1:1, its top edge included: Chrome's own bars, with no infobar.
  await tab.locator('.rb-screen').screenshot({ path: `${out}/remote-chrome-1-to-1.png` });
  await tab.getByRole('button', { name: 'Fit' }).click();
  await tab.waitForTimeout(1000);
  report.fit = { size: await text(tab, '.rb-size') };

  await tab.getByRole('button', { name: 'Done' }).click();
  await tab.waitForSelector('.rb-tab:not(.is-controlling)');
  await tab.waitForTimeout(800);
  // View only: a paste reaches nothing.
  evaluate("(() => { const p = document.getElementById('paste'); p.value = ''; p.focus(); return true; })()");
  await tab.evaluate(() => navigator.clipboard.writeText('VIEW-ONLY-MUST-NOT-ARRIVE'));
  await canvas.focus();
  await tab.keyboard.press('ControlOrMeta+V');
  await tab.waitForTimeout(3000);
  report.viewOnly = {
    bar: await text(tab, '.rb-tab-title'),
    foot: await text(tab, '.rb-tab-foot'),
    takeControl: await tab.getByRole('button', { name: 'Take control' }).count(),
    remoteFieldAfterPaste: evaluate("document.getElementById('paste').value"),
    streamsStillLive: await tab.locator('.rb-tab-foot .rb-link.is-live').count(),
  };
  step('Done: view only, and a paste reached nothing', report.viewOnly);
  await tab.screenshot({ path: `${out}/tab-view-only.png` });

  // ── 5. the session drawer hands its stream to the tab ─────────────────────────────────────────────────────
  if (sessionId) {
    await tab.close();
    await settings.goto(`${base}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
    const chip = settings.locator('.rb-chip');
    await chip.waitFor({ timeout: 60_000 });
    await chip.click();
    await settings.waitForSelector('.rb-drawer .rb-link.is-live', { timeout: 60_000 });
    await settings.waitForTimeout(1000);
    await settings.screenshot({ path: `${out}/drawer-quick-look.png` });
    const sockets = [];
    settings.on('websocket', (ws) => sockets.push(ws));
    const [handed] = await Promise.all([context.waitForEvent('page'), settings.getByRole('button', { name: /Open in new tab/ }).click()]);
    await live(handed);
    report.handOver = {
      drawerOpen: await settings.locator('.rb-drawer').count(),
      tabPath: new URL(handed.url()).pathname,
      tabControlling: await handed.locator('.rb-tab.is-controlling').count(),
      tabBar: await text(handed, '.rb-tab-title'),
    };
    step('Open in new tab: the drawer closed and the tab is live, view only', report.handOver);
    await handed.screenshot({ path: `${out}/tab-from-drawer.png` });
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
