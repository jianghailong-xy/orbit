import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, permissionRegressionNames } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// P4's named Go scenarios that run in-process (also under the race detector).
export const unitScenarios = [
  'TestDshPermissionPolicy',
  ...['supported-modes', 'unsupported-modes-refused-before-launch'].map((name) => `TestDshPermissionPolicy/${name}`),
  'TestDshPermissionBridge',
  ...['allow-once-joins-the-bare-tool-call-id', 'reject', 'late-allow-after-stop-is-never-sent', 'closed-bridge-cancels-without-asking',
    'unknown-tool-call-is-rejected', 'dont-ask-rejects-unasked', 'unknown-options-never-default-to-allow',
    'auto-allows-a-routine-escalation-without-a-card', 'auto-leaves-a-high-impact-escalation-to-a-person',
    'default-never-allows-an-escalation-itself'].map((name) => `TestDshPermissionBridge/${name}`),
  'TestDshAutoRoutineEscalation',
  'TestDshToolGate',
  'TestDshPermissionCard',
  'TestDshMCPServers',
  ...['orbit-server-and-session-identity', 'sse-entry-refused-before-launch', 'unverified-remote-refused', 'relative-command-refused',
    'third-party-server-only-where-unapproved-actions-run', 'session-identity-is-not-the-agents-to-set'].map((name) => `TestDshMCPServers/${name}`),
  'TestDshToolPolicy',
  'TestDshAgentOverlay',
  'TestDshEventsToolCallJoin',
  'TestDshACPPermissionRoundTrip',
  ...['allow-once', 'reject-once'].map((name) => `TestDshACPPermissionRoundTrip/${name}`),
];
// Earlier dsh scenarios whose code paths P4 changed (session loop, reader, file policy).
export const regressionScenarios = [
  'TestDshLifecycleInterrupt/approval-stop',
  'TestDshLifecycleWiring/file-policy',
  'TestDshLifecycleCredentialReload',
  'TestDshACPProcessMultiTurn',
  'TestDshACPStartupAndProtocolFailures',
  'TestDshACPRecordedEventMapping',
];
// The pinned official dsh against a scripted model, the real `orbit mcp` and a control-plane double.
export const realScenarios = [
  'TestDshRealOrbitMCPAndAgentInstructions',
  'TestDshRealThirdPartyMCPAsksFirst',
  'TestDshRealApprovalAllowOnce',
  'TestDshRealApprovalReject',
  'TestDshRealApprovalStop',
  'TestDshRealApprovalDisconnect',
  'TestDshRealDontAskRejectsUnasked',
  'TestDshRealAutoWorkspaceBoundary',
  'TestDshRealAutoRoutineEscalation',
  'TestDshRealToolGateAsksInAuto',
  'TestDshRealToolGateRefusesInDontAsk',
];
export const goScenarios = [...unitScenarios, ...regressionScenarios, ...realScenarios];
export const raceScenarios = [...unitScenarios, ...regressionScenarios];
// Server/shared permission capability: one table, and the server refuses what it does not honor.
export const apiCases = {
  'common/permission-semantics': permissionRegressionNames,
  'common/dsh-runtime-routing': ['P1a dsh rejects unverified permission modes including account defaults'],
  'sessions/dsh-runner-preflight': ['P1b dsh preflight: capable runners still reject unverified Harness permissions'],
  'sessions/dsh-session-routing': [
    'dsh admission: unverified permission policies reject explicit and account-default modes before creation',
    'dsh admission: terminal Harness resume refuses an unverified permission policy without rewriting its id',
  ],
};
export const sharedNames = ['P1a refuses unsupported Harness permission and fast-mode claims including defaults'];
export const guardNames = [
  'P4 acceptance names every mandatory MCP, approval and real-CLI scenario exactly once',
  'P4 acceptance rejects missing, unmatched, skipped, failed and unfinished Go scenarios',
  'P4 acceptance rejects TAP and Vitest reports with missing, skipped or failed named cases',
  'P4 race run covers every in-process scenario and no real-CLI scenario',
];

