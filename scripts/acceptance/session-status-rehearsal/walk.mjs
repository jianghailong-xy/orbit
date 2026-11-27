// The real-stack walk of docs/session-status-retirement-plan.md §7.3, one pass: the scenarios below, run against the
// rehearsal stack (rehearse.sh) with a real runner (go build of src/runner-go) whose only engine is the landing-measured
// kit's fake claude. Every scenario is driven through the owner's HTTP API (the replica named by --api) and read back
// from the database read-only; the few rows written by statement say so and are the statements a server's writer
// sends. Each pass writes <out>/walk-<label>.json: per scenario, the observations (words, turn states, phases, the
// runner's slot count, refusals, the payload words), with session ids replaced by the scenario's own names, so two
// passes compare line by line (compare.mjs).
//
//   node walk.mjs <label> --api <base URL> --code d1|d2|d3|d4
//
// --code says which code writes the statement rows (S5, S6): d1 the word only, d2 the word and turn_state, d3 and d4
// turn_state only, as each deploy's writer does. A d3 or d4 pass reads each row's word from its facts through the
// projector's SQL (scripts/lib/session-word.mjs), so it runs on a database with or without session.status; a d1 or d2
// pass reads the stored column, which is what those deploys decided by. The first pass registers the runner and its workspace ($LM_DIR/walk-state.json keeps them).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionWordSql } from '../../lib/session-word.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const KIT = join(REPO, 'scripts', 'acceptance', 'landing-measured');
const PROJECT = process.env.LM_PROJECT;
const S = process.env.LM_DIR;
const OUT = process.env.OUT;
const args = process.argv.slice(2);
const label = args[0];
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const API = opt('--api');
const CODE = opt('--code');
if (!label || !API || !['d1', 'd2', 'd3', 'd4'].includes(CODE) || !PROJECT || !S || !OUT) {
  console.error('usage: walk.mjs <label> --api <base> --code d1|d2|d3|d4   (env LM_PROJECT, LM_DIR, OUT)');
  process.exit(2);
}
/** SQL for the status word of the session row the query names `row`: the stored column for a D1 or D2 pass, the
 *  projector over the row's facts from D3 on. */
