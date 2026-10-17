// node drive.mjs <out-dir> <light|dark>
// Photographs the DeepSeek balance in the real web console: headless Chromium over CDP signs in with a
// fake token, picks server.mjs's scenario, opens each page, waits until the state it is meant to show
// has rendered (or fails), presses what a user would press, and screenshots at 2x. Exits non-zero if
// any page did not show its state. Expects server.mjs on API_PORT (3993) and vite on VITE_PORT (5193);
// FONTCONFIG_FILE should alias the system UI fonts to Inter / Noto Sans SC, or CJK renders as boxes.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const [outDir = '.', theme = 'light'] = process.argv.slice(2);
const API = `http://127.0.0.1:${process.env.API_PORT ?? 3993}`;
const WEB = `http://127.0.0.1:${process.env.VITE_PORT ?? 5193}`;
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
mkdirSync(outDir, { recursive: true });

const ID = {
  deepseek: '34bKeyDeepSeek0000002', harness: '34bKeyHarness00000003', intl: '34bKeyIntl00000000005',
  team: '34bKeyTeam00000000006', old: '34bKeyOldKey000000007', direct: '34bKeyDirect000000008',
  busy: '34bKeyBusy00000000009', slow: '34bKeySlow00000000010',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 600);
const profile = `/var/tmp/ds-balance-chrome-${port}`;
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  // The back-forward cache keeps a left page alive with its open requests (the event stream, the balance
  // that never answers), and enough of those starve the next navigation of connections.
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--lang=en-US', '--disable-features=BackForwardCache', 'about:blank'],
  { stdio: 'ignore' });
let target;
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const loaded = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Page.loadEventFired') loaded.splice(0).forEach((f) => f());
  if (msg.method === 'Runtime.exceptionThrown') console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const go = async (url) => { const p = new Promise((r) => loaded.push(r)); await send('Page.navigate', { url }); await Promise.race([p, sleep(15000)]); };
/** Each page from a blank one, so the page before it — its event stream, a balance still being asked —
 *  is gone, connections and all, before the next one needs them. */
const nav = async (url) => { await go('about:blank'); await sleep(300); await go(url); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'owner', exp: Math.floor(Date.now() / 1000) + 86400 * 7 })}.sig`;
await nav(`${WEB}/login`);
await evaluate(`localStorage.setItem('orbit_token', ${JSON.stringify(jwt)}); localStorage.setItem('orbit_refresh', 'r'); localStorage.setItem('orbit-theme', ${JSON.stringify(theme)});`);

/** The page's text, whitespace collapsed. */
const pageText = () => evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
async function until(what, test, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(300);
  }
  console.log(`FAIL ${what}`);
  return false;
}
/** A rectangle around the elements the selector function returns, padded. */
async function clipOf(js, pad = 16) {
  return evaluate(`(() => { const els = (${js})().filter(Boolean); const r = els.map((e) => e.getBoundingClientRect());
    const x = Math.min(...r.map((b) => b.left)) - ${pad}, y = Math.min(...r.map((b) => b.top)) - ${pad};
    return { x: Math.max(0, x + scrollX), y: Math.max(0, y + scrollY), width: Math.max(...r.map((b) => b.right)) - x + ${pad},
             height: Math.max(...r.map((b) => b.bottom)) - y + ${pad} }; })()`);
}
/** The page as a 1440×900 window shows it — or, given the elements to frame, just them: the window is
 *  made tall enough to hold them first, since a capture beyond the viewport lays a centred page out again. */
async function shot(name, frame) {
  let clip;
  if (frame) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 2200, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    clip = await clipOf(frame);
  }
  await sleep(600);
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png' });
  if (frame) await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  writeFileSync(`${outDir}/${name}-${theme}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('wrote', `${name}-${theme}.png`);
}
const KEYS = `() => [[...document.querySelectorAll('.re-sec-head')].find((e) => /Your API keys/.test(e.textContent)), document.querySelector('.provider-keys')]`;
const SECTION = `() => [document.querySelector('.dsb-section')]`;
const lineOf = (name) => evaluate(`[...document.querySelectorAll('tr')].find((tr) => tr.querySelector('.prov-cell-name')?.textContent === ${JSON.stringify(name)})?.querySelector('[data-testid="deepseek-balance-line"]')?.innerText.replace(/\\s+/g, ' ')`);
const results = [];
const check = (name, passed, detail) => {
  const ok = passed === true;
  results.push({ name, ok, detail });
  if (!ok) console.log('FAIL', name, detail ?? '');
};
const noAmount = (text) => !/[¥$]|(^|[^\d.])0(\.\d+)?(?![\d.])/.test(text);

async function scenario(name) { await fetch(`${API}/__set?scenario=${name}`); }

// Vite optimizes a page's dependencies on its first visit and reloads it once: visit both pages first.
await scenario('pair');
for (const path of ['/providers', `/providers/${ID.deepseek}`]) {
  await nav(`${WEB}${path}`);
  await sleep(4000);
}

