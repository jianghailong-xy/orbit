// Scenario 4 — each Kimi account's quota is read from its own login and shown on its own row; NEXT (and
// Automatic, which starts new sessions there) follows the quota.
//   round 1  Default nearly spent (5h at 85%): NEXT is Work, and a new Automatic session starts on Work
//   round 2  Work nearly spent (5h at 90%), Default fresh: NEXT is Default, and so is the new session
//   round 3  a session Automatic put on Work runs into Work's usage limit mid-conversation: the control plane moves
//            it to Default and sends the message again, and the runner carries the conversation there
//   refresh  Default's first token lives four minutes (seed.mjs): its quota is read on, through a refresh on its
//            own site under Kimi's lock
// Each round sets the accounts' usage on the fake Kimi server and restarts the runner, which otherwise reads an
// idle account's quota every 10 minutes (planUsageIdleInterval).
import { readFileSync, writeFileSync } from 'node:fs';
import { S, WEB, call, fk, login, logTo, note, seed, shotDir, sleep, stack, until } from './lib.mjs';
import { fakeKimiEvents, newKimiSession, runnerMetaFor, sendMessage, setWorkspaceKimiAccount, waitForTurns } from './flows.mjs';
import { signedIn, shot } from './ui.mjs';

const OUT = shotDir('4-quota-next');
writeFileSync(`${OUT}/scenario4.log`, '');
logTo(`${OUT}/scenario4.log`);
const sd = seed();
const RUNNER = sd.runners['hpc-kimi'].id;
const WS = sd.workspaces['hpc-kimi'].id;
const WORK = sd.work;
const T = await login();
note('== Scenario 4: per-account quota, NEXT and Automatic follow it ==');

const pct = (w) => (w ? `${w.utilization}%` : '—');
async function readQuota(expect) {
  const r = await until('the runner to report the new quota', async () => {
    const x = await call('GET', `/runners/${RUNNER}`, T, undefined, { quiet: true });
    const k = x.planUsage?.kimi;
    const w = k?.accounts?.[WORK.id];
    return k && w && k.fiveHour?.utilization === expect.default && w.fiveHour?.utilization === expect.work ? x : null;
  }, { timeoutMs: 120_000, everyMs: 2000 });
  const k = r.planUsage.kimi;
  const w = k.accounts[WORK.id];
  note('planUsage.kimi as stored (Default = the snapshot\'s own windows, Work = accounts[id]):',
    { default: { fiveHour: pct(k.fiveHour), sevenDay: pct(k.sevenDay), month: pct(k.month), monthCode: pct(k.monthCode), fetchedAt: k.fetchedAt },
      [WORK.id]: { fiveHour: pct(w.fiveHour), sevenDay: pct(w.sevenDay), month: pct(w.month), monthCode: pct(w.monthCode), fetchedAt: w.fetchedAt } });
  return r;
}

