// Acceptance for project P4a (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): the control plane keeps a runner's
// several Cursor CLI accounts apart — a workspace and a session pick one or leave it to Automatic
// (migration 0427), dispatch hands the runner the account a session runs on and Default for one it does not
// report, and a named sign-in or a removal goes only to a runner that declares cursor-account-login/v1 or
// cursor-account-remove/v1 (docs/cursor-runtime-contract.md §16). Run from the repository root:
//
//   node scripts/test-cursor-accounts-server.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, skipped, marked todo, failing, or a test process that did not start, is a non-zero exit. The
// guard is scripts/test-dsh-routing.mjs's, reused as it is, and checked first against made-up reports that
// it has to refuse. The PostgreSQL scenarios run through scripts/run-pg-spec.sh on a throwaway server; it
// also compiles the API server's test tree the application scenarios then run from.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover. The task's four
// named scenarios, and where each is shown:
//   1. the three columns read and written, and Automatic — PostgreSQL (0427's columns, the workspace and
//      session writes, Automatic's pick), the shared account helpers, and the dispatch spec's Automatic;
//   2. dispatch hands the runner the account, and an account it does not report runs on Default —
//      PostgreSQL (the real claim) and the dispatch spec;
//   3. a named sign-in and a removal go only to a runner that declares them, and an older one is refused
//      and told to update — PostgreSQL and the relay spec, beside every other engine's sign-in relay;
//   4. the census — the migration ledger names 0427 and its columns, and every write is in the write
//      inventory.
export const sharedCases = {
  'src/cursor-account.spec.ts': [
    'P4a cursor keeps accounts, and an account is handed to the runner as ORBIT_CURSOR_ACCOUNT_DIR',
    'P4a a Cursor CLI run with a key or token of its own spends no account',
    'P4a Automatic starts a Cursor CLI session on Default while no Cursor CLI quota is reported',
  ],
};

export const pgCases = {
  'sessions/cursor-account': [
    'P4a the columns are the ones 0427 says',
    'P4a a workspace and a session pick a Cursor CLI account, or leave it to Automatic',
    'P4a dispatch hands the runner the account its session runs on',
    'P4a an account the runner does not report runs a Cursor CLI session on Default',
    'P4a a Cursor CLI sign-in or removal goes only to a runner that declares it, and an older one is told to update',
    'P4a Cursor CLI accounts on PostgreSQL',
  ],
};

