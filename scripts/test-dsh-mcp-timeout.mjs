import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// In-process: the handoff, its refusal, the unchanged behaviour without a deadline, the capped inline
// waits, the dsh MCP declaration, and the create-card scenarios the handoff must not have changed.
export const unitScenarios = [
  'TestMCPOwnerWaitIsHandedOffUnderAnEngineDeadline',
  'TestMCPOwnerWaitIsRefusedWithoutAJobService',
  'TestMCPOwnerWaitBlocksInTheCallWithoutAnEngineDeadline',
  'TestMCPInlineWaitsEndBeforeAnEngineDeadline',
  'TestDshMCPServers',
  'TestDshMCPServers/orbit-server-and-session-identity',
  'TestMCPTaskCreateBatchAsksBeforeWriting',
  'TestMCPTaskCreateBatchWritesNothingWhenDenied',
  'TestMCPTaskCreateBatchHeadlessDoesNotAsk',
  'TestMCPSessionCreateWaitTellsTheModelTheWaitIsNotLost',
];
// The pinned official dsh against a scripted model, the real `orbit mcp` and a control-plane double.
export const realScenarios = [
  'TestDshRealMCPTimeoutCancelsTheCall',
  'TestDshRealOrbitMCPConfirmationOutlastsTimeout',
  'TestDshRealOrbitMCPAndAgentInstructions',
];
export const goScenarios = [...unitScenarios, ...realScenarios];

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
  const lockSha256 = sha256(path.join(p0, 'package-lock.json'));
  assert.equal(sha256(path.join(install, 'package-lock.json')), lockSha256, 'npm ci rewrote the canonical P0 lock');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-mcp-timeout-'));
  const home = process.env.HOME ?? homedir();
  const watched = ['.dsh', '.agents'].map((dir) => path.join(home, dir));
  const before = watched.map(harnessDirectoryFingerprint);
  let passed = false;
  try {
    for (const file of ['mcp_test.go', 'dsh_mcp_test.go']) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    const env = goEnvironment(scratch);
    const cli = installOfficialDsh(scratch, env);
    const records = path.join(scratch, 'recordings');
    const acceptance = goTest([], goScenarios, path.join(scratch, 'acceptance.jsonl'),
      { ...env, P4_DSH_BIN: cli.binary, P4_NODE_BIN: process.execPath, DSH_P4_EVIDENCE_DIR: records }, scratch);
    for (const name of realScenarios) assert.ok(existsSync(path.join(records, `${name}.json`)), `real scenario left no record: ${name}`);
    process.stdout.write(`PASS ${goScenarios.length} named Go scenarios, ${realScenarios.length} of them on the real CLI\n`);
    const race = goTest(['-race'], unitScenarios, path.join(scratch, 'race.jsonl'), env, scratch);
    assert.doesNotMatch(race, /WARNING: DATA RACE/, 'the race detector reported a data race');
    process.stdout.write(`PASS go test -race over ${unitScenarios.length} in-process scenarios\n`);
    assert.deepEqual(watched.map(harnessDirectoryFingerprint), before, 'the real ~/.dsh or ~/.agents changed during acceptance');
    if (evidence) {
      mkdirSync(path.join(evidence, 'recordings'), { recursive: true });
      writeFileSync(path.join(evidence, 'acceptance-output.txt'), acceptance);
      writeFileSync(path.join(evidence, 'race-output.txt'), race);
      for (const file of readdirSync(records)) copyFileSync(path.join(records, file), path.join(evidence, 'recordings', file));
      writeFileSync(path.join(evidence, 'summary.json'), `${JSON.stringify({
        command: 'bash scripts/test-dsh-mcp-timeout.sh', cliVersion: cli.version, cliSha256: cli.cliSha256,
        canonicalP0LockSha256: cli.lockSha256, goScenarios, realScenarios, raceScenarios: unitScenarios, raceDetector: 'clean',
      }, null, 2)}\n`);
    }
    process.stdout.write(`MCP timeout acceptance passed: ${goScenarios.length} Go scenarios, race-checked ${unitScenarios.length}, none missing or skipped.\n`);
    passed = true;
  } finally {
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else process.stderr.write(`Acceptance logs retained at ${scratch}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
