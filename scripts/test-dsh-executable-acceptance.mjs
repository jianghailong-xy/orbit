// D3 acceptance: an EXECUTABLE task on DeepSeek Harness, created through the real apiserver (PostgreSQL) and run
// by an Orbit runner built from this tree on the pinned official dsh against a local mock model. Its acceptance
// command is the runner's to run, in the worktree, exactly as for every other engine. Run through
// scripts/test-dsh-executable-acceptance.sh, which builds what this needs and passes it in.
//
// Stack (every piece a real process): postgres:16-alpine ← `prisma migrate deploy`; apiserver `node dist/main.js`;
// one runner (`orbit register` + `orbit run`, its own ORBIT_HOME); dsh 0.2.0-rc.2 installed from the runner's own
// embedded P0 lock; `claude` is scripts/deepseek-harness-dispatch/fake-claude.mjs (stream-json, no account);
// codex/kimi/opencode/agy/dsh on PATH are shims that record being run and fail.
//
// Where the result is written: the platform's EXECUTABLE comparison writes `task.status` and nothing else
// (runner-api executable-exit-code-judgment.spec.ts, by the account owner's direction of 2026-09-03). The raw
// output and the exit code live in the session transcript (the runner's `shell-<turnId>` Bash tool_use /
// tool_result pair) and, for a FAILED task, in the session's error sentence. No engine writes a task comment for
// a comparable result; the scenarios below hold Harness to exactly what Claude does there.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Fatal, RunnerMachine, callApi, eventually, fileLog, freePort, lookPath, migrate, startApiserver, startPostgres } from './codex-reset-e2e/harness.mjs';

export const SCENARIOS = [
  'D3-S1 Harness EXECUTABLE task: a passing acceptance command runs on the runner in the worktree and derives DONE',
  'D3-S2 Harness EXECUTABLE task: a failing acceptance command derives FAILED with its exit code and raw output recorded',
  'D3-S3 a person\'s ! shell on a Harness session is still refused, and a forged acceptance key is rejected at the door',
  'D3-S4 Claude EXECUTABLE tasks settle DONE and FAILED unchanged, in the same shape as Harness',
];

const ACCEPTANCE_PREFIX = 'system:task-acceptance:v1:';
const UNAVAILABLE = 'EXECUTABLE_ACCEPTANCE_UNAVAILABLE';
const HARNESS_REFUSAL = 'DeepSeek Harness sessions do not run shell turns';

/** A report is green only when it names exactly the required scenarios, once each, all PASS. */
export function assertReport(report, required = SCENARIOS) {
  assert.ok(Array.isArray(report) && report.length > 0, 'no scenario reported');
  for (const name of required) {
    const rows = report.filter((row) => row.name === name);
    assert.equal(rows.length, 1, `missing, unmatched or duplicate scenario: ${name}`);
    assert.equal(rows[0].status, 'PASS', `scenario did not pass (${rows[0].status}): ${name}`);
  }
  for (const row of report) assert.ok(required.includes(row.name), `unexpected scenario: ${row.name}`);
}

function selfTestReport() {
  const good = SCENARIOS.map((name) => ({ name, status: 'PASS' }));
  assertReport(good);
  for (const bad of [
    [],
    good.slice(1),
    [...good, good[0]],
    good.map((row, i) => (i === 1 ? { ...row, status: 'SKIP' } : row)),
    good.map((row, i) => (i === 2 ? { ...row, status: 'FAIL' } : row)),
    good.map((row, i) => (i === 3 ? { ...row, name: `${row.name} (renamed)` } : row)),
    [...good, { name: 'D3-S9 extra', status: 'PASS' }],
  ]) assert.throws(() => assertReport(bad));
  process.stdout.write('PASS acceptance guard rejects missing, unmatched, duplicate, skipped and failed scenarios\n');
}