// 1. One key behind DeepSeek and DeepSeek Harness: the Providers list.
await nav(`${WEB}/providers`);
check('providers: both DeepSeek rows show the balance', await until('pair list', async () =>
  (await lineOf('DeepSeek'))?.startsWith('Account balance ¥110.00') && (await lineOf('DeepSeek Harness'))?.startsWith('Account balance ¥110.00')));
check('providers: same line on both rows', (await lineOf('DeepSeek')) === (await lineOf('DeepSeek Harness')), await lineOf('DeepSeek'));
check('providers: no line on Anthropic or Kimi', !(await lineOf('Anthropic (Claude)')) && !(await lineOf('Kimi (Moonshot)')));
await shot('web-01-providers', KEYS);

// 2. The two edit pages, each naming the other as the same account.
for (const [id, name, other] of [[ID.deepseek, 'web-03-edit-deepseek', 'DeepSeek Harness'], [ID.harness, 'web-04-edit-deepseek-harness', 'DeepSeek']]) {
  await nav(`${WEB}/providers/${id}`);
  check(`${name}: balance section`, await until(name, async () => (await pageText()).includes('Granted¥10.00') || (await pageText()).includes('Granted ¥10.00')));
  const text = await pageText();
  check(`${name}: shared line`, text.includes(`Same DeepSeek account as ${other} — both show this balance.`));
  check(`${name}: whole-account note`, text.includes('The balance of the whole DeepSeek account this key belongs to'));
  check(`${name}: section right under the key`, await evaluate(`(() => { const s = [...document.querySelectorAll('.provider-step')]; const k = s.findIndex((e) => /API key/.test(e.querySelector('.ps-title')?.textContent ?? '')); return s[k + 1]?.classList.contains('dsb-section'); })()`));
  await shot(name);
}

// 3. Refresh: the page's own press asks DeepSeek again (?refresh=1 in server.mjs's log) and shows the new read.
if (theme === 'light') {
  await nav(`${WEB}/providers/${ID.deepseek}`);
  await until('refresh page', async () => (await pageText()).includes('Updated 2 min ago'));
  await evaluate(`[...document.querySelectorAll('.dsb-section button')].find((b) => b.textContent.includes('Refresh')).click()`);
  check('refresh: the section shows the new read', await until('refreshed', async () => (await pageText()).includes('Updated just now')));
  await shot('web-06-edit-refreshed', SECTION);
}

// 4. Every state, on the list and on each key's page.
await scenario('states');
await nav(`${WEB}/providers`);
check('states list', await until('states list', async () => (await lineOf('DeepSeek Old key'))?.includes('API key rejected')
  && (await lineOf('DeepSeek Team'))?.includes('too low') && (await lineOf('DeepSeek Intl'))?.includes('$5.00')));
for (const [name, want] of [['DeepSeek', 'Account balance ¥110.00 · updated 2 min ago'], ['DeepSeek Intl', 'Account balance ¥110.00 · $5.00'],
  ['DeepSeek Team', 'Balance ¥0.42 — too low, DeepSeek calls will fail'], ['DeepSeek Old key', 'Balance unavailable: API key rejected · Retry'],
  ['DeepSeek Direct', 'Balance unavailable: network error · Retry'], ['DeepSeek Busy', 'Balance unavailable: DeepSeek error · Retry'],
  ['DeepSeek Slow', 'Checking account balance…']]) {
  const line = await lineOf(name);
  check(`states list: ${name}`, line?.startsWith(want), line);
  if (/unavailable|Checking/.test(want)) check(`states list: ${name} shows no amount`, noAmount(line ?? ''), line);
}
await shot('web-02-providers-states', KEYS);

for (const [id, name, want, amountless] of [
  [ID.intl, 'web-05a-section-multi-currency', "Each currency is a separate balance; DeepSeek doesn't convert between them.", false],
  [ID.team, 'web-05b-section-low', 'Balance too low — DeepSeek calls will fail', false],
  [ID.old, 'web-05c-section-key-rejected', 'DeepSeek rejected this API key (401 Authentication Fails). Paste a valid key above and save, then retry.', true],
  [ID.direct, 'web-05d-section-network', "Couldn't reach api.deepseek.com — the request timed out after 10 s. The key itself wasn't checked.", true],
  [ID.busy, 'web-05e-section-upstream', "DeepSeek answered 503 Server Overloaded. The key itself wasn't checked.", true],
  [ID.slow, 'web-05f-section-loading', 'Checking balance…', true],
]) {
  await nav(`${WEB}/providers/${id}`);
  check(name, await until(name, async () => (await evaluate(`document.querySelector('.dsb-section')?.innerText.replace(/\\s+/g, ' ')`))?.includes(want)));
  const section = await evaluate(`document.querySelector('.dsb-section')?.innerText.replace(/\\s+/g, ' ')`);
  if (amountless) check(`${name}: no amount anywhere in the section`, noAmount(section ?? ''), section);
  await shot(name, SECTION);
}

writeFileSync(`${outDir}/checks-${theme}.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed (${theme})`);
ws.close();
chrome.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
