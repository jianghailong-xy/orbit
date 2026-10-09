import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import {
  assertCleanRun,
  foundationApiCases,
  foundationPgNames,
  regressionPgSources,
  runLogged,
} from '../scripts/test-provider-engine-foundation.mjs';

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('T2 acceptance guard requires every named PostgreSQL and application scenario', () => {
  assert.ok(foundationPgNames.length > 20 && regressionPgSources.length > 0);
  for (const names of [foundationPgNames, ...Object.values(foundationApiCases)]) {
    assert.equal(new Set(names).size, names.length, 'a scenario is named twice');
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, '- unmatched\n'), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
    }
  }
});

test('T2 acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('required', 'required # SKIP'),
    output.replace('required', 'required # TODO'),
    output.replace('ok 1', 'not ok 1'),
    output.replace('required', 'src/apiserver/build/queue/session-engine-foundation.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(output, []));
});

test('T2 acceptance guard rejects a regression run that failed, skipped or ran nothing', () => {
  const output = tap(['one', 'two']);
  assert.equal(assertCleanRun(output, 'clean'), 2);
  for (const invalid of [
    '',
    output.replace('# tests 2', '# tests 0').replace('# pass 2', '# pass 0'),
    output.replace('# pass 2', '# pass 1'),
    output.replace('# fail 0', '# fail 1'),
    output.replace('# skipped 0', '# skipped 1'),
    output.replace('# todo 0', '# todo 1'),
    output.replace('# cancelled 0', '# cancelled 1'),
    output.replace('ok 2 - two', 'ok 2 - two # SKIP'),
    output.replace('ok 1 - one', 'not ok 1 - one'),
    `${output}# pass 2\n`,
  ]) assert.throws(() => assertCleanRun(invalid, 'invalid'));
});

test('T2 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-foundation-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('T2 acceptance runs node:test with regular-file output and visible scenario names', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-foundation-output-'));
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
