// Acceptance for the Context/Speed follow-up of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO; task
// 34iDjteT5qGcwXKjAUKj1): a Cursor CLI session names its model's context size and fast lane in its model
// value, the way Cursor writes a variant — `claude-opus-5-5[context=1m,fast=true]`, with the effort in the
// session's effort and Auto the bare `default` (docs/cursor-runtime-contract.md §10). Covered, each by the
// scenarios named below:
//   - the runner selects the bare model, then the context and fast lane the session chose — the model's
//     default for one its value leaves out — with session/set_config_option; a setting or value the model
//     does not list is left at the model's own and logged; Auto sets nothing. On P0's
//     parameterized-model-picker recording, replayed by src/runner-go/fake_cursor_acp_test.go;
//   - shared's encodeCursorModel and decodeCursorModel (src/shared/src/cursorModels.ts), and the server,
//     which keeps a variant as long as the runner's catalogue lists its model;
//   - the web's model menu offers Context and Speed on a model that has them, and its chip reads
//     "Model Effort · Context · Speed", as the T0 board's Web 5 draws it;
//   - every other engine's model menu and its Speed (the engine's fast mode) are unchanged.
// Run from the repository root:
//
//   node scripts/test-cursor-model-variants.mjs
//
// Every named scenario below is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit.
// The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs,
// scripts/test-dsh-mcp-approval.mjs, scripts/test-dsh-failure-semantics.mjs and
// scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own names
// before they are trusted. Every test process writes to a regular file, never into a pipe. Every real
// engine CLI and Cursor's own commands are replaced on PATH by stubs that fail, and the runner user's real
// ~/.cursor family is fingerprinted before and after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { assertNamedTap } from './test-dsh-mcp-approval.mjs';
import { assertVitestNamed } from './test-dsh-failure-semantics.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory Go scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_model_variants_test.go': [
    'TestCursorModelVariants',
    // After the bare model and before the effort, the context and fast lane the session chose: the model
    // and its context as P0 sent them to the real CLI, the fast lane answered the way the recording shows.
    'TestCursorModelVariants/context-and-fast',
    // A setting the model does not list, or a value it does not offer: left at the model's own, and logged.
    'TestCursorModelVariants/setting-the-model-lacks',
    'TestCursorModelVariants/value-the-model-lacks',
    // Auto sets nothing, whatever its value names.
    'TestCursorModelVariants/auto',
    // The mode and the effort are not the model value's to set; a setting already in effect is not set again.
    'TestCursorModelVariants/only-context-and-fast',
    'TestCursorModelVariants/settings-already-current',
    // A setting the value does not name goes back to the model's default the runner's catalogue lists, and is
    // left as the process has it while there is no catalogue.
    'TestCursorModelVariants/unnamed-settings-take-the-default',
    'TestCursorModelVariants/no-catalogue',
    // A live session told its new value sets only what moved.
    'TestCursorModelVariants/reload',
    // The runner reads a model value as shared does.
    'TestCursorModelVariants/decode',
  ],
  'cursor_acp_test.go': [
    // P5a's model and effort, as before.
    'TestCursorACPInitializeAndNewSession',
    'TestCursorACPInitializeAndNewSession/model-and-effort',
  ],
  'cursor_models_test.go': [
    // The catalogue the clients take the rows from: each model's context sizes and fast lane, with defaults.
    'TestCursorModelCatalogParsesVariants',
  ],
};

// Shared: the encoding, required whole; and Cursor CLI still declaring no engine-level fast mode.
export const sharedCases = {
  'src/cursor-model-variants.spec.ts': [
    'Cursor variants: a model value carries context and fast in brackets, and reads back the same',
    "Cursor variants: Auto takes no settings, and a setting with no value or at the model's default is left out",
    'Cursor variants: a value not written as a variant is a model name as it stands',
    "Cursor variants: a variant is its model's row in the catalogue, on Cursor CLI alone",
  ],
};
export const sharedRegressions = {
  'src/cursor-engine.spec.ts': ['P1 cursor is one resident JSON-RPC process per session with no mid-turn steer and no fast lane'],
};

// The API server: a variant kept while its model is offered, required whole; and the Cursor routes before it.
export const apiCases = {
  'common/cursor-model-variants': [
    'Cursor variants: a bracketed variant is kept, never replaced by Auto',
    'Cursor variants: a variant whose model left the catalogue is retired as usual',
    "Cursor variants: a variant's effort is checked against its model's levels",
    'Cursor variants: other engines judge their model ids exactly as before',
  ],
};
export const apiRegressions = {
  'common/cursor-runtime-routing': [
    'P1 a Cursor CLI sign-in session is built for the runner on Cursor CLI alone',
    'P1 Cursor CLI effort values are opaque and the live catalogue decides them',
  ],
  'providers/cursor-api-key': ['P2 dispatch hands a Cursor key to Cursor CLI as ORBIT_CURSOR_API_KEY, and a sign-in session no typed one'],
};

