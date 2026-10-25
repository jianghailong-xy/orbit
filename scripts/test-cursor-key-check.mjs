// Acceptance for the P2 follow-up of project Cursor CLI native (34gyHIZv301nDWxKP9XkO): a Cursor API key is
// checked when it is connected and checked again on request, on a runner, and MCP and the CLI take one.
// Connecting a key (POST /providers/test) hands it to a runner of the owner's that is online, declares
// cursor-key-check/v1 and has the pinned Cursor CLI, on that runner's own heartbeat; the runner asks
// `agent models` in a throwaway home with the key in memory and answers VALID, INVALID or UNREACHABLE in
// bounded time, and with no runner able to ask the answer is NO_RUNNER and the key can still be saved.
// Check Again (POST /providers/mine/:id/key-check) keeps the answer on the key by compare-and-set, so an
// answer about a key replaced meanwhile is kept on nothing. No log, event, database row, error, API response
// or file on the runner holds a key being checked; provider_create, provider_update and `orbit provider
// create|update --runtime cursor` create and update one. Run from the repository root:
//
//   node scripts/test-cursor-key-check.mjs
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
  // The outcomes every client builds its connect form and its Check Again on.
  'src/cursor-key-check.spec.ts': [
    'P2 follow-up a check comes to what Cursor said on a runner, or to NO_RUNNER when no runner could ask',
  ],
};

export const pgCases = {
  'providers/cursor-key-check': [
    // The four results of connecting a key: VALID, INVALID, UNREACHABLE — and NO_RUNNER, which still saves.
    'P2 follow-up connecting a Cursor key answers VALID, INVALID or UNREACHABLE as Cursor said on a runner of the owner’s',
    'P2 follow-up with no runner that can check, connecting answers NO_RUNNER at once, and the key can still be saved',
    // Which runner is handed the key: the capability, the pinned Cursor CLI, the owner's, its own heartbeat.
    'P2 follow-up only a runner that declares cursor-key-check/v1 and has the pinned Cursor CLI is handed the key, on its own heartbeat',
    // Check Again writes back; a key replaced meanwhile keeps its own (empty) state.
    'P2 follow-up Check Again keeps the answer on the key, and an answer about a replaced key is kept on nothing',
    // The doors MCP and the CLI write through take a Cursor key, as they send it.
    'P2 follow-up MCP and the CLI create and update a Cursor key through the runner’s provider doors',
    // No log, event, database row, refusal or API response holds a key; only the heartbeat that hands it over.
    'P2 follow-up no log line, event, database row or API response holds a key being checked; only its runner’s heartbeat does',
    'P2 follow-up Cursor key check on PostgreSQL',
  ],
};

export const apiCases = {
  'providers/cursor-key-check-relay': [
    'P2 follow-up a key check goes to an online runner that declares cursor-key-check/v1 and has the pinned Cursor CLI, the freshest first',
    'P2 follow-up the relay hands a key once, to the heartbeat of the runner it was asked of, and then forgets it',
    'P2 follow-up an answer settles its check once, only from that runner and only about that key',
    'P2 follow-up a check nobody answers in time settles as no answer, and its key is gone',
    'P2 follow-up a runner is asked at most 4 checks at once',
    'P2 follow-up the heartbeat hands a key only to a process that declares cursor-key-check/v1, and only when one is waiting',
    'P2 follow-up connecting a Cursor key answers VALID, INVALID, UNREACHABLE or NO_RUNNER, in words that never carry the key',
  ],
};

export const goCases = {
  'cursor_key_check_test.go': [
    // `agent models` in a throwaway home, the key in memory: VALID, INVALID, UNREACHABLE, by the deadline.
    'TestCursorKeyCheckAnswersWhatCursorSaid',
    'TestCursorKeyCheckAnswersByTheDeadline',
    'TestCursorKeyCheckWithoutThePinnedCLIIsUnreachable',
    // The answer names the key by fingerprint; nothing printed, serialized or written holds it.
    'TestCursorKeyCheckReportsByFingerprintNeverTheKey',
    'TestCursorKeyCheckIsDeclaredAndHandedOverOnTheHeartbeat',
  ],
  'provider_cursor_key_test.go': [
    // provider_create, provider_update and `orbit provider create|update --runtime cursor`.
    'TestMCPProviderCreatesAndUpdatesACursorKey',
    'TestCLIProviderCreatesAndUpdatesACursorKey',
    'TestCursorKeyPresetIsTheSharedOne',
  ],
  'mcp_test.go': [
    // The MCP schemas name cursor among the protocols (mcp_test.go, kept in step).
    'TestMCPProviderAndAgentDescriptionsFollowTheDecoupledModel',
  ],
  'provider_cli_test.go': [
    // The CLI help and capabilities name it too, and every other key still needs what it always did.
    'TestProviderCLIHelpSpeaksOfProtocolsAndEngines',
    'TestCLIProviderWritesRefuseWhatTheServerCouldNotUse',
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
    ['a file wrapper that passed', one.replace('required', 'src/apiserver/build/providers/cursor-key-check.pg.spec.js')],
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
  assert.ok(!selector.test(`${first}Extra`) && !selector.test('TestCursorKeyCheck'), 'the -run pattern matches more than the named scenarios');

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
  assert.equal(pgLogName(0, 'providers/cursor-key-check'), '1-cursor-key-check.pg.spec.tap');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-key-check-'));
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
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P2 follow-up tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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
    process.stdout.write(`P2 follow-up acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
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
