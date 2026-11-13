// The fork-from-session drill on a real runner (docs/task-fork-from-session-design.md §5 P2).
//
//   node scripts/task-fork-drill/run.mjs <orbit-binary> <link-gateway-binary>
//   (after `bash scripts/worktree-overlay.sh` and `npm run build -w @orbit/apiserver`; the binaries from
//   src/runner-go and src/link-gateway)
//
// THE STACK — every piece a real process, as in scripts/owner-secret-e2e/run.mjs:
//   PostgreSQL, migrated by this branch · the apiserver (`node dist/main.js`) · the link gateway · one runner, the
//   `orbit` binary of this branch, `orbit register` then `orbit run` · scripts/owner-secret-e2e/fake-claude.mjs as
//   `claude`, which runs the shell command a turn names (`RUN: <command>`).
//
// THE DRILL
//   1. A session (its own worktree) makes uncommitted edits and, in the same shell command, runs
//      `orbit task create --fork-from-session`, with a checksum of its checkout (every file, and the index) taken
//      immediately before and after. The owner answers the card "Create and start".
//   2. The keep-alive ref refs/orbit/fork/<id> is listed while the task is open; the task's run is pinned
//      SESSION_FORK to the snapshot S and starts from it.
//   3. The task's run changes one more file and commits it; its turn ends, and the owner closes the task.
//   4. The forking session runs `git merge --no-ff <task branch>`; its branch's log has both the original edits and
//      the task's change.
//   5. The ref is listed again after the runner's gc has had the task's close: gone.
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
const SCRATCH = process.env.TASK_FORK_DRILL_DIR ?? path.join('/tmp', `task-fork-drill-${process.pid}`);
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

