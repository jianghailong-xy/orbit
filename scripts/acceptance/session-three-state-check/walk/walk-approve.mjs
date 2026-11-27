// Press Approve on the approval case's card in the console, and read what follows: the decision request, the card,
// the session's word and Stop in the DOM, and the approval and session as the real API answers after.
// It changes state (the approval is decided), so run it after the read-only walks.
// usage: [WALK_CASE=<case key>] node walk-approve.mjs <walk dir> <web origin> <out dir> [playwright module path]
// WALK_CASE picks the case whose card is pressed (default `approval`); outputs are named after it.
// No engine runs in this rig: nothing consumes the decision, so "the run continues" can only mean the session stays a
// running turn (phase RUNNING, Stop offered) once nobody is asked anything any more.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [walk, origin, out, pwModule = '/root/orbit/node_modules/playwright'] = process.argv.slice(2);
if (!walk || !origin || !out) throw new Error('usage: walk-approve.mjs <walk dir> <web origin> <out dir> [playwright]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(pwModule);
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const api = JSON.parse(fs.readFileSync(path.join(walk, 'api.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();
const key = process.env.WALK_CASE || 'approval';
const c = api.cases[key];
if (!c) throw new Error(`no case ${key} in api.json`);
const BASE = `${origin}/api`;

// The API, through the same proxy the console uses; the token is never printed.
const { accessToken } = await (await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.ownerEmail, password }),
})).json();
const getJson = async (route) => (await fetch(`${BASE}${route}`, { headers: { authorization: `Bearer ${accessToken}` } })).json();
const FIELDS = ['status', 'phase', 'released', 'waitingOn', 'lastTurnOutcome', 'endReason', 'workFinished'];
async function apiState() {
  const detail = await getJson(`/sessions/${c.id}`);
  const row = (await getJson('/sessions')).find((s) => s.title === c.title) ?? null;
  const approvals = await getJson(`/sessions/${c.id}/approvals`);
  return {
    detail: Object.fromEntries(FIELDS.map((k) => [k, detail?.[k]])),
    listRow: row ? { activity: row.activity ?? null, pendingApprovals: row.pendingApprovals ?? null, phase: row.phase, waitingOn: row.waitingOn } : null,
    approvals: Array.isArray(approvals) ? approvals.map((a) => ({ toolName: a.toolName, status: a.status, answeredBy: a.answeredBy ?? null })) : approvals,
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await context.newPage();
const requests = [];
page.on('response', (res) => {
  const url = new URL(res.url());
  if (url.pathname.includes('/approvals/') && res.request().method() === 'POST') {
    requests.push({ method: 'POST', path: url.pathname, status: res.status(), body: res.request().postData() });
  }
});
await page.goto(`${origin}/login`);
await page.fill('input[name="email"]', seed.ownerEmail);
await page.fill('input[name="password"]', password);
await page.click('button.login-submit');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

const read = () => page.evaluate((t) => {
  const row = [...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-title')?.textContent?.trim() === t);
  const approve = [...document.querySelectorAll('button')].find((b) => (b.textContent?.trim() ?? '').startsWith('Approve'));
  const stop = document.querySelector('button[aria-label="Stop"]');
  return {
    rowLine: row?.querySelector('.session-preview')?.textContent?.trim() ?? null,
    rowSpinner: !!row?.querySelector('.session-icon .anticon-spin, .session-icon .anticon-loading'),
    headerSub: document.querySelector('.workspace-sub:not([data-fork-source])')?.textContent?.trim() ?? null,
    stopVisible: !!stop && stop.getClientRects().length > 0,
    approveButton: approve ? { text: approve.textContent.trim(), disabled: approve.disabled } : null,
    approvalStaleNote: document.querySelector('.approval-stale')?.textContent?.trim() ?? null,
    cardText: document.querySelector('.approval-card, [class*="approval"]')?.textContent?.trim()?.slice(0, 300) ?? null,
  };
}, c.title);

await page.goto(`${origin}/sessions/${c.publicId}`);
const approveButton = page.locator('button', { hasText: /^Approve/ }).first();
await approveButton.waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(2_000);
const apiBefore = await apiState();
const before = await read();
await page.mouse.move(1400, 880);
await page.screenshot({ path: path.join(out, `approve-${key}-before.png`) });
console.log(`before: ${JSON.stringify(before)}`);

await approveButton.click();
// The card answers once the decision is written: wait for its Approve button to go, or to be disabled.
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent?.trim() ?? '').startsWith('Approve'));
  return !b || b.disabled;
}, null, { timeout: 15_000 }).catch(() => {});
// Then the session's own word: how long until the row and the header stop asking for an approval (30 s at most).
const pressedAt = Date.now();
const changed = await page.waitForFunction((t) => {
  const row = [...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-title')?.textContent?.trim() === t);
  const line = row?.querySelector('.session-preview')?.textContent?.trim() ?? '';
  const sub = document.querySelector('.workspace-sub:not([data-fork-source])')?.textContent?.trim() ?? '';
  return !line.startsWith('Waiting for approval') && !sub.startsWith('Waiting for approval');
}, c.title, { timeout: 30_000, polling: 250 }).then(() => true).catch(() => false);
const wordChangedAfterMs = changed ? Date.now() - pressedAt : null;
await page.waitForTimeout(1_000);
const after = await read();
const apiAfter = await apiState();
await page.mouse.move(1400, 880);
await page.screenshot({ path: path.join(out, `approve-${key}-after.png`) });
console.log(`decision: ${JSON.stringify(requests.map(({ path: p, status }) => ({ path: p, status })))}`);
console.log(`word changed after: ${wordChangedAfterMs === null ? 'NOT within 30 s' : `${wordChangedAfterMs} ms`}`);
console.log(`after:  ${JSON.stringify(after)}`);
console.log(`api before: ${JSON.stringify(apiBefore)}`);
console.log(`api after:  ${JSON.stringify(apiAfter)}`);
fs.writeFileSync(path.join(out, `approve-${key}.json`), JSON.stringify({ key, before, after, wordChangedAfterMs, requests, apiBefore, apiAfter }, null, 2));
await browser.close();
