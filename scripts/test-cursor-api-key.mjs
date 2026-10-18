// Acceptance for project P2 (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): a Cursor API key saved in Orbit.
// It is a key on Cursor's own dialect under the Cursor preset, which Cursor CLI alone runs on; the API's
// and MCP's doors resolve an engine and the key, the key alone, the engine alone and neither, and refuse
// it on any other engine (PROVIDER_ENGINE_INCOMPATIBLE); dispatch hands it to the session's runner as
// ORBIT_CURSOR_API_KEY, and the runner starts Cursor CLI with it as CURSOR_API_KEY, credentials held in
// memory and nothing written to disk; `agent models` checks it first, an invalid key ending the start
// with CURSOR_API_KEY_INVALID and being kept on the key as INVALID; and no log, event, database row or
// API response holds it. Run from the repository root:
//
//   node scripts/test-cursor-api-key.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero
// exit. The guards are scripts/test-dsh-routing.mjs's (TAP and Vitest), scripts/test-dsh-provider-gate.mjs's
// runLogged and scripts/test-dsh-runtime-environment.mjs's (Go), reused as they are and checked here
// against this script's own names before they are trusted. The PostgreSQL scenarios run through
// scripts/run-pg-spec.sh on a throwaway server, which also compiles the API server's test tree the
// application scenarios then run from. The Go scenarios run with every real engine CLI, Cursor's own
// commands and the download tools replaced on PATH by stubs that fail, and the runner user's real
// ~/.cursor family is fingerprinted before and after: any change fails the run.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';
import {
  assertGoResults,
  goTestPattern,
  harnessDirectoryFingerprint,
  runLogged as runGoLogged,
  runnerEnvironment,
} from './test-dsh-runtime-environment.mjs';
import { userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover.
export const sharedCases = {
  // The Cursor preset and dialect, and the compatibility table's row for a Cursor key.
  'src/cursor-api-key.spec.ts': [
    'P2 the Cursor preset is a key of the vendor Cursor, on Cursor’s own dialect, with no model list of its own',
    'P2 a Cursor key runs on Cursor CLI alone, and every other key and engine keeps its own',
  ],
  // The compatibility table every client and the server share (docs/provider-engine-contract.md §2.1).
  'src/providerEngines.spec.ts': [
    'lists every engine once, each under its CLI name',
    'runs a sign-in, a pool and OpenCode config on their own engine only',
    'runs a key on its dialect’s own engine first, then OpenCode',
    'adds DeepSeek Harness for a DeepSeek key, preset or custom host alike',
    'keeps a row still on the dsh runtime on DeepSeek Harness by default',
    'runs a Claude subscription token on Claude Code alone',
    'runs a key on a protocol no engine speaks nowhere',
    'is the engine the credential ran on before the split',
    'pairs an engine with a credential only where the table allows it',
    'is the two presets, else a custom endpoint on api.deepseek.com',
  ],
  // The vendor catalogue's shape, the Cursor preset in it.
  'src/providerPresets.spec.ts': [
    'has a unique, dispatchable slug per vendor',
    'offers at least one model, and defaults to one of them',
    'keeps every maintained list on a catalogue that recognizes its own models',
    'points at an https endpoint',
    'runs Kimi on the Kimi CLI, pointed at the API that CLI speaks',
    'runs Gemini on the Antigravity CLI, pointed at the API that CLI speaks',
    'resolves a preset only for a slug it knows',
  ],
  // Cursor CLI's sign-in still runs on Cursor CLI alone (P1), beside its key.
  'src/cursor-engine.spec.ts': [
    'P1 cursor is the seventh engine under its CLI name, with an opaque model space defaulting to Auto',
    'P1 a runner sign-in to cursor runs on cursor alone, and no other credential runs on cursor',
    'P1 cursor is one resident JSON-RPC process per session with no mid-turn steer and no fast lane',
    'P5c cursor keeps Accept Edits, Plan, Auto, Don’t Ask and Bypass, and refuses Default with a note',
    'P1 the six existing engines keep their names, transports, steer and permission tables',
  ],
};

export const pgCases = {
  'providers/cursor-api-key': [
    'P2 a Cursor key is saved encrypted under the Cursor preset, and every list says it runs on Cursor CLI alone',
    'P2 the API resolves engine and provider, provider alone, engine alone and neither on a Cursor key',
    'P2 MCP resolves engine and provider, provider alone, engine alone and neither on a Cursor key',
    'P2 a Cursor key on any other engine, and any other key on Cursor CLI, is refused PROVIDER_ENGINE_INCOMPATIBLE at every door',
    'P2 dispatch hands the session’s own runner the key as ORBIT_CURSOR_API_KEY, on Cursor CLI',
    'P2 a runner’s check of a Cursor key is kept on the key, an invalid one plainly, and a replaced key is unchecked',
    'P2 no log line, event, database row or API response holds a Cursor key; only its runner’s claim does',
    'P2 Cursor API key on PostgreSQL',
  ],
};

export const apiCases = {
  'providers/cursor-api-key': [
    'P2 a Cursor key is its own dialect: Cursor CLI alone runs it, on the models Cursor CLI reports',
    'P2 dispatch hands a Cursor key to Cursor CLI as ORBIT_CURSOR_API_KEY, and a sign-in session no typed one',
    'P2 a Cursor key on any other engine, and any other key on Cursor CLI, is refused PROVIDER_ENGINE_INCOMPATIBLE',
    'P2 the server never spends a Cursor key itself: no held key, no quota probe, no pool, no connection test',
  ],
};

export const goCases = {
  'cursor_api_key_test.go': [
    // Injected as CURSOR_API_KEY, credentials in memory, checked with `agent models` first, written nowhere.
    'TestCursorAPIKeyLaunchInjectsTheKeyInMemory',
    // An invalid key's clear state: CURSOR_API_KEY_INVALID, reported INVALID, nothing started.
    'TestCursorAPIKeyRefusedByCursorStartsNothing',
    'TestCursorAPIKeyUnreachableOrUnreadIsNoRefusal',
    'TestCursorAPIKeyCheckReachesTheControlPlaneByFingerprint',
    'TestCursorAPIKeyOnlyWhenDispatchedOne',
  ],
  'cursor_launch_test.go': [
    // P3's launch preparation, which now carries the key, keeps every other promise it made.
    'TestCursorLaunchSpecIsolatesSessionDirectories',
    'TestCursorLaunchSpecWhitelistsEnvironment',
    'TestCursorNeverWritesRealCursorHome',
  ],
  'cursor_health_test.go': [
    // The health probe shares `agent models` with the key check.
    'TestCursorHealthStates',
    'TestCursorHealthStates/not-installed',
    'TestCursorHealthStates/version-mismatch',
    'TestCursorHealthStates/platform-unsupported',
    'TestCursorHealthStates/signed-out',
    'TestCursorHealthStates/signed-in',
    'TestCursorHealthStates/handshake-is-not-a-credential',
  ],
  'user_credential_env_test.go': [
    // The session launch is one of the environments held to the runner's credential rule.
    'TestAgentEnvironmentsWithholdUserCredentials',
    'TestAgentEnvironmentsWithholdUserCredentials/census',
    'TestAgentEnvironmentsWithholdUserCredentials/cursor',
  ],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (1-based). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n`
    + `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function vitest(names) {
  return {
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: [{ assertionResults: names.map((title) => ({ title, status: 'passed' })) }],
  };
}

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

/**
 * The reused guards, held to this script's names before they are trusted: a complete run passes, and a
 * missing, unmatched, skipped, todo, failed or repeated scenario, an absent or inconsistent summary, a
 * file wrapper that passed, a test process that cannot start and one that exits non-zero are each refused.
 */
export function checkGuards(scratch) {
  const refused = (label, run) => assert.throws(run, undefined, `the guard accepted ${label}`);
  for (const names of [...Object.values(pgCases), ...Object.values(apiCases)]) {
    assertTapResults(tap(names), names);
    for (const name of names) {
      refused(`a missing ${name}`, () => assertTapResults(tap(names.filter((other) => other !== name)), names));
      refused(`an unmatched ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, '- unmatched\n'), names));
      refused(`a skipped ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
      refused(`a todo ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, `- ${name} # TODO\n`), names));
    }
  }
  const one = tap(['required']);
  for (const [label, invalid] of [
    ['no output', ''],
    ['a failed scenario', one.replace('ok 1', 'not ok 1')],
    ['a file wrapper that passed', one.replace('required', 'src/apiserver/build/providers/cursor-api-key.pg.spec.js')],
    ['a missing summary', one.replace('# pass 1\n', '')],
    ['a duplicate summary', `${one}# pass 1\n`],
    ['an inconsistent count', one.replace('# tests 1', '# tests 2')],
    ['a skipped count', one.replace('# skipped 0', '# skipped 1')],
    ['a todo count', one.replace('# todo 0', '# todo 1')],
    ['a cancelled count', one.replace('# cancelled 0', '# cancelled 1')],
  ]) refused(label, () => assertTapResults(invalid, ['required']));
  refused('no declared scenario', () => assertTapResults(one, []));

  for (const names of Object.values(sharedCases)) {
    assertVitestResults(vitest(names), names);
    for (const name of names) refused(`a missing ${name}`, () => assertVitestResults(vitest(names.filter((other) => other !== name)), names));
    for (const status of ['skipped', 'todo', 'failed']) {
      refused(`a ${status} case`, () => assertVitestResults({
        ...vitest(names), testResults: [{ assertionResults: names.map((title, i) => ({ title, status: i ? 'passed' : status })) }],
      }, names));
    }
    refused('a failed run', () => assertVitestResults({ ...vitest(names), success: false }, names));
  }
  refused('an empty Vitest report', () => assertVitestResults({ success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] }, []));

  const goNames = Object.values(goCases).flat();
  const events = goEvents(goNames);
  assertGoResults(json(events), goNames);
  const first = goNames[0];
  refused('a missing Go scenario', () => assertGoResults(json(events.filter((event) => event.Test !== first)), goNames));
  refused('a skipped Go scenario', () => assertGoResults(json(events.map((event) => (event.Test === first && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))), goNames));
  refused('a failed Go scenario', () => assertGoResults(json(events.map((event) => (event.Test === first && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))), goNames));
  refused('a Go scenario that never finished', () => assertGoResults(json(events.filter((event) => !(event.Test === first && event.Action === 'pass'))), goNames));
  refused('an unmatched Go test', () => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]), goNames));
  refused('a Go package that only says pass', () => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames));
  refused('no Go output', () => assertGoResults('', goNames));
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${first}Extra`) && !selector.test('TestCursor'), 'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  for (const run of [runLogged, runGoLogged]) {
    assert.throws(() => run(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
    assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
  }

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const table of [sharedCases, pgCases, apiCases, goCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  for (const file of Object.keys(sharedCases)) assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing src/shared/${file}`);
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing ${file}.spec.ts`);
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing src/runner-go/${file}`);
  assert.equal(pgLogName(0, 'providers/cursor-api-key'), '1-cursor-api-key.pg.spec.tap');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-dsh-provider-gate.mjs does; otherwise leave Prisma's own discovery alone.
  const platform = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
  const version = require('@prisma/engines-version').enginesVersion;
  const candidates = [
    path.join(path.dirname(require.resolve('@prisma/engines/package.json')), `schema-engine-${platform}`),
    path.join(homedir(), '.cache/prisma/master', version, platform, 'schema-engine'),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return { PRISMA_SCHEMA_ENGINE_BINARY: candidate };
    } catch { /* Prisma can use its normal discovery if this candidate is absent. */ }
  }
  return {};
}

