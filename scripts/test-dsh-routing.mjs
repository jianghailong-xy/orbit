import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what the test runner happens to discover.
const sharedNames = [
  'P1a registers a resident ACP runtime without claiming steer support',
  'P1a keeps the legacy DeepSeek preset on Claude and adds an explicit Harness API Key preset',
  'P1a preserves opaque Harness model and reasoning options with unknown context windows',
  'P1a refuses unsupported Harness permission and fast-mode claims including defaults',
  'P1a preserves other built-in model and transport routes',
];
export const permissionRegressionNames = [
  'an ask-me mode is honored only where the runtime can reach a human',
  "Don't Ask means deny everywhere a runtime can withhold, and is unenforced on Codex",
  'Auto and Bypass are honored by supported runtimes and rejected on DeepSeek Harness',
  'Auto is unavailable on DeepSeek Harness and only Claude gates it per model',
  'DeepSeek Harness rejects every permission mode with partial approval and explanatory notes',
  'Auto on a Claude model without it is disclosed, not hidden',
  'a caveat is carried as data exactly when the mode is not honored',
  'approval support is reported per runtime',
  'a session payload carries the semantics of the runtime that runs it',
  'a custom provider omits the field rather than guessing its borrowed runtime',
  'a row with no provider information still derives lifecycle capabilities',
  'an Antigravity session payload says what its mode means on agy, not on Claude',
];
const apiCases = {
  'common/permission-semantics': permissionRegressionNames,
  'common/dsh-runtime-routing': [
    'P1a runtime identity keeps legacy DeepSeek and other engines compatible',
    'P1a dsh initializes its own session id and preserves opaque live model defaults',
    'P1a dsh effort routing preserves opaque values and obeys the live model catalog',
    'P1a dsh rejects unverified permission modes including account defaults',
  ],
  'providers/dsh-provider': [
    'P1a existing DeepSeek configuration keeps Claude for new tasks',
    'P1a historical DeepSeek model pins stay on Claude',
    'P1a explicit Harness preset resolves dsh with dedicated API key',
    'P1a dsh models use opaque runtime defaults without static fallback',
    'P1a dsh keyword collisions preserve configured providers and pools',
    'P1a new provider slugs reserve dsh without renaming old rows',
    'P1a legacy dsh provider edits preserve its runtime and slug',
    'P1a provider history blocks cross-runtime dsh conversion',
    'P1a dsh configuration rejects static model guesses',
    'P1a dsh DTOs accept its runtime and HTTP probes require runtime validation',
    'P1a other built-in engine routes remain unchanged',
  ],
  'sessions/dsh-session-routing': [
    'dsh compatibility: legacy DeepSeek new session and task still dispatch on Claude',
    'dsh compatibility: inherited legacy DeepSeek task retains the configured Claude runtime',
    'dsh compatibility: legacy DeepSeek history resumes with the same Claude id model and environment',
    'dsh compatibility: existing dsh provider and pool slugs stay configured on creation and switching',
    'dsh compatibility: Claude and Harness histories refuse cross-runtime resume and config switches',
    'dsh compatibility: a disabled existing dsh provider is unavailable instead of becoming the built-in engine',
    'dsh admission: unverified permission policies reject explicit account and code defaults before creation',
    'dsh admission: terminal Harness resume refuses an unverified permission policy without rewriting its id',
    'dsh compatibility: other built-in engine creation and runtime routes remain unchanged',
    'dsh admission: Harness history cannot move to a different workspace',
  ],
  'tasks/dsh-task-routing': [
    'P1a new task route keeps existing DeepSeek provider on Claude',
    'P1a task routing uses the explicit Harness runtime and live model space',
    'P1a pinned dsh task preserves an existing provider or pool collision',
    'P1a task routing preserves every other built-in engine',
  ],
  'queue/dsh-pool-routing': [
    'P1a colliding dsh account pool keeps manual pause and quota wakeup',
    'P1a colliding dsh pool keeps the selected member pause',
    'P1a colliding dsh pool keeps shared and login credential retries',
    'P1a native dsh and other builtins avoid session pool reads',
    'P1a runner quota retry uses the colliding dsh pool discriminator',
  ],
};
const guardNames = [
  'acceptance guard rejects missing or unmatched named tests',
  'acceptance guard rejects skips todos failures and file-only passes',
  'acceptance guard rejects absent or inconsistent summaries',
  'acceptance guard rejects failed skipped and empty Vitest reports',
  'acceptance guard rejects missing executables and startup failures',
  'acceptance guard requires every named permission regression without skips',
];

export function assertTapResults(output, names) {
  assert.ok(names.length > 0, 'no mandatory scenarios declared');
  assert.doesNotMatch(output, /^\s*(?:not ok\b|ok \d+ - .*#\s*(?:SKIP|TODO)\b)/im, 'failed, skipped or todo scenario');
  const passed = [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((match) => match[1]);
  for (const name of names) {
    assert.equal(passed.filter((value) => value === name).length, 1, `missing or unmatched scenario: ${name}`);
  }
  for (const [key, expected] of Object.entries({ tests: names.length, pass: names.length, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const summaries = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    assert.equal(summaries.length, 1, `missing or duplicate ${key} summary`);
    assert.equal(Number(summaries[0][1]), expected, `unexpected ${key} count`);
  }
}

export function assertVitestResults(report, names) {
  assert.ok(names.length > 0, 'no mandatory scenarios declared');
  assert.equal(report.success, true, 'Vitest did not succeed');
  assert.equal(report.numTotalTests, names.length, 'missing shared scenarios');
  assert.equal(report.numPassedTests, names.length, 'shared scenarios did not all pass');
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(cases.length, names.length, 'missing shared result records');
  assert.ok(cases.every((entry) => entry.status === 'passed'), 'failed or skipped shared scenario');
  for (const name of names) {
    assert.equal(cases.filter((entry) => entry.title === name).length, 1, `missing or unmatched shared scenario: ${name}`);
  }
}

export function runLogged(command, args, log, cwd = root) {
  const fd = openSync(log, 'w');
  let result;
  try {
    // Regular files for both streams: node:test never writes its IPC/output into a pipe.
    result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_OPTIONS: '' }, timeout: 120_000 });
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, 'utf8');
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`test startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return output;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-routing-'));
  let total = 0;
  try {
    const runTap = (file, names) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // Node 26 process isolation can report just a passing file wrapper. Serial in-process
      // execution exposes the named cases; the validator also rejects that wrapper-only result.
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'));
      process.stdout.write(output);
      assertTapResults(output, names);
      total += names.length;
    };
    runTap(path.join(root, 'test/test-dsh-routing.test.mjs'), guardNames);
    const sharedFile = path.join(root, 'src/shared/src/dsh-routing.spec.ts');
    assert.ok(existsSync(sharedFile), `missing required test file: ${sharedFile}`);
    const reportPath = path.join(scratch, 'shared.json');
    const output = runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', 'src/dsh-routing.spec.ts', '--reporter=json', `--outputFile=${reportPath}`], path.join(scratch, 'vitest.log'), path.join(root, 'src/shared'));
    process.stdout.write(output);
    assertVitestResults(JSON.parse(readFileSync(reportPath, 'utf8')), sharedNames);
    for (const name of sharedNames) process.stdout.write(`PASS ${name}\n`);
    total += sharedNames.length;
    for (const [file, names] of Object.entries(apiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
      runTap(path.join(root, `src/apiserver/build/${file}.spec.js`), names);
    }
    process.stdout.write(`P1a acceptance passed: ${total} named scenarios, none missing or skipped.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
