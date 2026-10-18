// Scenario 3 — the session of scenario 2 has said something on Work; it is switched to Default from the web's
// composer (Provider submenu) and goes on with the same conversation: the runner carries it into Default's home,
// Kimi resumes it by id, and the next reply lists every earlier turn.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { S, WEB, call, login, logTo, note, seed, shotDir, sleep, until } from './lib.mjs';
import { signedIn, shot } from './ui.mjs';
import { fakeKimiEvents, sendMessage, waitForTurns } from './flows.mjs';

const OUT = shotDir('3-switch-to-default');
writeFileSync(`${OUT}/scenario3.log`, '');
logTo(`${OUT}/scenario3.log`);
const sd = seed();
const R = `${S}/runners/hpc-kimi`;
const DEFAULT_HOME = `${R}/userhome/.kimi-code`;
const WORK = sd.work;
const SID = sd.session2.id;
const KID = sd.session2.kimiSessionId;
const T = await login();
const detail = async () => {
  const s = await call('GET', `/sessions/${SID}`, T, undefined, { quiet: true });
  return { status: s.status, kimiAccount: s.kimiAccount, kimiAccountPinned: s.kimiAccountPinned, workspaceKimiAccount: s.workspace?.kimiAccount, runtimeSessionId: s.runtimeSessionId };
};
const turnsDone = async () => (await call('GET', `/sessions/${SID}/turns`, T, undefined, { quiet: true }).catch(() => null));
note('== Scenario 3: a session that has talked on Work moves to Default and goes on ==');
note('session before:', SID, await detail());
const logStart = new Date().toISOString();

const { b, page } = await signedIn();
page.on('request', (r) => {
  const p = new URL(r.url()).pathname;
  if (r.method() !== 'GET' && p.startsWith(`/api/sessions/${SID}`)) note(`web → ${r.method()} ${p} ${r.postData() ?? ''}`.slice(0, 500));
});
page.on('response', async (r) => {
  const p = new URL(r.url()).pathname;
  if (r.request().method() !== 'GET' && p.startsWith(`/api/sessions/${SID}`)) note(`web ← ${r.status()} ${p} ${(await r.text().catch(() => '')).slice(0, 300)}`);
});
await page.goto(`${WEB}/sessions/${SID}`, { waitUntil: 'domcontentloaded' });
await page.getByText('[fake kimi 2.1.1]', { exact: false }).first().waitFor({ timeout: 60_000 });
const answered = () => fakeKimiEvents('hpc-kimi', SID).filter((e) => e.event === 'acp.prompt').length;
const send = async (text) => {
  const before = answered();
  await sendMessage(page, SID, text);
  await waitForTurns('hpc-kimi', SID, '', before + 1);
};

// one more turn on Work, so the conversation has said more than its first message there
await send('Scenario 3, turn 2: still on Work.');
await shot(page, `${OUT}/3a-two-turns-on-work.png`, { fullPage: false });

// the composer's model chip → Provider → Default
await page.locator('button.composer-model-chip').click();
const provider = page.locator('.ant-dropdown-menu-submenu-title').filter({ hasText: /^Provider/ }).first();
await provider.hover();
await provider.click().catch(() => {});
const items = page.locator('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item');
await items.first().waitFor({ timeout: 15_000 });
await sleep(600);
note('Provider submenu rows:', await items.allInnerTexts());
await shot(page, `${OUT}/3b-provider-menu.png`, { fullPage: false });
await items.filter({ hasText: /^Default/ }).first().click();
const switched = await until('the session to name Default', async () => {
  const d = await detail();
  return d.kimiAccount === 'default' ? d : null;
}, { timeoutMs: 30_000 });
note('session after the switch:', switched);
await sleep(1500);

await send('Scenario 3, turn 3: now on Default — what have I said so far?');
await shot(page, `${OUT}/3c-continued-on-default.png`, { fullPage: false });
const last = await page.getByText('[fake kimi 2.1.1]', { exact: false }).last().evaluate((el) => (el.closest('[class*="msg"], [class*="turn"], article, li, div') ?? el).innerText);
note('last reply as shown:\n' + last);
await b.close();

const events = readFileSync(`${S}/logs/fake-kimi-hpc-kimi.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.orbitSession === SID && e.at >= logStart && /^acp\.(start|session|prompt|exit)/.test(e.event));
note('fake kimi, this session since the scenario began:', events.map((e) => ({ at: e.at, event: e.event, account: e.account, accountHome: e.accountHome, sessionsLink: e.sessionsLink, sessionId: e.sessionId, turnsFound: e.turnsFound, turn: e.turn, earlierTurns: e.earlierTurns })));
const runnerLog = execFileSync('grep', ['-a', `kimi conversation for ${KID}`, `${S}/logs/runner-hpc-kimi.log`], { encoding: 'utf8' }).trim();
note('runner log:\n' + runnerLog);
const inDefault = execFileSync('find', [DEFAULT_HOME, '-maxdepth', '3', '-path', `*${KID}*`], { encoding: 'utf8' }).trim();
const inWork = execFileSync('find', [WORK.home, '-maxdepth', '3', '-path', `*${KID}*`], { encoding: 'utf8' }).trim();
note(`kimi session ${KID} in Default's home:\n${inDefault || '(none)'}\nin Work's home:\n${inWork || '(none)'}`);
note("Default's session_index.jsonl:\n" + readFileSync(`${DEFAULT_HOME}/session_index.jsonl`, 'utf8').trim());

const lastPrompt = [...events].reverse().find((e) => e.event === 'acp.prompt');
const resume = events.find((e) => e.event === 'acp.session.resume' && e.account === 'default');
const checks = {
  'the web switched the session with PATCH /sessions/:id/account {account:"default"}': switched.kimiAccount === 'default' && switched.kimiAccountPinned === true,
  "the runner carried the conversation from Work to Default": runnerLog.includes(`carried from account ${WORK.id}`) && runnerLog.includes('to default'),
  'kimi resumed the same session id on Default with its two turns': !!resume && resume.sessionId === KID && resume.turnsFound === 2,
  'the reply on Default came from account default and read both earlier turns': lastPrompt?.account === 'default' && lastPrompt?.earlierTurns === 2,
  'the reply shown lists the turns said on Work': /Scenario 2: which Kimi account/.test(last) && /Scenario 3, turn 2: still on Work/.test(last),
  "Default's home now holds the conversation (Work keeps its copy)": !!inDefault && !!inWork,
};
void turnsDone;
let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 3 PASS' : 'SCENARIO 3 FAIL');
process.exit(ok ? 0 : 1);
