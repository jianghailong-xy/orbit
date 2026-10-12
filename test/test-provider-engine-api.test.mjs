import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { runLogged } from '../scripts/test-provider-engine-foundation.mjs';
import {
  apiCases,
  apiPgNames,
  assertNamedWithin,
  criteria,
  pgCases,
  regressionPgSources,
} from '../scripts/test-provider-engine-api.mjs';

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('T3 acceptance guard requires every named PostgreSQL and application scenario', () => {
  assert.ok(apiPgNames.length > 10 && regressionPgSources.length > 0);
  for (const names of [apiPgNames, ...Object.values(apiCases)]) {
    assert.equal(new Set(names).size, names.length, 'a scenario is named twice');
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, '- unmatched\n'), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
    }
  }
});

test('T3 acceptance guard maps every acceptance criterion to a scenario it runs', () => {
  const named = new Set([apiPgNames, ...Object.values(apiCases), ...Object.values(pgCases)].flat());
  const sources = new Set(regressionPgSources);
  assert.equal(Object.keys(criteria).length, 14, 'the task names fourteen acceptance criteria');
  for (const [criterion, proofs] of Object.entries(criteria)) {
    assert.ok(proofs.length > 0, `nothing proves: ${criterion}`);
    for (const proof of proofs) {
      assert.ok(typeof proof === 'string' && (named.has(proof) || sources.has(proof)), `${criterion}: not a scenario the acceptance runs: ${proof}`);
    }
  }
});

test('T3 acceptance guard requires named scenarios inside a larger spec, and the rest of it clean', () => {
  const output = tap(['named', 'another']);
  assert.equal(assertNamedWithin(output, ['named'], 'spec'), 2);
  for (const invalid of [
    output.replace('- named\n', '- renamed\n'),
    output.replace('ok 2 - another', 'not ok 2 - another'),
    output.replace('ok 2 - another', 'ok 2 - another # SKIP'),
    output.replace('# skipped 0', '# skipped 1'),
    `${output}ok 3 - named\n`,
  ]) assert.throws(() => assertNamedWithin(invalid, ['named'], 'spec'));
  assert.throws(() => assertNamedWithin(output, [], 'spec'));
});

test('T3 acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('required', 'required # SKIP'),
    output.replace('required', 'required # TODO'),
    output.replace('ok 1', 'not ok 1'),
    output.replace('required', 'src/apiserver/build/providers/provider-engine-api.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
});

test('T3 acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-api-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
