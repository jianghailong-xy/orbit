import assert from 'node:assert/strict';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Independent of Go discovery: deleting, renaming or skipping a required test is a failure.
export const mandatoryGoCases = {
  'dsh_install_test.go': [
    'TestDshInstallRequiresConsent',
    'TestDshInstallUsesFrozenLockAndImmutableVersion',
    'TestDshInstallRejectsStartupAndVersionFailures',
    'TestDshInstallRejectsStartupAndVersionFailures/npm-fails',
    'TestDshInstallRejectsStartupAndVersionFailures/no-entry',
    'TestDshInstallRejectsStartupAndVersionFailures/startup-fails',
    'TestDshInstallRejectsStartupAndVersionFailures/bad-version',
    'TestDshVersionAndPlatformAdmission',
    'TestDshHealthSeparatesInstallFromAuthentication',
    'TestDshUpdatePinsVersionAndProtectsActiveSessions',
    'TestDshTransientProbeFailureNeverPanics',
    'TestDshImmutableVersionRejectsExternalDirectory',
  ],
  'dsh_environment_test.go': [
    'TestDshConcurrentSessionIsolationAndRestart',
    'TestDshMissingRevokedAndInvalidCredentials',
    'TestDshPrivateConfigurationAndSafeDiagnostics',
    'TestDshRecoveryDirectoryConflictsFailClosed',
    'TestDshProfileAndOverlayHashesPreserveRecovery',
  ],
  'dsh_models_test.go': [
    'TestDshModelCatalogOpaqueGroupedDirectory',
    'TestDshModelCatalogCredentiallessProbe',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/missing-executable',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/non-json',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/protocol-version',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/session-new-error',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/empty-catalogue',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/exit-after-close',
    'TestDshModelCatalogRejectsStartupAndProtocolFailures/startup-diagnostic',
  ],
  'dsh_health_test.go': [
    'TestDshHealthSeparatesCredentialCatalogueAndAuthentication',
    'TestDshRequestValidationAndDiagnosticRedaction',
    'TestDshRequestValidationAndDiagnosticRedaction/missing-key',
    'TestDshRequestValidationAndDiagnosticRedaction/invalid-key',
    'TestDshRequestValidationAndDiagnosticRedaction/revoked-key',
    'TestDshRequestValidationAndDiagnosticRedaction/unauthorized',
    'TestDshRequestValidationAndDiagnosticRedaction/rate-limit',
    'TestDshRequestValidationAndDiagnosticRedaction/server-error',
    'TestDshRequestValidationAndDiagnosticRedaction/permission-forbidden',
    'TestDshRequestValidationAndDiagnosticRedaction/protocol-internal-error',
    'TestDshRequestValidationAndDiagnosticRedaction/success',
    'TestDshRequestValidationAndDiagnosticRedaction/ambiguous-success-with-error',
    'TestDshRequestValidationAndDiagnosticRedaction/incomplete-request',
  ],
};
export const mandatoryApiCases = {
  'runner-api/dsh-runtime-health': [
    'P2 dsh health preserves independent availability and request authentication states',
    'P2 dsh health API drops secrets upstream messages and malformed states',
    'P2 dsh browser install is authorized separately from unsupported account login',
  ],
  'providers/dsh-runtime-environment': [
    'P2 encrypted dsh dispatch keeps concurrent provider keys and endpoints separate',
    'P2 dsh credential rotation revocation and disabled dispatch cannot reuse a saved key',
  ],
};
const guardNames = [
  'P2 acceptance guard requires every named Go scenario exactly once',
  'P2 acceptance guard requires every named API scenario without skips',
  'P2 acceptance guard rejects failed skipped and unfinished Go scenarios',
  'P2 acceptance guard rejects invalid missing and duplicate Go package results',
  'P2 acceptance guard rejects unmatched Go tests and wrapper-only success',
  'P2 acceptance guard rejects missing executables and startup failures',
  'P2 acceptance runs node:test with regular-file output and visible scenario names',
  'P2 acceptance strips ambient credentials and Orbit context before Go tests',
  'P2 acceptance fingerprints user Harness content permissions and directory absence',
];