async function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-api-key-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  let total = 0;
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, todo, failed and unstarted scenarios.\n');

    const runTap = (file, names, cwd) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      assertTapResults(output, names);
      total += names.length;
    };

    for (const [file, names] of Object.entries(sharedCases)) {
      const report = path.join(scratch, `${path.basename(file)}.json`);
      const output = runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', file, '--reporter=json', `--outputFile=${report}`],
        path.join(scratch, 'vitest.log'), { cwd: path.join(root, 'src/shared') });
      process.stdout.write(output);
      assertVitestResults(JSON.parse(readFileSync(report, 'utf8')), names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      total += names.length;
    }

    const pgFiles = Object.keys(pgCases);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...pgFiles.map((file) => `src/apiserver/src/${file}.pg.spec.ts`)],
      path.join(scratch, 'postgres.log'), {
        env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
        timeout: 1_800_000,
      });
    process.stdout.write(output);
    pgFiles.forEach((file, index) => {
      const log = path.join(scratch, pgLogName(index, file));
      assert.ok(existsSync(log), `PostgreSQL runner produced no scenario log for ${file}`);
      assertTapResults(readFileSync(log, 'utf8'), pgCases[file]);
      for (const name of pgCases[file]) process.stdout.write(`PASS ${name}\n`);
      total += pgCases[file].length;
    });

    // From the test tree run-pg-spec.sh just compiled, in the package directory `npm test` runs them from.
    for (const [file, names] of Object.entries(apiCases)) {
      runTap(path.join(root, `src/apiserver/build/${file}.spec.js`), names, path.join(root, 'src/apiserver'));
    }

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P2 tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const goNames = Object.values(goCases).flat();
    const goOutput = runGoLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(goNames), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 600_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, goNames);
    for (const name of goNames) process.stdout.write(`PASS ${name}\n`);
    total += goNames.length;

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`P2 acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    if (changed().length !== 0) {
      process.stderr.write(`The runner user's Cursor CLI directories changed (${changed().join(', ')}); logs kept at ${scratch}\n`);
      process.exitCode = 1;
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
