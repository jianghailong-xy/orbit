// The startNow / "Create and start" end to end, on the isolated stack (stack.sh + bootstrap.mjs first):
//   node scenario.mjs
//
// One conversation in the stack's workspace. Its engine is the fake claude, which calls the real `task_create` /
// `task_create_batch` MCP tools through the `orbit mcp` server the runner configured (E2E-MCP lines). Each card
// that call raises is read, photographed and answered in the real web console (Playwright on the built dist), as
// the owner would. What reaches the runner and what it was answered is in the proxy's wire log; the database is
// read only, at the end.
//
//   A  task_create with startNow             card: "1 starts running within the minute", no Create and start;
//                                            "Create it" -> created and started at once -> its session
//   B  task_create without startNow          card: "1 needs a manual start" + Create and start;
//                                            "Create and start" -> created and started at once -> its session
//   C  the same without startNow             "Create it" (the plain yes) -> created, stays OPEN, no session, past a
//                                            minute of schedule scans
//   D  task_create_batch, one item startNow  card counts it as starting within the minute and has no Create and
//                                            start; approved -> that item started by the server's scan, the other OPEN
//   E  startNow beside runAt                 refused before any card is raised
//
// Writes ../run/: transcript.md, checks.json, the MCP answers, the wire log's records, API reads, queries.txt and
// the card screenshots.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  HERE, S, WEB, call, evidence, jsonLinesSince, login, logSize, mcpAnswer, readState, saveState, sendTurn, sleep, until,
} from './lib.mjs';

const require = createRequire(join(HERE, '../../../../../package.json'));
const { chromium } = require('playwright');

const ev = evidence('run');
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  ev.say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const shots = join(ev.dir, 'shots');
mkdirSync(shots, { recursive: true });

const state = readState();
const auth = await login();
const T = auth.accessToken;
const ws = state.workspace;
const wire = `${S}/logs/runner-wire.jsonl`;
const fakeLog = `${S}/logs/fake-claude.jsonl`;
const marks = { wire: logSize(wire), fake: logSize(fakeLog) };
ev.say(`stack ${S}; built from ${state.sourceSha ?? '(see SOURCE_SHA)'}; workspace ${ws.id}; runner ${state.runner.id}`);

// ── the conversation that files the tasks ────────────────────────────────────────────────────────────
const conversation = await call('POST', '/sessions', T, {
  workspaceId: ws.id, prompt: 'E2E: the conversation that files tasks (fake engine).', provider: 'claude', clientTurnId: crypto.randomUUID(),
});
state.conversationId = conversation.id;
saveState(state);
ev.say(`conversation ${conversation.id}`);
await until('the conversation to answer its first turn', async () => {
  const s = await call('GET', `/sessions/${conversation.id}`, T);
  return s.status === 'AWAITING_INPUT' ? s : null;
}, { timeoutMs: 180_000 });

