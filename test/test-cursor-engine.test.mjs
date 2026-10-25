import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from '../scripts/test-dsh-routing.mjs';
import { runLogged } from '../scripts/test-dsh-provider-gate.mjs';
import { apiCases, guardNames, pgCases, pgLogName, sharedCases } from '../scripts/test-cursor-engine.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function vitest(names) {
  return {
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: [{ assertionResults: names.map((title) => ({ title, status: 'passed' })) }],
  };
}

test('P1 acceptance guard requires every mandatory shared, PostgreSQL and application scenario', () => {
  for (const names of [...Object.values(pgCases), ...Object.values(apiCases), guardNames]) {
    const output = tap(names);
    assertTapResults(output, names);
    // Each one is required: dropping any of them is red.
    for (const name of names) assert.throws(() => assertTapResults(tap(names.filter((other) => other !== name)), names));
  }
  for (const names of Object.values(sharedCases)) {
    assertVitestResults(vitest(names), names);
    for (const name of names) assert.throws(() => assertVitestResults(vitest(names.filter((other) => other !== name)), names));
  }
});

test('P1 acceptance guard rejects missing, unmatched, skipped, todo and failed scenarios', () => {
  for (const names of [pgCases['queue/cursor-runner-gate'], apiCases['runner-api/cursor-runner-gate']]) {
    const output = tap(names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(name, 'unmatched'), names));
      assert.throws(() => assertTapResults(output.replace(name, `${name} # SKIP`), names));
      assert.throws(() => assertTapResults(output.replace(name, `${name} # TODO`), names));
    }
  }
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('ok 1', 'not ok 1'),
    // A file wrapper that passed is not its scenarios.
    output.replace('required', 'src/apiserver/build/queue/cursor-runner-gate.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(output, []));
});

test('P1 acceptance guard rejects absent, duplicate and inconsistent summaries', () => {
  const output = tap(['required']);
  for (const invalid of [
    output.replace('# pass 1\n', ''),
    `${output}# pass 1\n`,
    output.replace('# tests 1', '# tests 0'),
    output.replace('# pass 1', '# pass 2'),
    output.replace('# skipped 0', '# skipped 1'),
    output.replace('# todo 0', '# todo 1'),
    output.replace('# cancelled 0', '# cancelled 1'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
});

test('P1 acceptance guard rejects failed, skipped and empty Vitest reports', () => {
  const names = sharedCases['src/cursor-engine.spec.ts'];
  for (const invalid of [
    { ...vitest(names), success: false },
    { ...vitest(names), numPassedTests: names.length - 1 },
    { ...vitest(names), testResults: [{ assertionResults: names.map((title, i) => ({ title, status: i ? 'passed' : 'skipped' })) }] },
    { ...vitest(names), testResults: [{ assertionResults: names.map((title, i) => ({ title, status: i ? 'passed' : 'todo' })) }] },
    { success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] },
  ]) assert.throws(() => assertVitestResults(invalid, names));
  assert.throws(() => assertVitestResults(vitest([]), []));
});

test('P1 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'cursor-engine-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
    assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('P1 acceptance scenario tables name each file once and each scenario once', () => {
  for (const table of [sharedCases, pgCases, apiCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  // Every file named exists where the script looks for it.
  for (const file of Object.keys(sharedCases)) assert.ok(existsSync(path.join(root, 'src/shared', file)), file);
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), file);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), file);
  // Cursor CLI's own scenarios are there beside the existing gates the script requires whole.
  for (const file of ['providers/cursor-engine-migration', 'queue/cursor-runner-gate', 'queue/dsh-provider-gate',
    'queue/gemini-claim-gate', 'providers/antigravity-runtime-migration', 'queue/session-engine-foundation']) {
    assert.ok(Object.hasOwn(pgCases, file), file);
  }
  for (const file of ['queue/opencode-migration-guard', 'runner-api/runner-provider-gate', 'queue/antigravity-migration-guard',
    'runner-api/dsh-provider-gate', 'sessions/dsh-runner-preflight', 'providers/engine-provider']) {
    assert.ok(Object.hasOwn(apiCases, file), file);
  }
  // run-pg-spec.sh keeps the n-th spec's TAP as `<n>-<file name>.tap`.
  assert.equal(pgLogName(0, 'providers/cursor-engine-migration'), '1-cursor-engine-migration.pg.spec.tap');
  assert.equal(pgLogName(6, 'queue/session-engine-foundation'), '7-session-engine-foundation.pg.spec.tap');
});
