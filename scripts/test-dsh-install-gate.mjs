// F-P7-1 acceptance: an upgraded runner declares dsh before the pinned CLI is installed. The server reads the runner's
// engine report: creating or resuming a Harness session there is refused with the not-installed notice, and a persisted
// session's follow-up waits PENDING with it, never claimed and failed with the runner's DSH_NOT_INSTALLED. After the
// install through Orbit, the same sessions and a new one run. Run through scripts/test-dsh-install-gate.sh.
//
// Stack (every piece a real process): postgres:16-alpine ← `prisma migrate deploy`; apiserver `node dist/main.js`; one
// runner built from this tree (`orbit register --no-auto-install-engines` + `orbit run`, its own ORBIT_HOME).
//   phase 0 ..... dsh 0.2.0-rc.2 sits in the runner's version directory (`npm ci` of the runner's embedded P0 lock):
//                 two Harness sessions run one turn each against a local mock model; one is ended
//   phase 1 ..... the runner stops, the version directory goes, the runner starts again: the same binary, declaring
//                 dsh, with nothing installed — what an upgraded runner is before anyone installs
//   phase 2 ..... `POST /runners/:id/install {engine: dsh}`: the runner's own install relay runs `npm ci` from its
//                 embedded lock into a staging directory and publishes it (its npm cache seeded from the one above)
// claude/codex/kimi/opencode/agy/dsh on PATH are shims that record being run and fail — no real engine, account or key.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Fatal, RunnerMachine, callApi, eventually, fileLog, freePort, lookPath, migrate, startApiserver, startPostgres } from './codex-reset-e2e/harness.mjs';

export const SCENARIOS = [
  'IG-S1 an upgraded runner without the pinned dsh keeps declaring it and reports it not installed',
  'IG-S2 creating a Harness session there through the API is refused with the not-installed notice and leaves no session',
  "IG-S3 a persisted Harness session's follow-up waits with the notice and is never claimed or failed while Claude work still runs",
  'IG-S4 resuming an ended Harness session there is refused with the same notice and leaves it as it was',
  "IG-S5 after the install through Orbit the same session's waiting follow-up runs on its persisted dsh conversation",
  'IG-S6 after the install the ended session resumes and a new Harness session runs',
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
    good.map((row, i) => (i === 4 ? { ...row, name: `${row.name} (renamed)` } : row)),
    [...good, { name: 'IG-S9 extra', status: 'PASS' }],
  ]) assert.throws(() => assertReport(bad));
  process.stdout.write('PASS acceptance guard rejects missing, unmatched, duplicate, skipped and failed scenarios\n');
}