const wordOf = (row) => (CODE === 'd1' || CODE === 'd2' ? `${row}.status` : sessionWordSql(row));
const SCRATCH = `${S}/ops-out`;
mkdirSync(SCRATCH, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (line) => console.log(`${new Date().toISOString()} [${label}] ${line}`);

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function attempt(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return res.ok ? { ok: true, status: res.status, answer: json } : { ok: false, status: res.status, body: json };
}
async function call(method, path, token, body) {
  const r = await attempt(method, path, token, body);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`);
  return r.answer;
}
async function until(what, fn, timeoutMs = 120_000, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── database (read-only, but for the statements named below) ─────────────────────────────────────────────────────────
function value(sql, write = false) {
  const env = write ? [] : ['-e', 'PGOPTIONS=-c default_transaction_read_only=on'];
  return execFileSync('docker', ['exec', ...env, `${PROJECT}-postgres`, 'psql', '-U', 'orbit', '-d', 'orbit', '-X', '-tA',
    '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}
const json = (sql) => JSON.parse(value(sql) || 'null');

function stack(...a) {
  return execFileSync('bash', [join(KIT, 'stack.sh'), ...a], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}
const flag = (name, on) => (on ? writeFileSync(join(SCRATCH, name), '') : rmSync(join(SCRATCH, name), { force: true }));

// ── the walk's world ─────────────────────────────────────────────────────────────────────────────────────────────────
const stateFile = `${S}/walk-state.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const password = readFileSync(`${S}/stack/secrets/owner_password`, 'utf8').trim();
const T = (await call('POST', '/auth/login', undefined, { email: 'owner@orbit-staging.test', password })).accessToken;

if (!state.runnerId) {
  const name = 'lm42-runner';
  let runner = (await call('GET', '/runners', T)).find((x) => x.name === name);
  if (!runner) {
    const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 't16 walk runner' });
    stack('build-runner');
    stack('repo', '_root');
    say(stack('register', enroll.token));
  }
  say(stack('start-runner'));
  runner = await until('the walk runner online', async () => (await call('GET', '/runners', T)).find((x) => x.name === name && x.online), 120_000, 2_000);
  let ws = (await call('GET', '/workspaces', T)).find((x) => x.name === 't16-walk');
  if (!ws) {
    const [work] = stack('repo', 't16-walk').split(' ');
    ws = await call('POST', '/workspaces', T, {
      name: 't16-walk', description: 'T16 rehearsal walk (fake engine: no model is ever called)',
      runnerId: runner.id, workDir: work, enableWorktree: false, defaultMergeTarget: 'main',
    });
  }
  await until('the runner to report its workspace', async () => (await call('GET', '/workspaces', T)).find((x) => x.id === ws.id && x.repoUrl), 300_000, 3_000);
  Object.assign(state, { runnerId: runner.id, runnerUuid: value(`select id from runner where name = '${name}'`), workspaceId: ws.id });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
const { runnerId, runnerUuid, workspaceId } = state;
say(`api ${API}, code ${CODE}, runner ${runnerId} (${runnerUuid}), workspace ${workspaceId}`);

// ── observations ─────────────────────────────────────────────────────────────────────────────────────────────────────
const names = new Map(); // session uuid -> scenario name
const pidOf = new Map(); // scenario name -> public id
const uuidOf = new Map();
async function newSession(name, prompt) {
  const s = await call('POST', '/sessions', T, { workspaceId, permissionMode: 'auto', engine: 'claude', title: `${label} ${name}`, prompt });
  const id = value(`select id from session where title = '${label} ${name}' order by created_at desc limit 1`);
  names.set(id, name); pidOf.set(name, s.id); uuidOf.set(name, id);
  return name;
}
const ROW = (ids) => `select coalesce(json_agg(json_build_object('id', id, 'status', ${wordOf('s')}, 'turn_state', turn_state, 'phase', phase,
  'released', finished_at is not null, 'end_reason', end_reason, 'outcome', last_turn_outcome,
  'open_turns', (select count(*) from conversation_turn t where t.session_id = s.id and t.answered_at is null)) order by title), '[]')
  from session s where id in (${ids.map((i) => `'${i}'`).join(',')})`;
async function slots() {
  const r = (await call('GET', '/runners', T)).find((x) => x.id === runnerId);
  return r?.activeSessions ?? null;
}
const PAYLOAD_KEYS = ['status', 'runStatus', 'runState', 'sessionState', 'phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason'];
async function payload(name) {
  const p = await call('GET', `/sessions/${pidOf.get(name)}`, T);
  return Object.fromEntries(PAYLOAD_KEYS.map((k) => [k, p[k] ?? null]));
}
/** The rows of these scenario sessions, by name, with the runner's slot count. */
async function snap(...list) {
  const rows = json(ROW(list.map((n) => uuidOf.get(n))));
  const out = { slots: await slots() };
  for (const r of rows) {
    const { id, ...rest } = r;
    out[names.get(id)] = rest;
  }
  return out;
}
const word = (name) => value(`select ${wordOf('session')} || '/' || coalesce(turn_state, '-') || '/' || coalesce(phase, '-') from session where id = '${uuidOf.get(name)}'`);
const parked = (name) => until(`${name} parked with every turn answered`, () => value(`select finished_at is null and ${wordOf('s')} = 'AWAITING_INPUT'
  and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null) from session s where id = '${uuidOf.get(name)}'`) === 't', 120_000);
const isWord = (name, w) => until(`${name} ${w}`, () => value(`select ${wordOf('session')} from session where id = '${uuidOf.get(name)}'`) === w, 120_000, 250);
const released = (name, timeoutMs = 120_000) => until(`${name} released`, () => value(`select finished_at is not null from session where id = '${uuidOf.get(name)}'`) === 't', timeoutMs, 500);
const send = (name, content) => attempt('POST', `/sessions/${pidOf.get(name)}/turns`, T, { clientTurnId: randomUUID(), content });
const refusal = (r) => (r.ok ? 'ok' : `${r.status} ${r.body?.code ?? r.body?.error ?? ''}`.trim());
const setRunner = (body) => call('PATCH', `/runners/${runnerId}`, T, body);
/** Which word sequence a session went through, sampled every 200 ms until done() holds. */
async function trace(list, done, timeoutMs = 120_000) {
  const seen = Object.fromEntries(list.map((n) => [n, []]));
  const end = Date.now() + timeoutMs;
  for (;;) {
    for (const n of list) { const w = word(n); const a = seen[n]; if (a[a.length - 1] !== w) a.push(w); }
    if (await done()) return seen;
    if (Date.now() > end) throw new Error(`trace timed out for ${list.join(', ')}`);
    await sleep(200);
  }
}

/** A row's public id: its uuid in base62 (0-9A-Za-z), as the API spells it. */
function publicIdOf(id) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let n = BigInt(`0x${id.replace(/-/g, '')}`);
  let out = '';
  while (n > 0n) { out = alphabet[Number(n % 62n)] + out; n /= 62n; }
  return out || '0';
}

