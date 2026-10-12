import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { assertCleanRun, runLogged } from '../scripts/test-provider-engine-foundation.mjs';
import {
  apiCases,
  criteria,
  migrationPgNames,
  regressionPgSources,
} from '../scripts/test-provider-engine-migration.mjs';

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('T4 acceptance guard requires every named PostgreSQL and application scenario', () => {
  assert.ok(migrationPgNames.length > 10 && regressionPgSources.length > 0);
  for (const names of [migrationPgNames, ...Object.values(apiCases)]) {
    assert.equal(new Set(names).size, names.length, 'a scenario is named twice');
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, '- unmatched\n'), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # TODO\n`), names));
    }
  }
});

test('T4 acceptance guard maps every acceptance criterion to a scenario it runs', () => {
  const named = new Set([migrationPgNames, ...Object.values(apiCases)].flat());
  assert.equal(Object.keys(criteria).length, 9, 'the task names nine acceptance criteria');
  for (const [criterion, proofs] of Object.entries(criteria)) {
    assert.ok(proofs.length > 0, `nothing proves: ${criterion}`);
    for (const proof of proofs) {
      assert.ok(typeof proof === 'string' && named.has(proof), `${criterion}: not a scenario the acceptance runs: ${proof}`);
    }
  }
});

test('T4 acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('required', 'required # SKIP'),
    output.replace('required', 'required # TODO'),
    output.replace('ok 1', 'not ok 1'),
    output.replace('required', 'src/apiserver/build/providers/provider-engine-migration.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  // A regression spec runs clean: everything that ran passed, nothing skipped, left todo or cancelled.
  const clean = tap(['a', 'b']);
  assert.equal(assertCleanRun(clean, 'spec'), 2);
  for (const invalid of [
    clean.replace('ok 2 - b', 'not ok 2 - b'),
    clean.replace('ok 2 - b', 'ok 2 - b # SKIP'),
    clean.replace('# skipped 0', '# skipped 1'),
    clean.replace('# tests 2', '# tests 0'),
  ]) assert.throws(() => assertCleanRun(invalid, 'spec'));
});

test('T4 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-migration-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
