import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@orbit/shared';
import {
  canRun,
  computeDependencyState,
  dependencyStateFromCounts,
  statusPrerequisites,
  wouldCreateCycle,
  wouldReplacementCreateCycle,
  type DependencyEdge,
  type DependencyPrerequisiteFact,
} from './task-dependencies';
import {
  VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN,
  type VerificationEpochGate,
} from './verification-dependency';

test('no prerequisites -> NONE (and runnable)', () => {
  const state = computeDependencyState([]);
  assert.equal(state, 'NONE');
  assert.equal(canRun(state), true);
});

test('all prerequisites DONE -> READY (and runnable)', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.DONE]));
  assert.equal(state, 'READY');
  assert.equal(canRun(state), true);
});

test('any prerequisite still open/in-progress -> BLOCKED (not runnable)', () => {
  assert.equal(computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.OPEN])), 'BLOCKED');
  assert.equal(computeDependencyState(statusPrerequisites([TaskStatus.IN_PROGRESS])), 'BLOCKED');
  assert.equal(canRun('BLOCKED'), false);
});

test('a CANCELLED prerequisite escalates to BLOCKED_FAILED even if others are DONE', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.CANCELLED]));
  assert.equal(state, 'BLOCKED_FAILED');
  assert.equal(canRun(state), false);
});

test('CANCELLED wins over a still-pending prerequisite', () => {
  assert.equal(
    computeDependencyState(statusPrerequisites([TaskStatus.OPEN, TaskStatus.CANCELLED])),
    'BLOCKED_FAILED',
  );
});

test('a FAILED prerequisite escalates to BLOCKED_FAILED (needs a human, like CANCELLED)', () => {
  const state = computeDependencyState(statusPrerequisites([TaskStatus.DONE, TaskStatus.FAILED]));
  assert.equal(state, 'BLOCKED_FAILED');
  assert.equal(canRun(state), false);
});

/**
 * The tally form is the one the project task page uses, because counting in SQL is what keeps a
 * 118-node project to one query. Two spellings of a rule are two rules unless something holds them
 * together, so this walks every multiset of prerequisite facts and requires the two to agree on
 * all of them.
 *
 * A fact is a status, whether that prerequisite's work is on the project's integration line
 * (§2.5 J9), and what §13.3 DEP's epoch says about it. Each is a dimension this rule reads, and a
 * sweep that left one out agreed on every multiset for months while the graph drew READY on tasks
 * the dispatcher refused — first over statuses alone (the landing), then over statuses and landings
 * (the epoch).
 *
 * Pairs, not triples. With the epoch crossed in there are 405 facts, and a third level is sixty-six
 * million multisets — a heap limit rather than a test. Pairs lose nothing that matters here: every
 * clause of the rule is a "some count is non-zero" test, so a clause asked in the wrong order shows
 * up between the two facts that set its count, and a count that means the wrong thing shows up on
 * the one fact that sets it.
 */
test('dependencyStateFromCounts agrees with computeDependencyState on every multiset', () => {
  const statuses = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.FAILED];
  // `undefined` is its own case, not a synonym for `true`: it is what every caller that gathers no
  // landing facts sends, and what the rule promises to read as "nothing to land".
  const landings = [true, false, undefined];
  // Every gate the epoch can name, plus the absent one — and `undefined` for the stall flag beside
  // each, because a caller that gathers no liveness facts asserts nothing about them.
  const gates: (VerificationEpochGate | null)[] = [
    null, 'NO_LIVE_VERIFICATION', 'VERIFICATION_IN_FLIGHT', 'VERDICT_ABSENT', 'VERIFICATION_FAILED',
    'VERIFICATION_INCONCLUSIVE', 'VERDICT_UNREVISIONED', 'RUN_NOT_SETTLED', 'SUBJECT_NOT_DONE',
  ];
  const stalls = [true, false, undefined];
  const facts: DependencyPrerequisiteFact[] = statuses.flatMap((status) => landings.flatMap(
    (landed) => gates.flatMap((verificationGate) => stalls.map((verificationGateStalled) => ({
      status, landed, verificationGate, verificationGateStalled,
    }))),
  ));
  const multisets: DependencyPrerequisiteFact[][] = [[]];
  for (let size = 0; size < 2; size += 1) {
    for (const prefix of multisets.filter((m) => m.length === size)) {
      for (const fact of facts) multisets.push([...prefix, fact]);
    }
  }

  for (const prerequisites of multisets) {
    assert.equal(
      dependencyStateFromCounts({
        prerequisites: prerequisites.length,
        terminal: prerequisites.filter((p) => p.status === TaskStatus.CANCELLED || p.status === TaskStatus.FAILED).length,
        done: prerequisites.filter((p) => p.status === TaskStatus.DONE).length,
        // Exactly what the graph query counts: `landed = false`, over every prerequisite.
        unlanded: prerequisites.filter((p) => p.landed === false).length,
        // `verificationEpochOpenSql`, reversed.
        unverified: prerequisites.filter((p) => p.verificationGate != null).length,
        // `verificationEpochNeedsHumanSql`, which is one fragment and not the two clauses its
        // TypeScript half is written as: the static set, plus `verificationLiveness`'s stalls.
        stalled: prerequisites.filter((p) => (p.verificationGate != null
          && VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN.has(p.verificationGate))
          || p.verificationGateStalled === true).length,
      }),
      // Objects with a `status` key, never a bare status array: this rule reads a verification
      // gate and a landing beside each status, and a plain array reaches it as facts with no
      // `status` at all — which answers BLOCKED for every multiset and would have made this
      // agreement test pass by accident on nothing.
      computeDependencyState(prerequisites),
      prerequisites.map((p) => `${p.status}/${p.landed ?? 'unknown'}/${p.verificationGate ?? 'no-check'}`
        + `/${p.verificationGateStalled === undefined ? 'unsaid' : p.verificationGateStalled}`)
        .join(',') || '(no prerequisites)',
    );
  }
});

