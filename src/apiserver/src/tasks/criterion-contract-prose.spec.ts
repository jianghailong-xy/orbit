import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateTaskCompletion } from './task-completion-criterion';
import {
  EVIDENCE_DECISIONS,
  REQUIRES_INDEPENDENT_SESSION_ACTION,
  decidingSessionDisqualification,
} from './task-evidence-decision';

/**
 * The prose that states the third criterion's contract, read back against the implementation.
 *
 * Both comments below outlived the thing they described. The enum's said the criterion "still
 * requires one decision bound to one immutable evidence version" after 0228 had taken that decision
 * door away, and the keyword table's justified its missing row with "an agent decides an evidence
 * judgment itself" — which was never the design, since an agent judging its own work is the one
 * thing this whole boundary exists to refuse. 0238 and 0239 put a decision back, so the fix is not
 * to delete the sentences but to make them say what is now true.
 *
 * A text scan, because a comment is not reachable from any other kind of test: nothing imports it,
 * nothing calls it, and the only way a wrong one gets noticed is that somebody reads it and is
 * misled. The scan is paired with a runtime witness for each claim it makes, so a comment cannot
 * pass by containing the right words while the implementation says something else.
 */

function repoRoot(): string {
  // build/tasks -> build -> apiserver -> src -> repository root
  return path.resolve(__dirname, '../../../..');
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

const SCHEMA = 'src/apiserver/prisma/schema.prisma';
const SHAPE_ADVICE = 'src/apiserver/src/tasks/task-criterion-shape-advice.ts';

/** The unbroken run of comment lines immediately above a declaration — its doc comment. */
function docCommentAbove(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  assert.notEqual(at, -1, `${declaration} was not found; this scan is reading the wrong thing`);
  const lines = source.slice(0, at).split('\n');
  const comment: string[] = [];
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (!/^\s*(?:\/\/\/|\/\*\*|\*\/|\*|\/\/)/.test(lines[i])) break;
    comment.unshift(lines[i]);
  }
  assert.ok(comment.length > 0, `${declaration} carries no doc comment at all`);
  return comment.join('\n');
}

test('the criterion enum describes the decision that exists, not the one 0228 removed', () => {
  const comment = docCommentAbove(read(SCHEMA), 'enum TaskCompletionCriterion {');

  assert.doesNotMatch(
    comment,
    /still requires one decision bound to one immutable evidence version/,
    'the enum still states the contract of a door 0228 deleted',
  );

  // What it says instead, in the three parts a reader would have to check: one CONFIRM, a decider
  // that is not this work's own run, and a binding to the evidence version the decision names.
  assert.match(comment, /one CONFIRM decision/);
  assert.match(comment, /independent session/);
  assert.match(comment, /did not do the work and did not author the evidence/);
  assert.match(comment, /evidence revision that decision references/);
  assert.match(comment, /still this task's latest/);
});

test('the keyword table gives the reason that is true, not self-judgment', () => {
  const comment = docCommentAbove(read(SHAPE_ADVICE), 'export const TASK_CRITERION_SHAPE_RULES');

  // The sentence this replaces described the forbidden shape as if it were the implementation: an
  // agent settling its own evidence is exactly what `decidingSessionDisqualification` refuses.
  assert.doesNotMatch(comment, /an agent decides an evidence judgment itself/);
  assert.doesNotMatch(comment, /stop and ask a person/);

  // The conclusion is unchanged — no row for this criterion — and the reason is now about what a
  // keyword table can know: wording says what the work costs, never who will decide it.
  assert.match(comment, /no wording says WHO will decide/);
  assert.match(comment, /independent session/);
  assert.equal(read(SHAPE_ADVICE).includes("criterion: 'EVIDENCE_JUDGMENT'"), false,
    'the reason changed but the row must still be absent');
});

test('each claim those comments make is a claim the implementation makes too', async () => {
  assert.deepEqual([...EVIDENCE_DECISIONS], ['CONFIRM', 'SEND_BACK']);

  const evaluate = (confirmed: bigint | null, latest: bigint | null) => evaluateTaskCompletion({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    confirmedEvidenceRevision: confirmed,
    latestEvidenceRevision: latest,
  }).state;
  // "about the evidence revision that decision references, and only while that revision is still
  // this task's latest" — the comparison, in both directions.
  assert.equal(evaluate(4n, 4n), 'SATISFIED');
  assert.equal(evaluate(4n, 5n), 'UNSATISFIED');
  assert.equal(evaluate(null, 5n), 'UNSATISFIED');

  // "an independent session — one that did not do the work and did not author the evidence".
  const scope = { ownerId: 'owner', taskId: 'task' };
  const noEvidence = { taskCompletionEvidence: { findFirst: async () => null } } as never;
  const submitted = { taskCompletionEvidence: { findFirst: async () => ({ id: 'e' }) } } as never;
  assert.equal(
    await decidingSessionDisqualification(noEvidence, scope, { id: 's', taskId: 'task' }),
    'this session is a run of the task it is deciding',
  );
  assert.equal(
    await decidingSessionDisqualification(submitted, scope, { id: 's', taskId: null }),
    'this session submitted completion evidence for this task',
  );
  assert.equal(
    await decidingSessionDisqualification(noEvidence, scope, { id: 's', taskId: 'other' }),
    null,
  );
  assert.equal(REQUIRES_INDEPENDENT_SESSION_ACTION, 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK');
});

test('no file that states this criterion still says it has no implementation', () => {
  // The same sweep by hand found two more sentences of the same vintage: the REST door explained
  // its strictness by "declared-but-unimplemented", and the fixture helper called VERIFICATION the
  // only route left to DONE. Both were true on 2026-09-02 and are not true now.
  const stale: Array<[string, RegExp]> = [
    [SCHEMA, /still requires one decision bound to one immutable evidence version/],
    [SHAPE_ADVICE, /an agent decides an evidence judgment itself/],
    ['src/apiserver/src/tasks/tasks.controller.ts', /declared-but-unimplemented/],
    ['src/apiserver/src/tasks/task-completion-test-helper.ts',
      /the one criterion that still has an implementation|only remaining route to DONE/],
  ];
  for (const [file, pattern] of stale) {
    assert.doesNotMatch(read(file), pattern, `${file} still describes the removed machinery`);
  }
});
