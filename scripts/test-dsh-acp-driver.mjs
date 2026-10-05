import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'TestDshACPRecordedEventMapping',
  'TestDshACPStatusAndUnclosedTools',
  'TestDshACPEventAttribution',
  'TestDshACPProcessMultiTurn',
  'TestDshACPResponseBarrier',
  'TestDshACPStartupAndProtocolFailures',
  'TestDshACPRunnerMultiTurn',
  'TestDshACPRunnerProcessFailure',
  'TestProviderRuntimesDeclareOneTransportPerEngine',
  'TestRuntimeProviderResolvesEveryDeclaredRuntime',
  'TestDshACPDispatchPreservesLegacyDeepSeek',
  'TestEverySessionLoopThatCannotSteerRefusesOne',
  'TestOnlyAnImplementedSteerIsDeclaredToTheControlPlane',
  'TestDshACPRealRunnerMultiTurn',
];
const required = [
  ...suites,
  ...['committed_blocks_and_known_context', 'basic_multiturn', 'native_tools_and_failed_tool']
    .map(name => `TestDshACPRecordedEventMapping/${name}`),
  ...['recorded_errors_and_next_turn_recovery', 'success', 'cancelled', 'max_tokens', 'refusal', 'missing_stop', 'unknown_stop',
    'rpc_error', 'unfinished_success', 'unfinished_disconnect', 'unfinished_cancelled']
    .map(name => `TestDshACPStatusAndUnclosedTools/${name}`),
  ...['missing-executable', 'unsupported-version', 'malformed-stdout', 'wrong-protocol-version', 'non-object-result', 'eof-zero', 'unclosed-tool',
    'rpc-error-does-not-poison-next-turn', 'unknown-live-model-rejected']
    .map(name => `TestDshACPStartupAndProtocolFailures/${name}`),
];

// Go returns zero when -run matches nothing. Require actual run/pass records for each
// exact scenario, and reject skips even if the enclosing top-level test passes.
function assertGoResults(output, names) {
  const events = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.length > 0, 'Go emitted no test records');
  for (const event of events) {
    assert.notEqual(event.Action, 'skip', `mandatory scenario skipped: ${event.Test ?? event.Package}`);
    assert.notEqual(event.Action, 'fail', `scenario or package failed: ${event.Test ?? event.Package}`);
  }
  for (const name of names) {
    for (const action of ['run', 'pass']) {
      assert.equal(events.filter(event => event.Test === name && event.Action === action).length, 1,
        `missing, unmatched or duplicate ${action} scenario: ${name}`);
    }
  }
  assert.equal(events.filter(event => !event.Test && event.Action === 'pass').length, 1, 'missing package success');
}

function run(command, args, log, env, cwd = root, timeout = 10 * 60_000, stderrLog = log) {
  const fd = openSync(log, 'w');
  const stderr = stderrLog === log ? fd : openSync(stderrLog, 'w');
  let result;
  try {
    result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, stderr], timeout });
  } finally {
    closeSync(fd);
    if (stderr !== fd) closeSync(stderr);
  }
  const output = readFileSync(log, 'utf8');
  if (stderrLog !== log) process.stderr.write(readFileSync(stderrLog, 'utf8'));
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return output;
}

// Exercise the acceptance guard itself without a node:test harness or output pipe.
const record = (Action, Test) => JSON.stringify({ Action, ...(Test ? { Test } : {}), Package: 'main' });
const good = [record('run', 'Required'), record('pass', 'Required'), record('pass')].join('\n');
assertGoResults(good, ['Required']);
for (const bad of [
  record('pass'),
  good.replaceAll('Required', 'Other'),
  good + '\n' + record('skip', 'Required/mandatory'),
  good + '\n' + record('fail', 'Required/mandatory'),
  good.replace(record('pass', 'Required') + '\n', ''),
  good.replace('\n' + record('pass'), ''),
  '',
]) assert.throws(() => assertGoResults(bad, ['Required']));
process.stdout.write('PASS acceptance rejects missing, unmatched, skipped, failed and incomplete scenarios\n');

