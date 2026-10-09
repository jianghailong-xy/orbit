// Scenario 2 — the workspace picks the account added in scenario 1 (Work); a new Kimi session started from the
// web then runs with Work's KIMI_CODE_HOME: the runner's overlay borrows Work's directory, and the conversation is
// written there.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { S, WEB, call, login, logTo, note, seed, saveSeed, shotDir, sleep, until } from './lib.mjs';
import { signedIn, shot } from './ui.mjs';
import { waitForTurns } from './flows.mjs';

const OUT = shotDir('2-workspace-account');
writeFileSync(`${OUT}/scenario2.log`, '');
logTo(`${OUT}/scenario2.log`);
const sd = seed();
const RUNNER = sd.runners['hpc-kimi'].id;
const WS = sd.workspaces['hpc-kimi'].id;
const WORK = sd.work;
const R = `${S}/runners/hpc-kimi`;
const DEFAULT_HOME = `${R}/userhome/.kimi-code`;
const T = await login();
note('== Scenario 2: the workspace picks Work; a new session runs on its KIMI_CODE_HOME ==');
note('Work account:', WORK);
note('workspace before:', await call('GET', `/workspaces/${WS}`, T, undefined, { quiet: true }).then((w) => ({ id: w.id, name: w.name, kimiAccount: w.kimiAccount })));

const { b, page } = await signedIn();
const sent = [];
page.on('request', (r) => {
  const p = new URL(r.url()).pathname;
  if (r.method() !== 'GET' && /\/api\/(workspaces|sessions)/.test(p)) { sent.push({ method: r.method(), path: p, body: r.postData() }); note(`web → ${r.method()} ${p} ${r.postData() ?? ''}`.slice(0, 700)); }
});

// ── the workspace form: Advanced → Kimi account → Work → Save ──
await page.goto(`${WEB}/runners/${RUNNER}`, { waitUntil: 'domcontentloaded' });
const row = page.locator('.rd-workspace-row').filter({ hasText: 'hpc-kimi-ws' }).first();
await row.waitFor({ timeout: 60_000 });
await row.click();
const adv = page.locator('.rd-adv-toggle').first();
await adv.waitFor({ timeout: 30_000 });
await adv.click();
const field = page.locator('.rd-form-field').filter({ has: page.locator('.rd-form-label', { hasText: /^Kimi account$/ }) }).first();
await field.waitFor({ timeout: 30_000 });
await field.scrollIntoViewIfNeeded();
await field.locator('[role=combobox]').click();
await sleep(800);
const options = await page.locator('[role=option]').allInnerTexts();
note('Kimi account options:', options);
await shot(page, `${OUT}/2a-workspace-kimi-account-options.png`, { fullPage: false });
await page.locator('[role=option]').filter({ hasText: /^Work/ }).first().click();
await sleep(400);
await shot(page, `${OUT}/2b-workspace-kimi-account-work.png`, { fullPage: false, clip: await field.boundingBox().then((r) => ({ x: r.x - 16, y: r.y - 12, width: r.width + 32, height: r.height + 24 })) });
await page.getByRole('button', { name: /^Save$/ }).first().click();
const ws = await until('the workspace to name Work', async () => {
  const w = await call('GET', `/workspaces/${WS}`, T, undefined, { quiet: true });
  return w.kimiAccount === WORK.id ? w : null;
}, { timeoutMs: 30_000 });
note('workspace after Save:', { id: ws.id, kimiAccount: ws.kimiAccount });