export function harnessDirectoryFingerprint(directory) {
  try {
    lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  const hash = createHash('sha256');
  const visit = (entry) => {
    const info = lstatSync(entry);
    hash.update(JSON.stringify([path.relative(directory, entry), info.mode]));
    if (info.isSymbolicLink()) hash.update(readlinkSync(entry));
    else if (info.isFile()) hash.update(readFileSync(entry));
    else if (info.isDirectory()) {
      for (const child of readdirSync(entry).sort()) visit(path.join(entry, child));
    }
  };
  visit(directory);
  return hash.digest('hex');
}

export function goTestPattern(names) {
  assert.ok(names.length > 0, 'no mandatory Go scenarios declared');
  assert.equal(new Set(names).size, names.length, 'duplicate mandatory Go scenario');
  assert.ok(names.every((name) => /^Test[A-Za-z0-9_]+(?:\/[A-Za-z0-9_-]+)*$/.test(name)), 'invalid mandatory Go scenario name');
  return `^(${[...new Set(names.map((name) => name.split('/')[0]))].join('|')})$`;
}

export function assertGoResults(output, names, packageName = 'orbit') {
  goTestPattern(names);
  const events = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.length > 0, 'missing Go test events');
  const runs = new Set();
  const passes = new Set();
  const topLevelNames = names.map((name) => name.split('/')[0]);
  let started = 0;
  let completed = 0;
  for (const event of events) {
    assert.equal(event.Package, packageName, 'unmatched Go package');
    assert.ok(['start', 'run', 'pause', 'cont', 'output', 'pass', 'fail', 'skip'].includes(event.Action), 'invalid Go event action');
    assert.ok(!['fail', 'skip'].includes(event.Action), `failed or skipped Go scenario: ${event.Test ?? packageName}`);
    if (event.Test !== undefined) {
      assert.equal(typeof event.Test, 'string', 'invalid Go test name');
      assert.ok(topLevelNames.includes(event.Test.split('/')[0]), `unmatched Go scenario: ${event.Test}`);
      if (event.Action === 'run') {
        assert.ok(!runs.has(event.Test), `duplicate Go scenario: ${event.Test}`);
        runs.add(event.Test);
      } else if (event.Action === 'pass') {
        assert.ok(runs.has(event.Test), `Go scenario passed without running: ${event.Test}`);
        assert.ok(!passes.has(event.Test), `duplicate Go pass: ${event.Test}`);
        passes.add(event.Test);
      }
    } else if (event.Action === 'start') {
      started++;
    } else if (event.Action === 'pass') {
      completed++;
    } else {
      assert.equal(event.Action, 'output', 'unexpected Go package event');
    }
  }
  assert.equal(started, 1, 'missing or duplicate Go package start');
  assert.equal(completed, 1, 'missing or duplicate Go package pass');
  for (const name of names) {
    assert.ok(runs.has(name), `missing or unmatched Go scenario: ${name}`);
    assert.ok(passes.has(name), `unfinished Go scenario: ${name}`);
  }
  assert.equal(passes.size, runs.size, 'unfinished Go subtest');
}

export function runnerEnvironment(original, scratch, toolPath) {
  // Preserve HOME for user-directory snapshot checks. Nothing from the invoking live session,
  // provider credentials or Harness profiles is allowed to reach these fake-engine tests.
  return {
    HOME: original.HOME ?? homedir(),
    PATH: toolPath,
    TMPDIR: scratch,
    GOCACHE: original.GOCACHE ?? path.join(tmpdir(), 'orbit-dsh-p2-go-cache'),
    GOENV: 'off',
    CGO_ENABLED: '0',
    LANG: 'C.UTF-8',
    NODE_OPTIONS: '',
  };
}

export function runLogged(command, args, log, { cwd = root, env = process.env, timeout = 120_000 } = {}) {
  const fd = openSync(log, 'w');
  let result;
  try {
    // Both streams are regular files; node:test never runs inside a pipe or IPC harness.
    result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...env, NODE_OPTIONS: '' }, timeout });
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, 'utf8');
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`test startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return output;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-runtime-environment-'));
  const userHarness = path.join(process.env.HOME ?? homedir(), '.dsh');
  const userFingerprint = harnessDirectoryFingerprint(userHarness);
  try {
    const guard = path.join(root, 'test/test-dsh-runtime-environment.test.mjs');
    assert.ok(existsSync(guard), `missing required test file: ${guard}`);
    const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', guard], path.join(scratch, 'guard.tap'));
    process.stdout.write(tap);
    assertTapResults(tap, guardNames);
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    const names = Object.values(mandatoryGoCases).flat();
    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const engine of ['dsh', 'claude', 'codex', 'kimi', 'opencode', 'antigravity', 'agy', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, engine), '#!/bin/sh\nprintf "P2 tests attempted an unmocked runtime or installer\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath prepends these private installer locations unless they are already
    // present. Keep them at the end so the test blockers and fake fixtures retain precedence.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=180s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 240_000,
    });
    process.stdout.write(output);
    assertGoResults(output, names);
    for (const [file, apiNames] of Object.entries(mandatoryApiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required API test source: ${file}`);
      const compiled = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(compiled), `missing required compiled API tests: ${file}`);
      const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', compiled], path.join(scratch, 'api.tap'), {
        env: runnerEnvironment(process.env, scratch, toolPath),
      });
      process.stdout.write(tap);
      assertTapResults(tap, apiNames);
    }
    const apiCount = Object.values(mandatoryApiCases).reduce((sum, cases) => sum + cases.length, 0);
    assert.equal(harnessDirectoryFingerprint(userHarness), userFingerprint, 'real user Harness directory changed');
    process.stdout.write('PASS real user Harness directory content and permissions unchanged.\n');
    process.stdout.write(`P2 acceptance passed: ${names.length + apiCount} named runner and API scenarios, none missing or skipped.\n`);
  } finally {
    // Retain test logs if the host snapshot changes, including when another assertion failed.
    if (harnessDirectoryFingerprint(userHarness) !== userFingerprint) {
      process.stderr.write(`Real user Harness directory changed; acceptance logs retained at ${scratch}\n`);
      throw new Error('real user Harness directory changed');
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
