// Scenario 5 — removing a Kimi account a session is using is refused; once no session uses it, it is removed.
// A session on Work runs a slow turn (the fake kimi's FAKE_KIMI_SLOW) while Remove is pressed on the Providers page:
// the runner refuses, and the page says why. With the turn over but the session open, Remove is still refused. Once
// every open session is completed (the web's Complete), Remove takes the account — its directory and record —
// and Default's home is untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { HERE, S, WEB, call, login, logTo, note, seed, saveSeed, shotDir, sleep, until } from './lib.mjs';
import { fakeKimiEvents, newKimiSession, runnerMetaFor, setWorkspaceKimiAccount } from './flows.mjs';
import { signedIn, shot } from './ui.mjs';

const OUT = shotDir('5-remove-account');
writeFileSync(`${OUT}/scenario5.log`, '');
logTo(`${OUT}/scenario5.log`);
const sd = seed();
const RUNNER = sd.runners['hpc-kimi'].id;
const WS = sd.workspaces['hpc-kimi'].id;
const WORK = sd.work;
const R = `${S}/runners/hpc-kimi`;
const DEFAULT_HOME = `${R}/userhome/.kimi-code`;
const T = await login();
const hash = (dir) => execFileSync(`${HERE}/homehash.sh`, [dir], { encoding: 'utf8' }).trim().split('\n').pop();
const runnerState = async () => {
  const r = await call('GET', `/runners/${RUNNER}`, T, undefined, { quiet: true });
  return { accounts: r.engines.find((e) => e.engine === 'kimi').accounts.map((a) => ({ id: a.id, name: a.name, auth: a.auth })), accountRemove: r.accountRemove };
};
note('== Scenario 5: remove an account in use (refused), then idle (removed) ==');
note('before:', await runnerState());
const defaultBefore = hash(DEFAULT_HOME);
note('Default home:', defaultBefore);

const { b, page } = await signedIn();
page.on('request', (r) => { const p = new URL(r.url()).pathname; if (r.method() === 'DELETE' || (r.method() !== 'GET' && p.includes('/accounts/'))) note(`web → ${r.method()} ${p}`); });
page.on('response', async (r) => { const p = new URL(r.url()).pathname; if (r.request().method() === 'DELETE') note(`web ← ${r.status()} ${p} ${(await r.text().catch(() => '')).slice(0, 300)}`); });

// a session on Work with a turn in flight
await setWorkspaceKimiAccount(page, { runner: RUNNER, workspaceName: 'hpc-kimi-ws', option: /^Work/ });
note('workspace kimiAccount:', (await call('GET', `/workspaces/${WS}`, T, undefined, { quiet: true })).kimiAccount);
const since = new Date().toISOString();
const sid = await newKimiSession(page, { workspace: WS, prompt: 'Scenario 5: hold this account — FAKE_KIMI_SLOW 75' });
note('session in flight on Work:', sid);
await until('the slow turn to start', async () => fakeKimiEvents('hpc-kimi', sid, since).some((e) => e.event === 'acp.session.new'), { timeoutMs: 120_000 });
const kid = fakeKimiEvents('hpc-kimi', sid, since).find((e) => e.event === 'acp.session.new').sessionId;
note('its runner record:', runnerMetaFor('hpc-kimi', kid)?.meta.kimiCodeHome);
await sleep(2000);
await shot(page, `${OUT}/5a-turn-in-flight.png`, { fullPage: false });

const removeWork = async (tag) => {
  await page.evaluate(([id]) => localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${id}/kimi`])), [RUNNER]);
  await page.goto(`${WEB}/providers?runner=${RUNNER}&engine=kimi`, { waitUntil: 'domcontentloaded' });
  const work = page.locator('.re-runner-card:not(.collapsed) .re-acct').filter({ has: page.locator('.re-name-text', { hasText: /^Work$/ }) }).first();
  await work.waitFor({ timeout: 60_000 });
  await work.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove account' }).click();
  await sleep(500);
  await shot(page, `${OUT}/5${tag}1-confirm.png`, { fullPage: false });
  const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/accounts/kimi/${WORK.id}`), { timeout: 30_000 });
  await page.getByRole('button', { name: /^Remove$/ }).last().click();
  await deleted;
  return work;
};

// Remove while the turn runs
const work = await removeWork('b');
const refused = await until('the runner to answer the removal', async () => {
  const st = await runnerState();
  return st.accountRemove?.account === WORK.id && st.accountRemove.status === 'failed' ? st : null;
}, { timeoutMs: 90_000, everyMs: 1500 });
note('after Remove while in use:', refused);
const card5 = page.locator('.re-runner-card:not(.collapsed)').first();
await until('the page to show the refusal', async () => /in use by a session/.test(await card5.innerText().catch(() => '')), { timeoutMs: 30_000, everyMs: 500 });
await sleep(800);
const rowText = (await work.innerText().catch(() => '')).replace(/\s+/g, ' ');
const banner = (await card5.innerText()).split('\n').filter((l) => /in use by a session|untouched/.test(l)).join(' | ');
note('Work row as shown:', rowText);
note('refusal shown on the card:', banner);
await shot(page, `${OUT}/5b2-refused.png`, { fullPage: false });
const stillThere = existsSync(WORK.home);
note('Work home still on disk:', stillThere, WORK.home);

