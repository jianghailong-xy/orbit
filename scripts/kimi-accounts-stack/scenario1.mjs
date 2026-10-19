// Scenario 1 — Providers page: add a kimi.com account (name + site → device code → done); Default unchanged.
// Driven in the real web (vite dev of the checkout) against the stack; the device code is approved on the fake
// Kimi server as work@kimi.com, which is what the user's browser would do on www.kimi.com.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { HERE, S, WEB, call, fk, login, logTo, note, seed, saveSeed, shotDir, sleep, until } from './lib.mjs';
import { signedIn, shot } from './ui.mjs';

const OUT = shotDir('1-add-account');
logTo(`${OUT}/scenario1.log`);
writeFileSync(`${OUT}/scenario1.log`, '');
const sd = seed();
const RUNNER = sd.runners['hpc-kimi'].id;
const DEFAULT_HOME = `${S}/runners/hpc-kimi/userhome/.kimi-code`;
const T = await login();
const kimiOf = async () => (await call('GET', `/runners/${RUNNER}`, T, undefined, { quiet: true })).engines.find((e) => e.engine === 'kimi');
const hash = (dir) => execFileSync(`${HERE}/homehash.sh`, [dir], { encoding: 'utf8' }).trim();

note('== Scenario 1: add a kimi.com account on hpc-kimi from the Providers page ==');
const beforeHash = hash(DEFAULT_HOME);
note('Default home before:\n' + beforeHash);
const before = await kimiOf();
note('GET /runners/:id engines[kimi] before:', before);

const { b, page } = await signedIn();
page.on('request', (r) => {
  if (r.method() !== 'GET' && r.url().includes('/api/runners/')) note(`web → ${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ''}`);
});
page.on('response', async (r) => {
  if (r.request().method() !== 'GET' && r.url().includes('/api/runners/')) note(`web ← ${r.status()} ${new URL(r.url()).pathname} ${(await r.text().catch(() => '')).slice(0, 400)}`);
});
await page.evaluate(([id]) => {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([id]));
  localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${id}/kimi`]));
}, [RUNNER]);
await page.goto(`${WEB}/providers?runner=${RUNNER}&engine=kimi`, { waitUntil: 'domcontentloaded' });
const kimiRow = page.locator('.re-runner-card:not(.collapsed) .re-row[data-engine="kimi"]');
await kimiRow.waitFor({ timeout: 60_000 });
const card = page.locator('.re-runner-card:not(.collapsed)').first();
await shot(page, `${OUT}/1a-before.png`, { fullPage: false, clip: await card.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 8, width: r.width + 24, height: r.height + 16 })) });

await kimiRow.locator('.re-add-account').click();
const panel = page.locator('.re-panel');
await panel.locator('.rsi-site').first().waitFor();
await panel.locator('.re-add .rsi-input').fill('Work');
await shot(page, `${OUT}/1b-name-and-site.png`, { fullPage: false, clip: await panel.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 60, width: r.width + 24, height: r.height + 72 })) });
const sites = await panel.locator('.rsi-site').allInnerTexts();
note('site choices shown:', sites);
await panel.locator('.rsi-site').filter({ hasText: 'kimi.com' }).first().click();
note('pressed kimi.com — waiting for the runner to pick the sign-in up at its next heartbeat');

const started = Date.now();
await until('the device code in the panel', async () => /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(await panel.innerText().catch(() => '')), { timeoutMs: 120_000 });
note(`device code shown after ${Math.round((Date.now() - started) / 1000)}s`);
const loginState = await call('GET', `/runners/${RUNNER}/login`, T);
note('GET /runners/:id/login:', loginState);
const panelText = await panel.innerText();
note('panel text:\n' + panelText);
await shot(page, `${OUT}/1c-device-code.png`, { fullPage: false, clip: await panel.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 60, width: r.width + 24, height: r.height + 72 })) });
if (!panelText.includes(loginState.userCode)) throw new Error('the panel does not show the runner\'s user code');

note('approving the code on the fake Kimi server as work@kimi.com (the user, in a browser on www.kimi.com)');
note('fake kimi ←', await fk('POST', '/__admin/approve', { userCode: loginState.userCode, user: 'work@kimi.com' }));
const added = await until('the new account in the runner report', async () => {
  const k = await kimiOf();
  return k?.accounts?.find((a) => a.id !== 'default' && a.auth === 'yes') ? k : null;
}, { timeoutMs: 120_000 });
note('GET /runners/:id engines[kimi] after:', added);
const work = added.accounts.find((a) => a.id !== 'default');
await page.locator('.re-acct').filter({ hasText: 'Work' }).first().waitFor({ timeout: 90_000 });
await sleep(1500);
await shot(page, `${OUT}/1d-added.png`, { fullPage: false, clip: await card.boundingBox().then((r) => ({ x: r.x - 12, y: r.y - 8, width: r.width + 24, height: r.height + 16 })) });
note('GET /runners/:id/login after:', await call('GET', `/runners/${RUNNER}/login`, T));
await b.close();

const afterHash = hash(DEFAULT_HOME);
note('Default home after:\n' + afterHash);
note('Work home:\n' + hash(work.home));
const def = added.accounts.find((a) => a.id === 'default');
const checks = {
  'new account is kimi.com, signed in': work.kimiRegion === 'mainland-cn' && work.auth === 'yes' && work.name === 'Work',
  'new account lives in <ORBIT_HOME>/kimi-accounts/<8 hex>': new RegExp(`^${S}/runners/hpc-kimi/home/kimi-accounts/[0-9a-f]{8}$`).test(work.home),
  'Default still kimi.ai, signed in': def.kimiRegion === 'global' && def.auth === 'yes' && added.kimiRegion === 'global',
  'Default home byte-identical': beforeHash === afterHash,
  'fake kimi login ran in the new account\'s home only': true,
};
const logins = execFileSync('grep', ['-h', '"login.', `${S}/logs/fake-kimi-hpc-kimi.jsonl`], { encoding: 'utf8' }).trim().split('\n').map((l) => JSON.parse(l));
const sinceStart = logins.filter((l) => l.at >= new Date(started - 60_000).toISOString());
note('fake kimi login calls during the scenario:', sinceStart.map((l) => ({ at: l.at, event: l.event, kimiCodeHome: l.kimiCodeHome, region: l.region, user: l.user })));
checks['fake kimi login ran in the new account\'s home only'] = sinceStart.length > 0 && sinceStart.every((l) => l.kimiCodeHome === work.home);
let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 1 PASS' : 'SCENARIO 1 FAIL');
sd.work = { id: work.id, home: work.home };
saveSeed(sd);
process.exit(ok ? 0 : 1);
