// Acceptance for R1 of the merge-recovery project (34hIv3wbdtsxpc5RzDlOk): the runner recognizes the session
// commits that already reached origin/<target> under other names — rebase copies, cherry-picks — and stops
// reporting them as conflicts or a diverged target. Both the ordinary merge and the recovery check answer
// ALREADY_LANDED when every commit is there, and replay only the rest when some are. Run from the repository root:
//
//   node scripts/test-merge-recovery-landed.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero exit. The guards
// are scripts/test-dsh-routing.mjs's (Vitest) and scripts/test-dsh-runtime-environment.mjs's (Go), reused as they
// are and checked here against this script's own names before they are trusted.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVitestResults, runLogged } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, runLogged as runGoLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what the test runners happen to discover.
export const goCases = {
  // The task's scenarios. Each fixture first shows that the old replay (`git rebase --onto <target> <fork>`)
  // conflicts on it.
  'merge_recovery_landed_test.go': [
    // The 2026-10-11 incident: commits merged as rebase copies, origin's follow-up fix, the branch rewritten back
    // onto its first commit. ALREADY_LANDED; origin, the local target and the source do not move.
    'TestMergeLandedRewrittenBranchReportsAlreadyLanded',
    // The same with two unpushed commits on local main: ALREADY_LANDED, not TARGET_DIVERGED, nothing pushed.
    'TestMergeLandedDivergedLocalTargetIsNotPushed',
    // One commit landed, one new: the merge lands only the new one, without a conflict.
    'TestMergeLandedPartialMergeReplaysOnlyNewCommits',
    // The recovery check, everything landed once it synced: ALREADY_LANDED and no candidate.
    'TestMergeLandedRecoveryCheckReportsAlreadyLandedWithoutCandidate',
    // The recovery check, partly landed: SOURCE_REPLAY replays only the rest, READY.
    'TestMergeLandedRecoveryCheckReplaysOnlyTheRest',
    // A copy only the local target has is not landed.
    'TestMergeLandedLocalOnlyCopyIsNotLanded',
    // A real conflict is still CONFLICT.
    'TestMergeLandedRealConflictStillConflicts',
    // Past the comparison limit nothing is judged landed.
    'TestMergeLandedComparisonPastTheLimitIsNotLanded',
  ],
  // Every existing TestMergeRecovery*.
  'merge_recovery_test.go': [
    'TestMergeRecoveryEscapedEnvelopeCannotAdvertiseReady',
    'TestMergeRecoveryPreviewAndApply',
    'TestMergeRecoveryPreviewListsExactlyWhatThePushAdds',
    'TestMergeRecoveryPreviewOfAMatchingTargetPushesOnlyTheSession',
    'TestMergeRecoveryRejectsChangedPreview',
    'TestMergeRecoveryRejectsChangedPreview/local',
    'TestMergeRecoveryRejectsChangedPreview/remote',
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
  // Every case of the ancestry-proven ALREADY_MERGED, which is unchanged.
  'worktree_already_merged_test.go': [
    'TestMergeToMainAlreadyMergedTargetIsSource',
    'TestMergeToMainAlreadyMergedTargetAhead',
    'TestMergeToMainAlreadyMergedIsIdempotent',
    'TestMergeToMainStaleBaseStillMergesRealWork',
    'TestMergeToMainRefusesUnverifiedTip',
    'TestMergeToMainAlreadyMergedOutranksTipMismatch',
  ],
  // The ordinary merge's paths this change runs through: a real conflict without anything landed, the
  // diverged target, the origin sync, work already upstream, and the fork-point replay.
  'worktree_test.go': [
    'TestMergeToMainRebaseConflict',
    'TestMergeToMainDivergedLocalTargetErrors',
    'TestMergeToMainSyncsStaleLocalTargetFromOrigin',
    'TestMergeToMainAlreadyMergedUpstreamNoConflict',
    'TestMergeToMainReplaysOnlySessionCommits',
    'TestMergeToMainReplaysOnlySessionCommits/local_base_ref',
    'TestMergeToMainReplaysOnlySessionCommits/base_sha_from_the_control_plane',
    'TestMergeToMainReplaysOnlySessionCommits/both_agree',
  ],
};

// The shared contract: readMergeRecovery accepts well-formed landedCommits and refuses malformed ones. The
// guard counts the whole file, so every case in it is named.
export const sharedCases = {
  'src/mergeRecovery.spec.ts': [
    'accepts minimal old diagnostics but requires a complete checked candidate for approval',
    'rejects malformed fields before clients render or decode them',
    'reads the commits a push adds and tells where each comes from',
    'reads the origin commits an ALREADY_LANDED result names for each session commit',
    'rejects landedCommits of the wrong shape',
    'relates the local target to origin only when a check has read both sides',
    'hands repairs the actual private checkout and forbids shared target writes',
    'tells a repair that Orbit checks again when its turn ends, to commit, and to ask the owner directly',
    'hands the repair session the next step of the same recovery, with where it stands now',
    'lists what an unfinished repair left unresolved, and keeps to the repair it has when the check names none',
    'asks the repair session for a PR candidate when one is being prepared',
    'offers Done only on an ALREADY_LANDED check stored with a previewId and naming its source, and never as a candidate',
  ],
};

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
 * The reused guards, held to this script's names before they are trusted: a complete run passes, and a missing,
 * unmatched, skipped, todo, failed, unfinished or repeated scenario, a package that only says pass, an empty
 * report, a test process that cannot start and one that exits non-zero are each refused.
 */
export function checkGuards(scratch) {
  const refused = (label, run) => assert.throws(run, undefined, `the guard accepted ${label}`);

  for (const names of Object.values(sharedCases)) {
    assertVitestResults(vitest(names), names);
    for (const name of names) {
      refused(`a missing ${name}`, () => assertVitestResults(vitest(names.filter((other) => other !== name)), names));
      refused(`an unmatched ${name}`, () => assertVitestResults(vitest(names.map((other) => (other === name ? 'unmatched' : other))), names));
    }
    for (const status of ['skipped', 'pending', 'todo', 'failed']) {
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
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestMergeLanded') && !selector.test('TestMergeRecovery'),
    'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
  assert.throws(() => runGoLogged(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runGoLogged(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const table of [goCases, sharedCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  assert.equal(new Set(goNames).size, goNames.length, 'a Go scenario is named in two files');
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing src/runner-go/${file}`);
  for (const file of Object.keys(sharedCases)) assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing src/shared/${file}`);
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-merge-recovery-landed-'));
  let total = 0;
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, todo, failed and unstarted scenarios.\n');

    for (const [file, names] of Object.entries(sharedCases)) {
      const report = path.join(scratch, `${path.basename(file)}.json`);
      const output = runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', file, '--reporter=json', `--outputFile=${report}`],
        path.join(scratch, 'vitest.log'), path.join(root, 'src/shared'));
      process.stdout.write(output);
      assertVitestResults(JSON.parse(readFileSync(report, 'utf8')), names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      total += names.length;
    }

    // Real git in throwaway repositories; nothing but git and the Go toolchain is needed on PATH.
    const toolPath = [path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
    const goNames = Object.values(goCases).flat();
    const goOutput = runGoLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(goNames), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, goNames);
    for (const name of goNames) process.stdout.write(`PASS ${name}\n`);
    total += goNames.length;

    process.stdout.write(`R1 acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();
