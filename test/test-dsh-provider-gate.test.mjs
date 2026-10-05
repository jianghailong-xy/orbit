import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { mandatoryApiCases, mandatoryPgNames, runLogged } from '../scripts/test-dsh-provider-gate.mjs';

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('P1b acceptance guard requires every mandatory PostgreSQL and application scenario', () => {
  for (const names of [mandatoryPgNames, ...Object.values(mandatoryApiCases)]) {
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(name, 'unmatched'), names));
      assert.throws(() => assertTapResults(output.replace(name, `${name} # SKIP`), names));
    }
  }
});

test('P1b acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('required', 'required # SKIP'),
    output.replace('required', 'required # TODO'),
    output.replace('ok 1', 'not ok 1'),
    output.replace('required', 'src/apiserver/build/queue/dsh-provider-gate.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(output, []));
});

test('P1b acceptance guard rejects absent duplicate and inconsistent summaries', () => {
  const output = tap(['required']);
  for (const invalid of [
    output.replace('# pass 1\n', ''),
    `${output}# pass 1\n`,
    output.replace('# tests 1', '# tests 0'),
    output.replace('# pass 1', '# pass 2'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
});

test('P1b acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-provider-gate-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('P1b acceptance runs node:test with regular-file output and visible scenario names', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-provider-gate-output-'));
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