export const apiCases = {
  // Dispatch, Default and Automatic.
  'providers/cursor-account-dispatch': [
    'P4a dispatch hands a Cursor CLI session its account’s directory as ORBIT_CURSOR_ACCOUNT_DIR',
    'P4a an account the runner does not report runs a Cursor CLI session on Default',
    'P4a a Cursor CLI run is judged on the account dispatch gives it, and Automatic starts it on Default',
  ],
  // The sign-in and removal relay: the capability gates, the upgrade words, the link's expiry.
  'runners/cursor-account-relay': [
    'P4a a Cursor CLI account is signed in by name, and Cursor CLI’s own, only on a runner that declares cursor-account-login/v1',
    'P4a a runner too old for Cursor CLI’s sign-in is refused it at the start and at the heartbeat, in the upgrade words',
    'P4a a Cursor CLI sign-in link’s expiry, and that it expired, reach the page as the runner reported them',
    'P4a a Cursor CLI sign-in waits out its link, not the relay’s usual eleven minutes',
    'P4a a Cursor CLI account is removed only by a runner that declares cursor-account-remove/v1',
    'P4a Cursor CLI’s accounts come through the engine report, and its sign-in and account routes take cursor',
  ],
  // Every other engine's sign-in relay, through the same gate.
  'runners/runner-login-account': [
    'the account the body names is the account in the start the runner is handed',
    'a new account is started by its name, and the slot the runner reports is what the page reads',
    'a start naming no account — the runner’s own login — is the shape it always was',
    'a body that cannot name an account is refused, never read as the runner’s own login',
    'a Claude account is signed in by name, on a runner that declares that',
    'a Kimi account is signed in by name on the site it is added on, on a runner that declares that',
    'a runner that does not declare account sign-in is never handed a start naming another account',
    'a report about a start the row has moved past changes nothing',
    'a report naming something that is not an account is refused',
  ],
  // Cursor CLI's place among the engines (P1), whose sign-in is now relayed.
  'common/cursor-runtime-routing': [
    'P1 cursor is a built-in engine slug, unambiguous since migration 0426, and its guard row is never a provider',
    'P1 a Cursor CLI sign-in session is built for the runner on Cursor CLI alone',
    'P1 Cursor CLI effort values are opaque and the live catalogue decides them',
    'P1 the server admits exactly the Cursor CLI modes the picker calls kept, and defaults to Accept Edits',
  ],
  // The census: the migration ledger, which names 0427 and its five columns ...
  'tasks/task-judgment-data-preserved': [
    'the removal drops exactly the five judgment relations and their two views',
    'no preserved relation is dropped, altered, or written by the removal',
    'the 0177 declaration and the completion criterion enum are never named as targets',
    'the 0150/0172 gate triggers and 0141 verdict functions are not touched by the removal',
    'the ledger stays append-only, and every later migration is accounted for',
    'after 0246, no migration number is used twice: a duplicate reorders the ledger by string, not by intent',
  ],
  // ... and the write inventory, which names every statement that writes them.
  'common/db-write-inventory': [
    'every database write in the tree is in the inventory, and nothing else is',
    'every transaction unit matches its declared retry shape, and every statement has a class',
    'every retry names the operation it is retrying',
    '40P01, 40001 and P2034 are decided in one place',
    'a transaction writes through its own client and no other',
    'nothing outside the database happens inside a retried transaction',
    'the installed triggers are the ones the inventory describes',
    'task-list writes are absent from the live acceptance-trigger inventory',
    'every excluded source still exists and every class is still used',
  ],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

/**
 * The guard is only worth its green if it goes red: before anything runs, it is shown reports it has to
 * refuse — a scenario missing, unmatched, skipped, todo or failing, a summary absent, doubled or wrong, a
 * Vitest report that failed, skipped or is empty, a test process that never started or exited non-zero —
 * and the tables are checked to name every file once, every scenario once, and only files that exist.
 */
export function checkGuard() {
  const tap = (names) =>
    `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n` +
    `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const vitest = (names) => ({
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: [{ assertionResults: names.map((title) => ({ title, status: 'passed' })) }],
  });

  // Every scenario is required: a report without any one of them is red.
  for (const names of [...Object.values(pgCases), ...Object.values(apiCases)]) {
    assertTapResults(tap(names), names);
    for (const name of names) assert.throws(() => assertTapResults(tap(names.filter((other) => other !== name)), names));
  }
  for (const names of Object.values(sharedCases)) {
    assertVitestResults(vitest(names), names);
    for (const name of names) assert.throws(() => assertVitestResults(vitest(names.filter((other) => other !== name)), names));
  }
  process.stdout.write('PASS guard: every mandatory shared, PostgreSQL and application scenario is required\n');

  for (const names of [pgCases['sessions/cursor-account'], apiCases['runners/cursor-account-relay']]) {
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
    one.replace('required', 'src/apiserver/build/sessions/cursor-account.pg.spec.js'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(one, []));
  process.stdout.write('PASS guard: missing, unmatched, skipped, todo and failed scenarios are refused\n');

  for (const invalid of [
    one.replace('# pass 1\n', ''),
    `${one}# pass 1\n`,
    one.replace('# tests 1', '# tests 0'),
    one.replace('# pass 1', '# pass 2'),
    one.replace('# skipped 0', '# skipped 1'),
    one.replace('# todo 0', '# todo 1'),
    one.replace('# cancelled 0', '# cancelled 1'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  process.stdout.write('PASS guard: absent, duplicate and inconsistent summaries are refused\n');

  const shared = sharedCases['src/cursor-account.spec.ts'];
  for (const invalid of [
    { ...vitest(shared), success: false },
    { ...vitest(shared), numPassedTests: shared.length - 1 },
    { ...vitest(shared), testResults: [{ assertionResults: shared.map((title, i) => ({ title, status: i ? 'passed' : 'skipped' })) }] },
    { ...vitest(shared), testResults: [{ assertionResults: shared.map((title, i) => ({ title, status: i ? 'passed' : 'todo' })) }] },
    { success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] },
  ]) assert.throws(() => assertVitestResults(invalid, shared));
  assert.throws(() => assertVitestResults(vitest([]), []));
  process.stdout.write('PASS guard: failed, skipped and empty Vitest reports are refused\n');

  const scratch = mkdtempSync(path.join(tmpdir(), 'cursor-accounts-guard-'));
  try {
    const log = path.join(scratch, 'test.log');
    assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
    assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
    assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write('PASS guard: missing executables and startup failures are refused\n');

  for (const table of [sharedCases, pgCases, apiCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  for (const file of Object.keys(sharedCases)) assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing required test file: src/shared/${file}`);
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test file: ${file}.spec.ts`);
  // run-pg-spec.sh keeps the n-th spec's TAP as `<n>-<file name>.tap`.
  assert.equal(pgLogName(0, 'sessions/cursor-account'), '1-cursor-account.pg.spec.tap');
  process.stdout.write('PASS guard: the scenario tables name each file once, each scenario once, and only files that exist\n');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-cursor-engine.mjs does; otherwise leave Prisma's own discovery alone.
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
  checkGuard();
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-accounts-'));
  let total = 0;
  try {
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
      total += pgCases[file].length;
    });

    // From the test tree run-pg-spec.sh just compiled, in the package directory `npm test` runs them from
    // (the census specs read prisma/migrations and src relative to it).
    for (const [file, names] of Object.entries(apiCases)) {
      const spec = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(spec), `missing compiled test file: ${spec}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, 'node.log'), { cwd: path.join(root, 'src/apiserver'), timeout: 600_000 });
      process.stdout.write(tap);
      assertTapResults(tap, names);
      total += names.length;
    }
    process.stdout.write(`P4a acceptance passed: ${total} named scenarios, none missing, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
