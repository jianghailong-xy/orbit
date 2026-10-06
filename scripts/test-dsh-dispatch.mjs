// D1 acceptance: a DeepSeek Harness session created through the real apiserver (PostgreSQL) is claimed by an
// Orbit runner built from this tree and runs one turn on the pinned official dsh against a local mock model.
// Run through scripts/test-dsh-dispatch.sh, which builds what this needs and passes it in.
//
// Stack (every piece a real process): postgres:16-alpine ← `prisma migrate deploy`; apiserver `node dist/main.js`;
// two runners, each `orbit register` + `orbit run` with its own ORBIT_HOME, behind a recording link:
//   runner A ..... current: its own header passes through untouched
//   runner B ..... the same binary behind a link that can rewrite X-Orbit-Supported-Providers to the pre-D1
//                  value on every request, which is exactly what an older runner sends (its heartbeat persists
//                  capabilities from the same header)
// dsh 0.2.0-rc.2 is installed from the runner's own embedded P0 lock into each ORBIT_HOME's version directory;
// claude/codex/kimi/opencode/agy are shims that record being run and fail — no real engine, account or key.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Fatal, RunnerMachine, callApi, eventually, fileLog, freePort, lookPath, migrate, startApiserver, startPostgres } from './codex-reset-e2e/harness.mjs';

export const SCENARIOS = [
  'D1-S1 current runner declares dsh on claim, reclaim and heartbeat',
  'D1-S2 Harness session created through the API is claimed and settles one turn on pinned dsh',
  'D1-S3 runner without dsh declaration is refused at create and never claims a Harness session',
  'D1-S4 Claude dispatch is unchanged on current and legacy runners',
  'D1-S5 the same runner declaring dsh again claims the waiting Harness session',
];

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
    [...good, { name: 'D1-S9 extra', status: 'PASS' }],
  ]) assert.throws(() => assertReport(bad));
  process.stdout.write('PASS acceptance guard rejects missing, unmatched, duplicate, skipped and failed scenarios\n');
}