// ── the owner's browser ──────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
await context.addInitScript(([token, refresh]) => {
  localStorage.setItem('orbit_token', token);
  localStorage.setItem('orbit_refresh', refresh);
}, [T, auth.refreshToken]);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${WEB}/sessions/${conversation.id}`);
await page.waitForSelector('.composer, textarea', { timeout: 60_000 });

/** The pending card the conversation is showing now, once its body has drawn. */
async function cardOnScreen(title) {
  const card = page.locator('.approval-card', { hasText: title }).last();
  await card.waitFor({ state: 'visible', timeout: 120_000 });
  await card.scrollIntoViewIfNeeded();
  await sleep(500);
  return card;
}

async function shoot(card, name) {
  const path = join(shots, `${name}.png`);
  await card.screenshot({ path });
  ev.say(`screenshot ${name}.png`);
  return path;
}

const buttons = async (card) => (await card.locator('button').allTextContents()).map((t) => t.trim());

/** File one task through the fake engine's real MCP call; returns once the card is on screen. */
async function fileThroughMcp(callId, tool, args) {
  await sendTurn(T, conversation.id, `E2E-MCP ${callId} ${tool} ${JSON.stringify(args)}`);
}

async function taskByTitle(title) {
  return until(`task "${title}"`, async () => {
    const page1 = await call('GET', `/tasks/page?limit=50&counts=none`, T);
    return (page1.items ?? []).find((t) => t.title === title) ?? null;
  }, { timeoutMs: 120_000, everyMs: 1_500 });
}

async function sessionsOf(taskId) {
  const task = await call('GET', `/tasks/${taskId}`, T);
  return { task, sessions: task.sessions ?? [] };
}

const description = (what) => `${what}\n\nE2E-DO: commit`;
const base = (title, what) => ({
  title, description: description(what), completionCriterion: 'EVIDENCE_JUDGMENT',
  acceptanceCriteria: 'The run left its work file in the worktree.',
});
const results = {};

// ── A: startNow ──────────────────────────────────────────────────────────────────────────────────────
{
  const title = 'E2E A: filed with startNow';
  await fileThroughMcp('A', 'task_create', { ...base(title, 'Filed with startNow: one approval creates and starts it.'), startNow: true });
  const card = await cardOnScreen(title);
  const text = await card.innerText();
  await shoot(card, 'A-startNow-card-no-button');
  check('A: the card forecasts "1 starts running within the minute"', text.includes('1 starts running within the minute'), text.split('\n').slice(0, 4).join(' | '));
  const labels = await buttons(card);
  check('A: the card offers no Create and start (the task starts by itself)', !labels.some((l) => l.startsWith('Create and start')), labels);
  await card.locator('button', { hasText: 'Create it' }).first().click();
  const answer = await mcpAnswer('A');
  results.A = { mcp: answer };
  check('A: task_create answered without error', !answer.isError, answer.text.slice(0, 200));
  check('A: its answer says the task was started at once', answer.text.includes('Started at once'));
  const task = await taskByTitle(title);
  const live = await until('A\'s session', async () => {
    const r = await sessionsOf(task.id);
    return r.sessions.length ? r : null;
  }, { timeoutMs: 120_000 });
  results.A.task = live.task;
  check('A: the task has a session it started', live.sessions.length === 1, live.sessions.map((s) => `${s.id} ${s.status}`));
}

// ── B: Create and start ──────────────────────────────────────────────────────────────────────────────
{
  const title = 'E2E B: approved with Create and start';
  await fileThroughMcp('B', 'task_create', base(title, 'Filed without startNow; the owner presses Create and start.'));
  const card = await cardOnScreen(title);
  const text = await card.innerText();
  await shoot(card, 'B-create-and-start-card-with-button');
  check('B: the card forecasts a manual start', /1 needs? a manual start/.test(text), text.split('\n').slice(0, 4).join(' | '));
  const labels = await buttons(card);
  check('B: the card offers Create and start beside Create it', labels.some((l) => l.startsWith('Create it')) && labels.some((l) => l.startsWith('Create and start')), labels);
  await card.locator('button', { hasText: 'Create and start' }).click();
  const answer = await mcpAnswer('B');
  results.B = { mcp: answer };
  check('B: task_create answered without error', !answer.isError, answer.text.slice(0, 200));
  check('B: its answer says the task was started at once', answer.text.includes('Started at once'));
  const task = await taskByTitle(title);
  const live = await until('B\'s session', async () => {
    const r = await sessionsOf(task.id);
    return r.sessions.length ? r : null;
  }, { timeoutMs: 120_000 });
  results.B.task = live.task;
  check('B: the task has a session it started', live.sessions.length === 1, live.sessions.map((s) => `${s.id} ${s.status}`));
}

// ── C: the plain yes (control) ───────────────────────────────────────────────────────────────────────
let cTaskId;
{
  const title = 'E2E C: plain Create it (control)';
  await fileThroughMcp('C', 'task_create', base(title, 'Filed without startNow; the owner presses the plain Create it.'));
  const card = await cardOnScreen(title);
  await shoot(card, 'C-plain-card-with-button');
  await card.locator('button', { hasText: 'Create it' }).first().click();
  const answer = await mcpAnswer('C');
  results.C = { mcp: answer };
  check('C: task_create answered without error', !answer.isError, answer.text.slice(0, 200));
  check('C: its answer says nothing about a start', !answer.text.includes('Started') && !answer.text.includes('deferred'));
  const task = await taskByTitle(title);
  cTaskId = task.id;
}

// ── D: a batch with one startNow item ────────────────────────────────────────────────────────────────
{
  const titles = ['E2E D1: batch item with startNow', 'E2E D2: batch item without'];
  await fileThroughMcp('D', 'task_create_batch', { tasks: [
    { ...base(titles[0], 'Batch item with startNow: the server\'s scan starts it within the minute.'), startNow: true },
    base(titles[1], 'Batch item without startNow.'),
  ] });
  const card = page.locator('.approval-card', { hasText: 'Confirm: create 2 tasks?' }).last();
  await card.waitFor({ state: 'visible', timeout: 120_000 });
  await card.scrollIntoViewIfNeeded();
  await sleep(500);
  const text = await card.innerText();
  await shoot(card, 'D-batch-card');
  check('D: the batch card counts the startNow item as starting within the minute', text.includes('1 starts running within the minute'), text.split('\n').slice(0, 5).join(' | '));
  check('D: the batch card has no Create and start', !(await buttons(card)).some((l) => l.startsWith('Create and start')));
  await card.locator('button', { hasText: 'Create 2 tasks' }).click();
  const answer = await mcpAnswer('D');
  results.D = { mcp: answer };
  check('D: task_create_batch answered without error', !answer.isError, answer.text.slice(0, 200));
  const d1 = await taskByTitle(titles[0]);
  const d2 = await taskByTitle(titles[1]);
  const started = await until('D1 to be started by the scan', async () => {
    const r = await sessionsOf(d1.id);
    return r.sessions.length ? r : null;
  }, { timeoutMs: 150_000, everyMs: 3_000 });
  results.D.d1 = started.task;
  results.D.d2 = (await sessionsOf(d2.id)).task;
  check('D: the startNow item was started (by the scan) within the minute', started.sessions.length === 1, started.sessions.map((s) => `${s.id} ${s.status}`));
  check('D: the other item stays OPEN with no session', results.D.d2.status === 'OPEN' && (results.D.d2.sessions ?? []).length === 0);
}

// ── E: startNow beside runAt ─────────────────────────────────────────────────────────────────────────
{
  const before = jsonLinesSince(wire).filter((r) => r.kind === 'card-filed').length;
  await fileThroughMcp('E', 'task_create', { ...base('E2E E: refused', 'Never created.'), startNow: true, runAt: '2026-12-01T09:00:00Z' });
  const answer = await mcpAnswer('E');
  results.E = { mcp: answer };
  check('E: startNow beside runAt is refused', answer.isError && answer.text.includes('startNow cannot be combined with runAt'), answer.text.slice(0, 200));
  check('E: no card was raised for it', jsonLinesSince(wire).filter((r) => r.kind === 'card-filed').length === before);
}

// ── C, a minute later: still OPEN, never started ─────────────────────────────────────────────────────
await sleep(70_000);
{
  const r = await sessionsOf(cTaskId);
  results.C.task = r.task;
  check('C: a minute of schedule scans later the plain create is still OPEN, with no session and no runAt',
    r.task.status === 'OPEN' && r.sessions.length === 0 && r.task.runAt === null, `${r.task.status}, sessions ${r.sessions.length}, runAt ${r.task.runAt}`);
}

// ── settle the started runs and record their sessions ───────────────────────────────────────────────
await sleep(15_000);
const sessionRows = {};
for (const key of ['A', 'B']) {
  const r = await sessionsOf(results[key].task.id);
  results[key].task = r.task;
  sessionRows[key] = r.sessions.map((s) => ({ id: s.id, status: s.status, runState: s.runState, createdAt: s.createdAt }));
}
{
  const r = await sessionsOf(results.D.d1.id);
  results.D.d1 = r.task;
  sessionRows.D1 = r.sessions.map((s) => ({ id: s.id, status: s.status, runState: s.runState, createdAt: s.createdAt }));
}
ev.file('sessions.json', sessionRows);
for (const [key, rows] of Object.entries(sessionRows)) ev.say(`${key}: session ${rows.map((s) => `${s.id} ${s.status}`).join(', ')}`);

// ── the wire: what the runner sent and was answered ─────────────────────────────────────────────────
const records = jsonLinesSince(wire, marks.wire);
ev.file('runner-wire.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const filed = records.filter((r) => r.kind === 'card-filed');
const titleOf = (r) => r.request?.input?.title ?? (r.request?.input?.tasks ?? []).map((t) => t.title).join(' + ');
const cardA = filed.find((r) => titleOf(r) === 'E2E A: filed with startNow');
const cardB = filed.find((r) => titleOf(r) === 'E2E B: approved with Create and start');
check('wire: A\'s card was filed with a due runAt', !!cardA?.request?.input?.runAt
  && Date.parse(cardA.request.input.runAt) <= Date.parse(cardA.at), cardA?.request?.input?.runAt);
check('wire: B\'s card was filed with no runAt', cardB && cardB.request.input.runAt === undefined);
check('wire: each single-task card was filed declaring that its runner acts on Create and start',
  [cardA, cardB].every((r) => r?.request?.acceptsStartAfterCreate === true && r.request.input.acceptsStartAfterCreate === undefined));
// The forecast the server attached to each card when it filed it (cardInput -> previewCreateMany), as the owner reads it.
const stored = await call('GET', `/sessions/${conversation.id}/approvals`, T);
ev.file('approvals.json', stored);
const storedOf = (title) => stored.find((a) => a.input?.title === title);
check('stored: A\'s card forecast startingNow 1', storedOf('E2E A: filed with startNow')?.input?.preview?.startingNow === 1,
  storedOf('E2E A: filed with startNow')?.input?.preview);
check('stored: B\'s and C\'s cards forecast needsManualStart 1',
  ['E2E B: approved with Create and start', 'E2E C: plain Create it (control)'].every((t) => storedOf(t)?.input?.preview?.needsManualStart === 1));
check('stored: the server recorded that declaration on each single-task card, and not on the batch card',
  ['E2E A: filed with startNow', 'E2E B: approved with Create and start', 'E2E C: plain Create it (control)']
    .every((t) => storedOf(t)?.input?.acceptsStartAfterCreate === true)
  && stored.filter((a) => a.toolName === 'orbit_task_batch').every((a) => a.input?.acceptsStartAfterCreate === undefined));
check('stored: every card the owner answered here is ALLOWED',
  ['E2E A: filed with startNow', 'E2E B: approved with Create and start', 'E2E C: plain Create it (control)'].every((t) => storedOf(t)?.status === 'ALLOWED'));
const polls = records.filter((r) => r.kind === 'card-poll');
check('wire: the Create and start decision reached the runner as startAfterCreate: true',
  polls.some((r) => r.answer?.startAfterCreate === true), polls.map((r) => `${r.answer?.status}${r.answer?.startAfterCreate ? '+start' : ''}`));
check('wire: no other decision carried a start', polls.filter((r) => r.answer?.startAfterCreate === true).length === 1);
const creates = records.filter((r) => r.kind === 'task-create');
const starts = records.filter((r) => r.kind === 'task-start');
const createOf = (title) => creates.find((r) => r.request?.title === title);
check('wire: A\'s create carried the runAt its card showed', createOf('E2E A: filed with startNow')?.request?.runAt === cardA?.request?.input?.runAt);
check('wire: B\'s create carried a runAt (the owner\'s start)', !!createOf('E2E B: approved with Create and start')?.request?.runAt);
check('wire: C\'s create carried no runAt', createOf('E2E C: plain Create it (control)')?.request?.runAt === undefined);
check('wire: exactly two immediate starts, for A and B', starts.length === 2
  && starts.some((r) => r.path.includes(`/tasks/${results.A.task.id}/`) || r.path.includes(`/tasks/${results.A.task.publicId}/`))
  && starts.some((r) => r.path.includes(`/tasks/${results.B.task.id}/`) || r.path.includes(`/tasks/${results.B.task.publicId}/`)),
  starts.map((r) => `${r.path} ${r.status}`));

// ── the database, read only ─────────────────────────────────────────────────────────────────────────
ev.query('the cards and their answers', `SELECT tool_name, status, start_after_create, input->>'acceptsStartAfterCreate' AS accepts,
  input->>'title' AS title, input->>'runAt' AS run_at,
  input->'preview'->>'startingNow' AS starting_now, input->'preview'->>'needsManualStart' AS needs_manual_start
  FROM approval WHERE tool_name IN ('orbit_task_create', 'orbit_task_batch') ORDER BY created_at`);
ev.query('the tasks and the sessions that run them', `SELECT t.title, t.status, t.run_at, s.id AS session_id, s.status AS session_status, s.created_at
  FROM task t LEFT JOIN session s ON s.task_id = t.id ORDER BY t.created_at`);

ev.file('results.json', results);
ev.file('checks.json', { passed: checks.filter((c) => c.ok).length, total: checks.length, pageErrors, checks });
await browser.close();
const failed = checks.filter((c) => !c.ok);
ev.say(`${checks.length - failed.length}/${checks.length} checks passed${pageErrors.length ? `; page errors: ${pageErrors.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
