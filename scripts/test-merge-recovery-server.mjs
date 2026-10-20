// Acceptance for S2 and S3 of the merge-recovery project (34hIv3wbdtsxpc5RzDlOk).
//
// S2: Continue repair, Reply in repair session and Prepare PR candidate — POST /sessions/:id/merge-repair — go to the
// newest repair session that can go on, with where the recovery stands now. One waiting for input, or ended in a way
// that can be resumed, is reused and sent one message naming the check result, the phase, the files in conflict or
// left unresolved, and the repair branch and worktree (with preparePR, the PR candidate's requirements too); one
// running is answered as it is, with no message; a failed one, one in Trash, one whose doors refuse the message, or
// none at all is replaced by a new one, opened as before; and two taps send one message.
//
// S3: a check that found every commit of the session already on origin (ALREADY_LANDED) is ended by the owner's Done
// — POST /sessions/:id/merge with recoveryAction confirm-landed and the result's previewId — on the server alone: the
// session is recorded merged at the source the check found, the recovery is cleared, and a later merge of that source
// into that target is answered as already landed from the MATCHED_BY_CONTENT receipt Done leaves, with nothing sent to
// a runner. A stale previewId, or a result other than ALREADY_LANDED, is 409 with nothing written. Every other write
// that records the session as landed — an integration landing, a merge receipt, an ordinary merge — clears the
// recovery it was holding. A match by content is no ALREADY_MERGED: no reader of landed receipts counts it, and the
// ancestry check an ALREADY_MERGED receipt has to pass at the runner's CLI and MCP doors still refuses a sha the target
// does not contain (its Go tests, run by name beside the PostgreSQL scenarios).
//
// S3's lock order (task 34ivMR9MjIQEjnTw4Xmx2): a landing locks the sessions whose recovery it clears ahead of the
// project binding and of its first receipt. A stopped LAND_TASK takes its sessions (FOR NO KEY UPDATE when one holds
// a recovery to clear, FOR KEY SHARE otherwise), then the project and its tasks FOR KEY SHARE, then the binding. It
// still clears the recovery and writes the receipt, and neither the DONE that races it nor a project delete meets a
// deadlock. A result that writes J12's receipts beside its own, or beside a promotion's, takes every session they
// clear in one statement before the first of them. The order is read from the statements the result's transaction
// sends.
//
// Run from the repository root:
//
//   node scripts/test-merge-recovery-server.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit. The guards are
// scripts/test-dsh-routing.mjs's (assertTapResults), scripts/test-dsh-provider-gate.mjs's (runLogged) and
// scripts/test-dsh-runtime-environment.mjs's (Go), each shown the reports it has to refuse before it is trusted. The
// PostgreSQL scenarios run through scripts/run-pg-spec.sh on a throwaway PostgreSQL, through the controllers' doors,
// SessionsService, MergeReceiptService and the runner's routes over real rows.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';
import { assertGoResults, goTestPattern, runLogged as runGoLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';

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
  'sessions/merge-recovery-done': [
    // The check's ALREADY_LANDED — from Check again and from an ordinary Merge — stored with a previewId of the
    // server's; Done through the owner's door: merged at the recovery's source, merged now, the recovery and its
    // action cleared, one MATCHED_BY_CONTENT receipt, the gate's answer, and no operation for a runner.
    'S3 Done records the session merged and clears the recovery',
    // A previewId of another check, none, another target, no recovery; CONFLICT, TARGET_DIVERGED, READY,
    // REPAIR_IN_PROGRESS, an ALREADY_LANDED naming no source; a check in flight: 409, the row and receipts unchanged.
    'S3 Done with a stale previewId or on a result other than ALREADY_LANDED is refused 409 and writes nothing',
    // The Merge button and a waiting caller after Done: answered from the receipt, the row unchanged, nothing handed
    // out at the heartbeat; a merge of the same source into another target still goes to the runner.
    'S3 after Done a merge of the same source is answered as already landed and is not dispatched',
    // A task's LAND_TASK on the project branch, and the promotion that merges it into main: each clears the recovery
    // in the transaction of its receipt; a session with a check in flight keeps its own.
    'S3 an integration landing clears the recovery its session was holding',
    // MERGED through the owner's door and ALREADY_MERGED through an agent's clear it; a CONFLICT, and a landing
    // recorded while a check is in flight, keep it.
    'S3 a merge-receipt landing clears the recovery its session was holding',
    // An ordinary Merge, and an applied candidate synced to DONE, leave neither the recovery nor its action;
    // LOCAL_SYNC_PENDING keeps both for sync-local.
    'S3 an ordinary merge that lands leaves no recovery and no recovery action behind',
    // The Done receipt is not landed as every reader is shown it; taskLanding and its SQL, the landing evidence and
    // a dependent's wait (J9) do not count it; no receipt door records it; an ALREADY_MERGED of the work does count.
    'S3 a match by content is no ALREADY_MERGED and no reader of landed receipts counts it',
    // The file's one top-level test, whose subtests the scenarios above are.
    'S3 Done ends an ALREADY_LANDED merge recovery, and a landing from elsewhere clears one, on PostgreSQL',
  ],
  'sessions/merge-recovery-lock-order': [
    // A stopped LAND_TASK's session holding a recovery: FOR NO KEY UPDATE, then the project and the task FOR KEY SHARE,
    // then the binding, then its first write; after the binding only the clear re-taking that session. The recovery is
    // cleared and the MERGED receipt written.
    'S3 a stopped LAND_TASK that lands locks its session, the project and the task before the binding, and still clears the recovery and writes the receipt',
    // No recovery, and a recovery with a check in flight: the session FOR KEY SHARE in the same place, the row
    // unchanged, the receipt written.
    'S3 a stopped LAND_TASK takes its session FOR KEY SHARE when there is no recovery to clear, and a check in flight keeps its own',
    // A second connection holds the session and the task FOR UPDATE, as turnComplete's DONE does, and then takes the
    // binding: the result commits on its first attempt, with and without a recovery, and the DONE's generation is queued.
    'S3 a stopped LAND_TASK and the DONE that races it finish without a deadlock',
    // The same with ProjectsService.remove's two locks: the project FOR UPDATE, then the binding its cascade deletes.
    'S3 a stopped LAND_TASK and a project delete that races it finish without a deadlock',
    // J12 beside a landing's own receipt: both sessions in one statement in id order, before the first receipt.
    'S3 a landing that repairs an unknown push locks every session it clears in one statement before its first receipt',
    // The same on a stopped LAND_TASK: the repair's session and task are taken before the binding as well.
    'S3 a stopped LAND_TASK that repairs an unknown push locks the repair\'s session and task before the binding too',
    // J12 beside a promotion that merges: the sessions of both in one statement, before the first receipt.
    'S3 a promotion that merges beside a J12 repair locks the sessions of both in one statement before its first receipt',
    // The file's one top-level test, whose subtests the scenarios above are.
    'S3 a landing locks the sessions whose recovery it clears before the binding and before its first receipt, on PostgreSQL',
  ],
};

