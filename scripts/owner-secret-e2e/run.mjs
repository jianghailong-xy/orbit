// Owner request secrets, end to end against a real runner (docs/design/owner-request-secrets.md §11).
//
//   node scripts/owner-secret-e2e/run.mjs <orbit-binary> <link-gateway-binary>
//   (after `npm run build -w @orbit/shared -w @orbit/apiserver`; the binaries from src/runner-go and src/link-gateway)
//
// THE STACK — every piece a real process:
//   PostgreSQL ..... a disposable postgres:16-alpine, migrated by this branch's `prisma migrate deploy`
//   apiserver ...... `node dist/main.js`, the production AppModule
//   link gateway ... the src/link-gateway binary, plain ws on loopback: this build's runners work only over the link
//   runner A ....... the `orbit` binary built from src/runner-go: `orbit register`, then `orbit run`
//   runner B ....... a second runner of the SAME owner, on its own HOME, which must receive nothing
//   engine ......... scripts/owner-secret-e2e/fake-claude.mjs behind a `claude` shim: it runs the shell commands a turn
//                    names, with the engine's environment, and reports them as a Bash tool_use and tool_result — the
//                    frames that become the transcript and the tool results a model reads.
//
// Every secret is a fresh random canary. The scenarios, in order:
//   E1 ENV, task scope: the agent files a SECRET; the owner submits; the request is DONE only after runner A's ack;
//      `orbit secret exec` gives the declared variable to its command and to nothing else; that command printing the
//      value raw, in base64, on stderr and failing, reaches the tool result scrubbed; the engine's own `env` lacks it;
//      a file the command writes into the checkout is kept out of the commit; an agent write carrying it is refused.
//   E2 FILE: 0600 at the declared path, its parent 0700, on runner A only; runner B's HOME has nothing.
//   E3 removal at task end: the task is cancelled; the ENV grant ends TASK_ENDED, runner A confirms, REMOVED; a
//      later `orbit secret exec` is refused.
//   E4 removal at expiry, with runner A stopped across the trigger: the FILE grant expires while A is down; when A
//      comes back its first reconcile removes the file, and the grant reaches REMOVED.
//   E5 removal at expiry with the control plane unreachable: a FILE grant delivered with a short expiry; the
//      apiserver is stopped; runner A removes the file at its local expiry; the apiserver comes back, the grant
//      reaches REMOVED.
//   E6 absence: the canaries (raw, base64, base64url, hex) are searched for in a dump of the whole database, the
//      apiserver's and both runners' logs, both runners' ORBIT_HOME (spool, ledger, run dirs) and HOME, the session
//      transcripts and tool results through the API, and every git object of the checkout. Only value_enc may hold a
//      value, encrypted, and by now none does.
//
// Prints one line per check and `E2E PASS` at the end; any failure exits non-zero.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Fatal, RunnerMachine, callApi, eventually, freePort, migrate, startApiserver, startPostgres } from '../codex-reset-e2e/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const API = path.join(REPO, 'src/apiserver');
const require = createRequire(path.join(API, 'package.json'));
const pg = require('pg');
const { toUuid } = require('@orbit/shared');
const PRISMA = path.join(REPO, 'node_modules/.bin/prisma');
const BINARY = path.resolve(process.argv[2] ?? '');
const GATEWAY = path.resolve(process.argv[3] ?? '');
if (!existsSync(BINARY) || !existsSync(GATEWAY)) throw new Error('usage: run.mjs <orbit-binary> <link-gateway-binary>');
const KEEP = process.env.OWNER_SECRET_E2E_KEEP;
const SCRATCH = KEEP ?? path.join('/tmp', `owner-secret-e2e-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

const logFile = (name) => {
  const file = path.join(SCRATCH, `${name}.log`);
  writeFileSync(file, '');
  return Object.assign((text) => appendFileSync(file, typeof text === 'string' ? text : text.toString('utf8')), { file });
};
const log = { harness: logFile('harness'), api: logFile('apiserver'), gateway: logFile('gateway'), runnerA: logFile('runner-a'), runnerB: logFile('runner-b') };
const say = (line) => { process.stdout.write(`${line}\n`); log.harness(`${line}\n`); };
const check = async (name, fn) => {
  try {
    await fn();
    say(`  ok   ${name}`);
  } catch (error) {
    say(`  FAIL ${name}\n${error.stack ?? error}`);
    throw error;
  }
};

const teardown = [];
/** What a failure leaves for whoever reads the log: the rows the scenarios turn on, never a value. */
let diagnose = async () => undefined;
const canaries = [];
const canary = () => {
  const value = `sk-e2e-${randomBytes(18).toString('hex')}`;
  canaries.push(value);
  return value;
};
const forms = (value) => {
  const b = Buffer.from(value);
  return [value, b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex')];
};

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' };
  say(`==> scratch ${SCRATCH}`);
  const database = await startPostgres({ pg, name: `owner-secret-e2e-pg-${process.pid}`, log: log.harness });
  teardown.push(() => database.stop());
  migrate({ apiDir: API, prisma: PRISMA, url: database.url, env: baseEnv, log: log.harness });
  const sql = new pg.Client({ connectionString: database.url });
  await sql.connect();
  teardown.push(() => sql.end());
  diagnose = async () => {
    for (const [label, query] of [
      ['grants', `SELECT id, request_id, runner_id, session_id, task_id, name, exposure, state, end_reason, value_enc IS NOT NULL AS has_value, expires_at FROM owner_request_secret`],
      ['requests', `SELECT id, kind, state, asked_by_session_id, secret_spec FROM owner_request`],
      ['sessions', `SELECT id, status::text, assigned_runner_id, task_id, completed_at, archived_at, deleted_at FROM session`],
      ['tasks', `SELECT id, status::text FROM task`],
      ['runners', `SELECT id, name, status::text, last_heartbeat_at, 'owner-secret/v1' = ANY(capabilities) AS secrets FROM runner`],
      ['presence', `SELECT * FROM runner_presence`],
    ]) {
      const rows = await sql.query(query).then((r) => r.rows, (e) => [{ error: e.message }]);
      log.harness(`--- ${label}\n${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
  };

  const apiPort = await freePort();
  const linkPort = await freePort();
  const linkInternalPort = await freePort();
  const linkMetricsPort = await freePort();
  const gatewayToken = randomBytes(24).toString('hex');
  const signing = generateKeyPairSync('ed25519');
  const pem = (key, type) => Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
  const apiEnv = {
    RUNNER_LINK_SIGNING_KEY: pem(signing.privateKey, 'pkcs8'),
    RUNNER_LINK_URL: `ws://127.0.0.1:${linkPort}`,
    RUNNER_LINK_GATEWAY_TOKEN: gatewayToken,
    RUNNER_LINK_INTERNAL_PORT: String(linkInternalPort),
    ...baseEnv,
    DATABASE_URL: database.url,
    JWT_SECRET: randomBytes(32).toString('hex'),
    PROVIDER_SECRET_KEY: randomBytes(32).toString('base64'),
    CORS_ORIGINS: 'http://127.0.0.1',
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/models.json',
    NO_COLOR: '1',
  };
  let api = await startApiserver({ apiDir: API, node: process.execPath, port: apiPort, log: log.api, env: apiEnv });
  teardown.push(() => api.stop());
  const origin = api.origin;

  // The link gateway, between the runners and the apiserver.
  const gateway = spawn(GATEWAY, [], {
    env: {
      PATH: process.env.PATH, LINK_LISTEN_ADDR: `127.0.0.1:${linkPort}`, LINK_METRICS_ADDR: `127.0.0.1:${linkMetricsPort}`,
      LINK_TLS_MODE: 'off', LINK_API_URL: origin, LINK_GATEWAY_TOKEN: gatewayToken,
      LINK_PUBLIC_KEYS: pem(signing.publicKey, 'spki'), LINK_INTERNAL_API_URLS: `http://127.0.0.1:${linkInternalPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout.on('data', log.gateway);
  gateway.stderr.on('data', log.gateway);
  teardown.push(() => gateway.kill('SIGTERM'));
  await eventually('the link gateway to be healthy', async () => {
    if (gateway.exitCode !== null) throw new Error(`the gateway exited ${gateway.exitCode}: ${readFileSync(log.gateway.file, 'utf8').slice(-3000)}`);
    return (await fetch(`http://127.0.0.1:${linkMetricsPort}/healthz`).catch(() => ({ ok: false }))).ok;
  }, 60_000, 250);

  const password = randomBytes(18).toString('base64url');
  const owner = await callApi(origin, 'POST', '/auth/bootstrap', { body: { email: 'e2e-owner@example.invalid', name: 'E2E Owner', password } });
  assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
  const token = owner.json.accessToken;
  const as = (method, route, body) => callApi(origin, method, route, { token, body });

  // The engine: a `claude` shim first on both runners' PATH.
  const bin = path.join(SCRATCH, 'bin');
  mkdirSync(bin, { recursive: true });
  const engineLog = path.join(SCRATCH, 'engine.log');
  writeFileSync(engineLog, '');
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fake-claude.mjs')}" "${engineLog}" "$@"\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  const searchPath = `${bin}:/usr/local/bin:/usr/bin:/bin`;

  const machine = async (name, logTo) => {
    const enrollment = await as('POST', '/runners/enrollment-tokens', { label: name, ttlHours: 6 });
    assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
    const runner = new RunnerMachine({ binary: BINARY, root: path.join(SCRATCH, name), searchPath, log: logTo });
    // The fake engine needs no account, but the runner starts a Claude session only on a machine signed in to it: a
    // refreshable login in the scratch HOME is what it reads (claudeStoredSignedIn). Nothing here is a real token.
    mkdirSync(path.join(runner.home, '.claude'), { recursive: true });
    writeFileSync(path.join(runner.home, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'e2e-not-a-token', refreshToken: 'e2e-not-a-refresh-token', expiresAt: Date.now() + 86_400_000 },
    }), { mode: 0o600 });
    await runner.register({ server: origin, token: enrollment.json.token, name });
    const { rows } = await sql.query('SELECT id::text AS id FROM runner WHERE name = $1', [name]);
    runner.uuid = rows[0].id;
    runner.start();
    teardown.push(() => runner.stop());
    await eventually(`${name} to declare owner-secret/v1`, async () => {
      const { rows: [r] } = await sql.query('SELECT capabilities FROM runner WHERE id = $1', [runner.uuid]);
      return r.capabilities.includes('owner-secret/v1');
    }, 120_000, 500);
    return runner;
  };
  say('==> runners A and B (one owner)');
  const A = await machine('e2e-runner-a', log.runnerA);
  const B = await machine('e2e-runner-b', log.runnerB);

  // A git checkout on runner A, so the end-of-turn commit path runs.
  spawnSync('git', ['init', '-q', '-b', 'main', A.work]);
  spawnSync('git', ['-C', A.work, '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const ws = await as('POST', '/workspaces', { name: 'Owner secret E2E', runnerId: A.uuid, workDir: A.work });
  assert.equal(ws.status, 201, `workspace: ${ws.text}`);
  const workspaceId = ws.json.id;
  // Each session on its own branch in its own worktree, so the end-of-turn commit, the stored patches and the merge run.
  const isolated = await as('PATCH', `/workspaces/${workspaceId}`, { enableWorktree: true });
  assert.equal(isolated.status, 200, `enableWorktree: ${isolated.text}`);

  const task = await as('POST', '/tasks', { title: 'Run the experiment', description: 'owner-secret e2e', assigneeId: workspaceId, completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF', acceptanceCriteria: 'held open until the e2e cancels it' });
  assert.ok([200, 201].includes(task.status), `task: ${task.text}`);
  const taskId = task.json.id;

  /** A session on runner A that has finished its first turn. */
  const session = async (opts = {}) => {
    const created = await as('POST', '/sessions', {
      workspaceId, provider: 'claude', permissionMode: 'auto', prompt: 'RUN: echo ready', ...opts,
    });
    assert.ok([200, 201].includes(created.status), `session: ${created.text}`);
    const id = created.json.id;
    const uuid = toUuid(id);
    await idle(uuid);
    return { id, uuid };
  };
  const idle = (uuid) => eventually('the session to finish its turn', async () => {
    const { rows: [s] } = await sql.query(`SELECT to_jsonb(session) AS row, status::text AS status FROM session WHERE id = $1`, [uuid]);
    if (s && ['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(s.status)) {
      const { rows: events } = await sql.query(`SELECT type, payload::text AS p FROM run_event WHERE session_id = $1 ORDER BY seq DESC LIMIT 8`, [uuid]);
      throw new Fatal(`the session ended ${s.status}: ${JSON.stringify({ endReason: s.row.end_reason, error: s.row.error })}\n${events.map((e) => `${e.type} ${e.p.slice(0, 600)}`).join('\n')}`);
    }
    return s && ['AWAITING_INPUT', 'COMPLETED'].includes(s.status);
  }, 120_000, 500);
  /** One turn that runs `command` in the engine, and its tool result; `mode` SAY also makes its output the reply. */
  const run = async (s, command, mode = 'RUN') => {
    const before = await toolResults(s.uuid);
    const sent = await as('POST', `/sessions/${s.id}/turns`, { content: `${mode}: ${command}`, clientTurnId: randomUUID() });
    assert.ok([200, 201].includes(sent.status), `turn: ${sent.text}`);
    return eventually(`the tool result of: ${command}`, async () => {
      const after = await toolResults(s.uuid);
      return after.length > before.length ? after[after.length - 1] : false;
    }, 120_000, 500);
  };
  /** Every tool result of a session, as the transcript stores it. */
  const toolResults = async (uuid) => {
    const { rows } = await sql.query(`SELECT payload::text AS p FROM run_event WHERE session_id = $1 AND type = 'tool_result' ORDER BY seq`, [uuid]);
    return rows.map((r) => r.p);
  };
  const runnerCall = (machineRef, sessionUuid, method, route, body) => fetch(`${origin}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${machineRef.config.runnerToken}`, 'x-orbit-session-id': sessionUuid },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, text: await res.text() }));
  /** What `request_owner_action` sends, from a session of runner A. */
  const fileSecret = async (s, secretSpec) => {
    const res = await runnerCall(A, s.uuid, 'POST', '/runner/owner-requests', {
      kind: 'SECRET', title: 'Canary key', why: 'the experiment calls the API', secretSpec: { name: 'Canary key', ...secretSpec },
    });
    assert.equal(res.status, 201, `filing: ${res.text}`);
    return JSON.parse(res.text);
  };
  const grantOf = async (requestId) => (await sql.query(
    `SELECT id::text AS id, state, end_reason, value_enc IS NOT NULL AS has_value, expires_at FROM owner_request_secret WHERE request_id = $1`,
    [toUuid(requestId)],
  )).rows[0];
  const requestState = async (requestId) => (await sql.query(`SELECT state FROM owner_request WHERE id = $1`, [toUuid(requestId)])).rows[0].state;
  const ORBIT = BINARY;

  // ── E1 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E1 ENV, task scope');
  const s1 = await session({ taskId });
  const envSecret = canary();
  const r1 = await fileSecret(s1, { envVar: 'CANARY_KEY' });
  await check('the filing names runner A, taken from the session', async () => {
    assert.equal(toUuid(r1.secretSpec.runnerId), A.uuid);
  });
  await check('another runner\'s id in the filing is refused', async () => {
    const res = await runnerCall(A, s1.uuid, 'POST', '/runner/owner-requests', {
      kind: 'SECRET', title: 'x', why: 'y', secretSpec: { name: 'x', envVar: 'X_KEY', runnerId: B.uuid },
    });
    assert.equal(res.status, 400, res.text);
  });
  const submitted = await as('POST', `/owner-requests/${r1.id}/secret`, { value: envSecret });
  await check('the owner submits; the answer carries no value', async () => {
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(submitted.text.includes(envSecret), false);
  });
  await check('the request becomes DONE only once runner A acknowledged delivery', async () => {
    await eventually('the request to be DONE', async () => (await requestState(r1.id)) === 'DONE', 120_000, 500);
    const grant = await grantOf(r1.id);
    assert.equal(grant.state, 'ACTIVE');
  });
  await check('the second runner of the same owner is refused the fetch', async () => {
    const grant = await grantOf(r1.id);
    const res = await fetch(`${origin}/api/runner/secret-grants/${grant.id}/fetch`, {
      method: 'POST', headers: { authorization: `Bearer ${B.config.runnerToken}` },
    });
    assert.equal(res.status, 404);
  });
  await idle(s1.uuid);
  await check('`orbit secret exec` hands the variable to its command, and the tool result is scrubbed', async () => {
    const result = await run(s1, `${ORBIT} secret exec CANARY_KEY -- sh -c 'echo "raw=$CANARY_KEY"; printf %s "$CANARY_KEY" | base64; echo "err=$CANARY_KEY" >&2; test -n "$CANARY_KEY" && echo HAS_VALUE; exit 3'`);
    assert.ok(result.includes('HAS_VALUE'), `the command saw the variable: ${result}`);
    assert.ok(result.includes('[redacted]'), `the value is replaced: ${result}`);
    assert.ok(result.includes('[exit 3]'), `the command's exit code is kept: ${result}`);
    for (const form of forms(envSecret)) assert.equal(result.includes(form), false, `tool result carries ${form}`);
  });
  await idle(s1.uuid);
  await check('the engine\'s own environment does not hold it', async () => {
    const result = await run(s1, 'env');
    assert.equal(result.includes('CANARY_KEY'), false, result);
    for (const form of forms(envSecret)) assert.equal(result.includes(form), false);
  });
  await idle(s1.uuid);
  await check('a file the command writes into the checkout stays out of the commit', async () => {
    await run(s1, `${ORBIT} secret exec CANARY_KEY -- sh -c 'printf "%s\\n" "$CANARY_KEY" > leaked.txt'; echo wrote`);
    await idle(s1.uuid);
    const { rows: diffs } = await sql.query(`SELECT to_jsonb(d)::text AS d FROM session_diff d WHERE session_id = $1`, [s1.uuid]);
    for (const form of forms(envSecret)) assert.equal(diffs.some((d) => d.d.includes(form)), false, `a stored diff carries ${form}`);
    const branch = spawnSync('git', ['-C', A.work, 'log', '-p', '--all'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    for (const form of forms(envSecret)) assert.equal(branch.stdout.includes(form), false, `a commit carries ${form}`);
    // The agent cleans up after itself, so the sweep in E6 looks at what Orbit left, not at what the agent wrote.
    await run(s1, 'rm -f leaked.txt && echo cleaned');
    await idle(s1.uuid);
  });
  await check('an agent write carrying the value is refused SECRET_IN_TEXT', async () => {
    const res = await runnerCall(A, s1.uuid, 'POST', `/runner/tasks/${taskId}/comments`, { body: `the key is ${envSecret}` });
    assert.equal(res.status, 422, res.text);
    assert.match(res.text, /SECRET_IN_TEXT/);
    assert.equal(res.text.includes(envSecret), false);
  });

  // ── E2 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E2 FILE on runner A only');
  const s2 = await session();
  const fileSecretValue = canary();
  const r2 = await fileSecret(s2, { filePath: '~/.config/e2e-secret/key' });
  assert.equal((await as('POST', `/owner-requests/${r2.id}/secret`, { value: fileSecretValue })).status, 200);
  const fileA = path.join(A.home, '.config/e2e-secret/key');
  await check('the file is 0600 under a 0700 parent on runner A, holding the value', async () => {
    await eventually('the request to be DONE', async () => (await requestState(r2.id)) === 'DONE', 120_000, 500);
    const st = lstatSync(fileA);
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(fileA)).mode & 0o777, 0o700);
    assert.equal(readFileSync(fileA, 'utf8'), fileSecretValue);
  });
  await check('runner B has no such file', async () => {
    assert.equal(existsSync(path.join(B.home, '.config/e2e-secret/key')), false);
  });
  await idle(s2.uuid);
  await check('an agent that reads the FILE and quotes it: neither its tool result nor its final reply is stored with the value', async () => {
    const result = await run(s2, `cat ${fileA}`, 'SAY');
    for (const form of forms(fileSecretValue)) assert.equal(result.includes(form), false, `tool result carries ${form}`);
    await idle(s2.uuid);
    const { rows: [row] } = await sql.query(`SELECT to_jsonb(session)::text AS s FROM session WHERE id = $1`, [s2.uuid]);
    const { rows: turns } = await sql.query(`SELECT to_jsonb(conversation_turn)::text AS t FROM conversation_turn WHERE session_id = $1`, [s2.uuid]);
    for (const form of forms(fileSecretValue)) {
      assert.equal(row.s.includes(form), false, `the session row carries ${form}`);
      assert.equal(turns.some((t) => t.t.includes(form)), false, `a turn carries ${form}`);
    }
  });

  await idle(s2.uuid);
  await check('a value the agent commits itself reaches no stored patch, and the branch is not merged', async () => {
    const result = await run(s2, `cp ${fileA} committed-key.txt && git add committed-key.txt && git -c user.email=e2e@example.invalid -c user.name=e2e commit -qm 'add key' && echo committed`);
    assert.ok(result.includes('committed'), result);
    await idle(s2.uuid);
    const merged = await as('POST', `/sessions/${s2.id}/merge`, { waitSeconds: 90 });
    log.harness(`merge answered ${merged.status}: ${merged.text.slice(0, 2000)}\n`);
    assert.equal(merged.text.includes(fileSecretValue), false, 'the merge answer carries no value');
    const mainLog = spawnSync('git', ['-C', A.work, 'log', '-p', 'main'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    assert.equal(mainLog.status, 0, mainLog.stderr);
    for (const form of forms(fileSecretValue)) assert.equal(mainLog.stdout.includes(form), false, `main's history carries ${form}`);
    assert.equal(mainLog.stdout.includes('committed-key.txt'), false, 'the branch holding the value was not merged into main');
    const { rows: diffs } = await sql.query(`SELECT to_jsonb(d)::text AS d FROM session_diff d WHERE session_id = $1`, [s2.uuid]);
    for (const form of forms(fileSecretValue)) assert.equal(diffs.some((d) => d.d.includes(form)), false, `a stored diff carries ${form}`);
    // Deleting the file in a later commit does not clean the branch: its history still holds the value.
    await idle(s2.uuid);
    const removed = await run(s2, `git rm -q committed-key.txt && git -c user.email=e2e@example.invalid -c user.name=e2e commit -qm 'remove key' && echo removed`);
    assert.ok(removed.includes('removed'), removed);
    await idle(s2.uuid);
    await as('POST', `/sessions/${s2.id}/merge`, { waitSeconds: 90 });
    const after = spawnSync('git', ['-C', A.work, 'log', '-p', 'main'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    assert.equal(after.stdout.includes('committed-key.txt'), false, 'a branch whose history holds the value is still not merged');
  });

  // ── E3 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E3 removal at task end');
  await check('cancelling the task ends the ENV grant, and runner A confirms its removal', async () => {
    const cancelled = await as('PATCH', `/tasks/${taskId}`, { status: 'CANCELLED' });
    assert.ok([200, 201].includes(cancelled.status), cancelled.text);
    await eventually('the grant to be REMOVED', async () => (await grantOf(r1.id)).state === 'REMOVED', 180_000, 1000);
    const grant = await grantOf(r1.id);
    assert.equal(grant.end_reason, 'TASK_ENDED');
    assert.equal(grant.has_value, false);
  });
  await check('`orbit secret exec` is refused once the grant ended', async () => {
    const result = await run(s1, `${ORBIT} secret exec CANARY_KEY -- sh -c 'echo "got=$CANARY_KEY"'`);
    assert.equal(result.includes(envSecret), false);
    assert.equal(/got=sk-/.test(result), false, result);
  });

  // ── E4 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E4 expiry, runner A stopped across the trigger');
  await check('the FILE grant expires while A is down; A removes the file when it returns', async () => {
    await A.stop();
    await sql.query(`UPDATE owner_request_secret SET expires_at = now() - interval '1 second' WHERE request_id = $1`, [toUuid(r2.id)]);
    await eventually('the sweep to end it', async () => (await grantOf(r2.id)).state === 'REMOVING', 90_000, 1000);
    assert.equal((await grantOf(r2.id)).end_reason, 'EXPIRED');
    A.start();
    await eventually('the file to be gone', async () => !existsSync(fileA), 120_000, 500);
    assert.equal(existsSync(path.dirname(fileA)), false, 'the parent it created is removed too');
    await eventually('the grant to be REMOVED', async () => (await grantOf(r2.id)).state === 'REMOVED', 120_000, 1000);
  });

  // ── E5 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E5 expiry with the control plane unreachable');
  const s5 = await session();
  const offlineValue = canary();
  const r5 = await fileSecret(s5, { filePath: '~/.config/e2e-offline/key' });
  const file5 = path.join(A.home, '.config/e2e-offline/key');
  await check('a FILE grant with a short expiry is removed by runner A alone at that expiry', async () => {
    await A.stop();
    assert.equal((await as('POST', `/owner-requests/${r5.id}/secret`, { value: offlineValue })).status, 200);
    await sql.query(`UPDATE owner_request_secret SET expires_at = now() + interval '50 seconds' WHERE request_id = $1`, [toUuid(r5.id)]);
    A.start();
    await eventually('delivery', async () => existsSync(file5), 120_000, 500);
    await api.stop();
    const { rows: [{ expires_at: expiresAt }] } = await sql.query(`SELECT expires_at FROM owner_request_secret WHERE request_id = $1`, [toUuid(r5.id)]);
    await eventually('the file to be gone with no control plane', async () => !existsSync(file5), Math.max(0, expiresAt - Date.now()) + 120_000, 1000);
    api = await startApiserver({ apiDir: API, node: process.execPath, port: apiPort, log: log.api, env: apiEnv });
    await eventually('the grant to be REMOVED', async () => (await grantOf(r5.id)).state === 'REMOVED', 180_000, 1000);
    assert.equal((await grantOf(r5.id)).end_reason, 'EXPIRED');
  });

  // ── E6 ────────────────────────────────────────────────────────────────────────────────────────
  say('==> E6 the canaries are nowhere');
  await A.stop();
  await B.stop();
  const needles = canaries.flatMap(forms);
  const found = (text) => needles.filter((n) => text.includes(n));
  await check('no database text holds a value (value_enc is NULL everywhere by now)', async () => {
    const dump = spawnSync('docker', ['exec', database.name, 'pg_dump', '-U', 'codex_reset_e2e', '--data-only', 'codex_reset_e2e'], { encoding: 'utf8', maxBuffer: 1 << 30 });
    assert.equal(dump.status, 0, dump.stderr);
    assert.ok(dump.stdout.length > 1000);
    assert.deepEqual(found(dump.stdout), []);
    const { rows } = await sql.query(`SELECT count(*)::int AS n FROM owner_request_secret WHERE value_enc IS NOT NULL`);
    assert.equal(rows[0].n, 0);
  });
  await check('no log holds a value: apiserver, link gateway, runner A, runner B, engine', async () => {
    for (const file of [log.api.file, log.gateway.file, log.runnerA.file, log.runnerB.file, engineLog]) {
      assert.deepEqual(found(readFileSync(file, 'utf8')), [], file);
    }
  });
  await check('no file under either runner\'s ORBIT_HOME or HOME holds a value (spool, ledger, run dirs, uploads)', async () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && statSync(full).size < 64 << 20) {
          const text = readFileSync(full).toString('latin1');
          if (found(text).length > 0) hits.push(full);
        } else if (entry.isSocket?.()) continue;
      }
    };
    for (const root of [A.orbitHome, A.home, B.orbitHome, B.home]) if (existsSync(root)) walk(root);
    assert.deepEqual(hits, []);
  });
  await check('no transcript or tool result holds a value, through the API', async () => {
    for (const s of [s1, s2, s5]) {
      const res = await as('GET', `/sessions/${s.id}/turns`);
      assert.deepEqual(found(res.text), [], `turns of ${s.id}`);
    }
    const { rows } = await sql.query(`SELECT payload::text AS p FROM run_event`);
    assert.deepEqual(found(rows.map((r) => r.p).join('\n')), []);
  });
  // The one value E2 has the agent commit on purpose stays in runner A's own object store, as the FILE itself sat on its
  // disk: what must hold is that nothing that leaves the machine has it (the stored diffs above, main's history).
  await check('no git object any ref reaches holds a value, but the one the agent committed on its own branch', async () => {
    const needles = canaries.filter((c) => c !== fileSecretValue).flatMap(forms);
    const found = (text) => needles.filter((n) => text.includes(n));
    const roots = [A.work, ...readdirSync(A.orbitHome, { recursive: true }).filter((p) => p.endsWith('.git')).map((p) => path.dirname(path.join(A.orbitHome, p)))];
    for (const root of roots) {
      // Every object a ref reaches: what a push, a merge or a patch could carry off the machine. A blob the end-of-turn
      // `git add` wrote and the scrubber then unstaged is reachable from nothing and stays in the local store until gc.
      const objects = spawnSync('sh', ['-c', `git -C "${root}" rev-list --objects --all | cut -d' ' -f1 | git -C "${root}" cat-file --batch 2>/dev/null`], { encoding: 'latin1', maxBuffer: 1 << 30 });
      assert.deepEqual(found(objects.stdout ?? ''), [], root);
    }
  });
  say('E2E PASS');
}

main()
  .then(async () => {
    for (const step of teardown.reverse()) await Promise.resolve(step()).catch(() => undefined);
    process.exit(0);
  })
  .catch(async (error) => {
    say(`E2E FAIL: ${error.stack ?? error}`);
    await diagnose().catch((e) => say(`diagnosis failed: ${e.message}`));
    say(`logs kept in ${SCRATCH}`);
    for (const step of teardown.reverse()) await Promise.resolve(step()).catch(() => undefined);
    process.exit(1);
  });