// The web, in one Vitest run: every test of these files passes, and the named ones among them.
export const webCases = {
  files: [
    'src/lib/cursorModelVariants.test.ts',
    'src/components/WorkspaceView.cursor.test.tsx',
    'src/components/WorkspaceView.modelControl.test.tsx',
    'src/components/WorkspaceView.projectIntent.test.tsx',
    'src/copyLanguage.test.ts',
  ],
  names: [
    // A model value read against the runner's catalogue.
    'Cursor variants: a value is read as its model and the settings it names',
    'Cursor variants: Context and Speed are offered where the model lists them, at the value in effect',
    'Cursor variants: the chip names a context other than the model’s own, and Fast while it is on',
    'Cursor variants: a variant is kept as long as its model is offered, with its model’s efforts',
    // The composer's model menu and chip (board Web 5 ①): Effort, Context, Speed; Auto with none.
    'Cursor variants: a model with a context size and a fast lane offers Context and Speed under Effort, and the chip names them',
    "Cursor variants: picking a context or a speed writes it into the session's model value",
    'Cursor variants: a model shows only the rows its catalogue lists, and Fast only while it is on',
    'titles its model menu Cursor CLI, offers Auto with a line instead of an effort, and no Default effort label',
    // Every other engine's menu and its Speed, the engine's fast mode, as they were.
    'Cursor variants: another engine keeps its own Speed row and menu, with no Context row',
    'writes the model and its effort as one control, with the provider and the effort a level down',
    'leaves the session config alone when the pick is already running, and PATCHes a change once',
    'still defines exactly three toolbar pills and the four fields behind the model control',
    // Product copy in English.
    'holds Chinese only in the files ALLOWED lists, at exactly their counts',
  ],
};