const result = { label, api: API, code: CODE, runnerId, startedAt: new Date().toISOString(), scenarios: {} };
const failures = [];
// WALK_ONLY=<key>,<key>: run only those scenarios (by the key's first word, e.g. S8r). S8r runs only when named: it waits
// out the reaper's two-minute cancel grace.
const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null;
async function scenario(key, fn, { onlyWhenNamed = false } = {}) {
  const short = key.split(' ')[0];
  if (ONLY ? !ONLY.includes(short) : onlyWhenNamed) return;
  say(`== ${key}`);
  const start = Date.now();
  try {
    result.scenarios[key] = await fn();
  } catch (err) {
    failures.push(key);
    result.scenarios[key] = { error: String(err.message ?? err) };
    say(`${key} FAILED: ${err.message}`);
  }
  result.scenarios[key] = { ...result.scenarios[key], ms: Date.now() - start };
  writeFileSync(join(OUT, `walk-${label}.json`), JSON.stringify(result, null, 1));
}

await setRunner({ maxConcurrent: 2, burstConcurrent: 1 });

// S1: max_concurrent 2, three sessions sent at once; one finishes.
await scenario('S1 slots', async () => {
  for (const x of ['a', 'b', 'c']) flag(`${label}-s1-${x}`, true);
  for (const x of ['a', 'b', 'c']) await newSession(`S1 ${x}`, `E2E-HOLD-WHILE ${label}-s1-${x}`);
  await until('two of S1 running', () => Number(value(`select count(*) from session where id in (${['a', 'b', 'c'].map((x) => `'${uuidOf.get(`S1 ${x}`)}'`).join(',')}) and ${wordOf('session')} = 'RUNNING'`)) === 2, 120_000);
  await sleep(4_000);
  const full = await snap('S1 a', 'S1 b', 'S1 c');
  const queued = ['a', 'b', 'c'].find((x) => full[`S1 ${x}`].status === 'PENDING');
  const first = ['a', 'b', 'c'].find((x) => x !== queued);
  flag(`${label}-s1-${first}`, false);
  await parked(`S1 ${first}`);
  await isWord(`S1 ${queued}`, 'RUNNING');
  await sleep(2_000);
  const after = await snap('S1 a', 'S1 b', 'S1 c');
  for (const x of ['a', 'b', 'c']) flag(`${label}-s1-${x}`, false);
  for (const x of ['a', 'b', 'c']) await parked(`S1 ${x}`);
  const idle = await snap('S1 a', 'S1 b', 'S1 c');
  return { queuedWas: queued, full: { slots: full.slots, words: ['a', 'b', 'c'].map((x) => full[`S1 ${x}`].status).sort() },
    afterOneFinished: { slots: after.slots, queuedNow: after[`S1 ${queued}`].status, turnState: after[`S1 ${queued}`].turn_state },
    idle: { slots: idle.slots, words: ['a', 'b', 'c'].map((x) => idle[`S1 ${x}`].status) }, rows: { full, after, idle } };
});

