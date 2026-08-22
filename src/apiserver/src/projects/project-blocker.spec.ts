import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { wireRefusalCode } from './project-task-dispatcher.service';
import { bare, column, section, tables } from './contract-doc';
import {
  ObservedBlockerCondition,
  PROJECT_BLOCKER_KINDS,
  PROJECT_BLOCKER_NON_BLOCKING_REFUSALS,
  PROJECT_BLOCKER_POLICY,
  PROJECT_BLOCKER_REFUSAL_KINDS,
  PROJECT_BLOCKER_TURN_KINDS,
  ProjectBlockerFact,
  ProjectBlockerKind,
  blockerKindForRefusal,
  blockerRunState,
  clearBlockerIdempotencyKey,
  planProjectBlockers,
  projectBlockerConditionVersion,
  projectBlockerDedupeKey,
  projectDeadLetterCondition,
  raiseBlockerIdempotencyKey,
} from './project-blocker';

const REPO = path.resolve(__dirname, '../../../..');
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const MIGRATIONS = path.join(REPO, 'src/apiserver/prisma/migrations');
const MIGRATION = readFileSync(
  path.join(MIGRATIONS, '0125_project_blocker/migration.sql'),
  'utf8',
);
/**
 * The kind CHECK as it stands after every migration, not as 0125 first wrote it.
 *
 * A closed set that can only ever be read from the migration that CREATED it is a set that can
 * never grow: adding a kind means a later migration drops and re-adds the constraint (an applied
 * migration may not be edited), and a test pinned to the first one would then be asserting a
 * historical fact about a database nobody runs. Directory order is deployment order, so the last
 * file that declares the constraint is the one in force.
 */
