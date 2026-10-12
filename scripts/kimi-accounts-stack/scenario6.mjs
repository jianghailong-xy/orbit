// Scenario 6 — compatibility.
//  6a  old-kimi runs this checkout's runner built WITHOUT kimi-account-login/v1, kimi-account-remove/v1 and
//      kimi-account-move/v1 (stack.sh build: runner-nocap.diff). Its Kimi row has no Add account; a named Kimi
//      sign-in, a removal and an account switch addressed to it are refused with the upgrade message, and
//      nothing runs on the machine.
//  6b  The old client — origin/main's web before this project's web landed (721e48275) — on the same server
//      and the same data (two Kimi accounts with quota on hpc-kimi): the Providers page, a Kimi session and the
//      workspace form render, with no page error.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { HERE, MAIN_WEB, S, WEB, call, fk, HttpError, login, logTo, note, seed, saveSeed, shotDir, sleep, stack, until } from './lib.mjs';
import { signedIn, shot } from './ui.mjs';
import { waitForTurns } from './flows.mjs';

const OUT = shotDir('6-compat');
writeFileSync(`${OUT}/scenario6.log`, '');
logTo(`${OUT}/scenario6.log`);
const sd = seed();
const HPC = sd.runners['hpc-kimi'].id;
const OLD = sd.runners['old-kimi'].id;
const OLD_WS = sd.workspaces['old-kimi'].id;
const RO = `${S}/runners/old-kimi`;
const T = await login();
const checks = {};
const refusal = async (what, fn) => {
  try { await fn(); return null; } catch (e) { if (e instanceof HttpError) return { status: e.status, body: JSON.parse(e.body) }; throw e; }
};
const hash = (dir) => execFileSync(`${HERE}/homehash.sh`, [dir], { encoding: 'utf8' }).trim().split('\n').pop();

note('== Scenario 6a: a runner without the kimi-account-* capabilities ==');
note('runner-nocap.diff (the only change to the source):\n' + readFileSync(`${S}/logs/runner-nocap.diff`, 'utf8').trim());
const old = await call('GET', `/runners/${OLD}`, T, undefined, { quiet: true });
note('old-kimi capabilities with kimi in them:', old.capabilities.filter((c) => c.includes('kimi')));
note('old-kimi engines[kimi]:', old.engines.find((e) => e.engine === 'kimi'));
const oldDefault = `${RO}/userhome/.kimi-code`;
const oldDefaultBefore = hash(oldDefault);
note('old-kimi Default home:', oldDefaultBefore);