// S3: Run now past a full runner (maxConcurrent 2, burstConcurrent 1).
await scenario('S3 run now', async () => {
  for (const x of ['a', 'b', 'c', 'd']) flag(`${label}-s3-${x}`, true);
  for (const x of ['a', 'b', 'c', 'd']) await newSession(`S3 ${x}`, `E2E-HOLD-WHILE ${label}-s3-${x}`);
  await until('two of S3 running', () => Number(value(`select count(*) from session where title like '${label} S3 %' and ${wordOf('session')} = 'RUNNING'`)) === 2, 120_000);
  await sleep(3_000);
  const queued = ['a', 'b', 'c', 'd'].filter((x) => value(`select ${wordOf('session')} from session where id = '${uuidOf.get(`S3 ${x}`)}'`) === 'PENDING');
  const first = await attempt('POST', `/sessions/${pidOf.get(`S3 ${queued[0]}`)}/run-now`, T);
  if (first.ok) await isWord(`S3 ${queued[0]}`, 'RUNNING').catch(() => null);
  await sleep(2_000);
  const second = await attempt('POST', `/sessions/${pidOf.get(`S3 ${queued[1]}`)}/run-now`, T);
  await sleep(2_000);
  const rows = await snap('S3 a', 'S3 b', 'S3 c', 'S3 d');
  for (const x of ['a', 'b', 'c', 'd']) flag(`${label}-s3-${x}`, false);
  for (const x of ['a', 'b', 'c', 'd']) await parked(`S3 ${x}`);
  return { firstRunNow: refusal(first), secondRunNow: refusal(second),
    words: ['a', 'b', 'c', 'd'].map((x) => rows[`S3 ${x}`].status).sort(), slots: rows.slots,
    overCapacity: Number(value(`select count(*) from session where title like '${label} S3 %' and over_capacity_turn_id is not null`)) };
});

// S4: a message to a parked session whose background job runs.
await scenario('S4 background job', async () => {
  const n = await newSession('S4', `E2E-MCP s4-${label} bg_run {"command":"sleep 75","kind":"job","description":"t16 S4 job"}`);
  await parked(n);
  await until('S4 background job reported', () => value(`select cardinality(running_bg_jobs) > 0 from session where id = '${uuidOf.get(n)}'`) === 't', 60_000);
  const parkedWithJob = { ...(await snap(n)), payload: await payload(n) };
  // The runner's one slot is taken first, so the message waits for its claim where it can be read.
  await setRunner({ maxConcurrent: 1 });
  flag(`${label}-s4-f`, true);
  const f = await newSession('S4 filler', `E2E-HOLD-WHILE ${label}-s4-f`);
  await isWord(f, 'RUNNING');
  flag(`${label}-s4`, true);
  const sent = await send(n, `E2E-HOLD-WHILE ${label}-s4`);
  await sleep(3_000);
  const queued = { ...(await snap(n, f)), payload: await payload(n) };
  flag(`${label}-s4-f`, false);
  await isWord(n, 'RUNNING');
  await sleep(1_000);
  const claimed = { ...(await snap(n, f)), payload: await payload(n) };
  flag(`${label}-s4`, false);
  await parked(n);
  await parked(f);
  await setRunner({ maxConcurrent: 2 });
  return { sent: refusal(sent), parkedWithJob, queued, claimed, after: await snap(n) };
});

// S5: a parked session with a running sub-agent (running_subagents written by statement, as event ingestion writes it).
await scenario('S5 sub-agent', async () => {
  const n = await newSession('S5', 'Say hello');
  await parked(n);
  const before = await snap(n);
  value(`update session set running_subagents = array['agent-t16'], updated_at = now() where id = '${uuidOf.get(n)}'`, true);
  await sleep(1_500);
  const during = { ...(await snap(n)), payload: await payload(n) };
  value(`update session set running_subagents = '{}', updated_at = now() where id = '${uuidOf.get(n)}'`, true);
  await sleep(1_500);
  return { before, during, after: { ...(await snap(n)), payload: await payload(n) } };
});

