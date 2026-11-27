// API and runner load for a release hand-over of the rehearsal stack (task T17, D3 to D4): what a deployment's
// clients and runners do while two releases serve one database, with every call's answer recorded by the release that
// gave it.
//
//   node load.mjs        (env LM_PROJECT, LM_DIR, OUT; stop it by creating $OUT/load.stop)
//
// The targets are the apiserver containers that serve now, one line each in $OUT/state/targets ("<container> <side>
// <ip>"), which rehearse.sh rewrites on every container change; the file is read again on every tick. Every 1.5 s, in
// turn over the targets: a new session on the load runner's workspace (a claim, a turn, a park), the session lists
// (GET /sessions, /sessions/compact, /sessions/compact?status=AWAITING_INPUT, /sessions/listing and the Completed view,
// each with the Run now gate's read), and
// every few ticks a follow-up to a parked session, an end of one (a release), the runner list, and a task run that is
// batch-stopped (a cancel). The load runner (stack.sh LM_RUNNER=load, max_concurrent 3) claims through the link
// gateway, which forwards to the backends by their names.
//
// Every call is one line of $OUT/load-calls.jsonl: {t, target, side, op, status, ms}; status 0 is a connection error
// (a container being replaced), and such a call is sent again to the next target. A summary per side and op goes to
// stdout every 30 s and at the end.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', 'landing-measured');
const S = process.env.LM_DIR;
const OUT = process.env.OUT;
const CALLS = join(OUT, 'load-calls.jsonl');
const STOP = join(OUT, 'load.stop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(`${new Date().toISOString()} [load] ${line}`);

function targets() {
  return readFileSync(join(OUT, 'state', 'targets'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 3).map(([name, side, ip]) => ({ name, side, base: `http://${ip}:3000/api` }));
}
let turn = 0;
const stats = new Map(); // `${side} ${op}` -> { n, errors: {status: n}, maxMs }
function note(target, op, status, ms, detail) {
  appendFileSync(CALLS, `${JSON.stringify({ t: new Date().toISOString(), target: target.name, side: target.side, op, status, ms: Math.round(ms), ...(detail ? { detail } : {}) })}\n`);
  const k = `${target.side} ${op}`;
  const s = stats.get(k) ?? { n: 0, errors: {}, maxMs: 0 };
  s.n++; s.maxMs = Math.max(s.maxMs, ms);
  if (status === 0 || status >= 400) s.errors[status] = (s.errors[status] ?? 0) + 1;
  stats.set(k, s);
}
/** One call, to the next target in turn; a connection error goes to the one after it (at most once round). */
async function call(op, method, path, token, body) {
  const list = targets();
  for (let i = 0; i < list.length; i++) {
    const target = list[turn++ % list.length];
    const t0 = performance.now();
    try {
      const res = await fetch(`${target.base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      note(target, op, res.status, performance.now() - t0, res.status >= 400 ? text.slice(0, 300) : undefined);
      let json;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
      return { ok: res.ok, status: res.status, answer: json };
    } catch (err) {
      note(target, op, 0, performance.now() - t0, String(err.cause?.code ?? err.message ?? err).slice(0, 120));
    }
  }
  return { ok: false, status: 0 };
}
function summary(final) {
  const out = {};
  for (const [k, s] of [...stats.entries()].sort()) out[k] = { n: s.n, errors: s.errors, maxMs: Math.round(s.maxMs) };
  console.log(JSON.stringify({ t: new Date().toISOString(), [final ? 'final' : 'summary']: out }));
}
// A binary of its own: stack.sh finds a started runner by its binary's path, and the walk restarts its runner (S6).
const stack = (...a) => execFileSync('bash', [join(KIT, 'stack.sh'), ...a], { env: { ...process.env, LM_RUNNER: 'load', LM_RUNNER_BIN: `${S}/bin/orbit-load` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const password = readFileSync(`${S}/stack/secrets/owner_password`, 'utf8').trim();
const login = await call('login', 'POST', '/auth/login', undefined, { email: 'owner@orbit-staging.test', password });
if (!login.ok) throw new Error(`login ${login.status}`);
let T = login.answer.accessToken;
let tokenAt = Date.now();

// The load runner and its workspace, once.
const NAME = 'lm42-runner-load';
let runner = (await call('runners', 'GET', '/runners', T)).answer.find((x) => x.name === NAME);
if (!runner) {
  const enroll = await call('enroll', 'POST', '/runners/enrollment-tokens', T, { label: 't17 load runner' });
  stack('repo', '_root');
  say(stack('register', enroll.answer.token));
}
say(stack('start-runner'));
for (let i = 0; !(runner = (await call('runners', 'GET', '/runners', T)).answer?.find((x) => x.name === NAME && x.online)); i++) {
  if (i > 60) throw new Error('the load runner did not come online');
  await sleep(2000);
}
await call('runner-cap', 'PATCH', `/runners/${runner.id}`, T, { maxConcurrent: 3 });
let ws = (await call('workspaces', 'GET', '/workspaces', T)).answer.find((x) => x.name === 't17-load');
if (!ws) {
  const [work] = stack('repo', 't17-load').split(' ');
  ws = (await call('workspace', 'POST', '/workspaces', T, {
    name: 't17-load', description: 'T17 rehearsal load (fake engine: no model is ever called)',
    runnerId: runner.id, workDir: work, enableWorktree: false, defaultMergeTarget: 'main',
  })).answer;
}
for (let i = 0; !(await call('workspaces', 'GET', '/workspaces', T)).answer?.find((x) => x.id === ws.id && x.repoUrl); i++) {
  if (i > 100) throw new Error('the load workspace has no repo');
  await sleep(3000);
}
say(`runner ${runner.id}, workspace ${ws.id}; targets ${targets().map((t) => `${t.name}=${t.side}`).join(' ')}`);

const mine = []; // public ids of the load's own sessions
let tick = 0;
let lastSummary = Date.now();
while (!existsSync(STOP)) {
  tick++;
  if (Date.now() - tokenAt > 10 * 60_000) {
    const r = await call('login', 'POST', '/auth/login', undefined, { email: 'owner@orbit-staging.test', password });
    if (r.ok) { T = r.answer.accessToken; tokenAt = Date.now(); }
  }
  const s = await call('session-create', 'POST', '/sessions', T, { workspaceId: ws.id, permissionMode: 'auto', engine: 'claude', title: `load ${tick}`, prompt: 'Say hello' });
  if (s.ok && s.answer?.id) mine.push(s.answer.id);
  await call('list /sessions', 'GET', '/sessions?limit=50', T);
  await call('list /sessions/compact', 'GET', '/sessions/compact', T);
  await call('list ?status=AWAITING_INPUT', 'GET', '/sessions/compact?status=AWAITING_INPUT', T);
  await call('list /sessions/listing', 'GET', `/sessions/listing?workspaceId=${ws.id}`, T);
  if (tick % 3 === 0) await call('list view=completed', 'GET', '/sessions?view=completed&limit=50', T);
  if (tick % 2 === 0 && mine.length > 3) {
    const id = mine[Math.floor(Math.random() * (mine.length - 2))];
    await call('session-get', 'GET', `/sessions/${id}`, T);
    await call('follow-up', 'POST', `/sessions/${id}/turns`, T, { clientTurnId: randomUUID(), content: 'Say hello again' });
  }
  if (tick % 5 === 0 && mine.length > 10) await call('session-end', 'POST', `/sessions/${mine.shift()}/end`, T);
  if (tick % 10 === 0) await call('runners', 'GET', '/runners', T);
  if (tick % 20 === 0) {
    const task = await call('task-create', 'POST', '/tasks', T, {
      assigneeId: ws.id, title: `load task ${tick}`, description: 'Say done.',
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
      autoRunWhenReady: false,
    });
    if (task.ok) {
      await call('task-execute', 'POST', `/tasks/${task.answer.id}/execute`, T, { triggerId: randomUUID() });
      await sleep(1500);
      await call('task-batch-stop', 'POST', '/tasks/batch-stop', T, { taskIds: [task.answer.id] });
    }
  }
  if (Date.now() - lastSummary > 30_000) { summary(false); lastSummary = Date.now(); }
  await sleep(1500);
}
summary(true);
say(`load off after ${tick} ticks`);
say(stack('stop-runner'));
