import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ObservedBlockerCondition,
  PROJECT_BLOCKER_KINDS,
  PROJECT_BLOCKER_NON_BLOCKING_REFUSALS,
  PROJECT_BLOCKER_POLICY,
  PROJECT_BLOCKER_REFUSAL_KINDS,
  PROJECT_BLOCKER_SUBJECT_TYPES,
  PROJECT_BLOCKER_TURN_KINDS,
  ProjectBlockerFact,
  ProjectBlockerKind,
  ProjectBlockerSubjectType,
  blockerKindForRefusal,
  blockerRunState,
  planProjectBlockers,
  projectBlockerDedupeKey,
} from './project-blocker';

/**
 * Independent verification of §11 (unit 18): the dedupe rule, ES5's redelivery equivalence, ES3/ES1
 * escalation and BL2's fail-closed mapping, stated as properties over generated worlds.
 *
 * ES5 is the one that cannot be written as a table: it quantifies over "the same world facts
 * delivered N times, in any order, across restarts", and the only honest way to check that is to
 * generate a world, deliver it N times, and compare every column the contract freezes.
 */

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
const EPOCH = 1_760_000_000; // fixed instant, seconds — no wall clock anywhere in this file

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

const SUBJECTS = ['s1', 's2', 's3', 's4'];

function conditions(seed: number, count: number): ObservedBlockerCondition[] {
  const random = rng(seed);
  const out: ObservedBlockerCondition[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = pick(random, PROJECT_BLOCKER_KINDS);
    const subjectType = pick(random, PROJECT_BLOCKER_SUBJECT_TYPES);
    const subjectId = pick(random, SUBJECTS);
    out.push({
      kind,
      subjectType,
      subjectId,
      // A duplicate key inside one pass is "the same condition seen twice" (planProjectBlockers'
      // own words), so the generator makes the facts a function of the key. Two detectors that
      // disagreed about the facts of ONE key would be resolved by the detector list's fixed order,
      // which is a property of `detectProjectBlockerConditions`, not of this planner.
      facts: { kind, subjectType, subjectId },
      detail: { note: `${kind}/${subjectId}` },
      ...(PROJECT_BLOCKER_POLICY[kind].recovery === 'TIME' && random() < 0.8
        ? { recoveryAt: new Date((EPOCH + 3600) * 1_000).toISOString() }
        : {}),
    });
  }
  return out;
}

/**
 * Open rows as the database would hold them. `ageMs` spreads `first_seen_at` across the escalation
 * threshold so both sides of ES4 are generated.
 */
function openRows(seed: number, from: readonly ObservedBlockerCondition[]): ProjectBlockerFact[] {
  const random = rng(seed + 9001);
  const seen = new Set<string>();
  const rows: ProjectBlockerFact[] = [];
  for (const condition of from) {
    const dedupeKey = projectBlockerDedupeKey(condition.kind, condition.subjectType, condition.subjectId);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (random() < 0.4) continue;
    const policy = PROJECT_BLOCKER_POLICY[condition.kind];
    const ageMs = Math.floor(random() * policy.escalateMs * 2);
    const firstSeenAt = new Date(EPOCH * 1_000 - ageMs).toISOString();
    rows.push({
      id: `blk${rows.length}`,
      kind: condition.kind,
      owner: policy.owner,
      recovery: policy.recovery,
      severity: policy.severity,
      requiredAction: policy.requiredAction,
      subjectType: condition.subjectType,
      subjectId: condition.subjectId,
      dedupeKey,
      lifecycleGeneration: String(1 + Math.floor(random() * 3)),
      conditionVersion: 'stored-digest',
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      occurrences: 1,
      nextCheckAt: new Date(EPOCH * 1_000).toISOString(),
      escalatedAt: random() < 0.25 ? firstSeenAt : null,
    });
  }
  // Rows whose condition this pass will NOT observe — the auto-clear half of §11.4.
  for (let i = 0; i < 2; i += 1) {
    const kind = pick(random, PROJECT_BLOCKER_KINDS);
    const dedupeKey = projectBlockerDedupeKey(kind, 'TASK', `stale${i}`);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const policy = PROJECT_BLOCKER_POLICY[kind];
    const firstSeenAt = new Date(EPOCH * 1_000 - 120_000).toISOString();
    rows.push({
      id: `stale${i}`,
      kind,
      owner: policy.owner,
      recovery: policy.recovery,
      severity: policy.severity,
      requiredAction: policy.requiredAction,
      subjectType: 'TASK',
      subjectId: `stale${i}`,
      dedupeKey,
      lifecycleGeneration: '1',
      conditionVersion: 'stored-digest',
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      occurrences: 3,
      nextCheckAt: new Date(EPOCH * 1_000).toISOString(),
      escalatedAt: null,
    });
  }
  return rows;
}