// S7: turn-complete with a follow-up queued, without one, and a failed turn (old protocol: the switch is off).
await scenario('S7 turn complete', async () => {
  flag(`${label}-s7`, true);
  const a = await newSession('S7 follow-up', `E2E-HOLD-WHILE ${label}-s7`);
  await isWord(a, 'RUNNING');
  const queuedSend = await send(a, 'the follow-up');
  await sleep(1_000);
  const withQueued = await snap(a);
  flag(`${label}-s7`, false);
  const seqA = await trace([a], async () => value(`select ${wordOf('s')} = 'AWAITING_INPUT' and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null) from session s where id = '${uuidOf.get(a)}'`) === 't', 120_000);
  const b = await newSession('S7 single', 'Say hello');
  const seqB = await trace([b], async () => value(`select ${wordOf('s')} = 'AWAITING_INPUT' and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null) from session s where id = '${uuidOf.get(b)}'`) === 't', 120_000);
  const c = await newSession('S7 failed', 'E2E-FAIL: the build tool crashed (exit 2)');
  await released(c);
  return { queuedSend: refusal(queuedSend), withQueued, followUpWords: seqA[a], singleWords: seqB[b],
    failed: { ...(await snap(c)), payload: await payload(c) } };
});

// S8: ends: parked, running, queued; task done is S9's.
await scenario('S8 ends', async () => {
  const p = await newSession('S8 parked', 'Say hello');
  await parked(p);
  const endParked = await attempt('POST', `/sessions/${pidOf.get(p)}/end`, T);
  await released(p);
  flag(`${label}-s8-r`, true);
  const r = await newSession('S8 running', `E2E-HOLD-WHILE ${label}-s8-r`);
  await isWord(r, 'RUNNING');
  const endRunning = await attempt('POST', `/sessions/${pidOf.get(r)}/end`, T);
  flag(`${label}-s8-r`, false);
  await released(r);
  // queued: fill the runner first
  await setRunner({ maxConcurrent: 1 });
  flag(`${label}-s8-f`, true);
  const f = await newSession('S8 filler', `E2E-HOLD-WHILE ${label}-s8-f`);
  await isWord(f, 'RUNNING');
  const q = await newSession('S8 queued', 'Say hello');
  await sleep(3_000);
  const queuedWord = word(q);
  const endQueued = await attempt('POST', `/sessions/${pidOf.get(q)}/end`, T);
  await released(q);
  flag(`${label}-s8-f`, false);
  await parked(f);
  await setRunner({ maxConcurrent: 2 });
  const rows = await snap(p, r, q);
  return { endParked: refusal(endParked), endRunning: refusal(endRunning), endQueued: refusal(endQueued), queuedWord,
    rows, payloads: { parked: await payload(p), running: await payload(r), queued: await payload(q) } };
});

// S9: a task run, a second run refused while it holds the task, batch stop, task delete.
await scenario('S9 task run', async () => {
  flag(`${label}-s9`, true);
  const task = await call('POST', '/tasks', T, {
    assigneeId: workspaceId, title: `${label} S9 task`, description: `E2E-HOLD-WHILE ${label}-s9\nSay done.`,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
    autoRunWhenReady: false,
  });
  const run = await attempt('POST', `/tasks/${task.id}/execute`, T, { triggerId: randomUUID() });
  const sid = await until('the task run session', () => value(`select id from session where task_id = (select id from task where title = '${label} S9 task') order by created_at desc limit 1`) || null, 60_000);
  names.set(sid, 'S9 run'); uuidOf.set('S9 run', sid);
  pidOf.set('S9 run', publicIdOf(sid));
  await isWord('S9 run', 'RUNNING');
  const again = await attempt('POST', `/tasks/${task.id}/execute`, T, { triggerId: randomUUID() });
  const occupied = { ...(await snap('S9 run')), taskStatus: (await call('GET', `/tasks/${task.id}`, T)).status };
  const stop = await attempt('POST', '/tasks/batch-stop', T, { taskIds: [task.id] });
  flag(`${label}-s9`, false);
  await released('S9 run', 120_000).catch(() => null);
  const stopped = { ...(await snap('S9 run')), taskStatus: (await call('GET', `/tasks/${task.id}`, T)).status };
  const del = await attempt('DELETE', `/tasks/${task.id}`, T);
  return { execute: refusal(run), executeAgain: refusal(again), occupied, batchStop: refusal(stop), stopped, delete: refusal(del) };
});

