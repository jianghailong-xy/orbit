import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// P3b's named lifecycle scenarios. Each one must run and pass exactly once; a missing,
// unmatched, skipped or failed scenario, or a package that never starts, fails acceptance.
export const lifecycleScenarios = [
  'TestDshLifecycleMultiTurnQueue',
  ...['orbit-queue-and-redelivery', 'runner-local-queue', 'unsupported-turns-reach-a-terminal']
    .map((name) => `TestDshLifecycleMultiTurnQueue/${name}`),
  'TestDshLifecycleInterrupt',
  ...['cancel-active-turn', 'cancel-beats-racing-end_turn', 'approval-stop'].map((name) => `TestDshLifecycleInterrupt/${name}`),
  'TestDshLifecycleSettlementPriority',
  ...['precedence-table', 'output-limit-and-protocol-error', 'exit-without-response', 'stop-beats-exit']
    .map((name) => `TestDshLifecycleSettlementPriority/${name}`),
  'TestDshLifecycleCrashRestartRecovery',
  ...['runner-killed-mid-tool', 'runtime-id-never-reported'].map((name) => `TestDshLifecycleCrashRestartRecovery/${name}`),
  'TestDshLifecycleLeaseLoss',
  'TestDshLifecycleLateEvents',
  ...['settled-turn-stragglers', 'lost-completion-is-reported-again'].map((name) => `TestDshLifecycleLateEvents/${name}`),
  'TestDshLifecycleShutdownAndResume',
  'TestDshLifecycleCredentialReload',
  'TestDshLifecycleRedaction',
  'TestDshLifecycleWiring',
  ...['file-policy', 'production-seam-reads-dispatch', 'canonical-cwd-seal-and-execdir', 'launch-cwd-mismatch',
    'resume-failure-never-opens-new', 'runtime-id-conflict'].map((name) => `TestDshLifecycleWiring/${name}`),
];
// P3a driver scenarios whose code paths this phase changed (late events, runner loop).
export const driverScenarios = [
  'TestDshACPEventAttribution',
  'TestDshACPProcessMultiTurn',
  'TestDshACPResponseBarrier',
  'TestDshACPStartupAndProtocolFailures',
  'TestDshACPRunnerMultiTurn',
  'TestDshACPRunnerProcessFailure',
];
export const realScenarios = ['TestDshLifecycleRealRestartCancelAndLeaseRecovery'];
export const raceScenarios = [...lifecycleScenarios, ...driverScenarios];
export const acceptanceScenarios = [...lifecycleScenarios, ...driverScenarios, ...realScenarios];
export const guardNames = [
  'P3b acceptance requires every named lifecycle scenario exactly once',
  'P3b acceptance rejects missing, unmatched, skipped, failed and unfinished scenarios',
  'P3b acceptance rejects startup failures and absent packages',
  'P3b race run covers every in-process lifecycle scenario',
];