async function main() {
  selfTestReport();
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required: run scripts/test-dsh-install-gate.sh`);
    return value;
  };
  const REPO = required('DSH_INSTALL_GATE_REPO');
  const SCRATCH = required('DSH_INSTALL_GATE_SCRATCH');
  const RUNNER_BINARY = required('DSH_INSTALL_GATE_RUNNER_BINARY');
  const PRISMA = required('DSH_INSTALL_GATE_PRISMA');
  const PG_NAME = required('DSH_INSTALL_GATE_PG_NAME');
  const API = path.join(REPO, 'src/apiserver');
  const requireFromApi = createRequire(path.join(API, 'package.json'));
  const pg = requireFromApi('pg');
  const shared = requireFromApi(path.join(REPO, 'src/shared/dist/index.js'));
  const { DSH_NOT_INSTALLED_ERROR, DSH_RUNNER_UPGRADE_ERROR } = requireFromApi(path.join(API, 'dist/runner-api/runner-provider-support.js'));
  assert.ok(DSH_NOT_INSTALLED_ERROR && DSH_RUNNER_UPGRADE_ERROR, 'the apiserver build exports no dsh notices');
  const DSH_VERSION = '0.2.0-rc.2';
  const MOCK_KEY = `sk-ig-synthetic-${randomBytes(6).toString('hex')}`;
  const MOCK_ANSWER = 'IG answer from the mock model';

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
    const npmCache = path.join(SCRATCH, 'npm-cache');
    mkdirSync(install, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) cpSync(path.join(lockDir, file), path.join(install, file));
    say(`==> npm ci of the runner's embedded dsh ${DSH_VERSION} lock`);
    run('npm', ['ci', '--prefix', install, '--cache', npmCache, '--no-audit', '--no-fund'], path.join(logs, 'npm.log'),
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
    const modelHeard = (prompt) => modelRequests().filter((r) => r.accepted && (r.lastUser ?? '').includes(prompt)).length;
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
      { body: { email: 'ig-owner@example.invalid', name: 'IG Owner', password: randomBytes(18).toString('base64url') } });
    assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
    const token = owner.json.accessToken;
    const call = (method, route, body) => callApi(api.origin, method, route, { token, body });

    // ── the runner ──────────────────────────────────────────────────────────────────────────────
    const root = path.join(SCRATCH, 'runner');
    const shims = path.join(root, 'shim-bin');
    const shimLog = path.join(root, 'engine-shims.log');
    mkdirSync(shims, { recursive: true });
    writeFileSync(shimLog, '');
    for (const engine of ['claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh']) {
      writeFileSync(path.join(shims, engine), `#!/bin/sh
if [ "$1" = "--version" ] && [ "${engine}" = "claude" ]; then echo "2.1.200 (Claude Code)"; exit 0; fi
printf '%s\\t%s\\t%s\\n' "${engine}" "\${ORBIT_SESSION_ID:-}" "$*" >> '${shimLog}'
echo "test-dsh-install-gate: ${engine} is a recording shim here, not an engine" >&2
exit 97
`);
      chmodSync(path.join(shims, engine), 0o755);
    }
    const machine = new RunnerMachine({ binary: RUNNER_BINARY, root, searchPath: `${shims}:/usr/local/bin:/usr/bin:/bin`, log: fileLog(path.join(logs, 'runner.log')) });
    teardown.push(() => machine.stop());
    const versionDir = path.join(machine.orbitHome, 'engines', 'dsh', DSH_VERSION);
    const aside = path.join(SCRATCH, 'removed-install', DSH_VERSION);
    mkdirSync(path.dirname(versionDir), { recursive: true });
    cpSync(install, versionDir, { recursive: true, verbatimSymlinks: true });
    const enrollment = await call('POST', '/runners/enrollment-tokens', { label: 'ig-runner', ttlHours: 6 });
    assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);
    say('==> orbit register --no-auto-install-engines');
    await machine.register({ server: api.origin, token: enrollment.json.token, name: 'ig-runner' });
    const runnerUuid = (await one('SELECT id::text AS id FROM runner WHERE name = $1', ['ig-runner']))?.id;
    assert.ok(runnerUuid, 'orbit register created no runner');
    const runnerPublicId = shared.uuidToBase62(runnerUuid);
    // Instants compared across columns are read as epoch ms in SQL: run_claimed_at is TIMESTAMP(3) (UTC wall time) and
    // capabilities_reported_at TIMESTAMPTZ, which node-postgres would otherwise parse in two different zones.
    const runnerRow = () => one(`SELECT capabilities, capabilities_reported_at AS at, extract(epoch FROM capabilities_reported_at)::float8 * 1000 AS at_ms,
      engines, status::text AS status, install_status, install_message FROM runner WHERE id = $1`, [runnerUuid]);
    const dshReport = (row) => (Array.isArray(row?.engines) ? row.engines : []).find((engine) => engine.engine === 'dsh');
    const start = async () => {
      machine.start();
      await sleep(2_000);
      assert.ok(machine.alive(), 'orbit run exited at start');
    };

    const workspace = async (label, env) => {
      const dir = path.join(root, 'work', label);
      mkdirSync(dir, { recursive: true });
      const created = await call('POST', '/workspaces', { name: `IG ${label}`, runnerId: runnerPublicId, workDir: dir });
      assert.equal(created.status, 201, `workspace: ${created.text}`);
      const id = created.json.publicId ?? created.json.id;
      if (env) {
        const patched = await call('PATCH', `/workspaces/${id}`, { env });
        assert.equal(patched.status, 200, `workspace env: ${patched.text}`);
      }
      return { id, dir };
    };
    const ws = { harness: await workspace('harness'), claude: await workspace('claude', { ANTHROPIC_API_KEY: 'sk-ant-ig-recording-shim-only' }) };
    const provider = await call('POST', '/providers/mine', { label: 'IG Harness mock', runtime: 'dsh', baseUrl: mockURL, apiKey: MOCK_KEY, models: [] });
    assert.equal(provider.status, 201, `dsh provider: ${provider.text}`);
    const harness = provider.json.slug;
    // An older client's Harness form is stored as a DeepSeek key (docs/provider-engine-contract.md §3.6),
    // which runs on Claude Code unless DeepSeek Harness is named as the engine.
    say(`==> provider ${harness} (a DeepSeek key, run on DeepSeek Harness) → ${mockURL}`);

    const createSession = (workspaceId, providerSlug, prompt) =>
      call('POST', '/sessions', { workspaceId, provider: providerSlug, ...(providerSlug === harness ? { engine: 'dsh' } : {}), prompt, permissionMode: 'dontAsk' });
    const publicIdOf = (created) => created.json?.publicId ?? created.json?.id;
    const sessionRow = (uuid) => one(`SELECT id::text AS id, status::text AS status, num_turns, error, runtime_session_id,
      assigned_runner_id::text AS runner, finished_at, end_reason::text AS end_reason,
      extract(epoch FROM run_claimed_at)::float8 * 1000 AS claimed_ms FROM session WHERE id = $1`, [uuid]);
    const uuidOf = async (prompt) => (await one('SELECT id::text AS id FROM session WHERE prompt = $1', [prompt]))?.id;
    const settled = (what, uuid, turns, timeoutMs = 240_000) => eventually(what, async () => {
      const row = await sessionRow(uuid);
      if (row?.status === 'FAILED') throw new Fatal(`session FAILED: ${row.error}`);
      return row?.num_turns >= turns && row.status === 'AWAITING_INPUT' && row;
    }, timeoutMs, 500);
    const turnStatuses = async (uuid) => (await sql.query(`SELECT content, status FROM conversation_turn WHERE session_id = $1 AND kind = 'message'
      ORDER BY seq`, [uuid])).rows;
    const shimRuns = () => readFileSync(shimLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [engine, session, args] = line.split('\t');
      return { engine, session, args };
    });
    const dshProcesses = () => listProcesses().filter((p) => p.cmdline.some((arg) => arg.startsWith(`${versionDir}/`)) && p.cmdline.includes('--profile'));
    const dshHomeOf = (uuid) => path.join(machine.orbitHome, 'dsh-sessions', uuid);

    // ── phase 0: installed; two Harness sessions with a turn each ─────────────────────────────
    say('\n==== phase 0: dsh installed');
    await start();
    assert.equal(lookPath(machine.effectivePath(), 'claude'), path.join(shims, 'claude'), 'the runner would run a real claude');
    await eventually('the runner to report dsh installed', async () => {
      const row = await runnerRow();
      const dsh = dshReport(row);
      return row?.at && row.capabilities.includes('provider:dsh') && dsh?.installed === true && dsh.dsh?.versionCompatible === true;
    }, 120_000, 500);
    const prompts = { followUp: `IG-S1 ${randomBytes(4).toString('hex')}: answer once.`, ended: `IG-S2 ${randomBytes(4).toString('hex')}: answer once.` };
    for (const prompt of Object.values(prompts)) {
      const created = await createSession(ws.harness.id, harness, prompt);
      assert.equal(created.status, 201, `phase 0 Harness create: ${created.status} ${created.text}`);
    }
    const followUp = { uuid: await uuidOf(prompts.followUp) };
    const ended = { uuid: await uuidOf(prompts.ended) };
    for (const s of [followUp, ended]) {
      const row = await settled('a phase 0 Harness turn to settle', s.uuid, 1);
      assert.ok(row.runtime_session_id, 'no ACP session id persisted');
      Object.assign(s, { publicId: shared.uuidToBase62(s.uuid), runtimeSessionId: row.runtime_session_id, claimedMs: row.claimed_ms });
    }
    const end = await call('POST', `/sessions/${ended.publicId}/end`);
    assert.ok([200, 201].includes(end.status), `end: ${end.status} ${end.text}`);
    await eventually('the ended session to settle', async () => {
      const row = await sessionRow(ended.uuid);
      return row?.finished_at && row.status === 'CANCELLED' && row.end_reason === 'ended';
    }, 120_000, 500);
    facts.phase0 = { followUp: { runtimeSessionId: followUp.runtimeSessionId }, ended: { runtimeSessionId: ended.runtimeSessionId },
      modelRequests: modelRequests().length };

    // ── phase 1: the same binary, nothing installed ─────────────────────────────────────────────
    say('\n==== phase 1: upgraded runner, dsh not installed');
    await machine.stop();
    await eventually('the resident dsh processes to exit', () => dshProcesses().length === 0, 60_000);
    mkdirSync(path.dirname(aside), { recursive: true });
    renameSync(versionDir, aside);
    assert.ok(!existsSync(versionDir), 'the version directory is still there');
    const restartedAt = new Date();
    let notInstalledReportedAt = null;
    await start();

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

    await scenario(SCENARIOS[0], async () => {
      const row = await eventually('the restarted runner to report its engines', async () => {
        const current = await runnerRow();
        return current?.at > restartedAt && dshReport(current)?.installed === false && current;
      }, 120_000, 500);
      for (const capability of ['provider:dsh', 'provider:claude', 'provider:codex', 'provider:opencode', 'provider:antigravity']) {
        assert.ok(row.capabilities.includes(capability), `the restarted runner does not declare ${capability}: ${row.capabilities}`);
      }
      const dsh = dshReport(row);
      assert.equal(dsh.installationError, 'DSH_NOT_INSTALLED', `dsh report: ${JSON.stringify(dsh)}`);
      notInstalledReportedAt = row.at;
      // Reclaim handed the persisted session back without starting anything: it is still idle, not failed.
      const idle = await sessionRow(followUp.uuid);
      assert.equal(idle.status, 'AWAITING_INPUT', `the persisted session after the restart: ${idle.status} ${idle.error}`);
      assert.equal(dshProcesses().length, 0, 'a dsh process runs without an install');
      facts.s1 = { capabilities: row.capabilities, dsh };
    });

    await scenario(SCENARIOS[1], async () => {
      const refusals = {};
      for (const [label, slug] of [['configured', harness], ['builtin', 'dsh']]) {
        const prompt = `IG-S2 refused ${label} ${randomBytes(4).toString('hex')}`;
        const refused = await createSession(ws.harness.id, slug, prompt);
        assert.equal(refused.status, 409, `${label} create on an uninstalled runner: ${refused.status} ${refused.text}`);
        assert.equal(refused.json?.message, DSH_NOT_INSTALLED_ERROR, `${label} refusal: ${refused.text}`);
        assert.equal(await uuidOf(prompt), undefined, 'a refused create left a session row');
        refusals[label] = { status: refused.status, message: refused.json.message };
      }
      facts.s2 = refusals;
    });

    const followUpPrompt = `IG-S3 follow-up ${randomBytes(4).toString('hex')}: answer once.`;
    await scenario(SCENARIOS[2], async () => {
      // A claim long poll (25s) reads the runner's report when it starts. The one already waiting when that
      // heartbeat landed read phase 0's — the install this script removed, which a runner that never had one
      // cannot have — so the first Harness work goes in once it has turned over.
      assert.ok(notInstalledReportedAt, 'IG-S1 saw no not-installed report');
      await sleep(Math.max(0, notInstalledReportedAt.getTime() + 27_000 - Date.now()));
      const sent = await call('POST', `/sessions/${followUp.publicId}/turns`, { clientTurnId: randomUUID(), content: followUpPrompt });
      assert.ok([200, 201].includes(sent.status), `follow-up: ${sent.status} ${sent.text}`);
      const waiting = await eventually('the follow-up to wait with the not-installed notice', async () => {
        const row = await sessionRow(followUp.uuid);
        if (row?.status === 'FAILED') throw new Fatal(`the persisted session FAILED: ${row.error}`);
        return row?.status === 'PENDING' && row.error === DSH_NOT_INSTALLED_ERROR && row;
      }, 90_000, 500);
      // The same runner is claiming all along: a Claude session sent to it now is handed over and launched.
      const claudePrompt = `IG-S3 claude ${randomBytes(4).toString('hex')}`;
      const claude = await createSession(ws.claude.id, 'claude', claudePrompt);
      assert.equal(claude.status, 201, `Claude create: ${claude.status} ${claude.text}`);
      const launch = await eventually('the runner to launch claude for its session',
        () => shimRuns().find((r) => r.engine === 'claude' && r.session === publicIdOf(claude)), 120_000, 500);
      assert.ok(launch.args.includes('stream-json'), `claude was not launched as a session engine: ${launch.args}`);
      // One more full claim cycle (25s long poll) on top, then the Harness session must still be exactly where it was.
      await sleep(30_000);
      const still = await sessionRow(followUp.uuid);
      assert.equal(still.status, 'PENDING', `the waiting session moved: ${still.status} ${still.error}`);
      assert.equal(still.error, DSH_NOT_INSTALLED_ERROR);
      assert.equal(still.num_turns, 1, 'a turn ran without an install');
      assert.equal(still.runtime_session_id, followUp.runtimeSessionId, 'the Harness conversation changed');
      assert.equal(still.claimed_ms, followUp.claimedMs, 'the waiting session was claimed again');
      assert.deepEqual((await turnStatuses(followUp.uuid)).map((t) => t.status), ['ANSWERED', 'PENDING'], 'the follow-up was delivered');
      assert.equal(modelHeard(followUpPrompt), 0, 'the model heard the follow-up');
      assert.equal(dshProcesses().length, 0, 'a dsh process runs without an install');
      assert.equal(shimRuns().filter((r) => r.engine === 'dsh' || r.session === followUp.publicId).length, 0, 'something ran for the Harness session');
      facts.s3 = { waiting: { status: waiting.status, error: waiting.error, numTurns: still.num_turns }, claudeLaunched: true };
    });

    const resumePrompt = `IG-S4 resume ${randomBytes(4).toString('hex')}: answer once.`;
    await scenario(SCENARIOS[3], async () => {
      const refused = await call('POST', `/sessions/${ended.publicId}/resume`, { clientTurnId: randomUUID(), content: resumePrompt });
      assert.equal(refused.status, 409, `resume on an uninstalled runner: ${refused.status} ${refused.text}`);
      assert.equal(refused.json?.message, DSH_NOT_INSTALLED_ERROR, `resume refusal: ${refused.text}`);
      const row = await sessionRow(ended.uuid);
      assert.equal(row.status, 'CANCELLED');
      assert.equal(row.end_reason, 'ended');
      assert.equal(row.num_turns, 1);
      assert.equal(row.runtime_session_id, ended.runtimeSessionId);
      assert.equal((await turnStatuses(ended.uuid)).length, 1, 'a refused resume queued its message');
      facts.s4 = { status: refused.status, message: refused.json.message, session: row.status };
    });

    // ── phase 2: install through Orbit ──────────────────────────────────────────────────────────
    say('\n==== phase 2: install dsh through Orbit');
    await scenario(SCENARIOS[4], async () => {
      cpSync(npmCache, path.join(machine.orbitHome, 'engines', 'dsh', 'npm-cache'), { recursive: true });
      const requestedAt = Date.now();
      const asked = await call('POST', `/runners/${runnerPublicId}/install`, { engine: 'dsh' });
      assert.ok([200, 201].includes(asked.status), `install: ${asked.status} ${asked.text}`);
      const ready = await eventually('the runner to install dsh and report it ready', async () => {
        const row = await runnerRow();
        if (row?.install_status === 'failed') throw new Fatal(`install failed: ${row.install_message}`);
        const dsh = dshReport(row);
        return dsh?.installed === true && dsh.dsh?.versionCompatible === true && !dsh.installationError && row;
      }, 600_000, 1000);
      const reportedAt = Date.now();
      assert.ok(existsSync(path.join(versionDir, 'node_modules/.bin/dsh')), 'the runner published no install');
      assert.ok(existsSync(aside), 'the removed install came back instead of a new one');
      assert.ok(ready.capabilities.includes('provider:dsh'));
      const row = await settled("the waiting follow-up to run after the install", followUp.uuid, 2);
      assert.equal(row.error, null, 'the not-installed notice survived the claim');
      // Handed over by a claim after the heartbeat that reported the install, not by one before it.
      assert.ok(row.claimed_ms >= ready.at_ms, `the follow-up was claimed at ${new Date(row.claimed_ms).toISOString()}, before the report at ${new Date(ready.at_ms).toISOString()}`);
      assert.equal(row.runtime_session_id, followUp.runtimeSessionId, 'the follow-up ran on another Harness conversation');
      assert.deepEqual((await turnStatuses(followUp.uuid)).map((t) => t.status), ['ANSWERED', 'ANSWERED']);
      assert.ok(modelHeard(followUpPrompt) >= 1, 'the model never heard the follow-up');
      const live = dshProcesses().filter((p) => p.env.DSH_HOME === dshHomeOf(followUp.uuid));
      assert.equal(live.length, 1, `expected the session's resident dsh in its persisted home, found ${live.length}`);
      assert.ok(isDescendant(live[0].pid, machine.child.pid), 'the resident dsh is not a child of the runner');
      assert.equal(shimRuns().filter((r) => r.engine === 'dsh').length, 0, 'something ran a dsh other than the pinned install');
      facts.s5 = { installSeconds: Math.round((reportedAt - requestedAt) / 1000), engines: dshReport(ready),
        installReportedAt: new Date(ready.at_ms).toISOString(), followUpClaimedAt: new Date(row.claimed_ms).toISOString(),
        status: row.status, numTurns: row.num_turns, runtimeSessionId: row.runtime_session_id, dshHome: dshHomeOf(followUp.uuid) };
    });

    await scenario(SCENARIOS[5], async () => {
      const resumed = await call('POST', `/sessions/${ended.publicId}/resume`, { clientTurnId: randomUUID(), content: resumePrompt });
      assert.ok([200, 201].includes(resumed.status), `resume after the install: ${resumed.status} ${resumed.text}`);
      const revived = await settled('the resumed session to run', ended.uuid, 2);
      assert.equal(revived.error, null);
      assert.equal(revived.runtime_session_id, ended.runtimeSessionId, 'the resume started another Harness conversation');
      assert.ok(modelHeard(resumePrompt) >= 1, 'the model never heard the resumed message');
      const freshPrompt = `IG-S6 new ${randomBytes(4).toString('hex')}: answer once.`;
      const created = await createSession(ws.harness.id, harness, freshPrompt);
      assert.equal(created.status, 201, `create after the install: ${created.status} ${created.text}`);
      const fresh = await settled('the new Harness session to run', await uuidOf(freshPrompt), 1);
      assert.equal(fresh.error, null);
      assert.equal(fresh.runner, runnerUuid);
      assert.ok(fresh.runtime_session_id, 'no ACP session id persisted');
      assert.ok(modelHeard(freshPrompt) >= 1, 'the model never heard the new session');
      assert.ok(modelRequests().every((r) => r.keyMatched), 'a model request carried another key');
      facts.s6 = { resumed: { status: revived.status, numTurns: revived.num_turns }, fresh: { status: fresh.status, numTurns: fresh.num_turns } };
    });
  } catch (error) {
    fatal = error;
    say(`FATAL ${error.stack ?? error}`);
  } finally {
    for (const step of teardown.reverse()) {
      try { await step(); } catch { /* best effort */ }
    }
  }

  say('\n==== F-P7-1 install gate report');
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
  say(`F-P7-1 install gate acceptance passed: ${SCENARIOS.length} named scenarios, none missing, skipped or failed.`);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
