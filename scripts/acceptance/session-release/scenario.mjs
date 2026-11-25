// The session-release protocol walk (run.sh beside this file; docs/session-three-state-plan.md step 6.2). One server,
// two real runners: `old` (the old protocol) and `new` (this checkout). Every case is driven through the owner's HTTP
// API and read back from the database read-only; nothing is written to the database by this script.
//
//   pass ON  (ORBIT_SESSION_RELEASE_V1=on)   old and new: failed turn, ended session, resume of both, a retryable
//            failure whose armed retry fires, a swallowed delivery of a task's run; new only: a retryable failure
//            whose release never arrives (the runner is killed between its turn report and its release)
//   pass OFF (the switch off)                new again, every case of pass ON but the kill
//
// The rows compared case by case: the session's status, whether it is released (`finished_at` set), `end_reason`,
// `last_turn_outcome` and error, and each turn's kind, status, outcome and error. Equal is the verdict.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT, S, attempt, call, evidence, login, logSince, logSize, publicIdToUuid, readState, saveState, sleep, until, uuid,
} from '../landing-measured/lib.mjs';
import { sessionWordSql } from '../../lib/session-word.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const KIT = join(REPO, 'scripts', 'acceptance', 'landing-measured');
const { say, file, query } = evidence('session-release');
const SCRATCH = `${S}/ops-out`;
mkdirSync(SCRATCH, { recursive: true });
const FAKE_LOG = `${S}/logs/fake-claude.jsonl`;
const failures = [];
const check = (name, ok, detail) => {
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const flag = (name, on) => (on ? writeFileSync(join(SCRATCH, name), '') : rmSync(join(SCRATCH, name), { force: true }));
for (const name of ['hold-commit-message']) flag(name, false);

// ── the stack ────────────────────────────────────────────────────────────────────────────────────────────────────────
const runnerBin = (r) => (r === 'old' ? `${S}/bin/orbit-old` : `${S}/bin/orbit`);
const runnerLog = (r) => `${S}/logs/runner-${r}.log`;
function runnerStack(r, ...args) {
  return execFileSync('bash', [join(KIT, 'stack.sh'), ...args], {
    env: { ...process.env, LM_RUNNER: r, LM_RUNNER_BIN: runnerBin(r) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
}
/** One read-only value (psql -tA), for the waits; what the evidence shows goes through query(). */
function value(sql) {
  return execFileSync('docker', ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', `${PROJECT}-postgres`,
    'psql', '-U', 'orbit', '-d', 'orbit', '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

/** The apiserver's switch, set in the stack's env file and applied by recreating the apiserver. */
function setSwitch(on) {
  const envFile = `${S}/stack/compose.env`;
  const lines = readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('ORBIT_SESSION_RELEASE_V1='));
  if (on) lines.push('ORBIT_SESSION_RELEASE_V1=on');
  writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  execFileSync('bash', ['-c', 'source "$1/scripts/runner-link/staging-lib.sh" && compose --profile runner-link up -d --no-deps --wait apiserver', '_', REPO], {
    env: { ...process.env, ORBIT_LINK_STAGING_PROJECT: PROJECT, ORBIT_LINK_STAGING_DIR: `${S}/stack` }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  const seen = execFileSync('docker', ['exec', `${PROJECT}-apiserver`, 'sh', '-c', 'printf %s "${ORBIT_SESSION_RELEASE_V1:-}"'], { encoding: 'utf8' });
  say(`apiserver recreated with ORBIT_SESSION_RELEASE_V1=${JSON.stringify(seen)}`);
  check(`the switch is ${on ? 'on' : 'off'} in the apiserver`, (seen === 'on') === on);
}

const state = readState();
state.relwalk ??= {};
const T = await login();

async function ensureRunner(r) {
  const name = `lm42-runner-${r}`;
  const online = async () => (await call('GET', '/runners', T)).find((x) => x.name === name && x.online);
  if (!state.relwalk[r]) {
    const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: name });
    runnerStack(r, 'repo', `_root-${r}`);
    say(runnerStack(r, 'register', enroll.token).trim());
  }
  say(runnerStack(r, 'start-runner').trim());
  const runner = await until(`runner ${name} online`, online, { timeoutMs: 120_000 });
  if (!state.relwalk[r]) {
    const [work] = runnerStack(r, 'repo', `relwalk-${r}`).trim().split(' ');
    const ws = await call('POST', '/workspaces', T, {
      name: `relwalk-${r}`, description: `session-release walk, ${r} runner (fake engine: no model is ever called)`,
      runnerId: runner.id, workDir: work, enableWorktree: true, defaultMergeTarget: 'main',
    });
    await until(`the ${r} runner to report its workspace's origin`, async () =>
      (await call('GET', '/workspaces', T)).find((x) => x.id === ws.id && x.repoUrl), { timeoutMs: 300_000, everyMs: 3_000 });
    state.relwalk[r] = { runnerId: runner.id, workspaceId: ws.id, workDir: work };
    saveState(state);
  }
  say(`runner ${name}: ${runner.id} version ${runner.version}; workspace ${state.relwalk[r].workspaceId}`);
  return state.relwalk[r];
}

async function waitLog(r, needle, from, what, timeoutMs = 120_000) {
  return until(what, () => logSince(runnerLog(r), from).includes(needle), { timeoutMs, everyMs: 1_000 });
}

// ── the rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sid = (id) => publicIdToUuid(id);
const SESSION_ROW = (id) => `select ${sessionWordSql('session')} as status, finished_at is not null as released, end_reason, last_turn_outcome, error,
  retry_at is not null as retry_armed, retry_attempts, cancel_requested_at is not null as cancel_requested
  from session where id = '${sid(id)}'`;
const TURN_ROWS = (id) => `select seq, kind, status, outcome, error from conversation_turn
  where session_id = '${sid(id)}' and kind in ('message', 'shell') order by seq`;
/** What is compared between the runners: the session's facts and its work turns, as JSON. */
function facts(id) {
  const session = JSON.parse(value(`select json_build_object('status', ${sessionWordSql('session')}, 'released', finished_at is not null,
    'end_reason', end_reason, 'last_turn_outcome', last_turn_outcome, 'error', error) from session where id = '${sid(id)}'`));
  const turns = JSON.parse(value(`select coalesce(json_agg(json_build_object('kind', kind, 'status', status,
    'outcome', outcome, 'error', error) order by seq), '[]') from conversation_turn
    where session_id = '${sid(id)}' and kind in ('message', 'shell')`));
  return { session, turns };
}
function record(label, id) {
  query(`${label}: session`, SESSION_ROW(id));
  query(`${label}: turns`, TURN_ROWS(id));
  return facts(id);
}
const released = (id, what) => until(what, () => value(`select finished_at is not null from session where id = '${sid(id)}'`) === 't',
  { timeoutMs: 240_000, everyMs: 1_000 });
const idle = (id, what) => until(what, () => value(`select finished_at is null and turn_state is null
  and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null)
  from session s where id = '${sid(id)}'`) === 't', { timeoutMs: 240_000, everyMs: 1_000 });
const held = (id, what) => until(what, () => value(`select turn_state = 'IN_FLIGHT' and finished_at is null and cancel_requested_at is not null
  and end_reason is null and last_turn_outcome = 'FAILED' from session where id = '${sid(id)}'`) === 't', { timeoutMs: 240_000, everyMs: 250 });
const runnerLines = (r, id, from) => logSince(runnerLog(r), from).split('\n').filter((l) => l.includes(sid(id)) || l.includes(id)).join('\n');

async function newSession(ws, title, prompt) {
  return call('POST', '/sessions', T, { workspaceId: ws.workspaceId, permissionMode: 'auto', engine: 'claude', title, prompt });
}
// A message to a released session goes through the owner's resume (POST /sessions/:id/resume), as the app sends it.
const send = (id, content) => attempt('POST', `/sessions/${id}/resume`, T, { clientTurnId: uuid(), content });

const RETRYABLE = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

// ── one runner's walk ────────────────────────────────────────────────────────────────────────────────────────────────
async function walk(label, r, ws, { kill }) {
  const out = {};
  const from = logSize(runnerLog(r));
  say(`== ${label}: the ${r} runner`);

  // 1. A failed turn.
  const failed = await newSession(ws, `${label} failed turn`, 'E2E-FAIL: the build tool crashed (exit 2)');
  await released(failed.id, `${label}: the failed turn's session released`);
  out.failedTurn = record(`${label} 1 failed turn`, failed.id);
  const branch = value(`select branch from session where id = '${sid(failed.id)}'`);
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: `${S}/runner-userhome-${r}`, GIT_CONFIG_NOSYSTEM: '1' };
  const ahead = Number(execFileSync('git', ['-C', ws.workDir, 'rev-list', '--count', `main..refs/heads/${branch}`], { encoding: 'utf8', env: gitEnv }).trim());
  const tip = execFileSync('git', ['-C', ws.workDir, 'log', '-1', '--format=%h %s%n%b', `refs/heads/${branch}`], { encoding: 'utf8', env: gitEnv }).trim();
  say(`${label}: the failed run's branch ${branch} is ${ahead} commit(s) past main, ending on: ${tip.replace(/\n+/g, ' | ')}`);
  out.failedTurnCommit = ahead === 0 ? 'none' : /Orbit-Park-Checkpoint/.test(tip) ? 'checkpoint' : 'commit';

  // 2. An ended session: a turn answered, then the owner's End.
  const ended = await newSession(ws, `${label} ended session`, 'Say hello');
  await idle(ended.id, `${label}: the ended session's first turn answered`);
  await call('POST', `/sessions/${ended.id}/end`, T);
  await released(ended.id, `${label}: the ended session released`);
  out.ended = record(`${label} 2 ended session`, ended.id);

  // 3. A resume of each: a message to the failed session and to the ended one.
  const r1 = await send(failed.id, 'Carry on after the failure');
  say(`${label}: resume of the failed session: ${JSON.stringify(r1.ok ? { ok: true } : r1)}`);
  if (r1.ok) await idle(failed.id, `${label}: the resumed failed session answered`);
  out.resumeFailed = { accepted: r1.ok, ...record(`${label} 3a resume after the failed turn`, failed.id) };
  const r2 = await send(ended.id, 'Back again after the end');
  say(`${label}: resume of the ended session: ${JSON.stringify(r2.ok ? { ok: true } : r2)}`);
  if (r2.ok) await idle(ended.id, `${label}: the resumed ended session answered`);
  out.resumeEnded = { accepted: r2.ok, ...record(`${label} 3b resume after the end`, ended.id) };

  // 4. A retryable failure, whose armed retry fires. With kill: its release never arrives, because the runner is
  //    killed between its turn report and its release (the fake engine holds the release's commit message).
  const failFlag = `fail-${label}`;
  flag(failFlag, true);
  if (kill) flag('hold-commit-message', true);
  const fakeFrom = logSize(FAKE_LOG);
  const retry = await newSession(ws, `${label} retryable failure`, `E2E-FAIL-WHILE ${failFlag}: ${RETRYABLE}`);
  if (kill) {
    await held(retry.id, `${label}: the retryable failure held for its release`);
    await until('the release\'s commit message to be held', () => logSince(FAKE_LOG, fakeFrom).includes('"commit-message-hold"'), { timeoutMs: 60_000, everyMs: 250 });
    say(runnerStack(r, 'kill-runner').trim());
    const heldAt = record(`${label} 4 held, its runner killed before the release`, retry.id);
    out.held = heldAt;
    flag('hold-commit-message', false);
    say(`${label}: waiting for the reaper's cancel-grace backstop (two minutes from the hold)`);
    await until(`${label}: the backstop to release the held session`, () =>
      value(`select finished_at is not null from session where id = '${sid(retry.id)}'`) === 't', { timeoutMs: 420_000, everyMs: 3_000 });
  } else {
    await released(retry.id, `${label}: the retryable failure released`);
  }
  out.retryReleased = record(`${label} 4 retryable failure, released${kill ? ' by the backstop' : ''}`, retry.id);
  out.retryArmedAtRelease = value(`select retry_at is not null from session where id = '${sid(retry.id)}'`) === 't';
  flag(failFlag, false);
  if (kill) {
    say(runnerStack(r, 'start-runner').trim());
    await until(`runner lm42-runner-${r} online again`, async () =>
      (await call('GET', '/runners', T)).find((x) => x.name === `lm42-runner-${r}` && x.online), { timeoutMs: 120_000 });
  }
  // The retry re-sends the message as a turn of its own; once it is answered, the attempts count is reset.
  await until(`${label}: the armed retry to fire and its turn to be answered`, () => value(`select finished_at is null
    and turn_state is null and retry_at is null
    and (select count(*) from conversation_turn t where t.session_id = s.id and t.kind = 'message') >= 2
    and not exists (select 1 from conversation_turn t where t.session_id = s.id and t.answered_at is null)
    from session s where id = '${sid(retry.id)}'`) === 't', { timeoutMs: 420_000, everyMs: 2_000 });
  out.retryFired = record(`${label} 4 after the armed retry fired`, retry.id);

  // 5. A swallowed delivery of a task's run: the message read three times and never answered.
  const swallowFlag = `swallow-${label}`;
  flag(swallowFlag, true);
  const task = await call('POST', '/tasks', T, {
    assigneeId: ws.workspaceId, title: `${label} swallowed delivery`, description: `E2E-SWALLOW-WHILE ${swallowFlag}`,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60,
    autoRunWhenReady: false,
  });
  await call('POST', `/tasks/${task.id}/execute`, T, { triggerId: uuid() });
  const taskUuid = publicIdToUuid(task.id);
  const runId = await until(`${label}: the task's run`, () => value(`select id from session where task_id = '${taskUuid}' order by created_at limit 1`) || null,
    { timeoutMs: 120_000 });
  await until(`${label}: the swallowed run released`, () => value(`select finished_at is not null from session where id = '${runId}'`) === 't',
    { timeoutMs: 300_000, everyMs: 2_000 });
  flag(swallowFlag, false);
  query(`${label} 5 swallowed delivery: session`, `select ${sessionWordSql('session')} as status, finished_at is not null as released, end_reason, last_turn_outcome, error,
    retry_at is not null as retry_armed from session where id = '${runId}'`);
  query(`${label} 5 swallowed delivery: turns`, `select seq, kind, status, outcome, error from conversation_turn where session_id = '${runId}' order by seq`);
  query(`${label} 5 swallowed delivery: the task and its comments`, `select t.status, (select count(*) from task_comment c where c.task_id = t.id) as comments,
    (select string_agg(c.body, ' || ' order by c.created_at) from task_comment c where c.task_id = t.id) as bodies from task t where t.id = '${taskUuid}'`);
  out.swallowed = {
    session: JSON.parse(value(`select json_build_object('status', ${sessionWordSql('session')}, 'released', finished_at is not null, 'end_reason', end_reason,
      'last_turn_outcome', last_turn_outcome, 'error', error, 'retry_armed', retry_at is not null) from session where id = '${runId}'`)),
    turns: JSON.parse(value(`select coalesce(json_agg(json_build_object('kind', kind, 'status', status, 'outcome', outcome, 'error', error) order by seq), '[]')
      from conversation_turn where session_id = '${runId}' and kind in ('message', 'shell')`)),
    task: JSON.parse(value(`select json_build_object('status', t.status, 'comments', coalesce((select json_agg(c.body order by c.created_at) from task_comment c
      where c.task_id = t.id), '[]')) from task t where t.id = '${taskUuid}'`)),
  };

  file(`${label}-runner-log.txt`, logSince(runnerLog(r), from));
  for (const [what, id] of [['failed turn', failed.id], ['ended session', ended.id], ['retryable failure', retry.id]]) {
    say(`${label} runner log, ${what} (${sid(id)}):\n${runnerLines(r, id, from)}`);
  }
  say(`${label} runner log, swallowed run (${runId}):\n${logSince(runnerLog(r), from).split('\n').filter((l) => l.includes(runId)).join('\n')}`);
  file(`${label}.json`, out);
  return out;
}

function compare(a, b, nameA, nameB, cases) {
  for (const c of cases) {
    const ja = JSON.stringify(a[c]), jb = JSON.stringify(b[c]);
    check(`${c}: ${nameA} and ${nameB} store the same rows`, ja === jb, ja === jb ? ja : `${nameA} ${ja}\n    ${nameB} ${jb}`);
  }
}

// ── pass ON ──────────────────────────────────────────────────────────────────────────────────────────────────────────
say(`old runner ${process.env.SR_OLD_SHA}, new runner and server ${process.env.SR_NEW_SHA}`);
setSwitch(true);
const newFrom = logSize(runnerLog('new'));
const wsOld = await ensureRunner('old');
const wsNew = await ensureRunner('new');
await waitLog('new', 'the control plane offers session-release/v1', newFrom, 'the new runner to read the offer');
check('the new runner reads the offer from its heartbeat answer', true);
check('the old runner says nothing of the protocol', !readFileSync(runnerLog('old'), 'utf8').includes('session-release/v1'));

const old = await walk('old', 'old', wsOld, { kill: false });
const neu = await walk('new-on', 'new', wsNew, { kill: true });

// ── pass OFF ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const offFrom = logSize(runnerLog('new'));
setSwitch(false);
await waitLog('new', 'the control plane no longer offers session-release/v1', offFrom, 'the new runner to read that the offer is gone');
check('the new runner turns the declaration off on the first answer without the word', true);
const off = await walk('new-off', 'new', wsNew, { kill: false });

// ── verdicts ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const CASES = ['failedTurn', 'ended', 'resumeFailed', 'resumeEnded', 'retryReleased', 'retryFired', 'swallowed'];
compare(old, neu, 'old', 'new (switch on)', CASES);
compare(old, off, 'old', 'new (switch off)', CASES);
check('the held row before the backstop: RUNNING, not released, no end reason, last turn FAILED, the turn FAILED',
  neu.held?.session.status === 'RUNNING' && neu.held.session.released === false && neu.held.session.end_reason === null
  && neu.held.session.last_turn_outcome === 'FAILED' && neu.held.turns[0]?.outcome === 'FAILED', JSON.stringify(neu.held));
check('the backstop released it as the failure, the retry still armed', neu.retryReleased.session.status === 'FAILED'
  && neu.retryReleased.session.last_turn_outcome === 'FAILED' && neu.retryArmedAtRelease, JSON.stringify(neu.retryReleased.session));
check('the old runner\'s failed run commits nothing; the new runner\'s on the new protocol commits permanently; off, nothing',
  old.failedTurnCommit === 'none' && neu.failedTurnCommit === 'commit' && off.failedTurnCommit === 'none',
  `old ${old.failedTurnCommit}, new-on ${neu.failedTurnCommit}, new-off ${off.failedTurnCommit}`);
const onLog = readFileSync(`${join(S, 'records', process.env.LM_RUN || 'adhoc', 'session-release')}/new-on-runner-log.txt`, 'utf8');
const offLog = readFileSync(`${join(S, 'records', process.env.LM_RUN || 'adhoc', 'session-release')}/new-off-runner-log.txt`, 'utf8');
const oldLog = readFileSync(`${join(S, 'records', process.env.LM_RUN || 'adhoc', 'session-release')}/old-runner-log.txt`, 'utf8');
check('switch on: the new runner reports the failed turn as its outcome and releases it separately',
  onLog.includes('reported as its outcome; the session is held for its release') && onLog.includes('→ FAILED (released)'));
check('switch off: the new runner reports as the old one does (no hold, no release report)',
  !offLog.includes('held for its release') && !offLog.includes('(released)') && offLog.includes('failed turn terminal acknowledgement settled'));
check('the old runner: the failed turn settles the session, as always',
  oldLog.includes('failed turn terminal acknowledgement settled') && !oldLog.includes('(released)'));

file('checks.json', { failures, old, newOn: neu, newOff: off });
say(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL CHECKS PASSED');
process.stdout.write(`\n######## recorded queries\n${readFileSync(join(S, 'records', process.env.LM_RUN || 'adhoc', 'session-release', 'queries.txt'), 'utf8')}\n`);
await sleep(0);
process.exit(failures.length ? 1 : 0);