async function main() {
  selfTestReport();
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required: run scripts/test-dsh-dispatch.sh`);
    return value;
  };
  const REPO = required('DSH_DISPATCH_REPO');
  const SCRATCH = required('DSH_DISPATCH_SCRATCH');
  const RUNNER_BINARY = required('DSH_DISPATCH_RUNNER_BINARY');
  const PRISMA = required('DSH_DISPATCH_PRISMA');
  const PG_NAME = required('DSH_DISPATCH_PG_NAME');
  const API = path.join(REPO, 'src/apiserver');
  const requireFromApi = createRequire(path.join(API, 'package.json'));
  const pg = requireFromApi('pg');
  const shared = requireFromApi(path.join(REPO, 'src/shared/dist/index.js'));
  const { DSH_RUNNER_UPGRADE_ERROR } = requireFromApi(path.join(API, 'dist/runner-api/runner-provider-support.js'));
  assert.ok(DSH_RUNNER_UPGRADE_ERROR, 'the apiserver build exports no DSH_RUNNER_UPGRADE_ERROR');
  const LEGACY_PROVIDERS = 'claude,codex,opencode,antigravity';
  const DSH_VERSION = '0.2.0-rc.2';
  const MOCK_KEY = `sk-d1-synthetic-${randomBytes(6).toString('hex')}`;
  const MOCK_ANSWER = 'D1 dispatch answer from the mock model';

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
    say('==> apiserver (node dist/main.js)');
    const api = await startApiserver({
      apiDir: API, node: process.execPath, port: await freePort(), log: log.api,
      env: { ...baseEnv, DATABASE_URL: database.url, JWT_SECRET: randomBytes(32).toString('hex'),
        PROVIDER_SECRET_KEY: randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://127.0.0.1',
        MODEL_CATALOG_URL: 'http://127.0.0.1:9/models.json', NO_COLOR: '1' },
    });
    teardown.push(() => api.stop());
    const owner = await callApi(api.origin, 'POST', '/auth/bootstrap',
      { body: { email: 'd1-owner@example.invalid', name: 'D1 Owner', password: randomBytes(18).toString('base64url') } });
    assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
    const token = owner.json.accessToken;
    const call = (method, route, body) => callApi(api.origin, method, route, { token, body });

    // ── the runners ─────────────────────────────────────────────────────────────────────────────
    const runners = {};
    for (const name of ['A', 'B']) {
      const root = path.join(SCRATCH, `runner-${name}`);
      const shims = path.join(root, 'shim-bin');
      const shimLog = path.join(root, 'engine-shims.log');
      mkdirSync(shims, { recursive: true });
      writeFileSync(shimLog, '');
      for (const engine of ['claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh']) {
        writeFileSync(path.join(shims, engine), `#!/bin/sh
if [ "$1" = "--version" ] && [ "${engine}" = "claude" ]; then echo "2.1.200 (Claude Code)"; exit 0; fi
printf '%s\\t%s\\t%s\\n' "${engine}" "\${ORBIT_SESSION_ID:-}" "$*" >> '${shimLog}'
echo "test-dsh-dispatch: ${engine} is a recording shim here, not an engine" >&2
exit 97
`);
        chmodSync(path.join(shims, engine), 0o755);
      }
      const link = new ProviderLink(api.origin, LEGACY_PROVIDERS);
      await link.listen();
      teardown.push(() => link.close());
      const machine = new RunnerMachine({ binary: RUNNER_BINARY, root, searchPath: `${shims}:/usr/local/bin:/usr/bin:/bin`, log: fileLog(path.join(logs, `runner-${name}.log`)) });
      const versionDir = path.join(machine.orbitHome, 'engines', 'dsh', DSH_VERSION);
      mkdirSync(path.dirname(versionDir), { recursive: true });
      cpSync(install, versionDir, { recursive: true, verbatimSymlinks: true });
      const enrollment = await call('POST', '/runners/enrollment-tokens', { label: `d1-${name}`, ttlHours: 6 });
      assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
      say(`==> orbit register (runner ${name})`);
      await machine.register({ server: link.origin, token: enrollment.json.token, name: `d1-runner-${name}` });
      const row = await one('SELECT id::text AS id FROM runner WHERE name = $1', [`d1-runner-${name}`]);
      assert.ok(row, `orbit register created no runner ${name}`);
      runners[name] = { name, root, link, machine, shimLog, versionDir, uuid: row.id, publicId: shared.uuidToBase62(row.id),
        started: false };
      teardown.push(() => machine.stop());
    }
    const startRunner = async (r) => {
      r.machine.start();
      r.started = true;
      await sleep(2_000);
      assert.ok(r.machine.alive(), `orbit run (runner ${r.name}) exited at start`);
    };
    const kill = async (r) => {
      r.machine.child.kill('SIGKILL');
      await r.machine.exited;
    };
    const capabilities = async (r) => one('SELECT capabilities, capabilities_reported_at AS at, status FROM runner WHERE id = $1', [r.uuid]);
    const workspace = async (r, label, env) => {
      const dir = path.join(r.root, 'work', label);
      mkdirSync(dir, { recursive: true });
      const created = await call('POST', '/workspaces', { name: `D1 ${r.name} ${label}`, runnerId: r.publicId, workDir: dir });
      assert.equal(created.status, 201, `workspace: ${created.text}`);
      const id = created.json.publicId ?? created.json.id;
      if (env) {
        const patched = await call('PATCH', `/workspaces/${id}`, { env });
        assert.equal(patched.status, 200, `workspace env: ${patched.text}`);
      }
      return { id, dir };
    };
    const claudeEnv = { ANTHROPIC_API_KEY: 'sk-ant-d1-recording-shim-only' };
    const ws = {
      dshA: await workspace(runners.A, 'harness'), claudeA: await workspace(runners.A, 'claude', claudeEnv),
      dshB: await workspace(runners.B, 'harness'), claudeB: await workspace(runners.B, 'claude', claudeEnv),
    };
    const provider = await call('POST', '/providers/mine', { label: 'D1 Harness mock', runtime: 'dsh', baseUrl: mockURL, apiKey: MOCK_KEY, models: [] });
    assert.equal(provider.status, 201, `dsh provider: ${provider.text}`);
    const harness = provider.json.slug;
    assert.ok(harness, `dsh provider has no slug: ${provider.text}`);
    say(`==> provider ${harness} (runtime dsh) → ${mockURL}`);
    const createSession = (workspaceId, providerSlug, prompt, extra = {}) =>
      call('POST', '/sessions', { workspaceId, provider: providerSlug, prompt, ...extra });
    const sessionRow = (prompt) => one(`SELECT id::text AS id, status::text AS status, num_turns, result, error, runtime_session_id,
      assigned_runner_id::text AS runner, finished_at, end_reason::text AS end_reason FROM session WHERE prompt = $1`, [prompt]);
    const answerEvents = (id, runner) => one(`SELECT count(*)::int AS n, array_agg(DISTINCT type) AS types FROM run_event
      WHERE session_id = $1 AND ingested_by_runner_id = $2 AND payload::text LIKE $3`, [id, runner, `%${MOCK_ANSWER}%`]);
    const shimRuns = (r) => readFileSync(r.shimLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [engine, session, args] = line.split('\t');
      return { engine, session, args };
    });
    const dshProcesses = (r) => listProcesses().filter((p) => p.cmdline.some((arg) => arg.startsWith(`${r.versionDir}/`)) && p.cmdline.includes('--profile'));

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

    const s2Prompt = `D1-S2 ${randomBytes(4).toString('hex')}: answer once.`;
    await scenario(SCENARIOS[0], async () => {
      const A = runners.A;
      await startRunner(A);
      assert.equal(lookPath(A.machine.effectivePath(), 'claude'), path.join(A.root, 'shim-bin', 'claude'), 'runner A would run a real claude');
      const seen = await eventually('runner A to heartbeat, reclaim and claim', () => {
        const routes = new Set(A.link.exchanges.filter((e) => e.status === 200 || e.status === 201).map((e) => e.route));
        return ['heartbeat', 'reclaim', 'claim'].every((route) => routes.has(route)) && A.link.exchanges;
      }, 90_000);
      for (const route of ['heartbeat', 'reclaim', 'claim']) {
        for (const exchange of seen.filter((e) => e.route === route)) {
          assert.ok(names(exchange.sent).includes('dsh'), `runner A ${route} header ${exchange.sent} omits dsh`);
          assert.equal(exchange.forwarded, exchange.sent, 'runner A link must not rewrite the header');
        }
      }
      const row = await eventually('runner A capabilities to persist provider:dsh', async () => {
        const current = await capabilities(A);
        return current?.at && current.capabilities.includes('provider:dsh') && current;
      }, 60_000);
      for (const capability of ['provider:claude', 'provider:codex', 'provider:opencode', 'provider:antigravity']) {
        assert.ok(row.capabilities.includes(capability), `runner A capabilities lost ${capability}: ${row.capabilities}`);
      }
      facts.runnerAHeader = seen.find((e) => e.route === 'claim').sent;
      facts.runnerACapabilities = row.capabilities;
    });

    await scenario(SCENARIOS[1], async () => {
      const A = runners.A;
      const created = await createSession(ws.dshA.id, harness, s2Prompt, { permissionMode: 'dontAsk' });
      assert.equal(created.status, 201, `Harness session create: ${created.status} ${created.text}`);
      const publicId = created.json.publicId ?? created.json.id;
      const settled = await eventually('the Harness turn to settle', async () => {
        const row = await sessionRow(s2Prompt);
        if (row?.status === 'FAILED' || row?.status === 'CANCELLED') throw new Fatal(`session ${row.status}: ${row.error}`);
        return row?.num_turns >= 1 && row.status === 'AWAITING_INPUT' && row;
      }, 240_000, 500);
      assert.equal(settled.runner, A.uuid, 'the Harness session was not claimed by runner A');
      const answer = await answerEvents(settled.id, A.uuid);
      assert.ok(answer.n > 0, 'runner A ingested no event carrying the mock model answer');
      assert.equal(settled.error, null, `the settled session carries an error: ${settled.error}`);
      assert.ok(settled.runtime_session_id, 'no ACP session id persisted');
      const init = await one(`SELECT payload->>'sessionId' AS acp, payload->>'cliVersion' AS version FROM run_event
        WHERE session_id = $1 AND type = 'system' AND payload->>'subtype' = 'init' AND payload->>'provider' = 'dsh'`, [settled.id]);
      assert.equal(init?.acp, settled.runtime_session_id, 'the persisted ACP session id is not the one dsh reported');
      assert.equal(init.version, DSH_VERSION, 'the runner reported another dsh version');
      // The turn ran on the pinned dsh: the model heard the prompt, keyed by the configured provider.
      const heard = modelRequests().filter((r) => r.accepted && (r.lastUser ?? '').includes(s2Prompt));
      assert.ok(heard.length >= 1, 'the mock model never received the session prompt');
      assert.ok(modelRequests().every((r) => r.keyMatched), 'a model request carried another key');
      // The runner's launch record: the per-session dsh home it prepared, and the process it started there.
      const home = path.join(A.machine.orbitHome, 'dsh-sessions', settled.id);
      const ownerFile = JSON.parse(readFileSync(path.join(home, 'orbit-owner.json'), 'utf8'));
      assert.equal(ownerFile.version, DSH_VERSION, 'the session home names another dsh version');
      assert.equal(ownerFile.cwd, realpathSync(ws.dshA.dir), 'dsh ran outside the session workspace');
      assert.ok([settled.id, publicId].includes(ownerFile.sessionId) || ownerFile.sessionId === settled.id.toLowerCase(),
        `the session home belongs to ${ownerFile.sessionId}`);
      const live = dshProcesses(A).filter((p) => p.env.DSH_HOME === home);
      assert.equal(live.length, 1, `expected one resident dsh for the session, found ${live.length}; home ${home} holds ` +
        `${readdirSync(home).join(',')}; dsh-like processes: ${JSON.stringify(listProcesses().filter((p) => p.cmdline.join(' ').includes('dsh'))
          .map((p) => ({ pid: p.pid, cmdline: p.cmdline, DSH_HOME: p.env.DSH_HOME, parent: parentOf(p.pid) })))}; runner pid ${A.machine.child.pid}`);
      assert.ok(live[0].cmdline.includes('acp'), `dsh was not started in its ACP profile: ${live[0].cmdline.join(' ')}`);
      assert.ok(isDescendant(live[0].pid, A.machine.child.pid), 'the resident dsh is not a child of runner A');
      assert.equal(live[0].env.ORBIT_DSH_API_KEY, MOCK_KEY, 'dsh did not receive the configured provider key');
      const events = await one('SELECT count(*)::int AS n FROM run_event WHERE session_id = $1 AND ingested_by_runner_id = $2', [settled.id, A.uuid]);
      assert.ok(events.n > 0, 'runner A ingested no run events for the session');
      const turn = await one(`SELECT status FROM conversation_turn WHERE session_id = $1 AND kind = 'message' ORDER BY seq LIMIT 1`, [settled.id]);
      assert.equal(turn?.status, 'ANSWERED', `the first turn settled ${turn?.status}`);
      // End the session: the resident dsh stops, the session settles terminal and keeps its ACP id. An owner's end is
      // CANCELLED with endReason `ended` for every engine (SessionsService.transitionEnd).
      const ended = await call('POST', `/sessions/${publicId}/end`);
      assert.ok([200, 201].includes(ended.status), `end: ${ended.status} ${ended.text}`);
      const final = await eventually('the ended Harness session to settle', async () => {
        const row = await sessionRow(s2Prompt);
        return row?.finished_at && ['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(row.status) && row;
      }, 120_000, 500);
      assert.equal(final.status, 'CANCELLED', `the ended session settled ${final.status}: ${final.error}`);
      assert.equal(final.end_reason, 'ended', `the ended session carries endReason ${final.end_reason}`);
      assert.equal(final.error, null, `the ended session carries an error: ${final.error}`);
      assert.equal(final.runtime_session_id, settled.runtime_session_id, 'the ACP session id changed at the end');
      await eventually('the resident dsh to exit', () => dshProcesses(A).filter((p) => p.env.DSH_HOME === home).length === 0, 30_000);
      assert.equal(shimRuns(A).filter((r) => r.engine === 'dsh').length, 0, 'something ran a dsh other than the pinned install');
      Object.assign(facts, { s2: { status: final.status, endReason: final.end_reason, answerEvents: answer, numTurns: settled.num_turns, runtimeSessionId: settled.runtime_session_id,
        dshPid: live[0].pid, dshHome: home, runEvents: events.n, conversationTurnStatus: turn.status, modelRequests: heard.length } });
    });

    const s3Waiting = `D1-S3 ${randomBytes(4).toString('hex')}: waits for a runner that declares dsh.`;
    await scenario(SCENARIOS[2], async () => {
      const B = runners.B;
      // B first runs as a current runner and is stopped hard (no deregister), as a machine is before a downgrade.
      await startRunner(B);
      await eventually('runner B to persist provider:dsh', async () => (await capabilities(B))?.capabilities.includes('provider:dsh'), 60_000);
      await kill(B);
      await eventually('runner B claims in flight to settle', () => B.link.inflight === 0, 60_000);
      const waiting = await createSession(ws.dshB.id, harness, s3Waiting, { permissionMode: 'dontAsk' });
      assert.equal(waiting.status, 201, `create while B last declared dsh: ${waiting.status} ${waiting.text}`);
      // The same machine now runs a runner that does not name dsh.
      B.link.mode = 'legacy';
      const legacyFrom = B.link.exchanges.length;
      await startRunner(B);
      const legacy = await eventually('the legacy runner to heartbeat and finish two claims', async () => {
        const after = B.link.exchanges.slice(legacyFrom);
        const beat = after.findIndex((e) => e.route === 'heartbeat' && e.status < 300);
        const row = await capabilities(B);
        return beat >= 0 && after.slice(beat + 1).filter((e) => e.route === 'claim' && e.status < 300).length >= 2 &&
          row.at && !row.capabilities.includes('provider:dsh') && { after, row };
      }, 150_000, 500);
      for (const exchange of legacy.after) {
        assert.equal(exchange.forwarded, LEGACY_PROVIDERS, `the legacy link forwarded ${exchange.forwarded}`);
        assert.ok(!exchange.body.includes(waitingId(waiting)), `the legacy runner was handed the Harness session on ${exchange.route}`);
      }
      assert.ok(legacy.row.capabilities.includes('provider:claude'), 'the legacy heartbeat lost provider:claude');
      const stalled = await eventually('the waiting session to carry the upgrade notice', async () => {
        const row = await sessionRow(s3Waiting);
        return row?.error === DSH_RUNNER_UPGRADE_ERROR && row;
      }, 60_000, 500);
      assert.equal(stalled.status, 'PENDING', `the Harness session left PENDING on a legacy runner: ${stalled.status}`);
      assert.equal(stalled.num_turns, 0, 'the legacy runner ran a Harness turn');
      assert.equal(stalled.runtime_session_id, null, 'the legacy runner started a runtime');
      assert.equal(dshProcesses(B).length, 0, 'a dsh process runs under the legacy runner');
      assert.ok(!modelRequests().some((r) => (r.lastUser ?? '').includes(s3Waiting)), 'the model heard the waiting session');
      assert.equal(shimRuns(B).filter((r) => r.session === waitingId(waiting)).length, 0, 'the legacy runner ran an engine for the Harness session');
      // And creating one against it now is refused with the upgrade action.
      const refusedPrompt = `D1-S3 refused ${randomBytes(4).toString('hex')}`;
      const refused = await createSession(ws.dshB.id, harness, refusedPrompt, { permissionMode: 'dontAsk' });
      assert.equal(refused.status, 409, `create on the legacy runner: ${refused.status} ${refused.text}`);
      assert.equal(refused.json?.message, DSH_RUNNER_UPGRADE_ERROR, `refusal message: ${refused.text}`);
      assert.equal(await sessionRow(refusedPrompt), undefined, 'a refused create left a session row');
      const builtin = await createSession(ws.dshB.id, 'dsh', `${refusedPrompt} builtin`, { permissionMode: 'dontAsk' });
      assert.equal(builtin.status, 409, `built-in dsh create on the legacy runner: ${builtin.status} ${builtin.text}`);
      Object.assign(facts, { s3: { legacyCapabilities: legacy.row.capabilities, waitingError: stalled.error, refusal: refused.json.message,
        builtinRefusal: builtin.json?.message, legacyClaims: legacy.after.filter((e) => e.route === 'claim').length } });
    });

    await scenario(SCENARIOS[3], async () => {
      const claims = {};
      for (const [r, wsKey] of [[runners.A, 'claudeA'], [runners.B, 'claudeB']]) {
        assert.ok(r.machine.alive(), `runner ${r.name} is not running`);
        assert.equal(lookPath(r.machine.effectivePath(), 'claude'), path.join(r.root, 'shim-bin', 'claude'), `runner ${r.name} would run a real claude`);
        const prompt = `D1-S4 ${r.name} ${randomBytes(4).toString('hex')}`;
        const created = await createSession(ws[wsKey].id, 'claude', prompt);
        assert.equal(created.status, 201, `Claude create on runner ${r.name}: ${created.status} ${created.text}`);
        const publicId = created.json.publicId ?? created.json.id;
        const launch = await eventually(`runner ${r.name} to launch claude for its session`,
          () => shimRuns(r).find((run) => run.engine === 'claude' && run.session === publicId), 120_000, 500);
        const row = await sessionRow(prompt);
        assert.equal(row.runner, r.uuid, `the Claude session on ${r.name} was claimed elsewhere`);
        assert.ok(launch.args.includes('stream-json'), `claude was not launched as a session engine: ${launch.args}`);
        assert.equal(shimRuns(r).filter((run) => run.session === publicId && run.engine !== 'claude').length, 0, 'another engine ran the Claude session');
        assert.equal(dshProcesses(r).filter((p) => (p.env.DSH_HOME ?? '').endsWith(row.id)).length, 0, 'dsh ran the Claude session');
        claims[r.name] = { header: r.link.mode === 'legacy' ? LEGACY_PROVIDERS : 'current', args: launch.args.slice(0, 160) };
      }
      facts.s4 = claims;
    });

    await scenario(SCENARIOS[4], async () => {
      const B = runners.B;
      await B.machine.stop();
      B.link.mode = 'current';
      await startRunner(B);
      const settled = await eventually('the waiting Harness session to run on the upgraded runner', async () => {
        const row = await sessionRow(s3Waiting);
        if (row?.status === 'FAILED' || row?.status === 'CANCELLED') throw new Fatal(`session ${row.status}: ${row.error}`);
        return row?.num_turns >= 1 && row.status === 'AWAITING_INPUT' && row;
      }, 240_000, 500);
      assert.equal(settled.runner, B.uuid, 'the waiting session ran elsewhere');
      const answer = await answerEvents(settled.id, B.uuid);
      assert.ok(answer.n > 0, 'runner B ingested no event carrying the mock model answer');
      assert.equal(settled.error, null, `the upgrade notice survived the claim: ${settled.error}`);
      assert.ok(settled.runtime_session_id, 'no ACP session id persisted');
      assert.ok(modelRequests().some((r) => r.accepted && (r.lastUser ?? '').includes(s3Waiting)), 'the model never heard the waiting session');
      facts.s5 = { status: settled.status, answerEvents: answer, runtimeSessionId: settled.runtime_session_id };
    });
  } catch (error) {
    fatal = error;
    say(`FATAL ${error.stack ?? error}`);
  } finally {
    for (const step of teardown.reverse()) {
      try { await step(); } catch { /* best effort */ }
    }
  }

  say('\n==== D1 dispatch report');
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
  say(`D1 dispatch acceptance passed: ${SCENARIOS.length} named scenarios, none missing, skipped or failed.`);
  process.exit(0);
}

function waitingId(created) {
  return created.json?.publicId ?? created.json?.id ?? '\u0000no-id';
}

function names(header) {
  return String(header ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
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

function listProcesses() {
  const out = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const env = Object.fromEntries(readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      out.push({ pid: Number(entry), cmdline: cmdline.concat(exePath(entry)), env });
    } catch { /* exited or not ours */ }
  }
  return out;
}

function exePath(pid) {
  try { return [readlinkSync(`/proc/${pid}/exe`)]; } catch { return []; }
}

function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return 0;
  }
}

function isDescendant(pid, ancestor) {
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops += 1) {
    if (current === ancestor) return true;
    current = parentOf(current);
  }
  return false;
}

/**
 * Everything one runner says to the apiserver passes through here. In `legacy` mode it sends the
 * pre-D1 provider header on every request, as an older runner does. Heartbeat, claim and reclaim are
 * read whole and recorded with what the runner sent, what was forwarded and what came back.
 */
class ProviderLink {
  constructor(upstream, legacyProviders) {
    this.upstream = upstream;
    this.legacyProviders = legacyProviders;
    this.mode = 'current';
    this.exchanges = [];
    this.inflight = 0;
  }

  async listen() {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
  }

  close() {
    this.server?.closeAllConnections();
    this.server?.close();
  }

  handle(req, res) {
    const url = req.url ?? '/';
    const route = /\/runner\/heartbeat(\?|$)/.test(url) ? 'heartbeat'
      : /\/runner\/sessions\/claim(\?|$)/.test(url) ? 'claim'
        : /\/runner\/sessions\/reclaim(\?|$)/.test(url) ? 'reclaim' : null;
    const sent = req.headers['x-orbit-supported-providers'];
    const headers = { ...req.headers, host: new URL(this.upstream).host };
    delete headers.connection;
    if (this.mode === 'legacy') headers['x-orbit-supported-providers'] = this.legacyProviders;
    const target = new URL(url, this.upstream);
    const exchange = route ? { route, mode: this.mode, sent, forwarded: headers['x-orbit-supported-providers'], status: 0, body: '' } : null;
    if (exchange) this.inflight += 1;
    let settled = false;
    const settle = () => {
      if (exchange && !settled) {
        settled = true;
        this.inflight -= 1;
        this.exchanges.push(exchange);
      }
    };
    const outgoing = httpRequest(target, { method: req.method, headers, agent: false }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      if (!exchange) {
        response.pipe(res);
        return;
      }
      exchange.status = response.statusCode ?? 0;
      const chunks = [];
      response.on('data', (chunk) => { chunks.push(chunk); res.write(chunk); });
      response.on('end', () => { exchange.body = Buffer.concat(chunks).toString('utf8'); settle(); res.end(); });
      response.on('error', () => { settle(); res.destroy(); });
    });
    outgoing.on('error', () => { settle(); res.destroy(); });
    outgoing.on('close', settle);
    req.pipe(outgoing);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