// The turn has ended but the session is still open: the runner still counts it as using Work — it supervises
// the session (warm, or cold once its engine is recycled) until the session ends (session_pool.go).
await until('the slow turn to end', async () => fakeKimiEvents('hpc-kimi', sid, since).some((e) => e.event === 'acp.prompt'), { timeoutMs: 150_000, everyMs: 2000 });
await sleep(1500);
const answer = async () => until('the runner to answer the removal', async () => {
  const st = await runnerState();
  return st.accountRemove?.account === WORK.id && st.accountRemove.status !== 'pending' ? st : null;
}, { timeoutMs: 90_000, everyMs: 1500 });
await removeWork('c');
const refusedOpen = await answer();
note('after Remove with the session open but idle:', refusedOpen);
await shot(page, `${OUT}/5c2-refused-open-session.png`, { fullPage: false });

// Complete every open session of the workspace — the web's Complete (POST /sessions/:id/complete) — then Remove.
const sessions = await call('GET', `/sessions?workspaceId=${WS}`, T, undefined, { quiet: true }).catch(() => null);
const live = (Array.isArray(sessions) ? sessions : sessions?.items ?? sessions?.sessions ?? []).filter((s) => !['ENDED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(s.status));
note('open sessions of the workspace:', live.map((s) => ({ id: s.id, status: s.status })));
const runnerLogPath = `${R}/../../logs/runner-hpc-kimi.log`;
const linesBefore = readFileSync(runnerLogPath, 'utf8').split('\n').length;
for (const s of live) await call('POST', `/sessions/${s.id}/complete`, T);
// Every completed session's run ends in the runner's log — one the runner was not supervising (since a restart)
// is claimed for a moment just to be ended, and counts as using its account while it is.
await until('a finished run in the runner log for every completed session', async () =>
  readFileSync(runnerLogPath, 'utf8').split('\n').slice(linesBefore - 1).filter((l) => /■ interactive run [0-9a-f-]{36} →/.test(l)).length >= live.length,
{ timeoutMs: 120_000, everyMs: 1000 });
const supervised = () => {
  const all = readFileSync(runnerLogPath, 'utf8').split('\n');
  // since this runner process started: a run open when an earlier one stopped ended with it
  const lines = all.slice(all.findLastIndex((l) => /runner "hpc-kimi" online/.test(l)));
  const open = new Set();
  for (const l of lines) {
    const start = /> interactive run ([0-9a-f-]{36})/.exec(l);
    const end = /■ interactive run ([0-9a-f-]{36}) →/.exec(l);
    if (start) open.add(start[1]);
    if (end) open.delete(end[1]);
  }
  return [...open];
};
const idle = await until('the runner to supervise no session', async () => (supervised().length === 0 ? 'idle' : null), { timeoutMs: 120_000, everyMs: 1000 }).catch(() => null);
note('runner supervises no session any more:', idle === 'idle', supervised());
await sleep(2000);
await removeWork('d');
const removed = await until('the account to be gone', async () => {
  const st = await runnerState();
  return st.accountRemove?.account === WORK.id && st.accountRemove.status === 'done' && !st.accounts.some((a) => a.id === WORK.id) ? st : null;
}, { timeoutMs: 120_000, everyMs: 1500 });
note('after Remove while idle:', removed);
await page.locator('.re-acct').filter({ has: page.locator('.re-name-text', { hasText: /^Work$/ }) }).first().waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
await sleep(2000);
const card = page.locator('.re-runner-card:not(.collapsed)').first();
await shot(page, `${OUT}/5d2-removed.png`, { fullPage: false, clip: await card.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 8, width: r.width + 24, height: r.height + 16 })) });
await b.close();

note('runner log (sessions):\n' + readFileSync(`${R}/../../logs/runner-hpc-kimi.log`, 'utf8').split('\n').filter((l) => /interactive run/.test(l)).slice(-12).join('\n'));
const defaultAfter = hash(DEFAULT_HOME);
const checks = {
  'the removal of an account in use was refused by the runner, with its reason': /in use by a session running on this machine/.test(refused.accountRemove.message ?? ''),
  'the page showed the refusal under the Work row, and Work stays Available': /in use by a session running on this machine/.test(banner) && /Available/.test(rowText),
  "Work's directory stayed while refused": stillThere,
  'with the turn over but the session still open, the removal is still refused': refusedOpen.accountRemove.status === 'failed' && /in use by a session/.test(refusedOpen.accountRemove.message ?? ''),
  'once every session on it was completed, the removal went through and the account left the report': removed.accounts.every((a) => a.id !== WORK.id),
  "Work's directory and record are gone": !existsSync(WORK.home) && !existsSync(`${WORK.home}.json`),
  "Default's home untouched": defaultBefore === defaultAfter,
};
let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 5 PASS' : 'SCENARIO 5 FAIL');
sd.removed = { work: WORK.id, session: sid };
saveSeed(sd);
process.exit(ok ? 0 : 1);