// The reused TypeScript guards, held to this script's names: a complete report passes, and a missing,
// failed, skipped, pending, todo, renamed or repeated scenario, an empty report, one that did not succeed
// and output without its summary are each refused.
function checkTypeScriptGuards() {
  const refused = (label, check) => assert.throws(check, undefined, `the guard accepted ${label}`);
  const vitest = (cases) => ({
    success: cases.every((entry) => entry.status === 'passed'),
    numTotalTests: cases.length,
    numPassedTests: cases.filter((entry) => entry.status === 'passed').length,
    numFailedTests: cases.filter((entry) => entry.status === 'failed').length,
    numPendingTests: cases.filter((entry) => entry.status === 'skipped' || entry.status === 'pending').length,
    numTodoTests: cases.filter((entry) => entry.status === 'todo').length,
    testResults: [{ assertionResults: cases }],
  });
  const passing = (names) => names.map((title) => ({ title, status: 'passed' }));
  for (const [guard, names] of [[assertVitestResults, Object.values(sharedCases).flat()], [assertVitestNamed, webCases.names]]) {
    const [first, ...rest] = names;
    guard(vitest(passing(names)), names);
    refused('a missing scenario', () => guard(vitest(passing(rest)), names));
    for (const status of ['failed', 'skipped', 'pending', 'todo']) {
      refused(`a ${status} scenario`, () => guard(vitest([{ title: first, status }, ...passing(rest)]), names));
    }
    refused('a renamed scenario', () => guard(vitest(passing([`${first} (renamed)`, ...rest])), names));
    refused('a repeated scenario', () => guard(vitest(passing([first, ...names])), names));
    refused('an empty report', () => guard(vitest([]), names));
    refused('a report that did not succeed', () => guard({ ...vitest(passing(names)), success: false }, names));
  }
  const tap = (rows) => {
    const failed = rows.filter(([, result]) => result === 'not ok').length;
    return `TAP version 13\n${rows.map(([title, result = 'ok'], i) => `${result} ${i + 1} - ${title}\n`).join('')}` +
      `1..${rows.length}\n# tests ${rows.length}\n# pass ${rows.length - failed}\n# fail ${failed}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  };
  for (const [guard, names, others] of [
    [assertTapResults, Object.values(apiCases).flat(), []],
    [assertNamedTap, Object.values(apiRegressions).flat(), ['another test of the file']],
  ]) {
    const [first, ...rest] = names;
    const rows = (list) => [...list, ...others].map((title) => [title]);
    guard(tap(rows(names)), names);
    refused('a missing scenario', () => guard(tap(rows(rest)), names));
    refused('a failed scenario', () => guard(tap([[first, 'not ok'], ...rows(rest)]), names));
    refused('a skipped scenario', () => guard(tap(rows([`${first} # SKIP`, ...rest])), names));
    refused('a todo scenario', () => guard(tap(rows([`${first} # TODO`, ...rest])), names));
    refused('a renamed scenario', () => guard(tap(rows([`${first} (renamed)`, ...rest])), names));
    refused('a repeated scenario', () => guard(tap(rows([first, ...names])), names));
    refused('output without its summary', () => guard(tap(rows(names)).replace(/^# pass \d+\n/m, ''), names));
    refused('no output', () => guard('', names));
  }
}

function runTypeScript(scratch) {
  const api = path.join(root, 'src/apiserver');
  assert.ok(existsSync(path.join(root, 'node_modules/.bin/tsc')), 'missing root node_modules; run bash scripts/worktree-overlay.sh first');
  const vitest = path.join(root, 'node_modules/.bin/vitest');
  let count = 0;
  // Shared first: the API server reads it from its build.
  runLogged('npm', ['run', 'build', '-w', '@orbit/shared'], path.join(scratch, 'shared-build.log'), { cwd: root, timeout: 10 * 60_000 });
  for (const [cases, guard] of [[sharedCases, assertVitestResults], [sharedRegressions, assertVitestNamed]]) {
    for (const [file, names] of Object.entries(cases)) {
      assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing required test file: src/shared/${file}`);
      const report = path.join(scratch, `${path.basename(file)}.json`);
      const output = runLogged(vitest, ['run', file, '--reporter=json', `--outputFile=${report}`], path.join(scratch, 'shared-vitest.log'),
        { cwd: path.join(root, 'src/shared'), timeout: 10 * 60_000 });
      process.stdout.write(output);
      assert.ok(existsSync(report), `Vitest wrote no report for ${file}`);
      guard(JSON.parse(readFileSync(report, 'utf8')), names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      count += names.length;
    }
  }
  rmSync(path.join(api, 'build'), { recursive: true, force: true });
  runLogged(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.test.json'], path.join(scratch, 'api-tsc.log'), { cwd: api, timeout: 10 * 60_000 });
  for (const [cases, guard] of [[apiCases, assertTapResults], [apiRegressions, assertNamedTap]]) {
    for (const [file, names] of Object.entries(cases)) {
      assert.ok(existsSync(path.join(api, `src/${file}.spec.ts`)), `missing required test source: ${file}`);
      const spec = path.join(api, `build/${file}.spec.js`);
      assert.ok(existsSync(spec), `missing compiled test: ${spec}`);
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, `${path.basename(file)}.tap`), { cwd: api });
      process.stdout.write(output);
      guard(output, names);
      count += names.length;
    }
  }
  for (const file of webCases.files) {
    assert.ok(existsSync(path.join(root, 'src/web', file)), `missing required test file: src/web/${file}`);
  }
  const report = path.join(scratch, 'web.json');
  runLogged(vitest, ['run', ...webCases.files, '--reporter=json', `--outputFile=${report}`], path.join(scratch, 'web-vitest.log'),
    { cwd: path.join(root, 'src/web'), timeout: 20 * 60_000 });
  assert.ok(existsSync(report), 'Vitest wrote no web report');
  const web = JSON.parse(readFileSync(report, 'utf8'));
  assertVitestNamed(web, webCases.names);
  // Every file ran: a file that failed to load reports no case of its own.
  const ran = new Set(web.testResults.map((suite) => path.relative(path.join(root, 'src/web'), suite.name)));
  for (const file of webCases.files) assert.ok(ran.has(file), `the web run has no result for ${file}`);
  for (const name of webCases.names) process.stdout.write(`PASS ${name}\n`);
  process.stdout.write(`PASS every one of the ${web.numTotalTests} web tests in ${webCases.files.length} files.\n`);
  return count + webCases.names.length;
}

function runGo(scratch) {
  const names = Object.values(mandatoryGoCases).flat();
  for (const file of Object.keys(mandatoryGoCases)) {
    assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
  }
  assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor/parameterized-model-picker/acp/stdout.jsonl')),
    'missing the parameterized-model-picker recording');
  checkGuards(names, scratch);
  process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');
  const blockedBin = path.join(scratch, 'blocked-bin');
  mkdirSync(blockedBin, { mode: 0o700 });
  for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx', 'direnv']) {
    writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "Cursor variant tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
  }
  // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
  const loginHome = userInfo().homedir;
  const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
    path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
  const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
    cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
  });
  process.stdout.write(output);
  assertGoResults(output, names);
  for (const name of names) process.stdout.write(`PASS ${name}\n`);
  return names.length;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-model-variants-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    checkTypeScriptGuards();
    process.stdout.write('PASS the reused Vitest and TAP guards refuse missing, renamed, repeated, failed, skipped and todo scenarios.\n');
    const runner = runGo(scratch);
    const typescript = runTypeScript(scratch);
    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`Cursor model variants acceptance passed: ${runner} named runner scenarios and ${typescript} shared, API server ` +
      'and web scenarios, none missing, unmatched or skipped.\n');
  } finally {
    if (changed().length !== 0) {
      process.stderr.write(`The runner user's Cursor CLI directories changed (${changed().join(', ')}); logs kept at ${scratch}\n`);
      process.exitCode = 1;
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