const { b, page } = await signedIn();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e?.message || e)));
await page.evaluate(([a, c]) => {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([a, c]));
  localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${a}/kimi`]));
}, [HPC, OLD]);
await page.goto(`${WEB}/providers`, { waitUntil: 'domcontentloaded' });
const cards = page.locator('.re-runner-card:not(.collapsed)');
await until('both cards open', async () => (await cards.count()) === 2, { timeoutMs: 60_000 });
await sleep(1500);
const oldCard = cards.filter({ hasText: 'old-kimi' }).first();
const hpcCard = cards.filter({ hasText: 'hpc-kimi' }).first();
const oldKimi = oldCard.locator('.re-row[data-engine="kimi"]');
const hpcKimi = hpcCard.locator('.re-row[data-engine="kimi"]');
const oldAdd = await oldKimi.getByRole('button', { name: 'Add account' }).count();
const hpcAdd = await hpcKimi.getByRole('button', { name: 'Add account' }).count();
note('Kimi row on old-kimi:', (await oldKimi.innerText()).replace(/\s+/g, ' '), '| Add account buttons:', oldAdd);
note('Kimi row on hpc-kimi: Add account buttons:', hpcAdd);
await shot(page, `${OUT}/6a1-old-runner-no-add-account.png`, { fullPage: false, clip: await oldCard.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 8, width: r.width + 24, height: r.height + 16 })) });
checks['6a: the old runner\'s Kimi row offers no Add account (the new runner\'s does)'] = oldAdd === 0 && hpcAdd === 1;

// a named sign-in sent anyway (an older or a hand-made client): accepted as pending, refused at the runner's beat
const fakeLogBefore = existsSync(`${S}/logs/fake-kimi-old-kimi.jsonl`) ? readFileSync(`${S}/logs/fake-kimi-old-kimi.jsonl`, 'utf8').split('\n').length : 0;
note('POST a named Kimi sign-in to old-kimi:', await call('POST', `/runners/${OLD}/login`, T, { engine: 'kimi', accountName: 'Not on this runner', region: 'mainland-cn' }));
const failed = await until('old-kimi to refuse it', async () => {
  const l = await call('GET', `/runners/${OLD}/login`, T, undefined, { quiet: true });
  return l.status === 'failed' ? l : null;
}, { timeoutMs: 90_000, everyMs: 2000 });
note('GET /runners/old-kimi/login:', failed);
const runnerLogins = readFileSync(`${S}/logs/fake-kimi-old-kimi.jsonl`, 'utf8').split('\n').slice(fakeLogBefore - 1).filter((l) => l.includes('"login'));
note('fake kimi login calls on old-kimi since:', runnerLogins.length);
checks['6a: a named Kimi sign-in to the old runner is refused with the upgrade message'] = /too old to sign in another Kimi account — update it/.test(failed.message ?? '');
checks['6a: nothing signed in on the old runner (no kimi login ran, no slot, Default unchanged)'] = runnerLogins.length === 0 && !existsSync(`${RO}/home/kimi-accounts`) && hash(oldDefault) === oldDefaultBefore;
await call('DELETE', `/runners/${OLD}/login`, T).catch(() => {});

// the same sign-in through the page's own code path: what the old runner's card says if it is reached
const removeRefusal = await refusal('remove', () => call('DELETE', `/runners/${OLD}/accounts/kimi/0badc0de`, T));
note('DELETE a Kimi account on old-kimi:', removeRefusal);
checks['6a: removing a Kimi account on the old runner is refused with the upgrade message'] = removeRefusal?.status === 400 && /too old to remove a Kimi account/.test(JSON.stringify(removeRefusal.body));

// an account switch: give old-kimi a second Kimi account the way one could still be there — added before the
// runner was replaced by one without the capabilities — and ask a session on it to switch
const slot = `${RO}/home/kimi-accounts/0ddba11a`;
note(stack('stop', 'old-kimi').trim());
mkdirSync(`${RO}/home/kimi-accounts`, { recursive: true, mode: 0o700 });
mkdirSync(slot, { mode: 0o700 });
writeFileSync(`${RO}/home/kimi-accounts/0ddba11a.json`, JSON.stringify({ name: 'Left over', createdAt: new Date().toISOString() }), { mode: 0o600 });
{
  // signed in with the fake CLI in old-kimi's own namespace and environment, KIMI_CODE_HOME = the slot
  const out = `${S}/logs/leftover-login.err`;
  const code = execFileSync('bash', ['-c', `('${HERE}/stack.sh' exec old-kimi env KIMI_CODE_HOME='${slot}' kimi login --region global > /dev/null 2> '${out}' &); for i in $(seq 1 40); do c=$(sed -n 's/.*enter code: //p' '${out}'); [ -n "$c" ] && break; sleep 0.25; done; echo "$c"`], { encoding: 'utf8' }).trim();
  note('left-over account (0ddba11a) device code:', code, await fk('POST', '/__admin/approve', { userCode: code, user: 'leftover@kimi.ai' }));
  await until('its login written', async () => existsSync(`${slot}/config.toml`) && readFileSync(`${slot}/config.toml`, 'utf8').includes('managed:kimi-code'), { timeoutMs: 20_000, everyMs: 500 });
}
note(stack('start', 'old-kimi').trim());
const two = await until('old-kimi to report two Kimi accounts', async () => {
  const r = await call('GET', `/runners/${OLD}`, T, undefined, { quiet: true });
  const k = r.engines?.find((e) => e.engine === 'kimi');
  return k?.accounts?.length === 2 && k.accounts.every((a) => a.auth === 'yes') ? k : null;
}, { timeoutMs: 120_000, everyMs: 2000 });
note('old-kimi engines[kimi] now:', two);
const sess = await call('POST', '/sessions', T, { workspaceId: OLD_WS, provider: 'kimi', prompt: 'Scenario 6a: a Kimi session on the old runner.' });
await until('its first turn', async () => {
  const s = await call('GET', `/sessions/${sess.id}`, T, undefined, { quiet: true });
  return s.runtimeSessionId ? s : null;
}, { timeoutMs: 120_000, everyMs: 2000 });
const switchRefusal = await refusal('switch', () => call('PATCH', `/sessions/${sess.id}/account`, T, { account: '0ddba11a' }));
note('PATCH /sessions/:id/account {account:"0ddba11a"} on old-kimi:', switchRefusal);
checks['6a: switching a Kimi session on the old runner to another account is refused with the upgrade message'] = switchRefusal?.status === 409 && /cannot move a conversation to another account yet/.test(JSON.stringify(switchRefusal.body));
// what the old runner's session offers in the composer: the Provider submenu without accounts
await waitForTurns('old-kimi', sess.id, '', 1);
await page.goto(`${WEB}/sessions/${sess.id}`, { waitUntil: 'domcontentloaded' });
await page.getByText('[fake kimi 2.1.1]', { exact: false }).first().waitFor({ timeout: 90_000 });
await page.locator('button.composer-model-chip').click();
const provider = page.locator('.ant-dropdown-menu-submenu-title').filter({ hasText: /^Provider/ }).first();
let rows = [];
if (await provider.count()) {
  await provider.hover();
  await sleep(800);
  rows = await page.locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item').allInnerTexts();
}
note('old-kimi session, Provider submenu rows:', rows);
await shot(page, `${OUT}/6a2-old-runner-session-menu.png`, { fullPage: false });
checks['6a: the composer offers no account to move to on the old runner'] = !rows.some((r) => /Left over|Default/.test(r));
await page.keyboard.press('Escape');
await b.close();
note('page errors (new web):', errors);

note('== Scenario 6b: the old client (main before this project, 721e48275) ==');
note('main web source:', readFileSync(`${S}/main-src/SOURCE_SHA`, 'utf8').trim());
// two Kimi accounts with quota on hpc-kimi for it to show: a kimi.ai account added through the API
const before = (await call('GET', `/runners/${HPC}`, T, undefined, { quiet: true })).engines.find((e) => e.engine === 'kimi').accounts;
if (before.length < 2) {
  note('POST a named kimi.ai sign-in on hpc-kimi:', await call('POST', `/runners/${HPC}/login`, T, { engine: 'kimi', accountName: 'Personal', region: 'global' }));
  const st = await until('the device code', async () => { const l = await call('GET', `/runners/${HPC}/login`, T, undefined, { quiet: true }); return l.userCode ? l : null; }, { timeoutMs: 90_000 });
  note('device step:', st);
  note('fake kimi ←', await fk('POST', '/__admin/approve', { userCode: st.userCode, user: 'personal@kimi.ai' }));
  await until('Personal signed in', async () => (await call('GET', `/runners/${HPC}`, T, undefined, { quiet: true })).engines.find((e) => e.engine === 'kimi').accounts.some((a) => a.name === 'Personal' && a.auth === 'yes'), { timeoutMs: 90_000 });
  note(stack('stop', 'hpc-kimi').trim()); note(stack('start', 'hpc-kimi').trim());
  await until('both quotas', async () => { const r = await call('GET', `/runners/${HPC}`, T, undefined, { quiet: true }); return Object.keys(r.planUsage?.kimi?.accounts ?? {}).length >= 1 && r.planUsage.kimi.fiveHour; }, { timeoutMs: 90_000 });
}
const hpcNow = await call('GET', `/runners/${HPC}`, T, undefined, { quiet: true });
note('hpc-kimi engines[kimi]:', hpcNow.engines.find((e) => e.engine === 'kimi'));
const oldWeb = await signedIn({ origin: MAIN_WEB });
const oerr = [];
oldWeb.page.on('pageerror', (e) => oerr.push(String(e?.message || e)));
await oldWeb.page.evaluate(([a, c]) => {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([a, c]));
  localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${a}/kimi`]));
}, [HPC, OLD]);
await oldWeb.page.goto(`${MAIN_WEB}/providers`, { waitUntil: 'domcontentloaded' });
await oldWeb.page.locator('.re-row[data-engine="kimi"]').first().waitFor({ timeout: 90_000 });
await sleep(2500);
const oldText = (await oldWeb.page.locator('.re-runner-card').first().innerText()).replace(/\s+/g, ' ');
note('old client, hpc-kimi card:', oldText);
await shot(oldWeb.page, `${OUT}/6b1-old-client-providers.png`, { fullPage: true });
const s2 = sd.session2?.id;
if (s2) {
  await oldWeb.page.goto(`${MAIN_WEB}/sessions/${s2}`, { waitUntil: 'domcontentloaded' });
  await oldWeb.page.getByText('[fake kimi 2.1.1]', { exact: false }).first().waitFor({ timeout: 90_000 });
  await sleep(2000);
  await shot(oldWeb.page, `${OUT}/6b2-old-client-session.png`, { fullPage: false });
}
await oldWeb.page.goto(`${MAIN_WEB}/runners/${HPC}`, { waitUntil: 'domcontentloaded' });
await oldWeb.page.locator('.rd-workspace-row').first().waitFor({ timeout: 60_000 });
await oldWeb.page.locator('.rd-workspace-row').first().click();
await sleep(1500);
await shot(oldWeb.page, `${OUT}/6b3-old-client-runner-workspace.png`, { fullPage: false });
await oldWeb.b.close();
note('page errors (old client):', oerr);
checks['6b: the old client renders the Providers page, a Kimi session and the runner page with no page error'] = oerr.length === 0 && /Kimi Code/.test(oldText);

let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 6 PASS' : 'SCENARIO 6 FAIL');
sd.oldSession = sess.id;
saveSeed(sd);
process.exit(ok ? 0 : 1);