// The named cases must each pass exactly once in a file that failed, skipped and left nothing undone.
export function assertNamedTap(output, names) {
  assert.ok(names.length > 0, 'no mandatory scenarios declared');
  assert.doesNotMatch(output, /^\s*(?:not ok\b|ok \d+ - .*#\s*(?:SKIP|TODO)\b)/im, 'failed, skipped or todo scenario');
  const passed = [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((match) => match[1]);
  for (const name of names) assert.equal(passed.filter((value) => value === name).length, 1, `missing or unmatched scenario: ${name}`);
  for (const [key, test] of [['tests', (n) => n >= names.length], ['pass', (n) => n >= names.length], ['fail', (n) => n === 0],
    ['cancelled', (n) => n === 0], ['skipped', (n) => n === 0], ['todo', (n) => n === 0]]) {
    const summaries = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    assert.equal(summaries.length, 1, `missing or duplicate ${key} summary`);
    assert.ok(test(Number(summaries[0][1])), `unexpected ${key} count`);
  }
}

export function assertNamedVitest(report, names) {
  assert.equal(report.success, true, 'Vitest did not succeed');
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.ok(cases.length > 0 && cases.every((entry) => entry.status === 'passed'), 'failed, skipped or empty shared report');
  for (const name of names) assert.equal(cases.filter((entry) => entry.title === name).length, 1, `missing or unmatched shared scenario: ${name}`);
}

function goEnvironment(scratch) {
  // Nothing from the invoking Orbit session may reach these tests (they would talk to the live control plane).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORBIT_')));
  return { ...env, NODE_OPTIONS: '', GOCACHE: process.env.GOCACHE ?? '/tmp/orbit-dsh-p4-go-cache', GOFLAGS: '', TMPDIR: scratch };
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
  runLogged('npm', ['ci', '--prefix', install, '--cache', '/tmp/orbit-dsh-p4-npm-cache', '--no-audit', '--no-fund'],
    path.join(scratch, 'npm.log'), { env, timeout: 10 * 60_000 });
  const binary = path.join(install, 'node_modules/.bin/dsh');
  const version = runLogged(binary, ['--version'], path.join(scratch, 'version.log'), {
    env: { PATH: env.PATH, HOME: env.HOME, DSH_HOME: path.join(scratch, 'version-home'), DSH_TELEMETRY_DISABLED: '1' },
  }).trim();
  assert.equal(version, '0.2.0-rc.2', 'unsupported dsh CLI version');
  const baseline = JSON.parse(readFileSync(path.join(root, 'docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json'), 'utf8'));
  const cliSha256 = sha256(binary);
  assert.equal(cliSha256, baseline.cliSha256, 'CLI differs from the fixed P0 artifact');
  // The canonical lock is whatever the repository commits today, hashed from the repository.
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

function runTypeScript(scratch) {
  const npm = (args, log, cwd = root) => runLogged('npm', args, path.join(scratch, log), { cwd, timeout: 10 * 60_000 });
  assert.ok(existsSync(path.join(root, 'node_modules/.bin/tsc')), 'missing root node_modules; install dependencies first');
  npm(['run', 'build', '-w', '@orbit/shared'], 'shared-build.log');
  const api = path.join(root, 'src/apiserver');
  rmSync(path.join(api, 'build'), { recursive: true, force: true });
  runLogged(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.test.json'], path.join(scratch, 'api-tsc.log'), { cwd: api, timeout: 10 * 60_000 });
  let count = 0;
  for (const [file, names] of Object.entries(apiCases)) {
    assert.ok(existsSync(path.join(api, `src/${file}.spec.ts`)), `missing required test source: ${file}`);
    const spec = path.join(api, `build/${file}.spec.js`);
    assert.ok(existsSync(spec), `missing compiled test: ${spec}`);
    const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
      path.join(scratch, `${path.basename(file)}.tap`), { cwd: api });
    process.stdout.write(output);
    if (file === 'common/permission-semantics') assertTapResults(output, names);
    else assertNamedTap(output, names);
    count += names.length;
  }
  const report = path.join(scratch, 'shared.json');
  runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', 'src/dsh-routing.spec.ts', '--reporter=json', `--outputFile=${report}`],
    path.join(scratch, 'vitest.log'), { cwd: path.join(root, 'src/shared') });
  assertNamedVitest(JSON.parse(readFileSync(report, 'utf8')), sharedNames);
  for (const name of sharedNames) process.stdout.write(`PASS ${name}\n`);
  return count + sharedNames.length;
}

function runAcceptance() {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const evidence = evidenceIndex > 0 ? path.resolve(process.argv[evidenceIndex + 1] ?? '') : '';
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-p4-'));
  const home = process.env.HOME ?? homedir();
  const watched = ['.dsh', '.agents'].map((dir) => path.join(home, dir));
  const before = watched.map(harnessDirectoryFingerprint);
  let passed = false;
  try {
    const guard = path.join(root, 'test/test-dsh-mcp-approval.test.mjs');
    assert.ok(existsSync(guard), `missing required test file: ${guard}`);
    const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', guard], path.join(scratch, 'guard.tap'));
    assertTapResults(tap, guardNames);
    process.stdout.write(`PASS acceptance guard: ${guardNames.length} named guard cases\n`);
    for (const file of ['dsh_permissions_test.go', 'dsh_mcp_test.go', 'dsh_acp_test.go', 'dsh_events_test.go', 'dsh_lifecycle_test.go']) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    const tsCount = runTypeScript(scratch);
    process.stdout.write(`PASS ${tsCount} named server and shared permission scenarios\n`);
    const env = goEnvironment(scratch);
    const cli = installOfficialDsh(scratch, env);
    const records = path.join(scratch, 'recordings');
    const acceptance = goTest([], goScenarios, path.join(scratch, 'acceptance.jsonl'),
      { ...env, P4_DSH_BIN: cli.binary, P4_NODE_BIN: process.execPath, DSH_P4_EVIDENCE_DIR: records }, scratch);
    for (const name of realScenarios) assert.ok(existsSync(path.join(records, `${name}.json`)), `real scenario left no record: ${name}`);
    process.stdout.write(`PASS ${goScenarios.length} named Go scenarios, ${realScenarios.length} of them on the real CLI\n`);
    const race = goTest(['-race'], raceScenarios, path.join(scratch, 'race.jsonl'), env, scratch);
    assert.doesNotMatch(race, /WARNING: DATA RACE/, 'the race detector reported a data race');
    process.stdout.write(`PASS go test -race over ${raceScenarios.length} in-process scenarios\n`);
    assert.deepEqual(watched.map(harnessDirectoryFingerprint), before, 'the real ~/.dsh or ~/.agents changed during acceptance');
    if (evidence) {
      mkdirSync(path.join(evidence, 'recordings'), { recursive: true });
      writeFileSync(path.join(evidence, 'acceptance-output.txt'), acceptance);
      writeFileSync(path.join(evidence, 'race-output.txt'), race);
      for (const file of readdirSync(records)) copyFileSync(path.join(records, file), path.join(evidence, 'recordings', file));
      writeFileSync(path.join(evidence, 'summary.json'), `${JSON.stringify({
        command: 'bash scripts/test-dsh-mcp-approval.sh', cliVersion: cli.version, cliSha256: cli.cliSha256,
        canonicalP0LockSha256: cli.lockSha256, goScenarios, realScenarios, raceScenarios, apiCases, sharedNames, raceDetector: 'clean',
      }, null, 2)}\n`);
    }
    process.stdout.write(`P4 acceptance passed: ${goScenarios.length} Go and ${tsCount} TypeScript named scenarios, race-checked ${raceScenarios.length}, none missing or skipped.\n`);
    passed = true;
  } finally {
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else process.stderr.write(`Acceptance logs retained at ${scratch}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