/** The checksum of a checkout as the forking session's own shell takes it: every file but .git, then the index. */
const CHECKSUM = `{ find . -path ./.git -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; ` +
  `sha256sum "$(git rev-parse --path-format=absolute --git-path index)" | sed 's|  .*|  <index>|'; ` +
  `stat -c 'index inode=%i mtime=%.9Y size=%s' "$(git rev-parse --path-format=absolute --git-path index)"; }`;

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' };
  say(`==> scratch ${SCRATCH}`);
  say(`==> runner binary ${BINARY} (${spawnSync(BINARY, ['--version'], { encoding: 'utf8' }).stdout.trim()})`);
  const database = await startPostgres({ pg, name: `task-fork-drill-pg-${process.pid}`, log: log.harness });
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
    body: { email: 'fork-drill@example.invalid', name: 'Fork Drill', password: randomBytes(18).toString('base64url') },
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

  const enrollment = await as('POST', '/runners/enrollment-tokens', { label: 'fork-drill', ttlHours: 6 });
  assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
  const A = new RunnerMachine({ binary: BINARY, root: path.join(SCRATCH, 'runner'), searchPath: `${bin}:/usr/local/bin:/usr/bin:/bin`, log: log.runner });
  mkdirSync(path.join(A.home, '.claude'), { recursive: true });
  writeFileSync(path.join(A.home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'drill-not-a-token', refreshToken: 'drill-not-a-refresh-token', expiresAt: Date.now() + 86_400_000 },
  }), { mode: 0o600 });
  // Commits made in the sessions' shells (the merge) need an identity; the runner's own commits bring theirs.
  writeFileSync(path.join(A.home, '.gitconfig'), '[user]\n\temail = drill@example.invalid\n\tname = Fork Drill\n');
  await A.register({ server: origin, token: enrollment.json.token, name: 'fork-drill' });
  A.uuid = (await sql.query('SELECT id::text AS id FROM runner WHERE name = $1', ['fork-drill'])).rows[0].id;
  A.start();
  teardown.push(() => A.stop());
  await eventually('the runner to declare task-fork/v1', async () => {
    const { rows: [r] } = await sql.query('SELECT capabilities FROM runner WHERE id = $1', [A.uuid]);
    return r.capabilities.includes('task-fork/v1');
  }, 120_000, 500);
  say('==> runner online, declares task-fork/v1');

  const git = (...args) => spawnSync('git', ['-C', A.work, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(A.work, 'README.md'), '# drill repo\n');
  writeFileSync(path.join(A.work, 'app.txt'), 'line 1\nline 2\nline 3\n');
  git('add', '.');
  git('-c', 'user.email=drill@example.invalid', '-c', 'user.name=Fork Drill', 'commit', '-q', '-m', 'init');
  const ws = await as('POST', '/workspaces', { name: 'Fork drill', runnerId: A.uuid, workDir: A.work });
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

  // ── 1. The forking session ──────────────────────────────────────────────────────────────────
  const created = await as('POST', '/sessions', { workspaceId, provider: 'claude', permissionMode: 'auto', prompt: 'RUN: echo ready' });
  assert.ok([200, 201].includes(created.status), `session: ${created.text}`);
  const F = { id: created.json.id, uuid: toUuid(created.json.id) };
  await idle(F.uuid);
  const fRow = (await sql.query('SELECT branch FROM session WHERE id = $1', [F.uuid])).rows[0];
  const checkout = path.join(A.orbitHome, 'worktrees', F.uuid);
  assert.ok(existsSync(checkout), `the forking session's worktree ${checkout}`);
  say(`==> forking session ${F.id} on branch ${fRow.branch}, checkout ${checkout}`);

  const description = 'Continue the forking session\'s work: add one more file.\n\nRUN: printf \'added by the forked task\\n\' > task-change.txt && git add task-change.txt && git commit -q -m \'Add task-change.txt\' && git log --oneline -3';
  const descriptionFile = path.join(SCRATCH, 'task-description.txt');
  writeFileSync(descriptionFile, description);
  const forkCommand = [
    `printf 'line 1\\nline 2 edited, uncommitted\\nline 3\\n' > app.txt`,
    `printf 'an untracked note\\n' > notes.txt`,
    `echo '--- git status before the fork'`, 'git status --short',
    `${CHECKSUM} > /tmp/fork-drill-before-$$.txt`,
    `orbit task create --title 'Forked: add one more file' --description-file - ` +
      `--completion-criterion OWNER_CONFIRMED --owner-confirmation-reason OWNER_TRADE_OFF --fork-from-session --json < ${descriptionFile} > /tmp/fork-drill-task-$$.json; echo "create exit=$?"`,
    `${CHECKSUM} > /tmp/fork-drill-after-$$.txt`,
    `echo '--- checksum immediately before the fork'`, `cat /tmp/fork-drill-before-$$.txt`,
    `echo '--- checksum immediately after the fork'`, `cat /tmp/fork-drill-after-$$.txt`,
    `if cmp -s /tmp/fork-drill-before-$$.txt /tmp/fork-drill-after-$$.txt; then echo 'CHECKSUMS IDENTICAL'; else echo 'CHECKSUMS DIFFER'; fi`,
    `echo '--- created task'`, `cat /tmp/fork-drill-task-$$.json`,
  ].join('; ');
  let answered = false;
  const approveCard = async () => {
    if (answered) return;
    const list = await as('GET', `/sessions/${F.id}/approvals?status=PENDING`);
    const pending = (Array.isArray(list.json) ? list.json : list.json?.items ?? []).filter((a) => a.status === 'PENDING' || !a.status);
    for (const card of pending) {
      const decided = await as('POST', `/sessions/${F.id}/approvals/${card.id}/decision`, { behavior: 'allow', startAfterCreate: true });
      say(`==> owner answered card ${card.toolName ?? ''} "Create and start": ${decided.status}`);
      answered = decided.status < 300;
    }
  };
  say('==> 1. the forking session edits, then forks a task, in one shell command:');
  say(`$ ${forkCommand}`);
  const forkOutput = await run(F, forkCommand, approveCard);
  say(forkOutput);
  assert.match(forkOutput, /CHECKSUMS IDENTICAL/, 'the forking checkout changed across the fork');
  assert.match(forkOutput, /create exit=0/, 'orbit task create failed');

  const task = (await sql.query(
    `SELECT id::text AS id, status::text AS status, fork_sha, fork_base_head, fork_includes_uncommitted, fork_session_id::text AS fsid
       FROM task WHERE fork_sha IS NOT NULL`)).rows[0];
  assert.ok(task, 'no forked task row');
  assert.equal(task.fsid, F.uuid);
  say(`==> task ${task.id}: fork_sha=${task.fork_sha} fork_base_head=${task.fork_base_head} includes_uncommitted=${task.fork_includes_uncommitted}`);
  say(`$ git show --stat ${task.fork_sha}\n${git('show', '--stat', '--format=%H %P%n%s', task.fork_sha).stdout}`);

  // ── 2. The ref while the task is open, and the task's SOURCE ────────────────────────────────
  const refs = () => git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/orbit/fork/').stdout.trim();
  const refsOpen = refs();
  say(`==> 2. ref listing while the task is open (status ${task.status}):\n$ git for-each-ref refs/orbit/fork/\n${refsOpen}`);
  assert.ok(refsOpen.startsWith(`${task.fork_sha} refs/orbit/fork/`), 'no keep-alive ref names S');
  const T = await eventually('the task\'s session', async () => (await sql.query(
    `SELECT id::text AS uuid, branch FROM session WHERE task_id = $1`, [task.id])).rows[0] ?? false, 120_000, 500);
  await idle(T.uuid);
  const source = (await sql.query(
    `SELECT source_state, source_kind, source_revision_sha, source_ref_authority, source_base_sha FROM session WHERE id = $1`, [T.uuid])).rows[0];
  say(`==> the task's run ${T.uuid} on branch ${T.branch}: SOURCE ${JSON.stringify(source)}`);
  assert.equal(source.source_kind, 'SESSION_FORK');
  assert.equal(source.source_base_sha, task.fork_sha);
  assert.equal(source.source_ref_authority, 'RUNNER_LOCAL');

  // ── 3. The task's change, then its close ───────────────────────────────────────────────────
  say(`==> 3. the task's run changed one more file; its branch:\n$ git log --oneline --stat ${fRow.branch ? '' : ''}${T.branch} -3\n${git('log', '--format=%h %s', '--stat', T.branch, '-3').stdout}`);
  assert.ok(git('cat-file', '-e', `${T.branch}:task-change.txt`).status === 0, 'the task branch lacks task-change.txt');
  assert.equal(git('merge-base', '--is-ancestor', task.fork_sha, T.branch).status, 0, 'the task branch does not start from S');
  await eventually('the runner to state S open (a full beat after the create)', async () =>
    readFileSync(log.runner.file, 'utf8').includes(`fork snapshot ${task.fork_sha} is open`), 420_000, 1000);
  say(`==> runner log: fork snapshot ${task.fork_sha} is open`);
  // An OWNER_CONFIRMED task is DONE by the owner's Confirm done press, never by a status write.
  let closed = await as('POST', `/tasks/${task.id}/owner-confirmation`, { decision: 'CONFIRM' });
  say(`==> owner presses Confirm done: ${closed.status} ${closed.status >= 300 ? closed.text.slice(0, 400) : ''}`);
  if (closed.status >= 300) {
    closed = await as('PATCH', `/tasks/${task.id}`, { status: 'CANCELLED' });
    say(`==> owner closes the task CANCELLED instead: ${closed.status} ${closed.status >= 300 ? closed.text.slice(0, 400) : ''}`);
  }
  assert.ok(closed.status < 300, 'the task could not be closed');
  const finalStatus = (await sql.query('SELECT status::text AS s FROM task WHERE id = $1', [task.id])).rows[0].s;
  say(`==> task status now ${finalStatus}`);

  // ── 4. The forking session merges the task branch ──────────────────────────────────────────
  // The forking session's own commit of the edits S captured (design §2.5: "its own turn-end commit"), then the merge.
  const mergeCommand = `git status --short; git add -A && git commit -q -m 'Forking session commits its own work'; git log --oneline -3; git merge --no-ff ${T.branch} -m 'Merge forked task ${T.branch}'; echo "merge exit=$?"; ` +
    `git log --graph --format='%h %s' -8; echo '--- files'; cat app.txt notes.txt task-change.txt`;
  say(`==> 4. the forking session merges the task branch:\n$ ${mergeCommand}`);
  const mergeOutput = await run(F, mergeCommand);
  say(mergeOutput);
  assert.match(mergeOutput, /merge exit=0/);
  const branchLog = git('log', '--format=%h %s', '--stat', fRow.branch, '-6').stdout;
  say(`$ git log --stat ${fRow.branch} -6\n${branchLog}`);
  const tip = fRow.branch;
  assert.match(git('show', `${tip}:app.txt`).stdout, /line 2 edited, uncommitted/);
  assert.equal(git('show', `${tip}:notes.txt`).stdout, 'an untracked note\n');
  assert.equal(git('show', `${tip}:task-change.txt`).stdout, 'added by the forked task\n');

  // ── 5. The ref after the close ──────────────────────────────────────────────────────────────
  await eventually('the runner to delete the keep-alive ref', async () => refs() === '', 420_000, 1000);
  const gcLine = readFileSync(log.runner.file, 'utf8').split('\n').find((l) => l.includes('fork snapshot ref') && l.includes('deleted'));
  say(`==> 5. ref listing after the task closed:\n$ git for-each-ref refs/orbit/fork/\n${refs() || '(none)'}\nrunner log: ${gcLine}`);
  say('DRILL PASS');
}

main().catch((error) => {
  say(`DRILL FAIL\n${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const step of teardown.reverse()) await Promise.resolve().then(step).catch(() => undefined);
});
