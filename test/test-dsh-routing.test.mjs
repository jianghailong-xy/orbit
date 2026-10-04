import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults, assertVitestResults, runLogged } from '../scripts/test-dsh-routing.mjs';

const tap = 'TAP version 13\nok 1 - required\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('acceptance guard rejects missing or unmatched named tests', () => {
  assertTapResults(tap, ['required']);
  for (const output of ['', tap.replace('required', 'different')]) {
    assert.throws(() => assertTapResults(output, ['required']));
  }
  assert.throws(() => assertTapResults(tap, []));
});

test('acceptance guard rejects skips todos failures and file-only passes', () => {
  for (const output of [
    tap.replace('required', 'required # SKIP'),
    tap.replace('required', 'required # TODO'),
    tap.replace('ok 1', 'not ok 1'),
    tap.replace('required', 'src/apiserver/build/required.spec.js'),
  ]) assert.throws(() => assertTapResults(output, ['required']));
});

test('acceptance guard rejects absent or inconsistent summaries', () => {
  for (const output of [tap.replace('# pass 1\n', ''), tap.replace('# tests 1', '# tests 0'), `${tap}# pass 1\n`]) {
    assert.throws(() => assertTapResults(output, ['required']));
  }
});

test('acceptance guard rejects failed skipped and empty Vitest reports', () => {
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, testResults: [{ assertionResults: [{ title: 'required', status: 'passed' }] }] };
  assertVitestResults(report, ['required']);
  for (const status of ['failed', 'skipped', 'pending', 'todo']) {
    assert.throws(() => assertVitestResults({ ...report, testResults: [{ assertionResults: [{ title: 'required', status }] }] }, ['required']));
  }
  assert.throws(() => assertVitestResults({ ...report, testResults: [] }, ['required']));
  assert.throws(() => assertVitestResults({ ...report, success: false }, ['required']));
  assert.throws(() => assertVitestResults(report, ['unmatched']));
});

test('acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-acceptance-guard-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
