// Acceptance for S1 of the merge-recovery project (34hIv3wbdtsxpc5RzDlOk): when a repair session's turn ends — and
// the turn ended after its parent's recovery was last checked — the server checks that recovery again by queueing one
// preview, the way the owner's Check again does, once per turn and with no client online. The check waits while the
// parent runs a turn of its own and is queued when that turn ends; a merge operation in flight, a landing still being
// finished (LOCAL_SYNC_PENDING, PUSH_FAILED, REMOTE_NOT_VERIFIED), a runner without session-merge-recovery-v1 and an
// ordinary child session queue nothing; and the parent's detail carries what the repair row needs to show. Run from
// the repository root:
//
//   node scripts/test-merge-recovery-autocheck.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit. The guards are
// scripts/test-dsh-routing.mjs's (assertTapResults) and scripts/test-dsh-provider-gate.mjs's (runLogged), each shown
// the reports it has to refuse before it is trusted. The scenarios run through scripts/run-pg-spec.sh on a throwaway
// PostgreSQL, through the real runner doors: events, turn-complete, finalize, the heartbeat's merge drain and the
// merge result.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runner happens to discover.
export const pgCases = {
  'sessions/merge-recovery-autocheck': [
    // A repair turn ending after checkedAt: exactly one preview — the parent pending, its action preview — and the
    // runner's drain hands it over with the parent's recovery. A recovery without checkedAt reads as earlier.
    'S1 a repair turn that ends after the recovery was checked queues exactly one preview, which the runner is handed with the recovery',
    // The same turn reported twice, on two replicas at once: one preview; the check fails, and that turn is not
    // queued again.
    'S1 the same turn reported twice, by two replicas at once, queues one preview, and a failed check is not queued again',
    // A turn that ended before checkedAt: nothing.
    'S1 a repair turn that ended before the recovery was checked queues nothing',
    // The parent running a turn: nothing then; the end of the parent's turn queues it.
    'S1 while the parent runs a turn the check waits, and the end of that turn queues it',
    // A merge operation in flight on the parent: nothing.
    'S1 a merge operation in flight on the parent queues nothing',
    // A recovery in LOCAL_SYNC_PENDING or PUSH_FAILED — and REMOTE_NOT_VERIFIED: nothing.
    'S1 a recovery in LOCAL_SYNC_PENDING, PUSH_FAILED or REMOTE_NOT_VERIFIED queues nothing',
    // An ordinary child session (source not merge-repair): no check started.
    'S1 a turn of an ordinary child session triggers no check',
    // A runner without session-merge-recovery-v1: nothing.
    'S1 a runner without session-merge-recovery-v1 is not asked to check',
    // The parent's detail: the repair session's lastTurnAt, finishedAt and last reply (200 code points), and a check
    // in flight told from another merge operation.
    "S1 the parent's detail carries the repair session's lastTurnAt, finishedAt and last reply, and tells its check from another merge operation",
    // The other turn endings the task names: failed, stopped, and a repair session finalized mid-turn.
    'S1 a repair turn that fails or is stopped, or a repair session finalized mid-turn, queues the check too',
    // The file's one top-level test, whose subtests the scenarios above are.
    "S1 a repair session's turn has its parent's merge recovery checked again on PostgreSQL",
  ],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

/**
 * The guards are only worth their green if they go red: before anything runs, each is shown reports it has to
 * refuse — a scenario missing, unmatched, skipped, todo or failing, a summary absent, doubled or wrong, a test process
 * that never started or exited non-zero — and the table is checked to name every scenario once, and only a file that
 * exists.
 */
export function checkGuards(scratch) {
  const tap = (names) =>
    `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n` +
    `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;

  for (const names of Object.values(pgCases)) {
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(tap(names.filter((other) => other !== name)), names), undefined, `accepted a missing ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, 'unmatched'), names), undefined, `accepted an unmatched ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, `${name} # SKIP`), names), undefined, `accepted a skipped ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, `${name} # TODO`), names), undefined, `accepted a todo ${name}`);
    }
    assert.throws(() => assertTapResults(`${output.replace(/^1\.\.\d+$/m, '')}ok ${names.length + 1} - ${names[0]}\n`, names), undefined,
      'accepted a scenario reported twice');
  }
  process.stdout.write('PASS guard: every mandatory PostgreSQL scenario is required, and a missing, unmatched, skipped, todo or repeated one is refused\n');

  const one = tap(['required']);
  for (const invalid of [
    '',
    one.replace('ok 1', 'not ok 1'),
    // A file wrapper that passed is not its scenarios.
    one.replace('required', 'src/apiserver/build/sessions/merge-recovery-autocheck.pg.spec.js'),
    one.replace('# pass 1\n', ''),
    `${one}# pass 1\n`,
    one.replace('# tests 1', '# tests 0'),
    one.replace('# fail 0', '# fail 1'),
    one.replace('# skipped 0', '# skipped 1'),
    one.replace('# todo 0', '# todo 1'),
    one.replace('# cancelled 0', '# cancelled 1'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(one, []));
  process.stdout.write('PASS guard: failed scenarios and absent, doubled or wrong summaries are refused\n');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  process.stdout.write('PASS guard: missing executables and startup failures are refused\n');

  for (const [file, names] of Object.entries(pgCases)) {
    assert.ok(names.length > 0, `${file} names no scenario`);
    assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  }
  assert.equal(pgLogName(0, 'sessions/merge-recovery-autocheck'), '1-merge-recovery-autocheck.pg.spec.tap');
  process.stdout.write('PASS guard: the scenario table names each scenario once, and only a file that exists\n');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-cursor-quota.mjs does; otherwise leave Prisma's own discovery alone.
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-merge-recovery-autocheck-'));
  let total = 0;
  try {
    checkGuards(scratch);

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

    process.stdout.write(`S1 acceptance passed: ${total} named PostgreSQL scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
