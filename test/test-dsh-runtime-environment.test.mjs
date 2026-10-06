import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, mandatoryApiCases, mandatoryGoCases, runLogged, runnerEnvironment } from '../scripts/test-dsh-runtime-environment.mjs';

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

function json(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

test('P2 acceptance guard requires every named Go scenario exactly once', () => {
  const names = Object.values(mandatoryGoCases).flat();
  const events = goEvents(names);
  assertGoResults(json(events), names);
  for (const name of names) {
    assert.throws(() => assertGoResults(json(events.filter((event) => event.Test !== name)), names));
    assert.throws(() => assertGoResults(json([...events, ...goEvents([name]).slice(1, -1)]), names));
  }
  assert.throws(() => goTestPattern([]));
  assert.throws(() => goTestPattern(['TestOne', 'TestOne']));
  assert.throws(() => goTestPattern(['TestOne.*']));
  const selector = new RegExp(goTestPattern(['TestOne', 'TestTwo']));
  assert.ok(selector.test('TestOne'));
  assert.ok(!selector.test('TestOneExtra'));
  assert.equal(goTestPattern(['TestOne', 'TestOne/required-child']), '^(TestOne)$');
});

test('P2 acceptance guard requires every named API scenario without skips', () => {
  for (const names of Object.values(mandatoryApiCases)) {
    const tap = `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
    assertTapResults(tap, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(tap.replace(name, 'unmatched'), names));
      assert.throws(() => assertTapResults(tap.replace(name, `${name} # SKIP`), names));
    }
    assert.throws(() => assertTapResults(tap.replace(/^ok \d+ - .+\n/m, ''), names));
  }
});

test('P2 acceptance guard rejects failed skipped and unfinished Go scenarios', () => {
  const events = goEvents(['TestRequired']);
  for (const Action of ['fail', 'skip']) {
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test && event.Action === 'pass' ? { ...event, Action } : event)), ['TestRequired']));
    assert.throws(() => assertGoResults(json([...events, { Action, Package: 'orbit', Test: 'TestRequired/child' }]), ['TestRequired']));
    assert.throws(() => assertGoResults(json(events.map((event) => !event.Test && event.Action === 'pass' ? { ...event, Action } : event)), ['TestRequired']));
  }
  assert.throws(() => assertGoResults(json(events.filter((event) => !event.Test || event.Action !== 'pass')), ['TestRequired']));
  assert.throws(() => assertGoResults(json([...events, { Action: 'run', Package: 'orbit', Test: 'TestRequired/child' }]), ['TestRequired']));
});

test('P2 acceptance guard rejects invalid missing and duplicate Go package results', () => {
  const events = goEvents(['TestRequired']);
  for (const output of [
    '', 'not JSON\n', `${json(events)}{"Action":`,
    json(events.filter((event) => event.Test)),
    json(events.filter((event) => event.Action !== 'start')),
    json([...events, { Action: 'pass', Package: 'orbit' }]),
    json(events.map((event) => ({ ...event, Package: 'another-package' }))),
    json([...events, { Action: 'unexpected', Package: 'orbit' }]),
  ]) assert.throws(() => assertGoResults(output, ['TestRequired']));
});

test('P2 acceptance guard rejects unmatched Go tests and wrapper-only success', () => {
  assert.throws(() => assertGoResults(json(goEvents(['TestDifferent'])), ['TestRequired']));
  assert.throws(() => assertGoResults(json(goEvents([])), ['TestRequired']));
  const events = goEvents(['TestRequired']);
  assert.throws(() => assertGoResults(json([...events, ...goEvents(['TestExtra']).slice(1, -1)]), ['TestRequired']));
  const child = goEvents(['TestRequired/child']).slice(1, -1);
  assertGoResults(json([...events.slice(0, -1), ...child, events.at(-1)]), ['TestRequired']);
});

test('P2 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('P2 acceptance runs node:test with regular-file output and visible scenario names', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-output-'));
  try {
    const source = path.join(scratch, 'regular-file.test.cjs');
    writeFileSync(source, `const assert = require('node:assert/strict');
const { fstatSync } = require('node:fs');
const { test } = require('node:test');
test('regular file child', () => { assert.equal(fstatSync(1).isFile(), true); assert.equal(fstatSync(2).isFile(), true); });
`);
    const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', source], path.join(scratch, 'test.log'));
    assertTapResults(output, ['regular file child']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('P2 acceptance strips ambient credentials and Orbit context before Go tests', () => {
  const original = {
    HOME: '/unchanged-user-home', PATH: '/unsafe/bin', GOCACHE: '/tmp/existing-go-cache',
    ORBIT_SESSION_ID: 'live-session', ORBIT_API_URL: 'https://production.test', ORBIT_TOKEN: 'runner-key',
    ORBIT_DSH_API_KEY: 'ambient-key', ORBIT_DSH_BASE_URL: 'https://real-provider.test',
    DEEPSEEK_API_KEY: 'ambient-key', ANTHROPIC_API_KEY: 'ambient-key', OPENAI_API_KEY: 'ambient-key',
    DSH_HOME: '/real-harness-home', CLAUDE_CONFIG_DIR: '/real-claude-home', CODEX_HOME: '/real-codex-home',
    NODE_OPTIONS: '--require unsafe.cjs', GOFLAGS: '-exec=unsafe',
  };
  const env = runnerEnvironment(original, '/tmp/isolated-tests', '/safe/tools');
  assert.equal(env.HOME, original.HOME);
  assert.equal(env.PATH, '/safe/tools');
  assert.equal(env.GOCACHE, original.GOCACHE);
  assert.equal(env.TMPDIR, '/tmp/isolated-tests');
  for (const key of Object.keys(original).filter((key) => !['HOME', 'PATH', 'GOCACHE', 'NODE_OPTIONS'].includes(key))) {
    assert.equal(env[key], undefined, `${key} reached the test environment`);
  }
  assert.equal(env.NODE_OPTIONS, '');
  assert.equal(env.GOENV, 'off');
});

test('P2 acceptance fingerprints user Harness content permissions and directory absence', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-snapshot-'));
  try {
    const directory = path.join(scratch, '.dsh');
    assert.equal(harnessDirectoryFingerprint(directory), 'absent');
    mkdirSync(path.join(directory, 'profiles'), { recursive: true, mode: 0o700 });
    const credential = path.join(directory, '.credentials.yaml');
    writeFileSync(credential, 'fake-private-key', { mode: 0o600 });
    const before = harnessDirectoryFingerprint(directory);
    assert.equal(harnessDirectoryFingerprint(directory), before);
    assert.match(before, /^[0-9a-f]{64}$/);
    writeFileSync(credential, 'changed-private-key');
    assert.notEqual(harnessDirectoryFingerprint(directory), before);
    writeFileSync(credential, 'fake-private-key');
    assert.equal(harnessDirectoryFingerprint(directory), before);
    chmodSync(credential, 0o640);
    assert.notEqual(harnessDirectoryFingerprint(directory), before);
    chmodSync(credential, 0o600);
    writeFileSync(path.join(directory, 'profiles', 'new-config'), 'new');
    assert.notEqual(harnessDirectoryFingerprint(directory), before);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