async function main() {
  selfTestReport();
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required: run scripts/test-dsh-executable-acceptance.sh`);
    return value;
  };
  const REPO = required('DSH_EXEC_ACC_REPO');
  const SCRATCH = required('DSH_EXEC_ACC_SCRATCH');
  const RUNNER_BINARY = required('DSH_EXEC_ACC_RUNNER_BINARY');
  const PRISMA = required('DSH_EXEC_ACC_PRISMA');
  const PG_NAME = required('DSH_EXEC_ACC_PG_NAME');
  const API = path.join(REPO, 'src/apiserver');
  const requireFromApi = createRequire(path.join(API, 'package.json'));
  const pg = requireFromApi('pg');
  const shared = requireFromApi(path.join(REPO, 'src/shared/dist/index.js'));
  const { executableAcceptanceFailureReason } = requireFromApi(path.join(API, 'dist/tasks/executable-acceptance-round.js'));
  assert.equal(typeof executableAcceptanceFailureReason, 'function', 'the apiserver build exports no executableAcceptanceFailureReason');
  const DSH_VERSION = '0.2.0-rc.2';
  const MOCK_KEY = `sk-d3-synthetic-${randomBytes(6).toString('hex')}`;
  const MOCK_ANSWER = 'D3 mock model: the work is done.';

  const logs = path.join(SCRATCH, 'logs');
  const log = { harness: fileLog(path.join(logs, 'harness.log')), api: fileLog(path.join(logs, 'apiserver.log')) };
  const say = (line) => {
    process.stdout.write(`${line}\n`);
    log.harness(`${new Date().toISOString()} ${line}\n`);
  };
  const teardown = [];
  const report = [];
  const facts = {};
  let fatal = null;

  try {
    // ── the pinned dsh, installed the way the runner installs it ─────────────────────────────────
    const lockDir = path.join(REPO, 'src/runner-go/dsh-install');
    const p0 = path.join(REPO, 'scripts/deepseek-harness-p0');
    for (const file of ['package.json', 'package-lock.json']) {
      assert.equal(readFileSync(path.join(lockDir, file), 'utf8'), readFileSync(path.join(p0, file), 'utf8'), `runner's embedded ${file} differs from the P0 lock`);
    }
    const install = path.join(SCRATCH, 'dsh-install', DSH_VERSION);
    mkdirSync(install, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) cpSync(path.join(lockDir, file), path.join(install, file));
    say(`==> npm ci of the runner's embedded dsh ${DSH_VERSION} lock`);
    run('npm', ['ci', '--prefix', install, '--cache', path.join(SCRATCH, 'npm-cache'), '--no-audit', '--no-fund'], path.join(logs, 'npm.log'),
      { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'npm-home') }, install);
    const dshBin = path.join(install, 'node_modules/.bin/dsh');
    const version = run(dshBin, ['--version'], path.join(logs, 'dsh-version.log'),
      { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'npm-home'), DSH_HOME: path.join(SCRATCH, 'dsh-version-home'), DSH_TELEMETRY_DISABLED: '1' }).trim();
    assert.equal(version, DSH_VERSION, 'unsupported dsh CLI version');
    const cliSha256 = createHash('sha256').update(readFileSync(dshBin)).digest('hex');
    const baseline = JSON.parse(readFileSync(path.join(REPO, 'docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json'), 'utf8'));
    assert.equal(cliSha256, baseline.cliSha256, 'CLI differs from the fixed P0 artifact');
    Object.assign(facts, { dshVersion: version, cliSha256 });
    say(`    official dsh ${version}, CLI sha256=${cliSha256}`);

    // ── the mock model ──────────────────────────────────────────────────────────────────────────
    const mockLog = path.join(logs, 'model-requests.ndjson');
    const mock = spawn(process.execPath, [path.join(REPO, 'scripts/deepseek-harness-dispatch/mock-model.mjs'), mockLog, MOCK_KEY, MOCK_ANSWER],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
    teardown.push(() => mock.kill('SIGTERM'));
    const mockURL = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock model did not start')), 10_000);
      mock.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(chunk.toString().trim()); });
      mock.once('exit', (code) => reject(new Error(`mock model exited ${code}`)));
    });
    const modelRequests = () => readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    say(`==> mock Messages endpoint ${mockURL}`);

    // ── PostgreSQL and the apiserver ────────────────────────────────────────────────────────────
    const baseEnv = { PATH: process.env.PATH, HOME: path.join(SCRATCH, 'home'), LANG: 'C.UTF-8' };
    mkdirSync(baseEnv.HOME, { recursive: true });
    say(`==> PostgreSQL ${PG_NAME}`);
    const database = await startPostgres({ pg, name: PG_NAME, log: log.harness });
    teardown.push(() => database.stop());
    say('==> prisma migrate deploy');
    migrate({ apiDir: API, prisma: PRISMA, url: database.url, env: baseEnv, log: log.harness });
    const sql = new pg.Client({ connectionString: database.url });
    sql.on('error', (error) => say(`sql client error: ${error.message}`));
    await sql.connect();
    teardown.push(() => sql.end());
    const one = async (text, params) => (await sql.query(text, params)).rows[0];
    const all = async (text, params) => (await sql.query(text, params)).rows;
    say('==> apiserver (node dist/main.js)');
    const api = await startApiserver({
      apiDir: API, node: process.execPath, port: await freePort(), log: log.api,
      env: { ...baseEnv, DATABASE_URL: database.url, JWT_SECRET: randomBytes(32).toString('hex'),
        PROVIDER_SECRET_KEY: randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://127.0.0.1',
        MODEL_CATALOG_URL: 'http://127.0.0.1:9/models.json', NO_COLOR: '1' },
    });
    teardown.push(() => api.stop());
    const owner = await callApi(api.origin, 'POST', '/auth/bootstrap',
      { body: { email: 'd3-owner@example.invalid', name: 'D3 Owner', password: randomBytes(18).toString('base64url') } });
    assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
    const token = owner.json.accessToken;
    const call = (method, route, body) => callApi(api.origin, method, route, { token, body });

    // ── the runner ──────────────────────────────────────────────────────────────────────────────
    const root = path.join(SCRATCH, 'runner');
    const shims = path.join(root, 'shim-bin');
    const shimLog = path.join(root, 'engine-shims.log');
    mkdirSync(shims, { recursive: true });
    writeFileSync(shimLog, '');
    for (const engine of ['codex', 'kimi', 'opencode', 'agy', 'dsh']) {
      writeFileSync(path.join(shims, engine), `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "${engine}" "\${ORBIT_SESSION_ID:-}" "$*" >> '${shimLog}'
echo "test-dsh-executable-acceptance: ${engine} is a recording shim here, not an engine" >&2
exit 97
`);
      chmodSync(path.join(shims, engine), 0o755);
    }
    writeFileSync(path.join(shims, 'claude'), `#!/bin/sh
exec '${process.execPath}' '${path.join(REPO, 'scripts/deepseek-harness-dispatch/fake-claude.mjs')}' '${shimLog}' "$@"
`);
    chmodSync(path.join(shims, 'claude'), 0o755);
    const machine = new RunnerMachine({ binary: RUNNER_BINARY, root, searchPath: `${shims}:/usr/local/bin:/usr/bin:/bin`, log: fileLog(path.join(logs, 'runner.log')) });
    const versionDir = path.join(machine.orbitHome, 'engines', 'dsh', DSH_VERSION);
    mkdirSync(path.dirname(versionDir), { recursive: true });
    cpSync(install, versionDir, { recursive: true, verbatimSymlinks: true });
    const enrollment = await call('POST', '/runners/enrollment-tokens', { label: 'd3', ttlHours: 6 });
    assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
    say('==> orbit register');
    await machine.register({ server: api.origin, token: enrollment.json.token, name: 'd3-runner' });
    const runnerRow = await one('SELECT id::text AS id FROM runner WHERE name = $1', ['d3-runner']);
    assert.ok(runnerRow, 'orbit register created no runner');
    const runnerPublicId = shared.uuidToBase62(runnerRow.id);
    teardown.push(() => machine.stop());
    say('==> orbit run');
    machine.start();
    await sleep(2_000);
    assert.ok(machine.alive(), 'orbit run exited at start');
    assert.equal(lookPath(machine.effectivePath(), 'claude'), path.join(shims, 'claude'), 'the runner would run a real claude');
    await eventually('the runner to declare provider:dsh', async () =>
      (await one('SELECT capabilities FROM runner WHERE id = $1', [runnerRow.id]))?.capabilities?.includes('provider:dsh'), 90_000);
    const runnerPid = machine.child.pid;

    // A plain (non-git) workspace directory per engine, holding the module the acceptance command imports.
    const workspace = async (label, env) => {
      const dir = path.join(root, 'work', label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'calc.py'), 'def divide(a, b):\n    return a / b\n');
      const created = await call('POST', '/workspaces', { name: `D3 ${label}`, runnerId: runnerPublicId, workDir: dir });
      assert.equal(created.status, 201, `workspace: ${created.text}`);
      const id = created.json.publicId ?? created.json.id;
      if (env) {
        const patched = await call('PATCH', `/workspaces/${id}`, { env });
        assert.equal(patched.status, 200, `workspace env: ${patched.text}`);
      }
      return { id, dir: realpathSync(dir) };
    };
    const ws = {
      harness: await workspace('harness'),
      claude: await workspace('claude', { ANTHROPIC_API_KEY: 'sk-ant-d3-fake-claude-only' }),
    };
    const provider = await call('POST', '/providers/mine', { label: 'D3 Harness mock', runtime: 'dsh', baseUrl: mockURL, apiKey: MOCK_KEY, models: [] });
    assert.equal(provider.status, 201, `dsh provider: ${provider.text}`);
    const harness = provider.json.slug;
    assert.ok(harness, `dsh provider has no slug: ${provider.text}`);
    // An older client's Harness form is stored as a DeepSeek key (docs/provider-engine-contract.md §3.6),
    // which runs on Claude Code unless DeepSeek Harness is named as the engine.
    say(`==> provider ${harness} (a DeepSeek key, run on DeepSeek Harness) → ${mockURL}`);

    // The command prints who ran it ($PPID is the process that exec'd bash) and where, then does the real check.
    const acceptanceCommand = (expectation) =>
      `echo "d3-acceptance ppid=$PPID cwd=$(pwd)"; python3 -c "import calc; assert calc.divide(6, 3) == ${expectation}; print('d3 calc ok')"`;

    /** Create an EXECUTABLE task on `providerSlug`, run it, and wait for the platform to settle it. */
    const runTask = async (label, workspaceRef, providerSlug, command) => {
      const tag = `D3 ${label} ${randomBytes(4).toString('hex')}`;
      const modelCallsBefore = modelRequests().length;
      const created = await call('POST', '/tasks', {
        title: tag,
        description: `${tag}: calc.divide in this directory is already correct. Reply that the work is done; change nothing.`,
        assigneeId: workspaceRef.id,
        provider: providerSlug,
        ...(providerSlug === harness ? { engine: 'dsh' } : {}),
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: command,
        acceptanceExpectedExitCode: 0,
        acceptanceTimeoutSeconds: 120,
        autoRunWhenReady: false,
      });
      assert.equal(created.status, 201, `task create: ${created.status} ${created.text}`);
      const taskPublicId = created.json.publicId ?? created.json.id;
      const task = await one('SELECT id::text AS id FROM task WHERE title = $1', [tag]);
      assert.ok(task, 'the created task has no row');
      const executed = await call('POST', `/tasks/${taskPublicId}/execute`, { triggerId: randomUUID() });
      assert.ok([200, 201].includes(executed.status), `task execute: ${executed.status} ${executed.text}`);
      const settled = await eventually(`task ${label} to settle`, async () => {
        const row = await one('SELECT status::text AS status FROM task WHERE id = $1', [task.id]);
        const unavailable = await one('SELECT body FROM task_comment WHERE task_id = $1 AND body LIKE $2', [task.id, `%${UNAVAILABLE}%`]);
        if (unavailable) throw new Fatal(`the task was marked ${UNAVAILABLE}:\n${unavailable.body}`);
        return ['DONE', 'FAILED', 'CANCELLED'].includes(row?.status) && row;
      }, 300_000, 500);
      const session = await one(`SELECT id::text AS id, status::text AS status, error, runtime_session_id, provider
        FROM session WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [task.id]);
      assert.ok(session, 'the task ran no session');
      const turns = await all(`SELECT id::text AS id, kind, status, content, client_turn_id, delivered_at FROM conversation_turn
        WHERE session_id = $1 ORDER BY seq`, [session.id]);
      const acceptance = turns.filter((t) => t.client_turn_id.startsWith(ACCEPTANCE_PREFIX));
      assert.equal(acceptance.length, 1, `expected one acceptance turn, found ${acceptance.length}: ${JSON.stringify(turns)}`);
      const turn = acceptance[0];
      const events = await all(`SELECT type, payload FROM run_event WHERE session_id = $1 AND turn_id = $2 ORDER BY seq`, [session.id, turn.id]);
      const comments = await all('SELECT body FROM task_comment WHERE task_id = $1 ORDER BY created_at', [task.id]);
      return { tag, task, status: settled.status, session, turns, turn, events, comments, modelCallsBefore };
    };

    /** The acceptance turn ran as a runner shell: shape, provenance and output. */
    const checkRunnerShell = (r, command, workspaceDir, { exitCode, outputIncludes }) => {
      assert.equal(r.turn.kind, 'shell', 'the acceptance turn is not a shell turn');
      assert.equal(r.turn.content, command, 'the acceptance turn does not carry the declared command');
      assert.equal(r.turn.status, 'ANSWERED', `the acceptance turn settled ${r.turn.status}`);
      assert.ok(r.turn.client_turn_id.endsWith(':0'), `the acceptance key binds another expectation: ${r.turn.client_turn_id}`);
      const toolUseId = `shell-${r.turn.id}`;
      const use = r.events.find((e) => e.type === 'tool_use' && e.payload.id === toolUseId);
      const result = r.events.find((e) => e.type === 'tool_result' && e.payload.toolUseId === toolUseId);
      assert.ok(use, `no runner Bash tool_use ${toolUseId} for the acceptance turn: ${JSON.stringify(r.events.map((e) => e.type))}`);
      assert.equal(use.payload.name, 'Bash');
      assert.equal(use.payload.input?.command, command, 'the transcript shows another command');
      assert.ok(result, `no tool_result for ${toolUseId}`);
      const output = String(result.payload.content ?? '');
      assert.equal(result.payload.isError, exitCode !== 0, `isError does not match exit ${exitCode}`);
      for (const text of outputIncludes) assert.ok(output.includes(text), `the raw output lacks ${JSON.stringify(text)}:\n${output}`);
      const ran = /d3-acceptance ppid=(\d+) cwd=(.*)/.exec(output);
      assert.ok(ran, `the command's own provenance line is missing:\n${output}`);
      const ppid = Number(ran[1]);
      assert.equal(ran[2].trim(), workspaceDir, 'the acceptance command ran outside the task worktree');
      // The process that started bash is the runner binary itself — not dsh, not node, not an engine.
      assert.equal(ppid, runnerPid, `bash was started by pid ${ppid}, not the runner (${runnerPid})`);
      assert.equal(realpathSync(readlinkSync(`/proc/${ppid}/exe`)), realpathSync(RUNNER_BINARY), 'the acceptance shell parent is not the runner binary');
      assert.ok(!r.events.some((e) => JSON.stringify(e.payload).includes(HARNESS_REFUSAL)), 'the acceptance turn carries the Harness shell refusal');
      return { toolUseId, output, ppid, exitCode };
    };

    // ── scenarios ──────────────────────────────────────────────────────────────────────────────
    const scenario = async (name, body) => {
      say(`\n---- ${name}`);
      const startedAt = Date.now();
      try {
        await body();
        report.push({ name, status: 'PASS', ms: Date.now() - startedAt });
        say(`PASS ${name}`);
      } catch (error) {
        report.push({ name, status: 'FAIL', ms: Date.now() - startedAt, error: error.stack ?? String(error) });
        say(`FAIL ${name}\n${error.stack ?? error}`);
      }
    };

    /**
     * dsh and its model never saw the acceptance round. The mock answers every prompt with one text block and
     * no tool call, so one dsh turn is exactly one model request: since this task was created, the model was
     * asked once, and that once was the task brief. A prompt carrying the acceptance command would be a second.
     */
    const checkModelNeverHeard = (r, command) => {
      const heard = modelRequests().slice(r.modelCallsBefore);
      const messageTurns = r.turns.filter((t) => t.kind === 'message').length;
      assert.equal(messageTurns, 1, `expected the one task-brief turn, found ${messageTurns}`);
      assert.equal(heard.length, 1, `the model was asked ${heard.length} times for one brief turn: ${JSON.stringify(heard.map((m) => (m.lastUser ?? '').slice(0, 120)))}`);
      assert.ok((heard[0].lastUser ?? '').includes(r.tag), 'the one model request was not the task brief');
      assert.ok(heard[0].keyMatched, 'a model request carried another key');
      assert.ok(!heard.some((m) => (m.lastUser ?? '').trim() === command), 'the acceptance command was prompted to the model');
      const shimmed = readFileSync(shimLog, 'utf8').split('\n').filter((l) => l.startsWith('dsh\t'));
      assert.equal(shimmed.length, 0, 'something ran a dsh other than the pinned install');
      return { modelRequestsForTask: heard.length };
    };

    const harnessResults = {};
    await scenario(SCENARIOS[0], async () => {
      const command = acceptanceCommand(2);
      const r = await runTask('harness-pass', ws.harness, harness, command);
      assert.equal(r.session.provider, harness, `the task ran on ${r.session.provider}, not the Harness provider`);
      assert.ok(r.session.runtime_session_id, 'the Harness session has no ACP session id: dsh never ran the execution turn');
      const execution = r.turns.find((t) => t.kind === 'message');
      assert.equal(execution?.status, 'ANSWERED', 'the execution turn did not settle');
      assert.equal(r.status, 'DONE', `exit 0 against expectation 0 must derive DONE; task is ${r.status}, session error ${r.session.error}`);
      assert.equal(r.session.error, null, `the session carries an error: ${r.session.error}`);
      const shell = checkRunnerShell(r, command, ws.harness.dir, { exitCode: 0, outputIncludes: ['d3 calc ok'] });
      const model = checkModelNeverHeard(r, command);
      assert.ok(!r.comments.some((c) => c.body.includes(UNAVAILABLE)), 'an unavailable comment was written');
      harnessResults.pass = r;
      facts.s1 = { task: r.task.id, status: r.status, sessionStatus: r.session.status, acceptanceTurn: r.turn.id, ...shell, ...model,
        taskComments: r.comments.length };
    });

    await scenario(SCENARIOS[1], async () => {
      const command = acceptanceCommand(3);
      const r = await runTask('harness-fail', ws.harness, harness, command);
      assert.equal(r.session.provider, harness);
      assert.equal(r.status, 'FAILED', `exit 1 against expectation 0 must derive FAILED; task is ${r.status}`);
      assert.equal(r.session.error, executableAcceptanceFailureReason(1, 0), `the session error does not name both codes: ${r.session.error}`);
      const shell = checkRunnerShell(r, command, ws.harness.dir, { exitCode: 1, outputIncludes: ['AssertionError'] });
      // Python 3.13 echoes the `-c` source in its traceback, so only a printed line counts as the check passing.
      assert.ok(!/^d3 calc ok$/m.test(shell.output), 'the failing check printed its success line');
      const model = checkModelNeverHeard(r, command);
      assert.ok(!r.comments.some((c) => c.body.includes(UNAVAILABLE)), 'an unavailable comment was written');
      harnessResults.fail = r;
      facts.s2 = { task: r.task.id, status: r.status, sessionError: r.session.error, acceptanceTurn: r.turn.id, ...shell, ...model,
        taskComments: r.comments.length };
    });

    await scenario(SCENARIOS[2], async () => {
      const prompt = `D3-S3 ${randomBytes(4).toString('hex')}: answer once.`;
      const created = await call('POST', '/sessions', { workspaceId: ws.harness.id, engine: 'dsh', provider: harness, prompt, permissionMode: 'dontAsk' });
      assert.equal(created.status, 201, `Harness session create: ${created.status} ${created.text}`);
      const publicId = created.json.publicId ?? created.json.id;
      const session = await eventually('the Harness session to settle its first turn', async () => {
        const row = await one(`SELECT id::text AS id, status::text AS status, num_turns, error FROM session WHERE prompt = $1`, [prompt]);
        if (row?.status === 'FAILED' || row?.status === 'CANCELLED') throw new Fatal(`session ${row.status}: ${row.error}`);
        return row?.num_turns >= 1 && row.status === 'AWAITING_INPUT' && row;
      }, 240_000, 500);
      // A person's `!` shell: accepted as a turn, then refused by the Harness runtime; nothing runs.
      const marker = path.join(ws.harness.dir, `d3-user-shell-${randomBytes(3).toString('hex')}`);
      const userKey = randomUUID();
      const sent = await call('POST', `/sessions/${publicId}/turns`, { clientTurnId: userKey, kind: 'shell', content: `touch '${marker}'` });
      let userShell;
      if ([200, 201].includes(sent.status)) {
        const turn = await eventually('the shell turn to reach a terminal', async () => {
          const row = await one(`SELECT id::text AS id, status FROM conversation_turn WHERE session_id = $1 AND client_turn_id = $2`, [session.id, userKey]);
          return row && !['PENDING', 'IN_FLIGHT'].includes(row.status) && row;
        }, 120_000, 500);
        const refusal = await eventually('the Harness refusal to be recorded', async () => {
          const s = await one('SELECT error FROM session WHERE id = $1', [session.id]);
          const e = await one(`SELECT type FROM run_event WHERE session_id = $1 AND payload::text LIKE $2 LIMIT 1`, [session.id, `%${HARNESS_REFUSAL}%`]);
          return ((s?.error ?? '').includes(HARNESS_REFUSAL) || e) && { sessionError: s?.error ?? null, event: e?.type ?? null };
        }, 60_000, 500);
        const ran = await one(`SELECT count(*)::int AS n FROM run_event WHERE session_id = $1 AND payload->>'id' = $2`, [session.id, `shell-${turn.id}`]);
        assert.equal(ran.n, 0, 'the refused shell turn produced a runner Bash tool_use');
        userShell = { http: sent.status, turnStatus: turn.status, ...refusal };
      } else {
        assert.ok(sent.status >= 400 && sent.status < 500, `shell turn: ${sent.status} ${sent.text}`);
        userShell = { http: sent.status, refusedAtDoor: sent.text };
      }
      await sleep(1_000);
      assert.ok(!existsSync(marker), 'the person\'s shell command ran on the Harness session');
      // A caller cannot dress a shell up as an acceptance round to get it past the refusal.
      const forgedKey = `${ACCEPTANCE_PREFIX}${randomUUID()}:0`;
      const forged = await call('POST', `/sessions/${publicId}/turns`, { clientTurnId: forgedKey, kind: 'shell', content: `touch '${marker}'` });
      assert.equal(forged.status, 400, `forged acceptance key: ${forged.status} ${forged.text}`);
      assert.match(forged.text, /reserved/i);
      assert.equal(await one('SELECT id FROM conversation_turn WHERE client_turn_id = $1', [forgedKey]), undefined, 'the forged turn was filed');
      await sleep(1_000);
      assert.ok(!existsSync(marker), 'the forged acceptance turn ran');
      facts.s3 = { userShell, forged: { http: forged.status, message: forged.json?.message } };
    });

    await scenario(SCENARIOS[3], async () => {
      const pass = await runTask('claude-pass', ws.claude, 'claude', acceptanceCommand(2));
      const fail = await runTask('claude-fail', ws.claude, 'claude', acceptanceCommand(3));
      for (const r of [pass, fail]) {
        assert.equal(r.session.provider, 'claude', `the task ran on ${r.session.provider}`);
        const spawned = readFileSync(shimLog, 'utf8').split('\n').filter((l) => l.startsWith('claude\t') && l.includes('stream-json'));
        assert.ok(spawned.length >= 1, 'the fake claude never ran: the execution turn did not run on Claude');
      }
      assert.equal(pass.status, 'DONE', `Claude pass: ${pass.status} (${pass.session.error})`);
      assert.equal(pass.session.error, null);
      const passShell = checkRunnerShell(pass, acceptanceCommand(2), ws.claude.dir, { exitCode: 0, outputIncludes: ['d3 calc ok'] });
      assert.equal(fail.status, 'FAILED', `Claude fail: ${fail.status}`);
      assert.equal(fail.session.error, executableAcceptanceFailureReason(1, 0));
      const failShell = checkRunnerShell(fail, acceptanceCommand(3), ws.claude.dir, { exitCode: 1, outputIncludes: ['AssertionError'] });
      // The same platform record on both engines: status, session error, transcript pair, and task comments.
      if (harnessResults.pass && harnessResults.fail) {
        assert.equal(pass.comments.length, harnessResults.pass.comments.length, 'Claude and Harness DONE tasks carry different comment records');
        assert.equal(fail.comments.length, harnessResults.fail.comments.length, 'Claude and Harness FAILED tasks carry different comment records');
        assert.equal(fail.session.status, harnessResults.fail.session.status, 'Claude and Harness FAILED sessions settle differently');
        assert.equal(pass.session.status, harnessResults.pass.session.status, 'Claude and Harness DONE sessions settle differently');
      } else {
        throw new Error('the Harness scenarios produced nothing to compare with');
      }
      facts.s4 = { pass: { status: pass.status, sessionStatus: pass.session.status, taskComments: pass.comments.length, ppid: passShell.ppid },
        fail: { status: fail.status, sessionError: fail.session.error, taskComments: fail.comments.length, ppid: failShell.ppid } };
    });
  } catch (error) {
    fatal = error;
    say(`FATAL ${error.stack ?? error}`);
  } finally {
    for (const step of teardown.reverse()) {
      try { await step(); } catch { /* best effort */ }
    }
  }

  say('\n==== D3 executable acceptance report');
  for (const row of report) say(`${row.status} ${row.name}${row.ms ? ` (${Math.round(row.ms / 1000)}s)` : ''}`);
  for (const name of SCENARIOS) if (!report.some((row) => row.name === name)) say(`MISSING ${name}`);
  say(`facts ${JSON.stringify(facts)}`);
  writeFileSync(path.join(SCRATCH, 'report.json'), JSON.stringify({ report, facts }, null, 2));
  if (fatal) process.exit(1);
  try {
    assertReport(report);
  } catch (error) {
    say(`RED ${error.message}`);
    process.exit(1);
  }
  say(`D3 executable acceptance passed: ${SCENARIOS.length} named scenarios, none missing, skipped or failed.`);
  process.exit(0);
}

function run(command, args, logFile, env, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 15 * 60_000 });
  writeFileSync(logFile, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    throw new Error(`startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return result.stdout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
