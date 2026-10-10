import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from '../scripts/test-dsh-routing.mjs';
import { assertNamedWithin } from '../scripts/test-provider-engine-api.mjs';
import { assertCleanRun, runLogged } from '../scripts/test-provider-engine-foundation.mjs';
import {
  apiCases,
  assertContractCarriesRuling,
  criteria,
  followupPgNames,
  guardNames,
  pgCases,
  regressionPgSources,
} from '../scripts/test-provider-engine-followups.mjs';

const contract = readFileSync(fileURLToPath(new URL('../docs/provider-engine-contract.md', import.meta.url)), 'utf8');

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test('T3 follow-up acceptance guard requires every named PostgreSQL and application scenario', () => {
  assert.ok(followupPgNames.length === 4 && regressionPgSources.length > 0);
  for (const names of [followupPgNames, ...Object.values(pgCases), ...Object.values(apiCases)]) {
    assert.equal(new Set(names).size, names.length, 'a scenario is named twice');
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, '- unmatched\n'), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
      assert.throws(() => assertTapResults(output.replace(`- ${name}\n`, `- ${name} # TODO\n`), names));
    }
  }
  // A named scenario inside a larger spec has to pass there, once, with the rest of that spec clean.
  const within = tap(['another case', ...apiCases['providers/engine-provider']]);
  assert.equal(assertNamedWithin(within, apiCases['providers/engine-provider'], 'spec'), 2);
  assert.throws(() => assertNamedWithin(tap(['another case']), apiCases['providers/engine-provider'], 'spec'));
  assert.throws(() => assertNamedWithin(within.replace('ok 1 - another case', 'not ok 1 - another case'), apiCases['providers/engine-provider'], 'spec'));
});

test('T3 follow-up acceptance guard maps every acceptance criterion to a scenario it runs', () => {
  const named = new Set([followupPgNames, ...Object.values(pgCases), ...Object.values(apiCases), guardNames].flat());
  assert.equal(Object.keys(criteria).length, 4, 'the task names three behaviours and the contract');
  for (const [criterion, proofs] of Object.entries(criteria)) {
    assert.ok(proofs.length > 0, `nothing proves: ${criterion}`);
    for (const proof of proofs) {
      assert.ok(typeof proof === 'string' && named.has(proof), `${criterion}: not a scenario the acceptance runs: ${proof}`);
    }
  }
});

test('T3 follow-up acceptance guard rejects skips todos failures and wrapper-only TAP', () => {
  const output = tap(['required']);
  for (const invalid of [
    '',
    output.replace('required', 'required # SKIP'),
    output.replace('required', 'required # TODO'),
    output.replace('ok 1', 'not ok 1'),
    output.replace('required', 'src/apiserver/build/tasks/provider-engine-followups.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  // A regression spec runs clean: everything that ran passed, nothing skipped, left todo or cancelled.
  const clean = tap(['a', 'b']);
  assert.equal(assertCleanRun(clean, 'spec'), 2);
  for (const invalid of [
    clean.replace('ok 2 - b', 'not ok 2 - b'),
    clean.replace('ok 2 - b', 'ok 2 - b # SKIP'),
    clean.replace('# skipped 0', '# skipped 1'),
    clean.replace('# todo 0', '# todo 1'),
    clean.replace('# tests 2', '# tests 0'),
  ]) assert.throws(() => assertCleanRun(invalid, 'spec'));
});

test('T3 follow-up acceptance guard rejects missing executables and startup failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-engine-followups-startup-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('T3 follow-up acceptance guard finds the ruling written into the contract: §3.6, §4.5, §6.2, §6.4 and §10', () => {
  assertContractCarriesRuling(contract);
  // Each part of the ruling is checked, not merely the document's presence: undoing any one is red.
  for (const [undone, by] of [
    ['§4.5 exception', (doc) => doc.replace(/- 例外：存着 Claude 订阅 token[^\n]*\n/, '')],
    ['§4.5 API key', (doc) => doc.replace('普通 API key 也不再记为 blind', '普通 API key 记为 blind')],
    ['§6.4 comment', (doc) => doc.replace("written as the sign-in's slug", 'or null for the sign-in')],
    ['§3.6 window', (doc) => doc.replace(/  - 检查是先查后写[^\n]*\n/, '')],
    ['§6.2 handoff', (doc) => doc.replace(/- 跨项目移交的摘要[^\n]*\n/, '')],
    ['§10 date', (doc) => doc.replace('2026-10-09，协调会话对 T3 交付说明', '协调会话对 T3 交付说明')],
    ['§10 row', (doc) => doc.replace(/^\| 9 \|[^\n]*\n/m, '')],
  ]) {
    const edited = by(contract);
    assert.notEqual(edited, contract, `the mutation for ${undone} matched nothing`);
    assert.throws(() => assertContractCarriesRuling(edited), assert.AssertionError, `undoing ${undone} went unnoticed`);
  }
});
