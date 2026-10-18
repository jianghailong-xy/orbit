// Acceptance for S2 of the merge-recovery project (34hIv3wbdtsxpc5RzDlOk): Continue repair, Reply in repair session
// and Prepare PR candidate — POST /sessions/:id/merge-repair — go to the newest repair session that can go on, with
// where the recovery stands now. One waiting for input, or ended in a way that can be resumed, is reused and sent one
// message naming the check result, the phase, the files in conflict or left unresolved, and the repair branch and
// worktree (with preparePR, the PR candidate's requirements too); one running is answered as it is, with no message; a
// failed one, one in Trash, one whose doors refuse the message, or none at all is replaced by a new one, opened as
// before; and two taps send one message. Run from the repository root:
//
//   node scripts/test-merge-recovery-server.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit. The guards are
// scripts/test-dsh-routing.mjs's (assertTapResults) and scripts/test-dsh-provider-gate.mjs's (runLogged), each shown
// the reports it has to refuse before it is trusted. The scenarios run through scripts/run-pg-spec.sh on a throwaway
// PostgreSQL, through the controller's door and SessionsService over real rows.
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
  'sessions/merge-repair-continue': [
    // AWAITING_INPUT (and INTERRUPTED) reused: one message, with the check result, phase, conflicts and the repair's
    // branch and worktree; no new session, and the parent's detail still shows it. Through the controller's door.
    'S2 a repair session waiting for input is reused and gets one message with the current conflicts and its repair branch and worktree',
    // SUCCEEDED, and CANCELLED filed in Completed: resumed with the message (unresolved files of REPAIR_IN_PROGRESS).
    'S2 an ended repair session that can be resumed is resumed and reused',
    // RUNNING and PENDING: answered as they are, no turn written.
    'S2 a running repair session is returned as it is and sent no message',
    // FAILED, in Trash, none: a new session with the recovery's first prompt; the old one untouched.
    'S2 a new repair session is started when the latest one failed or was deleted, or there is none',
    // The doors' own refusals — never started, being ended, runner offline — end in a new session.
    'S2 a repair session whose doors refuse the message is replaced by a new one',
    // One after the other, at once on one waiting and on one ended, and with none yet: one message, one session.
    'S2 two taps in a row send one message',
    // preparePR, waiting and ended: the message carries the PR candidate's requirements.
    'S2 with preparePR the message carries the PR candidate requirements',
    // The file's one top-level test, whose subtests the scenarios above are.
    'S2 the merge repair door hands the next step to the same repair session on PostgreSQL',
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
    one.replace('required', 'src/apiserver/build/sessions/merge-repair-continue.pg.spec.js'),
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
  assert.equal(pgLogName(0, 'sessions/merge-repair-continue'), '1-merge-repair-continue.pg.spec.tap');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-merge-recovery-server-'));
  let total = 0;
  try {
    checkGuards(scratch);

    // A fresh worktree has no node_modules until the overlay has run, and the Prisma helpers below resolve from it.
    runLogged('bash', ['scripts/worktree-overlay.sh'], path.join(scratch, 'overlay.log'), { timeout: 900_000 });

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

    process.stdout.write(`S2 acceptance passed: ${total} named PostgreSQL scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