/** The two spellings are not vacuously equal: the landing dimension moves both of them. */
test('a DONE prerequisite that has not landed is BLOCKED in both spellings', () => {
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, landed: false }]),
    'BLOCKED',
  );
  assert.equal(
    dependencyStateFromCounts({ prerequisites: 1, terminal: 0, done: 1, unlanded: 1 }),
    'BLOCKED',
  );
  assert.equal(
    dependencyStateFromCounts({ prerequisites: 1, terminal: 0, done: 1, unlanded: 0 }),
    'READY',
  );
});

/**
 * ...and neither is the verification dimension, in either of its two tiers.
 *
 * A check that concluded NO and a check that has not concluded are both `unverified`; only the
 * first is `stalled`. A tally that collapsed them would tell a person to go and fix a check that is
 * still running, and one that ignored the dimension entirely — which is what this rule did until
 * the epoch reached it — drew READY on both.
 */
test('a DONE prerequisite held by the epoch is BLOCKED, and a stalled one BLOCKED_FAILED', () => {
  const counts = { prerequisites: 1, terminal: 0, done: 1, unlanded: 0 };
  // `VERIFICATION_IN_FLIGHT`: the check is running, so this is a wait.
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, verificationGate: 'VERIFICATION_IN_FLIGHT' }]),
    'BLOCKED',
  );
  assert.equal(
    dependencyStateFromCounts({ ...counts, unverified: 1, stalled: 0 }),
    'BLOCKED',
  );
  // `VERIFICATION_FAILED`: nothing mechanical advances it, so somebody has to be told.
  assert.equal(
    computeDependencyState([{
      status: TaskStatus.DONE, verificationGate: 'VERIFICATION_FAILED', verificationGateStalled: true,
    }]),
    'BLOCKED_FAILED',
  );
  assert.equal(
    dependencyStateFromCounts({ ...counts, unverified: 1, stalled: 1 }),
    'BLOCKED_FAILED',
  );
  // The default the whole dimension has to keep: a caller that counts nothing about the epoch gets
  // exactly the answer it got before the field existed.
  assert.equal(
    dependencyStateFromCounts({ prerequisites: 1, terminal: 0, done: 1, unlanded: 0, unverified: 0 }),
    'READY',
  );
});

test('self-dependency is a cycle', () => {
  assert.equal(wouldCreateCycle([], 'A', 'A'), true);
});

test('a fresh edge into an empty graph is fine', () => {
  assert.equal(wouldCreateCycle([], 'A', 'B'), false);
});

test('direct back-edge forms a cycle (A->B then B->A)', () => {
  const edges: DependencyEdge[] = [{ taskId: 'A', dependsOnTaskId: 'B' }];
  // B depends on A would close A->B->A.
  assert.equal(wouldCreateCycle(edges, 'B', 'A'), true);
});

test('transitive back-edge forms a cycle (A->B->C then C->A)', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'B', dependsOnTaskId: 'C' },
  ];
  assert.equal(wouldCreateCycle(edges, 'C', 'A'), true);
});

test('a diamond (shared prerequisite) is not a cycle', () => {
  // D depends on B and C; B and C both depend on A. Adding D->C must stay acyclic.
  const edges: DependencyEdge[] = [
    { taskId: 'B', dependsOnTaskId: 'A' },
    { taskId: 'C', dependsOnTaskId: 'A' },
    { taskId: 'D', dependsOnTaskId: 'B' },
  ];
  assert.equal(wouldCreateCycle(edges, 'D', 'C'), false);
});

test('an unrelated new edge in a populated graph is fine', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'C', dependsOnTaskId: 'D' },
  ];
  assert.equal(wouldCreateCycle(edges, 'A', 'D'), false);
});

test('replacing prerequisites rejects a cycle through any proposed edge', () => {
  const edges: DependencyEdge[] = [
    { taskId: 'B', dependsOnTaskId: 'C' },
    { taskId: 'C', dependsOnTaskId: 'A' },
  ];
  assert.equal(wouldReplacementCreateCycle(edges, 'A', ['D', 'B']), true);
});

test("replacing prerequisites ignores the task's outgoing edges being removed", () => {
  const edges: DependencyEdge[] = [
    { taskId: 'A', dependsOnTaskId: 'B' },
    { taskId: 'C', dependsOnTaskId: 'D' },
  ];
  assert.equal(wouldReplacementCreateCycle(edges, 'A', ['C']), false);
  assert.equal(wouldReplacementCreateCycle(edges, 'A', []), false);
});