async function round(n, { defaultRatios, workRatios, expectNext, prompt }) {
  note(`-- round ${n}: default@kimi.ai ${JSON.stringify(defaultRatios)}, work@kimi.com ${JSON.stringify(workRatios)} --`);
  note('fake kimi ←', await fk('POST', '/__admin/usage', { user: 'default@kimi.ai', ...defaultRatios }).then((u) => u.ratios));
  note('fake kimi ←', await fk('POST', '/__admin/usage', { user: 'work@kimi.com', ...workRatios }).then((u) => u.ratios));
  note(stack('stop', 'hpc-kimi').trim());
  note(stack('start', 'hpc-kimi').trim());
  await readQuota({ default: Math.round(defaultRatios.limit_5h * 100), work: Math.round(workRatios.limit_5h * 100) });

  const { b, page } = await signedIn();
  await page.evaluate(([id]) => localStorage.setItem('orbit:providers-open-accounts', JSON.stringify([`${id}/kimi`])), [RUNNER]);
  await page.goto(`${WEB}/providers?runner=${RUNNER}&engine=kimi`, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('.re-runner-card:not(.collapsed) .re-acct');
  await rows.nth(1).waitFor({ timeout: 60_000 });
  await until('both rows to show quota', async () => (await rows.allInnerTexts()).every((t) => /5h limit/.test(t)), { timeoutMs: 60_000 });
  await sleep(800);
  const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  note('account rows as shown:', texts);
  const kimiHead = page.locator('.re-runner-card:not(.collapsed) .re-row[data-engine="kimi"]');
  const card = page.locator('.re-runner-card:not(.collapsed)').first();
  const box = await kimiHead.boundingBox();
  const cardBox = await card.boundingBox();
  const last = await rows.last().boundingBox();
  await shot(page, `${OUT}/4${'ab'[n - 1]}1-accounts-open.png`, { fullPage: false, clip: { x: cardBox.x - 12, y: box.y - 8, width: cardBox.width + 24, height: last.y + last.height - box.y + 16 } });
  // folded: the head speaks for the group
  await kimiHead.locator('.re-grp-toggle').click();
  await sleep(800);
  const head = (await kimiHead.innerText()).replace(/\s+/g, ' ').trim();
  note('Kimi head, folded:', head);
  const hb = await kimiHead.boundingBox();
  await shot(page, `${OUT}/4${'ab'[n - 1]}2-folded.png`, { fullPage: false, clip: { x: cardBox.x - 12, y: hb.y - 8, width: cardBox.width + 24, height: hb.height + 16 } });
  const nextRow = texts.find((t) => /NEXT/.test(t)) ?? '';

  // Automatic: the workspace leaves the account to Orbit; a new session starts on NEXT
  if (n === 1) await setWorkspaceKimiAccount(page, { runner: RUNNER, workspaceName: 'hpc-kimi-ws', option: /^Automatic/, shotTo: `${OUT}/4a3-workspace-automatic.png`, shot });
  const ws = await call('GET', `/workspaces/${WS}`, T, undefined, { quiet: true });
  note('workspace kimiAccount (null = Automatic):', ws.kimiAccount);
  const since = new Date().toISOString();
  const sid = await newKimiSession(page, { workspace: WS, prompt, shotTo: `${OUT}/4${'ab'[n - 1]}4-new-session-automatic.png`, shot });
  await waitForTurns('hpc-kimi', sid, since, 1);
  await page.locator('button.composer-usage').first().click().catch(() => {});
  await sleep(800);
  await shot(page, `${OUT}/4${'ab'[n - 1]}5-session-on-next.png`, { fullPage: false });
  const gauge = await page.locator('.cu-account-name').first().innerText().catch(() => null);
  note('composer quota gauge names:', gauge);
  await b.close();
  const s = await call('GET', `/sessions/${sid}`, T, undefined, { quiet: true });
  note('new session:', { id: sid, kimiAccount: s.kimiAccount, kimiAccountPinned: s.kimiAccountPinned, workspaceKimiAccount: s.workspace?.kimiAccount });
  const ev = fakeKimiEvents('hpc-kimi', sid, since);
  const kid = ev.find((e) => e.event === 'acp.session.new')?.sessionId;
  const meta = runnerMetaFor('hpc-kimi', kid);
  note('runner record:', { file: meta?.file, kimiCodeHome: meta?.meta.kimiCodeHome ?? '(none: Default)' });
  note('fake kimi:', ev.filter((e) => /^acp\.(start|session\.new|prompt)/.test(e.event)).map((e) => ({ event: e.event, account: e.account, accountHome: e.accountHome })));
  const nextId = expectNext === 'Work' ? WORK.id : 'default';
  return {
    [`round ${n}: NEXT is on ${expectNext}`]: nextRow.startsWith(expectNext),
    [`round ${n}: the folded head names ${expectNext} next`]: new RegExp(`Next: ${expectNext}`).test(head),
    [`round ${n}: each row shows its own 5h quota`]: texts.some((t) => t.startsWith('Default') && t.includes(`${Math.round(defaultRatios.limit_5h * 100)}%`)) && texts.some((t) => t.startsWith('Work') && t.includes(`${Math.round(workRatios.limit_5h * 100)}%`)),
    [`round ${n}: Automatic started the new session on ${expectNext}`]: s.kimiAccount === nextId && s.kimiAccountPinned === false,
    [`round ${n}: the session ran in ${expectNext}'s KIMI_CODE_HOME`]: expectNext === 'Work' ? meta?.meta.kimiCodeHome === WORK.home : !meta?.meta.kimiCodeHome,
    [`round ${n}: the fake kimi answered as ${expectNext}`]: ev.some((e) => e.event === 'acp.prompt' && e.account === nextId),
  };
}

const checks = {
  ...(await round(1, {
    defaultRatios: { limit_5h: 0.85, limit_7d: 0.4, limit_month_total: 0.3, limit_month_code: 0.2 },
    workRatios: { limit_5h: 0.2, limit_7d: 0.15, limit_month_total: 0.1, limit_month_code: 0.05 },
    expectNext: 'Work', prompt: 'Scenario 4, round 1: started on Automatic — which account?',
  })),
  ...(await round(2, {
    defaultRatios: { limit_5h: 0.1, limit_7d: 0.4, limit_month_total: 0.3, limit_month_code: 0.2 },
    workRatios: { limit_5h: 0.9, limit_7d: 0.15, limit_month_total: 0.1, limit_month_code: 0.05 },
    expectNext: 'Default', prompt: 'Scenario 4, round 2: started on Automatic — which account?',
  })),
};
// Round 3 — Automatic at the limit: a session Automatic started on Work (NEXT) runs into Work's usage limit
// mid-conversation. Kimi ends the turn failed (APIProviderQuotaExhaustedError in its wire — the fake refuses a turn
// once the fake server says the login's quota is used up), the runner reports the usage limit, the control plane
// moves the session to the account with room (Default) and sends the message again, and the runner carries the
// conversation to Default before Kimi resumes it there.
{
  note('-- round 3: Automatic moves a session off an account that hits its limit --');
  note('fake kimi ←', (await fk('POST', '/__admin/usage', { user: 'work@kimi.com', limit_5h: 0.1, limit_7d: 0.1, limit_month_total: 0.05, limit_month_code: 0.05 })).ratios);
  note('fake kimi ←', (await fk('POST', '/__admin/usage', { user: 'default@kimi.ai', limit_5h: 0.85, limit_7d: 0.3, limit_month_total: 0.2, limit_month_code: 0.1 })).ratios);
  note(stack('stop', 'hpc-kimi').trim());
  note(stack('start', 'hpc-kimi').trim());
  await readQuota({ default: 85, work: 10 });
  const { b, page } = await signedIn();
  const since = new Date().toISOString();
  const sid = await newKimiSession(page, { workspace: WS, prompt: 'Scenario 4, round 3, turn 1: started on Automatic.' });
  await waitForTurns('hpc-kimi', sid, since, 1);
  const first = await call('GET', `/sessions/${sid}`, T, undefined, { quiet: true });
  note('session after turn 1:', { id: sid, kimiAccount: first.kimiAccount, kimiAccountPinned: first.kimiAccountPinned });
  note('work@kimi.com runs out — fake kimi ←', (await fk('POST', '/__admin/usage', { user: 'work@kimi.com', limit_5h: 1 })).ratios);
  await sendMessage(page, sid, 'Scenario 4, round 3, turn 2: sent after Work ran out — what have I said so far?');
  await page.getByText('Usage limit reached', { exact: false }).first().waitFor({ timeout: 120_000 }).catch(() => {});
  await sleep(1000);
  await shot(page, `${OUT}/4c1-usage-limit-reached.png`, { fullPage: false });
  // the control plane sends the message again once the session is on an account with room
  await waitForTurns('hpc-kimi', sid, since, 1, { where: (e) => e.account === 'default' });
  await shot(page, `${OUT}/4c2-moved-to-default.png`, { fullPage: false });
  await b.close();
  const after = await call('GET', `/sessions/${sid}`, T, undefined, { quiet: true });
  note('session after turn 2:', { kimiAccount: after.kimiAccount, kimiAccountPinned: after.kimiAccountPinned, status: after.status });
  const ev = fakeKimiEvents('hpc-kimi', sid, since);
  const prompts = ev.filter((e) => e.event === 'acp.prompt');
  note('fake kimi turns:', prompts.map((e) => ({ at: e.at, account: e.account, reason: e.reason, earlierTurns: e.earlierTurns })));
  const kid = ev.find((e) => e.event === 'acp.session.new')?.sessionId;
  const carried = readFileSync(`${S}/logs/runner-hpc-kimi.log`, 'utf8').split('\n').filter((l) => l.includes(`kimi conversation for ${kid}`));
  note('runner log:\n' + carried.join('\n'));
  Object.assign(checks, {
    'round 3: Automatic started the session on Work': prompts[0]?.account === WORK.id,
    "round 3: Work's turn ended on its usage limit": prompts.some((e) => e.account === WORK.id && e.reason === 'failed'),
    'round 3: the session moved to Default (still Automatic) and the message was answered there, with turn 1': after.kimiAccount === 'default' && after.kimiAccountPinned === false && prompts.some((e) => e.account === 'default' && e.reason === 'completed' && e.earlierTurns >= 1),
    'round 3: the runner carried the conversation from Work to Default': carried.some((l) => l.includes(`carried from account ${WORK.id}`) && l.includes('to default')),
  });
  // Work back to room for the scenarios after this one
  note('fake kimi ←', (await fk('POST', '/__admin/usage', { user: 'work@kimi.com', limit_5h: 0.2, limit_7d: 0.15, limit_month_total: 0.1, limit_month_code: 0.05 })).ratios);
}

// Default's first token lives four minutes (seed.mjs). Once it is past (or within the runner's 30-second lead of)
// its expiry, the runner reads Default's quota only by refreshing it on the account's own site, auth.kimi.ai,
// under Kimi's lock (kimi_refresh_lock.go), and then with the new token. A restart makes it read at once.
const refreshedDefault = () => readFileSync(`${S}/logs/fake-kimi-requests.jsonl`, 'utf8').trim().split('\n')
  .some((l) => { const r = JSON.parse(l); return r.grant === 'refresh_token' && r.user === 'default@kimi.ai'; });
if (!refreshedDefault()) {
  const state = await fk('GET', '/__admin/state');
  const exp = Math.min(...Object.values(state.access).filter((a) => a.user === 'default@kimi.ai').map((a) => Date.parse(a.exp)));
  const wait = Math.min(exp - 25_000 - Date.now(), 300_000);
  note(`Default's token expires ${new Date(exp).toISOString()}${wait > 0 ? `; waiting ${Math.round(wait / 1000)}s` : ''}`);
  if (wait > 0) await sleep(wait);
  note(stack('stop', 'hpc-kimi').trim());
  note(stack('start', 'hpc-kimi').trim());
  await until('the refresh', async () => refreshedDefault(), { timeoutMs: 90_000, everyMs: 2000 }).catch(() => {});
  await sleep(3000);
}
const requests = readFileSync(`${S}/logs/fake-kimi-requests.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const refreshes = requests.filter((r) => r.grant === 'refresh_token' && r.user === 'default@kimi.ai');
note('token refreshes of default@kimi.ai seen by the fake Kimi server:', refreshes);
const lastRefresh = refreshes[refreshes.length - 1];
const readsAfter = lastRefresh ? requests.filter((r) => r.path.endsWith('/usages') && r.user === 'default@kimi.ai' && r.at > lastRefresh.at) : [];
note('Default quota reads after it:', readsAfter.map((r) => ({ at: r.at, host: r.host, token: r.token, status: r.status })));
checks["Default's expired token was refreshed on its own site, and its quota read with the new one"] =
  !!lastRefresh && lastRefresh.status === 200 && lastRefresh.host.startsWith('auth.kimi.ai:') &&
  readsAfter.some((r) => r.status === 200 && r.token === lastRefresh.newToken);
let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 4 PASS' : 'SCENARIO 4 FAIL');
process.exit(ok ? 0 : 1);