test('§11 blocker properties over generated worlds', async (t) => {
  await t.test('BL4: opensTurn is true for exactly the kinds whose default owner is COORDINATOR', () => {
    for (const kind of PROJECT_BLOCKER_KINDS) {
      const policy = PROJECT_BLOCKER_POLICY[kind];
      assert.equal(policy.opensTurn, policy.owner === 'COORDINATOR',
        `${kind}: opensTurn and the default owner disagree`);
      assert.ok(policy.escalateMs > 0, `${kind}: a non-positive escalation threshold`);
    }
    assert.deepEqual([...PROJECT_BLOCKER_TURN_KINDS].sort(),
      PROJECT_BLOCKER_KINDS.filter((kind) => PROJECT_BLOCKER_POLICY[kind].owner === 'COORDINATOR')
        .slice().sort());
  });

  await t.test('BL2: every refusal code is either a frozen non-blocker or a kind, never a shrug', () => {
    const random = rng(4242);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789';
    const probes = [
      '', 'unknown', 'PROVIDER_GONE', 'provider_unavailable', 'WHO_UNRESOLVED ',
      ...Array.from({ length: 200 }, () => {
        let code = '';
        for (let i = 0; i < 1 + Math.floor(random() * 24); i += 1) {
          code += alphabet[Math.floor(random() * alphabet.length)];
        }
        return code;
      }),
    ];
    for (const code of probes) {
      const kind = blockerKindForRefusal(code);
      if (PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code)) {
        assert.equal(kind, null, `${code}: a frozen non-blocker became a blocker`);
        continue;
      }
      assert.ok(kind, `${code}: an unclassified refusal produced no blocker (BL2 is fail closed)`);
      assert.equal(kind, PROJECT_BLOCKER_REFUSAL_KINDS[code] ?? 'UNKNOWN_FAILURE',
        `${code}: mapped to something other than its frozen kind`);
    }
    for (const [code, expected] of Object.entries(PROJECT_BLOCKER_REFUSAL_KINDS)) {
      assert.equal(blockerKindForRefusal(code), expected);
      assert.ok(!PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code),
        `${code} is in both frozen lists, so its answer depends on which is read first`);
    }
    assert.equal(blockerKindForRefusal(null), 'UNKNOWN_FAILURE');
    assert.equal(blockerKindForRefusal(undefined), 'UNKNOWN_FAILURE');
  });

  await t.test('§11.3: one open row per dedupe key, and never both touched and cleared', () => {
    for (const seed of SEEDS) {
      const observed = conditions(seed, 12);
      const open = openRows(seed, observed);
      const plan = planProjectBlockers({ epoch: EPOCH, open, observed });

      const raisedKeys = plan.raises.map((raise) => raise.dedupeKey);
      assert.equal(new Set(raisedKeys).size, raisedKeys.length,
        `seed=${seed}: the same key was raised twice in one pass`);
      const openKeys = new Set(open.map((row) => row.dedupeKey));
      for (const key of raisedKeys) {
        assert.ok(!openKeys.has(key), `seed=${seed}: ${key} was raised while already open`);
      }
      const touchedIds = new Set(plan.touches.map((touch) => touch.blockerId));
      for (const clear of plan.clears) {
        assert.ok(!touchedIds.has(clear.blockerId),
          `seed=${seed}: ${clear.blockerId} was touched and cleared in one pass`);
      }
      // §11.4: cleared is exactly the open rows this recomputation no longer observes.
      const observedKeys = new Set(observed.map((condition) =>
        projectBlockerDedupeKey(condition.kind, condition.subjectType, condition.subjectId)));
      assert.deepEqual(plan.clears.map((clear) => clear.dedupeKey).sort(),
        open.filter((row) => !observedKeys.has(row.dedupeKey)).map((row) => row.dedupeKey).sort(),
        `seed=${seed}: auto-clear is not the set difference §11.4 defines`);
      // The projection the rest of the pass reads is exactly the post-commit open set.
      assert.deepEqual(plan.openAfter.map((row) => row.dedupeKey).sort(), [...observedKeys].sort(),
        `seed=${seed}: openAfter is not the observed key set`);
    }
  });

  await t.test('the plan does not depend on the order conditions or rows were collected in', () => {
    for (const seed of SEEDS) {
      const observed = conditions(seed, 12);
      const open = openRows(seed, observed);
      const baseline = planProjectBlockers({ epoch: EPOCH, open, observed });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const random = rng(seed * 977 + attempt);
        const permuted = planProjectBlockers({
          epoch: EPOCH,
          open: shuffle(random, open),
          observed: shuffle(random, observed),
        });
        assert.deepEqual(permuted, baseline,
          `seed=${seed} attempt=${attempt}: the blocker plan depends on collection order`);
      }
    }
  });

  await t.test('ES5: delivering the same facts N times equals delivering them once', () => {
    for (const seed of SEEDS) {
      const observed = conditions(seed, 10);
      let open = openRows(seed, observed);

      /** Commit a plan the way `applyBlockers` does, so the next pass reads the new rows. */
      const commit = (rows: ProjectBlockerFact[], plan: ReturnType<typeof planProjectBlockers>,
        generations: Map<string, bigint>): ProjectBlockerFact[] => {
        const byId = new Map(rows.map((row) => [row.id, { ...row }]));
        for (const clear of plan.clears) byId.delete(clear.blockerId);
        for (const touch of plan.touches) {
          const row = byId.get(touch.blockerId)!;
          row.occurrences += 1;
          row.lastSeenAt = touch.lastSeenAt;
          row.conditionVersion = touch.conditionVersion;
          row.nextCheckAt = touch.nextCheckAt;
        }
        for (const escalation of plan.escalations) {
          const row = byId.get(escalation.blockerId)!;
          row.owner = 'USER';
          row.escalatedAt = new Date(EPOCH * 1_000).toISOString();
        }
        for (const raise of plan.raises) {
          const generation = (generations.get(raise.dedupeKey) ?? 0n) + 1n;
          generations.set(raise.dedupeKey, generation);
          byId.set(`new:${raise.dedupeKey}`, {
            id: `new:${raise.dedupeKey}`,
            kind: raise.kind,
            owner: raise.owner,
            recovery: raise.recovery,
            severity: raise.severity,
            requiredAction: raise.requiredAction,
            subjectType: raise.subjectType,
            subjectId: raise.subjectId,
            dedupeKey: raise.dedupeKey,
            lifecycleGeneration: String(generation),
            conditionVersion: raise.conditionVersion,
            firstSeenAt: raise.firstSeenAt,
            lastSeenAt: raise.firstSeenAt,
            occurrences: 1,
            nextCheckAt: raise.nextCheckAt,
            escalatedAt: null,
          });
        }
        return [...byId.values()];
      };

      const generations = new Map<string, bigint>(
        open.map((row) => [row.dedupeKey, BigInt(row.lifecycleGeneration)]),
      );
      const once = planProjectBlockers({ epoch: EPOCH, open, observed });
      const afterOnce = commit(open, once, new Map(generations));
      const notifications = once.escalations.length;

      // N redeliveries of the SAME facts, shuffled each time, with the row set carried forward as
      // the database would carry it. A restart is modelled by re-planning from the committed rows.
      const total = 5;
      const carriedGenerations = new Map(generations);
      let carried = open;
      let escalationsSeen = 0;
      for (let delivery = 0; delivery < total; delivery += 1) {
        const random = rng(seed * 31 + delivery);
        const plan = planProjectBlockers({
          epoch: EPOCH,
          open: shuffle(random, carried),
          observed: shuffle(random, observed),
        });
        escalationsSeen += plan.escalations.length;
        if (delivery > 0) {
          assert.deepEqual(plan.raises, [],
            `seed=${seed}: redelivery ${delivery} opened a second episode for the same condition`);
          assert.deepEqual(plan.clears, [],
            `seed=${seed}: redelivery ${delivery} cleared a condition that is still true`);
        }
        carried = commit(carried, plan, carriedGenerations);
      }

      assert.equal(escalationsSeen, notifications,
        `seed=${seed}: ${total} redeliveries produced ${escalationsSeen} escalations, once produced ${notifications}`);

      const frozen = (rows: readonly ProjectBlockerFact[]) => [...rows]
        .sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1))
        .map((row) => ({
          kind: row.kind,
          owner: row.owner,
          recovery: row.recovery,
          requiredAction: row.requiredAction,
          dedupeKey: row.dedupeKey,
          lifecycleGeneration: row.lifecycleGeneration,
          conditionVersion: row.conditionVersion,
          firstSeenAt: row.firstSeenAt,
          escalatedAt: row.escalatedAt,
        }));
      assert.deepEqual(frozen(carried), frozen(afterOnce),
        `seed=${seed}: a column ES5 freezes moved with the number of deliveries`);
      assert.deepEqual(blockerRunState(carried), blockerRunState(afterOnce),
        `seed=${seed}: run_state moved with the number of deliveries`);
    }
  });

  await t.test('ES1/ES3/ES4: escalation is once, always to USER, and never touches recovery', () => {
    for (const seed of SEEDS) {
      const observed = conditions(seed, 12);
      const open = openRows(seed, observed);
      const plan = planProjectBlockers({ epoch: EPOCH, open, observed });
      const byId = new Map(open.map((row) => [row.id, row]));

      for (const escalation of plan.escalations) {
        const row = byId.get(escalation.blockerId)!;
        assert.equal(row.escalatedAt, null, `seed=${seed}: ${row.id} was escalated twice`);
        assert.equal(escalation.owner, 'USER', `seed=${seed}: ES3 says the target is always USER`);
        const dueAt = Date.parse(row.firstSeenAt) + PROJECT_BLOCKER_POLICY[row.kind].escalateMs;
        assert.equal(escalation.dueAt, new Date(dueAt).toISOString());
        assert.ok(EPOCH * 1_000 >= dueAt,
          `seed=${seed}: ${row.id} escalated before first_seen_at + threshold`);
        const projected = plan.openAfter.find((entry) => entry.id === row.id)!;
        assert.equal(projected.recovery, row.recovery, `seed=${seed}: ES1 forbids moving recovery`);
        assert.equal(projected.owner, 'USER');
        assert.ok(projected.escalatedAt, `seed=${seed}: the projection did not record the escalation`);
      }

      // The other direction: every row that was due and unescalated must be in the list.
      const due = plan.openAfter.filter((row) => row.id
        && open.find((stored) => stored.id === row.id)?.escalatedAt == null
        && EPOCH * 1_000 >= Date.parse(row.firstSeenAt) + PROJECT_BLOCKER_POLICY[row.kind].escalateMs);
      assert.deepEqual(plan.escalations.map((one) => one.blockerId).sort(),
        due.map((row) => row.id).sort(),
        `seed=${seed}: ES4's trigger is not exactly first_seen_at + threshold`);

      // BL7: a row this pass is OPENING can never also be escalated by it.
      const raisedKeys = new Set(plan.raises.map((raise) => raise.dedupeKey));
      for (const escalation of plan.escalations) {
        assert.ok(!raisedKeys.has(escalation.dedupeKey),
          `seed=${seed}: ${escalation.dedupeKey} was raised and escalated in the same pass`);
      }
    }
  });

  await t.test('BL7: occurrences and last_seen_at reach no decision', () => {
    for (const seed of SEEDS) {
      const observed = conditions(seed, 10);
      const open = openRows(seed, observed);
      const baseline = planProjectBlockers({ epoch: EPOCH, open, observed });
      const loud = open.map((row) => ({
        ...row,
        occurrences: row.occurrences + 1_000,
        lastSeenAt: new Date(EPOCH * 1_000 - 1).toISOString(),
      }));
      const plan = planProjectBlockers({ epoch: EPOCH, open: loud, observed });
      assert.deepEqual(plan, baseline,
        `seed=${seed}: a display counter changed the plan (ES5 / BL7)`);
    }
  });

  await t.test('I4a/I4b: a USER blocker decides the state without silencing the others', () => {
    const owners = ['USER', 'COORDINATOR', 'SYSTEM'] as const;
    assert.equal(blockerRunState([]), null);
    for (const a of owners) {
      for (const b of owners) {
        const state = blockerRunState([{ owner: a }, { owner: b }]);
        assert.equal(state, a === 'USER' || b === 'USER' ? 'AWAITING_HUMAN' : 'BLOCKED');
      }
    }
  });

  await t.test('BL5: next_check_at follows recovery, and a TIME row keeps its committed instant', () => {
    for (const kind of PROJECT_BLOCKER_KINDS) {
      const policy = PROJECT_BLOCKER_POLICY[kind];
      const subjectType: ProjectBlockerSubjectType = 'TASK';
      const recoveryAt = new Date((EPOCH + 7_200) * 1_000).toISOString();
      const [raise] = planProjectBlockers({
        epoch: EPOCH,
        open: [],
        observed: [{
          kind: kind as ProjectBlockerKind,
          subjectType,
          subjectId: 't1',
          facts: {},
          detail: {},
          ...(policy.recovery === 'TIME' ? { recoveryAt } : {}),
        }],
      }).raises;
      const expected = policy.recovery === 'TIME'
        ? recoveryAt
        : policy.recovery === 'EVENT'
          ? new Date(EPOCH * 1_000 + policy.pollMs!).toISOString()
          : new Date(EPOCH * 1_000 + policy.escalateMs).toISOString();
      assert.equal(raise.nextCheckAt, expected, `${kind}: next_check_at does not follow recovery`);
      assert.equal(raise.firstSeenAt, new Date(EPOCH * 1_000).toISOString(),
        `${kind}: the row was stamped with a clock other than the frozen epoch`);
      assert.equal(raise.owner, policy.owner);
      assert.equal(raise.recovery, policy.recovery);
    }
  });
});
