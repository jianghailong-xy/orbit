// The display walk (project 353SgnUjvamRr06Sho0EZ, criterion 3): the built console on a real apiserver, read for the
// approved board's three states and marks (docs/mocks/session-display-three-states).
//   1. the API's own list rows (GET /api/sessions, the six facts and the counts beside them), and from each the state
//      and marks the board's rule gives (capture/rules.mjs without Disconnected, mirrored below);
//   2. the session list on a desktop window: each row's state icon (data-state) and marks (data-mark), and its group;
//   3. each session's header on a phone window (a wide window's header is the title alone): its word and marks;
//   4. the task panel of each seeded task (run badges, their marks, the Now card), and the Tasks list's pills.
// Screenshots of each; <out>/marks.json holds every reading beside what the rule expects.
// usage: node walk-marks.mjs <walk dir> <web origin> <api origin> <out dir> [playwright module path]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [walk, origin, apiOrigin, out, pwModule = '/root/orbit/node_modules/playwright'] = process.argv.slice(2);
if (!walk || !origin || !apiOrigin || !out) throw new Error('usage: walk-marks.mjs <walk dir> <web origin> <api origin> <out dir> [playwright]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(pwModule);
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();

// ---- the board's rule (capture/rules.mjs, minus DISCONNECTED: owner approval 2026-11-25) ----
const STATES = { PENDING: 'Queued', RUNNING: 'Running', IDLE: 'Idle' };
const releasedByFailure = (p) => p.released === true && !p.endReason && p.lastTurnOutcome === 'FAILED';
function boardMarks(p) {
  const out = [];
  if (p.waitingOn === 'PERSON' || (p.pendingApprovals ?? 0) > 0) out.push('NEEDS_YOU');
  if (releasedByFailure(p)) out.push(p.waitingOn === 'WAKE' ? 'RETRYING' : 'FAILED');
  if (p.waitingOn === 'HOLD') out.push('ON_HOLD');
  if (!p.released && p.phase === 'IDLE' && p.lastTurnOutcome === 'INTERRUPTED') out.push('INTERRUPTED');
  if (!p.released && (p.activity === 'BACKGROUND_JOB' || (p.runningBgCount ?? 0) > 0)) out.push('BACKGROUND');
  if (!p.released && p.waitingOn === 'WAKE') out.push('WILL_RESUME');
  if (p.released && p.workFinished === true) out.push('FINISHED');
  if (p.released && p.workFinished !== true && !releasedByFailure(p)) out.push('ENDED');
  return out;
}

// ---- the API's own rows ----
const login = await (await fetch(`${apiOrigin}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.ownerEmail, password }),
})).json();
const token = login.accessToken ?? login.access_token ?? login.token;
const get = async (route) => (await fetch(`${apiOrigin}/api${route}`, { headers: { authorization: `Bearer ${token}` } })).json();
const listed = [];
for (const view of ['', '?view=completed']) {
  const body = await get(`/sessions${view}`);
  listed.push(...(Array.isArray(body) ? body : (body.sessions ?? body.items ?? [])));
}
const cases = {};
for (const [key, c] of Object.entries(seed.cases)) {
  const row = listed.find((s) => s.title === c.title);
  if (!row) { cases[key] = { title: c.title, missing: true }; continue; }
  const facts = Object.fromEntries(['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished', 'activity', 'pendingApprovals', 'runningBgCount', 'status'].map((k) => [k, row[k] ?? null]));
  cases[key] = { title: c.title, publicId: row.id, facts, expect: { state: STATES[row.phase], marks: boardMarks(row) } };
}

// ---- the console ----
const browser = await chromium.launch();
async function signedIn(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`${origin}/login`);
  await page.fill('input[name="email"]', seed.ownerEmail);
  await page.fill('input[name="password"]', password);
  await page.click('button.login-submit');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  return page;
}
const settle = (page) => page.waitForTimeout(2_500);

// 2. The list, on a desktop window: every row's icon state and marks, read from the DOM.
const desk = await signedIn({ width: 1440, height: 1100 });
await desk.waitForSelector('.session-row', { timeout: 30_000 });
await settle(desk);
const rows = await desk.evaluate(() => [...document.querySelectorAll('.session-row')].map((r) => ({
  title: r.querySelector('.session-title')?.textContent?.trim() ?? null,
  state: r.querySelector('.session-icon [data-state]')?.getAttribute('data-state') ?? null,
  marks: [...r.querySelectorAll('.session-marks [data-mark]')].map((m) => m.getAttribute('data-mark')),
  markWords: [...r.querySelectorAll('.session-marks [data-mark]')].map((m) => m.textContent.trim()),
  line: r.querySelector('.session-preview')?.textContent?.trim() ?? null,
  group: r.closest('section')?.querySelector(':scope > .session-section-head')?.textContent?.trim() ?? null,
})));
await desk.screenshot({ path: path.join(out, 'list-desktop.png'), fullPage: true });
for (const [key, c] of Object.entries(cases)) {
  const row = rows.find((r) => r.title === c.title);
  c.listRow = row ?? null;
  c.listMatches = !!row && row.state === c.facts?.phase && JSON.stringify(row.marks) === JSON.stringify(c.expect?.marks);
  if (row) {
    const el = desk.locator('.session-row', { has: desk.locator('.session-title', { hasText: c.title }) }).first();
    await el.screenshot({ path: path.join(out, `row-${key}.png`) });
  }
}

// 3. Each header, on a phone window.
const phone = await signedIn({ width: 393, height: 852 });
for (const [key, c] of Object.entries(cases)) {
  if (!c.publicId) continue;
  await phone.goto(`${origin}/sessions/${c.publicId}`);
  await phone.waitForSelector('.workspace-sub', { timeout: 30_000 }).catch(() => {});
  await settle(phone);
  c.header = await phone.evaluate(() => {
    const sub = document.querySelector('.workspace-sub:not([data-fork-source])');
    return {
      text: sub?.textContent?.trim() ?? null,
      marks: [...(sub?.querySelectorAll('[data-mark]') ?? [])].map((m) => m.getAttribute('data-mark')),
    };
  });
  c.headerMatches = !!c.header.text?.startsWith(c.expect.state) && JSON.stringify(c.header.marks) === JSON.stringify(c.expect.marks);
  await phone.screenshot({ path: path.join(out, `header-${key}.png`) });
}

// 4. The task panels and the Tasks list.
const tasks = {};
const taskIds = { ...(seed.tasks ?? {}) };
for (const [key, c] of Object.entries(seed.cases)) if (c.taskId) taskIds[key] = { id: c.taskId, title: c.title };
const taskList = await get('/tasks');
const taskRows = Array.isArray(taskList) ? taskList : (taskList.items ?? taskList.tasks ?? []);
for (const [key, t] of Object.entries(taskIds)) {
  const publicId = taskRows.find((r) => r.title === t.title)?.id ?? (await get(`/tasks/${t.id}`)).id;
  if (!publicId) continue;
  await desk.goto(`${origin}/tasks/${publicId}`);
  await desk.waitForSelector('a.tdp-session', { timeout: 30_000 }).catch(() => {});
  await settle(desk);
  tasks[key] = await desk.evaluate(() => ({
    runs: [...document.querySelectorAll('a.tdp-session')].map((a) => ({
      href: a.getAttribute('href'),
      badge: a.querySelector('.tdp-badge')?.textContent?.trim() ?? null,
      marks: [...a.querySelectorAll('[data-mark]')].map((m) => m.getAttribute('data-mark')),
      dot: a.querySelector('.tdp-dot')?.className ?? null,
    })),
    now: document.querySelector('.tdp-now-title')?.textContent?.trim() ?? null,
    nowMarks: [...document.querySelectorAll('.tdp-now-title [data-mark]')].map((m) => m.getAttribute('data-mark')),
  }));
  await desk.screenshot({ path: path.join(out, `task-${key}.png`) });
}
await desk.goto(`${origin}/tasks`);
await desk.waitForSelector('.task-status-cell', { timeout: 30_000 }).catch(() => {});
await settle(desk);
const pills = await desk.evaluate(() => [...document.querySelectorAll('.task-status-cell')].map((cell) => ({
  title: cell.parentElement?.querySelector('.task-title')?.textContent?.trim() ?? null,
  word: cell.querySelector('.status-pill')?.textContent?.trim() ?? null,
  marks: [...cell.querySelectorAll('[data-mark]')].map((m) => m.getAttribute('data-mark')),
})));
await desk.screenshot({ path: path.join(out, 'tasks-list.png') });
await browser.close();

const result = { at: new Date().toISOString(), cases, tasks, pills };
fs.writeFileSync(path.join(out, 'marks.json'), JSON.stringify(result, null, 2));
for (const [key, c] of Object.entries(cases)) {
  console.log(`${key.padEnd(16)} api=${c.facts?.phase}/${(c.expect?.marks ?? []).join('+') || '-'} list=${c.listRow?.state}/${(c.listRow?.marks ?? []).join('+') || '-'} [${c.listRow?.group}] header=${JSON.stringify(c.header?.text)} ${c.listMatches && c.headerMatches ? 'OK' : 'MISMATCH'}`);
}
for (const [key, t] of Object.entries(tasks)) console.log(`task ${key}: ${JSON.stringify(t)}`);
console.log(`pills: ${JSON.stringify(pills)}`);
const bad = Object.values(cases).filter((c) => !(c.listMatches && c.headerMatches));
console.log(bad.length ? `MISMATCHES: ${bad.length}` : 'every case matches the board');
process.exit(bad.length ? 1 : 0);
