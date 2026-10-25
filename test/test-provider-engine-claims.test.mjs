import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { runLogged } from '../scripts/test-provider-engine-foundation.mjs';
import { assertNamedWithin } from '../scripts/test-provider-engine-api.mjs';
import { claimSpecs } from '../scripts/test-provider-engine-claims.mjs';

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('claims acceptance guard names the eight specs and the cases 0414 turned red in each', () => {
  // The eight the task names, by file: seven claimed by hand (cause A), one built its own table (cause B).
  assert.deepEqual(Object.keys(claimSpecs).map((source) => path.basename(source, '.pg.spec.ts')).sort(), [
    'auto-retry-startup-failure',
    'background-wake-steer-retry',
    'project-coordinator-end-to-end',
    'project-exception-todos',
    'session-reply-steer',
    'session-request',
    'steer-dequeue',
    'task-source-refusal-visible',
  ]);
  for (const [source, names] of Object.entries(claimSpecs)) {
    assert.match(source, /^src\/apiserver\/src\/[a-z-]+\/[a-z0-9-]+\.pg\.spec\.ts$/);
    assert.ok(names.length > 0, `${source}: no case named`);
    assert.equal(new Set(names).size, names.length, `${source}: a case is named twice`);
  }
});

test('claims acceptance guard requires every named case once, in a spec that ran clean', () => {
  for (const [source, names] of Object.entries(claimSpecs)) {
    const output = tap([...names, 'a case 0414 never touched']);
    assert.equal(assertNamedWithin(output, names, source), names.length + 1);
    for (const name of names) {
      assert.throws(() => assertNamedWithin(output.replace(`- ${name}\n`, '- unmatched\n'), names, source));
      assert.throws(() => assertNamedWithin(output.replace(`- ${name}\n`, `- ${name} # SKIP\n`), names, source));
      assert.throws(() => assertNamedWithin(`${output}    ok 99 - ${name}\n`, names, source));
    }
    assert.throws(() => assertNamedWithin(output.replace(/ok (\d+) - a case 0414/, 'not ok $1 - a case 0414'), names, source));
  }
});

test('claims acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const [source, names] = Object.entries(claimSpecs)[0];
  const output = tap(names);
  for (const invalid of [
    '',
    output.replace('# skipped 0', '# skipped 1'),
    output.replace('# todo 0', '# todo 1'),
    output.replace('# fail 0', '# fail 1'),
    output.replace(`- ${names[0]}`, `- ${names[0]} # TODO`),
    output.replace('ok 1', 'not ok 1'),
    tap([source.replace('/src/', '/build/').replace(/\.ts$/, '.js')]),
  ]) assert.throws(() => assertNamedWithin(invalid, names, source));
  assert.throws(() => assertTapResults(output.replace('ok 1', 'not ok 1'), names));
});

test('claims acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-claims-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