function goEnvironment(scratch) {
  // Nothing from the invoking Orbit session may reach these tests (they would talk to the live control plane).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORBIT_')));
  return { ...env, NODE_OPTIONS: '', GOCACHE: process.env.GOCACHE ?? '/tmp/orbit-dsh-p3b-go-cache', GOFLAGS: '', TMPDIR: scratch };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Install the canonical P0 lock in isolation and prove the binary is the pinned official CLI.
function installOfficialDsh(scratch, env) {
  const p0 = path.join(root, 'scripts/deepseek-harness-p0');
  const install = path.join(scratch, 'install');
  mkdirSync(install);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(path.join(p0, file), path.join(install, file));
  process.stdout.write('Installing the canonical P0 lock in an isolated temporary directory\n');
  runLogged('npm', ['ci', '--prefix', install, '--cache', '/tmp/orbit-dsh-p3b-npm-cache', '--no-audit', '--no-fund'],
    path.join(scratch, 'npm.log'), { env, timeout: 10 * 60_000 });
  const binary = path.join(install, 'node_modules/.bin/dsh');
  const version = runLogged(binary, ['--version'], path.join(scratch, 'version.log'), {
    env: { PATH: env.PATH, HOME: env.HOME, DSH_HOME: path.join(scratch, 'version-home'), DSH_TELEMETRY_DISABLED: '1' },
  }).trim();
  assert.equal(version, '0.2.0-rc.2', 'unsupported dsh CLI version');
  const baseline = JSON.parse(readFileSync(path.join(root, 'docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json'), 'utf8'));
  const cliSha256 = sha256(binary);
  assert.equal(cliSha256, baseline.cliSha256, 'CLI differs from the fixed P0 artifact');
  // The canonical lock is whatever the repository commits today (it carries later security
  // overrides), so it is hashed from the repository rather than compared with a fixed value.
  const lockSha256 = sha256(path.join(p0, 'package-lock.json'));
  assert.equal(sha256(path.join(install, 'package-lock.json')), lockSha256, 'npm ci rewrote the canonical P0 lock');
  const lock = JSON.parse(readFileSync(path.join(p0, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/@deepseek-ai/dsh'];
  assert.equal(entry?.version, '0.2.0-rc.2', 'P0 lock does not pin dsh 0.2.0-rc.2');
  assert.equal(entry.integrity, baseline.npmIntegrity, 'P0 lock dsh integrity differs from the recorded artifact');
  process.stdout.write(`Official dsh ${version}; CLI sha256=${cliSha256}; canonical P0 lock sha256=${lockSha256}\n`);
  return { binary, version, cliSha256, lockSha256 };
}

function goTest(args, names, log, env, scratch) {
  const output = runLogged('go', ['test', ...args, '-json', '-count=1', '-timeout=20m', '-run', goTestPattern(names), '.'], log, {
    cwd: path.join(root, 'src/runner-go'), env, timeout: 25 * 60_000,
  });
  const text = output.trim().split('\n').map((line) => JSON.parse(line)).map((event) => event.Output ?? '').join('');
  writeFileSync(path.join(scratch, `${path.basename(log, '.jsonl')}.txt`), text);
  process.stdout.write(text);
  assertGoResults(output, names);
  return text;
}

function runAcceptance() {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const evidence = evidenceIndex > 0 ? path.resolve(process.argv[evidenceIndex + 1] ?? '') : '';
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-p3b-'));
  const userHarness = path.join(process.env.HOME ?? homedir(), '.dsh');
  const before = harnessDirectoryFingerprint(userHarness);
  let passed = false;
  try {
    const guard = path.join(root, 'test/test-dsh-session-lifecycle.test.mjs');
    assert.ok(existsSync(guard), `missing required test file: ${guard}`);
    const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', guard], path.join(scratch, 'guard.tap'));
    assertTapResults(tap, guardNames);
    process.stdout.write(`PASS acceptance guard: ${guardNames.length} named guard cases\n`);
    for (const file of ['dsh_lifecycle_test.go', 'dsh_acp_real_test.go', 'dsh_acp_test.go', 'dsh_events_test.go', 'dsh_session_test.go']) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    const env = goEnvironment(scratch);
    const cli = installOfficialDsh(scratch, env);
    const records = path.join(scratch, 'recordings');
    const acceptance = goTest(['-tags=dsh_integration'], acceptanceScenarios, path.join(scratch, 'acceptance.jsonl'),
      { ...env, P3A_DSH_BIN: cli.binary, P3A_NODE_BIN: process.execPath, DSH_P3B_EVIDENCE_DIR: records }, scratch);
    process.stdout.write(`PASS ${acceptanceScenarios.length} named lifecycle, driver and real-CLI scenarios\n`);
    const race = goTest(['-race'], raceScenarios, path.join(scratch, 'race.jsonl'), env, scratch);
    assert.doesNotMatch(race, /WARNING: DATA RACE/, 'the race detector reported a data race');
    process.stdout.write(`PASS go test -race over ${raceScenarios.length} in-process scenarios\n`);
    assert.deepEqual(harnessDirectoryFingerprint(userHarness), before, 'the real ~/.dsh changed during acceptance');
    if (evidence) {
      mkdirSync(path.join(evidence, 'recordings'), { recursive: true });
      writeFileSync(path.join(evidence, 'acceptance-output.txt'), acceptance);
      writeFileSync(path.join(evidence, 'race-output.txt'), race);
      for (const file of readdirSafe(records)) copyFileSync(path.join(records, file), path.join(evidence, 'recordings', file));
      writeFileSync(path.join(evidence, 'summary.json'), `${JSON.stringify({
        command: 'bash scripts/test-dsh-session-lifecycle.sh', cliVersion: cli.version, cliSha256: cli.cliSha256,
        canonicalP0LockSha256: cli.lockSha256, acceptanceScenarios, raceScenarios, raceDetector: 'clean',
      }, null, 2)}\n`);
    }
    process.stdout.write(`P3b acceptance passed: ${acceptanceScenarios.length} named scenarios, race-checked ${raceScenarios.length}, none missing or skipped.\n`);
    passed = true;
  } finally {
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else process.stderr.write(`Acceptance logs retained at ${scratch}\n`);
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