// ── a new session from the web: the hero's engine → Kimi, then the composer ──
await page.goto(`${WEB}/workspaces/${WS}/new`, { waitUntil: 'domcontentloaded' });
await page.locator('button[aria-label^="Engine:"]').click();
await page.locator('.np-row').filter({ has: page.locator('.np-row-name', { hasText: /^Kimi/ }) }).first().click();
await sleep(800);
const PROMPT = 'Scenario 2: which Kimi account is this session on?';
await page.locator('.composer-box textarea, textarea').first().fill(PROMPT);
await shot(page, `${OUT}/2c-new-session-kimi.png`, { fullPage: false });
await page.locator('button[aria-label="Send"]').click();
await page.waitForURL(/\/sessions\//, { timeout: 60_000 });
const sessionId = page.url().split('/sessions/')[1].split(/[/?#]/)[0];
note('session', sessionId);
await waitForTurns('hpc-kimi', sessionId, '', 1);
await shot(page, `${OUT}/2d-session-reply.png`, { fullPage: false });
await b.close();

const s = await call('GET', `/sessions/${sessionId}`, T, undefined, { quiet: true });
note('GET /sessions/:id:', { id: s.id, provider: s.provider, status: s.status, kimiAccount: s.kimiAccount, kimiAccountPinned: s.kimiAccountPinned, workspaceKimiAccount: s.workspace?.kimiAccount, runtimeSessionId: s.runtimeSessionId });

// the runner's own record of the session, and the fake kimi's word on the home it ran in
const metas = readdirSync(`${R}/home/runs`).map((d) => `${R}/home/runs/${d}/meta.json`).filter(existsSync)
  .map((f) => ({ f, m: JSON.parse(readFileSync(f, 'utf8')) })).filter(({ m }) => m.provider === 'kimi');
note('runner session records (runs/*/meta.json, kimi):', metas.map(({ f, m }) => ({ file: f.replace(S, '$S'), kimiCodeHome: m.kimiCodeHome, runtimeSessionId: m.runtimeSessionId ?? m.sessionUUID })));
const events = readFileSync(`${S}/logs/fake-kimi-hpc-kimi.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.orbitSession === sessionId && /^acp\.(start|session|prompt)/.test(e.event));
note('fake kimi, this session:', events.map((e) => ({ at: e.at, event: e.event, kimiCodeHome: e.kimiCodeHome, sessionsLink: e.sessionsLink, account: e.account, accountHome: e.accountHome, sessionDir: e.sessionDir, turn: e.turn })));
const overlay = events.find((e) => e.event === 'acp.start')?.kimiCodeHome;
if (overlay && existsSync(overlay)) note('the overlay, live:\n' + execFileSync('ls', ['-la', overlay], { encoding: 'utf8' }));
const kimiId = events.find((e) => e.event === 'acp.session.new')?.sessionId;
const inWork = execFileSync('find', [WORK.home, '-maxdepth', '3', '-path', `*${kimiId}*`], { encoding: 'utf8' }).trim();
const inDefault = execFileSync('find', [DEFAULT_HOME, '-maxdepth', '3', '-path', `*${kimiId}*`], { encoding: 'utf8' }).trim();
note(`kimi session ${kimiId} in Work's home:\n${inWork || '(none)'}`);
note(`kimi session ${kimiId} in Default's home:\n${inDefault || '(none)'}`);
note('Work session_index.jsonl:\n' + (existsSync(`${WORK.home}/session_index.jsonl`) ? readFileSync(`${WORK.home}/session_index.jsonl`, 'utf8').trim() : '(none)'));

const metaOf = metas.find(({ m }) => (m.runtimeSessionId ?? '') === kimiId) ?? metas[metas.length - 1];
const checks = {
  'the web saved kimiAccount = Work on the workspace': sent.some((r) => r.method === 'PATCH' && r.path === `/api/workspaces/${WS}` && JSON.parse(r.body || '{}').kimiAccount === WORK.id),
  'the session runs Kimi': s.provider === 'kimi',
  'the runner recorded KIMI_CODE_HOME = Work': metaOf?.m.kimiCodeHome === WORK.home,
  "kimi ran in an overlay whose sessions/ is Work's": !!overlay && overlay !== WORK.home && events.find((e) => e.event === 'acp.start')?.sessionsLink === `${WORK.home}/sessions`,
  'the fake kimi answered as account Work': events.some((e) => e.event === 'acp.prompt' && e.account === WORK.id),
  "the conversation is in Work's home, not Default's": !!inWork && !inDefault,
};
let ok = true;
for (const [k, v] of Object.entries(checks)) { note(`${v ? 'PASS' : 'FAIL'} ${k}`); ok &&= v; }
note(ok ? 'SCENARIO 2 PASS' : 'SCENARIO 2 FAIL');
sd.session2 = { id: sessionId, kimiSessionId: kimiId };
saveSeed(sd);
process.exit(ok ? 0 : 1);
