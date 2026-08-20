import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_BLOCKER_KINDS,
  PROJECT_BLOCKER_POLICY,
  ProjectBlockerKind,
  ProjectBlockerProjection,
  projectBlockerDedupeKey,
} from './project-blocker';
import {
  PROJECT_WAKE_FALLBACK_MS,
  PROJECT_WAKE_FLOOR_MS,
  PROJECT_TURN_RATE_LIMIT_MS,
  ProjectWakeCandidate,
  ProjectWakeInput,
  chooseProjectWake,
  collectProjectWakeCandidates,
  compareWakeCandidates,
} from './project-next-wake';

/**
 * Independent verification of §10.4 W5 (unit 18).
 *
 * The contract writes its own testable form: run `remaining ∈ {0,1,2,4,5,6,59}s`, permute the
 * candidates within a source, and delay the same input by a few seconds of wall clock. This states
 * those as properties over generated candidate tables, plus the two closure claims the prose makes
 * — that the order really is total, and that a NULL only ever comes out of N-null's two branches.
 */

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const EPOCH = 1_760_000_000;
const PROJECT = 'proj01';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function blocker(
  index: number,
  kind: ProjectBlockerKind,
  options: { firstSeenMs: number; nextCheckMs: number; escalated: boolean; onDisk: boolean },
): ProjectBlockerProjection {
  const policy = PROJECT_BLOCKER_POLICY[kind];
  const subjectId = `sub${index}`;
  return {
    id: options.onDisk ? `blk${index}` : null,
    kind,
    owner: policy.owner,
    recovery: policy.recovery,
    dedupeKey: projectBlockerDedupeKey(kind, 'TASK', subjectId),
    subjectType: 'TASK',
    subjectId,
    firstSeenAt: iso(options.firstSeenMs),
    nextCheckAt: iso(options.nextCheckMs),
    escalatedAt: options.escalated ? iso(options.firstSeenMs) : null,
    requiredAction: policy.requiredAction,
    conditionVersion: 'v',
    lifecycleGeneration: '1',
  };
}

/** A world with every clause of W5 plausibly firing, so the generated tables are not all trivial. */
function world(seed: number): ProjectWakeInput {
  const random = rng(seed);
  const epochMs = EPOCH * 1_000;
  const blockers: ProjectBlockerProjection[] = [];
  for (let i = 0; i < Math.floor(random() * 5); i += 1) {
    blockers.push(blocker(i, pick(random, PROJECT_BLOCKER_KINDS), {
      firstSeenMs: epochMs - Math.floor(random() * 3_600_000),
      // Deliberately includes instants in the past, which is exactly where the W3 floor bites.
      nextCheckMs: epochMs + Math.floor((random() - 0.35) * 600_000),
      escalated: random() < 0.3,
      onDisk: random() < 0.8,
    }));
  }
  const tasks: Array<ProjectWakeInput['tasks'][number]> = [];
  for (let i = 0; i < Math.floor(random() * 5); i += 1) {
    const backing = random() < 0.5;
    const scheduled = random() < 0.5;
    tasks.push({
      id: `task${i}`,
      retryBackoffUntil: backing ? iso(epochMs + Math.floor(random() * 300_000)) : null,
      runAt: scheduled ? iso(epochMs + Math.floor(random() * 300_000)) : null,
      retryBackoffExpired: !backing || random() < 0.3,
      runAtDue: !scheduled || random() < 0.3,
    });
  }
  return {
    epoch: EPOCH,
    projectId: PROJECT,
    runStateAfter: pick(random, ['PLANNING', 'EXECUTING', 'BLOCKED', 'AWAITING_HUMAN', 'AWAITING_VERIFICATION']),
    blockers,
    tasks,
    hasInFlightSession: random() < 0.4,
    rateLimitedTurnWindows: random() < 0.35
      ? [{ reasonCode: 'MANUAL', windowEndsAt: iso(epochMs + Math.floor(random() * 60_000)) }]
      : [],
  };
}