function kindCheckInForce(): string[] {
  const declared = readdirSync(MIGRATIONS)
    .filter((entry) => /^\d{4}_/.test(entry))
    .sort()
    .map((entry) => path.join(MIGRATIONS, entry, 'migration.sql'))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .map((sql) => /project_blocker_kind_chk[\s\S]*?CHECK \("kind" IN \(([\s\S]*?)\)\)/.exec(sql))
    .filter((match): match is RegExpExecArray => match !== null);
  assert.ok(declared.length > 0, 'no migration declares the project_blocker kind CHECK');
  return [...declared.at(-1)![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}
// Read from the repo, not from `__dirname`: these specs run compiled, out of `build/`.
const SRC = path.join(REPO, 'src/apiserver/src/projects');
const AUTHORIZATION = readFileSync(path.join(SRC, 'project-authorization.service.ts'), 'utf8');
const DISPATCHER = readFileSync(path.join(SRC, 'project-task-dispatcher.service.ts'), 'utf8');

const EPOCH = Math.floor(Date.parse('2026-08-20T00:00:00.000Z') / 1_000);
const PROJECT = 'PPPPPPPPPPPPPPPPPPPPPP';
const TASK = 'TTTTTTTTTTTTTTTTTTTTTT';
const MINUTE = 60_000;

// ── §11.2's table is the source, and it lives in the document ────────────────────────────────
// The point of reading the markdown rather than restating it: a kind whose owner is edited in one
// place and not the other is exactly the drift `PC-CX-06` and `PC-CX-12` were, and neither of them
// produced a compile error.

/** §11.2's kind table, as the document states it. */
function contractKindTable(): string[][] {
  const md = section(PCC, '11.2');
  const table = tables(md).find((rows) => bare(rows[0][0]) === 'kind');
  assert.ok(table, '§11.2 no longer has a table headed `kind`');
  return table;
}

/**
 * The rows §11.2 says are LANDED — the ones whose `落地` column reads `已落地`.
 *
 * BL8 (v1.16) is why this is not simply every row. PAC §12 can mint a dispatch refusal, and PAC
 * §7.4 AU-F says it has to become a blocker kind; the contract records that immediately, while the
 * CHECK constraint and this module's policy table move with the migration step §12.1 declares for
 * it. Without the column there were only two possible rules and both are wrong: "equal to the
 * implementation" refuses to let a new refusal into the contract at all, and "unconstrained" stops
 * seeing drift. So the column carries the distinction, and PAC's own self-check (`00.14`) is what
 * stops it being used to park a kind in the contract forever: an unlanded kind must be named by
 * exactly one declared migration step, and a landed one by none.
 */
function landedKinds(): string[] {
  const rows = contractKindTable();
  const kinds = column(rows, 'kind').map(bare);
  const landed = column(rows, '落地').map(bare);
  return kinds.filter((_, i) => landed[i] === '已落地');
}

test('§11.2: the implemented kind set IS the document\'s, in the document\'s order', () => {
  assert.deepEqual([...PROJECT_BLOCKER_KINDS], landedKinds());
  // …and the rest of the table is not free-floating: every unlanded kind is one PAC §12 refuses a
  // dispatch with, so BL8's first direction still holds over the WHOLE table.
  const rows = contractKindTable();
  const kinds = column(rows, 'kind').map(bare);
  const pending = kinds.filter((k) => !landedKinds().includes(k));
  const sources = column(rows, '来源').map(bare);
  for (const kind of pending) {
    assert.equal(sources[kinds.indexOf(kind)], 'PAC §12',
      `§11.2 leaves \`${kind}\` unlanded without it being a PAC refusal code — nothing would ever land it`);
  }
});

test('§11.2: the migration CHECK freezes exactly the same closed set', () => {
  assert.deepEqual(kindCheckInForce().sort(), [...PROJECT_BLOCKER_KINDS].sort());
  // …and 0125 is still where it started, so a rewrite of history would be visible here too.
  assert.match(MIGRATION, /project_blocker_kind_chk/);
});

test('§11.2: every kind carries the document\'s owner and recovery', () => {
  const rows = contractKindTable();
  const kinds = column(rows, 'kind').map(bare);
  const owners = column(rows, '默认 owner').map(bare);
  const recoveries = column(rows, 'recovery').map(bare);
  for (const [at, kind] of kinds.entries()) {
    if (!landedKinds().includes(kind)) continue;
    const policy = PROJECT_BLOCKER_POLICY[kind as ProjectBlockerKind];
    assert.equal(policy.owner, owners[at], `${kind} owner`);
    assert.equal(policy.recovery, recoveries[at], `${kind} recovery`);
  }
});

test('BL4: opensTurn is true for exactly the kinds whose default owner is COORDINATOR', () => {
  const rows = contractKindTable();
  const kinds = column(rows, 'kind').map(bare);
  const opens = column(rows, 'opensTurn').map(bare);
  for (const [at, kind] of kinds.entries()) {
    if (!landedKinds().includes(kind)) continue;
    const policy = PROJECT_BLOCKER_POLICY[kind as ProjectBlockerKind];
    assert.equal(policy.opensTurn, opens[at] === '✔', `${kind} opensTurn`);
    // Both directions, which is the whole of BL4: v1 hung "wake the coordinator" on `owner`, then
    // assigned `owner` by another rule elsewhere, and TEST_FAILED got two contradictory answers.
    assert.equal(policy.opensTurn, policy.owner === 'COORDINATOR', `${kind} BL4 iff`);
  }
});

test('§7.2 BLOCKER_DECISION reads exactly the opensTurn kinds', () => {
  const row = tables(section(PCC, '7.2'))
    .flat()
    .find((cells) => cells.some((cell) => cell.includes('BLOCKER_DECISION')));
  assert.ok(row, '§7.2 no longer has a BLOCKER_DECISION row');
  // The document writes the four as one backticked SET, so read every SCREAMING token in the row
  // and keep the ones that name a kind.
  const listed = [...row.join(' ').matchAll(/[A-Z][A-Z_]{3,}/g)]
    .map((m) => m[0])
    .filter((name) => (PROJECT_BLOCKER_KINDS as readonly string[]).includes(name));
  assert.deepEqual([...new Set(listed)].sort(), [...PROJECT_BLOCKER_TURN_KINDS].sort());
});

test('BL5: next_check_at means the right thing for each recovery axis', () => {
  for (const kind of PROJECT_BLOCKER_KINDS) {
    const policy = PROJECT_BLOCKER_POLICY[kind];
    const raise = onlyRaise(plan([], [condition(kind)]));
    if (policy.recovery === 'EVENT') {
      // A recompute poll, measured from the frozen epoch.
      assert.equal(raise.nextCheckAt, iso(EPOCH * 1_000 + policy.pollMs!), `${kind} poll`);
    } else if (policy.recovery === 'HUMAN') {
      // The escalation alarm, and NOT a recovery poll: once it fires this row stops ticking.
      assert.equal(raise.nextCheckAt, iso(EPOCH * 1_000 + policy.escalateMs), `${kind} alarm`);
      assert.equal(policy.pollMs, null, `${kind} must not also carry a poll`);
    } else {
      const at = iso(EPOCH * 1_000 + 3 * 60 * MINUTE);
      const timed = onlyRaise(plan([], [{ ...condition(kind), recoveryAt: at }]));
      assert.equal(timed.nextCheckAt, at, `${kind} recovery instant`);
    }
  }
});

test('§11.1: a raise answers all five questions and carries every audited column', () => {
  for (const kind of PROJECT_BLOCKER_KINDS) {
    const raise = onlyRaise(plan([], [{ ...condition(kind), recoveryAt: iso(EPOCH * 1_000 + MINUTE) }]));
    const policy = PROJECT_BLOCKER_POLICY[kind];
    assert.equal(raise.kind, kind);
    assert.equal(raise.owner, policy.owner);
    assert.equal(raise.recovery, policy.recovery);
    assert.equal(raise.severity, policy.severity);
    assert.equal(raise.requiredAction, policy.requiredAction);
    assert.ok(raise.requiredAction.endsWith('.'), `${kind} required action must be a sentence`);
    assert.equal(raise.subjectType, 'TASK');
    assert.equal(raise.subjectId, TASK);
    assert.equal(raise.dedupeKey, `${kind}:TASK:${TASK}`);
    assert.match(raise.conditionVersion, /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(raise.nextCheckAt) > EPOCH * 1_000, `${kind} must have a next check`);
    assert.deepEqual(raise.detail, { note: kind });
  }
});

// ── §11.3 dedupe, and BL7's exclusion set ───────────────────────────────────────────────────

test('§11.3: the default dedupe key is <kind>:<subjectType>:<subjectId>', () => {
  assert.equal(projectBlockerDedupeKey('MERGE_CONFLICT', 'TASK', TASK), `MERGE_CONFLICT:TASK:${TASK}`);
  assert.equal(raiseBlockerIdempotencyKey('p', 'TEST_FAILED', 't', 7n), 'pc:v1:p:blocker:TEST_FAILED:t:7');
  assert.equal(clearBlockerIdempotencyKey('p', 'b'), 'pc:v1:p:unblock:b');
});

test('§11.3: a repeat cause touches the open row instead of opening a second one', () => {
  const open = fact('MERGE_CONFLICT', { occurrences: 41 });
  const result = plan([open], [condition('MERGE_CONFLICT')]);
  assert.deepEqual(result.raises, []);
  assert.deepEqual(result.clears, []);
  assert.equal(result.touches.length, 1);
  assert.equal(result.touches[0].blockerId, open.id);
  assert.equal(result.openAfter.length, 1);
  assert.equal(result.openAfter[0].lifecycleGeneration, open.lifecycleGeneration);
});

test('TF2: the digest follows the FACTS, not how often they were seen', () => {
  const facts = { targetBranch: 'main', paths: ['a.ts'] };
  const same = projectBlockerConditionVersion('MERGE_CONFLICT', 'TASK', TASK, facts);
  assert.equal(projectBlockerConditionVersion('MERGE_CONFLICT', 'TASK', TASK, { ...facts }), same);
  // Key order must not matter; a changed fact must.
  assert.equal(
    projectBlockerConditionVersion('MERGE_CONFLICT', 'TASK', TASK, { paths: ['a.ts'], targetBranch: 'main' }),
    same,
  );
  assert.notEqual(
    projectBlockerConditionVersion('MERGE_CONFLICT', 'TASK', TASK, { ...facts, paths: ['a.ts', 'b.ts'] }),
    same,
  );
});

test('§11.3: a changed condition on an open row overwrites the digest without reopening it', () => {
  const open = fact('MERGE_CONFLICT', { conditionVersion: 'f'.repeat(64) });
  const result = plan([open], [{ ...condition('MERGE_CONFLICT'), facts: { paths: ['b.ts'] } }]);
  assert.deepEqual(result.raises, []);
  assert.notEqual(result.touches[0].conditionVersion, open.conditionVersion);
  assert.equal(
    result.touches[0].conditionVersion,
    projectBlockerConditionVersion('MERGE_CONFLICT', 'TASK', TASK, { paths: ['b.ts'] }),
  );
});

test('ES5: N deliveries, reordered and across a restart, are byte-identical to N = 1', () => {
  const one = plan([], [condition('MERGE_CONFLICT'), condition('TEST_FAILED')]);
  // The same world delivered ten times, in the other order, is the same world.
  const ten = plan([], [
    ...Array.from({ length: 5 }, () => condition('TEST_FAILED')),
    ...Array.from({ length: 5 }, () => condition('MERGE_CONFLICT')),
  ]);
  assert.equal(JSON.stringify(ten), JSON.stringify(one));

  // And once the rows exist, redelivery moves nothing this plan decides. `occurrences` and
  // `lastSeenAt` are the only things allowed to differ and they are written by the database, so at
  // this layer the plan is a touch with the SAME digest and no escalation.
  const open = [fact('MERGE_CONFLICT', { occurrences: 1 }), fact('TEST_FAILED', { occurrences: 97 })];
  const after = plan(open, [condition('TEST_FAILED'), condition('MERGE_CONFLICT')]);
  assert.deepEqual(after.raises, []);
  assert.deepEqual(after.clears, []);
  assert.deepEqual(after.escalations, []);
  assert.deepEqual(
    after.openAfter.map((row) => [row.kind, row.owner, row.recovery, row.escalatedAt, row.lifecycleGeneration]),
    [['MERGE_CONFLICT', 'COORDINATOR', 'EVENT', null, '3'], ['TEST_FAILED', 'USER', 'HUMAN', null, '3']],
  );
});

test('BL7: occurrences enters no key, no digest and no escalation', () => {
  const quiet = fact('TEST_FAILED', { occurrences: 1 });
  const loud = fact('TEST_FAILED', { occurrences: 10_000 });
  const a = plan([quiet], [condition('TEST_FAILED')]);
  const b = plan([loud], [condition('TEST_FAILED')]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // And it cannot buy an escalation the clock has not earned.
  assert.deepEqual(plan([loud], [condition('TEST_FAILED')]).escalations, []);
});

// ── §11.4 auto-clear ────────────────────────────────────────────────────────────────────────

test('§11.4 BL3: a condition the recomputation no longer sees is cleared as AUTO', () => {
  const open = fact('PROVIDER_UNAVAILABLE');
  const result = plan([open], []);
  assert.deepEqual(result.raises, []);
  assert.deepEqual(result.touches, []);
  assert.deepEqual(result.clears, [{
    blockerId: open.id,
    dedupeKey: open.dedupeKey,
    kind: 'PROVIDER_UNAVAILABLE',
    lifecycleGeneration: open.lifecycleGeneration,
  }]);
  assert.deepEqual(result.openAfter, []);
});

test('§11.4: clearing one condition leaves the others open', () => {
  const gone = fact('PROVIDER_UNAVAILABLE');
  const stays = fact('TEST_FAILED');
  const result = plan([gone, stays], [condition('TEST_FAILED')]);
  assert.deepEqual(result.clears.map((clear) => clear.kind), ['PROVIDER_UNAVAILABLE']);
  assert.deepEqual(result.openAfter.map((row) => row.kind), ['TEST_FAILED']);
});

test('BE1: a cleared condition that comes back is a RAISE, not a reopen', () => {
  // The row is resolved, so it is not in the open set any more; the same cause is a fresh raise and
  // the database allocates it `MAX + 1`. Reopening the old row in place would hand a new failure the
  // old episode's identity, which is what §7.6 TR3 then misreads as "no progress".
  const result = plan([], [condition('MERGE_CONFLICT')]);
  assert.equal(result.raises.length, 1);
  assert.equal(result.raises[0].dedupeKey, `MERGE_CONFLICT:TASK:${TASK}`);
});

// ── §11.5 escalation ────────────────────────────────────────────────────────────────────────

test('ES4/ES3/ES1: escalation is driven only by age, goes to USER, and leaves recovery alone', () => {
  const budget = fact('BUDGET_EXHAUSTED', {
    firstSeenAt: iso(EPOCH * 1_000 - PROJECT_BLOCKER_POLICY.BUDGET_EXHAUSTED.escalateMs),
    subjectType: 'PROJECT',
    subjectId: PROJECT,
  });
  const result = plan([budget], [{ ...condition('BUDGET_EXHAUSTED'), subjectType: 'PROJECT', subjectId: PROJECT }]);
  assert.equal(result.escalations.length, 1);
  assert.equal(result.escalations[0].owner, 'USER');
  assert.equal(result.escalations[0].blockerId, budget.id);
  const after = result.openAfter[0];
  assert.equal(after.owner, 'USER');
  // ES1: still TIME, so it still clears itself when the window rolls. Escalation says "somebody
  // should look at this", not "from now on only a person can end it".
  assert.equal(after.recovery, 'TIME');
  assert.equal(after.escalatedAt, iso(EPOCH * 1_000));
});

test('ES4: one second before the threshold, nothing escalates', () => {
  const open = fact('TEST_FAILED', {
    firstSeenAt: iso(EPOCH * 1_000 - PROJECT_BLOCKER_POLICY.TEST_FAILED.escalateMs + 1_000),
  });
  assert.deepEqual(plan([open], [condition('TEST_FAILED')]).escalations, []);
});

test('ES3/§11.5: a blocker escalates at most once in its lifecycle', () => {
  const open = fact('TEST_FAILED', {
    firstSeenAt: iso(EPOCH * 1_000 - 10 * 60 * MINUTE),
    escalatedAt: iso(EPOCH * 1_000 - 5 * 60 * MINUTE),
    owner: 'USER',
  });
  assert.deepEqual(plan([open], [condition('TEST_FAILED')]).escalations, []);
});

test('a raise cannot also escalate in the pass that opened it', () => {
  for (const kind of PROJECT_BLOCKER_KINDS) {
    assert.deepEqual(plan([], [condition(kind)]).escalations, [], kind);
  }
});

// ── §4.2 guards 2 and 3 ─────────────────────────────────────────────────────────────────────

test('I4a/I4b: a USER blocker wins, and it masks without silencing', () => {
  assert.equal(blockerRunState([]), null);
  assert.equal(blockerRunState([{ owner: 'SYSTEM' }]), 'BLOCKED');
  assert.equal(blockerRunState([{ owner: 'COORDINATOR' }]), 'BLOCKED');
  assert.equal(blockerRunState([{ owner: 'USER' }]), 'AWAITING_HUMAN');
  assert.equal(blockerRunState([{ owner: 'SYSTEM' }, { owner: 'USER' }]), 'AWAITING_HUMAN');
  // Order must not decide it — that was `PC-CX-03`.
  assert.equal(blockerRunState([{ owner: 'USER' }, { owner: 'SYSTEM' }]), 'AWAITING_HUMAN');
});

test('N-mask: a masked SYSTEM blocker is still recomputed and still carries its own clock', () => {
  const masked = fact('PROVIDER_UNAVAILABLE');
  const masking = fact('TEST_FAILED');
  const result = plan([masked, masking], [condition('PROVIDER_UNAVAILABLE'), condition('TEST_FAILED')]);
  const provider = result.openAfter.find((row) => row.kind === 'PROVIDER_UNAVAILABLE');
  assert.ok(provider, 'the masked row stays open');
  assert.equal(provider.recovery, 'EVENT');
  assert.equal(provider.nextCheckAt, iso(EPOCH * 1_000 + PROJECT_BLOCKER_POLICY.PROVIDER_UNAVAILABLE.pollMs!));
});

// ── BL2 fail closed ─────────────────────────────────────────────────────────────────────────

// ── §5.4 F22: the dead letter both writers have to name identically ─────────────────────────────

const DEAD_A = { eventId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'task.updated', dedupeKey: 'task.updated:1', attempts: 10 };
const DEAD_B = { eventId: 'BBBBBBBBBBBBBBBBBBBBBB', kind: 'session.ended', dedupeKey: 'session.ended:1', attempts: 10 };

test('F22: a dead letter is a PROJECT-subject UNKNOWN_FAILURE, so it stops the whole project', () => {
  const condition = projectDeadLetterCondition(PROJECT, [DEAD_A]);
  assert.equal(condition.kind, 'UNKNOWN_FAILURE');
  assert.equal(condition.subjectType, 'PROJECT');
  assert.equal(condition.subjectId, PROJECT);
  // The dedupe key is the whole point: the delivery path opens the row and §11.4's recomputation
  // keeps it open, and they only meet on this string.
  assert.equal(
    projectBlockerDedupeKey(condition.kind, condition.subjectType, condition.subjectId),
    `UNKNOWN_FAILURE:PROJECT:${PROJECT}`,
  );
  // §11.2's row, reached through the policy table rather than restated: whoever writes it gets a
  // person as the owner, a person as the only recovery, and an escalation alarm for a clock.
  const [raise] = planProjectBlockers({ epoch: EPOCH, open: [], observed: [condition] }).raises;
  assert.equal(raise.owner, 'USER');
  assert.equal(raise.recovery, 'HUMAN');
  assert.equal(raise.severity, 'CRITICAL');
  assert.ok(raise.requiredAction.length > 0);
  assert.equal(Date.parse(raise.nextCheckAt), EPOCH * 1_000 + 30 * MINUTE);
});

test('F22: the same losses in any order are one condition, and a new loss is a changed one', () => {
  // Redelivery reorders batches, and two instances can dead-letter the same events from different
  // sides of a restart. TF2 has to see one condition through all of it, so the digest is taken over
  // a SET of event identities — never over the order they arrived in or how many attempts each took.
  const forwards = projectDeadLetterCondition(PROJECT, [DEAD_A, DEAD_B]);
  const backwards = projectDeadLetterCondition(PROJECT, [DEAD_B, DEAD_A]);
  const version = (condition: ObservedBlockerCondition) => projectBlockerConditionVersion(
    condition.kind, condition.subjectType, condition.subjectId, condition.facts,
  );
  assert.equal(version(forwards), version(backwards));
  assert.deepEqual(forwards.detail, backwards.detail, 'the display payload is order-free too');
  assert.notEqual(version(forwards), version(projectDeadLetterCondition(PROJECT, [DEAD_A])),
    'a signal lost that was not lost before is a changed condition, not the same one');
  assert.equal(
    version(projectDeadLetterCondition(PROJECT, [{ ...DEAD_A, attempts: 40 }])),
    version(projectDeadLetterCondition(PROJECT, [DEAD_A])),
    'BL7: how hard delivery tried is a delivery observation, not the condition',
  );
});

test('F22: a second dead letter touches the open episode instead of opening a second one', () => {
  const first = planProjectBlockers({
    epoch: EPOCH, open: [], observed: [projectDeadLetterCondition(PROJECT, [DEAD_A])],
  });
  const [raise] = first.raises;
  const open: ProjectBlockerFact[] = [{
    id: 'BLOCKERBLOCKERBLOCKER1',
    kind: raise.kind,
    owner: raise.owner,
    recovery: raise.recovery,
    severity: raise.severity,
    requiredAction: raise.requiredAction,
    subjectType: raise.subjectType,
    subjectId: raise.subjectId,
    dedupeKey: raise.dedupeKey,
    lifecycleGeneration: '1',
    conditionVersion: raise.conditionVersion,
    firstSeenAt: raise.firstSeenAt,
    lastSeenAt: raise.firstSeenAt,
    occurrences: 1,
    nextCheckAt: raise.nextCheckAt,
    escalatedAt: null,
  }];
  const second = planProjectBlockers({
    epoch: EPOCH + 60, open, observed: [projectDeadLetterCondition(PROJECT, [DEAD_A, DEAD_B])],
  });
  assert.deepEqual(second.raises, [], 'the episode is already open');
  assert.deepEqual(second.clears, [], 'and the losses have not gone away');
  assert.equal(second.touches.length, 1);
  assert.equal(second.touches[0].blockerId, 'BLOCKERBLOCKERBLOCKER1');
  assert.notEqual(second.touches[0].conditionVersion, raise.conditionVersion,
    'the digest follows the set of lost signals, which grew');
  assert.equal(second.openAfter[0].firstSeenAt, raise.firstSeenAt,
    'ES5: the age the escalation is measured from does not restart');
  assert.equal(second.openAfter[0].nextCheckAt, raise.nextCheckAt,
    'BL5: a HUMAN row\'s clock is its escalation alarm, so it does not move with redelivery');
});

test('F22: nothing but a person clears it — the recomputation on its own never does', () => {
  // §11.4 clears whatever it no longer observes, which is exactly how every other kind recovers.
  // This one has no world left to look at — the event is gone and its effect never happened — so
  // the condition holds until the snapshot stops carrying it, and only an acknowledgement can do
  // that. Asserted in both directions so "it never clears" cannot be true by accident.
  const condition = projectDeadLetterCondition(PROJECT, [DEAD_A]);
  const [raise] = planProjectBlockers({ epoch: EPOCH, open: [], observed: [condition] }).raises;
  const open: ProjectBlockerFact[] = [{
    id: 'BLOCKERBLOCKERBLOCKER2',
    kind: raise.kind, owner: raise.owner, recovery: raise.recovery, severity: raise.severity,
    requiredAction: raise.requiredAction, subjectType: raise.subjectType,
    subjectId: raise.subjectId, dedupeKey: raise.dedupeKey, lifecycleGeneration: '1',
    conditionVersion: raise.conditionVersion, firstSeenAt: raise.firstSeenAt,
    lastSeenAt: raise.firstSeenAt, occurrences: 1, nextCheckAt: raise.nextCheckAt,
    escalatedAt: null,
  }];
  assert.deepEqual(
    planProjectBlockers({ epoch: EPOCH + 3_600, open, observed: [condition] }).clears, [],
    'an hour of healthy passes does not resolve a signal that is still lost',
  );
  assert.deepEqual(
    planProjectBlockers({ epoch: EPOCH + 3_600, open, observed: [] }).clears.map((c) => c.blockerId),
    ['BLOCKERBLOCKERBLOCKER2'],
    'and once the snapshot stops carrying it — somebody acknowledged it — it clears like anything else',
  );
});

test('BL2: an unclassified refusal becomes UNKNOWN_FAILURE, never nothing', () => {
  assert.equal(blockerKindForRefusal('SOMETHING_NOBODY_CLASSIFIED'), 'UNKNOWN_FAILURE');
  assert.equal(blockerKindForRefusal(null), 'UNKNOWN_FAILURE');
  assert.equal(blockerKindForRefusal(undefined), 'UNKNOWN_FAILURE');
  assert.equal(blockerKindForRefusal(''), 'UNKNOWN_FAILURE');
  assert.equal(blockerKindForRefusal('WHO_UNRESOLVED'), 'WHO_UNRESOLVED');
  assert.equal(blockerKindForRefusal('RUNNER_UNAVAILABLE'), 'NO_MATCHING_RUNNER');
  assert.equal(blockerKindForRefusal('RETRY_BACKOFF_ACTIVE'), null);
});

test('BL2: every refusal code the resolution chain can emit is classified exactly once', () => {
  // Only the reason-code union: the same file declares other string unions, and folding an action
  // TYPE into this list would ask the wrong question about it.
  const union = /export type ProjectAuthorizationReasonCode =([\s\S]*?);\n/.exec(AUTHORIZATION);
  assert.ok(union, 'the reason-code union no longer parses');
  const reasonCodes = [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(reasonCodes.length > 20, 'the reason-code union no longer parses');
  const refusalCodes = [...DISPATCHER.matchAll(/this\.refusal\(\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(refusalCodes.length > 3, 'the dispatcher refusal codes no longer parse');
  const unclassified = [...new Set([...reasonCodes, ...refusalCodes])].filter((code) =>
    !(code in PROJECT_BLOCKER_REFUSAL_KINDS) && !PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code));
  assert.deepEqual(unclassified, [],
    'a refusal code in neither list falls through to UNKNOWN_FAILURE at runtime — decide which it is');
  const both = [...new Set([...reasonCodes, ...refusalCodes])].filter((code) =>
    code in PROJECT_BLOCKER_REFUSAL_KINDS && PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code));
  assert.deepEqual(both, [], 'classified as both a blocker and not one');
});

test('the guard\'s own refusal is transparent, so a blocker cannot breed a second one', () => {
  assert.ok(PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('PROJECT_BLOCKED'));
  assert.equal(blockerKindForRefusal('PROJECT_BLOCKED'), null);
  assert.match(DISPATCHER, /this\.refusal\('PROJECT_BLOCKED'/,
    'the dispatcher must stop a blocked task with the code this list exempts');
});

// ── determinism ─────────────────────────────────────────────────────────────────────────────

test('the plan is sorted, so the same world always produces the same audit bytes', () => {
  const kinds: ProjectBlockerKind[] = ['TEST_FAILED', 'MERGE_CONFLICT', 'WHO_UNRESOLVED'];
  const forward = plan([], kinds.map((kind) => condition(kind)));
  const backward = plan([], [...kinds].reverse().map((kind) => condition(kind)));
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.deepEqual(forward.raises.map((raise) => raise.kind),
    ['MERGE_CONFLICT', 'TEST_FAILED', 'WHO_UNRESOLVED']);
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

function plan(
  open: ProjectBlockerFact[],
  observed: ObservedBlockerCondition[],
) {
  return planProjectBlockers({ epoch: EPOCH, open, observed });
}

function onlyRaise(result: ReturnType<typeof plan>) {
  assert.equal(result.raises.length, 1, 'expected exactly one raise');
  return result.raises[0];
}

function condition(kind: ProjectBlockerKind): ObservedBlockerCondition {
  return {
    kind,
    subjectType: 'TASK',
    subjectId: TASK,
    facts: { kind },
    detail: { note: kind },
  };
}

function fact(kind: ProjectBlockerKind, overrides: Partial<ProjectBlockerFact> = {}): ProjectBlockerFact {
  const policy = PROJECT_BLOCKER_POLICY[kind];
  const subjectType = overrides.subjectType ?? 'TASK';
  const subjectId = overrides.subjectId ?? TASK;
  return {
    id: `blocker-${kind}`,
    kind,
    owner: policy.owner,
    recovery: policy.recovery,
    severity: policy.severity,
    requiredAction: policy.requiredAction,
    subjectType,
    subjectId,
    dedupeKey: projectBlockerDedupeKey(kind, subjectType, subjectId),
    lifecycleGeneration: '3',
    conditionVersion: projectBlockerConditionVersion(kind, subjectType, subjectId, { kind }),
    firstSeenAt: iso(EPOCH * 1_000 - MINUTE),
    lastSeenAt: iso(EPOCH * 1_000 - MINUTE),
    occurrences: 1,
    nextCheckAt: iso(EPOCH * 1_000 + MINUTE),
    escalatedAt: null,
    ...overrides,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test('§13.1 AG6: the refusal is non-blocking, and its wire code is one old readers know', () => {
  // If this code ever became a blocker it would be a PROJECT-subject `UNKNOWN_FAILURE`, §11 BL1
  // would read that as "stop everything", and §11.4 could never clear it — the attempt it needs to
  // let through will always be refused for the same reason.
  assert.equal(blockerKindForRefusal('TASK_AGGREGATE_PARENT'), null);
  assert.ok(PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('TASK_AGGREGATE_PARENT'));

  // ...and the durable column carries a code a replica that predates this release also classifies
  // as non-blocking, because adding it to THIS build's list does nothing for the one beside it.
  assert.equal(wireRefusalCode('TASK_AGGREGATE_PARENT'), 'STALE_SNAPSHOT');
  assert.equal(blockerKindForRefusal(wireRefusalCode('TASK_AGGREGATE_PARENT')), null);
  // Every other code is passed through untouched.
  assert.equal(wireRefusalCode('RUNNER_UNAVAILABLE'), 'RUNNER_UNAVAILABLE');
});

// ---------------------------------------------------------------------------------------------
// The mixed-version half of adding a kind, which only the OLDER replica can get wrong.
// ---------------------------------------------------------------------------------------------

test('a kind this build has never heard of is left alone, not auto-cleared', () => {
  // BL3's auto-clear is "the recomputation no longer holds this condition". A kind this binary has
  // no detector for is one it did not RECOMPUTE, so its silence is ignorance rather than absence —
  // and clearing on ignorance is how a rolling deploy deletes a row a person is being asked to act
  // on, only for the newer replica to raise it again a generation later.
  //
  // This is exactly the shape migration 0135 creates: it teaches the database two kinds that only
  // the new code writes, so during the deploy an old reconciler sees them open and unexplained.
  // A kind THIS build has no detector for. `AGGREGATE_PARENT_UNSATISFIABLE` would not do: 0135
  // ships its detector alongside it, so this binary recomputes it and clearing it is correct. The
  // case that matters is the one an OLDER replica is in, which is a name it has never seen.
  const fromTheFuture = {
    ...fact('PROVIDER_UNAVAILABLE'),
    id: 'blocker-from-a-newer-replica',
    kind: 'A_KIND_FROM_A_LATER_RELEASE' as never,
    dedupeKey: 'a-kind-from-a-later-release:TASK:' + TASK,
  };

  const plan = planProjectBlockers({ epoch: EPOCH, open: [fromTheFuture], observed: [] });

  assert.deepEqual(plan.clears, [], 'an unrecognised kind must not be resolved as AUTO');
  // ...and it still STOPS what it says it stops: §4.2 and §11 BL1 read `openAfter`, so a row this
  // build cannot evaluate has to stay in it or the guards downstream silently stop honouring it.
  assert.deepEqual(
    plan.openAfter.map((b) => b.kind),
    ['A_KIND_FROM_A_LATER_RELEASE'],
    'the row a build cannot judge must still count as open',
  );
});

test('a kind this build DOES know is still auto-cleared when nothing observes it', () => {
  // The other half, so the rule above cannot be satisfied by never clearing anything.
  const known = fact('PROVIDER_UNAVAILABLE');
  const plan = planProjectBlockers({ epoch: EPOCH, open: [known], observed: [] });
  assert.deepEqual(plan.clears.map((c) => c.blockerId), [known.id]);
  assert.deepEqual(plan.openAfter, []);
});