// S10: the dispatch pause on and off.
await scenario('S10 dispatch pause', async () => {
  const on = await attempt('PUT', '/admin/dispatch-pause', T, { paused: true });
  const n = await newSession('S10', 'Say hello');
  await sleep(10_000);
  const whilePaused = { ...(await snap(n)), payload: await payload(n) };
  const off = await attempt('PUT', '/admin/dispatch-pause', T, { paused: false });
  const seq = await trace([n], async () => value(`select ${wordOf('s')} = 'AWAITING_INPUT' and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null) from session s where id = '${uuidOf.get(n)}'`) === 't', 120_000);
  return { pause: refusal(on), whilePaused, unpause: refusal(off), words: seq[n] };
});

// S6: restart the runner with sessions RUNNING, PENDING, AWAITING_INPUT and one ABANDONED (writer #1's statement).
await scenario('S6 runner restart', async () => {
  await setRunner({ maxConcurrent: 1 });
  flag(`${label}-s6-r`, true);
  const a = await newSession('S6 parked', 'Say hello');
  await parked(a);
  const x = await newSession('S6 abandoned', 'Say hello');
  await parked(x);
  const r = await newSession('S6 running', `E2E-HOLD-WHILE ${label}-s6-r`);
  await isWord(r, 'RUNNING');
  const p = await newSession('S6 queued', 'Say hello');
  await sleep(2_000);
  // writer #1 (managed-runners/managed-runner-manager.ts commitStopped): the out-of-memory stop, as each deploy writes it
  const moved = [CODE === 'd1' || CODE === 'd2' ? `status = 'INTERRUPTED'` : null, CODE === 'd1' ? null : `turn_state = 'ABANDONED'`]
    .filter(Boolean).join(', ');
  value(`update session set ${moved}, error = 'Stopped because the machine ran out of memory twice while this turn was running. Send a message to continue.',
    last_turn_outcome = 'INTERRUPTED', engine_turn_active = false, retry_at = null, retry_claimed_at = null, updated_at = now() where id = '${uuidOf.get(x)}'`, true);
  const before = await snap(a, x, r, p);
  const logFrom = existsSync(`${S}/logs/runner.log`) ? readFileSync(`${S}/logs/runner.log`).length : 0;
  say(stack('kill-runner'));
  await sleep(3_000);
  say(stack('start-runner'));
  await until('runner online again', async () => (await call('GET', '/runners', T)).find((y) => y.id === runnerId && y.online), 120_000, 1_000);
  await sleep(8_000);
  const afterRestart = await snap(a, x, r, p);
  flag(`${label}-s6-r`, false);
  await until('S6 queued answered', () => value(`select ${wordOf('s')} = 'AWAITING_INPUT' and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null) from session s where id = '${uuidOf.get(p)}'`) === 't', 180_000).catch(() => null);
  const settled = await snap(a, x, r, p);
  const logLines = readFileSync(`${S}/logs/runner.log`).subarray(logFrom).toString('utf8').split('\n')
    .filter((l) => /reclaim|takeover|resum|cold|active/i.test(l)).map((l) => {
      let s = l;
      for (const [id, nm] of names) s = s.split(id).join(`<${nm}>`);
      return s.replace(/^\S+ \S+ /, '').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<id>').slice(0, 300);
    })
    // Only this scenario's sessions, in a fixed order: the reclaim also names every other held session of the runner,
    // a number that grows pass by pass, and logs them in no fixed order.
    .filter((l) => /<S6 /.test(l)).map((l) => l.replace(/ — \S+ S6 .*$/, '')).sort();
  await setRunner({ maxConcurrent: 2 });
  return { before, afterRestart, settled, runnerLog: logLines, payloads: { parked: await payload(a), abandoned: await payload(x), running: await payload(r), queued: await payload(p) } };
});

