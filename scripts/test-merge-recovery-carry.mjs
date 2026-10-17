// Acceptance for R2 of the merge-recovery project (34hIv3wbdtsxpc5RzDlOk): a recovery check made after a repair keeps
// the repair while the local or remote target only moved on — it merges their new tips into the repair branch, so only
// what they changed can conflict — and starts over only when the source changed or a target was rewritten. A repair
// checkout left unfinished is reported as REPAIR_IN_PROGRESS with its unresolved files, and no other checkout is made.
// Run from the repository root:
//
//   node scripts/test-merge-recovery-carry.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, failing, or a test process that did not start, is a non-zero exit. Go has no todo marker — a test
// parked as todo can only be skipped, and a skip is refused. The guards are scripts/test-dsh-runtime-environment.mjs's
// (assertGoResults, goTestPattern, runLogged), reused as they are and checked here against this script's own names
// before they are trusted.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what the test runner happens to discover.
export const goCases = {
  // The task's scenarios, in real git repositories: a repair made in the saved checkout, then the targets or the source
  // change before the next check.
  'merge_recovery_carry_test.go': [
    // TARGET_SYNC repair, then origin moved: carried, and the candidate holds the repair's merge and lands.
    'TestMergeRecoveryCarryTargetSyncRepairPastRemoteAdvance',
    // SOURCE_REPLAY repair, then origin moved: carried without replaying again; READY with the repair's resolution.
    'TestMergeRecoveryCarrySourceReplayRepairPastRemoteAdvance',
    // The local target moved, after a repair in either phase: carried.
    'TestMergeRecoveryCarryRepairPastLocalAdvance',
    'TestMergeRecoveryCarryRepairPastLocalAdvance/TARGET_SYNC',
    'TestMergeRecoveryCarryRepairPastLocalAdvance/SOURCE_REPLAY',
    // origin's new commit conflicts with a file the repair changed: CONFLICT naming only that file, the repair kept.
    'TestMergeRecoveryCarryNewConflictListsOnlyNewFiles',
    // A rewritten target starts over: origin force-pushed, local main reset.
    'TestMergeRecoveryCarryRewrittenTargetStartsOver',
    'TestMergeRecoveryCarryRewrittenTargetStartsOver/origin',
    'TestMergeRecoveryCarryRewrittenTargetStartsOver/local',
    // A changed source starts over, also when it changed while the repair was unfinished.
    'TestMergeRecoveryCarryChangedSourceStartsOver',
    'TestMergeRecoveryCarryChangedSourceStartsOver/finished',
    'TestMergeRecoveryCarryChangedSourceStartsOver/unfinished',
    // An unfinished checkout — mid-merge, mid-rebase (R1's partly landed replay too), uncommitted edits — is
    // REPAIR_IN_PROGRESS with its unresolved files, and no other checkout is made although origin moved.
    'TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles',
    'TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles/TARGET_SYNC_merge',
    'TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles/SOURCE_REPLAY_rebase',
    'TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles/partly_landed_replay',
    'TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles/uncommitted_edits',
    // Both targets moved and local main's merge conflicts: origin's merge waits, and the repair is kept.
    'TestMergeRecoveryCarryBothTargetsMovedKeepsTheRepair',
    // merge.ff=only allows no merge commit, so a moved target starts over.
    'TestMergeRecoveryCarryLinearHistoryStartsOver',
  ],
  // Every existing TestMergeRecovery*. The changed-preview refusal gains a rewritten origin, now that the check's
  // fetch reads a force push instead of failing on it.
  'merge_recovery_test.go': [
    'TestMergeRecoveryEscapedEnvelopeCannotAdvertiseReady',
    'TestMergeRecoveryPreviewAndApply',
    'TestMergeRecoveryPreviewListsExactlyWhatThePushAdds',
    'TestMergeRecoveryPreviewOfAMatchingTargetPushesOnlyTheSession',
    'TestMergeRecoveryRejectsChangedPreview',
    'TestMergeRecoveryRejectsChangedPreview/local',
    'TestMergeRecoveryRejectsChangedPreview/remote',
    'TestMergeRecoveryRejectsChangedPreview/rewritten_remote',
    'TestMergeRecoveryRejectsChangedPreview/source',
    'TestMergeRecoveryRejectsChangedPreview/candidate',
    'TestMergeRecoveryRejectsChangedPreview/checkpoint',
    'TestMergeRecoveryRejectsChangedPreview/check_configuration',
    'TestMergeRecoveryConflictStaysInRepairWorktree',
    'TestMergeRecoverySourceConflictCanBeRechecked',
    'TestMergeRecoveryRechecksFixedCheckWithoutDiscardingWork',
    'TestMergeRecoveryRespectsLinearHistoryPolicy',
    'TestMergeRecoveryRejectedPushPreservesReviewedCandidate',
    'TestMergeRecoveryLocalAheadRequiresReview',
    'TestMergeRecoveryLocalOnlyLandingIsNotReportedAsRemoteMerged',
    'TestMergeRecoveryDoesNotMoveTargetInAnotherWorktree',
    'TestMergeRecoveryFailedCheckAndFetchDoNotPush',
    'TestMergeRecoveryRemoteLandedLocalBlocked',
  ],
  // R1's recovery-check scenarios, which run through the same check: ALREADY_LANDED ahead of any repair, the replay
  // that leaves landed commits out, and a recheck after its repair.
  'merge_recovery_landed_test.go': [
    'TestMergeLandedRecoveryCheckReportsAlreadyLandedWithoutCandidate',
    'TestMergeLandedRecoveryCheckReplaysOnlyTheRest',
    'TestMergeLandedRealConflictStillConflicts',
  ],
};

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

/**
 * The reused guards, held to this script's names before they are trusted: a complete run passes, and a missing,
 * unmatched, skipped, failed, unfinished or repeated scenario, a package that only says pass, an empty report, a test
 * process that cannot start and one that exits non-zero are each refused.
 */
export function checkGuards(scratch) {
  const refused = (label, run) => assert.throws(run, undefined, `the guard accepted ${label}`);

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
  refused('a failed Go package', () => assertGoResults(json([...events.slice(0, -1), { Action: 'fail', Package: 'orbit' }]), goNames));
  refused('a Go package that only says pass', () => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames));
  refused('no Go output', () => assertGoResults('', goNames));
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestMergeRecoveryCarry') && !selector.test('TestMergeRecovery'),
    'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const [file, names] of Object.entries(goCases)) {
    assert.ok(names.length > 0, `${file} names no scenario`);
    assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing src/runner-go/${file}`);
  }
  assert.equal(new Set(goNames).size, goNames.length, 'a Go scenario is named in two files');
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-merge-recovery-carry-'));
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    // Real git in throwaway repositories; nothing but git and the Go toolchain is needed on PATH.
    const toolPath = [path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
    const goNames = Object.values(goCases).flat();
    const goOutput = runLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(goNames), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, goNames);
    for (const name of goNames) process.stdout.write(`PASS ${name}\n`);

    process.stdout.write(`R2 acceptance passed: ${goNames.length} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
