import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertGoResults, goTestPattern, runLogged } from '../scripts/test-dsh-runtime-environment.mjs';
import { assertDeclared, criteria, goEnvironment, goTestNames, namedGoTests } from '../scripts/test-provider-engine-cli.mjs';

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

function json(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

test('T5 acceptance guard requires every named Go test to run and pass exactly once', () => {
  const events = goEvents(goTestNames);
  assertGoResults(json(events), goTestNames);
  for (const name of goTestNames) {
    assert.throws(() => assertGoResults(json(events.filter((event) => event.Test !== name)), goTestNames), undefined, `missing ${name} was accepted`);
    assert.throws(() => assertGoResults(json([...events, ...goEvents([name]).slice(1, -1)]), goTestNames), undefined, `a second ${name} was accepted`);
  }
  assert.equal(new Set(goTestNames).size, goTestNames.length, 'a named test is listed twice');
  const selector = new RegExp(goTestPattern(goTestNames));
  for (const name of goTestNames) assert.ok(selector.test(name.split('/')[0]), `the selector misses ${name}`);
  assert.ok(!selector.test('TestDshMissingKeyAsksForADeepSeekKeyAgain'), 'the selector matches past an exact name');
});

test('T5 acceptance guard rejects skipped, failed and unmatched Go tests and a package that never passed', () => {
  const names = ['TestRequired', 'TestRequired/child'];
  const events = goEvents(names);
  assertGoResults(json(events), names);
  for (const Action of ['fail', 'skip']) {
    assert.throws(() => assertGoResults(json(events.map((event) => event.Test === 'TestRequired/child' && event.Action === 'pass' ? { ...event, Action } : event)), names));
    assert.throws(() => assertGoResults(json(events.map((event) => !event.Test && event.Action === 'pass' ? { ...event, Action } : event)), names));
  }
  assert.throws(() => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestUnlisted' },
    { Action: 'pass', Package: 'orbit', Test: 'TestUnlisted' }, events.at(-1)]), names), undefined, 'an unmatched test was accepted');
  assert.throws(() => assertGoResults(json(events.slice(0, -1)), names), undefined, 'a package with no pass was accepted');
  assert.throws(() => assertGoResults('', names), undefined, 'no output was accepted');
});

test('T5 acceptance guard finds every named Go test declared in its source file', () => {
  assertDeclared(namedGoTests);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-t5-guard-'));
  try {
    writeFileSync(path.join(scratch, 'one_test.go'), 'package main\n\nfunc TestOne(t *testing.T) {}\n');
    assertDeclared({ 'one_test.go': ['TestOne', 'TestOne/child'] }, scratch);
    assert.throws(() => assertDeclared({ 'one_test.go': ['TestTwo'] }, scratch), /missing or duplicate Go test TestTwo/);
    assert.throws(() => assertDeclared({ 'absent_test.go': ['TestOne'] }, scratch), /missing required Go test source/);
    writeFileSync(path.join(scratch, 'two_test.go'), 'package main\n\nfunc TestOne(t *testing.T) {}\nfunc TestOne(t *testing.T) {}\n');
    assert.throws(() => assertDeclared({ 'two_test.go': ['TestOne'] }, scratch), /missing or duplicate/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('T5 acceptance guard maps every acceptance criterion to named Go tests it runs', () => {
  assert.equal(Object.keys(criteria).length, 7, 'every criterion but the full suite has named tests');
  const run = new Set(goTestNames);
  const covered = new Set();
  for (const [criterion, names] of Object.entries(criteria)) {
    assert.ok(names.length > 0, `${criterion} names no test`);
    for (const name of names) {
      assert.ok(run.has(name), `${criterion} names ${name}, which the acceptance does not run`);
      covered.add(name.split('/')[0]);
    }
  }
  for (const name of goTestNames) assert.ok(covered.has(name.split('/')[0]), `${name} serves no criterion`);
});

test('T5 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-t5-guard-'));
  try {
    assert.throws(() => runLogged(path.join(scratch, 'no-such-go'), ['test'], path.join(scratch, 'missing.log')), /test startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(3)'], path.join(scratch, 'exit.log')), /exit 3/);
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'go'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o700 });
    assert.throws(() => runLogged(path.join(bin, 'go'), ['test'], path.join(scratch, 'signal.log')), /signal SIGTERM/);
    assert.equal(runLogged(process.execPath, ['-e', 'console.log("ok")'], path.join(scratch, 'ok.log')), 'ok\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('T5 acceptance runs Go without the calling session or engine credentials, keeping HOME, PATH and TMPDIR', () => {
  const env = goEnvironment({
    HOME: '/home/runner', PATH: '/usr/bin', TMPDIR: '/tmp', GOCACHE: '/cache', LANG: 'C.UTF-8',
    ORBIT_SESSION_ID: 's', ORBIT_TASK_ID: 't', ORBIT_AGENT_ID: 'a', ORBIT_HOME: '/root/.orbit', ORBIT_ALLOW_ORCHESTRATION: '1',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'c', CLAUDE_CONFIG_DIR: '/accounts/1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
    GEMINI_API_KEY: 'k', KIMI_MODEL_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', OPENCODE_CONFIG_CONTENT: '{}',
  });
  assert.deepEqual(env, { HOME: '/home/runner', PATH: '/usr/bin', TMPDIR: '/tmp', GOCACHE: '/cache', LANG: 'C.UTF-8' });
});