/** W5 clause 2 spelled out again, independently of the implementation's comparator. */
function lexicographicMin(candidates: readonly ProjectWakeCandidate[]): ProjectWakeCandidate | null {
  const order = { BLOCKER: 0, PROJECT: 1, TASK: 2, TURN_WINDOW: 3 };
  let best: ProjectWakeCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) { best = candidate; continue; }
    const keys: Array<[number | string, number | string]> = [
      [Date.parse(candidate.at), Date.parse(best.at)],
      [candidate.source, best.source],
      [order[candidate.subjectType], order[best.subjectType]],
      [candidate.subjectId, best.subjectId],
    ];
    for (const [a, b] of keys) {
      if (a === b) continue;
      if (a < b) best = candidate;
      break;
    }
  }
  return best;
}

test('§10.4 W5 properties over generated candidate tables', async (t) => {
  await t.test('W5-2a: (source, subjectType, subjectId) identifies a candidate uniquely', () => {
    for (const seed of SEEDS) {
      const candidates = collectProjectWakeCandidates(world(seed));
      const keys = candidates.map((one) => `${one.source}|${one.subjectType}|${one.subjectId}`);
      assert.equal(new Set(keys).size, keys.length,
        `seed=${seed}: two candidates share the last three sort keys, so the order is not total`);
    }
  });

  await t.test('W5-2: the winner is the lexicographic minimum, whatever order it arrived in', () => {
    for (const seed of SEEDS) {
      const input = world(seed);
      const candidates = collectProjectWakeCandidates(input);
      const baseline = chooseProjectWake(input, candidates);
      const expected = lexicographicMin(candidates);
      assert.equal(baseline.nextWakeReason, expected ? expected.reason : null,
        `seed=${seed}: the chosen reason is not the minimum under (at, source, subjectType, subjectId)`);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const permuted = chooseProjectWake(input, shuffle(rng(seed * 601 + attempt), candidates));
        assert.deepEqual(permuted, baseline,
          `seed=${seed} attempt=${attempt}: the answer depends on the traversal order`);
      }
    }
  });

  await t.test('W5-2a again: same instant, same source, permuted — byte-identical answers', () => {
    // The exact shape `PC-CX-39` names: one source producing several candidates at one instant.
    const at = iso((EPOCH + 60) * 1_000);
    const table: ProjectWakeCandidate[] = [
      { at, source: 1, subjectType: 'BLOCKER', subjectId: 'blkA', reason: 'recheck PROVIDER_UNAVAILABLE' },
      { at, source: 1, subjectType: 'BLOCKER', subjectId: 'blkB', reason: 'recheck NO_MATCHING_RUNNER' },
      { at, source: 1, subjectType: 'BLOCKER', subjectId: 'blkC', reason: 'recheck MERGE_CONFLICT' },
      { at, source: 3, subjectType: 'TASK', subjectId: 'task1', reason: 'task retry backoff expires' },
      { at, source: 4, subjectType: 'TASK', subjectId: 'task1', reason: 'task becomes due' },
    ];
    const input = { epoch: EPOCH, runStateAfter: 'PLANNING' };
    const baseline = chooseProjectWake(input, table);
    assert.equal(baseline.nextWakeReason, 'recheck PROVIDER_UNAVAILABLE');
    const seen = new Set<string>();
    const permute = (rest: ProjectWakeCandidate[], prefix: ProjectWakeCandidate[]): void => {
      if (rest.length === 0) {
        seen.add(JSON.stringify(chooseProjectWake(input, prefix)));
        return;
      }
      for (let i = 0; i < rest.length; i += 1) {
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...prefix, rest[i]]);
      }
    };
    permute(table, []);
    assert.equal(seen.size, 1, 'all 120 permutations must give one byte-identical answer');
    assert.equal([...seen][0], JSON.stringify(baseline));
  });

  await t.test('W3: the floor is hard, and it is measured from the frozen epoch', () => {
    for (const seed of SEEDS) {
      const input = world(seed);
      const candidates = collectProjectWakeCandidates(input);
      const decision = chooseProjectWake(input, candidates);
      if (decision.nextWakeAt === null) continue;
      const floor = EPOCH * 1_000 + PROJECT_WAKE_FLOOR_MS;
      assert.ok(Date.parse(decision.nextWakeAt) >= floor,
        `seed=${seed}: ${decision.nextWakeAt} is closer than 5s to the epoch`);
      const chosen = lexicographicMin(candidates)!;
      assert.equal(decision.flooredBy, Date.parse(chosen.at) < floor ? 'W3' : null,
        `seed=${seed}: flooredBy does not record whether the floor moved the answer`);
      assert.equal(decision.nextWakeAt,
        iso(Math.max(Date.parse(chosen.at), floor)),
        `seed=${seed}: nextWakeAt is not max(chosen.at, epoch + 5s)`);
      // Clause 3: the floor moves the instant, never the reason.
      assert.equal(decision.nextWakeReason, chosen.reason);
      assert.deepEqual(decision.candidates, [...candidates].sort(compareWakeCandidates),
        `seed=${seed}: the audit table is not the sorted candidate table`);
    }
  });

  await t.test('W5 clause 3 / TR2: the last seconds of a rate-limit window have one legal answer', () => {
    // The contract's own testable form, run literally.
    for (const remaining of [0, 1, 2, 4, 5, 6, 59]) {
      const epochMs = EPOCH * 1_000;
      const windowEndsAt = iso(epochMs + remaining * 1_000);
      const decision = chooseProjectWake(
        { epoch: EPOCH, runStateAfter: 'PLANNING' },
        collectProjectWakeCandidates({
          epoch: EPOCH,
          projectId: PROJECT,
          runStateAfter: 'PLANNING',
          blockers: [],
          tasks: [],
          hasInFlightSession: false,
          rateLimitedTurnWindows: [{ reasonCode: 'MANUAL', windowEndsAt }],
        }),
      );
      assert.ok(decision.nextWakeAt, `remaining=${remaining}: a rate-limited request lost its timer`);
      const wake = Date.parse(decision.nextWakeAt!);
      assert.ok(wake >= epochMs + PROJECT_WAKE_FLOOR_MS, `remaining=${remaining}: W3 violated`);
      assert.ok(wake <= Date.parse(windowEndsAt) + PROJECT_WAKE_FLOOR_MS,
        `remaining=${remaining}: I18-C violated`);
      assert.equal(decision.nextWakeReason, 'manual trigger rate-limited',
        `remaining=${remaining}: TR2-e requires the window's own reason`);
      assert.equal(decision.flooredBy, remaining < 5 ? 'W3' : null);
      assert.equal(PROJECT_TURN_RATE_LIMIT_MS, 60_000);
    }
  });

  await t.test('N-null is closed: a null wake means SETTLED or nothing can move the project', () => {
    for (const seed of SEEDS) {
      const input = world(seed);
      const decision = chooseProjectWake(input, collectProjectWakeCandidates(input));
      if (decision.nextWakeAt !== null) continue;
      assert.notEqual(input.runStateAfter, 'PLANNING',
        `seed=${seed}: PLANNING must always have clause 6`);
      assert.equal(input.tasks.every((task) =>
        (!task.retryBackoffUntil || task.retryBackoffExpired) && (!task.runAt || task.runAtDue)), true,
      `seed=${seed}: a waiting task lost its timer`);
      assert.equal(input.hasInFlightSession, false, `seed=${seed}: an in-flight session lost its backstop`);
      assert.deepEqual(input.rateLimitedTurnWindows, [],
        `seed=${seed}: a rate-limited request lost its retry instant`);
      assert.ok(input.blockers.length > 0,
        `seed=${seed}: a project with no blocker at all stopped its own clock`);
      for (const one of input.blockers) {
        assert.equal(one.recovery, 'HUMAN',
          `seed=${seed}: ${one.kind} recovers without a person but got no timer`);
        assert.ok(one.escalatedAt,
          `seed=${seed}: an unescalated blocker stopped the clock instead of setting its alarm`);
      }
    }
  });

  await t.test('N-mask: a USER blocker never silences the clock of the ones it masks', () => {
    const epochMs = EPOCH * 1_000;
    const masked = blocker(1, 'PROVIDER_UNAVAILABLE', {
      firstSeenMs: epochMs - 10_000,
      nextCheckMs: epochMs + 300_000,
      escalated: false,
      onDisk: true,
    });
    const human = blocker(2, 'WHO_NOT_IN_TEAM', {
      firstSeenMs: epochMs - 10_000,
      nextCheckMs: epochMs + 3_600_000,
      escalated: true,
      onDisk: true,
    });
    const candidates = collectProjectWakeCandidates({
      epoch: EPOCH,
      projectId: PROJECT,
      runStateAfter: 'AWAITING_HUMAN',
      blockers: [human, masked],
      tasks: [],
      hasInFlightSession: false,
      rateLimitedTurnWindows: [],
    });
    assert.ok(candidates.some((one) => one.source === 1 && one.subjectId === masked.id),
      'the masked EVENT blocker lost its recompute poll');
    assert.ok(candidates.some((one) => one.source === 2 && one.subjectId === masked.id),
      'the masked blocker lost its escalation alarm');
    assert.ok(!candidates.some((one) => one.source === 2 && one.subjectId === human.id),
      'an already escalated blocker must not ask to be escalated again');
  });

  await t.test('clause 2 covers HUMAN blockers, which is the only clock a waiting project has', () => {
    for (const kind of PROJECT_BLOCKER_KINDS) {
      const epochMs = EPOCH * 1_000;
      const one = blocker(1, kind as ProjectBlockerKind, {
        firstSeenMs: epochMs,
        nextCheckMs: epochMs + 60_000,
        escalated: false,
        onDisk: true,
      });
      const candidates = collectProjectWakeCandidates({
        epoch: EPOCH,
        projectId: PROJECT,
        runStateAfter: 'BLOCKED',
        blockers: [one],
        tasks: [],
        hasInFlightSession: false,
        rateLimitedTurnWindows: [],
      });
      const escalation = candidates.find((candidate) => candidate.source === 2);
      assert.ok(escalation, `${kind}: no escalation alarm before it has fired`);
      assert.equal(escalation!.at, iso(epochMs + PROJECT_BLOCKER_POLICY[kind].escalateMs),
        `${kind}: the alarm is not first_seen_at + threshold`);
      const poll = candidates.find((candidate) => candidate.source === 1);
      assert.equal(Boolean(poll), PROJECT_BLOCKER_POLICY[kind].recovery !== 'HUMAN',
        `${kind}: clause 1 must cover exactly TIME and EVENT`);
    }
  });

  await t.test('the empty-table backstop can only fire when nothing else produced a candidate', () => {
    for (const seed of SEEDS) {
      const input = world(seed);
      const candidates = collectProjectWakeCandidates(input);
      const backstop = candidates.filter((candidate) =>
        candidate.source === 6 && candidate.subjectType === 'PROJECT'
        && input.runStateAfter !== 'PLANNING');
      if (backstop.length === 0) continue;
      assert.equal(candidates.length, 1,
        `seed=${seed}: the backstop fired alongside a candidate the contract does define`);
      assert.equal(input.blockers.length, 0);
      assert.equal(Date.parse(candidates[0].at), EPOCH * 1_000 + PROJECT_WAKE_FALLBACK_MS,
        `seed=${seed}: the backstop must be a 60s recheck, not a spin`);
    }
  });

  await t.test('S3/PC-CX-40: the answer does not move with the wall clock', async () => {
    const input = world(3);
    const candidates = collectProjectWakeCandidates(input);
    const first = chooseProjectWake(input, candidates);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const later = chooseProjectWake(input, collectProjectWakeCandidates(input));
    assert.deepEqual(later, first, 'the same declared input gave two answers a second apart');
  });
});
