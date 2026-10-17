// Acceptance for project P6a (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): every Cursor CLI account's quota is
// read on its own and reported, and Automatic, the quota gates and the retry after a usage limit work by it
// (docs/cursor-runtime-contract.md §11, §12). Run from the repository root:
//
//   node scripts/test-cursor-quota.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero
// exit. The guards are scripts/test-dsh-routing.mjs's (node:test, Vitest) and scripts/test-cursor-runner-
// install.mjs's (go test), each shown reports it has to refuse before it is trusted. The task's named
// scenarios, and where each is shown:
//   1. the quota source parsed (httptest) and reported in the heartbeat — runner: each account read from a
//      stand-in for Cursor's dashboard with its own sign-in, the end-to-end fixture's heartbeat, planUsage.cursor
//      naming every account's snapshot;
//   2. the snapshot in shared and the apiserver, and the account chosen by quota — the same fixture decided by
//      @orbit/shared, the heartbeat stored, Automatic's pick;
//   3. the quota gate and the retry after a usage limit — the turn a usage limit met kept for its account,
//      the retry armed for the account's reset, the sweep that holds it until then, the task quota gate;
//   4. unavailable when it cannot be read — never 0, in the runner, in shared and on the control plane.
// The Go tests run with every real engine CLI and the download tools replaced on PATH by stubs that fail, and
// the runner user's real ~/.cursor, ~/.config/cursor and Orbit's own Cursor CLI directories — Default's, the
// added accounts' and the usage limits the runner keeps — are fingerprinted before and after: any change
// fails the run. The PostgreSQL scenarios run through scripts/run-pg-spec.sh on a throwaway server; it also
// builds @orbit/shared and compiles the API server's test tree the application scenarios then run from.
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
  runLogged as runLoggedInEnv,
  runnerEnvironment,
} from './test-dsh-runtime-environment.mjs';
import { checkGuards as checkGoGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

/** The end-to-end fixture both ends are held to (src/shared/src/cursor-plan-usage.fixture.json): each case
 *  by the id its Go subtest runs under and the name its shared case runs under. */
export const fixtureCases = [
  ['paid-reading-before-free', 'a paid account with a reading takes the session before a Free one whose usage Cursor cannot report'],
  ['limit-met-spends-until-reset', 'an account a turn met the usage limit on is spent until its included usage resets, and the next session starts on the other'],
  ['free-request-limit', "the Free plan's request limit met holds its account back until its billing month ends, though Cursor still reports 0%"],
  ['every-account-spent', 'with every account spent, the session starts on the one that frees up first'],
  ['paid-zero-is-no-reading', 'a paid account at 0% is no reading: it ranks after an account with one, however soon its week ends, and is never taken for spent'],
  ['reading-at-limit-holds-nothing', 'a reading at its limit goes last but holds nothing back: past its included usage a paid plan can go on, on demand'],
  ['limit-before-period-is-over', 'a usage limit met before the period began is over'],
  ['dashboard-unanswered', "an account Cursor's dashboard did not answer for is unavailable: not reported, and taken after one that is"],
  ['limit-met-without-reading', "a usage limit met on an account Cursor's dashboard did not answer for: passed over while another can run, with no reset to hold a run back until"],
];

// Exact mandatory scenario names, independent of what the test runners happen to discover.
export const goCases = {
  'cursor_usage_test.go': [
    // (1) The source, parsed: each account read from Cursor's dashboard with its own sign-in.
    'TestCursorUsageReadsEachAccountFromTheDashboard',
    // (1)(2) The fixture's dashboard answers and usage limits met, sent as its heartbeat's planUsage.
    'TestCursorPlanUsageFixture',
    ...fixtureCases.map(([id]) => `TestCursorPlanUsageFixture/${id}`),
    // (1) The heartbeat: planUsage.cursor, provider and account on every snapshot; a removed account leaves.
    'TestCursorAccountUsageReportsEveryAccountUnderPlanUsageCursor',
    // (4) Unavailable, never 0: not signed in, an expired sign-in (never refreshed), a refused token, a
    // failed read, fields Cursor did not send, and Cursor's 0%.
    'TestCursorUsageUnavailableIsNeverZero',
    'TestCursorUsageUnavailableIsNeverZero/not-signed-in',
    'TestCursorUsageUnavailableIsNeverZero/expired-sign-in',
    'TestCursorUsageUnavailableIsNeverZero/token-refused',
    'TestCursorUsageUnavailableIsNeverZero/failed-read-keeps-the-last',
    'TestCursorUsageUnavailableIsNeverZero/fields-not-sent',
    'TestCursorUsageUnavailableIsNeverZero/zero-is-no-reading',
    // (3) The usage limit a session's turn met (P5b's recorded sentence), kept for the account it ran on —
    // the one it names, a key of its workspace's notwithstanding — none for a session on a key, across a restart.
    'TestCursorSessionKeepsTheUsageLimitItsAccountMet',
    'TestCursorSessionKeepsTheUsageLimitItsAccountMet/on-default',
    'TestCursorSessionKeepsTheUsageLimitItsAccountMet/on-a-named-account',
    'TestCursorSessionKeepsTheUsageLimitItsAccountMet/on-a-key-of-its-own',
    'TestCursorTurnOnAnAccountEndsItsUsageLimit',
    // (3) The account is read again once its included usage resets.
    'TestPlanUsageRefreshDueAfterACursorPeriodEnds',
  ],
};

export const sharedCases = {
  // (2)(3)(4) The fixture decided by @orbit/shared: the account a session starts on, until when each account
  // holds a run back, whether it is reported, and when a run that met its limit is retried.
  'src/cursor-plan-usage.spec.ts': [
    ...fixtureCases.map(([, name]) => name),
    'P6a what Cursor does not report is unavailable, never 0',
    'P6a a run that just met its usage limit is retried when its account’s included usage resets',
    'P6a a Cursor CLI run on an account it names spends that account, whatever key its workspace sets; one naming none spends no account on that key',
  ],
  // P4a's, whose rule for a run naming an account beside its workspace's key P6a aligns with the runner.
  'src/cursor-account.spec.ts': [
    'P4a cursor keeps accounts, and an account is handed to the runner as ORBIT_CURSOR_ACCOUNT_DIR',
    'P4a a Cursor CLI run with a key or token of its own spends no account',
    'P4a Automatic starts a Cursor CLI session on Default while no Cursor CLI quota is reported',
  ],
};

export const pgCases = {
  // (2)(3)(4) On real PostgreSQL: the retry turn-complete arms, the sweep, the heartbeat stored, the task gate.
  'runner-api/cursor-usage-limit': [
    'P6a a Cursor CLI turn that met the usage limit is retried when its account’s included usage resets',
    'P6a the retry waits for the reset of the account the run spent, a key of its workspace’s notwithstanding',
    'P6a an account Cursor’s dashboard has not answered for arms no retry',
    'P6a a Cursor CLI failure that is not the usage limit arms nothing',
    'P6a a task’s run that met the usage limit waits for the reset, its task told nothing meanwhile',
    'P6a the retry is held while the account is still spent, and sent once its included usage has reset',
    'P6a the heartbeat stores planUsage.cursor with each account’s snapshot under its own id',
    'P6a the task quota gate holds a Cursor CLI task on a spent account until it resets, and Automatic sends one to the account with room',
    'P6a a Cursor CLI account’s usage limit on PostgreSQL',
  ],
};

export const apiCases = {
  // (2) The snapshot stored, Automatic's pick and the account a run is judged on.
  'providers/cursor-quota': [
    'P6a the heartbeat’s planUsage.cursor is stored with each account’s snapshot under its own id',
    'P6a Automatic starts a Cursor CLI session on an account with room, never on one a turn met the limit on',
    'P6a a Cursor CLI run on an account picked for it is judged on that account, its workspace’s key notwithstanding',
  ],
  // P4a's dispatch, whose account for a run beside its workspace's key P6a aligns with the runner.
  'providers/cursor-account-dispatch': [
    'P4a dispatch hands a Cursor CLI session its account’s directory as ORBIT_CURSOR_ACCOUNT_DIR',
    'P4a an account the runner does not report runs a Cursor CLI session on Default',
    'P4a a Cursor CLI run is judged on the account dispatch gives it, and Automatic starts it on Default',
  ],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

/** What the runner keeps of Cursor CLI under Orbit's own home: Default's directory, the added accounts and
 *  the usage limits its sessions met. The tests run on homes of their own, so the runner's own must not change. */
export function orbitCursorPaths(home) {
  const orbitHome = process.env.ORBIT_HOME ?? path.join(home, '.orbit');
  return [path.join(orbitHome, 'cursor', 'default'), path.join(orbitHome, 'cursor-accounts'), path.join(orbitHome, 'cursor', 'usage-limits.json')];
}

/**
 * The guards are only worth their green if they go red: before anything runs, each is shown reports it has
 * to refuse — a scenario missing, unmatched, skipped, todo or failing, a summary absent, doubled or wrong, a
 * Vitest report that failed, skipped or is empty, a Go scenario missing, skipped, failed, repeated, unfinished
 * or unmatched, a test process that never started or exited non-zero — and the tables are checked to name every
 * file once, every scenario once, only files that exist, and exactly the fixture's cases.
 */
export function checkGuards(scratch) {
  const tap = (names) =>
    `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n` +
    `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const vitest = (names) => ({
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: [{ assertionResults: names.map((title) => ({ title, status: 'passed' })) }],
  });

  for (const names of [...Object.values(pgCases), ...Object.values(apiCases)]) {
    assertTapResults(tap(names), names);
    for (const name of names) assert.throws(() => assertTapResults(tap(names.filter((other) => other !== name)), names));
  }
  for (const names of Object.values(sharedCases)) {
    assertVitestResults(vitest(names), names);
    for (const name of names) assert.throws(() => assertVitestResults(vitest(names.filter((other) => other !== name)), names));
  }
  process.stdout.write('PASS guard: every mandatory shared, PostgreSQL and application scenario is required\n');

  for (const names of [pgCases['runner-api/cursor-usage-limit'], apiCases['providers/cursor-quota']]) {
    const output = tap(names);
    for (const name of names) {
      assert.throws(() => assertTapResults(output.replace(name, 'unmatched'), names));
      assert.throws(() => assertTapResults(output.replace(name, `${name} # SKIP`), names));
      assert.throws(() => assertTapResults(output.replace(name, `${name} # TODO`), names));
    }
  }
  const one = tap(['required']);
  for (const invalid of [
    '',
    one.replace('ok 1', 'not ok 1'),
    // A file wrapper that passed is not its scenarios.
    one.replace('required', 'src/apiserver/build/runner-api/cursor-usage-limit.pg.spec.js'),
    one.replace('# pass 1\n', ''),
    `${one}# pass 1\n`,
    one.replace('# tests 1', '# tests 0'),
    one.replace('# skipped 0', '# skipped 1'),
    one.replace('# todo 0', '# todo 1'),
    one.replace('# cancelled 0', '# cancelled 1'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(one, []));
  process.stdout.write('PASS guard: missing, unmatched, skipped, todo and failed scenarios, and wrong summaries, are refused\n');

  const shared = sharedCases['src/cursor-plan-usage.spec.ts'];
  for (const invalid of [
    { ...vitest(shared), success: false },
    { ...vitest(shared), numPassedTests: shared.length - 1 },
    { ...vitest(shared), testResults: [{ assertionResults: shared.map((title, i) => ({ title, status: i ? 'passed' : 'skipped' })) }] },
    { ...vitest(shared), testResults: [{ assertionResults: shared.map((title, i) => ({ title, status: i ? 'passed' : 'todo' })) }] },
    { success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] },
  ]) assert.throws(() => assertVitestResults(invalid, shared));
  assert.throws(() => assertVitestResults(vitest([]), []));
  process.stdout.write('PASS guard: failed, skipped and empty Vitest reports are refused\n');

  checkGoGuards(Object.values(goCases).flat(), scratch);
  process.stdout.write('PASS guard: missing, unmatched, skipped, failed, repeated and unfinished Go scenarios, and unstarted tests, are refused\n');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  process.stdout.write('PASS guard: missing executables and startup failures are refused\n');

  for (const table of [goCases, sharedCases, pgCases, apiCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
  for (const file of Object.keys(sharedCases)) assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing required test file: src/shared/${file}`);
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test file: ${file}.spec.ts`);
  // Every case of the fixture is named, by its id on the Go side and its name on the shared side.
  const fixture = JSON.parse(readFileSync(path.join(root, 'src/shared/src/cursor-plan-usage.fixture.json'), 'utf8'));
  assert.deepEqual(fixture.cases.map((c) => [c.id, c.name]), fixtureCases, 'the fixture\'s cases are not the ones named here');
  assert.equal(pgLogName(0, 'runner-api/cursor-usage-limit'), '1-cursor-usage-limit.pg.spec.tap');
  process.stdout.write('PASS guard: the scenario tables name each file once, each scenario once, only files that exist, and every fixture case\n');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-cursor-accounts-server.mjs does; otherwise leave Prisma's own discovery alone.
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

/** The runner's scenarios, against stubs for every real CLI, with the runner user's Cursor directories and
 *  Orbit's own fingerprinted before and after. */
function runGoScenarios(scratch) {
  const home = process.env.HOME ?? homedir();
  const watched = [...userCursorPaths(home), ...orbitCursorPaths(home)];
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const blockedBin = path.join(scratch, 'blocked-bin');
  mkdirSync(blockedBin, { mode: 0o700 });
  for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
    writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P6a tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
  }
  // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
  const loginHome = userInfo().homedir;
  const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
    path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
  const names = Object.values(goCases).flat();
  const output = runLoggedInEnv('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
    cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 600_000,
  });
  process.stdout.write(output);
  assertGoResults(output, names);
  for (const name of names) process.stdout.write(`PASS ${name}\n`);
  const changed = watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  assert.deepEqual(changed, [], 'the runner user\'s Cursor CLI directories or Orbit\'s own Cursor CLI state changed');
  process.stdout.write(`PASS unchanged: ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')}.\n`);
  return names.length;
}

async function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-quota-'));
  let total = 0;
  try {
    checkGuards(scratch);

    total += runGoScenarios(scratch);

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
      const spec = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(spec), `missing compiled test file: ${spec}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, 'node.log'), { cwd: path.join(root, 'src/apiserver'), timeout: 600_000 });
      process.stdout.write(tap);
      assertTapResults(tap, names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      total += names.length;
    }
    process.stdout.write(`P6a acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