// The ancestry check every ALREADY_MERGED receipt has to pass at the runner's doors, unchanged by S3: a sha the
// target does not contain is refused before anything reaches the control plane (src/runner-go/merge_receipt_check.go).
export const goCases = {
  'merge_receipt_check_test.go': [
    'TestMCPMergeReceiptRefusesAlreadyMergedShaNotInTarget',
    'TestCLIMergeReceiptRefusesAlreadyMergedShaNotInTarget',
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

  const goNames = Object.values(goCases).flat();
  const goEvents = (names) => [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
  const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const events = goEvents(goNames);
  assertGoResults(json(events), goNames);
  for (const name of goNames) {
    assert.throws(() => assertGoResults(json(events.filter((event) => event.Test !== name)), goNames), undefined, `accepted a missing ${name}`);
    assert.throws(() => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))), goNames),
      undefined, `accepted a skipped ${name}`);
    assert.throws(() => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))), goNames),
      undefined, `accepted a failed ${name}`);
    assert.throws(() => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), goNames),
      undefined, `accepted an unfinished ${name}`);
  }
  assert.throws(() => assertGoResults(json([...events.slice(0, -1), ...goEvents([goNames[0]]).slice(1, -1), events.at(-1)]), goNames), undefined,
    'accepted a Go scenario reported twice');
  assert.throws(() => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]), goNames), undefined, 'accepted an unmatched Go test');
  assert.throws(() => assertGoResults(json([...events.slice(0, -1), { Action: 'fail', Package: 'orbit' }]), goNames), undefined, 'accepted a failed Go package');
  assert.throws(() => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames), undefined,
    'accepted a Go package that only says pass');
  assert.throws(() => assertGoResults('', goNames), undefined, 'accepted no Go output');
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name)), 'the -run pattern misses a named Go scenario');
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestMCPMergeReceipt'), 'the -run pattern matches more than the named Go scenarios');
  process.stdout.write('PASS guard: every mandatory Go scenario is required, and a missing, skipped, failed, unfinished, repeated or unmatched one is refused\n');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  assert.throws(() => runGoLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runGoLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  process.stdout.write('PASS guard: missing executables and startup failures are refused\n');

  for (const [file, names] of Object.entries(pgCases)) {
    assert.ok(names.length > 0, `${file} names no scenario`);
    assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  }
  assert.equal(new Set(Object.values(pgCases).flat()).size, Object.values(pgCases).flat().length, 'a scenario is named in two files');
  for (const [file, names] of Object.entries(goCases)) {
    assert.ok(names.length > 0, `${file} names no scenario`);
    assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: src/runner-go/${file}`);
  }
  assert.equal(new Set(goNames).size, goNames.length, 'a Go scenario is named twice');
  assert.equal(pgLogName(0, 'sessions/merge-repair-continue'), '1-merge-repair-continue.pg.spec.tap');
  assert.equal(pgLogName(1, 'sessions/merge-recovery-done'), '2-merge-recovery-done.pg.spec.tap');
  assert.equal(pgLogName(2, 'sessions/merge-recovery-lock-order'), '3-merge-recovery-lock-order.pg.spec.tap');
  process.stdout.write('PASS guard: the scenario tables name each scenario once, and only a file that exists\n');
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

    // Real git in throwaway repositories; nothing but git and the Go toolchain is needed on PATH.
    const toolPath = [path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
    const goNames = Object.values(goCases).flat();
    const goOutput = runGoLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(goNames), '.'],
      path.join(scratch, 'runner.json'), {
        cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
      });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, goNames);
    for (const name of goNames) process.stdout.write(`PASS ${name}\n`);

    process.stdout.write(`S2 and S3 acceptance passed: ${total} named PostgreSQL scenarios and ${goNames.length} named Go scenarios, ` +
      'none missing, unmatched, skipped or failing.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();
