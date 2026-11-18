// The codeless-run drill on a real runner (docs/task-fork-from-session-design.md §3 B2, §5 P3).
//
//   node scripts/task-codeless-drill/run.mjs <orbit-binary> <link-gateway-binary>
//   (after `bash scripts/worktree-overlay.sh` and `npm run build -w @orbit/apiserver`; the binaries from
//   src/runner-go and src/link-gateway)
//
// THE STACK — every piece a real process, as in scripts/owner-secret-e2e/run.mjs:
//   PostgreSQL, migrated by this branch · the apiserver (`node dist/main.js`) · the link gateway · one runner, the
//   `orbit` binary of this branch, `orbit register` then `orbit run` · scripts/owner-secret-e2e/fake-claude.mjs as
//   `claude`, which runs the shell command a turn names (`RUN: <command>`).
//
// THE DRILL — on a workspace with worktrees on, two codeless tasks, each closed by the owner's Confirm done:
//   1. one whose run changes nothing: its run is created with no branch, runs in a detached checkout under
//      worktrees/<session>, and afterwards `git branch --list` has no branch for it and the checkout is gone;
//   2. one whose run writes a file: afterwards the run reports the branch the runner made at finalize, the branch
//      exists in `git branch --list`, and the file is in the session's changedFiles and on the branch.
//
// Writes transcript.txt (what the evidence quotes) into the scratch directory, and exits non-zero on any failure.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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
const SCRATCH = process.env.TASK_CODELESS_DRILL_DIR ?? path.join('/tmp', `task-codeless-drill-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });

const logFile = (name) => {
  const file = path.join(SCRATCH, `${name}.log`);
  writeFileSync(file, '');
  return Object.assign((text) => appendFileSync(file, typeof text === 'string' ? text : text.toString('utf8')), { file });
};
const log = { harness: logFile('harness'), api: logFile('apiserver'), gateway: logFile('gateway'), runner: logFile('runner') };
const transcriptFile = path.join(SCRATCH, 'transcript.txt');
writeFileSync(transcriptFile, '');
const say = (line) => {
  process.stdout.write(`${line}\n`);
  log.harness(`${line}\n`);
  appendFileSync(transcriptFile, `${line}\n`);
};
const teardown = [];

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' };
  say(`==> scratch ${SCRATCH}`);
  say(`==> runner binary ${BINARY} (${spawnSync(BINARY, ['--version'], { encoding: 'utf8' }).stdout.trim()})`);
  const database = await startPostgres({ pg, name: `task-codeless-drill-pg-${process.pid}`, log: log.harness });
  teardown.push(() => database.stop());
  migrate({ apiDir: API, prisma: PRISMA, url: database.url, env: baseEnv, log: log.harness });
  const sql = new pg.Client({ connectionString: database.url });
  await sql.connect();
  teardown.push(() => sql.end());

  const apiPort = await freePort();
  const linkPort = await freePort();
  const linkInternalPort = await freePort();
  const linkMetricsPort = await freePort();
  const gatewayToken = randomBytes(24).toString('hex');
  const signing = generateKeyPairSync('ed25519');
  const pem = (key, type) => Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
  const api = await startApiserver({
    apiDir: API, node: process.execPath, port: apiPort, log: log.api,
    env: {
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
    },
  });
  teardown.push(() => api.stop());
  const origin = api.origin;
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
    if (gateway.exitCode !== null) throw new Error(`the gateway exited ${gateway.exitCode}`);
    return (await fetch(`http://127.0.0.1:${linkMetricsPort}/healthz`).catch(() => ({ ok: false }))).ok;
  }, 60_000, 250);

  const owner = await callApi(origin, 'POST', '/auth/bootstrap', {
    body: { email: 'codeless-drill@example.invalid', name: 'Codeless Drill', password: randomBytes(18).toString('base64url') },
  });
  assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
  const as = (method, route, body) => callApi(origin, method, route, { token: owner.json.accessToken, body });

  const bin = path.join(SCRATCH, 'bin');
  mkdirSync(bin, { recursive: true });
  const engineLog = path.join(SCRATCH, 'engine.log');
  writeFileSync(engineLog, '');
  writeFileSync(path.join(bin, 'claude'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO, 'scripts/owner-secret-e2e/fake-claude.mjs')}" "${engineLog}" "$@"\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  // The forking session runs `orbit` from its shell, as an agent does: this branch's binary, first on its PATH.
  writeFileSync(path.join(bin, 'orbit'), `#!/bin/sh\nexec "${BINARY}" "$@"\n`);
  chmodSync(path.join(bin, 'orbit'), 0o755);

  const enrollment = await as('POST', '/runners/enrollment-tokens', { label: 'codeless-drill', ttlHours: 6 });
  assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
  const A = new RunnerMachine({ binary: BINARY, root: path.join(SCRATCH, 'runner'), searchPath: `${bin}:/usr/local/bin:/usr/bin:/bin`, log: log.runner });
  mkdirSync(path.join(A.home, '.claude'), { recursive: true });
  writeFileSync(path.join(A.home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'drill-not-a-token', refreshToken: 'drill-not-a-refresh-token', expiresAt: Date.now() + 86_400_000 },
  }), { mode: 0o600 });
  // Commits made in the sessions' shells (the merge) need an identity; the runner's own commits bring theirs.
  writeFileSync(path.join(A.home, '.gitconfig'), '[user]\n\temail = drill@example.invalid\n\tname = Fork Drill\n');
  await A.register({ server: origin, token: enrollment.json.token, name: 'codeless-drill' });
  A.uuid = (await sql.query('SELECT id::text AS id FROM runner WHERE name = $1', ['codeless-drill'])).rows[0].id;
  A.start();
  teardown.push(() => A.stop());
  await eventually('the runner to declare codeless-checkout/v1', async () => {
    const { rows: [r] } = await sql.query('SELECT capabilities FROM runner WHERE id = $1', [A.uuid]);
    return r.capabilities.includes('codeless-checkout/v1');
  }, 120_000, 500);
  say('==> runner online, declares codeless-checkout/v1');

  const git = (...args) => spawnSync('git', ['-C', A.work, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(A.work, 'README.md'), '# drill repo\n');
  writeFileSync(path.join(A.work, 'app.txt'), 'line 1\nline 2\nline 3\n');
  git('add', '.');
  git('-c', 'user.email=drill@example.invalid', '-c', 'user.name=Fork Drill', 'commit', '-q', '-m', 'init');
  const ws = await as('POST', '/workspaces', { name: 'Codeless drill', runnerId: A.uuid, workDir: A.work });
  assert.equal(ws.status, 201, `workspace: ${ws.text}`);
  const workspaceId = ws.json.id;
  const isolated = await as('PATCH', `/workspaces/${workspaceId}`, { enableWorktree: true });
  assert.equal(isolated.status, 200, `enableWorktree: ${isolated.text}`);

  const statusOf = async (uuid) => (await sql.query('SELECT status::text AS status FROM session WHERE id = $1', [uuid])).rows[0]?.status;
  const idle = (uuid) => eventually('the session to finish its turn', async () => {
    const s = await statusOf(uuid);
    if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(s)) throw new Fatal(`session ${uuid} ended ${s}`);
    return ['AWAITING_INPUT', 'COMPLETED'].includes(s);
  }, 180_000, 500);
  const toolResults = async (uuid) => (await sql.query(
    `SELECT payload::text AS p FROM run_event WHERE session_id = $1 AND type = 'tool_result' ORDER BY seq`, [uuid])).rows.map((r) => r.p);
  const outputOf = (payload) => {
    const parsed = JSON.parse(payload);
    const content = parsed.content ?? parsed.output ?? parsed;
    return typeof content === 'string' ? content : JSON.stringify(content);
  };
  const run = async (s, command, onWait) => {
    const before = (await toolResults(s.uuid)).length;
    const sent = await as('POST', `/sessions/${s.id}/turns`, { content: `RUN: ${command}`, clientTurnId: randomUUID() });
    assert.ok([200, 201].includes(sent.status), `turn: ${sent.text}`);
    const result = await eventually(`the tool result of: ${command.slice(0, 80)}`, async () => {
      if (onWait) await onWait();
      const after = await toolResults(s.uuid);
      return after.length > before ? after[after.length - 1] : false;
    }, 180_000, 500);
    await idle(s.uuid);
    return outputOf(result);
  };

  const branches = () => git('branch', '--list').stdout.trimEnd();
  const worktrees = () => git('worktree', 'list').stdout.trimEnd();
  say(`==> repo ${A.work}\n$ git branch --list\n${branches()}`);

  /** One codeless task, run to its end: created, started, its turn done, the owner's Confirm done, finalized. */
  const runCodeless = async (title, command) => {
    const created = await as('POST', '/tasks', {
      title, description: `A codeless task.\n\nRUN: ${command}`, codeless: true, assigneeId: workspaceId,
      completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF',
    });
    assert.equal(created.status, 201, `task: ${created.text}`);
    const taskUuid = toUuid(created.json.id);
    const started = await as('POST', `/tasks/${created.json.id}/execute`, {});
    assert.ok(started.status < 300, `execute: ${started.text}`);
    const run = await eventually('the task\'s run', async () => (await sql.query(
      `SELECT id::text AS uuid, branch FROM session WHERE task_id = $1`, [taskUuid])).rows[0] ?? false, 120_000, 500);
    say(`==> task ${created.json.id} (codeless) → run ${run.uuid}, branch at create: ${run.branch ?? 'NULL'}`);
    assert.equal(run.branch, null, 'a codeless run is created with no branch');
    await idle(run.uuid);
    const checkout = path.join(A.orbitHome, 'worktrees', run.uuid);
    const head = spawnSync('git', ['-C', checkout, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' });
    say(`==> during the run: checkout ${checkout} exists=${existsSync(checkout)}, HEAD ${head.status === 0 ? `on ${head.stdout.trim()}` : 'detached'}`);
    assert.ok(existsSync(checkout), 'the run has its own checkout, not the shared workDir');
    assert.notEqual(head.status, 0, 'the checkout is detached while the run has no branch');
    say(`$ git worktree list\n${worktrees()}\n$ git branch --list\n${branches()}`);
    say(`==> run's transcript: ${JSON.stringify((await toolResults(run.uuid)).map(outputOf))}`);
    const confirmed = await as('POST', `/tasks/${created.json.id}/owner-confirmation`, { decision: 'CONFIRM' });
    say(`==> owner presses Confirm done: ${confirmed.status} ${confirmed.status >= 300 ? confirmed.text.slice(0, 300) : ''}`);
    assert.ok(confirmed.status < 300, 'the task could not be confirmed');
    const ended = await eventually('the run to be finalized', async () => {
      const { rows: [r] } = await sql.query(
        `SELECT status::text AS status, branch, base_sha, isolation_status, changed_files::text AS changed_files, finished_at
           FROM session WHERE id = $1`, [run.uuid]);
      return r.finished_at ? r : false;
    }, 300_000, 1000);
    say(`==> run finalized: ${JSON.stringify(ended)}`);
    return { run, checkout, ended };
  };

  // ── 1. A codeless run that changes nothing ──────────────────────────────────────────────────
  say('==> 1. a codeless task whose run changes nothing');
  const one = await runCodeless('Read the README and answer', 'cat README.md && git status --short && echo read-only');
  say(`$ git branch --list\n${branches()}\n$ git worktree list\n${worktrees()}`);
  assert.equal(one.ended.branch, null, 'no branch is recorded');
  assert.equal(branches(), '* main', 'git branch --list has a branch besides main');
  await eventually('the detached checkout to be removed', async () => !existsSync(one.checkout), 60_000, 500);
  say(`==> checkout ${one.checkout} exists=${existsSync(one.checkout)}; no branch was ever made`);

  // ── 2. A codeless run that writes a file ────────────────────────────────────────────────────
  say('==> 2. a codeless task whose run writes a file');
  const two = await runCodeless('Write down the findings', `printf 'findings of a codeless task\\n' > findings.md && ls`);
  say(`$ git branch --list\n${branches()}`);
  assert.match(two.ended.branch ?? '', /^orbit\//, 'the run reports the branch made at finalize');
  assert.ok(branches().split('\n').some((l) => l.replace(/^[*+ ] /, '').trim() === two.ended.branch), 'the branch is in git branch --list');
  const changed = JSON.parse(two.ended.changed_files ?? '[]');
  say(`==> changedFiles: ${JSON.stringify(changed)}`);
  assert.deepEqual(changed.map((f) => f.path), ['findings.md']);
  const onBranch = git('show', `${two.ended.branch}:findings.md`).stdout;
  say(`$ git log --oneline --stat main..${two.ended.branch}\n${git('log', '--format=%h %s', '--stat', `main..${two.ended.branch}`).stdout}`);
  assert.equal(onBranch, 'findings of a codeless task\n');
  say('DRILL PASS');
}

main().catch((error) => {
  say(`DRILL FAIL\n${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const step of teardown.reverse()) await Promise.resolve().then(step).catch(() => undefined);
});