// S8r: an end the runner does not honour (plan §3.4 C1): a task run stopped (batch stop, reason `cancelled`) while its
// runner is down, released by the reaper once the two-minute cancel grace has passed.
await scenario('S8r end not honoured', async () => {
  flag(`${label}-s8r`, true);
  const task = await call('POST', '/tasks', T, {
    assigneeId: workspaceId, title: `${label} S8r task`, description: `E2E-HOLD-WHILE ${label}-s8r\nSay done.`,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
    autoRunWhenReady: false,
  });
  await call('POST', `/tasks/${task.id}/execute`, T, { triggerId: randomUUID() });
  const sid = await until('the S8r run session', () => value(`select id from session where task_id = (select id from task where title = '${label} S8r task') order by created_at desc limit 1`) || null, 60_000);
  names.set(sid, 'S8r run'); uuidOf.set('S8r run', sid); pidOf.set('S8r run', publicIdOf(sid));
  await isWord('S8r run', 'RUNNING');
  // The turn is in the engine's hands before its runner goes: a stop of an undelivered turn answers it at once.
  await until('the S8r turn delivered', () => value(`select delivered_at is not null from conversation_turn where session_id = '${sid}' and seq = 1`) === 't', 60_000, 100);
  say(stack('kill-runner'));
  const stop = await attempt('POST', '/tasks/batch-stop', T, { taskIds: [task.id] });
  const stopped = await snap('S8r run');
  await released('S8r run', 330_000);
  flag(`${label}-s8r`, false);
  const rows = await snap('S8r run');
  const facts = json(`select json_build_object('error', error, 'cancel_requested', cancel_requested_at is not null) from session where id = '${sid}'`);
  say(stack('start-runner'));
  await until('runner online again', async () => (await call('GET', '/runners', T)).find((y) => y.id === runnerId && y.online), 120_000, 1_000);
  return { batchStop: refusal(stop), stopped, released: rows, facts, payload: await payload('S8r run') };
}, { onlyWhenNamed: true });

// S11: the ?status= filter with each word (GET /sessions/compact, what `orbit session list --status` reads), over this pass's sessions.
await scenario('S11 status filter', async () => {
  const out = {};
  for (const w of ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED']) {
    const r = await attempt('GET', `/sessions/compact?status=${w}`, T);
    const list = Array.isArray(r.answer) ? r.answer : r.answer?.items ?? r.answer?.sessions ?? [];
    out[w] = r.ok ? list.filter((s) => String(s.title ?? '').startsWith(`${label} `)).map((s) => s.title.slice(label.length + 1)).sort() : refusal(r);
  }
  return out;
});

// S12: the payload of every session this pass walked.
await scenario('S12 payloads', async () => {
  const out = {};
  for (const name of [...pidOf.keys()].sort()) if (pidOf.get(name)) out[name] = await payload(name);
  return out;
});

result.finishedAt = new Date().toISOString();
result.ms = Date.now() - t0;
result.failures = failures;
result.sessions = Object.fromEntries([...pidOf.entries()].map(([n, p]) => [n, { publicId: p, id: uuidOf.get(n) }]));
writeFileSync(join(OUT, `walk-${label}.json`), JSON.stringify(result, null, 1));
say(`done in ${Math.round(result.ms / 1000)} s; failures: ${failures.length ? failures.join(', ') : 'none'}`);
process.exit(failures.length ? 1 : 0);
