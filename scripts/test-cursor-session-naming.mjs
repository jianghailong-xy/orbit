// Acceptance for the P5a follow-up (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): the title Cursor CLI gives a
// session lands, and never over a title that is already somebody's. Cursor CLI names a session in its first
// turn (session_info_update, docs/cursor-runtime-contract.md §3.2); its runner reports that title only when the
// claim carries `naming`, and the report is kept only while the session still carries the title its claim
// did. engineNamingJob (src/apiserver/src/sessions/naming.ts) asks Cursor CLI by the rules it asks Claude Code
// and Codex by. Run from the repository root:
//
//   node scripts/test-cursor-session-naming.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero
// exit. The guards are scripts/test-dsh-routing.mjs's (TAP), scripts/test-dsh-provider-gate.mjs's runLogged
// and scripts/test-dsh-runtime-environment.mjs's (Go), reused as they are and checked here against this
// script's own names before they are trusted. The PostgreSQL scenarios run through scripts/run-pg-spec.sh on a
// throwaway server, which also compiles the API server's test tree the application scenarios then run from.
// The Go scenarios run with every real engine CLI, Cursor's own commands and the download tools replaced on
// PATH by stubs that fail, and the runner user's real ~/.cursor family is fingerprinted before and after.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
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

// Exact mandatory scenario names, independent of what the test runners happen to discover. The task's three
// scenarios, and where each is shown:
//   1. a Cursor CLI session's claim carries naming, and the title its runner reports lands — the rule, the
//      real claim and report on PostgreSQL, and the runner reporting Cursor CLI's title when asked;
//   2. a task's title, a person's rename and DeepSeek's title are not replaced by Cursor CLI's — the rule,
//      the real claim and report on PostgreSQL, the report's compare-and-set, and the runner reporting
//      nothing when its claim did not ask;
//   3. Claude Code and Codex are named as before — the rule, their real claims on PostgreSQL, the claim spec
//      that held them before Cursor CLI joined, and their runner asking them only when the claim says so.
export const pgCases = {
  'sessions/cursor-session-naming': [
    'P5a a Cursor CLI session nothing else names is claimed with naming, and the title its runner reports lands',
    "P5a a Cursor CLI session that runs a task keeps the task's title",
    "P5a a person's rename stands over Cursor CLI's title, made before the claim or after it",
    "P5a DeepSeek's title stands: a Cursor CLI session the server names is claimed without naming",
    'P5a Claude Code and Codex sessions are claimed with naming as before, and their titles land',
    'P5a Cursor CLI session titles on PostgreSQL',
  ],
};

export const apiCases = {
  // The rule, engine by engine.
  'sessions/cursor-session-naming': [
    'P5a Cursor CLI is asked to name a session nothing else names, as Claude Code and Codex are, and no other engine is',
    'P5a a title a task, a project, a person or DeepSeek gave is not handed to Cursor CLI, Claude Code or Codex to replace',
  ],
  // The claim's naming as it stood for Claude Code and Codex.
  'queue/claim-naming': [
    "with no DeepSeek key, a session on an engine's own sign-in is named by that engine",
    'a session something else names, or that already has a real title, is not named again',
    'a configured Claude subscription is named by the Claude Code that runs on it',
  ],
  // The report's compare-and-set: the title the claim carried, or nothing.
  'runner-api/session-naming': [
    'the title lands while the session still carries the one its claim did',
    'a rename made since, or a project that owns the title, stands',
    "an engine's title is kept to one clean line, and no title is no write",
    "another runner's session is refused before anything is written",
  ],
};

export const goCases = {
  // The runner reports Cursor CLI's title against the claimed one when the claim asks, and nothing otherwise.
  'cursor_acp_test.go': [
    'TestCursorACPEventMapping',
    'TestCursorACPEventMapping/title',
    'TestCursorACPEventMapping/title-not-asked-for',
  ],
  // Claude Code and Codex, asked only when the claim says so.
  'session_naming_test.go': [
    'TestClaudeNamesItsSessionThroughItsOwnTitleRequest',
    'TestClaudeThatCannotNameLeavesTheTitleAlone',
    'TestSessionAsksItsEngineToNameItOnceWhenTheClaimSaysSo',
    'TestSessionLeavesItsEngineUnaskedWithoutANamingJob',
    'TestCodexNamesItsSessionInASideThreadOfTheSameAppServer',
    'TestCodexNamingTurnThatFailsNamesNothing',
  ],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n`
    + `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

/**
 * The reused guards, held to this script's names before they are trusted: a complete run passes, and a
 * missing, unmatched, skipped, todo, failed or repeated scenario, an absent or inconsistent summary, a file
 * wrapper that passed, a test process that cannot start and one that exits non-zero are each refused.
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
    ['a file wrapper that passed', one.replace('required', 'src/apiserver/build/sessions/cursor-session-naming.pg.spec.js')],
    ['a missing summary', one.replace('# pass 1\n', '')],
    ['a duplicate summary', `${one}# pass 1\n`],
    ['an inconsistent count', one.replace('# tests 1', '# tests 2')],
    ['a skipped count', one.replace('# skipped 0', '# skipped 1')],
    ['a todo count', one.replace('# todo 0', '# todo 1')],
    ['a cancelled count', one.replace('# cancelled 0', '# cancelled 1')],
  ]) refused(label, () => assertTapResults(invalid, ['required']));
  refused('no declared scenario', () => assertTapResults(one, []));

  const goNames = Object.values(goCases).flat();
  const events = goEvents(goNames);
  assertGoResults(json(events), goNames);
  for (const name of goNames) {
    refused(`a missing ${name}`, () => assertGoResults(json(events.filter((event) => event.Test !== name)), goNames));
    refused(`a skipped ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))), goNames));
    refused(`a failed ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))), goNames));
    refused(`an unfinished ${name}`, () => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), goNames));
  }
  refused('a repeated Go scenario', () => assertGoResults(json([...events.slice(0, -1), ...goEvents([goNames[0]]).slice(1, -1), events.at(-1)]), goNames));
  refused('an unmatched Go test', () => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]), goNames));
  refused('a Go package that only says pass', () => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames));
  refused('no Go output', () => assertGoResults('', goNames));
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestCursor'), 'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  for (const run of [runLogged, runGoLogged]) {
    assert.throws(() => run(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
    assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
  }

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const table of [pgCases, apiCases, goCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing ${file}.spec.ts`);
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing src/runner-go/${file}`);
  assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor/multi-turn-tools-default/turns/stdout.jsonl')),
    'missing the P0 recording the fake Cursor CLI replays');
  assert.equal(pgLogName(0, 'sessions/cursor-session-naming'), '1-cursor-session-naming.pg.spec.tap');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-session-naming-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  let total = 0;
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, todo, failed and unstarted scenarios.\n');

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
      const spec = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(spec), `missing compiled test file: ${spec}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const result = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, 'node.log'), { cwd: path.join(root, 'src/apiserver') });
      process.stdout.write(result);
      assertTapResults(result, names);
      total += names.length;
    }

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "the naming tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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
    process.stdout.write(`P5a follow-up acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
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
