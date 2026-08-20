import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  PROJECT_BLOCKER_POLICY,
  ProjectBlockerKind,
  ProjectBlockerProjection,
  projectBlockerDedupeKey,
} from './project-blocker';
import {
  PROJECT_WAKE_FALLBACK_MS,
  PROJECT_WAKE_FLOOR_MS,
  ProjectWakeCandidate,
  ProjectWakeInput,
  chooseProjectWake,
  collectProjectWakeCandidates,
  compareWakeCandidates,
} from './project-next-wake';

const REPO = path.resolve(__dirname, '../../../..');
const SOURCE = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/project-next-wake.ts'),
  'utf8',
);

const EPOCH = Math.floor(Date.parse('2026-08-20T00:00:00.000Z') / 1_000);
const EPOCH_MS = EPOCH * 1_000;
const PROJECT = 'PPPPPPPPPPPPPPPPPPPPPP';

// ── W5 clause 1: the candidate table ────────────────────────────────────────────────────────

test('W5-1: each of the seven clauses produces the frozen (source, subjectType, subjectId)', () => {
  const candidates = collectProjectWakeCandidates(input({
    blockers: [
      projection('PROVIDER_UNAVAILABLE', { id: 'b1', nextCheckAt: at(120_000) }),
      projection('TEST_FAILED', { id: 'b2', escalatedAt: null }),
    ],
    tasks: [
      { id: 't1', retryBackoffUntil: at(30_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
      { id: 't2', retryBackoffUntil: null, runAt: at(90_000), retryBackoffExpired: true, runAtDue: false },
    ],
    hasInFlightSession: true,
    runStateAfter: 'PLANNING',
    rateLimitedTurnWindows: [{ reasonCode: 'MANUAL', windowEndsAt: at(45_000) }],
  }));
  assert.deepEqual(
    candidates.map((c) => [c.source, c.subjectType, c.subjectId]).sort(),
    [
      [1, 'BLOCKER', 'b1'],
      [2, 'BLOCKER', 'b1'],
      [2, 'BLOCKER', 'b2'],
      [3, 'TASK', 't1'],
      [4, 'TASK', 't2'],
      [5, 'PROJECT', PROJECT],
      [6, 'PROJECT', PROJECT],
      [7, 'TURN_WINDOW', 'MANUAL'],
    ].sort(),
  );
  // Clause 1 covers TIME and EVENT only; TEST_FAILED is HUMAN, so it has no recovery poll — only
  // the escalation alarm of clause 2.
  assert.deepEqual(candidates.filter((c) => c.source === 1).map((c) => c.subjectId), ['b1']);
});

test('W5-1: an escalated blocker stops contributing an alarm, and a HUMAN one stops entirely', () => {
  const escalated = projection('TEST_FAILED', { id: 'b1', escalatedAt: at(-60_000) });
  assert.deepEqual(collectProjectWakeCandidates(input({ blockers: [escalated] })), []);
});

test('W5-1: clauses 3 and 4 produce one candidate per task, not one for the earliest', () => {
  const candidates = collectProjectWakeCandidates(input({
    tasks: [
      { id: 't1', retryBackoffUntil: at(60_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
      { id: 't2', retryBackoffUntil: at(60_000), runAt: null, retryBackoffExpired: false, runAtDue: true },
      { id: 't3', retryBackoffUntil: at(10_000), runAt: null, retryBackoffExpired: true, runAtDue: true },
    ],
  }));
  // Two at the same instant, and the expired one contributes nothing.
  assert.deepEqual(candidates.map((c) => c.subjectId), ['t1', 't2']);
});

test('W5-1: clause 7 only fires while a request is actually being held', () => {
  const held = collectProjectWakeCandidates(input({
    rateLimitedTurnWindows: [{ reasonCode: 'MANUAL', windowEndsAt: at(30_000) }],
  }));
  assert.equal(held[0].reason, 'manual trigger rate-limited');
  assert.deepEqual(collectProjectWakeCandidates(input({})).filter((c) => c.source === 7), []);
});

// ── W5 clause 2: one total order ────────────────────────────────────────────────────────────

test('W5-2: the order is (at, source, subjectType, subjectId), byte-wise on the last key', () => {
  const a = candidate({ at: at(10_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' });
  const later = candidate({ at: at(20_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' });
  const higherSource = candidate({ at: at(10_000), source: 2, subjectType: 'BLOCKER', subjectId: 'a' });
  const otherType = candidate({ at: at(10_000), source: 1, subjectType: 'TASK', subjectId: 'a' });
  const otherId = candidate({ at: at(10_000), source: 1, subjectType: 'BLOCKER', subjectId: 'b' });
  assert.ok(compareWakeCandidates(a, later) < 0);
  assert.ok(compareWakeCandidates(a, higherSource) < 0);
  assert.ok(compareWakeCandidates(a, otherType) < 0);
  assert.ok(compareWakeCandidates(a, otherId) < 0);
  // BLOCKER < PROJECT < TASK < TURN_WINDOW, alphabetically, as the contract freezes it.
  const types = ['TURN_WINDOW', 'TASK', 'PROJECT', 'BLOCKER'] as const;
  assert.deepEqual(
    types.map((subjectType) => candidate({ subjectType }))
      .sort(compareWakeCandidates)
      .map((c) => c.subjectType),
    ['BLOCKER', 'PROJECT', 'TASK', 'TURN_WINDOW'],
  );
});

test('W5-2a: two same-instant candidates in ONE source are decided, in every permutation', () => {
  // The exact counterexample `PC-CX-39` names: a provider blocker and a runner blocker both due at
  // 60s. Under `(at, source)` alone the winner — and therefore `nextWakeReason` — came down to
  // array order.
  const table = [
    candidate({ at: at(60_000), source: 1, subjectType: 'BLOCKER', subjectId: 'aaa', reason: 'recheck PROVIDER_UNAVAILABLE' }),
    candidate({ at: at(60_000), source: 1, subjectType: 'BLOCKER', subjectId: 'bbb', reason: 'recheck NO_MATCHING_RUNNER' }),
    candidate({ at: at(60_000), source: 3, subjectType: 'TASK', subjectId: 'ccc', reason: 'task retry backoff expires' }),
  ];
  const expected = JSON.stringify(chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table));
  for (const order of permutations(table)) {
    assert.equal(
      JSON.stringify(chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, order)),
      expected,
      'the answer and the audit table must be byte-identical under every traversal order',
    );
  }
  const chosen = chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table);
  assert.equal(chosen.nextWakeReason, 'recheck PROVIDER_UNAVAILABLE');
});

test('W5-4: the whole table is audited, sorted, and losers are recorded rather than dropped', () => {
  const decision = chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, [
    candidate({ at: at(90_000), source: 4, subjectType: 'TASK', subjectId: 'z' }),
    candidate({ at: at(30_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' }),
  ]);
  assert.equal(decision.candidates.length, 2);
  assert.deepEqual(decision.candidates.map((c) => c.at), [at(30_000), at(90_000)]);
  assert.equal(decision.nextWakeAt, at(30_000));
  assert.equal(decision.flooredBy, null);
});

// ── W5 clause 3: the floor ──────────────────────────────────────────────────────────────────

test('W3: every remaining-window value has a legal answer, and the floor never loses', () => {
  // §10.4's own measurable form. `remaining` is how much of a 60s rate-limit window is left when
  // this pass evaluates; the last five seconds are where "at most the deadline" and "at least
  // now + 5s" had no common solution before W5 (`PC-CX-35`).
  for (const remaining of [0, 1, 2, 4, 5, 6, 59]) {
    const nextAttemptAt = EPOCH_MS + remaining * 1_000;
    const decision = chooseProjectWake({ epoch: EPOCH, runStateAfter: 'PLANNING' }, [
      candidate({
        at: new Date(nextAttemptAt).toISOString(),
        source: 7,
        subjectType: 'TURN_WINDOW',
        subjectId: 'MANUAL',
        reason: 'manual trigger rate-limited',
      }),
    ]);
    const wake = Date.parse(decision.nextWakeAt!);
    assert.ok(wake >= EPOCH_MS + PROJECT_WAKE_FLOOR_MS, `W3 lower bound at remaining=${remaining}`);
    assert.ok(wake <= nextAttemptAt + PROJECT_WAKE_FLOOR_MS, `I18-C upper bound at remaining=${remaining}`);
    // The reason always stays the winner's: it answers "what am I waking for", not "am I on time".
    assert.equal(decision.nextWakeReason, 'manual trigger rate-limited');
    assert.equal(decision.flooredBy, remaining < 5 ? 'W3' : null);
  }
});

test('W3: the floor is measured from the frozen epoch, never from a second clock', () => {
  // `PC-CX-40`: reading `now()` here would give one serialized `decisionInput` two legal answers
  // depending on how long the pass took to reach this line. The guard is structural — the module
  // may not read a clock at all — because a timing test could pass by being fast.
  const clockReads = SOURCE.match(/Date\.now\(\)|new Date\(\s*\)/g) ?? [];
  assert.deepEqual(clockReads, [], 'the wake algorithm must read no clock but `evaluation.epoch`');
  const table = [candidate({ at: at(1_000), source: 1, subjectType: 'BLOCKER', subjectId: 'a' })];
  const first = chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table);
  assert.equal(first.nextWakeAt, at(PROJECT_WAKE_FLOOR_MS));
  assert.equal(JSON.stringify(chooseProjectWake({ epoch: EPOCH, runStateAfter: 'BLOCKED' }, table)),
    JSON.stringify(first), 'same input, same answer, whenever it runs');
});

// ── N-null and N-mask ───────────────────────────────────────────────────────────────────────

test('N-null: SETTLED stops the clock', () => {
  const decision = chooseProjectWake({ epoch: EPOCH, runStateAfter: 'SETTLED' }, [
    candidate({ at: at(60_000) }),
  ]);
  assert.equal(decision.nextWakeAt, null);
  assert.equal(decision.nextWakeReason, null);
});

test('N-null: the only other legal stop is every open blocker HUMAN and already escalated', () => {
  const escalated = [
    projection('TEST_FAILED', { id: 'b1', escalatedAt: at(-60_000) }),
    projection('AWAITING_USER_APPROVAL', { id: 'b2', escalatedAt: at(-60_000) }),
  ];
  const candidates = collectProjectWakeCandidates(input({
    blockers: escalated,
    runStateAfter: 'AWAITING_HUMAN',
  }));
  assert.deepEqual(candidates, []);
  assert.equal(chooseProjectWake({ epoch: EPOCH, runStateAfter: 'AWAITING_HUMAN' }, candidates).nextWakeAt, null);

  // One un-escalated row is enough to keep it ticking — that alarm is the whole reason a project
  // waiting on a person still has a clock.
  const mixed = collectProjectWakeCandidates(input({
    blockers: [...escalated, projection('WHO_NOT_IN_TEAM', { id: 'b3' })],
    runStateAfter: 'AWAITING_HUMAN',
  }));
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].source, 2);
});

test('I5: a state no clause names still gets a wake instead of a silent stop', () => {
  // AWAITING_VERIFICATION with nothing in flight matches no clause today. A NULL there is the
  // defect §10.2 W4 would catch five minutes later; this records a wake instead.
  const candidates = collectProjectWakeCandidates(input({ runStateAfter: 'AWAITING_VERIFICATION' }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, 'verification may settle');
  assert.equal(candidates[0].at, at(PROJECT_WAKE_FALLBACK_MS));
  // And it never runs when anything else produced a candidate.
  const withWork = collectProjectWakeCandidates(input({
    runStateAfter: 'AWAITING_VERIFICATION',
    hasInFlightSession: true,
  }));
  assert.deepEqual(withWork.map((c) => c.source), [5]);
});

test('N-mask: a USER blocker cannot stop the clock of the SYSTEM blockers it masks', () => {
  const candidates = collectProjectWakeCandidates(input({
    // The masking USER row and the masked SYSTEM row, together — I4b says the second is still open.
    blockers: [
      projection('TEST_FAILED', { id: 'human', escalatedAt: at(-60_000) }),
      projection('PROVIDER_UNAVAILABLE', { id: 'system', nextCheckAt: at(300_000) }),
    ],
    runStateAfter: 'AWAITING_HUMAN',
  }));
  assert.deepEqual(
    candidates.map((c) => [c.source, c.subjectId]),
    [[1, 'system'], [2, 'system']],
    'an approval blocker must not freeze every provider blocker in the same project',
  );
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

function input(overrides: Partial<ProjectWakeInput>): ProjectWakeInput {
  return {
    epoch: EPOCH,
    projectId: PROJECT,
    runStateAfter: 'BLOCKED',
    blockers: [],
    tasks: [],
    hasInFlightSession: false,
    rateLimitedTurnWindows: [],
    ...overrides,
  };
}

function projection(
  kind: ProjectBlockerKind,
  overrides: Partial<ProjectBlockerProjection> = {},
): ProjectBlockerProjection {
  const policy = PROJECT_BLOCKER_POLICY[kind];
  return {
    id: null,
    kind,
    owner: policy.owner,
    recovery: policy.recovery,
    dedupeKey: projectBlockerDedupeKey(kind, 'TASK', 'task'),
    subjectType: 'TASK',
    subjectId: 'task',
    firstSeenAt: at(0),
    nextCheckAt: at(policy.pollMs ?? policy.escalateMs),
    escalatedAt: null,
    requiredAction: policy.requiredAction,
    conditionVersion: '0'.repeat(64),
    lifecycleGeneration: '1',
    ...overrides,
  };
}

function candidate(overrides: Partial<ProjectWakeCandidate> = {}): ProjectWakeCandidate {
  return {
    at: at(60_000),
    source: 1,
    subjectType: 'BLOCKER',
    subjectId: 'a',
    reason: 'recheck',
    ...overrides,
  };
}

function at(offsetMs: number): string {
  return new Date(EPOCH_MS + offsetMs).toISOString();
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]));
}