const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-p3a-accept-'));
let passed = false;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORBIT_')));
  env.NODE_OPTIONS = '';
  env.GOCACHE = '/tmp/orbit-dsh-p3a-go-cache';
  const install = path.join(scratch, 'install');
  mkdirSync(install);
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(path.join(root, 'scripts/deepseek-harness-p0', file), path.join(install, file));
  }
  process.stdout.write('Installing the P0 lock in an isolated temporary directory\n');
  process.stdout.write(run('npm', ['ci', '--prefix', install, '--cache', '/tmp/orbit-dsh-p3a-npm-cache', '--no-audit', '--no-fund'],
    path.join(scratch, 'npm.log'), env));
  const binary = path.join(install, 'node_modules/.bin/dsh');
  const identityEnv = { PATH: env.PATH, HOME: env.HOME, DSH_HOME: path.join(scratch, 'version-home'), DSH_TELEMETRY_DISABLED: '1' };
  const version = run(binary, ['--version'], path.join(scratch, 'version.log'), identityEnv).trim();
  assert.equal(version, '0.2.0-rc.2', 'unsupported dsh CLI version');
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const baseline = JSON.parse(readFileSync(path.join(root, 'docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json'), 'utf8'));
  assert.equal(sha256, baseline.cliSha256, 'CLI differs from the fixed P0 artifact');
  // baseline.lockSha256 records the pre-override historical experiment; the canonical lock is the
  // committed P0 package-lock.json carrying the fflate security override (docs/dependency-security.md).
  const p0 = path.join(root, 'scripts/deepseek-harness-p0');
  const lockSha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const canonicalLockSha256 = lockSha256(path.join(p0, 'package-lock.json'));
  assert.equal(lockSha256(path.join(install, 'package-lock.json')), canonicalLockSha256,
    'npm ci rewrote the canonical P0 lock');
  const lock = JSON.parse(readFileSync(path.join(p0, 'package-lock.json'), 'utf8'));
  const dshEntry = lock.packages['node_modules/@deepseek-ai/dsh'];
  assert.equal(dshEntry?.version, '0.2.0-rc.2', 'P0 lock does not pin dsh 0.2.0-rc.2');
  assert.equal(dshEntry.integrity, baseline.npmIntegrity, 'P0 lock dsh integrity differs from the recorded artifact');
  assert.equal(JSON.parse(readFileSync(path.join(p0, 'package.json'), 'utf8'))
    .overrides?.['@deepseek-ai/libreoffice-kit']?.fflate, '0.8.3', 'P0 fflate security override missing');
  const fflateKey = 'node_modules/@deepseek-ai/libreoffice-kit/node_modules/fflate';
  assert.equal(lock.packages[fflateKey]?.version, '0.8.3', 'P0 lock does not resolve the fflate override');
  assert.equal(JSON.parse(readFileSync(path.join(install, fflateKey, 'package.json'), 'utf8')).version, '0.8.3',
    'installed fflate is not the patched 0.8.3');
  process.stdout.write(`Real official dsh ${version}; CLI sha256=${sha256}; P0 lock sha256=${canonicalLockSha256} (fflate 0.8.3 override)\n`);
  env.P3A_DSH_BIN = binary;
  env.P3A_NODE_BIN = process.execPath;
  const output = run('go', ['test', '-tags=dsh_integration', '-json', '-count=1', '-timeout=30m', '-run', `^(${suites.join('|')})$`, '.'],
    path.join(scratch, 'go.jsonl'), env, path.join(root, 'src/runner-go'), 31 * 60_000, path.join(scratch, 'go.stderr.log'));
  for (const line of output.trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.Output) process.stdout.write(event.Output);
  }
  assertGoResults(output, required);
  process.stdout.write(`P3a acceptance passed: ${required.length} named scenarios, none missing or skipped.\n`);
  passed = true;
} finally {
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else process.stderr.write(`Acceptance logs retained at ${scratch}\n`);
}
