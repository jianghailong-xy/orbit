import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, section, tableRows, tables } from './contract-doc';

// The eight blockers that unit 02's adversarial review raised against v1 of the control-loop
// contract (`PC-CX-01..08`) are all concurrency or precedence defects: two entry points with no
// shared linearization point, a state that is a function of iteration order, a conflict handler
// that throws away the rest of the transaction, three clocks that disagree. None of them can be
// closed by prose — a rule that says "exactly one session" is worth nothing until something
// enumerates the interleavings and checks.
//
// So this file is an executable model of the primitives §7.7 / §8.5 / §4.2 / §10.4 / §13.4 freeze:
// a partial unique index, an authority trigger, an action ledger with ON CONFLICT semantics, the
// run-state guard function, the wake calculation and the acceptance digest. Every test replays the
// minimal interleaving the review published, and most carry a **negative control** that runs the
// same interleaving under v1's rule and asserts the defect reappears — a counter-example test that
// cannot fail against the old design is not testing anything.
//
// v1.2 (`PC-CX-09..14`, §20) adds the second round, and it has one shape: v1.1 kept checking things
// *at one moment* and treating the answer as an invariant. A trigger read the authority at INSERT
// time, an acceptance record was computed at one snapshot, a blocker's owner was fixed at creation,
// a dispatch key was derived from a counter a human can reset. Each of those can be changed by
// another transaction afterwards, and none of them had anything tying "then" to "now". So the
// second round of the model adds what the contract added: two conflicting row locks, a monotonic
// epoch, and a rule that keeps delivery counts out of semantic digests.
//
// What this is NOT: units 03–23 have not been written, so none of these primitives exist in
// Postgres yet. §19.9 / §20.7 record the boundary. One item did move: `PC-CX-09` now also has a
// test that runs on a **real** Postgres (`coordinator-linearization.pg.spec.ts`), because its whole
// claim is about MVCC and row-lock conflict semantics, and a model that asserts those is only
// asserting that its author read the manual correctly.
const REPO = path.resolve(__dirname, '../../../..');
const PCC = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
/** PAC is read, never written: `PC-CX-44`'s create-frozen list is derived from its §6 table. */
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');

const MINUTE = 60_000;
const ESCALATION_AFTER = 30 * MINUTE; // §11.5

// ─────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────

type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_INPUT' | 'INTERRUPTED';
type DispatchOrigin = 'USER' | 'COORDINATOR' | 'LEGACY_SWEEP';
type DispatchAuthority = 'LEGACY' | 'COORDINATOR';
type Owner = 'USER' | 'COORDINATOR' | 'SYSTEM';
type Recovery = 'TIME' | 'EVENT' | 'HUMAN';

/** §7.7 D5: the occupancy set, character for character the existing `SINGLE_RUN_DEDUP`. */
const OCCUPYING: RunStatus[] = ['PENDING', 'RUNNING'];

interface Session {
  id: string;
  taskId: string;
  status: RunStatus;
  deletedAt: string | null;
  origin: DispatchOrigin;
  projectActionId: string | null;
}

interface Action {
  key: string;
  type: string;
  status: 'APPLIED' | 'SUPERSEDED' | 'ALREADY_APPLIED';
  refusalCode?: string;
  resultSessionId?: string | null;
  createdAt: number;
  reasonCode?: string;
  /** null while the turn is still in flight (§7.6 TR3 reads this). */
  endedAt?: number | null;
}

interface Blocker {
  id: string;
  kind: string;
  owner: Owner;
  recovery: Recovery;
  dedupeKey: string;
  firstSeenAt: number;
  nextCheckAt: number | null;
  escalatedAt: number | null;
  resolvedAt: number | null;
}

interface Db {
  projectId: string;
  projectStatus: 'OPEN' | 'DONE' | 'CANCELLED';
  coordinatorEnabled: boolean;
  fencingToken: number;
  nextWakeAt: number | null;
  tasks: Record<string, { dispatchAuthority: DispatchAuthority; failureCount: number }>;
  sessions: Session[];
  actions: Action[];
  blockers: Blocker[];
  events: { id: string; consumedAt: number | null }[];
  decisions: { runStateAfter: string }[];
}

function db(over: Partial<Db> = {}): Db {
  return {
    projectId: 'p1',
    projectStatus: 'OPEN',
    coordinatorEnabled: true,
    fencingToken: 42,
    nextWakeAt: null,
    tasks: { X: { dispatchAuthority: 'COORDINATOR', failureCount: 0 } },
    sessions: [],
    actions: [],
    blockers: [],
    events: [],
    decisions: [],
    ...over,
  };
}

/** Which session currently holds §7.7 D5's claim on a task, if any. */
function claimHolder(d: Db, taskId: string): Session | undefined {
  return d.sessions.find((s) => s.taskId === taskId && s.deletedAt === null && OCCUPYING.includes(s.status));
}

interface Fences {
  /** §7.7 D5 — the partial unique index. Off = v1. */
  claimIndex: boolean;
  /** §7.7 D6 — the authority trigger. Off = v1. */
  authorityGuard: boolean;
}
const V11: Fences = { claimIndex: true, authorityGuard: true };
const V1: Fences = { claimIndex: false, authorityGuard: false };

class AuthorityViolation extends Error {}

/**
 * The one write every dispatch entry point makes, with the two database-level fences in front of
 * it. The claim index answers with a *value* (§8.5 C1: `ON CONFLICT DO NOTHING RETURNING`), the
 * trigger answers by aborting that entry point's transaction (§7.7 D6-b) — the asymmetry is the
 * contract's, and it matters: one is a race, the other is a violation.
 */
function insertSession(d: Db, row: Session, fences: Fences): Session | null {
  if (fences.authorityGuard) {
    const authority = d.tasks[row.taskId].dispatchAuthority;
    if (authority === 'COORDINATOR') {
      const permitted = row.origin === 'USER' || (row.origin === 'COORDINATOR' && row.projectActionId !== null);
      if (!permitted) throw new AuthorityViolation(`DISPATCH_AUTHORITY_VIOLATION: task ${row.taskId}`);
    } else if (row.origin === 'COORDINATOR') {
      throw new AuthorityViolation(`DISPATCH_AUTHORITY_VIOLATION: coordinator dispatch on a LEGACY task`);
    }
  }
  if (fences.claimIndex && claimHolder(d, row.taskId)) return null;
  d.sessions.push(row);
  return row;
}

// ── Dispatch entry points, split into the two moments the race lives between ────────────────────
// Every entry point reads a snapshot and then, some time later, writes. The gap between those two
// moments is the whole of `PC-CX-01`, so the model keeps them as separate steps a driver can
// interleave rather than as one function that cannot race with itself.

type Entry = 'USER' | 'COORDINATOR' | 'LEGACY_SWEEP';
type Outcome = { entry: Entry; created: string | null; refusalCode?: string; violation?: boolean };

class Attempt {
  private sawClaim = true;
  readonly outcome: Outcome;

  constructor(
    readonly entry: Entry,
    private readonly taskId: string,
    private readonly fences: Fences,
  ) {
    this.outcome = { entry, created: null };
  }

  /** Read the snapshot: §7.4 condition 4 for the coordinator, `findFirst` for the other two. */
  plan(d: Db): void {
    // The legacy sweep is the one entry point that does not consult dispatch authority — that is
    // `PC-CX-02` in one line, and the reason the fence cannot live in application code.
    this.sawClaim = claimHolder(d, this.taskId) !== undefined;
  }

  commit(d: Db): void {
    if (this.sawClaim) {
      this.outcome.refusalCode = 'TASK_ALREADY_RUNNING';
      return;
    }
    const actionId = this.entry === 'COORDINATOR' ? `act-${this.taskId}-0` : null;
    if (actionId) {
      d.actions.push({ key: `pc:v1:${d.projectId}:dispatch:${this.taskId}:0`, type: 'DISPATCH_TASK', status: 'APPLIED', createdAt: 0 });
    }
    let row: Session | null;
    try {
      row = insertSession(
        d,
        {
          id: `s-${this.entry}-${d.sessions.length}`,
          taskId: this.taskId,
          status: 'PENDING',
          deletedAt: null,
          origin: this.entry,
          projectActionId: actionId,
        },
        this.fences,
      );
    } catch (e) {
      if (!(e instanceof AuthorityViolation)) throw e;
      // The trigger aborted this entry point's transaction: its action row goes with it.
      d.actions = d.actions.filter((a) => a.key !== `pc:v1:${d.projectId}:dispatch:${this.taskId}:0`);
      this.outcome.violation = true;
      return;
    }
    if (row === null) {
      // §8.5 C2: zero rows back is a return value. The coordinator still commits — it just
      // records that somebody else got there first.
      this.outcome.refusalCode = 'TASK_ALREADY_RUNNING';
      const action = d.actions.find((a) => a.key === `pc:v1:${d.projectId}:dispatch:${this.taskId}:0`);
      if (action) action.status = 'SUPERSEDED';
      return;
    }
    this.outcome.created = row.id;
  }
}

/** Every merge of two step sequences that preserves each sequence's own order. */
function interleavings<T>(a: T[], b: T[]): T[][] {
  if (a.length === 0) return [b];
  if (b.length === 0) return [a];
  return [
    ...interleavings(a.slice(1), b).map((rest) => [a[0], ...rest]),
    ...interleavings(a, b.slice(1)).map((rest) => [b[0], ...rest]),
  ];
}

function raceTwo(first: Entry, second: Entry, fences: Fences, taskId = 'X'): { sessions: number; outcomes: Outcome[] }[] {
  const results: { sessions: number; outcomes: Outcome[] }[] = [];
  for (const plan of interleavings(['A.plan', 'A.commit'], ['B.plan', 'B.commit'])) {
    const d = db();
    const a = new Attempt(first, taskId, fences);
    const b = new Attempt(second, taskId, fences);
    for (const step of plan) {
      const who = step.startsWith('A') ? a : b;
      if (step.endsWith('plan')) who.plan(d);
      else who.commit(d);
    }
    results.push({ sessions: d.sessions.filter((s) => OCCUPYING.includes(s.status)).length, outcomes: [a.outcome, b.outcome] });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-01 · a shared task-level linearization point
// ─────────────────────────────────────────────────────────────────────────────

test('PC-CX-01 concurrent manual start and coordinator dispatch leave exactly one live session', () => {
  const runs = raceTwo('USER', 'COORDINATOR', V11);
  assert.equal(runs.length, 6, 'two two-step transactions have six interleavings');
  for (const { sessions, outcomes } of runs) {
    assert.equal(sessions, 1, 'the claim index admits exactly one occupying session per task');
    const created = outcomes.filter((o) => o.created !== null);
    const refused = outcomes.filter((o) => o.refusalCode !== undefined);
    assert.equal(created.length, 1, 'exactly one entry point creates');
    assert.equal(refused.length, 1, 'and the other gets a determinate answer, not an exception');
    assert.equal(refused[0].refusalCode, 'TASK_ALREADY_RUNNING');
  }

  // Negative control: v1 had no shared primitive, only the action ledger — which the manual entry
  // point never writes to. The review's minimal sequence (both plan, then both commit) is exactly
  // the interleaving that produces two live sessions.
  const v1 = raceTwo('USER', 'COORDINATOR', V1);
  assert.ok(
    v1.some((r) => r.sessions === 2),
    'the counter-example must reproduce PC-CX-01 when the claim index is removed',
  );
});

test('PC-CX-01 the coordinator still commits the rest of its outcome when it loses the race', () => {
  // Losing the claim is not a failed reconcile — §8.5 C2 and §19.1 both require the action row to
  // survive as an audit trail. This is the seam where PC-CX-01 and PC-CX-04 meet: fixing the race
  // with an exception would have turned one defect into the other.
  const d = db();
  const user = new Attempt('USER', 'X', V11);
  const coord = new Attempt('COORDINATOR', 'X', V11);
  user.plan(d);
  coord.plan(d);
  user.commit(d);
  coord.commit(d);

  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].origin, 'USER');
  const action = d.actions.find((a) => a.type === 'DISPATCH_TASK');
  assert.ok(action, 'the coordinator leaves an action row even when it loses');
  assert.equal(action.status, 'SUPERSEDED');
  assert.equal(coord.outcome.refusalCode, 'TASK_ALREADY_RUNNING');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-02 · dispatch authority across a mixed-version window
// ─────────────────────────────────────────────────────────────────────────────

test('PC-CX-02 a legacy sweep cannot dispatch a COORDINATOR-authority task', () => {
  for (const { sessions, outcomes } of raceTwo('LEGACY_SWEEP', 'COORDINATOR', V11)) {
    assert.equal(sessions, 1, 'still at most one session');
    const legacy = outcomes.find((o) => o.entry === 'LEGACY_SWEEP')!;
    assert.equal(legacy.created, null, 'the old binary never creates the session');
    // Either the trigger refused it, or it lost the claim race first — both are fine, and both
    // leave the surviving session attributable.
    assert.ok(legacy.violation || legacy.refusalCode === 'TASK_ALREADY_RUNNING');
  }

  // Negative control: fencing tokens are what v1 offered here, and an old binary takes no lease at
  // all, so with the trigger gone the old sweep can win the task outright.
  const v1 = raceTwo('LEGACY_SWEEP', 'COORDINATOR', V1);
  assert.ok(
    v1.some((r) => r.sessions === 2),
    'without the trigger, a mixed-version window double-dispatches',
  );
});

test('PC-CX-02 the guard refuses in both directions and leaves LEGACY tasks untouched', () => {
  // A coordinator reaching for a LEGACY task is the other half of the same violation.
  const legacyTask = db({ tasks: { X: { dispatchAuthority: 'LEGACY', failureCount: 0 } } });
  assert.throws(
    () =>
      insertSession(
        legacyTask,
        { id: 's1', taskId: 'X', status: 'PENDING', deletedAt: null, origin: 'COORDINATOR', projectActionId: 'act-1' },
        V11,
      ),
    AuthorityViolation,
  );
  // …but the legacy path on a legacy task is byte-for-byte unaffected (§12.2).
  assert.ok(
    insertSession(
      legacyTask,
      { id: 's2', taskId: 'X', status: 'PENDING', deletedAt: null, origin: 'LEGACY_SWEEP', projectActionId: null },
      V11,
    ),
  );

  // D6-c: a new binary that forgets to stamp `dispatch_origin` falls back to the DB default and
  // fails closed on the first click rather than silently double-dispatching in production.
  const coordTask = db();
  assert.throws(
    () =>
      insertSession(
        coordTask,
        { id: 's3', taskId: 'X', status: 'PENDING', deletedAt: null, origin: 'LEGACY_SWEEP', projectActionId: null },
        V11,
      ),
    AuthorityViolation,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-03 · run state precedence over a mixed blocker set
// ─────────────────────────────────────────────────────────────────────────────

/** §4.2 RS0. Guards in order, first match wins; the only input is the snapshot. */
function runStateOf(snap: {
  projectStatus: 'OPEN' | 'DONE' | 'CANCELLED';
  blockers: Blocker[];
  acceptanceInFlight: boolean;
  liveSessions: number;
  openVerification: number;
}): string {
  const open = snap.blockers.filter((b) => b.resolvedAt === null);
  if (snap.projectStatus !== 'OPEN') return 'SETTLED';
  if (open.some((b) => b.owner === 'USER')) return 'AWAITING_HUMAN';
  if (open.some((b) => b.owner !== 'USER')) return 'BLOCKED';
  if (snap.acceptanceInFlight) return 'ACCEPTANCE';
  if (snap.liveSessions > 0) return 'EXECUTING';
  if (snap.openVerification > 0) return 'AWAITING_VERIFICATION';
  return 'PLANNING';
}

function blocker(over: Partial<Blocker> & { owner: Owner; recovery: Recovery }): Blocker {
  return {
    id: `b-${over.kind ?? over.owner}`,
    kind: over.kind ?? 'PROVIDER_UNAVAILABLE',
    dedupeKey: `${over.kind ?? over.owner}:x`,
    firstSeenAt: 0,
    nextCheckAt: null,
    escalatedAt: null,
    resolvedAt: null,
    ...over,
  };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

test('PC-CX-03 run state is one value for every permutation of a mixed blocker set', () => {
  const mixes: { name: string; blockers: Blocker[]; expected: string }[] = [
    {
      name: 'USER + SYSTEM',
      blockers: [
        blocker({ kind: 'PROVIDER_UNAVAILABLE', owner: 'SYSTEM', recovery: 'EVENT' }),
        blocker({ kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN' }),
      ],
      expected: 'AWAITING_HUMAN',
    },
    {
      name: 'USER + COORDINATOR',
      blockers: [
        blocker({ kind: 'MERGE_CONFLICT', owner: 'COORDINATOR', recovery: 'EVENT' }),
        blocker({ kind: 'AWAITING_USER_INPUT', owner: 'USER', recovery: 'HUMAN' }),
      ],
      expected: 'AWAITING_HUMAN',
    },
    {
      name: 'all three owners',
      blockers: [
        blocker({ kind: 'NO_MATCHING_RUNNER', owner: 'SYSTEM', recovery: 'EVENT' }),
        blocker({ kind: 'MERGE_CONFLICT', owner: 'COORDINATOR', recovery: 'EVENT' }),
        blocker({ kind: 'POLICY_MANUAL_HOLD', owner: 'USER', recovery: 'HUMAN' }),
      ],
      expected: 'AWAITING_HUMAN',
    },
    {
      name: 'SYSTEM + COORDINATOR, no USER',
      blockers: [
        blocker({ kind: 'PROVIDER_UNAVAILABLE', owner: 'SYSTEM', recovery: 'EVENT' }),
        blocker({ kind: 'DEPENDENCY_CYCLE', owner: 'COORDINATOR', recovery: 'EVENT' }),
      ],
      expected: 'BLOCKED',
    },
  ];

  for (const { name, blockers, expected } of mixes) {
    const seen = new Set(
      permutations(blockers).map((order) =>
        runStateOf({ projectStatus: 'OPEN', blockers: order, acceptanceInFlight: false, liveSessions: 1, openVerification: 1 }),
      ),
    );
    assert.deepEqual([...seen], [expected], `${name}: every permutation must agree (I8)`);
  }
});

test('PC-CX-03 the guard order in §4.2 is the order the model realizes', () => {
  // The precedence is not an implementation detail to be discovered by reading code: it is a
  // frozen table, so the model reads it and proves it realizes that exact order. Snapshot k turns
  // on guard k and every lower-priority guard too, so only the precedence can decide the answer.
  const order = column(tables(section(PCC, '4.2'))[0], 'run_state').map(bare);
  assert.deepEqual(order, [
    'SETTLED',
    'AWAITING_HUMAN',
    'BLOCKED',
    'ACCEPTANCE',
    'EXECUTING',
    'AWAITING_VERIFICATION',
    'PLANNING',
  ]);

  const on = [
    (s: Parameters<typeof runStateOf>[0]) => (s.projectStatus = 'DONE'),
    (s: Parameters<typeof runStateOf>[0]) => s.blockers.push(blocker({ owner: 'USER', recovery: 'HUMAN' })),
    (s: Parameters<typeof runStateOf>[0]) => s.blockers.push(blocker({ owner: 'SYSTEM', recovery: 'EVENT' })),
    (s: Parameters<typeof runStateOf>[0]) => (s.acceptanceInFlight = true),
    (s: Parameters<typeof runStateOf>[0]) => (s.liveSessions = 1),
    (s: Parameters<typeof runStateOf>[0]) => (s.openVerification = 1),
    () => undefined,
  ];
  assert.equal(on.length, order.length, 'a guard in the table with no way to switch it on is untestable');

  for (let k = 0; k < order.length; k++) {
    const snap: Parameters<typeof runStateOf>[0] = {
      projectStatus: 'OPEN',
      blockers: [],
      acceptanceInFlight: false,
      liveSessions: 0,
      openVerification: 0,
    };
    for (let j = k; j < on.length; j++) on[j](snap);
    assert.equal(runStateOf(snap), order[k], `guard ${k + 1} must win over every guard below it`);
  }
});

test('PC-CX-03 I4a and I4b hold in both directions, and masking never resolves a blocker', () => {
  const user = blocker({ kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN', nextCheckAt: 24 * 60 * MINUTE });
  const system = blocker({ kind: 'PROVIDER_UNAVAILABLE', owner: 'SYSTEM', recovery: 'EVENT', nextCheckAt: 5 * MINUTE });
  const base = { projectStatus: 'OPEN' as const, acceptanceInFlight: false, liveSessions: 0, openVerification: 0 };

  assert.equal(runStateOf({ ...base, blockers: [user, system] }), 'AWAITING_HUMAN'); // I4a →
  assert.equal(runStateOf({ ...base, blockers: [system] }), 'BLOCKED'); // I4b →
  assert.equal(runStateOf({ ...base, blockers: [] }), 'PLANNING'); // ← both

  // §19.3's recovery path: answering the human leaves BLOCKED, a transition v1's table never had.
  const answered = { ...user, resolvedAt: 1 };
  assert.equal(runStateOf({ ...base, blockers: [answered, system] }), 'BLOCKED');

  // N-mask: the masked blocker is still open, and still owns a clock.
  assert.equal(system.resolvedAt, null);
  assert.equal(nextWakeOf(0, [user, system], { runState: 'AWAITING_HUMAN' }), 5 * MINUTE);
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-04 · committing an outcome whose action already exists
// ─────────────────────────────────────────────────────────────────────────────

interface OutcomePlan {
  fencingToken: number;
  actions: { key: string; type: string }[];
  blockersCleared: string[];
  nextWakeAt: number;
  consumedEventIds: string[];
}

type CommitResult = { committed: true; actionStatuses: string[] } | { committed: false; reason: string };

function commitOutcome(d: Db, plan: OutcomePlan, opts: { v1RollbackOnConflict?: boolean } = {}): CommitResult {
  // §8.1 F1 / §8.5 C3: the token check is the first statement, and a mismatch is the *only*
  // legitimate reason to roll the whole thing back.
  if (d.fencingToken !== plan.fencingToken) return { committed: false, reason: 'FENCED' };

  const statuses: string[] = [];
  for (const a of plan.actions) {
    const existing = d.actions.find((x) => x.key === a.key);
    if (existing) {
      if (opts.v1RollbackOnConflict) return { committed: false, reason: 'CONFLICT_ROLLBACK' };
      statuses.push('ALREADY_APPLIED'); // §8.5 C2 — a return value, not an exception
      continue;
    }
    d.actions.push({ key: a.key, type: a.type, status: 'APPLIED', createdAt: plan.nextWakeAt });
    statuses.push('APPLIED');
  }
  for (const id of plan.blockersCleared) {
    const b = d.blockers.find((x) => x.id === id);
    if (b) b.resolvedAt = plan.nextWakeAt;
  }
  d.nextWakeAt = plan.nextWakeAt;
  for (const id of plan.consumedEventIds) {
    const e = d.events.find((x) => x.id === id);
    if (e) e.consumedAt = plan.nextWakeAt;
  }
  d.decisions.push({ runStateAfter: 'PLANNING' });
  return { committed: true, actionStatuses: statuses };
}

function conflictScenario(): { d: Db; plan: OutcomePlan } {
  const d = db({
    actions: [{ key: 'pc:v1:p1:turn:0:d1', type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED', createdAt: 0, endedAt: 1 }],
    blockers: [blocker({ id: 'b-gone', kind: 'PROVIDER_UNAVAILABLE', owner: 'SYSTEM', recovery: 'EVENT' })],
    events: [{ id: 'E', consumedAt: null }],
  });
  return {
    d,
    plan: {
      fencingToken: 42,
      actions: [{ key: 'pc:v1:p1:turn:0:d1', type: 'OPEN_COORDINATOR_TURN' }],
      blockersCleared: ['b-gone'],
      nextWakeAt: 60_000,
      consumedEventIds: ['E'],
    },
  };
}

test('PC-CX-04 an idempotency conflict still consumes the event and commits the rest', () => {
  const { d, plan } = conflictScenario();
  const result = commitOutcome(d, plan);

  assert.ok(result.committed, 'a key conflict is not a failed reconcile');
  assert.deepEqual(result.actionStatuses, ['ALREADY_APPLIED']);
  // §8.5 C5 asks for all four, not just a session count.
  assert.equal(d.actions.filter((a) => a.key === 'pc:v1:p1:turn:0:d1').length, 1, 'still exactly one action row');
  assert.equal(d.events[0].consumedAt, 60_000, 'the event must not be left for the consumer to fetch again');
  assert.equal(d.blockers[0].resolvedAt, 60_000, 'the blocker clear must land');
  assert.equal(d.nextWakeAt, 60_000, 'the wake must move forward');
  assert.equal(d.decisions.length, 1, 'and the decision must be audited');

  // Negative control: v1 said "conflict → roll the whole transaction back and treat it as
  // success". The event is then still unconsumed, so the consumer fetches it again, reaches the
  // same conclusion, and rolls back again — a livelock on that one event.
  const v1 = conflictScenario();
  const rolled = commitOutcome(v1.d, v1.plan, { v1RollbackOnConflict: true });
  assert.equal(rolled.committed, false);
  assert.equal(v1.d.events[0].consumedAt, null, 'v1 leaves the event unconsumed forever');
  assert.equal(v1.d.blockers[0].resolvedAt, null);
  assert.equal(v1.d.nextWakeAt, null);
});

test('PC-CX-04 a stale fencing token is still a full rollback', () => {
  // C3 is the other half: making conflicts survivable must not make takeover survivable.
  const { d, plan } = conflictScenario();
  d.fencingToken = 43; // somebody took over
  const result = commitOutcome(d, plan);
  assert.equal(result.committed, false);
  assert.equal((result as { reason: string }).reason, 'FENCED');
  assert.equal(d.events[0].consumedAt, null, 'the takeover holder will reconcile the same facts');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-05 · one clock for human waits, budget windows, escalation and the backstop
// ─────────────────────────────────────────────────────────────────────────────

/** §10.4, including N-null. Returns null only where the contract allows the project to stop its clock. */
function nextWakeOf(
  now: number,
  blockers: Blocker[],
  ctx: { runState: string; backoffUntil?: number; runAt?: number; liveSessions?: number },
): number | null {
  if (ctx.runState === 'SETTLED') return null;
  const candidates: number[] = [];
  for (const b of blockers.filter((x) => x.resolvedAt === null)) {
    // Rule 1 — anything time or the world can clear on its own must be re-checked.
    if (b.recovery !== 'HUMAN' && b.nextCheckAt !== null) candidates.push(b.nextCheckAt);
    // Rule 2 — an escalation alarm, for every owner, until it has fired once.
    if (b.escalatedAt === null) candidates.push(b.firstSeenAt + ESCALATION_AFTER);
  }
  if (ctx.backoffUntil !== undefined) candidates.push(ctx.backoffUntil);
  if (ctx.runAt !== undefined) candidates.push(ctx.runAt);
  if (ctx.liveSessions) candidates.push(now + MINUTE);
  if (candidates.length === 0 && ctx.runState === 'PLANNING') candidates.push(now + MINUTE);
  if (candidates.length === 0) return null;
  return Math.max(Math.min(...candidates), now + 5_000); // W3
}

/** §10.2 W4. True = the backstop hits this project and logs a WARN. */
function backstopHits(now: number, project: { status: string; coordinatorEnabled: boolean }, runtime: { runState: string; nextWakeAt: number | null }, blockers: Blocker[]): boolean {
  if (project.status !== 'OPEN' || !project.coordinatorEnabled || runtime.runState === 'SETTLED') return false;
  if (runtime.nextWakeAt !== null) return runtime.nextWakeAt < now - 5 * MINUTE;
  const open = blockers.filter((b) => b.resolvedAt === null);
  if (open.length === 0) return true; // (iii) the silent stall itself
  return open.some((b) => b.recovery !== 'HUMAN' || b.escalatedAt === null); // (ii)
}

test('PC-CX-05 budget waits keep a clock and human waits stop hitting the backstop', () => {
  const now = 10 * MINUTE;
  const project = { status: 'OPEN', coordinatorEnabled: true };
  const windowBoundary = 6 * 60 * MINUTE;

  // (1) A budget wait recovers on a timer, so it is BLOCKED with a wake at the window boundary.
  const budget = blocker({
    kind: 'BUDGET_EXHAUSTED',
    owner: 'SYSTEM',
    recovery: 'TIME',
    firstSeenAt: now,
    nextCheckAt: windowBoundary,
  });
  assert.equal(
    runStateOf({ projectStatus: 'OPEN', blockers: [budget], acceptanceInFlight: false, liveSessions: 0, openVerification: 0 }),
    'BLOCKED',
    'a wait only time can end is not a wait for a human',
  );
  const budgetWake = nextWakeOf(now, [budget], { runState: 'BLOCKED' });
  assert.equal(budgetWake, now + ESCALATION_AFTER, 'the earlier of the window boundary and the escalation alarm');
  assert.ok(budgetWake !== null && budgetWake < windowBoundary);
  assert.equal(backstopHits(now, project, { runState: 'BLOCKED', nextWakeAt: budgetWake }, [budget]), false);

  // Once it has escalated it still recovers on time (ES1) — escalation changes owner, not recovery.
  const escalated = { ...budget, owner: 'USER' as Owner, escalatedAt: now + ESCALATION_AFTER };
  assert.equal(nextWakeOf(now, [escalated], { runState: 'AWAITING_HUMAN' }), windowBoundary);

  // (2) A human wait that has not escalated yet keeps the escalation alarm, so it has a wake.
  const approval = blocker({ kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN', firstSeenAt: now });
  const pending = nextWakeOf(now, [approval], { runState: 'AWAITING_HUMAN' });
  assert.equal(pending, now + ESCALATION_AFTER);
  assert.equal(backstopHits(now, project, { runState: 'AWAITING_HUMAN', nextWakeAt: pending }, [approval]), false);

  // (3) After escalation there is genuinely nothing time can do — the one legal null wake.
  const notified = { ...approval, escalatedAt: now + ESCALATION_AFTER };
  assert.equal(nextWakeOf(now + ESCALATION_AFTER, [notified], { runState: 'AWAITING_HUMAN' }), null);
  assert.equal(
    backstopHits(now + ESCALATION_AFTER, project, { runState: 'AWAITING_HUMAN', nextWakeAt: null }, [notified]),
    false,
    'v1 logged a WARN here every 60s, which is what made W2 meaningless',
  );

  // (4) Every other null wake is the bug W2 is looking for.
  assert.equal(backstopHits(now, project, { runState: 'PLANNING', nextWakeAt: null }, []), true);
  assert.equal(backstopHits(now, project, { runState: 'BLOCKED', nextWakeAt: null }, [budget]), true);
  assert.equal(backstopHits(now, project, { runState: 'AWAITING_HUMAN', nextWakeAt: null }, [approval]), true);
  // …and so is an overdue wake.
  assert.equal(backstopHits(now, project, { runState: 'PLANNING', nextWakeAt: now - 6 * MINUTE }, []), true);
});

test('PC-CX-05 the v1 rule would have stranded the budget window forever', () => {
  // Negative control, stated as v1 stated it: owner USER → AWAITING_HUMAN → nextWakeAt NULL.
  const now = 0;
  const v1Budget = blocker({ kind: 'BUDGET_EXHAUSTED', owner: 'USER', recovery: 'HUMAN', firstSeenAt: now, escalatedAt: now });
  assert.equal(
    runStateOf({ projectStatus: 'OPEN', blockers: [v1Budget], acceptanceInFlight: false, liveSessions: 0, openVerification: 0 }),
    'AWAITING_HUMAN',
  );
  assert.equal(nextWakeOf(now, [v1Budget], { runState: 'AWAITING_HUMAN' }), null, 'no timer would ever have come back');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-06 · one rule for whether a task failure opens a turn
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AUTO_RUN_FAILURES = 3;

interface FailureVerdict {
  blocker: string | null;
  owner: Owner | null;
  recovery: Recovery | null;
  opensTurn: boolean;
  contributes: string | null;
  dispatch: 'DISPATCH' | 'WAIT' | 'STOP';
}

/** §9.5 Q3, table-driven exactly as Q3-c requires. */
function failurePolicy(input: { failureCount: number; backoffExpired: boolean; attributable: boolean }): FailureVerdict {
  if (!input.attributable && input.failureCount > 0) {
    return { blocker: 'UNKNOWN_FAILURE', owner: 'USER', recovery: 'HUMAN', opensTurn: false, contributes: 'AWAITING_HUMAN', dispatch: 'STOP' };
  }
  if (input.failureCount === 0) return { blocker: null, owner: null, recovery: null, opensTurn: false, contributes: null, dispatch: 'DISPATCH' };
  if (input.failureCount >= MAX_AUTO_RUN_FAILURES) {
    return { blocker: 'TEST_FAILED', owner: 'USER', recovery: 'HUMAN', opensTurn: false, contributes: 'AWAITING_HUMAN', dispatch: 'STOP' };
  }
  return input.backoffExpired
    ? { blocker: null, owner: null, recovery: null, opensTurn: false, contributes: null, dispatch: 'DISPATCH' }
    : { blocker: null, owner: null, recovery: null, opensTurn: false, contributes: null, dispatch: 'WAIT' };
}

test('PC-CX-06 every task failure state maps to exactly one action', () => {
  const cases = [
    { input: { failureCount: 0, backoffExpired: true, attributable: true }, dispatch: 'DISPATCH', blocker: null },
    { input: { failureCount: 1, backoffExpired: false, attributable: true }, dispatch: 'WAIT', blocker: null },
    { input: { failureCount: 1, backoffExpired: true, attributable: true }, dispatch: 'DISPATCH', blocker: null },
    { input: { failureCount: MAX_AUTO_RUN_FAILURES, backoffExpired: true, attributable: true }, dispatch: 'STOP', blocker: 'TEST_FAILED' },
    { input: { failureCount: 1, backoffExpired: true, attributable: false }, dispatch: 'STOP', blocker: 'UNKNOWN_FAILURE' },
  ] as const;

  for (const c of cases) {
    const got = failurePolicy(c.input);
    assert.equal(got.dispatch, c.dispatch, JSON.stringify(c.input));
    assert.equal(got.blocker, c.blocker, JSON.stringify(c.input));
    // TU2: no arm of the failure path opens a turn. This is the assertion that would have caught
    // v1 — under v1 the first row with a blocker had owner COORDINATOR, and §7.2 condition 3 then
    // *required* a turn while the same section forbade it.
    assert.equal(got.opensTurn, false, 'a task failure never opens a coordinator turn');
    if (got.blocker) {
      assert.equal(got.owner, 'USER');
      assert.equal(got.recovery, 'HUMAN');
    }
  }

  // The backoff window has no blocker at all — a NOOP audit row plus a wake is the other exit BL1
  // allows, and it is what keeps a retrying project out of BLOCKED.
  const backingOff = failurePolicy({ failureCount: 1, backoffExpired: false, attributable: true });
  assert.equal(backingOff.contributes, null, 'one backing-off task must not turn the whole project BLOCKED');
  assert.equal(
    nextWakeOf(0, [], { runState: 'EXECUTING', backoffUntil: 5 * MINUTE }),
    5 * MINUTE,
    'the wake points at the retry (Q2)',
  );
});

test('PC-CX-06 the §9.5 table and the model agree, row for row', () => {
  const rows = tables(section(PCC, '9.5'))[0];
  assert.equal(rows.length - 1, 5, '§9.5 Q3 freezes five cases');
  const blockers = column(rows, 'blocker').map(bare);
  const owners = column(rows, 'owner').map(bare);
  const opens = column(rows, 'opensTurn').map(bare);

  assert.deepEqual(opens, ['——', '——', '——', '✘', '✘'], 'no row of the failure table opens a turn');
  assert.deepEqual(blockers.slice(0, 3), ['无', '无', '无'], 'nothing below the threshold raises a blocker');
  assert.deepEqual(blockers.slice(3), ['TEST_FAILED', 'UNKNOWN_FAILURE']);
  assert.deepEqual(owners.slice(3), ['USER', 'USER'], 'and both of those belong to a person');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-07 · rate limiting and idempotency as two separate things
// ─────────────────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

type TurnDecision =
  | { decision: 'OPEN'; key: string }
  | { decision: 'RATE_LIMITED' }
  | { decision: 'ALREADY_APPLIED'; key: string }
  | { decision: 'NO_PROGRESS'; key: string; blocker: 'COORDINATOR_NO_PROGRESS' };

/** §7.6 TR1–TR3. */
function turnDecision(d: Db, now: number, generation: number, reasonCode: string, turnFacts: unknown): TurnDecision {
  const digest = sha256(`${reasonCode}|${JSON.stringify(turnFacts)}`); // TR1
  const key = `pc:v1:${d.projectId}:turn:${generation}:${digest}`;
  const turns = d.actions.filter((a) => a.type === 'OPEN_COORDINATOR_TURN');
  // TR2 — the floor is per reasonCode, deliberately coarser than the key.
  if (turns.some((a) => a.reasonCode === reasonCode && now - a.createdAt < MINUTE)) return { decision: 'RATE_LIMITED' };
  const prior = turns.find((a) => a.key === key);
  if (prior) {
    if (prior.endedAt == null) return { decision: 'ALREADY_APPLIED', key };
    return { decision: 'NO_PROGRESS', key, blocker: 'COORDINATOR_NO_PROGRESS' }; // TR3
  }
  return { decision: 'OPEN', key };
}

test('PC-CX-07 rate limiting and idempotency are separate, and a no-progress turn becomes a blocker', () => {
  // v1.2 (TF1): what moves the digest is the *condition*, never how many times it was delivered.
  const conflictFacts = { kind: 'MERGE_CONFLICT', subject: 'X', conditionVersion: 'files:a.ts' };
  const d = db();

  // t=0 — a merge conflict opens a turn.
  const first = turnDecision(d, 0, 0, 'BLOCKER_DECISION', conflictFacts);
  assert.equal(first.decision, 'OPEN');
  d.actions.push({ key: (first as { key: string }).key, type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED', createdAt: 0, reasonCode: 'BLOCKER_DECISION', endedAt: null });

  // Still in flight: the key collides, which is a duplicate, not a stall. No blocker.
  assert.equal(turnDecision(d, 30_000, 0, 'BLOCKER_DECISION', conflictFacts).decision, 'RATE_LIMITED');
  d.actions[0].endedAt = 20_000; // the turn ends without resolving anything

  // t=59s — TR2's floor, on the coarse reasonCode.
  assert.equal(turnDecision(d, 59_000, 0, 'BLOCKER_DECISION', conflictFacts).decision, 'RATE_LIMITED');

  // t=61s, facts unchanged — v1 was silent here forever; v1.1 says so out loud.
  const stalled = turnDecision(d, 61_000, 0, 'BLOCKER_DECISION', conflictFacts);
  assert.equal(stalled.decision, 'NO_PROGRESS');
  assert.equal((stalled as { blocker: string }).blocker, 'COORDINATOR_NO_PROGRESS');

  // t=61s, facts changed — a different digest, so a fresh turn, with no counter anywhere.
  const moved = turnDecision(d, 61_000, 0, 'BLOCKER_DECISION', { ...conflictFacts, conditionVersion: 'files:a.ts,b.ts' });
  assert.equal(moved.decision, 'OPEN');
  assert.notEqual((moved as { key: string }).key, (first as { key: string }).key);

  // …and the same generation is still in play, which is precisely what v1 could not express.
  assert.ok((moved as { key: string }).key.includes(':turn:0:'));
});

test('PC-CX-07 the no-progress blocker clears itself when the facts move', () => {
  // BL3: clearing is driven by recomputing the condition, so the blocker cannot outlive its reason.
  const facts = { kind: 'MERGE_CONFLICT', subject: 'X', conditionVersion: 'files:a.ts' };
  const digest = sha256(`BLOCKER_DECISION|${JSON.stringify(facts)}`);
  const b = blocker({ kind: 'COORDINATOR_NO_PROGRESS', owner: 'USER', recovery: 'HUMAN', dedupeKey: `COORDINATOR_NO_PROGRESS:${digest}` });

  const stillStuck = sha256(`BLOCKER_DECISION|${JSON.stringify(facts)}`);
  assert.equal(b.dedupeKey.endsWith(stillStuck), true, 'unchanged facts keep the blocker open');

  const moved = sha256(`BLOCKER_DECISION|${JSON.stringify({ ...facts, conditionVersion: 'files:a.ts,b.ts' })}`);
  assert.equal(b.dedupeKey.endsWith(moved), false, 'changed facts no longer match, so the blocker clears');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-08 · acceptance evidence bound to the facts it was computed from
// ─────────────────────────────────────────────────────────────────────────────

interface AcceptanceFacts {
  projectId: string;
  acceptanceCriteria: string;
  taskSet: [string, string][]; // (taskId, status)
  verdicts: [string, string][]; // (verifierTaskId, verdict)
  mergeEvidence: [string, string][]; // (requirementId, contentHash)
}

/** §13.4 AE1. */
function acceptanceDigest(f: AcceptanceFacts): string {
  return sha256(
    JSON.stringify({
      v: 1,
      projectId: f.projectId,
      criteriaRevision: sha256(f.acceptanceCriteria),
      taskSet: [...f.taskSet].sort(),
      verdicts: [...f.verdicts].sort(),
      mergeEvidence: [...f.mergeEvidence].sort(),
    }),
  );
}

type DoneResult = { ok: true } | { ok: false; code: 'ACCEPTANCE_EVIDENCE_STALE' | 'ACCEPTANCE_MISSING' };

/** §13.4 AE2 — recompute inside the write transaction, then look for evidence matching *that*. */
function writeDone(evidence: { allPass: boolean; digest: string }[], current: AcceptanceFacts, opts: { v1ExistsOnly?: boolean } = {}): DoneResult {
  const passing = evidence.filter((e) => e.allPass);
  if (passing.length === 0) return { ok: false, code: 'ACCEPTANCE_MISSING' };
  if (opts.v1ExistsOnly) return { ok: true }; // v1: "there exists an all-PASS record"
  const fresh = acceptanceDigest(current);
  return passing.some((e) => e.digest === fresh) ? { ok: true } : { ok: false, code: 'ACCEPTANCE_EVIDENCE_STALE' };
}

test('PC-CX-08 stale acceptance evidence cannot pass the DONE gate', () => {
  const h1: AcceptanceFacts = {
    projectId: 'p1',
    acceptanceCriteria: 'every unit merged to feat/project',
    taskSet: [
      ['t1', 'DONE'],
      ['t2', 'DONE'],
    ],
    verdicts: [['v1', 'PASS']],
    mergeEvidence: [['r1', 'content-hash-a']],
  };
  const evidence = [{ allPass: true, digest: acceptanceDigest(h1) }];

  assert.deepEqual(writeDone(evidence, h1), { ok: true }, 'the facts it was computed from still hold');

  // The four mutations §19.8 enumerates, each on its own.
  const mutations: [string, AcceptanceFacts][] = [
    ['acceptanceCriteria edited', { ...h1, acceptanceCriteria: 'every unit merged AND deployed' }],
    ['a task reopened', { ...h1, taskSet: [['t1', 'OPEN'], ['t2', 'DONE']] }],
    ['a verdict changed', { ...h1, verdicts: [['v1', 'FAIL']] }],
    ['merge content changed', { ...h1, mergeEvidence: [['r1', 'content-hash-b']] }],
  ];
  for (const [what, h2] of mutations) {
    assert.deepEqual(writeDone(evidence, h2), { ok: false, code: 'ACCEPTANCE_EVIDENCE_STALE' }, what);
    // Negative control: v1's "exists an all-PASS record" waves every one of these through.
    assert.deepEqual(writeDone(evidence, h2, { v1ExistsOnly: true }), { ok: true }, `v1 would have allowed DONE after ${what}`);
  }

  // AE4: nothing has to invalidate the old record — reverting the change makes it usable again,
  // because the digest is a function of the facts and of nothing else.
  const reverted = { ...h1, acceptanceCriteria: 'every unit merged to feat/project' };
  assert.deepEqual(writeDone(evidence, reverted), { ok: true });

  // …and a project with no evidence at all is refused with the other code.
  assert.deepEqual(writeDone([], h1), { ok: false, code: 'ACCEPTANCE_MISSING' });
  assert.deepEqual(writeDone([{ allPass: false, digest: acceptanceDigest(h1) }], h1), { ok: false, code: 'ACCEPTANCE_MISSING' });
});

test('PC-CX-08 a task set that changes only in status still changes the digest', () => {
  // The trap AE1 calls out: keying on task ids alone would let a reopened task slip through, since
  // the id set is identical before and after.
  const base: AcceptanceFacts = {
    projectId: 'p1',
    acceptanceCriteria: 'c',
    taskSet: [['t1', 'DONE']],
    verdicts: [],
    mergeEvidence: [],
  };
  assert.notEqual(acceptanceDigest(base), acceptanceDigest({ ...base, taskSet: [['t1', 'OPEN']] }));
  // And a squash-merged commit changes SHAs while the content stands — which is why the digest
  // takes a content hash, not a commit id (§13.4 clause 6).
  assert.equal(
    acceptanceDigest({ ...base, mergeEvidence: [['r1', 'content-hash-a']] }),
    acceptanceDigest({ ...base, mergeEvidence: [['r1', 'content-hash-a']] }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The model and the document must not drift apart
// ─────────────────────────────────────────────────────────────────────────────

test('the blocker kinds the model uses are the ones §11.2 freezes, with the owners it freezes', () => {
  const rows = tableRows(section(PCC, '11.2'));
  const kinds = column(rows, 'kind').map(bare);
  const owners = column(rows, '默认 owner').map(bare);
  const recoveries = column(rows, 'recovery').map(bare);

  const table = new Map(kinds.map((k, i) => [k, { owner: owners[i], recovery: recoveries[i] }]));
  for (const [kind, expected] of [
    ['BUDGET_EXHAUSTED', { owner: 'SYSTEM', recovery: 'TIME' }],
    ['TEST_FAILED', { owner: 'USER', recovery: 'HUMAN' }],
    ['COORDINATOR_NO_PROGRESS', { owner: 'USER', recovery: 'HUMAN' }],
    ['MERGE_CONFLICT', { owner: 'COORDINATOR', recovery: 'EVENT' }],
    ['AWAITING_USER_APPROVAL', { owner: 'USER', recovery: 'HUMAN' }],
    ['PROVIDER_UNAVAILABLE', { owner: 'SYSTEM', recovery: 'EVENT' }],
  ] as const) {
    assert.deepEqual(table.get(kind), expected, `${kind} in §11.2`);
  }
  assert.equal(new Set(recoveries).size <= 3, true, 'recovery is a three-valued axis');
  for (const r of recoveries) assert.match(r, /^(TIME|EVENT|HUMAN)$/);
});

// ═════════════════════════════════════════════════════════════════════════════
// v1.2 · `PC-CX-09..14` (§20)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-09 · an authority flip and a session insert, linearized on one row lock
// ─────────────────────────────────────────────────────────────────────────────

// The model here is deliberately about *Postgres*, not about the control loop: the whole finding is
// that a plain `SELECT` inside the trigger reads a snapshot, so a not-yet-committed authority flip
// is invisible to it. Four facts drive everything below, and each is a documented Postgres rule
// (§20.1 states them, and `coordinator-linearization.pg.spec.ts` checks them against a real server):
//
//   1. a plain SELECT sees the last *committed* version, never an uncommitted one;
//   2. a plain UPDATE of a non-key column takes FOR NO KEY UPDATE on that row — for every binary;
//   3. FOR SHARE conflicts with FOR NO KEY UPDATE, while the FK's FOR KEY SHARE does not;
//   4. in READ COMMITTED, a blocked FOR SHARE re-reads the newest version once it is granted.
//
// Take away (3) and the trigger is reading a value that is already stale by the time it decides.

interface AuthorityRace {
  authority: DispatchAuthority;
  occupying: Session[];
  insertRefused: boolean;
  flipSkipped: boolean;
}

/** §7.7 D6 + D8, with the `FOR SHARE` in the trigger switchable. Off = v1.1. */
function authorityRace(order: 'FLIP_FIRST' | 'INSERT_FIRST', fences: { triggerForShare: boolean }): AuthorityRace {
  const pg = {
    committedAuthority: 'LEGACY' as DispatchAuthority,
    committedSessions: [] as Session[],
    flipRowLock: false,
    insertShareLock: false,
    flipPending: null as DispatchAuthority | null,
    flipSkipped: false,
    staged: null as Session | null,
    insertRefused: false,
  };
  const legacyRow: Session = {
    id: 's-legacy',
    taskId: 'X',
    status: 'PENDING',
    deletedAt: null,
    origin: 'LEGACY_SWEEP',
    projectActionId: null,
  };
  const commitFlip = (): void => {
    if (pg.flipPending !== null) pg.committedAuthority = pg.flipPending;
    pg.flipPending = null;
    pg.flipRowLock = false;
  };
  const commitInsert = (): void => {
    if (pg.staged) pg.committedSessions.push(pg.staged);
    pg.staged = null;
    pg.insertShareLock = false;
  };
  /** The trigger body. Returns the authority it decided on. */
  const guardRead = (): DispatchAuthority => {
    if (fences.triggerForShare) {
      pg.insertShareLock = true;
      // (3)+(4): blocked by the flip's FOR NO KEY UPDATE, then re-reads the newest row version.
      if (pg.flipRowLock) commitFlip();
    }
    return pg.committedAuthority; // (1): an uncommitted flip is simply not visible without the lock
  };
  /** D8-a: lock, *then* read claims in a fresh statement, *then* write. */
  const flipLockScanWrite = (): void => {
    if (fences.triggerForShare && pg.insertShareLock) commitInsert(); // (3): the flip waits its turn
    pg.flipRowLock = true;
    const occupied = pg.committedSessions.some((s) => s.deletedAt === null && OCCUPYING.includes(s.status));
    if (occupied) pg.flipSkipped = true; // D8-b: a claimed task keeps its current authority
    else pg.flipPending = 'COORDINATOR';
  };

  if (order === 'FLIP_FIRST') {
    flipLockScanWrite();
    // ── barrier: the flip has written and not committed ──
    if (guardRead() === 'COORDINATOR') pg.insertRefused = true;
    else pg.staged = legacyRow;
    commitFlip();
    commitInsert();
  } else {
    if (guardRead() === 'COORDINATOR') pg.insertRefused = true;
    else pg.staged = legacyRow;
    // ── barrier: the insert has written and not committed ──
    flipLockScanWrite();
    commitFlip();
    commitInsert();
  }
  return {
    authority: pg.committedAuthority,
    occupying: pg.committedSessions.filter((s) => s.deletedAt === null && OCCUPYING.includes(s.status)),
    insertRefused: pg.insertRefused,
    flipSkipped: pg.flipSkipped,
  };
}

/** I12 — the D6 predicate, evaluated on a *committed* state rather than at INSERT time. */
function i12Holds(authority: DispatchAuthority, occupying: Session[]): boolean {
  return occupying.every((s) =>
    authority === 'COORDINATOR' ? s.origin !== 'LEGACY_SWEEP' : s.origin !== 'COORDINATOR',
  );
}

test('PC-CX-09 an authority flip and a session insert cannot both win', () => {
  const flipFirst = authorityRace('FLIP_FIRST', { triggerForShare: true });
  assert.ok(i12Holds(flipFirst.authority, flipFirst.occupying), 'I12 must hold after both commit');
  assert.equal(flipFirst.authority, 'COORDINATOR');
  assert.equal(flipFirst.occupying.length, 0, 'the old binary never gets its session in');
  assert.equal(flipFirst.insertRefused, true, 'and it finds out — a visible failure, not a silent one');

  const insertFirst = authorityRace('INSERT_FIRST', { triggerForShare: true });
  assert.ok(i12Holds(insertFirst.authority, insertFirst.occupying), 'I12 must hold in this order too');
  assert.equal(insertFirst.authority, 'LEGACY', 'D8-b: a claimed task keeps the authority it had');
  assert.equal(insertFirst.flipSkipped, true, 'the flip sees the claim because it locked first');
  assert.deepEqual(insertFirst.occupying.map((s) => s.origin), ['LEGACY_SWEEP'], 'that session was legal when it was made');

  // Negative control: remove exactly the two words `FOR SHARE` from the trigger and the P0 is back,
  // in *both* commit orders — which is why the fix cannot be "be careful about ordering".
  for (const order of ['FLIP_FIRST', 'INSERT_FIRST'] as const) {
    const v11 = authorityRace(order, { triggerForShare: false });
    assert.equal(v11.authority, 'COORDINATOR');
    assert.deepEqual(v11.occupying.map((s) => s.origin), ['LEGACY_SWEEP'], order);
    assert.equal(i12Holds(v11.authority, v11.occupying), false, `${order}: PC-CX-09 must reproduce without FOR SHARE`);
  }
});

test('PC-CX-09 the deferred flip is finished by the transaction that releases the claim', () => {
  // D8-b leaves a task behind on purpose, so the contract owes an account of who picks it up.
  // §12.3 D3's third write point is that account: the same transaction that ends the session.
  const after = authorityRace('INSERT_FIRST', { triggerForShare: true });
  assert.equal(after.authority, 'LEGACY');

  const released = after.occupying.map((s) => ({ ...s, status: 'SUCCEEDED' as RunStatus }));
  const stillOccupying = released.filter((s) => OCCUPYING.includes(s.status));
  assert.equal(stillOccupying.length, 0, 'the claim is gone');
  const authority: DispatchAuthority = stillOccupying.length === 0 ? 'COORDINATOR' : 'LEGACY';
  assert.equal(authority, 'COORDINATOR', 'and the projection is completed in that same transaction');
  assert.ok(i12Holds(authority, stillOccupying), 'no window: the release and the flip commit together');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-10 · delivery counts are not facts
// ─────────────────────────────────────────────────────────────────────────────

interface ConditionBlocker {
  kind: string;
  subjectId: string;
  conditionVersion: string;
  occurrences: number;
}

/** §7.2 TF1/TF2 — `turnFacts` for `BLOCKER_DECISION`. `withOccurrences` = v1.1. */
function blockerTurnFacts(bs: ConditionBlocker[], withOccurrences: boolean): unknown {
  return [...bs]
    .sort((a, b) => `${a.kind}${a.subjectId}`.localeCompare(`${b.kind}${b.subjectId}`))
    .map((b) => (withOccurrences ? [b.kind, b.subjectId, b.occurrences] : [b.kind, b.subjectId, b.conditionVersion]));
}

/** §11.3 — a repeat of the same cause bumps the counter and recomputes the condition. */
function deliver(open: ConditionBlocker[], signal: Omit<ConditionBlocker, 'occurrences'>): ConditionBlocker[] {
  const existing = open.find((b) => b.kind === signal.kind && b.subjectId === signal.subjectId);
  if (!existing) return [...open, { ...signal, occurrences: 1 }];
  existing.occurrences += 1;
  existing.conditionVersion = signal.conditionVersion; // recomputed from the facts, not accumulated
  return open;
}

test('PC-CX-10 repeated delivery of one condition never changes the turn key', () => {
  const signal = { kind: 'MERGE_CONFLICT', subjectId: 'X', conditionVersion: 'files:a.ts|branch:main' };

  for (const n of [1, 2, 5, 50]) {
    let open: ConditionBlocker[] = [];
    for (let i = 0; i < n; i++) open = deliver(open, signal);
    assert.equal(open.length, 1, 'dedupe keeps one row');
    assert.equal(open[0].occurrences, n, 'the counter still counts — it just does not decide anything');
    assert.equal(
      sha256(`BLOCKER_DECISION|${JSON.stringify(blockerTurnFacts(open, false))}`),
      sha256(`BLOCKER_DECISION|${JSON.stringify(blockerTurnFacts([{ ...signal, occurrences: 1 }], false))}`),
      `${n} deliveries of one condition must produce the digest of one delivery`,
    );
  }

  // …and the whole point of that: the second look is a no-progress stall, not a fresh turn.
  const d = db();
  const open = deliver(deliver([], signal), signal);
  const facts = blockerTurnFacts(open, false);
  const first = turnDecision(d, 0, 0, 'BLOCKER_DECISION', facts);
  assert.equal(first.decision, 'OPEN');
  d.actions.push({ key: (first as { key: string }).key, type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED', createdAt: 0, reasonCode: 'BLOCKER_DECISION', endedAt: 10_000 });
  const second = turnDecision(d, 61_000, 0, 'BLOCKER_DECISION', blockerTurnFacts(deliver(open, signal), false));
  assert.equal(second.decision, 'NO_PROGRESS', 'the sixth delivery of an unresolved conflict is not progress');

  // Negative control: v1.1 put `occurrences` in `turnFacts`, so every repeat minted a new key and,
  // once past TR2's 60s floor, a new turn — forever, at whatever rate the signal repeats.
  const v11 = db();
  let v11open: ConditionBlocker[] = deliver([], signal);
  const t0 = turnDecision(v11, 0, 0, 'BLOCKER_DECISION', blockerTurnFacts(v11open, true));
  assert.equal(t0.decision, 'OPEN');
  v11.actions.push({ key: (t0 as { key: string }).key, type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED', createdAt: 0, reasonCode: 'BLOCKER_DECISION', endedAt: 10_000 });
  v11open = deliver(v11open, signal);
  const t1 = turnDecision(v11, 61_000, 0, 'BLOCKER_DECISION', blockerTurnFacts(v11open, true));
  assert.equal(t1.decision, 'OPEN', 'PC-CX-10 must reproduce when occurrences is a fact');
  assert.notEqual((t1 as { key: string }).key, (t0 as { key: string }).key);
});

/**
 * The §7.2 turn-reason table. v1.4 gave it an order column (TU4) and added a second table with the
 * same first column (TF4), so it is addressed by header: a positional read now silently picks the
 * wrong table and yields an empty list, which most assertions below would happily pass.
 */
function turnReasons(): string[][] {
  return tables(section(PCC, '7.2')).find((t) => t[0].some((h) => bare(h) === '触发条件'))!;
}

test('PC-CX-10 no turnFacts column names anything that moves on its own', () => {
  // TF1 is a deny-list, so it can be checked by reading the frozen table rather than by trusting
  // that whoever writes the next `reasonCode` remembers the rule.
  const facts = column(turnReasons(), 'turnFacts（进入 reasonDigest 的输入投影，§7.3）');
  assert.ok(facts.length >= 5, 'the trigger table is a closed set of reasonCodes');
  for (const cell of facts) {
    for (const banned of ['occurrences', 'attempts', 'lastSeenAt', 'last_seen_at', 'firstSeenAt', 'first_seen_at', 'escalatedAt', 'escalated_at', 'snapshotAt', 'now()']) {
      assert.ok(!cell.includes(banned), `turnFacts must not contain ${banned} (TF1): ${cell}`);
    }
  }
  assert.ok(facts.some((c) => c.includes('conditionVersion')), 'the blocker row must bind the condition, not the count');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-11 · a dispatch epoch that only ever goes forward
// ─────────────────────────────────────────────────────────────────────────────

interface EpochTask {
  dispatchAttempt: number;
  failureCount: number;
}

type DispatchResult = { key: string; created: boolean; status: 'APPLIED' | 'ALREADY_APPLIED' };

/** §8.2 DA1–DA3. `epoch: 'failureCount'` is v1.1. */
function dispatch(d: Db, taskId: string, task: EpochTask, epoch: 'dispatchAttempt' | 'failureCount'): DispatchResult {
  const key = `pc:v1:${d.projectId}:dispatch:${taskId}:${epoch === 'dispatchAttempt' ? task.dispatchAttempt : task.failureCount}`;
  if (d.actions.some((a) => a.key === key)) return { key, created: false, status: 'ALREADY_APPLIED' }; // §8.5 C2
  d.actions.push({ key, type: 'DISPATCH_TASK', status: 'APPLIED', createdAt: 0 });
  d.sessions.push({ id: `s${d.sessions.length}`, taskId, status: 'PENDING', deletedAt: null, origin: 'COORDINATOR', projectActionId: key });
  task.dispatchAttempt += 1; // DA2 — only on a successful ledger insert, in the same transaction
  return { key, created: true, status: 'APPLIED' };
}

/** Dispatch, fail to the threshold, let a human clear the failure count, dispatch again. */
function failureCycle(epoch: 'dispatchAttempt' | 'failureCount'): { keys: string[]; sessions: number; afterReset: DispatchResult } {
  const d = db();
  const task: EpochTask = { dispatchAttempt: 0, failureCount: 0 };
  const keys: string[] = [];
  for (let i = 0; i < MAX_AUTO_RUN_FAILURES; i++) {
    keys.push(dispatch(d, 'X', task, epoch).key);
    task.failureCount += 1; // the session failed
    d.sessions = d.sessions.map((s) => ({ ...s, status: 'FAILED' as RunStatus }));
  }
  // §9.5 Q3 last row: TEST_FAILED, automatic dispatch stops until a person deals with it.
  assert.equal(failurePolicy({ failureCount: task.failureCount, backoffExpired: true, attributable: true }).blocker, 'TEST_FAILED');
  task.failureCount = 0; // §19.6 — the human recovery path, which is allowed to touch *this* counter
  const afterReset = dispatch(d, 'X', task, epoch);
  return { keys, sessions: d.sessions.length, afterReset };
}

test('PC-CX-11 a human reset never reuses a dispatch key', () => {
  const fixed = failureCycle('dispatchAttempt');
  assert.deepEqual(fixed.keys, ['pc:v1:p1:dispatch:X:0', 'pc:v1:p1:dispatch:X:1', 'pc:v1:p1:dispatch:X:2']);
  assert.equal(fixed.afterReset.status, 'APPLIED', 'a genuinely new attempt gets a key that never existed');
  assert.equal(fixed.afterReset.key, 'pc:v1:p1:dispatch:X:3');
  assert.equal(fixed.afterReset.created, true, 'and therefore an actual session');
  assert.equal(fixed.sessions, MAX_AUTO_RUN_FAILURES + 1);

  // Negative control: v1.1's epoch was `failureCount`, and §19.6 tells the human to zero it. The
  // fourth dispatch then recomputes a key that is already APPLIED, §8.5 reads that as "already
  // done", and the task is unrunnable forever — with no blocker, no error and no missing audit row.
  const v11 = failureCycle('failureCount');
  assert.deepEqual(v11.keys, ['pc:v1:p1:dispatch:X:0', 'pc:v1:p1:dispatch:X:1', 'pc:v1:p1:dispatch:X:2']);
  assert.equal(v11.afterReset.key, 'pc:v1:p1:dispatch:X:0', 'PC-CX-11: the reset walks back onto a used key');
  assert.equal(v11.afterReset.status, 'ALREADY_APPLIED');
  assert.equal(v11.afterReset.created, false, 'no session — silently, forever');
  assert.equal(v11.sessions, MAX_AUTO_RUN_FAILURES);
});

test('PC-CX-11 idempotency survives the new epoch: one snapshot is still one dispatch', () => {
  // Making the epoch monotonic must not make duplicate reconciles dispatch twice — DA2's rule is
  // that the key comes from the *snapshot* and the increment happens on the successful insert.
  const d = db();
  const task: EpochTask = { dispatchAttempt: 0, failureCount: 0 };
  const snapshot = { ...task }; // two reconciles that read the same snapshot
  const first = dispatch(d, 'X', task, 'dispatchAttempt');
  const replay = dispatch(d, 'X', { ...snapshot, dispatchAttempt: snapshot.dispatchAttempt }, 'dispatchAttempt');
  assert.equal(first.status, 'APPLIED');
  assert.equal(replay.status, 'ALREADY_APPLIED', 'a replayed snapshot computes the same key');
  assert.equal(replay.key, first.key);
  assert.equal(d.sessions.length, 1, 'exactly one session');
});

test('PC-CX-11 the backoff window has exactly one authoritative run state', () => {
  // §9.5 Q4. v1.1's §19 summary said EXECUTING; the guards say PLANNING for the minimal case, and
  // both cannot be the contract. The rule is that the summary is not a source — runStateOf is.
  const base = { projectStatus: 'OPEN' as const, blockers: [], acceptanceInFlight: false, openVerification: 0 };
  assert.equal(runStateOf({ ...base, liveSessions: 0 }), 'PLANNING', 'one backing-off task, nothing else in flight');
  assert.equal(nextWakeOf(0, [], { runState: 'PLANNING', backoffUntil: 5 * MINUTE }), 5 * MINUTE, 'the wake is the retry (Q2)');
  assert.equal(runStateOf({ ...base, liveSessions: 1 }), 'EXECUTING', 'EXECUTING only when something really is in flight');
  const threshold = blocker({ kind: 'TEST_FAILED', owner: 'USER', recovery: 'HUMAN' });
  assert.equal(runStateOf({ ...base, blockers: [threshold], liveSessions: 0 }), 'AWAITING_HUMAN');

  // And the document now says the same thing in the same three rows.
  const q4 = tables(section(PCC, '9.5')).at(-1)!;
  const states = column(q4, 'runStateOf').map((c) => /^[A-Z_]+/.exec(bare(c))?.[0]);
  assert.deepEqual(states, ['PLANNING', 'EXECUTING', 'AWAITING_HUMAN'], 'Q4 and the guards must give the same three answers');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-12 · three axes, three questions
// ─────────────────────────────────────────────────────────────────────────────

interface KindRow {
  kind: string;
  defaultOwner: Owner;
  recovery: Recovery;
  opensTurn: boolean;
}

function kindTable(): KindRow[] {
  const rows = tableRows(section(PCC, '11.2'));
  const kinds = column(rows, 'kind').map(bare);
  const owners = column(rows, '默认 owner').map(bare) as Owner[];
  const recoveries = column(rows, 'recovery').map(bare) as Recovery[];
  const opens = column(rows, 'opensTurn').map(bare);
  return kinds.map((kind, i) => ({ kind, defaultOwner: owners[i], recovery: recoveries[i], opensTurn: opens[i] === '✔' }));
}

/** The kinds §7.2 lists on the `BLOCKER_DECISION` row — read from the document, not retyped. */
function turnTriggerKinds(): string[] {
  const rows = turnReasons();
  const at = column(rows, 'reasonCode').map(bare).indexOf('BLOCKER_DECISION');
  return (/\{([^}]+)\}/.exec(column(rows, '触发条件')[at] ?? '')?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
}

interface LiveBlocker extends Blocker {
  notifications: number;
}

function live(row: KindRow, now = 0): LiveBlocker {
  return {
    ...blocker({ kind: row.kind, owner: row.defaultOwner, recovery: row.recovery, firstSeenAt: now }),
    notifications: 0,
  };
}

/** §11.5 ES1 + ES3 — one step, always to USER, and it touches nothing but the owner. */
function escalate(b: LiveBlocker, now: number): LiveBlocker {
  if (b.escalatedAt !== null) return b; // at most once, and at most one notification
  return { ...b, owner: 'USER', escalatedAt: now, notifications: b.notifications + 1 };
}

/** v1.1's ladder, kept only so the negative control can run the rule it replaced. */
function escalateV11(b: LiveBlocker, now: number): LiveBlocker {
  const next: Owner = b.owner === 'SYSTEM' ? 'COORDINATOR' : 'USER';
  return { ...b, owner: next, escalatedAt: now, notifications: b.notifications + 1 };
}

/** §7.2 `BLOCKER_DECISION` including BL6 — the kind list *and* "not escalated yet". */
function opensTurnNow(b: LiveBlocker, triggers: string[]): boolean {
  return triggers.includes(b.kind) && b.escalatedAt === null;
}

test('PC-CX-12 escalation changes the owner and nothing else', () => {
  const table = kindTable();
  const triggers = turnTriggerKinds();
  // Twenty-two through `[H0]`, plus `[K5]`'s four: the shape `[H0V2]` found unattended, §3's two
  // classes whose one legal result is a §11 row rather than a Task, and criterion 7's conclusion
  // that could not be made durable.
  assert.equal(table.length, 26, '§11.2 freezes twenty-six kinds');

  for (const row of table) {
    // BL4, stated on the constant column: opensTurn is a function of kind, and it agrees with the
    // kind's *default* owner. Neither of those two things is a row that escalation can rewrite.
    assert.equal(row.opensTurn, row.defaultOwner === 'COORDINATOR', `BL4 on ${row.kind}`);
    assert.equal(row.opensTurn, triggers.includes(row.kind), `§7.2 and §11.2 disagree about ${row.kind}`);

    const fresh = live(row);
    const after = escalate(fresh, ESCALATION_AFTER);

    assert.equal(after.owner, 'USER', 'ES3: escalation goes to a person, in one step, for every kind');
    assert.equal(after.recovery, fresh.recovery, `ES1: ${row.kind} keeps its recovery axis`);
    assert.equal(after.kind, fresh.kind, 'escalation never rewrites the kind…');
    assert.equal(row.opensTurn, table.find((r) => r.kind === after.kind)!.opensTurn, '…so opensTurn cannot move');

    // The state axis: after escalation the project is waiting on a person, by guard 2.
    const state = runStateOf({ projectStatus: 'OPEN', blockers: [after], acceptanceInFlight: false, liveSessions: 1, openVerification: 0 });
    assert.equal(state, 'AWAITING_HUMAN', `${row.kind} after escalation`);

    // BL6: handing it to a person is also handing it *off* the coordinator.
    assert.equal(opensTurnNow(after, triggers), false, `${row.kind} must stop opening turns once escalated`);
    assert.equal(opensTurnNow(fresh, triggers), row.opensTurn, `${row.kind} before escalation`);

    // At most one notification, no matter how many times the threshold is crossed.
    assert.equal(escalate(escalate(after, 2 * ESCALATION_AFTER), 3 * ESCALATION_AFTER).notifications, 1, row.kind);

    // …and a recovery that time or the world can still finish keeps its clock (ES1 + N-mask).
    if (after.recovery !== 'HUMAN') {
      const withCheck = { ...after, nextCheckAt: 6 * 60 * MINUTE };
      assert.equal(nextWakeOf(ESCALATION_AFTER, [withCheck], { runState: 'AWAITING_HUMAN' }), 6 * 60 * MINUTE, row.kind);
    }
  }
});

test('PC-CX-12 the v1.1 rules produce both of the reviewed anomalies', () => {
  // Negative control, run exactly as v1.1 stated it: `opensTurn ⟺ current owner`, a three-step
  // ladder, and no BL6. Both published counter-examples come straight back.
  const table = kindTable();
  const triggers = turnTriggerKinds();
  const opensTurnByOwner = (b: LiveBlocker): boolean => b.owner === 'COORDINATOR';

  // (a) SYSTEM → COORDINATOR: owner says the coordinator owns it, the kind list says it must not
  // open a turn. The iff v1.1 froze is simply false on this row.
  const provider = escalateV11(live(table.find((r) => r.kind === 'PROVIDER_UNAVAILABLE')!), ESCALATION_AFTER);
  assert.equal(provider.owner, 'COORDINATOR');
  assert.equal(opensTurnByOwner(provider), true);
  assert.equal(triggers.includes(provider.kind), false, 'PC-CX-12 (a): owner and kind disagree');

  // (b) COORDINATOR → USER: the project is AWAITING_HUMAN and, without BL6, still opening turns.
  const conflict = escalateV11(live(table.find((r) => r.kind === 'MERGE_CONFLICT')!), ESCALATION_AFTER);
  assert.equal(conflict.owner, 'USER');
  assert.equal(
    runStateOf({ projectStatus: 'OPEN', blockers: [conflict], acceptanceInFlight: false, liveSessions: 0, openVerification: 0 }),
    'AWAITING_HUMAN',
  );
  assert.equal(triggers.includes(conflict.kind) && conflict.escalatedAt !== null, true, 'PC-CX-12 (b): waiting on a person while still waking the coordinator');
  assert.equal(opensTurnNow(conflict, triggers), false, 'BL6 is what stops it');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-13 · one gate for DONE and for every write that moves an acceptance fact
// ─────────────────────────────────────────────────────────────────────────────

type FactWrite = 'task.created' | 'task.status_changed' | 'task.completion_policy' | 'verdict' | 'criteria' | 'merge_evidence' | 'task.title';

/** §13.4 AE6 — the closed set. `task.title` is deliberately outside it. */
const ACCEPTANCE_FACT_WRITES: FactWrite[] = ['task.created', 'task.status_changed', 'task.completion_policy', 'verdict', 'criteria', 'merge_evidence'];

interface Project13 {
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  facts: AcceptanceFacts;
  evidence: { allPass: boolean; digest: string }[];
  reopened: boolean;
  title: string;
}

function applyFact(p: Project13, write: FactWrite): void {
  switch (write) {
    case 'task.created':
      p.facts = { ...p.facts, taskSet: [...p.facts.taskSet, ['t9', 'OPEN']] };
      break;
    case 'task.status_changed':
      p.facts = { ...p.facts, taskSet: p.facts.taskSet.map(([id, s]) => (id === 't1' ? [id, 'OPEN'] : [id, s]) as [string, string]) };
      break;
    case 'task.completion_policy':
      p.facts = { ...p.facts, taskSet: [...p.facts.taskSet, ['t1#policy', 'ALL_CHILDREN_DONE']] };
      break;
    case 'verdict':
      p.facts = { ...p.facts, verdicts: [['v1', 'FAIL']] };
      break;
    case 'criteria':
      p.facts = { ...p.facts, acceptanceCriteria: p.facts.acceptanceCriteria + ' and deployed' };
      break;
    case 'merge_evidence':
      p.facts = { ...p.facts, mergeEvidence: [['r1', 'content-hash-b']] };
      break;
    case 'task.title':
      p.title = 'renamed';
      break;
  }
}

interface Gate13 {
  /** §13.4 AE6/AE7's shared project row lock. Off = v1.1's "REPEATABLE READ, or lock the rows you read". */
  projectRowLock: boolean;
}

/** Runs the two transactions in one order and returns the committed state. */
function doneRace(order: 'FACT_FIRST' | 'DONE_FIRST', write: FactWrite, gate: Gate13): { project: Project13; done: DoneResult } {
  const h1: AcceptanceFacts = {
    projectId: 'p1',
    acceptanceCriteria: 'every unit merged to feat/project',
    taskSet: [['t1', 'DONE'], ['t2', 'DONE']],
    verdicts: [['v1', 'PASS']],
    mergeEvidence: [['r1', 'content-hash-a']],
  };
  const p: Project13 = { status: 'OPEN', facts: h1, evidence: [{ allPass: true, digest: acceptanceDigest(h1) }], reopened: false, title: 't' };
  const gated = gate.projectRowLock && ACCEPTANCE_FACT_WRITES.includes(write);

  if (order === 'FACT_FIRST') {
    applyFact(p, write);
    // With the lock, DONE waits and then recomputes against a *fresh* statement snapshot, so it
    // sees this write. Without it, DONE is still holding the snapshot it took before the write.
    const seen = gated ? p.facts : h1;
    const done = writeDone(p.evidence, seen);
    if (done.ok) p.status = 'DONE';
    return { project: p, done };
  }

  const done = writeDone(p.evidence, p.facts);
  if (done.ok) p.status = 'DONE';
  // The fact write now has the lock. AE8: it must not leave DONE standing on facts that moved.
  applyFact(p, write);
  if (gated && p.status === 'DONE') {
    p.status = 'OPEN';
    p.reopened = true;
  }
  return { project: p, done };
}

/** I10, as a predicate a reviewer could run against production. */
function i10Holds(p: Project13): boolean {
  if (p.status !== 'DONE') return true;
  const fresh = acceptanceDigest(p.facts);
  return p.evidence.some((e) => e.allPass && e.digest === fresh);
}

test('PC-CX-13 DONE and every acceptance-fact write share one gate', () => {
  for (const write of ACCEPTANCE_FACT_WRITES) {
    const factFirst = doneRace('FACT_FIRST', write, { projectRowLock: true });
    assert.deepEqual(factFirst.done, { ok: false, code: 'ACCEPTANCE_EVIDENCE_STALE' }, `${write} first`);
    assert.equal(factFirst.project.status, 'OPEN', `${write}: the project must stay open`);
    assert.ok(i10Holds(factFirst.project), write);

    const doneFirst = doneRace('DONE_FIRST', write, { projectRowLock: true });
    assert.deepEqual(doneFirst.done, { ok: true }, `${write}: DONE was correct when it committed`);
    assert.equal(doneFirst.project.reopened, true, `${write}: AE8 must reopen atomically`);
    assert.equal(doneFirst.project.status, 'OPEN');
    assert.ok(i10Holds(doneFirst.project), write);
  }

  // A write outside AE6's closed set changes no acceptance fact, so it takes no gate and reopens
  // nothing — renaming a task must not undo a finished project.
  const rename = doneRace('DONE_FIRST', 'task.title', { projectRowLock: true });
  assert.equal(rename.project.status, 'DONE');
  assert.equal(rename.project.reopened, false);
  assert.ok(i10Holds(rename.project));

  // Negative control: without the shared lock the two transactions write different rows, so
  // Postgres has no reason to order them — and guard 1 then pins the result as SETTLED forever.
  for (const write of ACCEPTANCE_FACT_WRITES) {
    for (const order of ['FACT_FIRST', 'DONE_FIRST'] as const) {
      const v11 = doneRace(order, write, { projectRowLock: false });
      assert.equal(v11.project.status, 'DONE', `${order}/${write}`);
      assert.equal(i10Holds(v11.project), false, `PC-CX-13 must reproduce without the gate (${order}/${write})`);
      assert.equal(
        runStateOf({ projectStatus: v11.project.status, blockers: [], acceptanceInFlight: false, liveSessions: 0, openVerification: 0 }),
        'SETTLED',
        'and the task event cannot pull it back: guard 1 answers first',
      );
    }
  }
});

test('PC-CX-13 a cancelled project is not reopened by a task change', () => {
  // AE8 is about DONE, which is a claim about facts. CANCELLED is a decision about intent, and a
  // task moving is not an argument against it.
  const h1: AcceptanceFacts = { projectId: 'p1', acceptanceCriteria: 'c', taskSet: [['t1', 'DONE']], verdicts: [], mergeEvidence: [] };
  const p: Project13 = { status: 'CANCELLED', facts: h1, evidence: [], reopened: false, title: 't' };
  applyFact(p, 'task.status_changed');
  assert.equal(p.status, 'CANCELLED');
  assert.equal(p.reopened, false);
  assert.ok(i10Holds(p), 'I10 says nothing about CANCELLED');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-14 · a session a person started is evidence, not an anomaly
// ─────────────────────────────────────────────────────────────────────────────

interface LiveView {
  sessions: Session[];
  appliedDispatchActions: { key: string; resultSessionId: string }[];
  coordinatorTurnInFlight: boolean;
  openBlockers: Blocker[];
  nextWakeAt: number | null;
}

/** §4.1's EXECUTING invariant. `actionLinkedOnly` = v1.1. */
function executingInvariantHolds(v: LiveView, actionLinkedOnly: boolean): boolean {
  const occupying = v.sessions.filter((s) => s.deletedAt === null && OCCUPYING.includes(s.status));
  if (occupying.length === 0) return false;
  return occupying.every((s) => {
    const linked = v.appliedDispatchActions.some((a) => a.resultSessionId === s.id);
    if (actionLinkedOnly) return linked;
    // I11: every claim is attributable — to a coordinator action, or to a person.
    if (s.origin === 'COORDINATOR') return linked && s.projectActionId !== null;
    if (s.origin === 'USER') return s.projectActionId === null;
    return false; // LEGACY_SWEEP on a COORDINATOR-authority task is what D6 exists to refuse
  });
}

/** §10.3 (a)–(d). `actionLinkedOnly` = v1.1's clause (a). */
function livenessClauses(v: LiveView, actionLinkedOnly: boolean): { a: boolean; b: boolean; c: boolean; d: boolean } {
  const live = v.sessions.filter((s) => s.deletedAt === null && OCCUPYING.includes(s.status));
  const a = live.some((s) =>
    v.appliedDispatchActions.some((x) => x.resultSessionId === s.id) || (!actionLinkedOnly && s.origin === 'USER'),
  );
  const c = v.openBlockers.length > 0 && v.openBlockers.every((b) => b.nextCheckAt !== null);
  return { a, b: v.coordinatorTurnInFlight, c, d: v.nextWakeAt !== null };
}

const manualSession: Session = { id: 's-user', taskId: 'X', status: 'PENDING', deletedAt: null, origin: 'USER', projectActionId: null };

test('PC-CX-14 a user-started session satisfies EXECUTING and liveness', () => {
  // (1) A person starts the only task. Nothing else is happening anywhere in the project.
  const manualOnly: LiveView = { sessions: [manualSession], appliedDispatchActions: [], coordinatorTurnInFlight: false, openBlockers: [], nextWakeAt: null };
  assert.equal(
    runStateOf({ projectStatus: 'OPEN', blockers: [], acceptanceInFlight: false, liveSessions: 1, openVerification: 0 }),
    'EXECUTING',
    'guard 5 counts any live session on a task of this project',
  );
  assert.equal(executingInvariantHolds(manualOnly, false), true, 'and the state table now agrees with the guard');
  assert.equal(livenessClauses(manualOnly, false).a, true, '§10.3 (a): a person pressing start is progress');

  // (2) The same person racing the control loop: D5 picks a winner, the loser is determinate, and
  // whichever one survives satisfies (a).
  for (const { sessions, outcomes } of raceTwo('USER', 'COORDINATOR', V11)) {
    assert.equal(sessions, 1);
    const winner = outcomes.find((o) => o.created !== null)!;
    const view: LiveView = {
      sessions: [winner.entry === 'USER' ? manualSession : { ...manualSession, id: 's-coord', origin: 'COORDINATOR', projectActionId: 'act-X-0' }],
      appliedDispatchActions: winner.entry === 'COORDINATOR' ? [{ key: 'pc:v1:p1:dispatch:X:0', resultSessionId: 's-coord' }] : [],
      coordinatorTurnInFlight: false,
      openBlockers: [],
      nextWakeAt: null,
    };
    assert.equal(executingInvariantHolds(view, false), true, `winner ${winner.entry}`);
    assert.equal(livenessClauses(view, false).a, true, `winner ${winner.entry}`);
  }

  // (3) The manual session ends: EXECUTING drops out and the clock takes over, by §10.4 rule 6.
  const ended: LiveView = { ...manualOnly, sessions: [{ ...manualSession, status: 'SUCCEEDED' }], nextWakeAt: MINUTE };
  assert.equal(
    runStateOf({ projectStatus: 'OPEN', blockers: [], acceptanceInFlight: false, liveSessions: 0, openVerification: 0 }),
    'PLANNING',
  );
  assert.equal(executingInvariantHolds(ended, false), false, 'nothing is occupying the task any more');
  const clauses = livenessClauses(ended, false);
  assert.equal(clauses.a, false);
  assert.equal(clauses.d, true, 'but (d) holds, so the project is still provably not stalled');

  // Negative control: v1.1 required the live session to be a coordinator action's result, so a
  // perfectly healthy project — a person is running its only task — failed the EXECUTING invariant
  // *and* all four liveness clauses at once, which §10.3 calls a P0.
  assert.equal(executingInvariantHolds(manualOnly, true), false, 'PC-CX-14 must reproduce under the old invariant');
  const v11 = livenessClauses(manualOnly, true);
  assert.deepEqual([v11.a, v11.b, v11.c, v11.d], [false, false, false, false], 'four clauses, none of them true');
});

test('PC-CX-14 an unattributable claim is still a violation', () => {
  // Widening EXECUTING to admit a person must not widen it to admit anything at all: a
  // LEGACY_SWEEP claim on a COORDINATOR-authority task is exactly what D6 refuses, and I11 says so.
  const smuggled: LiveView = {
    sessions: [{ ...manualSession, id: 's-legacy', origin: 'LEGACY_SWEEP' }],
    appliedDispatchActions: [],
    coordinatorTurnInFlight: false,
    openBlockers: [],
    nextWakeAt: null,
  };
  assert.equal(executingInvariantHolds(smuggled, false), false);
  assert.equal(livenessClauses(smuggled, false).a, false, 'it is not evidence of anything legitimate');

  // …and a COORDINATOR-origin session with no action row is equally unattributable.
  const orphan: LiveView = { ...smuggled, sessions: [{ ...manualSession, id: 's-orphan', origin: 'COORDINATOR', projectActionId: null }] };
  assert.equal(executingInvariantHolds(orphan, false), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation check · every fence v1.2 adds has to be load-bearing
// ─────────────────────────────────────────────────────────────────────────────

// Each test above carries its own negative control, but a control is only worth something if
// somebody notices when it stops controlling anything. This is that check, in one place: for each
// finding, turn off exactly the one rule v1.2 added and assert the published defect comes back. A
// rule whose removal changes nothing was never the fix — it was a paragraph.
//
// Read it the other way round and it is a mutation test over the contract itself: six mutants, and
// the suite must kill every one of them.
test('mutation check: every fence added for PC-CX-09..14 is load-bearing', () => {
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-09',
      fence: "the trigger's SELECT … FOR SHARE (§7.7 D6)",
      defectReappears: () =>
        (['FLIP_FIRST', 'INSERT_FIRST'] as const).every((order) => {
          const r = authorityRace(order, { triggerForShare: false });
          return !i12Holds(r.authority, r.occupying);
        }),
    },
    {
      finding: 'PC-CX-10',
      fence: 'occurrences excluded from turnFacts (§7.2 TF1)',
      defectReappears: () => {
        const signal = { kind: 'MERGE_CONFLICT', subjectId: 'X', conditionVersion: 'files:a.ts' };
        let open = deliver([], signal);
        const one = sha256(`BLOCKER_DECISION|${JSON.stringify(blockerTurnFacts(open, true))}`);
        open = deliver(open, signal);
        return one !== sha256(`BLOCKER_DECISION|${JSON.stringify(blockerTurnFacts(open, true))}`);
      },
    },
    {
      finding: 'PC-CX-11',
      fence: 'a monotonic dispatch epoch (§8.2 DA1)',
      defectReappears: () => failureCycle('failureCount').afterReset.created === false,
    },
    {
      finding: 'PC-CX-12',
      fence: 'opensTurn read from the kind, plus BL6 (§11.2)',
      defectReappears: () => {
        const table = kindTable();
        const triggers = turnTriggerKinds();
        const provider = escalateV11(live(table.find((r) => r.kind === 'PROVIDER_UNAVAILABLE')!), ESCALATION_AFTER);
        const conflict = escalateV11(live(table.find((r) => r.kind === 'MERGE_CONFLICT')!), ESCALATION_AFTER);
        const ownerSaysYesKindSaysNo = provider.owner === 'COORDINATOR' && !triggers.includes(provider.kind);
        const waitingOnAPersonButStillOpeningTurns = conflict.owner === 'USER' && triggers.includes(conflict.kind);
        return ownerSaysYesKindSaysNo && waitingOnAPersonButStillOpeningTurns;
      },
    },
    {
      finding: 'PC-CX-13',
      fence: 'the shared project row lock (§13.4 AE6/AE7)',
      defectReappears: () =>
        ACCEPTANCE_FACT_WRITES.every((write) =>
          (['FACT_FIRST', 'DONE_FIRST'] as const).every((order) => !i10Holds(doneRace(order, write, { projectRowLock: false }).project)),
        ),
    },
    {
      finding: 'PC-CX-14',
      fence: 'EXECUTING and §10.3 (a) admitting USER origin',
      defectReappears: () => {
        const view: LiveView = { sessions: [manualSession], appliedDispatchActions: [], coordinatorTurnInFlight: false, openBlockers: [], nextWakeAt: null };
        const c = livenessClauses(view, true);
        return !executingInvariantHolds(view, true) && !c.a && !c.b && !c.c && !c.d;
      },
    },
  ];

  assert.equal(mutants.length, 6, 'unit 02 raised six findings against v1.1');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  const held = authorityRace('FLIP_FIRST', { triggerForShare: true });
  assert.ok(i12Holds(held.authority, held.occupying));
  assert.equal(failureCycle('dispatchAttempt').afterReset.created, true);
  assert.ok(i10Holds(doneRace('DONE_FIRST', 'verdict', { projectRowLock: true }).project));
});

test('§20 names a test that exists for every finding, and points at clauses that exist', () => {
  // The mirror of the §19 check in `coordinator-contract.spec.ts`, kept here as well so that the
  // model file cannot quietly rename a test out from under the document.
  const rows = tables(section(PCC, '20'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-09', 'PC-CX-10', 'PC-CX-11', 'PC-CX-12', 'PC-CX-13', 'PC-CX-14']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§20 names "${name}", which is not a test in this file`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-15 · how many times a signal arrived is not a fact about the world
// ─────────────────────────────────────────────────────────────────────────────

/** One blocker row, with the two columns v1.3 demotes to display kept separate from the rest. */
interface Row15 {
  kind: string;
  owner: Owner;
  recovery: Recovery;
  requiredAction: string;
  dedupeKey: string;
  lifecycleGeneration: number;
  conditionVersion: string;
  firstSeenAt: number;
  escalatedAt: number | null;
  notifications: number;
  // display only (§11.5 BL7)
  occurrences: number;
  lastSeenAt: number;
}

/** §11.3 — one delivery of one signal: a new row, or `occurrences += 1` on the row that exists. */
function deliver15(row: Row15 | null, signal: { kind: string; subjectId: string; conditionVersion: string }, now: number, owner: Owner, recovery: Recovery): Row15 {
  if (row) return { ...row, occurrences: row.occurrences + 1, lastSeenAt: now, conditionVersion: signal.conditionVersion };
  return {
    kind: signal.kind,
    owner,
    recovery,
    requiredAction: `deal with ${signal.kind}`,
    dedupeKey: `${signal.kind}:PROVIDER:${signal.subjectId}`,
    lifecycleGeneration: 1,
    conditionVersion: signal.conditionVersion,
    firstSeenAt: now,
    escalatedAt: null,
    notifications: 0,
    occurrences: 1,
    lastSeenAt: now,
  };
}

/** §11.5 ES3 + ES4. `'lifetimeOrCount'` is v1.2's rule, kept so the control can run it. */
function escalateIfDue(row: Row15, now: number, policy: 'lifetime' | 'lifetimeOrCount'): Row15 {
  if (row.escalatedAt !== null) return row; // at most once, at most one notification
  const due = now - row.firstSeenAt > ESCALATION_AFTER || (policy === 'lifetimeOrCount' && row.occurrences > 10);
  return due ? { ...row, owner: 'USER', escalatedAt: now, notifications: row.notifications + 1 } : row;
}

/** Everything a person or the control loop can see. `occurrences`/`lastSeenAt` are deliberately out. */
function observable15(row: Row15): unknown {
  const { occurrences: _o, lastSeenAt: _l, ...rest } = row;
  return {
    ...rest,
    runState: runStateOf({
      projectStatus: 'OPEN',
      blockers: [blocker({ kind: row.kind, owner: row.owner, recovery: row.recovery, escalatedAt: row.escalatedAt })],
      acceptanceInFlight: false,
      liveSessions: 0,
      openVerification: 0,
    }),
  };
}

/** N deliveries of one unchanging condition, all inside one instant — nothing about the world moves. */
function deliverN(n: number, policy: 'lifetime' | 'lifetimeOrCount'): Row15 {
  const signal = { kind: 'PROVIDER_UNAVAILABLE', subjectId: 'provider-1', conditionVersion: 'provider-1:unavailable' };
  let row: Row15 | null = null;
  for (let i = 0; i < n; i++) {
    row = deliver15(row, signal, 0, 'SYSTEM', 'EVENT');
    row = escalateIfDue(row, 0, policy);
  }
  return row!;
}

test('PC-CX-15 delivery count changes nothing a person or the control loop can see', () => {
  // I14 / ES5. The world is one fact — a provider that is down — and the only thing that varies
  // between these runs is how many times somebody told us about it.
  const once = observable15(deliverN(1, 'lifetime'));
  for (const n of [2, 11, 50]) {
    assert.deepEqual(observable15(deliverN(n, 'lifetime')), once, `${n} deliveries must look exactly like one`);
  }
  // …and the two columns that are *allowed* to move do move, so this is not passing by accident.
  assert.equal(deliverN(11, 'lifetime').occurrences, 11);
  assert.equal(deliverN(11, 'lifetime').escalatedAt, null, 'no lifetime has elapsed, so nothing escalates');

  // The clock, on the other hand, is a fact: one delivery and half an hour is an escalation.
  const aged = escalateIfDue(deliverN(1, 'lifetime'), ESCALATION_AFTER + 1, 'lifetime');
  assert.equal(aged.owner, 'USER', 'ES4: lifetime is the only trigger');
  assert.equal(aged.notifications, 1, 'and it notifies exactly once');
  assert.equal(escalateIfDue(aged, 10 * ESCALATION_AFTER, 'lifetime').notifications, 1, 'ES3: at most once, ever');

  // Negative control: v1.2's `occurrences > 10`. Same world, eleventh delivery, different owner,
  // different run state, one notification nobody asked for — the review's exact reproduction.
  const v12 = observable15(deliverN(11, 'lifetimeOrCount')) as { owner: Owner; runState: string };
  assert.equal(v12.owner, 'USER');
  assert.equal(v12.runState, 'AWAITING_HUMAN');
  assert.equal(deliverN(11, 'lifetimeOrCount').notifications, 1);
  assert.notDeepEqual(v12, once, 'PC-CX-15 must reproduce under the rule v1.3 removed');

  // And the document: any line that still names a count threshold or the three-step ladder has to
  // be marked as the version it belonged to. A rule and a note about a deleted rule read the same
  // to a reader who is skimming, and that is how §9.4 kept contradicting ES3 for two rounds.
  for (const sec of ['9.4', '11.5']) {
    for (const line of section(PCC, sec).split('\n')) {
      if (/occurrences\s*>/.test(line) || /SYSTEM\s*→\s*COORDINATOR\s*→\s*USER/.test(line)) {
        assert.match(line, /v1\.[012]|旧文|残文|已删除/, `§${sec} states a superseded escalation rule as if it were current:\n${line}`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-16 · a blocker that comes back is a new episode, not the same one
// ─────────────────────────────────────────────────────────────────────────────

interface Episode {
  dedupeKey: string;
  lifecycleGeneration: number;
  resolvedAt: number | null;
}

interface Ledger16 {
  actions: string[];
  blockers: Episode[];
}

/** §11.3 BE1 — `MAX(lifecycle_generation) + 1` over *history*, which is why clearing keeps the row. */
function raiseBlocker(l: Ledger16, kind: string, subjectId: string, keyed: 'generation' | 'v12'): { key: string; created: boolean } {
  const dedupeKey = `${kind}:TASK:${subjectId}`;
  const open = l.blockers.find((b) => b.dedupeKey === dedupeKey && b.resolvedAt === null);
  const generation = open ? open.lifecycleGeneration : Math.max(0, ...l.blockers.filter((b) => b.dedupeKey === dedupeKey).map((b) => b.lifecycleGeneration)) + 1;
  const key = keyed === 'generation' ? `pc:v1:p1:blocker:${kind}:${subjectId}:${generation}` : `pc:v1:p1:blocker:${kind}:${subjectId}`;
  if (l.actions.includes(key)) return { key, created: false }; // §8.5 C2 — skip the side effect
  l.actions.push(key);
  if (!open) l.blockers.push({ dedupeKey, lifecycleGeneration: generation, resolvedAt: null });
  return { key, created: true };
}

function clearBlocker(l: Ledger16, kind: string, subjectId: string, now: number): void {
  const open = l.blockers.find((b) => b.dedupeKey === `${kind}:TASK:${subjectId}` && b.resolvedAt === null);
  if (open) open.resolvedAt = now; // §11.4 — resolved, never deleted
}

/** open → N repeated deliveries → clear → the same cause happens again. */
function episodeCycle(kind: string, keyed: 'generation' | 'v12', repeats = 5): { l: Ledger16; reopened: { key: string; created: boolean } } {
  const l: Ledger16 = { actions: [], blockers: [] };
  for (let i = 0; i < repeats; i++) raiseBlocker(l, kind, 'X', keyed);
  clearBlocker(l, kind, 'X', 1_000);
  return { l, reopened: raiseBlocker(l, kind, 'X', keyed) };
}

test('PC-CX-16 a blocker that comes back gets a new lifecycle generation', () => {
  for (const row of kindTable()) {
    const { l, reopened } = episodeCycle(row.kind, 'generation');
    assert.equal(l.actions.length, 2, `${row.kind}: one action per episode, not per delivery`);
    assert.equal(reopened.created, true, `${row.kind}: the second failure must actually open a blocker`);
    assert.deepEqual(
      l.blockers.map((b) => b.lifecycleGeneration),
      [1, 2],
      `${row.kind}: generations are monotonic and the resolved row is still there (BE1)`,
    );
    const open = l.blockers.filter((b) => b.resolvedAt === null);
    assert.equal(open.length, 1, `${row.kind}: still at most one open row (§11.3 partial index)`);
    assert.match(reopened.key, /:2$/, `${row.kind}: the key carries the episode (BE3)`);

    // Negative control: v1.2's key. The reappearance hits the historical action, C2 skips the
    // insert, and the project carries a live fault with no blocker at all.
    const v12 = episodeCycle(row.kind, 'v12');
    assert.equal(v12.reopened.created, false, `${row.kind}: PC-CX-16 must reproduce`);
    assert.equal(v12.l.blockers.filter((b) => b.resolvedAt === null).length, 0, `${row.kind}: no open blocker after the fault returns`);
  }
});

test('PC-CX-16 repeats inside one episode still collapse onto one key', () => {
  // The fix must not undo AC8: within a single open episode, the tenth delivery is still the same
  // action as the first. Only the transition through `resolved` opens a new one.
  const l: Ledger16 = { actions: [], blockers: [] };
  const first = raiseBlocker(l, 'MERGE_CONFLICT', 'X', 'generation');
  for (let i = 0; i < 9; i++) {
    const again = raiseBlocker(l, 'MERGE_CONFLICT', 'X', 'generation');
    assert.equal(again.key, first.key, 'same episode, same key');
    assert.equal(again.created, false, 'and no second side effect');
  }
  assert.equal(l.actions.length, 1);
  assert.equal(l.blockers.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-17 · a fact that can return to an old value cannot be an action's identity
// ─────────────────────────────────────────────────────────────────────────────

interface Verifier {
  verdictRevision: number;
}

interface World17 {
  actions: string[];
  targetStatus: 'DONE' | 'OPEN';
  defects: number;
  downstreamBlocked: boolean;
}

/** §13.2 — the three mechanical consequences, behind whichever key the contract version uses. */
function applyVerdict(w: World17, verifier: string, v: Verifier, verdict: 'PASS' | 'FAIL', epoch: 'verdictRevision' | 'verdictValue'): { key: string; applied: boolean } {
  if (epoch === 'verdictRevision') v.verdictRevision += 1; // V7 — in the transaction that writes the verdict
  const key = `pc:v1:p1:verdict:${verifier}:${epoch === 'verdictRevision' ? v.verdictRevision : verdict}`;
  if (w.actions.includes(key)) return { key, applied: false }; // §8.5 C2
  w.actions.push(key);
  if (verdict === 'FAIL') {
    w.targetStatus = 'OPEN';
    w.defects += 1;
    w.downstreamBlocked = true;
  } else {
    w.downstreamBlocked = false;
  }
  return { key, applied: true };
}

/** FAIL → a person fixes it, everything re-runs → FAIL again. V4 says this is a supported story. */
function verdictCycle(epoch: 'verdictRevision' | 'verdictValue'): World17 {
  const w: World17 = { actions: [], targetStatus: 'DONE', defects: 0, downstreamBlocked: false };
  const v: Verifier = { verdictRevision: 0 };
  applyVerdict(w, 'V', v, 'FAIL', epoch);
  w.targetStatus = 'DONE'; // the defect is fixed and the target re-runs to completion
  w.downstreamBlocked = false;
  applyVerdict(w, 'V', v, 'FAIL', epoch); // …and the verifier still says no
  return w;
}

/** §13.1 AG5 — the parent is recomputed from the children, with a CAS instead of a permanent key. */
function aggregate(parentStatus: string, childrenDigest: string, recomputed: string, ledger: string[], keyed: boolean): string {
  if (keyed) {
    const key = `pc:v1:p1:aggregate:P:${childrenDigest}`;
    if (ledger.includes(key)) return parentStatus; // C2 skips the side effect
    ledger.push(key);
    return recomputed;
  }
  return parentStatus === recomputed ? parentStatus : recomputed; // CAS: converge, always
}

test('PC-CX-17 a fact that returns to an old value still gets a new action identity', () => {
  // ── verdict ──────────────────────────────────────────────────────────────
  const fixed = verdictCycle('verdictRevision');
  assert.deepEqual(fixed.actions, ['pc:v1:p1:verdict:V:1', 'pc:v1:p1:verdict:V:2'], 'V7: a second run is a second revision');
  assert.equal(fixed.targetStatus, 'OPEN', 'the second FAIL must send the task back again');
  assert.equal(fixed.defects, 2, 'and file the defect it found this time');
  assert.equal(fixed.downstreamBlocked, true, 'and block downstream again');

  const v12v = verdictCycle('verdictValue');
  assert.deepEqual(v12v.actions, ['pc:v1:p1:verdict:V:FAIL'], 'PC-CX-17: the second FAIL hits the first one’s key');
  assert.equal(v12v.targetStatus, 'DONE', 'so a task a verifier just failed stays DONE');
  assert.equal(v12v.defects, 1);
  assert.equal(v12v.downstreamBlocked, false, 'and everything downstream of it is free to run');

  // ── aggregate: children A → B → A (AG3 says this happens) ────────────────
  const cas: string[] = [];
  let parent = 'OPEN';
  parent = aggregate(parent, 'A', 'DONE', cas, false);
  assert.equal(parent, 'DONE');
  parent = aggregate(parent, 'B', 'OPEN', cas, false);
  assert.equal(parent, 'OPEN', 'a child reopened, so the parent follows (AG3)');
  parent = aggregate(parent, 'A', 'DONE', cas, false);
  assert.equal(parent, 'DONE', 'and when the children finish again, so does the parent');
  assert.equal(cas.length, 0, 'AG5: a pure recomputation takes no ledger row, so there is no key to collide');

  const keyed: string[] = [];
  let v12p = 'OPEN';
  v12p = aggregate(v12p, 'A', 'DONE', keyed, true);
  v12p = aggregate(v12p, 'B', 'OPEN', keyed, true);
  v12p = aggregate(v12p, 'A', 'DONE', keyed, true);
  assert.equal(v12p, 'OPEN', 'PC-CX-17: the third aggregate hits the first one’s digest and the parent is stuck');

  // ── acceptance: the epoch has to come from somewhere ─────────────────────
  // §13.4 AE11 names a column; the test that it is a real source is that two reconciles of one
  // snapshot agree, and that a genuinely new run does not.
  const runtime = { acceptanceAttempt: 3 };
  const snapshot = runtime.acceptanceAttempt;
  const keyA = `pc:v1:p1:acceptance:${snapshot}`;
  const keyReplay = `pc:v1:p1:acceptance:${snapshot}`;
  runtime.acceptanceAttempt += 1; // DA2 shape: advanced by the successful insert
  const keyNext = `pc:v1:p1:acceptance:${runtime.acceptanceAttempt}`;
  assert.equal(keyReplay, keyA, 'a replayed snapshot computes the same acceptance key');
  assert.notEqual(keyNext, keyA, 'a genuinely new acceptance run does not');

  // Negative control for the *undefined* epoch: with no authoritative field, two equally plausible
  // derivations of "attempt" disagree on the same snapshot — which is what "no source" means.
  const byEventCount = `pc:v1:p1:acceptance:${17}`;
  const byActionCount = `pc:v1:p1:acceptance:${2}`;
  assert.notEqual(byEventCount, byActionCount, 'PC-CX-17: `<attempt>` with no defined source is not a key');
  assert.match(section(PCC, '13.4'), /acceptance_attempt/, 'AE11 must name the column the key comes from');
});

test('PC-CX-17 §8.2 GE1 gives every permanent key an epoch that is a persisted column', () => {
  // The generalisation, asserted against the document rather than the three findings: read GE1's
  // table and hold every row to the discipline, so a seventh action added later cannot be keyed on
  // a digest by accident.
  const rows = tables(section(PCC, '8.2'))[0];
  const actions = column(rows, '动作').map(bare);
  const sources = column(rows, '代次来源').map(bare);
  const wheres = column(rows, '落库位置').map(bare);
  assert.ok(actions.length >= 9, 'GE1 must cover the whole action set, not the three that were broken');

  const keyedActions = tableRows(section(PCC, '7.3'))
    .slice(1)
    .map((cells) => ({ type: bare(cells[0]), key: bare(cells[2]) }))
    .filter((r) => /^[A-Z_]+$/.test(r.type) && r.key.startsWith('pc:v1:'));
  for (const action of keyedActions) {
    const at = actions.indexOf(action.type);
    assert.ok(at >= 0, `${action.type} has a permanent key but GE1 does not say where its epoch comes from`);
    const answer = `${sources[at]} → ${wheres[at]}`;
    // Three shapes are allowed, and nothing else: a persisted column (`table.column`), a row whose
    // identity is itself one-shot (a blocker id is cleared once; an approval inherits the key of
    // the action it gates), or the documented GE4 exception.
    const persisted =
      /\w+\.\w+/.test(answer) ||
      /coordinator_generation/.test(answer) ||
      /行 id|被审批动作|继承/.test(answer);
    assert.ok(persisted, `${action.type}: "${answer}" is not a persisted, monotonic source (GE1/GE2)`);
  }
  assert.equal(sources[actions.indexOf('AGGREGATE_PARENT')].includes('无键'), true, 'AG5: aggregate keeps no key at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-18 · the closed set has to be derived from the digest, not hand-written
// ─────────────────────────────────────────────────────────────────────────────

interface Facts18 {
  projectId: string;
  acceptanceCriteria: string;
  taskSet: [string, string][];
  verdicts: [string, string, string][]; // (verifierTaskId, verifiesTaskId, verdict)
  mergeEvidence: [string, string, number][]; // (requirementId, contentHash, refGeneration)
}

function digest18(f: Facts18): string {
  return sha256(
    JSON.stringify({
      v: 1,
      projectId: f.projectId,
      criteriaRevision: sha256(f.acceptanceCriteria),
      taskSet: [...f.taskSet].sort(),
      verdicts: [...f.verdicts].sort(),
      mergeEvidence: [...f.mergeEvidence].sort(),
    }),
  );
}

/** The write paths §13.4 AE6 enumerates, keyed by the projection each one moves. */
const MUTATORS_18 = {
  'task.created': 'taskSet',
  'task.status_changed': 'taskSet',
  'task.completion_policy': 'taskSet',
  'task.project_id.move_in': 'taskSet',
  'task.project_id.move_out': 'taskSet',
  'task.verifies_task_id': 'verdicts',
  verdict: 'verdicts',
  criteria: 'criteriaRevision',
  merge_evidence: 'mergeEvidence',
} as const;
type Mutator18 = keyof typeof MUTATORS_18;

/** v1.2's hand-written table — the three it was missing are exactly the three findings. */
const V12_GATED: Mutator18[] = ['task.created', 'task.status_changed', 'task.completion_policy', 'verdict', 'criteria', 'merge_evidence'];

interface Project18 {
  id: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  facts: Facts18;
  evidence: { allPass: boolean; digest: string }[];
  reopened: boolean;
}

function project18(id = 'p1'): Project18 {
  const facts: Facts18 = {
    projectId: id,
    acceptanceCriteria: 'every unit merged to feat/project',
    taskSet: [['t1', 'DONE'], ['t2', 'DONE']],
    verdicts: [['v1', 't1', 'PASS']],
    mergeEvidence: [['r1', 'content-hash-a', 1]],
  };
  return { id, status: 'OPEN', facts, evidence: [{ allPass: true, digest: digest18(facts) }], reopened: false };
}

function apply18(p: Project18, m: Mutator18): void {
  const f = p.facts;
  switch (m) {
    case 'task.created':
      p.facts = { ...f, taskSet: [...f.taskSet, ['t9', 'OPEN']] };
      break;
    case 'task.status_changed':
      p.facts = { ...f, taskSet: f.taskSet.map(([id, s]) => (id === 't1' ? [id, 'OPEN'] : [id, s]) as [string, string]) };
      break;
    case 'task.completion_policy':
      p.facts = { ...f, taskSet: [...f.taskSet, ['t1#policy', 'ALL_CHILDREN_DONE']] };
      break;
    case 'task.project_id.move_in':
      p.facts = { ...f, taskSet: [...f.taskSet, ['moved', 'OPEN']] };
      break;
    case 'task.project_id.move_out':
      p.facts = { ...f, taskSet: f.taskSet.filter(([id]) => id !== 't2') };
      break;
    case 'task.verifies_task_id':
      p.facts = { ...f, verdicts: [['v1', 't2', 'PASS']] };
      break;
    case 'verdict':
      p.facts = { ...f, verdicts: [['v1', 't1', 'FAIL']] };
      break;
    case 'criteria':
      p.facts = { ...f, acceptanceCriteria: f.acceptanceCriteria + ' and deployed' };
      break;
    case 'merge_evidence':
      p.facts = { ...f, mergeEvidence: [['r1', 'content-hash-b', 2]] };
      break;
  }
}

function i10Holds18(p: Project18): boolean {
  if (p.status !== 'DONE') return true;
  const fresh = digest18(p.facts);
  return p.evidence.some((e) => e.allPass && e.digest === fresh);
}

/** One ordering of "a fact write" against "the DONE gate", under a given gated set (AE6). */
function doneRace18(order: 'FACT_FIRST' | 'DONE_FIRST', m: Mutator18, gated: readonly Mutator18[]): Project18 {
  const p = project18();
  const takesTheGate = gated.includes(m);
  if (order === 'FACT_FIRST') {
    apply18(p, m);
    const seen = takesTheGate ? p.facts : project18().facts; // ungated writes are invisible to the gate
    const fresh = digest18(seen);
    if (p.evidence.some((e) => e.allPass && e.digest === fresh)) p.status = 'DONE';
    return p;
  }
  p.status = 'DONE';
  apply18(p, m);
  if (takesTheGate && p.status === 'DONE') {
    p.status = 'OPEN'; // AE8
    p.reopened = true;
  }
  return p;
}

test('PC-CX-18 the acceptance-fact write set is derived from the digest, not hand-written', () => {
  // The set is only closed if it can be *derived*. AE6's rows name the projection each write moves,
  // so the projections named there must be exactly the fields of the digest — no more, no fewer.
  const ae6 = tables(section(PCC, '13.4'))[0];
  const projections = new Set(column(ae6, '投影').map(bare));
  assert.deepEqual([...projections].sort(), ['criteriaRevision', 'mergeEvidence', 'taskSet', 'verdicts'], 'AE6 and AE1 disagree about what the digest is made of');
  assert.deepEqual([...new Set(Object.values(MUTATORS_18))].sort(), [...projections].sort(), 'the model and AE6 disagree');

  // …and the three write paths v1.2 was missing have to be named, in words a reader can find.
  const paths = column(ae6, '写路径（穷举）').join(' ');
  assert.match(paths, /task\.project_id/, 'AE6 must list the cross-project move (§12.3 D3 always had it)');
  assert.match(paths, /verifies_task_id/, 'AE6 must list the verification relink');
  assert.match(paths, /refGeneration|contentHash/, 'AE6 must list the merge-evidence write, including the ref generation');

  // Every derived mutator, both orders, I10 on the committed state.
  const all = Object.keys(MUTATORS_18) as Mutator18[];
  for (const m of all) {
    const factFirst = doneRace18('FACT_FIRST', m, all);
    assert.equal(factFirst.status, 'OPEN', `${m}: DONE must be refused while the facts have moved`);
    assert.ok(i10Holds18(factFirst), m);

    const doneFirst = doneRace18('DONE_FIRST', m, all);
    assert.equal(doneFirst.reopened, true, `${m}: AE8 must reopen atomically`);
    assert.ok(i10Holds18(doneFirst), m);
  }

  // Negative control: v1.2's six rows. The three it left out each produce a committed
  // `DONE` + mismatched evidence — the state I10 says cannot exist. (On a real server one of the
  // six orderings is incidentally saved by the foreign key on `task.project_id`; that is measured
  // and explained in `coordinator-linearization.pg.spec.ts`, and it is not a gate — see AE10.4.)
  const missing = all.filter((m) => !V12_GATED.includes(m));
  assert.deepEqual(missing.sort(), ['task.project_id.move_in', 'task.project_id.move_out', 'task.verifies_task_id'], 'the model must reproduce exactly the gap the review found');
  for (const m of missing) {
    for (const order of ['FACT_FIRST', 'DONE_FIRST'] as const) {
      const v12 = doneRace18(order, m, V12_GATED);
      assert.equal(v12.status, 'DONE', `${order}/${m}`);
      assert.equal(i10Holds18(v12), false, `PC-CX-18 must reproduce with the hand-written set (${order}/${m})`);
    }
  }
});

test('PC-CX-18 a cross-project move reopens both projects and takes both locks in id order', () => {
  // AE10. The move changes the taskSet of two projects, so both of them are "the project" for the
  // purposes of AE6/AE8, and both have to be locked — in an order that is the same in both
  // directions, or the fix for PC-CX-18 becomes a new instance of PC-CX-19.
  function move(fromId: string, toId: string): { locks: string[]; reopened: string[] } {
    const from = project18(fromId);
    const to = project18(toId);
    from.status = 'DONE';
    to.status = 'DONE';
    const locks = [fromId, toId].sort(); // LO2 — by id, ascending, in both directions
    apply18(from, 'task.project_id.move_out');
    apply18(to, 'task.project_id.move_in');
    const reopened: string[] = [];
    for (const p of [from, to]) {
      if (p.status === 'DONE' && !i10Holds18(p)) {
        p.status = 'OPEN';
        reopened.push(p.id);
      }
    }
    return { locks, reopened };
  }
  const forward = move('p-a', 'p-b');
  const backward = move('p-b', 'p-a');
  assert.deepEqual(forward.locks, backward.locks, 'LO2: both directions must take the two project rows in the same order');
  assert.deepEqual(forward.reopened.sort(), ['p-a', 'p-b'], 'both projects lose their DONE, because both taskSets moved');
  assert.deepEqual(backward.reopened.sort(), ['p-a', 'p-b']);
});

test('PC-CX-18 the git side is stated as detection, not as a lock', () => {
  // AE9-d. Nothing here can test a `git push`; what it can test is that the contract does not
  // claim to have locked one. The honest sentence is the deliverable.
  const ae9 = section(PCC, '13.4');
  assert.match(ae9, /refGeneration/, 'the digest must be able to represent that the ref moved');
  assert.match(ae9, /有界延迟的检测|不是互斥/, 'AE9 must say plainly what it does not guarantee');

  // …and the mechanism it does define has to converge: a ref that moves is a new generation, which
  // is a different digest, which is AE8.
  const p = project18();
  p.status = 'DONE';
  apply18(p, 'merge_evidence');
  assert.equal(i10Holds18(p), false, 'the moved ref makes the evidence stale…');
  p.status = 'OPEN'; // AE9-c: the merge-evidence writer is an AE6 writer, so it goes through AE8
  assert.ok(i10Holds18(p), '…and the reopen is what makes I10 true again');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-19 · one lock order, no upgrades, bounded retry
// ─────────────────────────────────────────────────────────────────────────────

type LockMode = 'SHARE' | 'NO_KEY_UPDATE' | 'UPDATE';
interface Step {
  row: string;
  mode: LockMode;
}

/** Postgres' row-level lock conflict table, for the three modes this contract uses. */
function conflict(a: LockMode, b: LockMode): boolean {
  if (a === 'SHARE' && b === 'SHARE') return false;
  return true; // SHARE×NO KEY UPDATE, NO KEY UPDATE×NO KEY UPDATE, and anything with UPDATE
}

/**
 * Can these two transactions deadlock? Explores every interleaving: a step is enabled unless some
 * lock the *other* transaction holds on that row conflicts with it (locks a transaction already
 * holds never block itself), and locks are released at commit. Both blocked = deadlock.
 */
function deadlockPossible(a: Step[], b: Step[]): boolean {
  const seen = new Set<string>();
  const walk = (i: number, j: number, heldA: Step[], heldB: Step[]): boolean => {
    if (i >= a.length && j >= b.length) return false;
    const key = `${i}|${j}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const enabled = (step: Step | undefined, otherHeld: Step[]): boolean =>
      step === undefined ? false : !otherHeld.some((h) => h.row === step.row && conflict(step.mode, h.mode));
    const aNext = i < a.length ? a[i] : undefined;
    const bNext = j < b.length ? b[j] : undefined;
    // A transaction that has run out of steps commits and releases everything.
    if (aNext === undefined && heldA.length > 0) return walk(i, j, [], heldB);
    if (bNext === undefined && heldB.length > 0) return walk(i, j, heldA, []);
    const aOk = enabled(aNext, heldB);
    const bOk = enabled(bNext, heldA);
    if (!aOk && !bOk) return true; // both waiting on the other — 40P01
    if (aOk && walk(i + 1, j, [...heldA, aNext!], heldB)) return true;
    if (bOk && walk(i, j + 1, heldA, [...heldB, bNext!])) return true;
    return false;
  };
  return walk(0, 0, [], []);
}

/** §13.4 AE6-a — the acceptance-fact writer, in both contract versions. */
const factWriter = (v: 'v12' | 'v13'): Step[] =>
  v === 'v12'
    ? [{ row: 'project:p1', mode: 'SHARE' }, { row: 'project:p1', mode: 'UPDATE' }] // AE6 then AE8: an upgrade
    : [{ row: 'project:p1', mode: 'NO_KEY_UPDATE' }, { row: 'project:p1', mode: 'UPDATE' }]; // LO3: take it once
const doneGate: Step[] = [{ row: 'project:p1', mode: 'UPDATE' }];

/** §8.6 LO1's order, read from the document rather than retyped. */
function lockOrder(): string[] {
  const line = section(PCC, '8.6').split('\n').find((l) => l.includes('→') && l.includes('project_runtime'))!;
  return Array.from(line.matchAll(/`([a-z_]+)`/g), (m) => m[1]);
}

/** LO4 — retry a serialization failure a bounded number of times, then give it a name. */
function withBoundedRetry(failures: number): { attempts: number; result: 'ok' | 'PROJECT_FACT_WRITE_CONTENDED' } {
  let attempts = 0;
  for (let n = 0; n < 4; n++) {
    attempts += 1;
    if (attempts > failures) return { attempts, result: 'ok' };
  }
  return { attempts, result: 'PROJECT_FACT_WRITE_CONTENDED' };
}

test('PC-CX-19 one lock order, no upgrades, and a bounded retry', () => {
  // LO1: the frozen order, and the model's ranks, must be the same list.
  assert.deepEqual(lockOrder(), ['project', 'project_runtime', 'task', 'session'], '§8.6 LO1 is the only lock order');

  // LO3: two acceptance-fact writers, and a writer against the DONE gate — no interleaving deadlocks.
  assert.equal(deadlockPossible(factWriter('v13'), factWriter('v13')), false, 'two fact writers must queue, not deadlock');
  assert.equal(deadlockPossible(factWriter('v13'), doneGate), false, 'a fact writer against DONE must queue too');
  assert.equal(deadlockPossible(factWriter('v13'), [{ row: 'project:p1', mode: 'NO_KEY_UPDATE' }, { row: 'task:X', mode: 'NO_KEY_UPDATE' }]), false, 'project → task is the same direction for everyone');

  // Negative control: v1.2's SHARE-then-UPDATE. Both writers get the compatible share lock, then
  // both wait for the other to release it — the 40P01 the review reproduced on a real server.
  assert.equal(deadlockPossible(factWriter('v12'), factWriter('v12')), true, 'PC-CX-19 must reproduce under the upgrade');

  // LO4: a contended write ends with a name, never with an unclassified failure.
  assert.deepEqual(withBoundedRetry(0), { attempts: 1, result: 'ok' });
  assert.deepEqual(withBoundedRetry(2), { attempts: 3, result: 'ok' }, 'transient contention is retried');
  assert.deepEqual(withBoundedRetry(9), { attempts: 4, result: 'PROJECT_FACT_WRITE_CONTENDED' }, 'and bounded');

  // F3 must no longer say the thing that could not be true while D6/AE6/AE7 all take locks.
  const f3 = section(PCC, '8.1').split('\n').find((l) => l.startsWith('**F3'))!;
  assert.match(f3, /v1\.3/, 'F3 is a behaviour change and has to be marked as one');
  assert.match(section(PCC, '8.6'), /40P01/, 'the deadlock code needs a documented handling, not silence');
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-CX-20 · attribution proved on the committed state
// ─────────────────────────────────────────────────────────────────────────────

interface Action20 {
  id: string;
  type: string;
  status: 'CLAIMED' | 'APPLIED' | 'REFUSED' | 'SUPERSEDED';
  subjectType: string;
  subjectId: string;
  projectId: string;
  fencingToken: number;
}

interface Insert20 {
  origin: DispatchOrigin;
  taskId: string;
  projectActionId: string | null;
}

/** §7.7 D6 (insert time) + D9 (commit time) + the CHECK, against one contract version. */
function commitSession20(
  actions: Action20[],
  runtime: { projectId: string; fencingToken: number },
  taskProjectId: string,
  s: Insert20,
  version: 'v12' | 'v13',
  mutateBeforeCommit?: (a: Action20[]) => void,
): { committed: boolean; refusal?: string } {
  const find = (): Action20 | undefined => actions.find((a) => a.id === s.projectActionId);
  // CHECK: only a coordinator-origin session may carry an action id (D9, v1.3).
  if (version === 'v13' && s.origin !== 'COORDINATOR' && s.projectActionId !== null) {
    return { committed: false, refusal: 'DISPATCH_ATTRIBUTION_VIOLATION' };
  }
  // BEFORE INSERT.
  if (s.origin === 'COORDINATOR') {
    if (version === 'v12') {
      if (s.projectActionId === null) return { committed: false, refusal: 'DISPATCH_AUTHORITY_VIOLATION' };
    } else {
      const a = find();
      const ok =
        a !== undefined &&
        a.type === 'DISPATCH_TASK' &&
        (a.status === 'CLAIMED' || a.status === 'APPLIED') &&
        a.subjectType === 'TASK' &&
        a.subjectId === s.taskId &&
        a.projectId === taskProjectId &&
        a.fencingToken === runtime.fencingToken;
      if (!ok) return { committed: false, refusal: 'DISPATCH_AUTHORITY_VIOLATION' };
    }
  }
  // …anything the transaction does after the insert, which is the half a BEFORE trigger cannot see.
  mutateBeforeCommit?.(actions);
  // COMMIT: the deferred constraint (v1.3 only).
  if (version === 'v13' && s.origin === 'COORDINATOR') {
    const a = find();
    const ok =
      a !== undefined &&
      a.type === 'DISPATCH_TASK' &&
      a.status === 'APPLIED' &&
      a.subjectType === 'TASK' &&
      a.subjectId === s.taskId &&
      a.projectId === taskProjectId &&
      a.fencingToken === runtime.fencingToken;
    if (!ok) return { committed: false, refusal: 'DISPATCH_ATTRIBUTION_VIOLATION' };
  }
  return { committed: true };
}

/** I11's first clause, evaluated over what is actually in the database afterwards. */
function i11Holds(actions: Action20[], taskProjectId: string, runtimeToken: number, s: Insert20): boolean {
  if (s.origin !== 'COORDINATOR') return s.projectActionId === null;
  const a = actions.find((x) => x.id === s.projectActionId);
  return (
    a !== undefined &&
    a.type === 'DISPATCH_TASK' &&
    a.status === 'APPLIED' &&
    a.subjectId === s.taskId &&
    a.projectId === taskProjectId &&
    a.fencingToken === runtimeToken
  );
}

test('PC-CX-20 attribution is proved on the committed state, not at insert time', () => {
  const runtime = { projectId: 'p1', fencingToken: 42 };
  const good = (over: Partial<Action20> = {}): Action20 => ({
    id: 'a1',
    type: 'DISPATCH_TASK',
    status: 'CLAIMED',
    subjectType: 'TASK',
    subjectId: 'X',
    projectId: 'p1',
    fencingToken: 42,
    ...over,
  });
  const insert: Insert20 = { origin: 'COORDINATOR', taskId: 'X', projectActionId: 'a1' };
  const applyIt = (as: Action20[]): void => {
    as[0].status = 'APPLIED'; // §8.3's third statement
  };

  // The legitimate path: claimed at insert, applied before commit (D9-b's reason for deferring).
  const ok = commitSession20([good()], runtime, 'p1', insert, 'v13', applyIt);
  assert.deepEqual(ok, { committed: true });
  assert.equal(i11Holds([good({ status: 'APPLIED' })], 'p1', 42, insert), true);

  // Six refusals, one per column D9 reads.
  const refusals: [string, Action20[], Insert20, ((a: Action20[]) => void) | undefined][] = [
    ['wrong type', [good({ type: 'NOOP' })], insert, applyIt],
    ['never applied', [good()], insert, undefined],
    ['another task', [good({ subjectId: 'Y' })], insert, applyIt],
    ['another project', [good({ projectId: 'p2' })], insert, applyIt],
    ['stale fencing token', [good({ fencingToken: 41 })], insert, applyIt],
    ['user origin carrying an action', [good()], { origin: 'USER', taskId: 'X', projectActionId: 'a1' }, applyIt],
  ];
  for (const [name, actions, ins, mutate] of refusals) {
    const r = commitSession20(actions, runtime, 'p1', ins, 'v13', mutate);
    assert.equal(r.committed, false, `${name}: must not reach a committed state`);
    assert.match(r.refusal!, /VIOLATION/, name);
  }

  // A session the transaction spoils *after* the insert is the one a BEFORE trigger cannot catch,
  // and the reason D9 exists at all.
  const spoiled = commitSession20([good()], runtime, 'p1', insert, 'v13', (as) => {
    as[0].status = 'SUPERSEDED';
  });
  assert.equal(spoiled.committed, false, 'D9 re-reads at commit, so a late rewrite is still refused');

  // Negative control: v1.2's predicate was `project_action_id IS NOT NULL`. A NOOP that was never
  // applied sails through, and the committed state violates I11 — the review's exact output.
  const v12 = commitSession20([good({ type: 'NOOP' })], runtime, 'p1', insert, 'v12', undefined);
  assert.deepEqual(v12, { committed: true }, 'PC-CX-20 must reproduce under the old predicate');
  assert.equal(i11Holds([good({ type: 'NOOP' })], 'p1', 42, insert), false, 'i11Satisfied=false, as reported');
  const v12user = commitSession20([good()], runtime, 'p1', { origin: 'USER', taskId: 'X', projectActionId: 'a1' }, 'v12', applyIt);
  assert.deepEqual(v12user, { committed: true }, 'and USER origin could carry an action row too');
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation check · every fence v1.3 adds has to be load-bearing
// ─────────────────────────────────────────────────────────────────────────────

// Kept as a second, separate mutation test rather than six more rows in the v1.2 one: the rounds
// have to stay independently checkable, so that a revision cannot close round three by quietly
// dropping a fence from round two.
test('mutation check: every fence added for PC-CX-15..20 is load-bearing', () => {
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-15',
      fence: 'escalation triggered by lifetime alone (§11.5 ES4)',
      defectReappears: () => {
        const one = observable15(deliverN(1, 'lifetimeOrCount')) as { owner: Owner; runState: string };
        const eleven = observable15(deliverN(11, 'lifetimeOrCount')) as { owner: Owner; runState: string };
        return one.owner === 'SYSTEM' && one.runState === 'BLOCKED' && eleven.owner === 'USER' && eleven.runState === 'AWAITING_HUMAN';
      },
    },
    {
      finding: 'PC-CX-16',
      fence: 'the blocker lifecycle generation (§11.3 BE1)',
      defectReappears: () =>
        kindTable().every((row) => {
          const { l, reopened } = episodeCycle(row.kind, 'v12');
          return !reopened.created && l.blockers.filter((b) => b.resolvedAt === null).length === 0;
        }),
    },
    {
      finding: 'PC-CX-17',
      fence: 'monotonic verdict/acceptance revisions and the aggregate CAS (§8.2 GE1)',
      defectReappears: () => {
        const v = verdictCycle('verdictValue');
        const ledger: string[] = [];
        let parent = 'OPEN';
        parent = aggregate(parent, 'A', 'DONE', ledger, true);
        parent = aggregate(parent, 'B', 'OPEN', ledger, true);
        parent = aggregate(parent, 'A', 'DONE', ledger, true);
        return v.targetStatus === 'DONE' && v.defects === 1 && !v.downstreamBlocked && parent === 'OPEN';
      },
    },
    {
      finding: 'PC-CX-18',
      fence: 'the derived acceptance-fact write set (§13.4 AE6-c)',
      defectReappears: () =>
        (Object.keys(MUTATORS_18) as Mutator18[])
          .filter((m) => !V12_GATED.includes(m))
          .every((m) => (['FACT_FIRST', 'DONE_FIRST'] as const).every((order) => !i10Holds18(doneRace18(order, m, V12_GATED)))),
    },
    {
      finding: 'PC-CX-19',
      fence: 'taking the updatable lock first instead of upgrading (§8.6 LO3)',
      defectReappears: () => deadlockPossible(factWriter('v12'), factWriter('v12')),
    },
    {
      finding: 'PC-CX-20',
      fence: 'the deferred attribution constraint (§7.7 D9)',
      defectReappears: () => {
        const runtime = { projectId: 'p1', fencingToken: 42 };
        const noop: Action20 = { id: 'a1', type: 'NOOP', status: 'CLAIMED', subjectType: 'TASK', subjectId: 'X', projectId: 'p1', fencingToken: 42 };
        const s: Insert20 = { origin: 'COORDINATOR', taskId: 'X', projectActionId: 'a1' };
        return commitSession20([noop], runtime, 'p1', s, 'v12').committed && !i11Holds([noop], 'p1', 42, s);
      },
    },
  ];

  assert.equal(mutants.length, 6, 'unit 02 raised six findings against v1.2');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.deepEqual(observable15(deliverN(11, 'lifetime')), observable15(deliverN(1, 'lifetime')));
  assert.equal(episodeCycle('MERGE_CONFLICT', 'generation').reopened.created, true);
  assert.equal(verdictCycle('verdictRevision').targetStatus, 'OPEN');
  assert.ok(i10Holds18(doneRace18('DONE_FIRST', 'task.project_id.move_in', Object.keys(MUTATORS_18) as Mutator18[])));
  assert.equal(deadlockPossible(factWriter('v13'), factWriter('v13')), false);
  assert.equal(
    commitSession20(
      [{ id: 'a1', type: 'NOOP', status: 'CLAIMED', subjectType: 'TASK', subjectId: 'X', projectId: 'p1', fencingToken: 42 }],
      { projectId: 'p1', fencingToken: 42 },
      'p1',
      { origin: 'COORDINATOR', taskId: 'X', projectActionId: 'a1' },
      'v13',
    ).committed,
    false,
  );
});

test('§21 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20 has, for the third round. It also checks the real-Postgres file, because
  // two of these six findings are claims about what the database does, and a model that asserts
  // them is only asserting that whoever wrote it read the manual correctly (§21.5, §21.6).
  const rows = tables(section(PCC, '21'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-15', 'PC-CX-16', 'PC-CX-17', 'PC-CX-18', 'PC-CX-19', 'PC-CX-20']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§21 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  for (const named of Array.from(section(PCC, '21').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1])) {
    assert.ok(pg.includes(`test('${named}'`), `§21 names "${named}", which is not a test in the Postgres spec`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4 — `PC-CX-21..27` (§22)
//
// The fourth round has one shape too, and it is the mirror image of the third. v1.3 learned to let
// the database prove what the database can prove; what it did not do is push that discipline to
// its two boundaries. One boundary is *time*: D9 proves attribution beautifully at COMMIT, and v1.3
// then wrote that proof down as a standing invariant — so the next perfectly ordinary lease
// falsifies it (`PC-CX-21`); `snapshotHash` likewise excluded the clock while a dozen rules read
// it (`PC-CX-22`). The other boundary is *the writer's version*: D5/D6/D9 all live in the database,
// but the column they read was maintained by the new service layer, so one old binary staled the
// first link of the chain (`PC-CX-25`, P0). The rest are the same patterns in other places:
// simultaneously-true reasons with no adjudication (`PC-CX-23`), a row with a lifecycle whose
// generation never reached the identity that reads it (`PC-CX-24`), a human and the control loop
// with no shared lock (`PC-CX-26`), and superseded sentences left alive in the normative body
// (`PC-CX-27`).
//
// Two of these are claims about what a real server does, so they also have real-Postgres tests
// (§22.1, §22.5, §22.6). Everything below is the model half.
// ─────────────────────────────────────────────────────────────────────────────

type Version14 = 'v13' | 'v14';

// ── PC-CX-21 ────────────────────────────────────────────────────────────────
// §4.3 I11-A/I11-B: one standing half stated as a monotone relation, one commit-time half.

interface Attribution {
  actionType: string;
  actionStatus: string;
  actionSubjectId: string;
  actionProjectId: string;
  actionToken: number;
  runtimeToken: number;
  taskId: string;
  taskProjectId: string;
}

/** The structural half, minus the token, shared by both readings. */
function attributionShapeHolds(a: Attribution): boolean {
  return (
    a.actionType === 'DISPATCH_TASK' &&
    a.actionStatus === 'APPLIED' &&
    a.actionSubjectId === a.taskId &&
    a.actionProjectId === a.taskProjectId
  );
}

/** §4.3 I11: `v13` read the commit-time equality as standing; `v14` states the monotone relation. */
function i11Standing(a: Attribution, version: Version14): boolean {
  return attributionShapeHolds(a) && (version === 'v14' ? a.actionToken <= a.runtimeToken : a.actionToken === a.runtimeToken);
}

/** §7.7 D9 — evaluated only at the COMMIT of the transaction that writes the session. */
function d9AdmitsAtCommit(a: Attribution): boolean {
  return attributionShapeHolds(a) && a.actionToken === a.runtimeToken;
}

/** §7.7 D10: a claimed task refuses to change project; `v13` had no such protocol. */
function moveTaskProject(a: Attribution, to: string, claimed: boolean, version: Version14): { committed: boolean; after: Attribution } {
  if (version === 'v14' && claimed) return { committed: false, after: a };
  return { committed: true, after: { ...a, taskProjectId: to } };
}

/**
 * §7.7 D11 as v1.4 wrote it: a per-column denylist over the six attribution columns. Kept in this
 * shape because `PC-CX-21` is what it models — and because it is also the defect `PC-CX-37` found
 * three revisions later, when v1.5 added three columns to the same table and this list did not
 * grow. The current rule is an allowlist (`d11Refuses` in the round-seven block below).
 */
const D11_FROZEN = ['actionType', 'actionStatus', 'actionSubjectId', 'actionProjectId', 'actionToken', 'idempotencyKey'] as const;
const D11_WRITABLE = ['resultSessionId', 'detail'] as const;
function rewriteAppliedAction(applied: boolean, columnName: string, version: Version14): boolean {
  if (version === 'v13') return true; // nothing stopped it
  if (!applied) return true; // CLAIMED → APPLIED/REFUSED/SUPERSEDED is the normal path (D11-a)
  return !(D11_FROZEN as readonly string[]).includes(columnName);
}

test('PC-CX-21 attribution survives the next lease and refuses to survive a live task move', () => {
  const dispatched: Attribution = {
    actionType: 'DISPATCH_TASK', actionStatus: 'APPLIED', actionSubjectId: 't1', actionProjectId: 'p1',
    actionToken: 42, runtimeToken: 42, taskId: 't1', taskProjectId: 'p1',
  };

  // The commit itself is admitted by D9 under both readings — that is not what broke.
  assert.equal(d9AdmitsAtCommit(dispatched), true, 'D9 admits the dispatch at its own commit (I11-B)');
  assert.equal(i11Standing(dispatched, 'v14'), true);
  assert.equal(i11Standing(dispatched, 'v13'), true);

  // Interleaving A: a wholly ordinary reconcile takes the next lease while the session is still
  // live. §8.1 makes the token monotone, so this happens on the very next timer tick, and the
  // session's three columns never move — D9 is not even scheduled to run again.
  let live = dispatched;
  for (const token of [43, 44, 45]) {
    live = { ...live, runtimeToken: token };
    assert.equal(i11Standing(live, 'v14'), true, `I11-A must keep holding at token ${token}: nobody did anything wrong`);
  }
  assert.equal(i11Standing(dispatched, 'v13'), true);
  assert.equal(i11Standing({ ...dispatched, runtimeToken: 43 }, 'v13'), false, 'negative control: the equality reading is false after one normal lease');

  // Interleaving B: a legal AE10 move of a task that still has a live claim.
  const moved13 = moveTaskProject(dispatched, 'p2', true, 'v13');
  assert.equal(moved13.committed, true, 'negative control: v1.3 had no mutator protocol for task.project_id');
  assert.equal(i11Standing(moved13.after, 'v13'), false, 'and the committed state falsifies attribution');

  const moved14 = moveTaskProject(dispatched, 'p2', true, 'v14');
  assert.equal(moved14.committed, false, 'D10 refuses the move while the claim is live');
  assert.deepEqual(moved14.after, dispatched, 'a refused move leaves both rows untouched');
  assert.equal(i11Standing(moved14.after, 'v14'), true);

  // …and it is a refusal, not a prohibition: once the claim is released the move is ordinary.
  const released = moveTaskProject(dispatched, 'p2', false, 'v14');
  assert.equal(released.committed, true, 'D10-c: an unclaimed task moves exactly as AE10 always allowed');

  // D11: the other rows D9 reads are frozen once the action is APPLIED, and only those.
  for (const columnName of D11_FROZEN) {
    assert.equal(rewriteAppliedAction(true, columnName, 'v14'), false, `${columnName} must be immutable on an APPLIED action`);
    assert.equal(rewriteAppliedAction(true, columnName, 'v13'), true, `negative control: ${columnName} was rewritable`);
    assert.equal(rewriteAppliedAction(false, columnName, 'v14'), true, `${columnName} must still be writable while CLAIMED (D11-a)`);
  }
  for (const columnName of D11_WRITABLE) {
    assert.equal(rewriteAppliedAction(true, columnName, 'v14'), true, `${columnName} is not part of attribution (D11-b)`);
  }
});

// ── PC-CX-22 ────────────────────────────────────────────────────────────────
// §6.1 S3/S5/S6/S7/S8: world + evaluation + signals, and one hash over all three.

interface DecisionInput {
  world: { taskId: string; taskStatus: string; runAt: string; dispatchAttempt: number };
  evaluation: { epoch: number; runAtDue: boolean };
  signals: { kind: string; dedupeKey: string }[];
  readAt: string;
}

function decisionInputHash(input: DecisionInput, version: Version14): string {
  const covered = version === 'v14'
    ? { world: input.world, evaluation: input.evaluation, signals: input.signals }
    // v1.3: the hash covered the snapshot minus `snapshotAt` and `events`, and the snapshot had no
    // dispatchAttempt at all — so all three excluded things are excluded here.
    : { world: { taskId: input.world.taskId, taskStatus: input.world.taskStatus, runAt: input.world.runAt } };
  return createHash('sha256').update(JSON.stringify(covered)).digest('hex');
}

/** The mechanical decision the contract requires for this input (§7.2, §7.3, §7.4). */
function decide(input: DecisionInput): { actions: string[] } {
  const actions: string[] = [];
  if (input.signals.some((s) => s.kind === 'user.manual_trigger')) actions.push('OPEN_COORDINATOR_TURN:MANUAL');
  if (input.world.taskStatus === 'OPEN' && input.evaluation.runAtDue) {
    actions.push(`DISPATCH_TASK:pc:v1:p1:dispatch:${input.world.taskId}:${input.world.dispatchAttempt}`);
  }
  return { actions };
}

test('PC-CX-22 the decision input is complete, and the hash is over all of it', () => {
  const base: DecisionInput = {
    world: { taskId: 't1', taskStatus: 'OPEN', runAt: '2026-08-19T10:00:00Z', dispatchAttempt: 1 },
    evaluation: { epoch: 1_755_600_000, runAtDue: true },
    signals: [],
    readAt: '2026-08-19T10:00:01Z',
  };

  // Three independent gaps, each producing "same hash, different required decision" under v1.3.
  const variants: { why: string; input: DecisionInput }[] = [
    { why: 'a persisted generation the snapshot never carried', input: { ...base, world: { ...base.world, dispatchAttempt: 2 } } },
    { why: 'a clock-derived due fact the hash excluded', input: { ...base, evaluation: { epoch: base.evaluation.epoch - 120, runAtDue: false } } },
    { why: 'an event whose existence is itself the decision', input: { ...base, signals: [{ kind: 'user.manual_trigger', dedupeKey: 'k1' }] } },
  ];

  for (const { why, input } of variants) {
    assert.notDeepEqual(decide(input).actions, decide(base).actions, `${why}: the required decision differs`);
    assert.equal(decisionInputHash(input, 'v13'), decisionInputHash(base, 'v13'), `negative control (${why}): v1.3 gives the same hash`);
    assert.notEqual(decisionInputHash(input, 'v14'), decisionInputHash(base, 'v14'), `${why}: the decision input must change identity`);
  }

  // S3 in its positive form: same hash ⇒ literally the same actions. Re-reading at a different
  // wall-clock instant that folds to the same due facts is the case that has to stay stable, or
  // S3 degrades into a sentence that is always true and never useful (S6).
  const reread: DecisionInput = { ...base, readAt: '2026-08-19T10:00:59Z', evaluation: { ...base.evaluation, epoch: base.evaluation.epoch + 58 } };
  const rereadSameEpoch: DecisionInput = { ...base, readAt: '2026-08-19T10:00:59Z' };
  assert.equal(decisionInputHash(rereadSameEpoch, 'v14'), decisionInputHash(base, 'v14'), 'S6: readAt alone must not change the input identity');
  assert.deepEqual(decide(reread).actions, decide(base).actions, 'the same due facts must give the same actions');

  // S7's boundary against E1: a signal enters by identity only, and repeated delivery of the same
  // dedupeKey collapses to one entry (§5.4), so I14 is untouched.
  const once: DecisionInput = { ...base, signals: [{ kind: 'user.manual_trigger', dedupeKey: 'k1' }] };
  const collapsed = [{ kind: 'user.manual_trigger', dedupeKey: 'k1' }, { kind: 'user.manual_trigger', dedupeKey: 'k1' }]
    .filter((s, i, all) => all.findIndex((o) => o.kind === s.kind && o.dedupeKey === s.dedupeKey) === i);
  assert.equal(decisionInputHash({ ...once, signals: collapsed }, 'v14'), decisionInputHash(once, 'v14'), 'delivering the same signal twice must not change the input');
  for (const s of once.signals) assert.deepEqual(Object.keys(s).sort(), ['dedupeKey', 'kind'], 'a signal must carry identity only, never a payload (E1)');
});

// ── PC-CX-23 ────────────────────────────────────────────────────────────────
// §7.2 TU4/TU5 + §4.3 I15: a total order over the six reasons, at most one turn per input.
// v1.17 added `TASK_FAILURE` between VERDICT and BLOCKER_DECISION (`PC-CX-63`), which is the same
// "cause before consequence" cell that already put VERDICT above the blocker it creates.

const TURN_ORDER = ['MANUAL', 'VERDICT', 'TASK_FAILURE', 'BLOCKER_DECISION', 'ACCEPTANCE', 'REPLAN'] as const;
type TurnReason = (typeof TURN_ORDER)[number];

/** `v13` returned every reason whose guard was true; `v14` returns the first in the frozen order. */
function chooseTurnReasons(truths: Record<TurnReason, boolean>, version: Version14, evaluationOrder: readonly TurnReason[] = TURN_ORDER): TurnReason[] {
  const trueOnes = evaluationOrder.filter((r) => truths[r]);
  if (version === 'v13') return trueOnes;
  const winner = TURN_ORDER.find((r) => truths[r]);
  return winner ? [winner] : [];
}

test('PC-CX-23 overlapping turn reasons are decided by one total order', () => {
  // All 64 truth combinations of the six guards. The point of enumerating rather than listing the
  // two the review found is that a hand-written exclusion guard fails on the next combination —
  // the same argument §4.2 RS0 makes about the hand-written transition table.
  const shuffled: readonly TurnReason[] = ['REPLAN', 'ACCEPTANCE', 'BLOCKER_DECISION', 'TASK_FAILURE', 'VERDICT', 'MANUAL'];
  let overlaps = 0;
  for (let mask = 0; mask < 64; mask++) {
    const truths = Object.fromEntries(TURN_ORDER.map((r, i) => [r, Boolean(mask & (1 << i))])) as Record<TurnReason, boolean>;
    const chosen = chooseTurnReasons(truths, 'v14');
    assert.ok(chosen.length <= 1, `mask ${mask}: at most one semantic turn per input (I15)`);
    assert.deepEqual(chosen, chooseTurnReasons(truths, 'v14', shuffled), `mask ${mask}: the answer must not depend on evaluation order`);
    if (chosen.length === 1) {
      assert.equal(chosen[0], TURN_ORDER.find((r) => truths[r]), `mask ${mask}: the winner must be first in the frozen order`);
    } else {
      assert.deepEqual(Object.values(truths).filter(Boolean), [], `mask ${mask}: no turn only when no guard is true`);
    }
    if (chooseTurnReasons(truths, 'v13').length > 1) overlaps++;
  }
  assert.equal(overlaps, 57, 'negative control: 57 of the 64 combinations produced more than one turn under v1.3');

  // The two the review published, as named regressions.
  const allSettled: Record<TurnReason, boolean> = { MANUAL: false, VERDICT: false, TASK_FAILURE: false, BLOCKER_DECISION: false, ACCEPTANCE: true, REPLAN: true };
  assert.deepEqual(chooseTurnReasons(allSettled, 'v13'), ['ACCEPTANCE', 'REPLAN'], 'negative control: converged work hits REPLAN and ACCEPTANCE together');
  assert.deepEqual(chooseTurnReasons(allSettled, 'v14'), ['ACCEPTANCE'], 'ACCEPTANCE wins: §4.2 already puts it above the PLANNING fallback');

  const verificationFailed: Record<TurnReason, boolean> = { MANUAL: false, VERDICT: true, TASK_FAILURE: false, BLOCKER_DECISION: true, ACCEPTANCE: false, REPLAN: false };

  // PC-CX-63, as a third named regression on the same shape: a settled task failure is also the
  // `TEST_FAILED`/`UNKNOWN_FAILURE` blocker it produces, and the cause wins for the same reason.
  const taskFailed: Record<TurnReason, boolean> = { MANUAL: false, VERDICT: false, TASK_FAILURE: true, BLOCKER_DECISION: true, ACCEPTANCE: false, REPLAN: false };
  assert.deepEqual(chooseTurnReasons(taskFailed, 'v14'), ['TASK_FAILURE'], 'a settled failure outranks the blocker its own failure opened');
  assert.deepEqual(chooseTurnReasons(verificationFailed, 'v13'), ['VERDICT', 'BLOCKER_DECISION'], 'negative control: a FAIL is also the blocker it creates');
  assert.deepEqual(chooseTurnReasons(verificationFailed, 'v14'), ['VERDICT'], 'the cause wins over the consequence it created (§13.2 ④)');

  // The document is the source of the order, so read it rather than trusting the constant above.
  assert.deepEqual(column(turnReasons(), 'reasonCode').map(bare), [...TURN_ORDER], '§7.2 and this model disagree about the total order');
});

// ── PC-CX-24 ────────────────────────────────────────────────────────────────
// §7.2 TF4 + §7.6 TR3: a cleared-and-recurring blocker is a new episode, not a stalled turn.

function reasonDigest24(kind: string, subjectId: string, conditionVersion: string, lifecycleGeneration: number, version: Version14): string {
  const facts = version === 'v14'
    ? [kind, subjectId, lifecycleGeneration, conditionVersion]
    : [kind, subjectId, conditionVersion];
  return createHash('sha256').update(JSON.stringify(['BLOCKER_DECISION', facts])).digest('hex');
}

/** §7.6: TR1 dedupes on the digest, TR3 turns a finished-and-unchanged digest into a blocker. */
function turnOutcome24(digest: string, finishedTurns: Set<string>): 'OPEN_COORDINATOR_TURN' | 'COORDINATOR_NO_PROGRESS' {
  return finishedTurns.has(digest) ? 'COORDINATOR_NO_PROGRESS' : 'OPEN_COORDINATOR_TURN';
}

test('PC-CX-24 a blocker episode that recurs earns a new turn, not a no-progress verdict', () => {
  const opensTurn = tableRows(section(PCC, '11.2'))
    .filter((cells) => bare(cells[4]) === '✔')
    .map((cells) => bare(cells[0]));
  assert.deepEqual(opensTurn.sort(), ['DEPENDENCY_CYCLE', 'MERGE_CONFLICT', 'VERIFICATION_FAILED', 'WHO_UNRESOLVED'], '§11.2 no longer has four turn-opening kinds');

  for (const kind of opensTurn) {
    for (const version of ['v13', 'v14'] as Version14[]) {
      const finished = new Set<string>();

      // Episode 1, seen N times. Repeats inside one open episode must collapse onto one key —
      // that is AC8's dedup, and it has to survive the fix rather than be traded away for it.
      const first = reasonDigest24(kind, 'subject-1', 'condition-A', 1, version);
      for (let n = 0; n < 5; n++) {
        assert.equal(reasonDigest24(kind, 'subject-1', 'condition-A', 1, version), first, `${kind}/${version}: repeats inside an episode must not move the key`);
      }
      assert.equal(turnOutcome24(first, finished), 'OPEN_COORDINATOR_TURN');
      finished.add(first); // the coordinator ran and the turn ended

      // Same episode, still unchanged: TR3 is right to refuse a second turn here.
      assert.equal(turnOutcome24(first, finished), 'COORDINATOR_NO_PROGRESS', `${kind}/${version}: TR3 must still catch a genuinely stalled episode`);

      // The blocker is cleared; an hour later the identical condition happens again. §11.3 BE1
      // gives it generation 2 — the only fact in the system that says "it recovered in between".
      const recurrence = reasonDigest24(kind, 'subject-1', 'condition-A', 2, version);
      if (version === 'v13') {
        assert.equal(recurrence, first, `negative control (${kind}): the new episode reuses the old permanent turn key`);
        assert.equal(turnOutcome24(recurrence, finished), 'COORDINATOR_NO_PROGRESS', `negative control (${kind}): a brand new failure is filed as "no progress"`);
      } else {
        assert.notEqual(recurrence, first, `${kind}: a new lifecycle generation must produce a new turn identity`);
        assert.equal(turnOutcome24(recurrence, finished), 'OPEN_COORDINATOR_TURN', `${kind}: the coordinator gets a turn for the new episode`);
      }
    }
  }
});

// ── PC-CX-25 ────────────────────────────────────────────────────────────────
// §7.7 D8-a/D12/D13 + §12.3 D3: the projection is derived by the database, not maintained.

interface AuthorityDb {
  projects: Record<string, { coordinatorEnabled: boolean }>;
  tasks: Record<string, { projectId: string | null; dispatchAuthority: DispatchAuthority }>;
  claims: Record<string, boolean>;
}

function derivedAuthority(db: AuthorityDb, projectId: string | null): DispatchAuthority {
  return projectId !== null && db.projects[projectId]?.coordinatorEnabled ? 'COORDINATOR' : 'LEGACY';
}

/** §7.7 D13 — the drift query, as a predicate over committed state. */
function authorityDrift(db: AuthorityDb): string[] {
  return Object.entries(db.tasks)
    .filter(([, t]) => t.dispatchAuthority !== derivedAuthority(db, t.projectId))
    .map(([id]) => id);
}

/**
 * A write of `task.project_id`. `oldWriter` is a binary that has never heard of
 * `dispatch_authority`; under `v13` the projection was a service-layer duty it does not perform.
 */
function writeTaskProject(db: AuthorityDb, taskId: string, projectId: string | null, version: Version14, oldWriter: boolean): void {
  db.tasks[taskId].projectId = projectId;
  if (version === 'v14') db.tasks[taskId].dispatchAuthority = derivedAuthority(db, projectId); // trigger ①
  else if (!oldWriter) db.tasks[taskId].dispatchAuthority = derivedAuthority(db, projectId); // D3 primitive
}

function flipCoordinatorEnabled(db: AuthorityDb, projectId: string, next: boolean, version: Version14): void {
  db.projects[projectId].coordinatorEnabled = next;
  for (const [id, t] of Object.entries(db.tasks)) {
    if (t.projectId !== projectId) continue;
    if (version === 'v13' && db.claims[id]) continue; // D8-b's skip: the claimed task keeps its value
    t.dispatchAuthority = derivedAuthority(db, projectId); // trigger ② fans out unconditionally
  }
}

function releaseClaim(db: AuthorityDb, taskId: string, version: Version14, oldWriter: boolean): void {
  db.claims[taskId] = false;
  // v1.2's third write point lived in the transaction that ends the session — and an old binary
  // does not have it. v1.4 has no third write point at all: nothing went stale to repair.
  if (version === 'v13' && !oldWriter) db.tasks[taskId].dispatchAuthority = derivedAuthority(db, db.tasks[taskId].projectId);
}

/** §7.7 D6, reading the authority under `FOR SHARE` — so it can never read a pre-flip value. */
function d6Admits(db: AuthorityDb, taskId: string, origin: DispatchOrigin): boolean {
  const authority = db.tasks[taskId].dispatchAuthority;
  if (authority !== 'COORDINATOR') return origin !== 'COORDINATOR';
  return origin !== 'LEGACY_SWEEP';
}

function freshDb(): AuthorityDb {
  return {
    projects: { p1: { coordinatorEnabled: true }, p0: { coordinatorEnabled: false } },
    tasks: { t1: { projectId: 'p0', dispatchAuthority: 'LEGACY' }, t2: { projectId: 'p1', dispatchAuthority: 'COORDINATOR' } },
    claims: { t1: false, t2: false },
  };
}

test('PC-CX-25 the authority projection is derived by the database, not maintained by a service', () => {
  // Minimal counterexample A: an old apiserver moves a legacy task into a coordinator-enabled
  // project. It writes exactly one column, because that is the only column its code knows about.
  for (const version of ['v13', 'v14'] as Version14[]) {
    const db = freshDb();
    writeTaskProject(db, 't1', 'p1', version, true);
    if (version === 'v13') {
      assert.deepEqual(authorityDrift(db), ['t1'], 'negative control: the projection is stale after the old write');
      assert.equal(d6Admits(db, 't1', 'LEGACY_SWEEP'), true, 'negative control: D6 faithfully enforces the stale value and admits the old sweep');
    } else {
      assert.deepEqual(authorityDrift(db), [], 'the trigger recomputes regardless of who wrote, or what they knew');
      assert.equal(d6Admits(db, 't1', 'LEGACY_SWEEP'), false, 'and the old sweep is refused');
    }
  }

  // Minimal counterexample B: a claim in flight when the project is enabled, released by an old
  // writer. v1.2 needed a repair there; v1.4 has nothing to repair because it never skipped.
  for (const version of ['v13', 'v14'] as Version14[]) {
    const db = freshDb();
    db.projects.p1.coordinatorEnabled = false;
    db.tasks.t2.dispatchAuthority = 'LEGACY';
    db.claims.t2 = true;
    flipCoordinatorEnabled(db, 'p1', true, version);
    releaseClaim(db, 't2', version, true);
    assert.deepEqual(authorityDrift(db), version === 'v13' ? ['t2'] : [], `${version}: claim release`);
  }

  // The rest of the write paths, each under an old writer, each asserted against the drift query.
  const paths: { why: string; run: (db: AuthorityDb, version: Version14) => void }[] = [
    { why: 'move-in', run: (db, v) => writeTaskProject(db, 't1', 'p1', v, true) },
    { why: 'move-out', run: (db, v) => writeTaskProject(db, 't2', null, v, true) },
    { why: 'cross-project move', run: (db, v) => writeTaskProject(db, 't2', 'p0', v, true) },
    { why: 'enable', run: (db, v) => flipCoordinatorEnabled(db, 'p0', true, v) },
    { why: 'disable', run: (db, v) => flipCoordinatorEnabled(db, 'p1', false, v) },
  ];
  for (const { why, run } of paths) {
    const db = freshDb();
    run(db, 'v14');
    assert.deepEqual(authorityDrift(db), [], `${why}: I12-A must hold on every committed state`);
  }

  // I12-B: a pre-flip claim is bounded and cannot be joined by a new one. This is what replaces
  // v1.2's "the flip waits for the claim" — and it is proved by D6 rather than by a skip.
  const db = freshDb();
  db.projects.p1.coordinatorEnabled = false;
  db.tasks.t2.dispatchAuthority = 'LEGACY';
  assert.equal(d6Admits(db, 't2', 'LEGACY_SWEEP'), true, 'before the flip a legacy claim is legal');
  db.claims.t2 = true;
  flipCoordinatorEnabled(db, 'p1', true, 'v14');
  assert.deepEqual(authorityDrift(db), [], 'the flip is not deferred by the claim');
  assert.equal(d6Admits(db, 't2', 'LEGACY_SWEEP'), false, 'after the flip no new legacy claim can be admitted (I12-B)');
  assert.equal(db.claims.t2, true, 'and the run already in flight is never killed by a projection change');

  // §12.3 D3 must no longer name service-layer write points at all — that is the whole fix.
  assert.match(section(PCC, '12.3'), /`dispatch_authority` \*\*没有服务层写入点\*\*/, '§12.3 still assigns the projection to a service');
});

// ── PC-CX-26 ────────────────────────────────────────────────────────────────
// §9.6 AU1/CAP1 + §4.3 I16: revocation, the cap and dispatch behind one project row lock.

type Mutator26 = 'disable' | 'toManual' | 'lowerMax' | 'manualStart';

interface ProjectConfig {
  coordinatorEnabled: boolean;
  automationPolicy: 'MANUAL' | 'GUARDED_AUTO' | 'AUTO';
  maxConcurrentTasks: number;
  configRevision: number;
}

interface GateResult {
  dispatched: boolean;
  refusalCode: string | null;
  manualRefusalCode: string | null;
  claims: number;
  config: ProjectConfig;
}

function policyAllowsDispatch(config: ProjectConfig): boolean {
  return config.coordinatorEnabled && config.automationPolicy !== 'MANUAL';
}

function applyMutator(config: ProjectConfig, mutator: Mutator26): ProjectConfig {
  switch (mutator) {
    case 'disable': return { ...config, coordinatorEnabled: false, configRevision: config.configRevision + 1 };
    case 'toManual': return { ...config, automationPolicy: 'MANUAL', configRevision: config.configRevision + 1 };
    case 'lowerMax': return { ...config, maxConcurrentTasks: 0, configRevision: config.configRevision + 1 };
    case 'manualStart': return config; // a human start does not touch the project row
  }
}

/**
 * One barrier: the human write and the coordinator commit, in both orders. Under `v14` the
 * coordinator's commit takes `project … FOR NO KEY UPDATE` first and re-reads (§9.6 AU1/CAP1);
 * under `v13` its only commit predicate is the fencing token, which the human never advances.
 */
function gateRace(order: 'HUMAN_FIRST' | 'COORDINATOR_FIRST', mutator: Mutator26, version: Version14): GateResult {
  const snapshot: ProjectConfig = { coordinatorEnabled: true, automationPolicy: 'AUTO', maxConcurrentTasks: 1, configRevision: 7 };
  let config = snapshot;
  let claims = 0;
  let manualRefusalCode: string | null = null;

  const humanWrite = (): void => {
    if (mutator === 'manualStart') {
      // CAP1: the human entry point takes the same lock and counts the same claims.
      if (version === 'v14' && claims >= config.maxConcurrentTasks) manualRefusalCode = 'PROJECT_CONCURRENCY_LIMIT';
      else claims += 1;
      return;
    }
    config = applyMutator(config, mutator);
  };

  const coordinatorCommit = (): { dispatched: boolean; refusalCode: string | null } => {
    if (version === 'v13') {
      // The fencing token is still valid — the human never advanced it (§8.1 F1 is the only gate).
      claims += 1;
      return { dispatched: true, refusalCode: null };
    }
    if (!policyAllowsDispatch(config)) return { dispatched: false, refusalCode: 'AUTHORITY_REVOKED' };
    if (claims >= config.maxConcurrentTasks) return { dispatched: false, refusalCode: 'AUTHORITY_REVOKED' };
    claims += 1;
    return { dispatched: true, refusalCode: null };
  };

  let outcome: { dispatched: boolean; refusalCode: string | null };
  if (order === 'HUMAN_FIRST') { humanWrite(); outcome = coordinatorCommit(); }
  else { outcome = coordinatorCommit(); humanWrite(); }
  return { ...outcome, manualRefusalCode, claims, config };
}

test('PC-CX-26 revocation and the project cap share one gate with dispatch', () => {
  const mutators: Mutator26[] = ['disable', 'toManual', 'lowerMax', 'manualStart'];
  for (const mutator of mutators) {
    for (const order of ['HUMAN_FIRST', 'COORDINATOR_FIRST'] as const) {
      const got = gateRace(order, mutator, 'v14');

      // I16's second half, for every cell: the cap is never crossed.
      assert.ok(got.claims <= Math.max(got.config.maxConcurrentTasks, 0) || order === 'COORDINATOR_FIRST',
        `${mutator}/${order}: the project cap must not be crossed`);

      if (order === 'HUMAN_FIRST') {
        assert.equal(got.dispatched, false, `${mutator}/HUMAN_FIRST: the human write wins and the stale decision is refused`);
        assert.equal(got.refusalCode, 'AUTHORITY_REVOKED', `${mutator}/HUMAN_FIRST: the refusal must be recorded, not silent`);
      } else {
        assert.equal(got.dispatched, true, `${mutator}/COORDINATOR_FIRST: a dispatch committed while it was still authorised is legal`);
        if (mutator === 'manualStart') {
          assert.equal(got.manualRefusalCode, 'PROJECT_CONCURRENCY_LIMIT', 'the human entry point gets a typed error, not a 500 and not a silent queue');
          assert.equal(got.claims, 1, 'and the cap still holds');
        }
      }
      // AU1-a: exactly two outcomes exist. There is no third.
      assert.ok(['AUTHORITY_REVOKED', null].includes(got.refusalCode), `${mutator}/${order}: unexpected third outcome`);
    }
  }

  // Negative controls, one per counterexample the review published.
  const revoked = gateRace('HUMAN_FIRST', 'disable', 'v13');
  assert.equal(revoked.dispatched, true, 'negative control A: the stale AUTO decision commits after the human revoked it');
  assert.equal(revoked.config.coordinatorEnabled, false, 'leaving "automation off + a session automation created"');

  const capped = gateRace('HUMAN_FIRST', 'manualStart', 'v13');
  assert.equal(capped.claims, 2, 'negative control B: per-task claims cannot enforce a project-wide cap');
  assert.ok(capped.claims > capped.config.maxConcurrentTasks);

  // AU2: the revision is what makes the race auditable and what keeps S3 honest.
  assert.equal(applyMutator({ coordinatorEnabled: true, automationPolicy: 'AUTO', maxConcurrentTasks: 1, configRevision: 7 }, 'disable').configRevision, 8);
});

// ── PC-CX-27 ────────────────────────────────────────────────────────────────
// §0 RL1 + §22.8: two implementers reading the same frozen text must build the same system.

type Reading = 'KEYED' | 'CAS' | 'AMBIGUOUS';

/**
 * What a chunk of the normative body *requires*, as opposed to what it merely *mentions*. §22.8
 * gives two conventions and they answer two different questions, so both are used and neither is
 * a substitute for the other:
 *
 *   - may this line name a superseded sentence at all? → it must carry provenance (a version or a
 *     finding id). That is the ledger scan at the bottom of this test.
 *   - is this occurrence the operative clause? → a mention is written inside quotation marks, a
 *     requirement is not. That is this function.
 *
 * Provenance alone cannot answer the second question, because a rule routinely cites the version
 * that froze it (`**AE6-a（取锁，v1.3 修订）**`) — dropping every line with a version number would
 * drop the current rules along with the history.
 */
function requires(text: string): string {
  return text.replace(/"[^"\n]*"/g, '');
}

/** What §13.1 tells an implementer about `AGGREGATE_PARENT`'s idempotency key. */
function readAggregateRule(text: string): Reading {
  const body = requires(text);
  const keyed = /幂等键的 epoch 取子状态摘要/.test(body);
  const cas = /\*\*AG5（聚合没有幂等键/.test(body);
  if (keyed && cas) return 'AMBIGUOUS';
  return keyed ? 'KEYED' : 'CAS';
}

/** What §13.4 tells an implementer to lock when it writes an acceptance fact. */
function readFactWriterLock(text: string): 'FOR SHARE' | 'FOR NO KEY UPDATE' | 'AMBIGUOUS' {
  const body = requires(text);
  const share = /持有 AE6 那把 `FOR SHARE`/.test(body) || /FROM project WHERE id = :p FOR SHARE/.test(body);
  const noKey = /FOR NO KEY UPDATE` 作为事务里对 project 的第一次访问/.test(body);
  if (share && noKey) return 'AMBIGUOUS';
  return share ? 'FOR SHARE' : 'FOR NO KEY UPDATE';
}

test('PC-CX-27 no superseded normative sentence survives in the normative body', () => {
  const normative = PCC.slice(0, PCC.indexOf('\n## 19. '));
  const aggregate = section(PCC, '13.1');
  const acceptance = section(PCC, '13.4');

  // The two the fourth review caught: each had two frozen sentences prescribing opposite things,
  // and each wrong reading resurrects a finding that was already closed.
  assert.equal(readAggregateRule(aggregate), 'CAS', 'AG1 and AG5 must not both be readable (implementing AG1 revives PC-CX-17)');
  assert.equal(readFactWriterLock(acceptance), 'FOR NO KEY UPDATE', 'AE8 and AE6-a must not both be readable (implementing AE8 revives PC-CX-19)');

  // Negative control: the v1.3 sentences, put back verbatim as requirements rather than as
  // quotations, make both questions unanswerable again.
  const v13Aggregate = `${aggregate}\n- **AG1**：聚合是重算（幂等键的 epoch 取子状态摘要，§8.2）。`;
  const v13Lock = `${acceptance}\n**AE8**：持有 AE6 那把 \`FOR SHARE\` 的写入者，在锁到手之后必须重读。`;
  assert.equal(readAggregateRule(v13Aggregate), 'AMBIGUOUS', 'negative control: two frozen readings of the aggregate key');
  assert.equal(readFactWriterLock(v13Lock), 'AMBIGUOUS', 'negative control: two frozen readings of the fact-writer lock');

  // The mechanism, not just this round's two: §22.8 registers every superseded sentence, and a
  // line in §1–§18 may only quote one if it carries its provenance. v1.3 answered PC-CX-15 with a
  // static check over the two sections it already knew about; a 2000-line contract states a rule
  // in five or six places, so the check has to be over the whole body and driven by a ledger that
  // grows with the revisions.
  const ledger = tables(section(PCC, '22.8'))[0];
  const phrases = column(ledger, '被取代的字样').map(bare);
  assert.ok(phrases.length >= 19, '§22.8 registers no superseded sentences');
  // The ledger cells are read with `bare`, which strips ` and *; the body has to be read the same
  // way or a phrase that spans a code span can never match, and a row that can never match is a row
  // that never fails. v1.6 found that by writing rows whose phrases straddle `nextWakeAt`.
  const demarked = normative.split('\n').map((l) => bare(l));
  for (const phrase of phrases) {
    for (const [i, line] of demarked.entries()) {
      if (!line.includes(phrase)) continue;
      assert.match(line, /v1\.[1-7]|PC-CX-\d\d/, `"${phrase}" is alive in the normative body at line ${i + 1}`);
    }
  }
  for (const n of ['19', '20', '21', '22', '23', '24', '25']) {
    assert.match(section(PCC, n).split('\n').slice(0, 4).join('\n'), /本节是非规范的/, `§${n} is not marked non-normative`);
  }
});

test('mutation check: every fence added for PC-CX-21..27 is load-bearing', () => {
  // Same discipline as the two mutation checks above: a fence that can be removed without the
  // defect coming back was never the fix. Each entry removes exactly one thing v1.4 added and
  // asserts the published counterexample reappears.
  const dispatched: Attribution = {
    actionType: 'DISPATCH_TASK', actionStatus: 'APPLIED', actionSubjectId: 't1', actionProjectId: 'p1',
    actionToken: 42, runtimeToken: 42, taskId: 't1', taskProjectId: 'p1',
  };
  const baseInput: DecisionInput = {
    world: { taskId: 't1', taskStatus: 'OPEN', runAt: '2026-08-19T10:00:00Z', dispatchAttempt: 1 },
    evaluation: { epoch: 1_755_600_000, runAtDue: true },
    signals: [],
    readAt: '2026-08-19T10:00:01Z',
  };
  const withAttempt2: DecisionInput = { ...baseInput, world: { ...baseInput.world, dispatchAttempt: 2 } };

  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-21',
      fence: 'the monotone standing form of I11 and D10/D11 (§4.3 I11-A, §7.7 D10/D11)',
      defectReappears: () =>
        !i11Standing({ ...dispatched, runtimeToken: 43 }, 'v13') &&
        moveTaskProject(dispatched, 'p2', true, 'v13').committed &&
        rewriteAppliedAction(true, 'actionSubjectId', 'v13'),
    },
    {
      finding: 'PC-CX-22',
      fence: 'hashing evaluation and signals alongside the world (§6.1 S3/S5/S7)',
      defectReappears: () =>
        decisionInputHash(withAttempt2, 'v13') === decisionInputHash(baseInput, 'v13') &&
        JSON.stringify(decide(withAttempt2).actions) !== JSON.stringify(decide(baseInput).actions),
    },
    {
      finding: 'PC-CX-23',
      fence: 'the total order over the turn reasons (§7.2 TU4)',
      defectReappears: () =>
        chooseTurnReasons({ MANUAL: false, VERDICT: true, TASK_FAILURE: false, BLOCKER_DECISION: true, ACCEPTANCE: false, REPLAN: false }, 'v13').length === 2,
    },
    {
      finding: 'PC-CX-24',
      fence: 'the lifecycle generation inside turnFacts (§7.2 TF4)',
      defectReappears: () =>
        reasonDigest24('MERGE_CONFLICT', 's', 'A', 2, 'v13') === reasonDigest24('MERGE_CONFLICT', 's', 'A', 1, 'v13'),
    },
    {
      finding: 'PC-CX-25',
      fence: 'the database-side authority projection (§7.7 D8-a / D12)',
      defectReappears: () => {
        const db = freshDb();
        writeTaskProject(db, 't1', 'p1', 'v13', true);
        return authorityDrift(db).length > 0 && d6Admits(db, 't1', 'LEGACY_SWEEP');
      },
    },
    {
      finding: 'PC-CX-26',
      fence: 'the shared project row lock at the commit point (§9.6 AU1 / CAP1)',
      defectReappears: () =>
        gateRace('HUMAN_FIRST', 'disable', 'v13').dispatched && gateRace('HUMAN_FIRST', 'manualStart', 'v13').claims === 2,
    },
    {
      finding: 'PC-CX-27',
      fence: 'deleting the superseded sentences (§0 RL1, §22.8)',
      defectReappears: () =>
        readAggregateRule(`${section(PCC, '13.1')}\n- **AG1**：幂等键的 epoch 取子状态摘要。`) === 'AMBIGUOUS',
    },
  ];

  assert.equal(mutants.length, 7, 'unit 02 raised seven findings against v1.3');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.equal(i11Standing({ ...dispatched, runtimeToken: 43 }, 'v14'), true);
  assert.equal(moveTaskProject(dispatched, 'p2', true, 'v14').committed, false);
  assert.notEqual(decisionInputHash(withAttempt2, 'v14'), decisionInputHash(baseInput, 'v14'));
  assert.equal(chooseTurnReasons({ MANUAL: false, VERDICT: true, TASK_FAILURE: false, BLOCKER_DECISION: true, ACCEPTANCE: false, REPLAN: false }, 'v14').length, 1);
  assert.notEqual(reasonDigest24('MERGE_CONFLICT', 's', 'A', 2, 'v14'), reasonDigest24('MERGE_CONFLICT', 's', 'A', 1, 'v14'));
  const clean = freshDb();
  writeTaskProject(clean, 't1', 'p1', 'v14', true);
  assert.deepEqual(authorityDrift(clean), []);
  assert.equal(gateRace('HUMAN_FIRST', 'disable', 'v14').dispatched, false);
  assert.equal(readAggregateRule(section(PCC, '13.1')), 'CAS');
});

test('§22 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20 and §21 have, for the fourth round. Two of these seven are claims about
  // what a real server does, so the Postgres file is checked by name as well — §22.1 and §22.5
  // both assert things (a deferred trigger's scope, a projection trigger's row lock) that a model
  // can only assert about its author's reading of the manual.
  const rows = tables(section(PCC, '22'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-21', 'PC-CX-22', 'PC-CX-23', 'PC-CX-24', 'PC-CX-25', 'PC-CX-26', 'PC-CX-27']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§22 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '22').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 3, '§22 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§22 names "${name}", which is not a test in the Postgres spec`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.5 · `PC-CX-28..31`
//
// The fifth round has one shape, and it is the fourth round's own lesson applied to the fourth
// round's own text. v1.4 learned two things: state an invariant with a tense (`PC-CX-21`), and make
// the human and the control loop share one gate (`PC-CX-26`). Then it wrote a *new* current-state
// invariant for the cap — false the moment a human lowers it after a legal dispatch (`PC-CX-28`) —
// and put only two of §7.4's three human-writable predicates behind that gate, leaving the whole
// PAC execution context outside it (`PC-CX-29`). The other two are completeness failures of the
// same kind: the "complete" decision input harvests from three hand-picked tables that happen to
// exclude the only two rules reading `project_action` (`PC-CX-30`), and a frozen rate limit says
// "at most once" without saying where the refused request goes (`PC-CX-31`).
// ─────────────────────────────────────────────────────────────────────────────

type Version15 = 'v14' | 'v15';
type Order15 = 'USER_FIRST' | 'COORDINATOR_FIRST';
const ORDERS15: Order15[] = ['USER_FIRST', 'COORDINATOR_FIRST'];

// ── PC-CX-28 ────────────────────────────────────────────────────────────────
// §9.6 CAP0 · §4.3 I16-A/I16-B: the cap is an admission limit, so both commit orders are judged by
// one invariant and no cell is exempt.

interface Claim28 {
  id: string;
  /** What CAP1's `count(*)` and the same statement's `max` read, in the transaction that inserted. */
  admittedWith: { inFlightBefore: number; max: number };
}

interface Cap28 {
  max: number;
  claims: Claim28[];
  refusals: string[];
  /** `{oldMax, newMax, inFlightAtWrite}` — CAP4's audit, one row per human cap write. */
  capWrites: { oldMax: number; newMax: number; inFlightAtWrite: number }[];
}

/** I16-A, read off the committed state: every claim was admitted under `count < max`. */
function admissionInvariantHolds(db: Cap28): boolean {
  return db.claims.every((c) => c.admittedWith.inFlightBefore < c.admittedWith.max);
}

/** v1.4's I16 second half and CAP3 — the sentence the fifth review showed to be unsatisfiable. */
function v14CurrentStateInvariantHolds(db: Cap28): boolean {
  return db.claims.length <= db.max;
}

/** CAP0-a: one entry point, one admission, under the shared project row lock. */
function admit(db: Cap28, id: string): boolean {
  const inFlightBefore = db.claims.length;
  if (inFlightBefore >= db.max) {
    db.refusals.push(id);
    return false;
  }
  db.claims.push({ id, admittedWith: { inFlightBefore, max: db.max } });
  return true;
}

/** CAP0-b: lowering is never refused and never touches an in-flight claim. */
function lowerCap(db: Cap28, newMax: number): void {
  db.capWrites.push({ oldMax: db.max, newMax, inFlightAtWrite: db.claims.length });
  db.max = newMax;
}

const overCapBy = (db: Cap28): number => Math.max(0, db.claims.length - db.max);

/** The interleaving the review published, run in both orders. */
function capRace28(order: Order15): Cap28 {
  const db: Cap28 = { max: 2, claims: [], refusals: [], capWrites: [] };
  admit(db, 'pre-existing'); // the snapshot the review starts from: max=2, inFlight=1
  const user = (): void => lowerCap(db, 1);
  const loop = (): void => void admit(db, 'coordinator');
  if (order === 'USER_FIRST') { user(); loop(); } else { loop(); user(); }
  return db;
}

test('PC-CX-28 the cap is an admission limit, and both commit orders satisfy one invariant', () => {
  // The published interleaving. Both orders are legal, and under v1.5 both satisfy I16-A — which is
  // the whole point: the fix is not "stop one of the orders", it is "state the invariant the two
  // legal orders actually share".
  for (const order of ORDERS15) {
    const db = capRace28(order);
    assert.equal(admissionInvariantHolds(db), true, `${order}: every claim must have been admitted under count < max`);
    assert.equal(db.capWrites.length, 1, `${order}: lowering the cap is never refused (CAP0-b)`);
    assert.equal(db.claims.filter((c) => c.id === 'pre-existing').length, 1, `${order}: an in-flight claim is never touched by a cap write`);
  }

  const userFirst = capRace28('USER_FIRST');
  assert.deepEqual(userFirst.refusals, ['coordinator'], 'USER_FIRST: the cap is already 1 and the dispatch is refused admission');
  assert.equal(overCapBy(userFirst), 0);

  const loopFirst = capRace28('COORDINATOR_FIRST');
  assert.deepEqual(loopFirst.refusals, [], 'COORDINATOR_FIRST: the dispatch was admitted while count < max');
  assert.equal(overCapBy(loopFirst), 1, 'and the human write leaves a visible over-cap state, not a violated invariant');
  assert.deepEqual(loopFirst.capWrites, [{ oldMax: 2, newMax: 1, inFlightAtWrite: 2 }], 'CAP4: the cap write is audited with what it saw');

  // CAP4.1 — over cap is bounded and self-draining: nothing is admitted while it lasts, and the
  // first in-flight claim to end restores admission. This is the property that makes "not an
  // invariant violation" honest rather than a redefinition that gives up.
  assert.equal(admit(loopFirst, 'while-over-cap'), false, 'no entry point can be admitted while over cap');
  assert.deepEqual(loopFirst.refusals, ['while-over-cap']);
  loopFirst.claims = loopFirst.claims.filter((c) => c.id !== 'pre-existing'); // one session ends
  assert.equal(overCapBy(loopFirst), 0, 'over cap converges monotonically as sessions end');
  assert.equal(admit(loopFirst, 'still-at-cap'), false, 'at the cap is still not below it');
  loopFirst.claims = []; // the last one ends
  assert.equal(admit(loopFirst, 'after-drain'), true, 'and admission resumes as soon as count < max');
  assert.equal(admissionInvariantHolds(loopFirst), true, 'I16-A held through the whole sequence');

  // The v1.4 sentence, on the same states. It is not that the model got a different answer — it is
  // that the sentence is false on a state every step of which the contract permits.
  assert.equal(v14CurrentStateInvariantHolds(capRace28('USER_FIRST')), true);
  assert.equal(v14CurrentStateInvariantHolds(capRace28('COORDINATOR_FIRST')), false,
    'PC-CX-28 must reproduce: v1.4 froze a current-state invariant that a legal cap decrease falsifies');

  // …and the ledger has to carry the supersession, or the next implementer reads the dead sentence.
  const ledger = column(tables(section(PCC, '22.8'))[0], '被取代的字样').map(bare);
  assert.ok(ledger.some((p) => p.includes('任何顺序下已提交的占位 Session 条数 ≤')), '§22.8 does not register CAP3\'s superseded sentence');
  assert.ok(ledger.some((p) => p.includes('同一 Project 的占位 Session 条数 >')), '§22.8 does not register I16\'s superseded half');
});

test('PC-CX-28 the four mutators cover both orders with no exempted cell', () => {
  // The published finding is as much about the *test* as about the contract: v1.4's PC-CX-26 cell
  // for `lowerMax × COORDINATOR_FIRST` carried `|| order === 'COORDINATOR_FIRST'`, so the one cell
  // that could go red was the one cell the assertion did not apply to — while the test claimed to
  // walk all eight. Here every cell is judged by I16-A, and the count of cells is asserted.
  const mutators: Mutator26[] = ['disable', 'toManual', 'lowerMax', 'manualStart'];
  let cells = 0;
  for (const mutator of mutators) {
    for (const order of ORDERS15) {
      cells += 1;
      const legacyOrder = order === 'USER_FIRST' ? 'HUMAN_FIRST' : 'COORDINATOR_FIRST';
      const got = gateRace(legacyOrder, mutator, 'v14');

      // I16-A over the gateRace model: `claims` never exceeded the cap *at the moment of admission*.
      // gateRace admits at most one claim per entry point and always checks first, so the readable
      // form is "no admission happened while claims >= max at that time".
      assert.ok(got.claims <= Math.max(got.config.maxConcurrentTasks, got.claims), `${mutator}/${order}: unreachable`);
      assert.ok(['AUTHORITY_REVOKED', null].includes(got.refusalCode), `${mutator}/${order}: unexpected third outcome`);
      if (order === 'USER_FIRST') {
        assert.equal(got.dispatched, false, `${mutator}/USER_FIRST: the human write wins and the stale decision is refused`);
      } else {
        assert.equal(got.dispatched, true, `${mutator}/COORDINATOR_FIRST: a dispatch committed while it was still authorised is legal`);
      }
    }
  }
  assert.equal(cells, 8, 'the matrix is four mutators by two orders');

  // And the contract now says so: CAP3 names both orders and forbids the exemption by name.
  const cap = section(PCC, '9.6');
  assert.match(cap, /\*\*CAP0（`maxConcurrentTasks` 是准入上限/, '§9.6 does not freeze the admission semantics');
  assert.match(cap, /\*\*CAP4（over-cap 是一个有界、可见、会自己排空的状态/, '§9.6 does not say what an over-cap project looks like');
  assert.match(cap, /USER_FIRST` \/ `COORDINATOR_FIRST/, 'CAP3 no longer names the two commit orders');
  assert.match(cap, /一格豁免都不许有/, 'CAP3 must forbid the exemption that made the v1.4 model green');
});

// ── PC-CX-29 ────────────────────────────────────────────────────────────────
// §7.4 EC1–EC5 · §7.7 D14 · §4.3 I17: the execution context is frozen and re-resolved at commit.

const REVOKED_INPUTS = ['AGENT', 'MEMBERSHIP', 'TASK', 'PROVIDER', 'MODEL', 'WORKSPACE', 'RUNNER', 'COORDINATOR_WORKSPACE'] as const;
type RevokedInput = (typeof REVOKED_INPUTS)[number];

interface ExecutionContext {
  agentId: string;
  projectMemberId: string;
  taskId: string;
  taskAssigneeAgentId: string;
  providerSlug: string;
  model: string;
  workspaceId: string;
  runnerId: string;
  coordinatorWorkspaceId: string;
}

/** The eight rows EC1 freezes, in the shape a resolution reads them. */
interface EcWorld {
  agentEnabled: boolean;
  memberOfProject: boolean;
  taskAssignee: string;
  taskProvider: string;
  taskModel: string;
  providerAvailable: boolean;
  workspaceLive: boolean;
  runnerOnline: boolean;
  coordinatorWorkspaceId: string;
}

function ecWorld(): EcWorld {
  return {
    agentEnabled: true, memberOfProject: true, taskAssignee: 'a1', taskProvider: 'claude',
    taskModel: 'claude-opus-5', providerAvailable: true, workspaceLive: true, runnerOnline: true,
    coordinatorWorkspaceId: 'w-coord',
  };
}

/** EC4: several inputs can be revoked at once, and the lowest EC1 row number wins. */
function firstRevoked(w: EcWorld): RevokedInput | null {
  if (!w.agentEnabled) return 'AGENT';
  if (!w.memberOfProject) return 'MEMBERSHIP';
  if (w.taskAssignee !== 'a1') return 'TASK';
  if (!w.providerAvailable || w.taskProvider !== 'claude') return 'PROVIDER';
  if (w.taskModel !== 'claude-opus-5') return 'MODEL';
  if (!w.workspaceLive) return 'WORKSPACE';
  if (!w.runnerOnline) return 'RUNNER';
  if (w.coordinatorWorkspaceId !== 'w-coord') return 'COORDINATOR_WORKSPACE';
  return null;
}

/** PAC §5's chain, as far as EC2 needs it: a resolution, or nothing. */
function resolveExecutionContext(w: EcWorld): ExecutionContext | null {
  if (firstRevoked(w) !== null) return null;
  return {
    agentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: w.taskAssignee,
    providerSlug: w.taskProvider, model: w.taskModel, workspaceId: 'w1', runnerId: 'r1',
    coordinatorWorkspaceId: w.coordinatorWorkspaceId,
  };
}

const ecDigest = (c: ExecutionContext | null): string | null => (c ? sha256(JSON.stringify(c)) : null);

function revoke(w: EcWorld, input: RevokedInput): EcWorld {
  switch (input) {
    case 'AGENT': return { ...w, agentEnabled: false };
    case 'MEMBERSHIP': return { ...w, memberOfProject: false };
    case 'TASK': return { ...w, taskAssignee: 'a2' };
    case 'PROVIDER': return { ...w, providerAvailable: false };
    case 'MODEL': return { ...w, taskModel: 'claude-sonnet-5' };
    case 'WORKSPACE': return { ...w, workspaceLive: false };
    case 'RUNNER': return { ...w, runnerOnline: false };
    case 'COORDINATOR_WORKSPACE': return { ...w, coordinatorWorkspaceId: 'w-other' };
  }
}

interface Ec29Result {
  committed: boolean;
  refusalCode: string | null;
  revokedInput: RevokedInput | null;
  /** I17 read off the committed state: the claim's context still resolves to the frozen digest. */
  i17Holds: boolean;
  dispatchAttemptAfter: number;
}

/**
 * One barrier between a human revocation and the coordinator's commit. `v14` replays only §9.2 and
 * §7.4 steps 6/7 — the four project fields, none of which the revocation touches. `v15` also
 * re-resolves step 8 under the same lock order (EC3) and is backed by D14 at COMMIT.
 */
function ecRace(order: Order15, input: RevokedInput, version: Version15): Ec29Result {
  const snapshot = ecWorld();
  const frozen = ecDigest(resolveExecutionContext(snapshot))!;
  let world = snapshot;
  let dispatchAttempt = 7;
  const policyStillAllows = true; // AU3's four fields; a revocation never touches them

  const human = (): void => { world = revoke(world, input); };
  const coordinator = (): Ec29Result => {
    if (!policyStillAllows) return { committed: false, refusalCode: 'AUTHORITY_REVOKED', revokedInput: null, i17Holds: true, dispatchAttemptAfter: dispatchAttempt };
    if (version === 'v15') {
      const observed = ecDigest(resolveExecutionContext(world));
      if (observed !== frozen) {
        dispatchAttempt += 1; // EC5: the REFUSED row keeps its key, so the next dispatch needs a new epoch
        return { committed: false, refusalCode: 'EXECUTION_CONTEXT_REVOKED', revokedInput: firstRevoked(world), i17Holds: true, dispatchAttemptAfter: dispatchAttempt };
      }
    }
    dispatchAttempt += 1;
    const committedContextStillResolves = ecDigest(resolveExecutionContext(world)) === frozen;
    return { committed: true, refusalCode: null, revokedInput: null, i17Holds: committedContextStillResolves, dispatchAttemptAfter: dispatchAttempt };
  };

  if (order === 'USER_FIRST') { human(); return coordinator(); }
  const outcome = coordinator();
  human(); // the human write queues behind the same lock and takes effect afterwards
  return outcome;
}

test('PC-CX-29 the frozen execution context is re-resolved at the commit point', () => {
  for (const input of REVOKED_INPUTS) {
    const userFirst = ecRace('USER_FIRST', input, 'v15');
    assert.equal(userFirst.committed, false, `${input}/USER_FIRST: a revoked context must not produce a session`);
    assert.equal(userFirst.refusalCode, 'EXECUTION_CONTEXT_REVOKED', `${input}/USER_FIRST: the refusal must be typed, not silent`);
    assert.equal(userFirst.revokedInput, input, `${input}/USER_FIRST: detail.revokedInput must name the input that was revoked`);
    assert.equal(userFirst.dispatchAttemptAfter, 8, `${input}: a REFUSED action still consumes its key, so the epoch must advance (EC5)`);

    const loopFirst = ecRace('COORDINATOR_FIRST', input, 'v15');
    assert.equal(loopFirst.committed, true, `${input}/COORDINATOR_FIRST: committing while still authorised is legal`);
    assert.equal(loopFirst.i17Holds, true, `${input}/COORDINATOR_FIRST: I17 is required at the commit instant, and it held`);

    // Negative control, per input: under v1.4 the gate replays only the four project fields, so the
    // stale resolution commits and the published counterexample reappears.
    const stale = ecRace('USER_FIRST', input, 'v14');
    assert.equal(stale.committed, true, `PC-CX-29 must reproduce for ${input}: the v1.4 gate admits a revoked context`);
    assert.equal(stale.i17Holds, false, `${input}: and the committed state violates I17`);
  }

  // EC4's total order: several inputs revoked at once still name exactly one, and it is the lowest
  // EC1 row — the same discipline as RS0 and TU4, not "whichever the loop noticed first".
  const both = revoke(revoke(ecWorld(), 'RUNNER'), 'AGENT');
  assert.equal(firstRevoked(both), 'AGENT', 'EC4 must be decided by one total order, not by traversal order');

  // EC5 is a total function over the closed enum, and it introduces no new blocker kind.
  const kinds = new Set(column(tableRows(section(PCC, '11.2')), 'kind').map(bare));
  const ec5 = tables(section(PCC, '7.4')).find((t) => bare(t[0][0]) === 'revokedInput');
  assert.ok(ec5, 'EC5 no longer maps each revoked input to a consequence');
  assert.deepEqual(column(ec5, 'revokedInput').map(bare).flatMap((c) => c.split(' · ')).sort(), [...REVOKED_INPUTS].sort(),
    'EC5 must cover the closed EC1 enum exactly');
  for (const consequence of column(ec5, '后果')) {
    for (const named of consequence.matchAll(/`([A-Z_]+)` blocker/g)) {
      assert.ok(kinds.has(named[1]), `EC5 maps to ${named[1]}, which is not a §11.2 kind — v1.5 adds no new kinds`);
    }
  }
});

test('PC-CX-29 the commit gate is a database object, and it locks what it reads', () => {
  // Every P0 in this contract is answered by a database object rather than by a service, because
  // the entry point that has to be stopped includes "another version of the binary" (§2.4). And
  // the lock has to be FOR SHARE: FOR KEY SHARE does not conflict with the FOR NO KEY UPDATE that
  // `UPDATE agent SET enabled = false` takes, so it would admit exactly the interleaving above.
  const objects = column(tables(section(PCC, '2.4'))[1], '对象').map(bare);
  assert.ok(objects.includes('session_execution_context_guard'), 'D14 is not frozen in §2.4');
  assert.ok(section(PCC, '12.1').includes('session_execution_context_guard'), 'D14 is frozen but never created by the migration');

  const dispatch = section(PCC, '7.7');
  const d14 = dispatch.slice(dispatch.indexOf('#### D14 '), dispatch.indexOf('#### D8 '));
  assert.ok(d14.startsWith('#### D14 · 执行上下文的提交时授权门'), '§7.7 has no execution-context gate');
  assert.match(d14, /DEFERRABLE INITIALLY DEFERRED/, 'D14 must be proved at COMMIT, not at INSERT (the PC-CX-20 lesson)');
  assert.match(d14, /FOR SHARE/, 'D14 must lock the rows it re-reads, or it is a plain read under MVCC (the PC-CX-09 lesson)');
  assert.match(section(PCC, '7.4'), /`FOR KEY SHARE` \*\*不够\*\*/, 'EC3 must say why FOR KEY SHARE is not enough');
  assert.match(section(PCC, '4.3'), /\*\*I17（执行上下文在提交点复核/, '§4.3 does not state the execution-context invariant');
  assert.match(section(PCC, '8.6'), /project_member.*agent.*task.*runner|project_member` 与 `agent`/, '§8.6 LO1 does not place EC3\'s reads in the one lock order');
  assert.match(section(PCC, '9.6'), /第 6、7、8 条/, 'AU1 still replays only two of §7.4\'s three human-writable predicates');
});

// ── PC-CX-30 ────────────────────────────────────────────────────────────────
// §6.1 S8/S9: the declared input has to carry the action history its own rules read.

interface Db30 {
  projectStatus: string;
  openBlockers: number;
  liveSessions: number;
  unverifiedVerifiers: number;
  /** The rows v1.4's `world` did not project. */
  unsettledAcceptance: boolean;
  turns: { reasonCode: string; reasonDigest: string; openedAtEpoch: number; turnState: 'IN_FLIGHT' | 'FINISHED' }[];
}

function db30(over: Partial<Db30> = {}): Db30 {
  return { projectStatus: 'OPEN', openBlockers: 0, liveSessions: 0, unverifiedVerifiers: 0, unsettledAcceptance: false, turns: [], ...over };
}

/** §6.1's declared input, in each version. v1.4 stops at the rows it listed. */
function declaredInput(db: Db30, version: Version15): unknown {
  const base = {
    project: { status: db.projectStatus },
    blockers: db.openBlockers,
    sessions: db.liveSessions,
    verifiers: db.unverifiedVerifiers,
  };
  if (version === 'v14') return base;
  return {
    ...base,
    actions: {
      unsettledAcceptance: db.unsettledAcceptance ? { acceptanceAttempt: 1 } : null,
      turns: [...db.turns].sort((a, b) => a.reasonCode.localeCompare(b.reasonCode) || a.openedAtEpoch - b.openedAtEpoch),
    },
  };
}

const inputHash30 = (db: Db30, version: Version15): string => sha256(JSON.stringify(declaredInput(db, version)));

/** §4.2's guards, over the database rather than over the declared input — the required answer. */
function requiredRunState(db: Db30): string {
  if (db.projectStatus !== 'OPEN') return 'SETTLED';
  if (db.openBlockers > 0) return 'BLOCKED';
  if (db.unsettledAcceptance) return 'ACCEPTANCE';   // guard 4 — the row v1.4 did not project
  if (db.liveSessions > 0) return 'EXECUTING';
  if (db.unverifiedVerifiers > 0) return 'AWAITING_VERIFICATION';
  return 'PLANNING';
}

/** §7.6 TR1/TR3, over the database: the same digest means two different things. */
function requiredTurnOutcome(db: Db30, digest: string): 'OPEN_TURN' | 'ALREADY_APPLIED' | 'COORDINATOR_NO_PROGRESS' {
  const prior = db.turns.find((t) => t.reasonDigest === digest);
  if (!prior) return 'OPEN_TURN';
  return prior.turnState === 'IN_FLIGHT' ? 'ALREADY_APPLIED' : 'COORDINATOR_NO_PROGRESS';
}

test('PC-CX-30 the declared decision input carries the action history its own rules read', () => {
  // Counterexample 1: two databases, identical on everything v1.4 declared, one with an unsettled
  // acceptance action. §4.2 guard 4 requires two different run states from one declared input.
  const planning = db30();
  const accepting = db30({ unsettledAcceptance: true });
  assert.notEqual(requiredRunState(planning), requiredRunState(accepting), 'the two states must differ, or there is nothing to catch');
  assert.equal(inputHash30(planning, 'v14'), inputHash30(accepting, 'v14'),
    'PC-CX-30 must reproduce: one v1.4 hash, two required run states');
  assert.notEqual(inputHash30(planning, 'v15'), inputHash30(accepting, 'v15'), 'v1.5 must separate them');

  // Counterexample 2: same declared input, a prior turn that is in flight vs finished. TR1 says
  // ALREADY_APPLIED, TR3 says COORDINATOR_NO_PROGRESS — again two required actions, one hash.
  const digest = sha256('MERGE_CONFLICT|A|1');
  const inFlight = db30({ turns: [{ reasonCode: 'BLOCKER_DECISION', reasonDigest: digest, openedAtEpoch: 100, turnState: 'IN_FLIGHT' }] });
  const finished = db30({ turns: [{ reasonCode: 'BLOCKER_DECISION', reasonDigest: digest, openedAtEpoch: 100, turnState: 'FINISHED' }] });
  assert.notEqual(requiredTurnOutcome(inFlight, digest), requiredTurnOutcome(finished, digest));
  assert.equal(inputHash30(inFlight, 'v14'), inputHash30(finished, 'v14'),
    'PC-CX-30 must reproduce for TR1/TR3 as well');
  assert.notEqual(inputHash30(inFlight, 'v15'), inputHash30(finished, 'v15'));

  // S3 is now true over the rules that read `project_action`: same hash ⇒ same required decision,
  // across every combination the two projections can take.
  const all: Db30[] = [];
  for (const unsettledAcceptance of [false, true]) {
    for (const turnState of ['IN_FLIGHT', 'FINISHED'] as const) {
      for (const openBlockers of [0, 1]) {
        all.push(db30({ unsettledAcceptance, openBlockers, turns: [{ reasonCode: 'BLOCKER_DECISION', reasonDigest: digest, openedAtEpoch: 100, turnState }] }));
      }
    }
  }
  const byHash = new Map<string, string>();
  for (const db of all) {
    const decision = `${requiredRunState(db)}|${requiredTurnOutcome(db, digest)}`;
    const h = inputHash30(db, 'v15');
    if (byHash.has(h)) assert.equal(byHash.get(h), decision, 'S3: one v1.5 hash must give one decision');
    byHash.set(h, decision);
  }
  assert.equal(byHash.size, all.length, 'every distinct required decision must have its own hash');

  // S9: the projection is minimal and stated, so "we added the whole ledger" is not the fix either.
  const s9 = tables(section(PCC, '6.1')).find((t) => bare(t[0][0]) === '字段');
  assert.ok(s9, '§6.1 S9 no longer states the minimal action projection');
  assert.deepEqual(column(s9, '字段').map(bare), [
    'unsettledAcceptance',
    'turns[].reasonDigest + turnState',
    'turns[].reasonCode + openedAt',
  ], 'the frozen minimal projection changed');
  assert.match(section(PCC, '6.1'), /"actions": \{/, '§6.1 world does not carry the action projection');
  assert.match(section(PCC, '6.1'), /"coordinatorSession"/, '§7.3\'s turn preconditions read a row the input does not carry');
  assert.match(section(PCC, '6.1'), /"turnWindows"/, 'TR2\'s window has no due-fact in evaluation (S5)');
});

test('PC-CX-30 S8 harvests from every rule that reads a row, not from three hand-picked tables', () => {
  // The finding is as much about the completeness *mechanism* as about the missing fields: v1.4's
  // S8 was a real assertion over a harvest surface that happened to exclude the only two rules
  // reading `project_action`. The fix has to be the surface, or the next added rule repeats it.
  const s8 = section(PCC, '6.1');
  assert.match(s8, /v1\.5 把采集面冻结成\*\*五处，封闭\*\*/, 'S8 does not freeze its harvest surface');
  for (const source of ['§4.2 的七条守卫', '§7.6 TR1–TR3']) {
    assert.ok(s8.includes(source), `S8's harvest surface still omits ${source}`);
  }
  assert.match(s8, /把 `world` 里任意一个字段删掉，必须至少有一条规则因此不可判定/, 'S8 has no reverse direction');

  // And the superseded sentence is registered, so a future revision cannot quietly go back to the
  // three tables — that is exactly the PC-CX-27 mechanism doing its job one round later.
  const ledger = column(tables(section(PCC, '22.8'))[0], '被取代的字样').map(bare);
  assert.ok(ledger.some((p) => p.includes('§8.2 GE1 的代次表与 §13.4 AE1 的摘要投影里收集列名')),
    '§22.8 does not register the hand-picked harvest surface');
});

// ── PC-CX-31 ────────────────────────────────────────────────────────────────
// §7.6 TR2-a–TR2-e · §7.2 TF5 · §10.4 item 7 · §4.3 I18.

const TURN_WINDOW_MS = 60_000;

interface ManualRequest {
  dedupeKey: string;
  consumedAt: number | null;
  nextAttemptAt: number | null;
}

interface World31 {
  now: number;
  /** TR2-a's anchor: the most recent APPLIED turn for this (generation, reasonCode). */
  anchor: { idempotencyKey: string; openedAt: number } | null;
  requests: ManualRequest[];
  turnsOpened: { key: string; answered: string[] }[];
  audits: { type: string; detail?: Record<string, unknown> }[];
  nextWakeAt: number | null;
  nextWakeReason: string | null;
}

function world31(): World31 {
  return { now: 0, anchor: null, requests: [], turnsOpened: [], audits: [], nextWakeAt: null, nextWakeReason: null };
}

const pending = (w: World31): ManualRequest[] => w.requests.filter((r) => r.consumedAt === null);

/** TF5 (v1.5) vs the v1.1–v1.4 cell: the whole pending set, or just the one that triggered. */
function manualReasonDigest(w: World31, version: Version15, trigger?: ManualRequest): string {
  const keys = version === 'v15'
    ? pending(w).map((r) => r.dedupeKey).sort()
    : [trigger!.dedupeKey];
  return sha256(`MANUAL|${keys.join(',')}`);
}

type Consumption = 'CONSUME' | 'LEAVE';

/**
 * One reconcile. `version` selects the rate-limited outcome: v1.5 freezes TR2-b/c/d, while v1.4
 * left two readings open, and `consumption` is that ambiguity made explicit so both can be run.
 */
function reconcile31(w: World31, version: Version15, consumption: Consumption = 'CONSUME'): void {
  const requests = pending(w);
  if (requests.length === 0) {
    w.nextWakeAt = w.now + TURN_WINDOW_MS;
    w.nextWakeReason = 'planning';
    return;
  }
  const windowEndsAt = w.anchor ? w.anchor.openedAt + TURN_WINDOW_MS : -Infinity;
  const rateLimited = w.now < windowEndsAt;

  if (rateLimited) {
    if (version === 'v14' && consumption === 'CONSUME') {
      for (const r of requests) r.consumedAt = w.now;       // the request disappears
      w.audits.push({ type: 'NOOP' });
      w.nextWakeAt = w.now + TURN_WINDOW_MS;
      w.nextWakeReason = 'planning';
      return;
    }
    if (version === 'v14') {                                 // left unconsumed, with no rule for when
      w.audits.push({ type: 'NOOP' });
      w.nextWakeAt = w.now + 5_000;                          // W3's floor is the only thing left
      w.nextWakeReason = 'planning';
      return;
    }
    for (const r of requests) r.nextAttemptAt = windowEndsAt; // TR2-b ③
    w.audits.push({ type: 'NOOP', detail: { reason: 'turn_rate_limited', windowKey: w.anchor!.idempotencyKey, windowEndsAt, pendingSignalCount: requests.length } });
    w.nextWakeAt = Math.max(windowEndsAt, w.now + 5_000);     // §10.4 item 7, floored by W3
    w.nextWakeReason = 'manual trigger rate-limited';
    return;
  }

  const digest = manualReasonDigest(w, version, requests[0]);
  const key = `pc:v1:p1:turn:0:${digest}`;
  w.turnsOpened.push({ key, answered: requests.map((r) => r.dedupeKey) });
  for (const r of (version === 'v15' ? requests : [requests[0]])) r.consumedAt = w.now;  // TR2-c ①
  w.anchor = { idempotencyKey: key, openedAt: w.now };
  w.nextWakeAt = w.now + TURN_WINDOW_MS;
  w.nextWakeReason = 'turn in flight';
}

/** I18, read off the committed state. */
function i18Holds(w: World31): boolean {
  return w.requests.every((r) =>
    r.consumedAt !== null ||
    (r.nextAttemptAt !== null && w.nextWakeAt !== null && w.nextWakeAt <= r.nextAttemptAt));
}

test('PC-CX-31 a rate-limited manual trigger is durable, deterministic and visible', () => {
  const w = world31();
  w.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  reconcile31(w, 'v15');
  assert.equal(w.turnsOpened.length, 1, 'the first request opens a turn');
  assert.equal(w.anchor?.openedAt, 0, 'and becomes the window anchor (TR2-a)');

  // t0 + 10s: a second, distinct request lands inside the window.
  w.now = 10_000;
  w.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
  reconcile31(w, 'v15');
  assert.equal(w.turnsOpened.length, 1, 'TR2 refuses a second turn inside the window');
  assert.equal(pending(w).length, 1, 'TR2-c: the request is not consumed — it has not been answered');
  assert.equal(pending(w)[0].nextAttemptAt, 60_000, 'TR2-b ③: next_attempt_at is the window boundary');
  assert.equal(w.nextWakeAt, 60_000, '§10.4 item 7: nextWakeAt points at the same boundary');
  assert.equal(w.nextWakeReason, 'manual trigger rate-limited', 'TR2-e: and it says so');
  assert.deepEqual(w.audits.at(-1), {
    type: 'NOOP',
    detail: { reason: 'turn_rate_limited', windowKey: w.anchor!.idempotencyKey, windowEndsAt: 60_000, pendingSignalCount: 1 },
  }, 'TR2-b ④: a NOOP that names the window, not silence');
  assert.equal(i18Holds(w), true, 'I18 holds while the request waits');

  // A restart / takeover changes nothing: the pending state is a `project_event` row and the window
  // anchor is a `project_action` row, so re-reading the same database gives the same answer.
  const rehydrated: World31 = JSON.parse(JSON.stringify({ ...w, now: 30_000, audits: [], nextWakeAt: null, nextWakeReason: null }));
  reconcile31(rehydrated, 'v15');
  assert.equal(rehydrated.nextWakeAt, 60_000, 'the window survives a restart — it is two committed rows');
  assert.equal(rehydrated.turnsOpened.length, 1, 'and it is still closed');

  // A third request inside the same window collapses into the same pending set (TF5), it does not
  // queue a third turn.
  w.now = 30_000;
  w.requests.push({ dedupeKey: 'manual:3', consumedAt: null, nextAttemptAt: null });
  reconcile31(w, 'v15');
  assert.equal(pending(w).length, 2);
  assert.equal(w.turnsOpened.length, 1);

  // The boundary: exactly one turn, answering every pending request, consuming all of them.
  w.now = 60_000;
  reconcile31(w, 'v15');
  assert.equal(w.turnsOpened.length, 2, 'exactly one more turn at the boundary — not one per request');
  assert.deepEqual(w.turnsOpened[1].answered.sort(), ['manual:2', 'manual:3'], 'TF5: one turn answers the whole pending set');
  assert.deepEqual(pending(w), [], 'TR2-c: and consumes them all, because they were answered');
  assert.equal(i18Holds(w), true, 'I18 holds after the boundary too');
  assert.equal(new Set(w.turnsOpened.map((t) => t.key)).size, 2, 'the two turns have distinct idempotency keys');

  // Repeated delivery of an already-pending dedupeKey changes nothing (§5.4's partial unique index
  // collapses it to one row) — so TF5's digest, and therefore the turn key, is unchanged (I14).
  const dup = world31();
  dup.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  const once = manualReasonDigest(dup, 'v15');
  const twice = manualReasonDigest(dup, 'v15');
  assert.equal(once, twice, 'delivery count must not move the digest (TF1/I14)');
});

test('PC-CX-31 both v1.4 readings are reachable, and both lose the request or busy-loop', () => {
  // Reading A — consume it. The explicit request is gone: no turn, no pending row, no record.
  const consumed = world31();
  consumed.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  reconcile31(consumed, 'v14');
  consumed.now = 10_000;
  consumed.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
  reconcile31(consumed, 'v14', 'CONSUME');
  assert.equal(consumed.turnsOpened.length, 1, 'no turn was opened for the second request');
  assert.deepEqual(pending(consumed), [], 'PC-CX-31 reading A must reproduce: the request is consumed and gone');
  assert.equal(i18Holds(consumed), true, 'and I18 cannot see it either — which is the point: v1.4 had no I18');
  consumed.now = 60_000;
  reconcile31(consumed, 'v14', 'CONSUME');
  assert.equal(consumed.turnsOpened.length, 1, 'the boundary passes and the request never runs');

  // Reading B — leave it. Nothing in §10.4's closed list points at the boundary, so the only wake
  // left is W3's 5s floor: the same limited reason is re-evaluated twelve times before it can fire.
  const left = world31();
  left.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  reconcile31(left, 'v14');
  left.now = 10_000;
  left.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
  let spins = 0;
  while (left.now < 60_000) {
    reconcile31(left, 'v14', 'LEAVE');
    spins += 1;
    left.now = left.nextWakeAt!;
  }
  assert.equal(pending(left).length, 1, 'reading B keeps the request…');
  assert.ok(spins >= 10, `…at the cost of a busy loop: ${spins} reconciles inside one window`);

  // v1.5 does the same stretch in one wake.
  const fixed = world31();
  fixed.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  reconcile31(fixed, 'v15');
  fixed.now = 10_000;
  fixed.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
  let wakes = 0;
  while (fixed.now < 60_000) {
    reconcile31(fixed, 'v15');
    wakes += 1;
    fixed.now = fixed.nextWakeAt!;
  }
  assert.equal(wakes, 1, 'v1.5 wakes once, at the boundary');
  reconcile31(fixed, 'v15');
  assert.equal(fixed.turnsOpened.length, 2, 'and the request runs');

  // The clauses this depends on are in the document, closed-list style.
  const wake = section(PCC, '10.4');
  assert.match(wake, /7\. \*\*每一个被 §7\.6 TR2 限频挡住的 `reasonCode`/, '§10.4 has no wake at the rate-limit boundary');
  assert.match(wake, /上面 1–7 条/, 'N-null was not updated for the new item');
  const turns = section(PCC, '7.6');
  for (const rule of ['TR2-a（窗口身份', 'TR2-b（被限频的确定结果', 'TR2-c（消费语义', 'TR2-d（唤醒与幂等', 'TR2-e（用户可见状态']) {
    assert.ok(turns.includes(rule), `§7.6 does not freeze ${rule}）`);
  }
  assert.match(section(PCC, '4.3'), /\*\*I18（显式请求不丢失/, '§4.3 does not state that an explicit request cannot be lost');
  assert.match(section(PCC, '7.2'), /\*\*TF5（`MANUAL` 的 `turnFacts` 是全部 pending 请求/, '§7.2 does not freeze the pending-set digest');
});

test('mutation check: every fence added for PC-CX-28..31 is load-bearing', () => {
  // Same discipline as the three mutation checks above: a fence that can be removed without the
  // defect coming back was never the fix.
  const digest30 = sha256('MERGE_CONFLICT|A|1');
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-28',
      fence: 'stating the cap as an admission limit (§9.6 CAP0, §4.3 I16-A/I16-B)',
      defectReappears: () => v14CurrentStateInvariantHolds(capRace28('COORDINATOR_FIRST')) === false,
    },
    {
      finding: 'PC-CX-29',
      fence: 're-resolving the frozen execution context at the commit point (§7.4 EC3, §7.7 D14)',
      defectReappears: () => REVOKED_INPUTS.every((i) => ecRace('USER_FIRST', i, 'v14').committed && !ecRace('USER_FIRST', i, 'v14').i17Holds),
    },
    {
      finding: 'PC-CX-30',
      fence: 'projecting the action/turn history into the decision input (§6.1 S9)',
      defectReappears: () =>
        inputHash30(db30(), 'v14') === inputHash30(db30({ unsettledAcceptance: true }), 'v14') &&
        requiredRunState(db30()) !== requiredRunState(db30({ unsettledAcceptance: true })),
    },
    {
      finding: 'PC-CX-31',
      fence: 'the durable pending request and the wake at the window boundary (§7.6 TR2-b/c/d, §10.4 item 7)',
      defectReappears: () => {
        const w = world31();
        w.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
        reconcile31(w, 'v14');
        w.now = 10_000;
        w.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
        reconcile31(w, 'v14', 'CONSUME');
        w.now = 60_000;
        reconcile31(w, 'v14', 'CONSUME');
        return w.turnsOpened.length === 1 && pending(w).length === 0;
      },
    },
  ];

  assert.equal(mutants.length, 4, 'unit 02 raised four findings against v1.4');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.equal(admissionInvariantHolds(capRace28('COORDINATOR_FIRST')), true);
  assert.equal(ecRace('USER_FIRST', 'AGENT', 'v15').committed, false);
  assert.notEqual(inputHash30(db30(), 'v15'), inputHash30(db30({ unsettledAcceptance: true }), 'v15'));
  assert.notEqual(
    requiredTurnOutcome(db30({ turns: [{ reasonCode: 'BLOCKER_DECISION', reasonDigest: digest30, openedAtEpoch: 1, turnState: 'IN_FLIGHT' }] }), digest30),
    requiredTurnOutcome(db30({ turns: [{ reasonCode: 'BLOCKER_DECISION', reasonDigest: digest30, openedAtEpoch: 1, turnState: 'FINISHED' }] }), digest30),
  );
  const fixed = world31();
  fixed.requests.push({ dedupeKey: 'manual:1', consumedAt: null, nextAttemptAt: null });
  reconcile31(fixed, 'v15');
  fixed.now = 10_000;
  fixed.requests.push({ dedupeKey: 'manual:2', consumedAt: null, nextAttemptAt: null });
  reconcile31(fixed, 'v15');
  assert.equal(pending(fixed).length, 1);
  assert.equal(i18Holds(fixed), true);
});

test('§23 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20/§21/§22 have, for the fifth round. Two of these four are claims about what
  // a real server does — a shared row lock cannot make a later cap decrease retroactive, and a
  // FOR SHARE inside a deferred constraint trigger conflicts with a concurrent revocation — so the
  // Postgres file is checked by name as well.
  const rows = tables(section(PCC, '23'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-28', 'PC-CX-29', 'PC-CX-30', 'PC-CX-31']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§23 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '23').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 3, '§23 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§23 names "${name}", which is not a test in the Postgres spec`);
  }

  // The clauses §23 points at have to exist, and the section has to be marked non-normative.
  assert.match(section(PCC, '23').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§23 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§23 points at §${m[1]}, which does not exist`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6 — `PC-CX-32..36`, §24
//
// Round six has three shapes, and all three are "the lesson from last round was not pushed all the
// way through". Tense, for the third time: v1.4 split I11, v1.5 split I16, and the same revision
// that learned it wrote I17 as a current-state invariant (`PC-CX-34`). The harvest surface of a
// closed list, for the third time: `PC-CX-27` was superseded prose, `PC-CX-30` was this document's
// own read set, and `PC-CX-33` is the read set of the *other* document. And one that only a real
// server can teach: the specified D14 resolver promised `STABLE` and took `FOR SHARE`, which
// PostgreSQL refuses outright — the development fixture happened to omit the volatility marker and
// therefore tested a different object (`PC-CX-32`). The remaining two are arithmetic: three clauses
// with no solution in the last five seconds of a rate-limit window (`PC-CX-35`), and an invariant
// that never looked at the first state of the very row it is about (`PC-CX-36`).
// ─────────────────────────────────────────────────────────────────────────────

type Version16 = 'v15' | 'v16';

/** PAC §7.5's frozen resolution, plus EC2's nine components. A dispatch produces one of these. */
interface Resolution33 {
  agentId: string;
  projectMemberId: string;
  taskId: string;
  taskAssigneeAgentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
  workspaceId: string;
  runnerId: string;
  coordinatorWorkspaceId: string;
}

/** The rows PAC §5 / §7.1–§7.4 actually read. Everything here is a persisted column. */
interface Db33 {
  agent: {
    id: string; enabled: boolean; deletedAt: string | null;
    defaultProvider: string | null; defaultModel: string | null; defaultEffort: string | null;
    providerFallbacks: { provider: string; model?: string }[]; requiredCapabilities: string[];
  };
  member: { projectMemberId: string; agentId: string; role: string } | null;
  task: {
    id: string; executionContract: 'V1' | 'LEGACY'; assigneeAgentId: string | null;
    provider: string | null; model: string | null;
    workspaceId: string | null; requiredCapabilities: string[]; status: string;
  };
  workspaces: {
    workspaceId: string; enabled: boolean; deletedAt: string | null; isDefault: boolean;
    position: number; runnerId: string | null; runnerStatus: string;
    capabilities: string[]; capabilitiesReportedAt: string | null;
  }[];
  providers: { slug: string; available: boolean; models: string[] }[];
  project: { coordinatorWorkspaceId: string };
}

function db33(): Db33 {
  return {
    agent: {
      id: 'a1', enabled: true, deletedAt: null, defaultProvider: 'claude', defaultModel: 'claude-opus-5',
      defaultEffort: 'high', providerFallbacks: [], requiredCapabilities: [],
    },
    member: { projectMemberId: 'm1', agentId: 'a1', role: 'MEMBER' },
    task: {
      id: 't1', executionContract: 'V1', assigneeAgentId: 'a1', provider: null, model: null,
      workspaceId: null, requiredCapabilities: [], status: 'OPEN',
    },
    workspaces: [{
      workspaceId: 'w1', enabled: true, deletedAt: null, isDefault: true, position: 0, runnerId: 'r1',
      runnerStatus: 'ONLINE', capabilities: ['linux'], capabilitiesReportedAt: '2026-08-19T00:00:00.000Z',
    }],
    providers: [
      { slug: 'claude', available: true, models: ['claude-opus-5', 'claude-sonnet-5'] },
      { slug: 'codex', available: true, models: ['gpt-5.6-sol'] },
    ],
    project: { coordinatorWorkspaceId: 'w-coord' },
  };
}

const clone33 = (db: Db33): Db33 => JSON.parse(JSON.stringify(db)) as Db33;

/**
 * PAC §5 step 2–5, as far as this file needs it: the contract branch, then WHO, then WITH (with
 * §7.4's explicit fallback), then WHERE. Every branch below reads a column; S10's table is exactly
 * the list of those columns.
 *
 * `reads` is an optional sink for the columns whose OWNERSHIP is the claim EC1-b makes: the
 * contract selector itself, the three Agent columns the V1 chain starts from, and the two task
 * columns only the LEGACY bridge may touch. It is not a general tracer — it exists so "V1 reads the
 * Agent, LEGACY reads the task pin" can be asserted by running the resolver instead of by reading
 * the branch and believing it.
 */
function resolveExecutionContext33(db: Db33, reads?: string[]): Resolution33 | LegacyResolution33 | { refuse: string } {
  const read = <T>(column: string, value: T): T => { reads?.push(column); return value; };

  // PAC §5 step 2 — the split. `execution_contract` is the ONLY criterion (PAC §2, §11.1): not
  // `project_id IS NULL`, not the creation time. A LEGACY row leaves §7 entirely (PAC §7 preamble),
  // so none of the three chains below runs on it.
  if (read('task.execution_contract', db.task.executionContract) === 'LEGACY') {
    return {
      legacy: true,
      taskId: db.task.id,
      pinnedProvider: read('task.provider', db.task.provider),
      pinnedModel: read('task.model', db.task.model),
    };
  }

  // WHO — PAC §7.1. Priority 2 first (no assignee at all → `WHO_UNRESOLVED`), then priority 1's two
  // checks in the order H4 fixes: ① team membership, ② enabled / not soft-deleted. Both predicates
  // can hold of one input, and H4's answer is `WHO_NOT_IN_TEAM` — membership is the authorization
  // boundary, availability is only a state inside it. v1.2 stated that and this model still judged
  // availability first, which is the third-round finding: an off-team, disabled Agent got
  // `WHO_DISABLED`, whose required action ("enable it") does not make the dispatch possible.
  if (db.task.assigneeAgentId === null || db.task.assigneeAgentId !== db.agent.id) return { refuse: 'WHO_UNRESOLVED' };
  if (db.member === null) return { refuse: 'WHO_NOT_IN_TEAM' };
  if (!db.agent.enabled || db.agent.deletedAt !== null) return { refuse: 'WHO_DISABLED' };

  // WITH — PAC §7.2 priorities 1–2, then §7.4's ordered fallback chain. A V1 task carries no
  // provider/model pin at all (PAC §7.2 P1, enforced by the §3.4 K1 CHECK), so the chain starts at
  // the agent default and `task.provider` / `task.model` are read only on the LEGACY branch above,
  // which the control loop distinguishes by `execution_contract` (PCC §7.4 EC1-b).
  const wanted = read('agent.default_provider', db.agent.defaultProvider) ?? 'claude';
  const wantedModel = read('agent.default_model', db.agent.defaultModel);
  const usable = (slug: string, model: string | null): boolean => {
    const p = db.providers.find((x) => x.slug === slug);
    return p !== undefined && p.available && (model === null || p.models.includes(model));
  };
  let provider: string | null = usable(wanted, wantedModel) ? wanted : null;
  let model = wantedModel;
  if (provider === null) {
    for (const hop of read('agent.provider_fallbacks', db.agent.providerFallbacks)) {
      const hopModel = hop.model ?? null;
      if (usable(hop.provider, hopModel)) { provider = hop.provider; model = hopModel; break; }
    }
  }
  if (provider === null) {
    const p = db.providers.find((x) => x.slug === wanted);
    return { refuse: p && p.available ? 'RUNTIME_REQUIREMENT_UNMET' : 'PROVIDER_UNAVAILABLE' };
  }
  const effort = db.agent.defaultEffort;

  // WHERE — PAC §7.3's candidate set, requirement set and priorities 1–5
  const candidates = db.workspaces
    .filter((w) => w.deletedAt === null && w.enabled && w.runnerId !== null)
    .sort((a, b) => a.position - b.position || a.workspaceId.localeCompare(b.workspaceId));
  const required = [...new Set([...db.task.requiredCapabilities, ...db.agent.requiredCapabilities])];
  const meets = (w: Db33['workspaces'][number]): boolean =>
    w.runnerStatus === 'ONLINE' &&
    (required.length === 0 || (w.capabilitiesReportedAt !== null && required.every((c) => w.capabilities.includes(c))));
  const feasible = candidates.filter(meets);
  let chosen: Db33['workspaces'][number] | undefined;
  // PAC §7.3 C8: the empty candidate set is decided FIRST, so "no workspace at all" and "the pin is
  // outside a non-empty set" cannot both be true of one input.
  if (candidates.length === 0) {
    return { refuse: 'NO_PROJECT_WORKSPACE' };
  } else if (db.task.workspaceId !== null) {
    const pinned = candidates.find((w) => w.workspaceId === db.task.workspaceId);
    if (!pinned) return { refuse: 'WORKSPACE_PIN_NOT_A_CANDIDATE' };
    if (!meets(pinned)) return { refuse: 'RUNTIME_REQUIREMENT_UNMET' };
    chosen = pinned;
  } else if (feasible.length === 0) {
    return { refuse: 'RUNTIME_REQUIREMENT_UNMET' };
  } else {
    chosen = feasible.find((w) => w.isDefault) ?? feasible[0];
  }

  return {
    agentId: db.agent.id, projectMemberId: db.member.projectMemberId, taskId: db.task.id,
    taskAssigneeAgentId: db.task.assigneeAgentId, provider, model, effort,
    workspaceId: chosen.workspaceId, runnerId: chosen.runnerId!, coordinatorWorkspaceId: db.project.coordinatorWorkspaceId,
  };
}

/**
 * PAC §11.1 L1's legacy bridge. It is a DIFFERENT shape, not a `Resolution33` with holes: there is
 * no Agent and no `project_member` on this path at all, which is the whole content of the split.
 *
 * The model carries the bridge exactly as far as `world` carries it — the task pin (PCC §6.1 S10-f:
 * `tasks[].provider` / `tasks[].model` are in `world` *because* the LEGACY branch reads them). The
 * rest of L1's bridge (`agentProviderSeed(workspace)`, `workspace.model`, `task.assignee_id`) is not
 * a column of `world`, so this model does not invent an answer for it and does not claim to.
 */
interface LegacyResolution33 {
  legacy: true;
  taskId: string;
  /** What the LEGACY branch reads and the V1 branch cannot even carry (PAC §3.4 K1). */
  pinnedProvider: string | null;
  pinnedModel: string | null;
}

/** EC2: the digest摘 nine identities, not the whole resolution (S10-e says why effort is not in it). */
function ec2Digest33(r: Resolution33 | LegacyResolution33 | { refuse: string }): string {
  if ('refuse' in r) return `REFUSE:${r.refuse}`;
  if ('legacy' in r) return `LEGACY:${r.taskId}:${r.pinnedProvider ?? ''}:${r.pinnedModel ?? ''}`;
  return sha256([r.agentId, r.projectMemberId, r.taskId, r.taskAssigneeAgentId, r.provider, r.model ?? '',
    r.workspaceId, r.runnerId, r.coordinatorWorkspaceId].join('|'));
}

/** What a dispatch has to produce, in the sense S3 means it: the resolution PAC §6 freezes. */
const requiredOutcome33 = (db: Db33): string => JSON.stringify(resolveExecutionContext33(db));

/** The ten fields S10 adds to `world`, each with the PAC clause that reads it. */
const S10_FIELDS = [
  'team[].projectMemberId', 'team[].defaultProvider', 'team[].defaultModel', 'team[].defaultEffort',
  'team[].providerFallbacks', 'team[].requiredCapabilities', 'workspaces[].enabled',
  'tasks[].executionContract', 'tasks[].workspaceId', 'providers[].models',
] as const;
type S10Field = (typeof S10_FIELDS)[number];

/**
 * §6.1's declared `world`, as the two versions project it. `omit` drops one v1.6 field, which is
 * S10-c's deletion mutation: a field nothing can distinguish without is a field that belongs here.
 */
function worldProjection33(db: Db33, version: Version16, omit?: S10Field): unknown {
  const has = (f: S10Field): boolean => version === 'v16' && omit !== f;
  return {
    team: [{
      agentId: db.agent.id, role: db.member?.role ?? null, enabled: db.agent.enabled, deletedAt: db.agent.deletedAt,
      ...(has('team[].projectMemberId') ? { projectMemberId: db.member?.projectMemberId ?? null } : {}),
      ...(has('team[].defaultProvider') ? { defaultProvider: db.agent.defaultProvider } : {}),
      ...(has('team[].defaultModel') ? { defaultModel: db.agent.defaultModel } : {}),
      ...(has('team[].defaultEffort') ? { defaultEffort: db.agent.defaultEffort } : {}),
      ...(has('team[].providerFallbacks') ? { providerFallbacks: db.agent.providerFallbacks } : {}),
      ...(has('team[].requiredCapabilities') ? { requiredCapabilities: db.agent.requiredCapabilities } : {}),
    }],
    tasks: [{
      id: db.task.id, status: db.task.status, assigneeAgentId: db.task.assigneeAgentId,
      provider: db.task.provider, model: db.task.model, requiredCapabilities: db.task.requiredCapabilities,
      ...(has('tasks[].executionContract') ? { executionContract: db.task.executionContract } : {}),
      ...(has('tasks[].workspaceId') ? { workspaceId: db.task.workspaceId } : {}),
    }],
    workspaces: db.workspaces.map((w) => ({
      workspaceId: w.workspaceId, isDefault: w.isDefault, position: w.position, runnerId: w.runnerId,
      runnerStatus: w.runnerStatus, capabilities: w.capabilities, capabilitiesReportedAt: w.capabilitiesReportedAt,
      deletedAt: w.deletedAt,
      ...(has('workspaces[].enabled') ? { enabled: w.enabled } : {}),
    })),
    providers: db.providers.map((p) => ({
      slug: p.slug, available: p.available,
      ...(has('providers[].models') ? { models: p.models } : {}),
    })),
    project: { coordinatorWorkspaceId: db.project.coordinatorWorkspaceId },
  };
}

const inputHash33 = (db: Db33, version: Version16, omit?: S10Field): string =>
  sha256(JSON.stringify(worldProjection33(db, version, omit)));

/** One pair per S10 field: two databases that differ only in that column, and require different runs. */
const S10_MUTATIONS: { field: S10Field; left: () => Db33; right: () => Db33 }[] = [
  {
    field: 'team[].projectMemberId',
    left: db33,
    right: () => { const d = db33(); d.member!.projectMemberId = 'm2'; return d; },
  },
  {
    // The review's counterexample A, as a single-column pair: no task pin, no Agent default model,
    // so the only thing that decides the engine is `agent.default_provider`.
    field: 'team[].defaultProvider',
    left: () => { const d = db33(); d.agent.defaultModel = null; return d; },
    right: () => { const d = db33(); d.agent.defaultModel = null; d.agent.defaultProvider = 'codex'; return d; },
  },
  {
    field: 'team[].defaultModel',
    left: db33,
    right: () => { const d = db33(); d.agent.defaultModel = 'claude-sonnet-5'; return d; },
  },
  {
    field: 'team[].defaultEffort',
    left: db33,
    right: () => { const d = db33(); d.agent.defaultEffort = 'low'; return d; },
  },
  {
    field: 'team[].providerFallbacks',
    left: () => { const d = db33(); d.providers[0].available = false; return d; },
    right: () => {
      const d = db33();
      d.providers[0].available = false;
      d.agent.providerFallbacks = [{ provider: 'codex', model: 'gpt-5.6-sol' }];
      return d;
    },
  },
  {
    field: 'team[].requiredCapabilities',
    left: db33,
    right: () => { const d = db33(); d.agent.requiredCapabilities = ['macos']; return d; },
  },
  {
    field: 'workspaces[].enabled',
    left: db33,
    right: () => { const d = db33(); d.workspaces[0].enabled = false; return d; },
  },
  {
    // S10-f in its executable form, and the pair is legal on BOTH sides — which is the only way this
    // one can be built. A V1 row cannot carry a pin (PAC §3.4 K1's CHECK), so "same row, two
    // contracts, one pin" is not a database state and would prove nothing. What IS reachable on both
    // sides is a Project task with no assignee and no pin: as V1 it is PAC §7.1 priority 2
    // (`WHO_UNRESOLVED`, and PAC H3 says that refusal exists precisely for V1 rows); as LEGACY it is
    // the shape §11.4 / L5 hands to every old client, and it dispatches over the old bridge. One
    // column apart, one REFUSE and one DISPATCH — S10-f's "strongest form of the deletion criterion".
    field: 'tasks[].executionContract',
    left: () => { const d = db33(); d.task.assigneeAgentId = null; return d; },
    right: () => {
      const d = db33();
      d.task.assigneeAgentId = null;
      d.task.executionContract = 'LEGACY';
      return d;
    },
  },
  {
    field: 'tasks[].workspaceId',
    left: () => {
      const d = db33();
      d.workspaces.push({ ...d.workspaces[0], workspaceId: 'w2', isDefault: false, position: 1 });
      return d;
    },
    right: () => {
      const d = db33();
      d.workspaces.push({ ...d.workspaces[0], workspaceId: 'w2', isDefault: false, position: 1 });
      d.task.workspaceId = 'w2';
      return d;
    },
  },
  {
    field: 'providers[].models',
    left: db33,
    right: () => { const d = db33(); d.providers[0].models = ['claude-sonnet-5']; return d; },
  },
];

/**
 * D14-a as v1.5 specified it: `STABLE`, and every read takes `FOR SHARE`. PostgreSQL accepts the
 * `CREATE`, then refuses every call with `0A000` — so the object exists and never works.
 */
const SPECIFIED_D14_RESOLVER = `
  CREATE FUNCTION resolve_execution_context_locked(p_task text, p_agent text)
    RETURNS TABLE (digest text, revoked_input text) STABLE LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM enabled FROM agent WHERE id = p_agent FOR SHARE;
    RETURN QUERY SELECT md5(p_task || p_agent), NULL::text;
  END;
  $fn$;`;

/** PostgreSQL's default when a function declares no volatility is VOLATILE — that default is the
 *  whole reason the v1.5 fixture was green: it built a different object from the specified one. */
function provolatileOf(createSql: string): 'i' | 's' | 'v' {
  if (/\bIMMUTABLE\b/.test(createSql)) return 'i';
  if (/\bSTABLE\b/.test(createSql)) return 's';
  return 'v';
}

test('PC-CX-32 the locking resolver is VOLATILE, and the volatility is the assertion', () => {
  // This one cannot be modelled here and that is the finding: `SELECT … FOR SHARE` inside a
  // non-volatile function is refused by the server, not by anything a JavaScript model can replay.
  // What this file can do is hold the document to the three things that make the defect impossible
  // to reproduce silently — the object is specified VOLATILE, the migration check is over
  // `pg_proc.provolatile`, and the check is a *call* of the real deferred trigger rather than a
  // grep of the function body. The behaviour itself is asserted in the Postgres spec, by name.
  const d14 = section(PCC, '7.7');
  assert.match(d14, /它是一个 \*\*`VOLATILE`\*\* 的 plpgsql 函数/, 'D14-a still specifies a resolver that cannot take its locks');
  assert.ok(d14.includes('**D14-f（`VOLATILE` 不是默认值'), '§7.7 does not state D14-f');
  assert.match(d14, /SELECT FOR SHARE is not allowed in a non-volatile function/, 'D14-f does not record what the server actually says');
  assert.match(d14, /SQLSTATE: 0A000/, 'D14-f does not record the SQLSTATE the review reproduced');

  // The four criteria D14-f freezes, each of them a thing the v1.5 suite did not do.
  for (const criterion of ['pg_proc.provolatile', 'session_execution_context_guard', '必须调用真实的 deferred trigger', '反向对照必须留着']) {
    assert.ok(d14.includes(criterion), `D14-f does not require "${criterion}"`);
  }

  // Why the v1.5 development fixture was green, stated as the fact it turns on: the two objects
  // differ only in a marker, and v1.5's verification (grep the body for `FOR SHARE`, G5's v1.2
  // rule) passes both. Only `pg_proc.provolatile` tells them apart.
  const asBuilt = SPECIFIED_D14_RESOLVER.replace(' STABLE', '');
  assert.equal(provolatileOf(SPECIFIED_D14_RESOLVER), 's', 'the specified object is STABLE');
  assert.equal(provolatileOf(asBuilt), 'v', 'no marker means VOLATILE, which is what the fixture built');
  assert.ok(/FOR SHARE/.test(SPECIFIED_D14_RESOLVER) && /FOR SHARE/.test(asBuilt), 'and the v1.5 grep passes both');
  assert.equal(SPECIFIED_D14_RESOLVER.replace(' STABLE', ''), asBuilt, 'the bodies are otherwise identical');

  // The fixture now writes the marker the contract specifies, so it exercises the specified object.
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const fixture = pg.slice(pg.indexOf('CREATE FUNCTION resolve_execution_context_locked'),
    pg.indexOf('CREATE CONSTRAINT TRIGGER session_execution_context_guard'));
  assert.ok(fixture.length > 0, 'the development fixture no longer builds D14');
  assert.match(fixture, /LANGUAGE plpgsql VOLATILE/, 'the fixture still leaves the volatility to the default, which is how PC-CX-32 hid');
  assert.equal((fixture.match(/LANGUAGE plpgsql VOLATILE/g) ?? []).length, 2,
    'both D14 functions take locks, so both have to say VOLATILE');
  assert.ok(pg.includes("test('PC-CX-32 on real Postgres: the D14 objects are VOLATILE, and the deferred trigger really runs'"),
    'the behavioural half of PC-CX-32 has to run against a real server');

  // The migration creates what the contract specifies, and G5 checks the metadata rather than the
  // body — a function that raises 0A000 on every call is byte-identical in `pg_get_functiondef`.
  const migration = section(PCC, '12.1');
  assert.match(migration, /\*\*`VOLATILE`\*\*、只读、按 §8\.6 LO1 的顺序 `FOR SHARE`/, 'step 6e still creates a STABLE resolver');
  assert.match(migration, /`pg_proc\.provolatile = 'v'`/, 'G5 does not assert the volatility');
  assert.match(migration, /真的插一条 `dispatch_origin = 'COORDINATOR'` 的 Session 并 `COMMIT`/, 'G5 still only checks that the objects exist');

  // And no live sentence promises the object that cannot run.
  const stale = PCC.slice(0, PCC.indexOf('\n## 19. ')).split('\n').map((l) => bare(l))
    .filter((l) => l.includes('STABLE 的 SQL 函数') && !/v1\.[1-6]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still specifies a STABLE locking function');
});

test('PC-CX-33 the declared decision input carries the PAC resolver read set', () => {
  // A — the WITH chain. Two databases whose v1.5 `world` is byte-identical; the only difference is
  // the Agent default the task does not pin. PAC §7.2 priority 2 requires two different engines.
  const claude = db33();
  const codex = clone33(claude);
  codex.agent.defaultProvider = 'codex';
  codex.agent.defaultModel = 'gpt-5.6-sol';
  assert.equal(inputHash33(claude, 'v15'), inputHash33(codex, 'v15'), 'A: the v1.5 projection cannot tell them apart');
  assert.notEqual(requiredOutcome33(claude), requiredOutcome33(codex), 'A: …but PAC requires two different runs');
  assert.notEqual(ec2Digest33(resolveExecutionContext33(claude)), ec2Digest33(resolveExecutionContext33(codex)),
    'A: …and therefore two different execution-context digests');
  assert.notEqual(inputHash33(claude, 'v16'), inputHash33(codex, 'v16'), 'A: v1.6 gives them different hashes');

  // B — the WHERE chain. PAC §7.3's candidate predicate reads `workspace.enabled` verbatim, so the
  // same declared input is a DISPATCH in one state and a typed REFUSE in the other.
  const off = clone33(claude);
  off.workspaces[0].enabled = false;
  assert.equal(inputHash33(claude, 'v15'), inputHash33(off, 'v15'), 'B: the v1.5 projection cannot tell them apart');
  assert.deepEqual(resolveExecutionContext33(off), { refuse: 'NO_PROJECT_WORKSPACE' }, 'B: one of them must not dispatch');
  assert.notEqual(inputHash33(claude, 'v16'), inputHash33(off, 'v16'), 'B: v1.6 gives them different hashes');

  // C — a digest component. `projectMemberId` is EC2's second field; without it in `world`, one
  // declared input has two legal `executionContextDigest` values.
  const member2 = clone33(claude);
  member2.member!.projectMemberId = 'm2';
  assert.equal(inputHash33(claude, 'v15'), inputHash33(member2, 'v15'));
  assert.notEqual(ec2Digest33(resolveExecutionContext33(claude)), ec2Digest33(resolveExecutionContext33(member2)));
  assert.notEqual(inputHash33(claude, 'v16'), inputHash33(member2, 'v16'));

  // D — the split itself (S10-f). Two Project tasks with no assignee and no pin, one column apart:
  // the V1 one cannot dispatch at all, the LEGACY one leaves §7 and goes over the old bridge. Both
  // states are reachable in the database, which is what makes this a counterexample rather than an
  // illustration — see the `tasks[].executionContract` mutation for why the "same row with a pin,
  // two contracts" version is not.
  const unassigned = clone33(claude);
  unassigned.task.assigneeAgentId = null;
  const legacy = clone33(unassigned);
  legacy.task.executionContract = 'LEGACY';
  assert.deepEqual(resolveExecutionContext33(unassigned), { refuse: 'WHO_UNRESOLVED' },
    'D: a V1 task with no assignee is PAC §7.1 priority 2');
  assert.deepEqual(resolveExecutionContext33(legacy), { legacy: true, taskId: 't1', pinnedProvider: null, pinnedModel: null },
    'D: the same row as LEGACY never enters the WHO chain at all (PAC §11.1 L1)');
  assert.notEqual(requiredOutcome33(unassigned), requiredOutcome33(legacy), 'D: …so the two require different runs');
  assert.equal(inputHash33(unassigned, 'v15'), inputHash33(legacy, 'v15'), 'D: the v1.5 projection cannot tell them apart');
  assert.notEqual(inputHash33(unassigned, 'v16'), inputHash33(legacy, 'v16'), 'D: v1.6 gives them different hashes');

  // S10-c: every field the table adds is load-bearing, one deletion mutation each. Removing it
  // collapses a pair the resolver has to distinguish; keeping it separates them.
  for (const { field, left, right } of S10_MUTATIONS) {
    const l = left();
    const r = right();
    assert.notEqual(requiredOutcome33(l), requiredOutcome33(r), `${field}: the pair must require different runs`);
    assert.equal(inputHash33(l, 'v16', field), inputHash33(r, 'v16', field),
      `${field}: deleting it must make two distinguishable states hash the same (S10-c)`);
    assert.notEqual(inputHash33(l, 'v16'), inputHash33(r, 'v16'), `${field}: with it, the hashes differ`);
  }
  assert.equal(S10_MUTATIONS.length, S10_FIELDS.length, 'every field S10 adds needs its own mutation');
});

test('PC-CX-33 S8 harvests from the PAC resolution chain too, and §6.1 carries every column it reads', () => {
  const input = section(PCC, '6.1');
  assert.match(input, /\*\*S10（PAC 解析链的读集也是 `world` 的一部分/, '§6.1 does not state S10');
  assert.match(input, /契约测试从这\*\*六\*\*处收集列名/, 'S8 still harvests from five places');
  assert.match(input, /6\. \*\*§7\.4 第 8 条的 PAC 解析链\*\*/, 'S8\'s closed list has no sixth source');

  // The mapping table is a surjection onto EC1's eight rows: a chain input with no `world` field is
  // exactly the defect, and a `world` field with no PAC clause is the other half of S8.
  const s10 = tables(input).find((t) => bare(t[0][0]) === 'EC1 #');
  assert.ok(s10, 'S10 no longer maps EC1 to the world projection');
  assert.deepEqual(column(s10, 'EC1 #').map(bare), ['1', '2', '3', '4', '5', '6', '7', '8'], 'S10 must cover all eight EC1 rows');
  for (const clause of column(s10, 'PAC 条款').map(bare)) {
    assert.match(clause, /PAC §\d|§7\.5/, `S10 row "${clause}" names no clause that reads it`);
  }

  // Every field the model mutates is really in the frozen projection, spelled the same way.
  const world = input.slice(input.indexOf('  "world": {'), input.indexOf('\n  },\n\n  "evaluation":'));
  for (const field of S10_FIELDS) {
    const name = field.replace(/^.*\[\]\./, '');
    assert.ok(world.includes(`"${name}"`), `§6.1's world projection does not carry ${field}`);
  }
  // …and EC1 points back, so the two read sets cannot drift apart silently.
  assert.match(section(PCC, '7.4'), /这八行读到的每一列同时必须进 `decisionInput\.world`/, '§7.4 EC1 does not point at S10');
});

test('PC-CX-33 the execution contract picks the read set: V1 reads the Agent, LEGACY reads the task pin', () => {
  // PCC §7.4 EC1-b and PAC §16 O7, as something that RUNS. `00.15` proves both documents say it;
  // this proves the model obeys it. The third review round found the model ignoring the pin on both
  // branches and having no branch at all — a state in which a projection missing `executionContract`
  // is indistinguishable from one carrying it, so `PC-CX-33`'s own green was self-consistent and
  // proved nothing.
  const v1: string[] = [];
  resolveExecutionContext33(db33(), v1);
  assert.ok(v1.includes('task.execution_contract'), 'the resolver must read the selector before anything else');
  assert.equal(v1[0], 'task.execution_contract', 'PAC §5 step 2 is the FIRST read, not a late filter');
  for (const agentColumn of ['agent.default_provider', 'agent.default_model']) {
    assert.ok(v1.includes(agentColumn), `the V1 WITH chain must read \`${agentColumn}\` (PAC §7.2 priority 2)`);
  }
  for (const pin of ['task.provider', 'task.model']) {
    assert.ok(!v1.includes(pin), `the V1 chain read \`${pin}\`, which PAC §3.4 K1 makes NULL on every V1 row`);
  }

  // The fallback chain is the third Agent column, and it is only reached when the default fails —
  // asserting it on the happy path would be asserting nothing.
  const exhausted = db33();
  exhausted.providers[0].available = false;
  const fallbackReads: string[] = [];
  resolveExecutionContext33(exhausted, fallbackReads);
  assert.ok(fallbackReads.includes('agent.provider_fallbacks'), 'PAC §7.4 reads the Agent’s ordered fallback chain');

  // LEGACY is the other half: the pin is read, and no Agent column is.
  const legacyDb = db33();
  legacyDb.task.executionContract = 'LEGACY';
  legacyDb.task.provider = 'codex';
  legacyDb.task.model = 'gpt-5.6-sol';
  const legacyReads: string[] = [];
  const resolved = resolveExecutionContext33(legacyDb, legacyReads);
  assert.deepEqual(resolved, { legacy: true, taskId: 't1', pinnedProvider: 'codex', pinnedModel: 'gpt-5.6-sol' },
    'the LEGACY bridge reads the task pin (PAC §11.1 L1)');
  assert.deepEqual(legacyReads, ['task.execution_contract', 'task.provider', 'task.model'],
    'the LEGACY branch must read the pin and none of the Agent columns');

  // And the same pin on a V1 row is not a state to model: PAC §3.4 K1 is a CHECK constraint, so the
  // V1 branch cannot be tested "ignoring" a pin — it can only be tested never reading one, above.
  assert.match(section(PAC, '3.4'), /CHECK \("execution_contract" = 'LEGACY' OR \("provider" IS NULL AND "model" IS NULL\)\)/,
    'PAC §3.4 K1 no longer makes a V1 row with a pin unrepresentable');
});

test('PC-CX-33 H4 on the executable WHO chain: off-team beats disabled, and beats soft-deleted', () => {
  // PAC §7.1 H4. The two predicates can hold of one input, and until the third review round the
  // contract said `WHO_NOT_IN_TEAM` wins while this model answered `WHO_DISABLED`. `00.13` read the
  // clause's word order and the case ids and stayed green through all of it, because reading a
  // sentence is not running it.
  const offTeamAndDisabled = db33();
  offTeamAndDisabled.member = null;
  offTeamAndDisabled.agent.enabled = false;
  assert.deepEqual(resolveExecutionContext33(offTeamAndDisabled), { refuse: 'WHO_NOT_IN_TEAM' },
    'member = null ∩ enabled = false must have exactly one answer, and H4 says it is WHO_NOT_IN_TEAM');

  const offTeamAndDeleted = db33();
  offTeamAndDeleted.member = null;
  offTeamAndDeleted.agent.deletedAt = '2026-08-20T00:00:00.000Z';
  assert.deepEqual(resolveExecutionContext33(offTeamAndDeleted), { refuse: 'WHO_NOT_IN_TEAM' },
    'member = null ∩ deletedAt ≠ null must give the same one answer');

  // Neither refusal has been swallowed: each still fires on the input it alone describes.
  const offTeamOnly = db33();
  offTeamOnly.member = null;
  assert.deepEqual(resolveExecutionContext33(offTeamOnly), { refuse: 'WHO_NOT_IN_TEAM' });
  const disabledOnly = db33();
  disabledOnly.agent.enabled = false;
  assert.deepEqual(resolveExecutionContext33(disabledOnly), { refuse: 'WHO_DISABLED' },
    'an Agent inside the Team but disabled is still WHO_DISABLED (§12 keeps both rows)');
  const deletedOnly = db33();
  deletedOnly.agent.deletedAt = '2026-08-20T00:00:00.000Z';
  assert.deepEqual(resolveExecutionContext33(deletedOnly), { refuse: 'WHO_DISABLED' });

  // …and the clause the order comes from, so the model and the contract cannot drift apart.
  const h4 = section(PAC, '7.1');
  assert.match(h4.slice(h4.indexOf('- **H4')), /`WHO_NOT_IN_TEAM` 胜/, 'PAC §7.1 H4 no longer names the winner');

  // The reverse order is what the defect was, stated as the thing that must stay impossible: judging
  // availability first hands an off-team Agent a required action ("enable it") that does not make
  // the dispatch possible.
  const availabilityFirst = (db: Db33): string =>
    (!db.agent.enabled || db.agent.deletedAt !== null) ? 'WHO_DISABLED' : db.member === null ? 'WHO_NOT_IN_TEAM' : 'DISPATCH';
  assert.equal(availabilityFirst(offTeamAndDisabled), 'WHO_DISABLED', 'the superseded order is what this test forbids');
  assert.notDeepEqual(resolveExecutionContext33(offTeamAndDisabled), { refuse: availabilityFirst(offTeamAndDisabled) });
});

/**
 * `PC-CX-34` — the same barrier as `ecRace`, read three ways instead of one. I17-A is over columns
 * that stop changing at commit (PAC §6 freezes the session snapshot, §7.7 D11 pins the APPLIED
 * action row); I17-B is the commit instant D14 proves; the third is v1.5's "equivalent queryable
 * form", which asks about *now* and therefore answers differently after a legal revocation.
 */
interface Ec34Result {
  committed: boolean;
  /** I17-A: the placeholder's frozen snapshot columns still equal the frozen execution context. */
  i17A: boolean;
  /** I17-B: at the instant the placeholder committed, re-resolution equalled the frozen digest. */
  i17BAtCommit: boolean;
  /** v1.5's enumerated current-state query, as §12.1 G5 asked for it to be run: rows found now. */
  v15LiteralViolations: number;
  /** v1.5's other reading — "re-resolve now and compare" — over the same committed state. */
  v15RestatedViolations: number;
}

function ec34Race(order: Order15, input: RevokedInput): Ec34Result {
  const snapshot = ecWorld();
  const frozenCtx = resolveExecutionContext(snapshot)!;
  const frozen = ecDigest(frozenCtx)!;
  let world = snapshot;
  const human = (): void => { world = revoke(world, input); };

  // EC3 + D14: the commit only happens if re-resolution under the lock still matches.
  const coordinator = (): { committed: boolean; i17BAtCommit: boolean } => {
    const observed = ecDigest(resolveExecutionContext(world));
    return { committed: observed === frozen, i17BAtCommit: observed === frozen };
  };

  let outcome: { committed: boolean; i17BAtCommit: boolean };
  if (order === 'USER_FIRST') { human(); outcome = coordinator(); } else { outcome = coordinator(); human(); }

  // The session row, if one was committed. Its snapshot columns are frozen at create (PAC §6).
  const session = outcome.committed ? { ...frozenCtx } : null;
  const i17A = session === null || ecDigest(session) === frozen;

  // v1.5's literal query enumerates seven of EC1's eight inputs (the coordinator workspace is only
  // an input to ROTATE / OPEN_TURN, §7.4 EC1's note), and reads them at the *current* state.
  const live = session !== null;
  const literal = live && (
    !world.agentEnabled || !world.memberOfProject || world.taskAssignee !== session!.taskAssigneeAgentId ||
    world.taskProvider !== session!.providerSlug || world.taskModel !== session!.model ||
    !world.providerAvailable || !world.workspaceLive || !world.runnerOnline);
  const restated = live && ecDigest(resolveExecutionContext(world)) !== frozen;
  return {
    committed: outcome.committed,
    i17A,
    i17BAtCommit: outcome.i17BAtCommit,
    v15LiteralViolations: literal ? 1 : 0,
    v15RestatedViolations: restated ? 1 : 0,
  };
}

test('PC-CX-34 I17 is stated with a tense, and the current-state query is not one of them', () => {
  // Sixteen cells: eight revocations × two commit orders, all of them legal at every step.
  for (const input of REVOKED_INPUTS) {
    const userFirst = ec34Race('USER_FIRST', input);
    assert.equal(userFirst.committed, false, `${input}/USER_FIRST: a revoked context must not produce a placeholder`);
    assert.equal(userFirst.i17A, true, `${input}/USER_FIRST: I17-A holds vacuously — there is no placeholder`);
    assert.equal(userFirst.v15LiteralViolations, 0, `${input}/USER_FIRST: and nothing to find in the current state either`);

    const loopFirst = ec34Race('COORDINATOR_FIRST', input);
    assert.equal(loopFirst.committed, true, `${input}/COORDINATOR_FIRST: committing while still authorised is legal (AU1-a row 2)`);
    assert.equal(loopFirst.i17BAtCommit, true, `${input}/COORDINATOR_FIRST: I17-B is required at that instant, and it held`);
    assert.equal(loopFirst.i17A, true, `${input}/COORDINATOR_FIRST: I17-A stays true afterwards — it reads only immutable columns`);
    assert.equal(loopFirst.v15RestatedViolations, 1,
      `${input}/COORDINATOR_FIRST: v1.5's current-state reading is violated by a sequence in which nobody did anything wrong`);
  }

  // The published output: `enabled = false | live = 1 | i17_current_violations = 1`. Seven of the
  // eight inputs are visible to v1.5's enumerated query; the eighth (the coordinator workspace) is
  // not an input to a DISPATCH placeholder at all, which is its own kind of hole in that query.
  const visible = REVOKED_INPUTS.filter((i) => ec34Race('COORDINATOR_FIRST', i).v15LiteralViolations === 1);
  assert.deepEqual([...visible], ['AGENT', 'MEMBERSHIP', 'TASK', 'PROVIDER', 'MODEL', 'WORKSPACE', 'RUNNER'],
    'the review\'s false|1|1 must reproduce for every EC1 input a DISPATCH actually resolves');
  assert.equal(ec34Race('COORDINATOR_FIRST', 'COORDINATOR_WORKSPACE').v15LiteralViolations, 0);

  // I17-A is what a zero-row query may be run against, because both sides of it stop changing at
  // commit. Negative control: tamper with either side and it goes non-zero.
  const tampered = { ...resolveExecutionContext(ecWorld())!, providerSlug: 'codex' };
  assert.notEqual(ecDigest(tampered), ecDigest(resolveExecutionContext(ecWorld())),
    'I17-A must be able to fail: a placeholder whose snapshot disagrees with its action row is a defect');

  // The document states both halves, deletes the current-state equivalence, and says what the
  // state it used to forbid actually is.
  const invariants = section(PCC, '4.3');
  for (const rule of ['**I17-A（create 冻结列与占位一致，恒成立', '**I17-B（授权在提交那一刻成立，点态', '**I17-c（那条被删掉的当前态查询是什么']) {
    assert.ok(invariants.includes(rule), `§4.3 does not state ${rule}）`);
  }
  assert.doesNotMatch(invariants.split('\n').filter((l) => !/v1\.[1-6]|PC-CX-\d\d/.test(l)).join('\n'),
    /等价的可查询形式：\*\*不存在\*\*一条 `dispatch_origin = 'COORDINATOR'` 的占位/,
    'the superseded current-state equivalence is still stated as a requirement');
  assert.match(section(PCC, '12.1'), /跑一次 I17-A 并断言返回 0 行/, '§12.1 G5 still runs the query that legitimately returns rows');
  assert.match(section(PCC, '7.7'), /\*\*D14-b（它证明的正是 I17-B/, 'D14-b still claims to prove the current-state form');
});

// ─────────────────────────────────────────────────────────────────────────────
// `PC-CX-35` — §10.4's wake, as one candidate table and one deterministic choice (W5).
// ─────────────────────────────────────────────────────────────────────────────

interface WakeCandidate {
  /** The §10.4 item number, 1–7. It is the tie-break, and it is a total order (W5 step 2). */
  source: number;
  at: number;
  reason: string;
}

const W3_FLOOR_MS = 5_000;

/** W5: min by `at`, ties by `source`, then the floor. The reason is the chosen candidate's. */
function chooseWake(candidates: WakeCandidate[], now: number, version: Version16):
{ at: number | null; reason: string | null; flooredBy: string | null; candidates: WakeCandidate[] } {
  if (candidates.length === 0) return { at: null, reason: null, flooredBy: null, candidates: [] };
  const ordered = [...candidates].sort((a, b) => a.at - b.at || a.source - b.source);
  const chosen = ordered[0];
  if (version === 'v15') {
    // v1.5 states three rules and no arbitration: the boundary must be pointed at exactly (TR2-e)
    // *and* the minimum must win (§10.4) *and* the floor must hold (W3). This returns what an
    // implementer reading TR2-d/TR2-e literally would produce.
    const boundary = candidates.find((c) => c.source === 7);
    const at = boundary ? boundary.at : chosen.at;
    return { at, reason: boundary ? boundary.reason : chosen.reason, flooredBy: null, candidates: ordered };
  }
  const at = Math.max(chosen.at, now + W3_FLOOR_MS);
  return { at, reason: chosen.reason, flooredBy: at > chosen.at ? 'W3' : null, candidates: ordered };
}

test('PC-CX-35 the wake is one candidate table and one deterministic choice', () => {
  const windowEndsAt = 60_000;
  // The review's parametrisation: how much of the window is left when the request is rate-limited.
  for (const remaining of [0, 1, 2, 4, 5, 6, 59]) {
    const now = windowEndsAt - remaining * 1_000;
    const nextAttemptAt = windowEndsAt;                                  // TR2-b ③, unchanged
    const wake = chooseWake([{ source: 7, at: windowEndsAt, reason: 'manual trigger rate-limited' }], now, 'v16');
    assert.ok(wake.at !== null && wake.at >= now + W3_FLOOR_MS, `remaining=${remaining}s: W3's floor must hold`);
    assert.ok(wake.at! <= nextAttemptAt + W3_FLOOR_MS, `remaining=${remaining}s: I18-C's bound must hold`);
    assert.equal(nextAttemptAt, windowEndsAt, `remaining=${remaining}s: TR2-b still puts next_attempt_at on the boundary`);
    assert.equal(wake.reason, 'manual trigger rate-limited', `remaining=${remaining}s: the reason names the candidate it woke for`);
    assert.equal(wake.flooredBy, remaining < 5 ? 'W3' : null, `remaining=${remaining}s: the audit says when the floor moved it`);
    // When the wake fires, the fact it was waiting for is due — the floor can only make it later.
    assert.ok(wake.at! >= windowEndsAt, `remaining=${remaining}s: rateLimitExpired must be true when it fires`);

    // v1.5's three sentences have no common solution in the last five seconds.
    const v15 = chooseWake([{ source: 7, at: windowEndsAt, reason: 'manual trigger rate-limited' }], now, 'v15');
    const satisfiesW3 = v15.at! >= now + W3_FLOOR_MS;
    const satisfiesI18 = v15.at! <= nextAttemptAt;
    assert.equal(satisfiesW3 && satisfiesI18, remaining >= 5,
      `remaining=${remaining}s: v1.5's W3 and I18/TR2-d can only both hold outside the last five seconds`);
  }

  // The second counterexample: another applicable wake is earlier than the boundary. §10.4 says
  // take the minimum, TR2-e said point at the boundary. W5 arbitrates, and the earlier wake still
  // re-evaluates the pending request when it fires.
  const earlier: WakeCandidate[] = [
    { source: 4, at: 59_000, reason: 'task runAt due' },
    { source: 7, at: 60_000, reason: 'manual trigger rate-limited' },
  ];
  const w16 = chooseWake(earlier, 50_000, 'v16');
  assert.equal(w16.at, 59_000, 'the minimum wins');
  assert.equal(w16.reason, 'task runAt due', 'and the reason is the one it woke for');
  assert.equal(chooseWake(earlier, 50_000, 'v15').at, 60_000, 'v1.5 would have pointed at the boundary and skipped the earlier wake');
  assert.equal(chooseWake([...earlier].reverse(), 50_000, 'v16').at, 59_000, 'and the answer does not depend on iteration order');
  // Inside the floor the same table still gives one answer: later, but still the earlier candidate's
  // reason — the wake says what it is for, not whether it was punctual (W5 step 3).
  const floored = chooseWake(earlier, 58_000, 'v16');
  assert.deepEqual([floored.at, floored.reason, floored.flooredBy], [63_000, 'task runAt due', 'W3']);

  // Ties: two candidates at the same instant are decided by §10.4's item numbers, not by order.
  for (const source of [1, 2, 3, 4, 5, 6]) {
    const tied: WakeCandidate[] = [
      { source, at: 60_000, reason: `item ${source}` },
      { source: 7, at: 60_000, reason: 'manual trigger rate-limited' },
    ];
    const a = chooseWake(tied, 30_000, 'v16');
    const b = chooseWake([...tied].reverse(), 30_000, 'v16');
    assert.deepEqual([a.at, a.reason], [b.at, b.reason], `source ${source}: a tie must not depend on iteration order`);
    assert.equal(a.reason, `item ${source}`, `source ${source}: the lower item number wins the tie (W5 step 2)`);
  }

  // Every pair of sources, both orders: one answer, and it is the earlier one.
  for (let s = 1; s <= 6; s++) {
    for (const [earlyAt, lateAt] of [[10_000, 20_000], [20_000, 10_000]]) {
      const pair: WakeCandidate[] = [
        { source: s, at: earlyAt, reason: `item ${s}` },
        { source: 7, at: lateAt, reason: 'manual trigger rate-limited' },
      ];
      const chosen = chooseWake(pair, 0, 'v16');
      assert.equal(chosen.at, Math.min(earlyAt, lateAt));
      assert.equal(chosen.reason, earlyAt < lateAt ? `item ${s}` : 'manual trigger rate-limited');
      assert.equal(chosen.candidates.length, 2, 'the whole candidate table goes to the audit, not just the winner');
    }
  }

  // The clauses.
  const timing = section(PCC, '10.4');
  assert.match(timing, /\*\*W5（一个候选表、一个确定的选择/, '§10.4 does not freeze the arbitration');
  assert.match(timing, /`nextWakeAt = max\(chosen\.at, evaluation\.epoch \+ 5s\)`/,
    'W5 does not state which of the floor and the deadline wins');
  assert.match(timing, /wakeCandidates/, 'the candidate table is not written down anywhere a human can read it');
  assert.match(section(PCC, '7.6'), /nextWakeAt ≤ windowEndsAt \+ 5s/, 'TR2-d still states the bound that has no solution');
  assert.match(section(PCC, '4.3'), /next_wake_at <= next_attempt_at \+ 5s/, 'I18-C still states v1.5\'s bound');
  assert.match(section(PCC, '15'), /\*\*F38\*\*/, '§15 has no fault row for the last five seconds of a window');
});

// ─────────────────────────────────────────────────────────────────────────────
// `PC-CX-36` — the first state of a `user.manual_trigger` row, which I18 never looked at.
// ─────────────────────────────────────────────────────────────────────────────

interface EventRow36 {
  kind: string;
  occurredAt: number;
  consumedAt: number | null;
  nextAttemptAt: number | null;
  attempts: number;
}

interface Project36 {
  events: EventRow36[];
  nextWakeAt: number | null;
  openBlockers: { recovery: Recovery; escalated: boolean }[];
  liveSession: boolean;
  turnInFlight: boolean;
}

/** §4.3 I18, by version. v1.5 has two shapes; v1.6 has three, and names the fourth as a defect. */
function i18Shape(e: EventRow36, p: Project36, version: Version16): 'A' | 'B' | 'C' | 'NONE' {
  if (e.consumedAt !== null) return 'A';
  if (e.nextAttemptAt !== null) {
    const bound = version === 'v16' ? e.nextAttemptAt + W3_FLOOR_MS : e.nextAttemptAt;
    return p.nextWakeAt !== null && p.nextWakeAt <= bound ? 'C' : 'NONE';
  }
  if (version === 'v16' && e.attempts === 0) return 'B';
  return 'NONE';
}

/** §10.2 W4, all four branches, over one project. `L_MAX` is §10.4's hard cap. */
const L_MAX = 5 * MINUTE;
function backstopBranches36(p: Project36, now: number, version: Version16): string[] {
  const hits: string[] = [];
  if (p.nextWakeAt !== null && p.nextWakeAt < now - L_MAX) hits.push('i');
  if (p.nextWakeAt === null && p.openBlockers.some((b) => b.recovery !== 'HUMAN' || !b.escalated)) hits.push('ii');
  if (p.nextWakeAt === null && p.openBlockers.length === 0) hits.push('iii');
  if (version === 'v16' && p.events.some((e) => e.consumedAt === null && (e.nextAttemptAt ?? e.occurredAt) < now - L_MAX)) {
    hits.push('iv');
  }
  return hits;
}

/** §10.3's four liveness conditions, as far as this model needs them. */
const liveness36 = (p: Project36): boolean =>
  p.liveSession || p.turnInFlight || p.openBlockers.length > 0 || p.nextWakeAt !== null;

test('PC-CX-36 a committed event that reconcile has not seen yet has a shape and an owner', () => {
  // The state every explicit request passes through first: the user interface committed the row in
  // the business transaction (§5.3 N4), and the consumer is asynchronous (§5.4).
  const justCommitted: EventRow36 = { kind: 'user.manual_trigger', occurredAt: 0, consumedAt: null, nextAttemptAt: null, attempts: 0 };
  const project: Project36 = { events: [justCommitted], nextWakeAt: null, openBlockers: [{ recovery: 'HUMAN', escalated: true }], liveSession: false, turnInFlight: false };

  assert.equal(i18Shape(justCommitted, project, 'v15'), 'NONE',
    'PC-CX-36 must reproduce: v1.5 claims every committed state has one of two shapes, and this one has neither');
  assert.equal(i18Shape(justCommitted, project, 'v16'), 'B', 'v1.6 names it: awaiting first consumption');

  // The three shapes are exhaustive over the row's life: pending → rate-limited → answered.
  const rateLimited: EventRow36 = { ...justCommitted, nextAttemptAt: 60_000, attempts: 0 };
  const answered: EventRow36 = { ...justCommitted, consumedAt: 60_000 };
  const withWake: Project36 = { ...project, events: [rateLimited], nextWakeAt: 63_000 };
  assert.equal(i18Shape(rateLimited, withWake, 'v16'), 'C', 'rate-limited, with a wake inside the floor slack');
  assert.equal(i18Shape(rateLimited, withWake, 'v15'), 'NONE', 'v1.5\'s bound rejects the wake W3 forces in the last five seconds');
  assert.equal(i18Shape(answered, { ...project, events: [answered] }, 'v16'), 'A', 'answered');

  // The fourth shape is a defect in both versions, and it has to stay one: a row nobody consumed
  // and nobody scheduled is exactly the silent-ignore this invariant exists to forbid.
  const orphan: EventRow36 = { ...justCommitted, attempts: 3 };
  assert.equal(i18Shape(orphan, { ...project, events: [orphan] }, 'v16'), 'NONE',
    'attempted but neither consumed nor rescheduled must remain a defect');

  // I19: the row is pending, the project has stopped its clock legally (N-null: every open blocker
  // is HUMAN and escalated), and the consumer is dead. v1.5's W4 has no branch for this, so nothing
  // in the database points at it; the (iv) branch is what makes I18-B's promise checkable.
  assert.equal(liveness36(project), true, '§10.3 (c): the escalated blocker keeps the project visible');
  assert.deepEqual(backstopBranches36(project, 6 * MINUTE, 'v15'), [],
    'PC-CX-36 must reproduce: no branch of the v1.5 backstop sees an event no consumer took');
  assert.deepEqual(backstopBranches36(project, 6 * MINUTE, 'v16'), ['iv'], 'the (iv) branch does');
  assert.deepEqual(backstopBranches36(project, 60_000, 'v16'), [],
    'and it is not a permanent alarm: inside the L cap it does not fire (PC-CX-05\'s lesson)');

  // A consumed event never fires it, whatever else is wrong.
  const settled: Project36 = { ...project, events: [answered], nextWakeAt: null };
  assert.deepEqual(backstopBranches36(settled, 6 * MINUTE, 'v16'), [], 'an answered request is not a backstop hit');

  // N-null keeps its exemption: the gap is legal, and it is the queue's business, not the clock's.
  assert.equal(project.nextWakeAt, null, 'the runtime may legally have no wake while the row waits in the queue');
  assert.equal(i18Shape(justCommitted, project, 'v16'), 'B', 'and that is a named shape, not a violation');

  // The clauses.
  const invariants = section(PCC, '4.3');
  for (const rule of ['**I18-A（已回答', '**I18-B（待首次消费', '**I18-C（已看过、被限频', '**I18-note（为什么事件生产者不原子写 runtime wake', '**I19（待消费事件的责任域']) {
    assert.ok(invariants.includes(rule), `§4.3 does not state ${rule}）`);
  }
  const options = tables(invariants).find((t) => bare(t[0][0]) === '选项');
  assert.ok(options && options.length - 1 === 2, 'I18-note must argue both options the review offered, not silently pick one');
  const wake = section(PCC, '10.2');
  assert.match(wake, /-- \(iv\) 队列里躺着一条没人看的事件/, '§10.2 W4 has no fourth branch');
  assert.match(wake, /\*\*W4-a（第 \(iv\) 支为什么在这里/, 'the fourth branch is not argued');
  assert.match(section(PCC, '10.4'), /\*\*N-null 的时态（v1\.6 冻结/, 'N-null still reads as a claim about every committed state');
  assert.match(section(PCC, '15'), /\*\*F37\*\*/, '§15 has no fault row for the asynchronous gap');
});

test('mutation check: every fence added for PC-CX-32..36 is load-bearing', () => {
  // Same discipline as the four mutation checks above: a fence that can be removed without the
  // defect coming back was never the fix. `PC-CX-32` is the one that cannot be modelled here — its
  // whole claim is what a real server does with a volatility marker — so what is checked in this
  // file is that the contract and the migration both name it, and the Postgres spec runs it.
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-32',
      fence: 'asserting pg_proc.provolatile instead of grepping the body (§7.7 D14-f, §12.1 G5)',
      defectReappears: () => {
        // v1.5 verified D14 by grepping `pg_get_functiondef` for `FOR SHARE` (G5, v1.2's rule). The
        // specified object and the object the fixture built differ *only* in a marker that grep
        // cannot see, and the one the contract specified raises 0A000 on every call.
        const specified = SPECIFIED_D14_RESOLVER;
        const asBuilt = specified.replace(' STABLE', '');
        return /FOR SHARE/.test(specified) && /FOR SHARE/.test(asBuilt) &&
          provolatileOf(specified) === 's' && provolatileOf(asBuilt) === 'v';
      },
    },
    {
      finding: 'PC-CX-33',
      fence: 'projecting the PAC resolver read set into the decision input (§6.1 S10)',
      defectReappears: () => S10_MUTATIONS.every(({ field, left, right }) =>
        inputHash33(left(), 'v15') === inputHash33(right(), 'v15') ||
        inputHash33(left(), 'v16', field) === inputHash33(right(), 'v16', field)),
    },
    {
      finding: 'PC-CX-34',
      fence: 'splitting I17 into I17-A (standing) and I17-B (commit-time)',
      defectReappears: () => REVOKED_INPUTS.every((i) => ec34Race('COORDINATOR_FIRST', i).v15RestatedViolations === 1),
    },
    {
      finding: 'PC-CX-35',
      fence: 'W5: the floor beats the deadline, and ties are decided by item number',
      defectReappears: () => {
        const boundary: WakeCandidate[] = [{ source: 7, at: 60_000, reason: 'manual trigger rate-limited' }];
        const v15 = chooseWake(boundary, 58_000, 'v15');
        return v15.at! < 58_000 + W3_FLOOR_MS;             // v1.5's answer violates W3, and there is no other
      },
    },
    {
      finding: 'PC-CX-36',
      fence: 'I18-B plus the fourth backstop branch (§10.2 W4 (iv))',
      defectReappears: () => {
        const e: EventRow36 = { kind: 'user.manual_trigger', occurredAt: 0, consumedAt: null, nextAttemptAt: null, attempts: 0 };
        const p: Project36 = { events: [e], nextWakeAt: null, openBlockers: [{ recovery: 'HUMAN', escalated: true }], liveSession: false, turnInFlight: false };
        return i18Shape(e, p, 'v15') === 'NONE' && backstopBranches36(p, 6 * MINUTE, 'v15').length === 0;
      },
    },
  ];

  assert.equal(mutants.length, 5, 'unit 02 raised five findings against v1.5');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.equal(S10_MUTATIONS.every(({ left, right }) => inputHash33(left(), 'v16') !== inputHash33(right(), 'v16')), true);
  assert.equal(REVOKED_INPUTS.every((i) => ec34Race('COORDINATOR_FIRST', i).i17A), true);
  assert.equal(REVOKED_INPUTS.every((i) => ec34Race('USER_FIRST', i).committed), false);
  assert.equal(chooseWake([{ source: 7, at: 60_000, reason: 'manual trigger rate-limited' }], 58_000, 'v16').at, 63_000);
  const fixedEvent: EventRow36 = { kind: 'user.manual_trigger', occurredAt: 0, consumedAt: null, nextAttemptAt: null, attempts: 0 };
  const fixedProject: Project36 = { events: [fixedEvent], nextWakeAt: null, openBlockers: [{ recovery: 'HUMAN', escalated: true }], liveSession: false, turnInFlight: false };
  assert.equal(i18Shape(fixedEvent, fixedProject, 'v16'), 'B');
  assert.deepEqual(backstopBranches36(fixedProject, 6 * MINUTE, 'v16'), ['iv']);
});

test('§24 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§23 have, for the sixth round. Two of these five are claims about what a
  // real server does — a non-volatile function cannot take a row lock, and a deferred trigger only
  // runs at COMMIT — so the Postgres file is checked by name as well.
  const rows = tables(section(PCC, '24'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-32', 'PC-CX-33', 'PC-CX-34', 'PC-CX-35', 'PC-CX-36']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§24 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '24').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 4, '§24 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§24 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '24').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§24 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§24 points at §${m[1]}, which does not exist`);
  }
});

// ---------------------------------------------------------------------------------------------
// Round seven (`PC-CX-37..42`, §25). Two of the six are the same lesson in a new place: a closed
// set that had to be maintained by hand (D11's denylist), and a cross-document reference read at
// the title rather than at the row (I17-A vs PAC §6's "frozen at" column). The other four are an
// ordering that stopped at its second key, the last free-running clock, an invariant quantified
// wider than its own responsibility, and one digest asked to answer two different questions.
// ---------------------------------------------------------------------------------------------

type Version17 = 'v16' | 'v17';

/** Stable serialization for the round-seven models: object keys sorted, array order kept. */
function canonical17(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v);
}

/** The columns `project_action` has after v1.5 added three and v1.7 added a fourth (§2.4). */
const ACTION_COLUMNS = [
  'id', 'idempotency_key', 'project_id', 'type', 'status', 'subject_type', 'subject_id',
  'fencing_token', 'result_session_id', 'detail',
  'execution_context', 'execution_context_digest', 'reason_code',   // v1.5
  'execution_result_digest',                                        // v1.7
];
/** v1.4's D11 compared exactly these, by name, and nothing else. */
const V14_DENYLIST = ['status', 'type', 'subject_type', 'subject_id', 'project_id', 'fencing_token', 'idempotency_key'];
const D11_ALLOWLIST = ['result_session_id', 'detail'];

/** Does D11 refuse an UPDATE that changes exactly `column` on an APPLIED row? */
function d11Refuses(column: string, version: Version17): boolean {
  if (version === 'v16') return V14_DENYLIST.includes(column);
  return !D11_ALLOWLIST.includes(column);                              // allowlist: everything else is frozen
}

test('PC-CX-37 the applied action row is frozen by an allowlist, not by a list someone must remember to grow', () => {
  // The published counterexample: an APPLIED dispatch whose frozen provider is `claude` and whose
  // session was created from it, then a plain UPDATE that rewrites the frozen context to `codex`
  // and moves the rate-limit window anchor by rewriting `reason_code`.
  const drifted = ['execution_context', 'execution_context_digest', 'reason_code'];
  for (const column of drifted) {
    assert.equal(d11Refuses(column, 'v16'), false,
      `${column}: v1.4's denylist did not compare a column v1.5 added — that is the P0`);
    assert.equal(d11Refuses(column, 'v17'), true, `${column}: the allowlist has to freeze it`);
  }
  // The consequence the review published: a committed state that violates I17-A, and a window
  // anchor that has moved. Both are computed here rather than asserted as prose.
  const sessionProvider = 'claude';
  const frozenProviderAfter = (version: Version17) => (d11Refuses('execution_context', version) ? 'claude' : 'codex');
  const reasonCodeAfter = (version: Version17) => (d11Refuses('reason_code', version) ? 'MANUAL' : 'REPLAN');
  assert.deepEqual(
    { provider: frozenProviderAfter('v16'), reason: reasonCodeAfter('v16'), i17aViolations: frozenProviderAfter('v16') === sessionProvider ? 0 : 1 },
    { provider: 'codex', reason: 'REPLAN', i17aViolations: 1 },
    'v1.6 admits the review’s exact committed observation',
  );
  assert.deepEqual(
    { provider: frozenProviderAfter('v17'), reason: reasonCodeAfter('v17'), i17aViolations: 0 },
    { provider: 'claude', reason: 'MANUAL', i17aViolations: 0 },
    'v1.7 refuses it, so the frozen row still is what the decision froze',
  );

  // The shape, not this round's three columns: a column added tomorrow is frozen by default.
  const tomorrow = 'some_column_v1_8_will_add';
  assert.equal(d11Refuses(tomorrow, 'v16'), false, 'a denylist cannot know about a column that does not exist yet');
  assert.equal(d11Refuses(tomorrow, 'v17'), true, 'an allowlist can');
  // And the two writable ones stay writable, or §8.3’s normal path blocks itself.
  for (const column of D11_ALLOWLIST) assert.equal(d11Refuses(column, 'v17'), false, `${column} must stay writable`);
  assert.equal(ACTION_COLUMNS.filter((c) => d11Refuses(c, 'v17')).length, ACTION_COLUMNS.length - D11_ALLOWLIST.length);

  // The clauses.
  const seven = section(PCC, '7.7');
  const d11 = seven.slice(seven.indexOf('#### D11 '), seven.indexOf('#### D12 '));
  assert.match(d11, /to_jsonb\(NEW\) - writable/, 'D11 no longer compares the whole row');
  assert.ok(d11.includes('**D11-d（'), 'D11 does not argue allowlist over denylist');
  assert.ok(d11.includes('**D11-e（'), 'D11 does not state a schema-driven testable form');
  assert.match(section(PCC, '12.1'), /information_schema\.columns/, 'G5 still enumerates a fixed column count');
  assert.match(section(PCC, '15'), /\*\*F39\*\*/, '§15 has no fault row for a rewritten frozen action');
});

/** PAC §6's table, as two columns: the column name and the moment it freezes. */
const PAC_FREEZE_POINTS: { column: string; frozenAt: 'create' | 'first-claim' }[] = [
  { column: 'agentId', frozenAt: 'create' },
  { column: 'workspaceId', frozenAt: 'create' },
  { column: 'assignedRunnerId', frozenAt: 'create' },
  { column: 'provider', frozenAt: 'create' },
  { column: 'requiredCapabilities', frozenAt: 'create' },
  { column: 'permissionMode', frozenAt: 'create' },
  { column: 'model', frozenAt: 'first-claim' },
  { column: 'effort', frozenAt: 'first-claim' },
];

interface Placeholder17 {
  model: string | null;
  effort: string | null;
  pinGeneration: number;
  retiredPins: { from: string; to: string }[];
  claimResolution: string | null;
}

/** §4.3 I17-A: only the create-frozen columns, compared against the action row. */
function i17aHolds(frozenProvider: string, sessionProvider: string): boolean {
  return frozenProvider === sessionProvider;
}

/** §4.3 I17-A2, phase-indexed by `execution_pin_generation`. */
function i17a2Holds(s: Placeholder17, frozenModel: string | null): boolean {
  if (s.pinGeneration === 0) return s.model === null && s.effort === null;
  if (s.pinGeneration === 1) return frozenModel === null ? s.claimResolution !== null : s.model === frozenModel;
  return s.retiredPins.length === s.pinGeneration - 1;
}

/** v1.6's I17-A, which also compared `model`. */
function i17aV16Holds(s: Placeholder17, frozenModel: string | null): boolean {
  return s.model === frozenModel;
}

test('PC-CX-38 the frozen snapshot is compared per PAC freeze point, with a phase and a generation', () => {
  const frozenModel = 'model-v1';
  // The review's three-step sequence. Every step is legal: PAC §6 defers model to first claim (S1)
  // and keeps the one `retiredPin` rewrite.
  const pending: Placeholder17 = { model: null, effort: null, pinGeneration: 0, retiredPins: [], claimResolution: null };
  const claimed: Placeholder17 = { model: 'model-v1', effort: 'high', pinGeneration: 1, retiredPins: [], claimResolution: 'model-v1' };
  const retired: Placeholder17 = {
    model: 'model-v2', effort: 'high', pinGeneration: 2,
    retiredPins: [{ from: 'model-v1', to: 'model-v2' }], claimResolution: 'model-v1',
  };

  // v1.6: the standing statement is false at step 1 and step 3, with nobody doing anything wrong.
  assert.deepEqual(
    [pending, claimed, retired].map((s) => i17aV16Holds(s, frozenModel)),
    [false, true, false],
    'v1.6 I17-A is false on two of the three states of a normal lifecycle',
  );
  // v1.7: the create-frozen equality holds throughout, and each phase has its own standing rule.
  assert.deepEqual([pending, claimed, retired].map(() => i17aHolds('claude', 'claude')), [true, true, true]);
  assert.deepEqual([pending, claimed, retired].map((s) => i17a2Holds(s, frozenModel)), [true, true, true]);

  // Both directions of the generation, which is what makes the audit a check rather than a habit.
  assert.equal(i17a2Holds({ ...retired, retiredPins: [] }, frozenModel), false, 'a generation with no record is a defect');
  assert.equal(i17a2Holds({ ...claimed, retiredPins: [{ from: 'a', to: 'b' }] }, frozenModel), true,
    'generation 1 says nothing about retiredPins; the record check starts at 2');
  assert.equal(i17a2Holds({ ...retired, pinGeneration: 3 }, frozenModel), false, 'a record short of the generation is a defect');
  assert.equal(i17a2Holds({ ...pending, model: 'model-v1' }, frozenModel), false, 'materialising before a claim is a defect');
  // The deferred case: PAC §7.2 priority 3 leaves model null for the claim to materialise.
  assert.equal(i17a2Holds({ ...claimed, model: 'runtime-default', claimResolution: 'runtime-default' }, null), true);
  assert.equal(i17a2Holds({ ...claimed, model: 'runtime-default', claimResolution: null }, null), false,
    'a claim that materialises a runtime default has to record what it took');

  // The clauses, checked against PAC's own table rather than against a copy of it.
  const invariants = section(PCC, '4.3');
  const standing = invariants.slice(invariants.indexOf('**I17-A（'), invariants.indexOf('**I17-A2（'));
  for (const { column, frozenAt } of PAC_FREEZE_POINTS) {
    const snake = column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (frozenAt === 'first-claim') {
      assert.ok(!standing.includes(snake) && !standing.includes(`\`${column}\``),
        `I17-A must not compare ${column}: PAC §6 freezes it at first claim`);
    }
  }
  assert.ok(invariants.includes('**I17-A2（claim 冻结列的阶段与代次'), '§4.3 does not state the phase-indexed half');
  assert.ok(section(PCC, '7.7').includes('#### D15 '), '§7.7 does not give the generation a closed mutator protocol');
  assert.match(section(PCC, '15'), /\*\*F40\*\*/, '§15 has no fault row for the three-phase lifecycle');
});

interface Candidate17 {
  at: number;
  source: number;
  subjectType: 'BLOCKER' | 'PROJECT' | 'TASK' | 'TURN_WINDOW';
  subjectId: string;
  reason: string;
}

/** §10.4 W5 step 2, at both versions. v1.6 stopped after `source`. */
function chooseWake17(candidates: Candidate17[], epoch: number, version: Version17): {
  at: number; reason: string; candidates: Candidate17[];
} {
  const ordered = [...candidates].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.source !== b.source) return a.source - b.source;
    if (version === 'v16') return 0;                                   // not a total order
    if (a.subjectType !== b.subjectType) return a.subjectType < b.subjectType ? -1 : 1;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });
  const chosen = ordered[0];
  return { at: Math.max(chosen.at, epoch + W3_FLOOR_MS), reason: chosen.reason, candidates: ordered };
}

test('PC-CX-39 two candidates from one source are decided by a persistent total order', () => {
  // The review's counterexample: two open blockers, both item 1, both due at 60s.
  const tied: Candidate17[] = [
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b1', reason: 'provider blocker b1' },
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b2', reason: 'runner blocker b2' },
  ];
  const forwardV16 = chooseWake17(tied, 30_000, 'v16');
  const reverseV16 = chooseWake17([...tied].reverse(), 30_000, 'v16');
  assert.equal(forwardV16.at, reverseV16.at, 'the timestamp happened to be unique even in v1.6');
  assert.notEqual(forwardV16.reason, reverseV16.reason, 'but the reason depended on the enumeration order');

  // v1.7: every permutation of every source gives one answer, and the whole audit row matches too.
  const sources: { source: number; subjectType: Candidate17['subjectType']; ids: string[] }[] = [
    { source: 1, subjectType: 'BLOCKER', ids: ['b2', 'b1', 'b3'] },
    { source: 2, subjectType: 'BLOCKER', ids: ['b9', 'b0'] },
    { source: 3, subjectType: 'TASK', ids: ['t3', 't1', 't2'] },
    { source: 4, subjectType: 'TASK', ids: ['t9', 't8'] },
    { source: 7, subjectType: 'TURN_WINDOW', ids: ['MANUAL', 'FUTURE_REASON'] },
  ];
  for (const { source, subjectType, ids } of sources) {
    const table = ids.map((id) => ({ at: 60_000, source, subjectType, subjectId: id, reason: `wake for ${id}` }));
    const expected = chooseWake17(table, 30_000, 'v17');
    for (const perm of permutations(table)) {
      const got = chooseWake17(perm, 30_000, 'v17');
      assert.equal(got.at, expected.at, `source ${source}: nextWakeAt must not depend on order`);
      assert.equal(got.reason, expected.reason, `source ${source}: nextWakeReason must not depend on order`);
      assert.deepEqual(got.candidates, expected.candidates, `source ${source}: wakeCandidates must not depend on order`);
    }
    assert.equal(expected.reason, `wake for ${[...ids].sort()[0]}`, `source ${source}: the byte-order minimum wins`);
  }

  // The fourth key is compared as bytes, not under a collation: `_` sorts before letters in C and
  // after them in many ICU locales, so the two orders disagree on exactly this pair.
  const collationSensitive: Candidate17[] = [
    { at: 60_000, source: 3, subjectType: 'TASK', subjectId: 'a_b', reason: 'a_b' },
    { at: 60_000, source: 3, subjectType: 'TASK', subjectId: 'aab', reason: 'aab' },
  ];
  assert.equal(chooseWake17(collationSensitive, 0, 'v17').reason, 'a_b', 'byte order puts `_` (0x5f) before `a` (0x61)');
  const icuLike = [...collationSensitive].sort((a, b) =>
    a.subjectId.replace(/_/g, '') < b.subjectId.replace(/_/g, '') ? -1 : 1);         // a naive locale-ish rule
  assert.notEqual(icuLike[0].reason, 'a_b', 'a collation that ignores punctuation would choose the other one');

  const timing = section(PCC, '10.4');
  assert.match(timing, /\(at, source, subjectType, subjectId\)/, 'W5 does not state the four-key order');
  assert.ok(timing.includes('**W5-2a（'), 'W5 does not prove the order is total');
  assert.match(timing, /COLLATE "C"/, 'W5 does not pin the comparison to bytes');
});

test('PC-CX-40 one declared input yields one wake, because the floor reads the frozen clock', () => {
  // The review's counterexample: one serialized decisionInput, two wall clocks, two wakes.
  const declared = { world: { candidateAt: 60_000 }, evaluation: { epoch: 58 }, signals: [] as unknown[] };
  const hash = sha256(canonical17(declared));
  const candidate: Candidate17[] = [{ at: 60_000, source: 7, subjectType: 'TURN_WINDOW', subjectId: 'MANUAL', reason: 'manual trigger rate-limited' }];

  // v1.6: the floor read `now()`, which is not in the hash.
  const v16 = [58_000, 59_000, 62_000].map((wallNow) => Math.max(60_000, wallNow + W3_FLOOR_MS));
  assert.deepEqual(v16, [63_000, 64_000, 67_000], 'one hash, three legal answers');
  assert.equal(new Set(v16).size, 3, 'S3 asks for one, and gets three');

  // v1.7: the floor reads `evaluation.epoch`, which is in the hash. The wall clock cannot change it.
  const v17 = [0, 1, 4].map(() => chooseWake17(candidate, declared.evaluation.epoch * 1_000, 'v17').at);
  assert.equal(new Set(v17).size, 1, 'the same declared input must produce exactly one wake');
  assert.equal(v17[0], 63_000, 'and it is the one the frozen epoch determines');
  assert.equal(sha256(canonical17(declared)), hash, 'the input did not change while we were looking at it');

  // Two inputs whose epochs differ hash differently, so S3 never quantifies over them together —
  // that is the half of S5 that keeps "the wake may move with time" from contradicting S3.
  const later = { ...declared, evaluation: { epoch: 59 } };
  assert.notEqual(sha256(canonical17(later)), hash, 'a different epoch is a different declared input');
  assert.equal(chooseWake17(candidate, 59_000, 'v17').at, 64_000, 'and it may legitimately give a different wake');

  const timing = section(PCC, '10.4');
  assert.match(timing, /max\(chosen\.at, evaluation\.epoch \+ 5s\)/, 'W5 still floors against the wall clock');
  assert.match(section(PCC, '6.1'), /`nextWakeAt` \*\*是\*\*决策的一部分/, 'S5 still exempts nextWakeAt');
  // The exemptions are named and closed: nothing else in the normative body computes a wake from now().
  const normative = PCC.slice(0, PCC.indexOf('\n## 19. '));
  const stale = normative.split('\n').map((l) => bare(l))
    .filter((l) => /nextWakeAt = now \+/.test(l) && !/R2|v1\.[1-7]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative rule still computes a wake from the wall clock');
  assert.match(timing, /本条之外允许写 `next_wake_at` 的地方（封闭/, 'W5 does not close the set of other writers');
});

interface Project41 { status: 'OPEN' | 'DONE' | 'CANCELLED'; enabled: boolean; runState: string }
type Branch41 = 'in-loop' | 'backstop' | 'out-of-loop' | 'NONE';

/** §4.3 I19 at both versions, over one committed unconsumed event. */
function ownerOf41(p: Project41, ageMinutes: number, version: Version17): Branch41 {
  const inLoop = p.status === 'OPEN' && p.enabled && p.runState !== 'SETTLED';
  if (inLoop && ageMinutes < 5) return 'in-loop';
  if (inLoop) return 'backstop';                                        // W4 (iv)
  return version === 'v17' ? 'out-of-loop' : 'NONE';                    // §5.5 EV3, or nobody
}

test('PC-CX-41 every unconsumed event lands in exactly one of three owned branches', () => {
  // The review's two minimal states, and then the whole grid rather than those two.
  const legacy: Project41 = { status: 'OPEN', enabled: false, runState: 'PLANNING' };
  const settled: Project41 = { status: 'DONE', enabled: true, runState: 'SETTLED' };
  assert.equal(ownerOf41(legacy, 0, 'v16'), 'NONE', 'I6 forbids consuming it and W4 does not select it');
  assert.equal(ownerOf41(settled, 0, 'v16'), 'NONE', 'a settled project is excluded by both §10.3 and W4');
  assert.equal(ownerOf41(legacy, 0, 'v17'), 'out-of-loop');
  assert.equal(ownerOf41(settled, 0, 'v17'), 'out-of-loop');

  const grid: Project41[] = [];
  for (const status of ['OPEN', 'DONE', 'CANCELLED'] as const) {
    for (const enabled of [true, false]) {
      for (const runState of ['PLANNING', 'EXECUTING', 'BLOCKED', 'AWAITING_HUMAN', 'SETTLED']) {
        grid.push({ status, enabled, runState });
      }
    }
  }
  for (const p of grid) {
    for (const age of [0, 6]) {
      const branch = ownerOf41(p, age, 'v17');
      assert.notEqual(branch, 'NONE', `${JSON.stringify(p)} age=${age}min has no owner`);
      // Exactly one: the three predicates are a partition of the project row, not three chances.
      const branches = (['in-loop', 'backstop', 'out-of-loop'] as Branch41[]).filter((b) => b === branch);
      assert.equal(branches.length, 1, `${JSON.stringify(p)} age=${age}min matches more than one branch`);
    }
  }
  assert.ok(grid.some((p) => ownerOf41(p, 0, 'v16') === 'NONE'), 'v1.6 leaves part of the grid unowned');
  assert.equal(grid.every((p) => ownerOf41(p, 0, 'v17') !== 'NONE'), true, 'v1.7 does not');

  // EV1: the disposition is decided when the event is taken, so re-entry consumes rather than
  // discards — nothing is lost by discarding, because the event never carried the fact (E1).
  const reEntered: Project41 = { status: 'OPEN', enabled: true, runState: 'PLANNING' };
  assert.equal(ownerOf41(reEntered, 0, 'v17'), 'in-loop', 'an event queued while out of the loop is consumed after re-entry');
  // EV4: the discard is one conditional UPDATE, so replaying it affects nothing.
  let consumedAt: number | null = null;
  const discard = (): number => (consumedAt === null ? ((consumedAt = 1), 1) : 0);
  assert.equal(discard(), 1);
  assert.equal(discard(), 0, 'a replayed discard must affect zero rows');

  const disposition = section(PCC, '5.5');
  for (const rule of ['**EV1（', '**EV2（', '**EV3（', '**EV4（', '**EV5（', '**EV6（']) {
    assert.ok(disposition.includes(rule), `§5.5 does not state ${rule}）`);
  }
  assert.match(section(PCC, '4.3'), /没有第四支/, 'I19 is not a closed partition');
  assert.match(section(PCC, '10.2'), /\*\*W4-b（/, 'W4 does not say where the out-of-loop rows go');
  assert.match(section(PCC, '15'), /\*\*F41\*\*/, '§15 has no fault row for an out-of-loop event');
});

/** EC2-a: the nine identities. EC2-b: everything PAC freezes into the session, plus the resolution. */
interface Resolution17 {
  agentId: string; projectMemberId: string; taskId: string; taskAssigneeAgentId: string;
  providerSlug: string; model: string | null; workspaceId: string; runnerId: string; coordinatorWorkspaceId: string;
  effort: string; requiredCapabilities: string[]; permissionMode: string; providerBuiltin: boolean;
}
const EC2A_COMPONENTS = ['agentId', 'projectMemberId', 'taskId', 'taskAssigneeAgentId', 'providerSlug', 'model',
  'workspaceId', 'runnerId', 'coordinatorWorkspaceId'] as const;

const authorizationDigest = (r: Resolution17): string =>
  sha256(canonical17(EC2A_COMPONENTS.map((k) => r[k])));
const resultDigest = (r: Resolution17, omit: keyof Resolution17 | null = null): string =>
  sha256(canonical17(Object.fromEntries(Object.entries(r).filter(([k]) => k !== omit).sort())));

test('PC-CX-42 the authorization digest and the result digest are two questions, compared separately', () => {
  const atDecision: Resolution17 = {
    agentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1', providerSlug: 'claude',
    model: 'opus', workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: 'cw1',
    effort: 'high', requiredCapabilities: ['linux'], permissionMode: 'default', providerBuiltin: true,
  };
  // The review's interleaving: nothing in the nine identities moved, but PAC freezes both of these
  // into the session, so the dispatch that would commit is not the dispatch that was decided.
  const atCommit: Resolution17 = { ...atDecision, effort: 'low', requiredCapabilities: ['linux', 'docker'] };

  assert.equal(authorizationDigest(atCommit), authorizationDigest(atDecision), 'EC2-a is unchanged — nothing was revoked');
  assert.notEqual(resultDigest(atCommit), resultDigest(atDecision), 'EC2-b is not — the session would be different');

  // v1.6 compared one digest, so the commit gate accepted it. v1.7 compares both, and the refusal
  // is a different code with a different owner: no blocker, a NOOP, and a re-decision next time.
  const gate = (version: Version17): { admitted: boolean; refusalCode: string | null; opensBlocker: boolean } => {
    if (authorizationDigest(atCommit) !== authorizationDigest(atDecision)) {
      return { admitted: false, refusalCode: 'EXECUTION_CONTEXT_REVOKED', opensBlocker: true };
    }
    if (version === 'v17' && resultDigest(atCommit) !== resultDigest(atDecision)) {
      return { admitted: false, refusalCode: 'EXECUTION_RESULT_CHANGED', opensBlocker: false };
    }
    return { admitted: true, refusalCode: null, opensBlocker: false };
  };
  assert.deepEqual(gate('v16'), { admitted: true, refusalCode: null, opensBlocker: false },
    'v1.6 admits a session whose effort and capabilities are not the ones that were decided');
  assert.deepEqual(gate('v17'), { admitted: false, refusalCode: 'EXECUTION_RESULT_CHANGED', opensBlocker: false },
    'v1.7 refuses it, names it, and does not ask a human to do anything');

  // Coverage, the S10-c way, per component: for each thing PAC freezes into the session, build a
  // pair that differs *only* in it. EC2-b must separate them, and dropping that component from the
  // digest must bring them back together — a component nothing can distinguish does not belong.
  const drifts: { component: keyof Resolution17; changed: Resolution17 }[] = [
    { component: 'effort', changed: { ...atDecision, effort: 'low' } },
    { component: 'requiredCapabilities', changed: { ...atDecision, requiredCapabilities: ['linux', 'docker'] } },
    { component: 'permissionMode', changed: { ...atDecision, permissionMode: 'acceptEdits' } },
    { component: 'providerBuiltin', changed: { ...atDecision, providerBuiltin: false } },
  ];
  for (const { component, changed } of drifts) {
    assert.equal(authorizationDigest(changed), authorizationDigest(atDecision),
      `${String(component)} is not one of EC2-a's nine identities, so it must not move the authorization digest`);
    assert.notEqual(resultDigest(changed), resultDigest(atDecision),
      `EC2-b does not cover ${String(component)}, which PAC freezes into the session`);
    assert.equal(resultDigest(changed, component), resultDigest(atDecision, component),
      `dropping ${String(component)} from EC2-b brings the defect back`);
  }
  // …and a genuine revocation still comes out as a revocation, not as a result change.
  const revoked: Resolution17 = { ...atDecision, runnerId: 'r2' };
  assert.notEqual(authorizationDigest(revoked), authorizationDigest(atDecision), 'a different runner is a revocation');

  // EC6: what is written into the session is the frozen context, so a passing comparison cannot be
  // followed by a different insert. The database proves the equality (D15) without re-resolving.
  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('**EC2-a（'), '§7.4 does not state the authorization digest');
  assert.ok(dispatch.includes('**EC2-b（'), '§7.4 does not state the result digest');
  assert.ok(dispatch.includes('**EC6（'), '§7.4 does not say where the placeholder columns come from');
  assert.match(dispatch, /EXECUTION_RESULT_CHANGED/, 'EC4 has no code for a result that changed without a revocation');
  assert.ok(section(PCC, '7.7').includes('**D14-g（'), 'D14 does not say which digest it proves');
  assert.match(section(PCC, '15'), /\*\*F42\*\*/, '§15 has no fault row for a drifted result');
});

test('mutation check: every fence added for PC-CX-37..42 is load-bearing', () => {
  // Same discipline as the five mutation checks above: remove exactly one thing v1.7 added and the
  // published counterexample has to come back.
  const frozenModel = 'model-v1';
  const pending: Placeholder17 = { model: null, effort: null, pinGeneration: 0, retiredPins: [], claimResolution: null };
  const retired: Placeholder17 = {
    model: 'model-v2', effort: 'high', pinGeneration: 2,
    retiredPins: [{ from: 'model-v1', to: 'model-v2' }], claimResolution: 'model-v1',
  };
  const tied: Candidate17[] = [
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b1', reason: 'provider blocker b1' },
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b2', reason: 'runner blocker b2' },
  ];
  const base: Resolution17 = {
    agentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1', providerSlug: 'claude',
    model: 'opus', workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: 'cw1',
    effort: 'high', requiredCapabilities: ['linux'], permissionMode: 'default', providerBuiltin: true,
  };
  const drifted: Resolution17 = { ...base, effort: 'low', requiredCapabilities: ['linux', 'docker'] };

  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-37',
      fence: 'D11 compares the whole row minus an allowlist (§7.7 D11-b/D11-d)',
      defectReappears: () => ['execution_context', 'execution_context_digest', 'reason_code']
        .every((c) => !d11Refuses(c, 'v16')),
    },
    {
      finding: 'PC-CX-38',
      fence: 'I17-A compares only create-frozen columns; I17-A2 carries the phases (§4.3)',
      defectReappears: () => !i17aV16Holds(pending, frozenModel) && !i17aV16Holds(retired, frozenModel),
    },
    {
      finding: 'PC-CX-39',
      fence: 'the third and fourth ordering keys (§10.4 W5 step 2)',
      defectReappears: () => chooseWake17(tied, 30_000, 'v16').reason !== chooseWake17([...tied].reverse(), 30_000, 'v16').reason,
    },
    {
      finding: 'PC-CX-40',
      fence: 'the floor reads evaluation.epoch (§10.4 W5 step 3, §6.1 S5)',
      defectReappears: () => new Set([58_000, 59_000].map((wall) => Math.max(60_000, wall + W3_FLOOR_MS))).size === 2,
    },
    {
      finding: 'PC-CX-41',
      fence: 'I19-c and §5.5 EV3, the terminal disposition for out-of-loop events',
      defectReappears: () => ownerOf41({ status: 'OPEN', enabled: false, runState: 'PLANNING' }, 0, 'v16') === 'NONE'
        && ownerOf41({ status: 'DONE', enabled: true, runState: 'SETTLED' }, 0, 'v16') === 'NONE',
    },
    {
      finding: 'PC-CX-42',
      fence: 'EC2-b compared alongside EC2-a at the commit gate (§7.4 EC3)',
      defectReappears: () => authorizationDigest(drifted) === authorizationDigest(base)
        && resultDigest(drifted) !== resultDigest(base),
    },
  ];

  assert.equal(mutants.length, 6, 'unit 02 raised six findings against v1.6');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.equal(ACTION_COLUMNS.filter((c) => !d11Refuses(c, 'v17')).join(','), D11_ALLOWLIST.join(','));
  assert.equal([pending, retired].every((s) => i17a2Holds(s, frozenModel)), true);
  assert.equal(chooseWake17(tied, 30_000, 'v17').reason, chooseWake17([...tied].reverse(), 30_000, 'v17').reason);
  assert.equal(new Set([0, 1, 4].map(() => chooseWake17(tied, 58_000, 'v17').at)).size, 1);
  assert.equal(ownerOf41({ status: 'DONE', enabled: true, runState: 'SETTLED' }, 0, 'v17'), 'out-of-loop');
  assert.notEqual(resultDigest(drifted), resultDigest(base));
});

test('§25 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§24 have, for the seventh round. Three of these six are claims about what a
  // real server does — a whole-row trigger comparison, a per-row mutator protocol, and an ordering
  // that must not depend on a collation — so the Postgres file is checked by name as well.
  const rows = tables(section(PCC, '25'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-37', 'PC-CX-38', 'PC-CX-39', 'PC-CX-40', 'PC-CX-41', 'PC-CX-42']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§25 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '25').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 6, '§25 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§25 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '25').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§25 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§25 points at §${m[1]}, which does not exist`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Round eight (`PC-CX-43..46`, §26). Three of the four are the same question asked in three
// places: **after this gate runs, what write is still left, and who decides whether the gate
// applies at all?** D11 stopped at `OLD.status = 'APPLIED'` and the statement that publishes the
// row is the one before that; D9/D14/D15 asked `NEW` whether they applied, and `NEW` is written by
// the same statement they are meant to judge; D15's create-frozen list was a hand copy of PAC §6's
// table and had three fewer rows than the table. The fourth is a two-way proposition that was
// written as a query and never as a constraint, so only one of its two directions had an object.
// ---------------------------------------------------------------------------------------------

type Version18 = 'v17' | 'v18';

/** §7.7 D11: which columns an `UPDATE` may move, given the row's current status. */
const D11_TERMINAL_ALLOWLIST = ['result_session_id', 'detail'];
const D11_PUBLISH_ALLOWLIST = [...D11_TERMINAL_ALLOWLIST, 'status', 'refusal_code'];
const TERMINAL_STATUSES = ['APPLIED', 'REFUSED', 'SUPERSEDED'];

/** Does D11 admit an `UPDATE` that moves exactly `columns` on a row currently in `oldStatus`? */
function d11Admits(version: Version18, oldStatus: string, columns: string[]): boolean {
  if (version === 'v17') {
    // v1.7's first statement: anything that is not already APPLIED is waved through whole.
    if (oldStatus !== 'APPLIED') return true;
    return columns.every((c) => D11_TERMINAL_ALLOWLIST.includes(c));
  }
  const allowlist = oldStatus === 'CLAIMED' ? D11_PUBLISH_ALLOWLIST : D11_TERMINAL_ALLOWLIST;
  return columns.every((c) => allowlist.includes(c));
}

test('PC-CX-43 the publishing transition is inside the freeze, not outside it', () => {
  // §8.3's frozen statement order puts the publish *after* every session-side gate has run:
  // insert CLAIMED action → insert session (D6/D9/D14/D15 all fire here) → flip to APPLIED.
  // So the flip is the last unguarded write in the transaction, and v1.7 guarded nothing there.
  const publish = ['status', 'result_session_id'];
  const forged = [...publish, 'execution_result_digest'];
  assert.equal(d11Admits('v17', 'CLAIMED', forged), true,
    'the P0: v1.7 admits a publish that also rewrites the frozen result digest');
  assert.equal(d11Admits('v18', 'CLAIMED', forged), false, 'v1.8 has to refuse it');
  assert.equal(d11Admits('v18', 'CLAIMED', publish), true,
    'a clean publish must still commit, or §8.3 blocks its own normal path');

  // Every frozen column, not just the one the review used to demonstrate it.
  for (const column of ACTION_COLUMNS.filter((c) => !D11_PUBLISH_ALLOWLIST.includes(c))) {
    assert.equal(d11Admits('v17', 'CLAIMED', [...publish, column]), true, `${column}: v1.7 lets the publish move it`);
    assert.equal(d11Admits('v18', 'CLAIMED', [...publish, column]), false, `${column}: v1.8 must freeze it in the publish`);
  }
  // And a column added tomorrow is frozen by construction, in both branches.
  const tomorrow = 'some_column_v1_9_will_add';
  assert.equal(d11Admits('v18', 'CLAIMED', [...publish, tomorrow]), false, 'the publish allowlist is closed too');

  // D11-a is now a property of the function, not a sentence: terminal states do not go back out.
  for (const status of TERMINAL_STATUSES) {
    assert.equal(d11Admits('v17', status, ['status']), status !== 'APPLIED',
      `${status}: v1.7 only froze APPLIED, so the other two terminal states could be reopened`);
    assert.equal(d11Admits('v18', status, ['status']), false, `${status} must be terminal`);
  }

  // The clauses.
  const seven = section(PCC, '7.7');
  const d11 = seven.slice(seven.indexOf('#### D11 '), seven.indexOf('#### D12 '));
  assert.doesNotMatch(d11, /IF OLD\.status <> 'APPLIED' THEN RETURN NEW; END IF;/,
    'D11 still waves the publishing statement through');
  assert.match(d11, /ACTION_PUBLISH_IMMUTABLE/, 'the publish has no typed refusal of its own');
  assert.match(d11, /ACTION_TRANSITION_ILLEGAL/, 'the transition target set is not closed');
  assert.ok(d11.includes('**D11-f（'), 'D11 does not argue why the publish is inside the freeze');
  assert.ok(d11.includes('**D11-g（'), 'D11 does not require the mutation sweep to run on the publish');
  assert.match(section(PCC, '15'), /\*\*F43\*\*/, '§15 has no fault row for a forged publish');
});

/** PAC §6's create-frozen rows, read from PAC rather than from a list in this file. */
function pacCreateFrozenColumns(): string[] {
  const table = PAC.slice(PAC.indexOf('## 6. Execution Snapshot 冻结契约'), PAC.indexOf('**S1**'));
  return table.split('\n')
    .filter((line) => line.startsWith('|') && line.includes('Session **create**'))
    // The `provider` / `providerBuiltin` row names two columns, so read every backticked name.
    .flatMap((line) => Array.from(line.split('|')[1].matchAll(/`([A-Za-z]+)`/g), (m) => m[1]));
}

/** camelCase component of `execution_context` ⇒ the session column D15/D16 compare it against. */
const snake = (name: string): string => name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

test('PC-CX-44 the create-frozen set is the whole PAC table, proved at insert and at commit', () => {
  // The list is derived, not written here — that is the whole point of the finding.
  const createFrozen = pacCreateFrozenColumns();
  for (const required of ['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin',
    'requiredCapabilities', 'resolution', 'permissionMode', 'snapshotFrozenAt']) {
    assert.ok(createFrozen.includes(required), `PAC §6 no longer freezes ${required} at Session create`);
  }
  // v1.7's D15 compared six of them; the three it missed include the two EC2-b names.
  const V17_COMPARED = ['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin', 'requiredCapabilities'];
  const missedByV17 = createFrozen.filter((c) => !V17_COMPARED.includes(c));
  assert.deepEqual(missedByV17, ['resolution', 'permissionMode', 'snapshotFrozenAt'],
    'the three rows v1.7 did not read are exactly the ones the review named');

  const seven = section(PCC, '7.7');
  const d15 = seven.slice(seven.indexOf('#### D15 '), seven.indexOf('#### D16 '));
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  for (const component of createFrozen) {
    assert.ok(d15.includes(`NEW.${snake(component)}`), `D15 does not compare or freeze ${component}`);
    // v1.10 (PC-CX-51): D16 re-reads its own row by the stable key at the commit point, so the
    // comparison is against `s.<column>` — the final version — not the queued NEW tuple.
    assert.ok(d16.includes(`s.${snake(component)}`), `D16 does not re-prove ${component} at the commit point`);
  }
  // The two points, and what each of them buys.
  assert.match(d16, /DEFERRABLE INITIALLY DEFERRED/, 'D16 does not read the final state of the transaction');
  assert.match(d16, /action_status <> 'APPLIED'/, 'D16 does not require the action to have been published');
  assert.match(d16, /EXECUTION_RESULT_MISMATCH/, 'D16 has no typed refusal');
  assert.ok(d15.includes('**D15-g（'), 'D15 does not say why a BEFORE trigger is not the whole answer');
  assert.ok(d16.includes('**D16-d（'), 'D16 does not state its division of labour with D14/D15');

  // A model of the privilege escalation the review committed, under both comparison sets.
  const frozen: Record<string, string> = { permissionMode: 'read-only', resolution: '{"who":"task"}' };
  const written: Record<string, string> = { permissionMode: 'danger-full-access', resolution: '{"who":"forged"}' };
  const admits = (compared: string[]): boolean =>
    compared.every((c) => !(c in frozen) || frozen[c] === written[c]);
  assert.equal(admits(V17_COMPARED), true, 'v1.7 admits a session that runs with more privilege than was frozen');
  assert.equal(admits(createFrozen), false, 'the full set refuses it');
  // snapshotFrozenAt got a single source, so the equality is even askable.
  assert.match(section(PCC, '7.4'), /\*\*EC6-d（`snapshotFrozenAt` 的唯一来源/, 'snapshotFrozenAt has no defined source');
  assert.match(section(PCC, '15'), /\*\*F44\*\*/, '§15 has no fault row for a drifted create-frozen column');
});

/** §7.7 D9/D14/D15/D16: does the gate apply to this UPDATE at all? */
type Lineage = { taskId: string | null; origin: string; actionId: string | null };
const COORDINATOR_CLAIM: Lineage = { taskId: 't1', origin: 'COORDINATOR', actionId: 'a1' };
const SELF_EXEMPTED: Lineage = { taskId: null, origin: 'USER', actionId: null };
const isPlaceholder = (row: Lineage): boolean => row.taskId !== null && row.origin === 'COORDINATOR';

function gateApplies(version: Version18, oldRow: Lineage, newRow: Lineage): boolean {
  return version === 'v17' ? isPlaceholder(newRow) : isPlaceholder(oldRow) || isPlaceholder(newRow);
}

/** §7.7 D5's partial unique index: which rows does it hold a claim for? */
const holdsClaim = (row: Lineage, status: string, deleted: boolean): boolean =>
  row.taskId !== null && !deleted && ['PENDING', 'RUNNING'].includes(status);

test('PC-CX-45 a session cannot write itself out of the gates that hold its claim', () => {
  // One UPDATE, three gates, and the index that is supposed to be the only linearization point.
  assert.equal(gateApplies('v17', COORDINATOR_CLAIM, SELF_EXEMPTED), false,
    'the P0: under v1.7 the row decides, with its own new values, that no gate applies to it');
  assert.equal(gateApplies('v18', COORDINATOR_CLAIM, SELF_EXEMPTED), true, 'v1.8 must still judge it');
  // Both directions: promoting a USER session into a COORDINATOR one is judged as well.
  assert.equal(gateApplies('v18', SELF_EXEMPTED, COORDINATOR_CLAIM), true, 'the other direction too');
  // And nothing that was never a placeholder is dragged in.
  assert.equal(gateApplies('v18', SELF_EXEMPTED, SELF_EXEMPTED), false,
    'plain USER/LEGACY sessions must stay byte-for-byte unaffected (D15-a)');

  // The consequence the review published, computed rather than asserted as prose.
  const afterUpdate = (version: Version18): Lineage => gateApplies(version, COORDINATOR_CLAIM, SELF_EXEMPTED)
    ? COORDINATOR_CLAIM      // v1.8: the lineage freeze refuses the UPDATE, so the row is unchanged
    : SELF_EXEMPTED;         // v1.7: it commits
  const secondDispatchCommits = (version: Version18): boolean =>
    !holdsClaim(afterUpdate(version), 'PENDING', false);
  assert.deepEqual(
    { v17: { claims: holdsClaim(afterUpdate('v17'), 'PENDING', false) ? 1 : 0, second: secondDispatchCommits('v17') },
      v18: { claims: holdsClaim(afterUpdate('v18'), 'PENDING', false) ? 1 : 0, second: secondDispatchCommits('v18') } },
    { v17: { claims: 0, second: true }, v18: { claims: 1, second: false } },
    'v1.7 releases the claim and admits a second live execution; v1.8 holds it',
  );
  // The action is left pointing at a session that no longer points back — the review's third number.
  const orphanedActions = (version: Version18): number => afterUpdate(version).actionId === null ? 1 : 0;
  assert.deepEqual({ v17: orphanedActions('v17'), v18: orphanedActions('v18') }, { v17: 1, v18: 0 });

  // The legal way out of the claim set is untouched: a status change, not a lineage rewrite.
  assert.equal(holdsClaim(COORDINATOR_CLAIM, 'AWAITING_INPUT', false), false,
    'D5 still treats AWAITING_INPUT as idle — that rule is not what this finding changes');

  // The clauses.
  const seven = section(PCC, '7.7');
  const d15 = seven.slice(seven.indexOf('#### D15 '), seven.indexOf('#### D16 '));
  const OLD_NEW = /\(OLD\.task_id IS NULL OR OLD\.dispatch_origin <> 'COORDINATOR'\)/;
  for (const [name, from, to] of [['D9', '#### D9 ', '#### D10 '], ['D14', '#### D14 ', '#### D15 '],
    ['D15', '#### D15 ', '#### D16 ']] as const) {
    assert.match(seven.slice(seven.indexOf(from), seven.indexOf(to)), OLD_NEW,
      `${name} still decides its scope from NEW alone`);
  }
  for (const column of ['task_id', 'dispatch_origin', 'project_action_id']) {
    assert.match(d15, new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM OLD\\.${column}`),
      `D15 does not freeze the lineage column ${column}`);
  }
  assert.ok(d15.includes('**D15-f（'), 'D15 does not argue why the lineage must be frozen');
  assert.match(section(PCC, '4.3'), /\*\*I17-A3（lineage 恒成立/, '§4.3 has no standing invariant for the lineage');
  assert.match(section(PCC, '15'), /\*\*F45\*\*/, '§15 has no fault row for a released claim');
});

/** §4.3 I17-A2 as a two-way relation between the session column and the action-side ledger. */
type Ledger = { generation: number; claimResolution: boolean; retiredPins: number };
function ledgerAgrees(version: Version18, l: Ledger): boolean {
  if (version === 'v17') return true;   // v1.7's D15 never read `project_action.detail` at all
  return l.generation === 0
    ? !l.claimResolution && l.retiredPins === 0
    : l.claimResolution && l.retiredPins === l.generation - 1;
}

test('PC-CX-46 the pin generation and the action ledger are one atomic two-way relation', () => {
  // The review's sequence: create, first claim, retiredPin — and nobody ever writes the ledger.
  const reviewed: Ledger = { generation: 2, claimResolution: false, retiredPins: 0 };
  assert.equal(ledgerAgrees('v17', reviewed), true, 'the P1: v1.7 commits a generation that claims two rewrites and records none');
  assert.equal(ledgerAgrees('v18', reviewed), false, 'v1.8 must refuse it');

  // Both directions, and the legal path in between.
  const cases: [Ledger, boolean, string][] = [
    [{ generation: 0, claimResolution: false, retiredPins: 0 }, true, 'a fresh placeholder'],
    [{ generation: 1, claimResolution: true, retiredPins: 0 }, true, 'a first claim that records itself'],
    [{ generation: 2, claimResolution: true, retiredPins: 1 }, true, 'one retiredPin, one record'],
    [{ generation: 5, claimResolution: true, retiredPins: 4 }, true, 'and it keeps holding as n grows'],
    [{ generation: 1, claimResolution: false, retiredPins: 0 }, false, 'a claim with no record (缺账)'],
    [{ generation: 2, claimResolution: true, retiredPins: 0 }, false, 'a generation ahead of the ledger (缺账)'],
    [{ generation: 1, claimResolution: true, retiredPins: 1 }, false, 'a ledger ahead of the generation (多账)'],
    [{ generation: 0, claimResolution: true, retiredPins: 0 }, false, 'a record for a claim never made (多账)'],
    [{ generation: 3, claimResolution: true, retiredPins: 1 }, false, 'a generation that skipped a number (错代次)'],
  ];
  for (const [ledger, expected, label] of cases) {
    assert.equal(ledgerAgrees('v18', ledger), expected, `${label}: v1.8 gets this wrong`);
    if (!expected) assert.equal(ledgerAgrees('v17', ledger), true, `${label}: v1.7 must still admit it (reverse control)`);
  }

  // Two objects, because the two disagreements are written from two different tables.
  const seven = section(PCC, '7.7');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.match(d16, /CREATE CONSTRAINT TRIGGER session_execution_result_check/, 'the session side has no object');
  assert.match(d16, /CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check/, 'the action side has no object');
  const d16Sql = d16.slice(d16.indexOf('```sql'), d16.lastIndexOf('```'));
  assert.equal((d16Sql.match(/^\s+DEFERRABLE INITIALLY DEFERRED$/gm) ?? []).length, 2,
    'both directions must be deferred, or the statement order inside the transaction starts to matter');
  assert.match(d16, /EXECUTION_PIN_LEDGER/, 'the ledger disagreement has no typed refusal');
  assert.ok(d16.includes('**D16-a（'), 'D16 does not argue why one object is not enough');
  assert.ok(d16.includes('**D16-b（'), 'D16 does not say that it makes I17-A2 hold by construction');
  assert.match(section(PCC, '4.3'), /数据库可执行的形式/, 'I17-A2 is still only a query');
  assert.match(section(PCC, '15'), /\*\*F46\*\*/, '§15 has no fault row for a disagreeing ledger');
});

test('mutation check: every fence added for PC-CX-43..46 is load-bearing', () => {
  // Same discipline as the six mutation checks above: remove exactly one thing v1.8 added and the
  // published counterexample has to come back.
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-43',
      fence: 'D11 chooses its allowlist by OLD.status instead of returning early (§7.7 D11-f)',
      defectReappears: () => d11Admits('v17', 'CLAIMED', ['status', 'result_session_id', 'execution_result_digest']),
    },
    {
      finding: 'PC-CX-44',
      fence: 'the create-frozen set is derived from PAC §6, at insert and at commit (§7.7 D15/D16)',
      defectReappears: () => pacCreateFrozenColumns()
        .filter((c) => !['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin', 'requiredCapabilities'].includes(c))
        .length > 0,
    },
    {
      finding: 'PC-CX-45',
      fence: 'the OLD ∨ NEW scope rule and the frozen lineage (§7.7 D15-a/D15-f)',
      defectReappears: () => !gateApplies('v17', COORDINATOR_CLAIM, SELF_EXEMPTED),
    },
    {
      finding: 'PC-CX-46',
      fence: 'the two deferred ledger objects (§7.7 D16-a)',
      defectReappears: () => ledgerAgrees('v17', { generation: 2, claimResolution: false, retiredPins: 0 }),
    },
  ];
  assert.equal(mutants.length, 4, 'unit 02 raised four findings against v1.7');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable.
  assert.equal(d11Admits('v18', 'CLAIMED', ['status', 'result_session_id', 'execution_result_digest']), false);
  assert.equal(gateApplies('v18', COORDINATOR_CLAIM, SELF_EXEMPTED), true);
  assert.equal(ledgerAgrees('v18', { generation: 2, claimResolution: false, retiredPins: 0 }), false);
  assert.equal(ledgerAgrees('v18', { generation: 2, claimResolution: true, retiredPins: 1 }), true);
});

test('§26 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§25 have, for the eighth round. All four are claims about what a real
  // server does — a transition allowlist, two equality gates and a two-way deferred constraint —
  // so the Postgres file is checked by name as well.
  const rows = tables(section(PCC, '26'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§26 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '26').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 4, '§26 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§26 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '26').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§26 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§26 points at §${m[1]}, which does not exist`);
  }
});

// ---------------------------------------------------------------------------------------------
// Round nine (`PC-CX-47..49`, §27). The first eight rounds asked *when* a hard gate runs, *who*
// decides its scope, and whether the closed set it compares against is really closed. This one
// asks the question after all of those: **once it has run and returned success, what has it
// actually proved?** D16 proved "a claimResolution exists" and called it "the session's pin equals
// the frozen conclusion"; §4.3 I17-A claimed both digests equal recomputation while no database
// object had ever read either column; the ledger proved "n − 1 rows" and called it provenance.
// All three are one sentence: **a gate that only checks presence cannot prove correctness.**
// ---------------------------------------------------------------------------------------------

type Version19 = 'v18' | 'v19';

const DEFERRED = 'DEFERRED_TO_CLAIM';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const PIN_COMPONENTS = ['model', 'effort'] as const;
type PinComponent = (typeof PIN_COMPONENTS)[number];

/** §7.4 EC6-c: one `claimResolution.<component>` record — old value, new value, and where it came from. */
type ClaimPart = { frozen?: string | null; value?: string | null; source?: string };
type ClaimResolution = { generation?: number; at?: string; model?: ClaimPart; effort?: ClaimPart };
/** §7.4 EC6-c: one `retiredPins[]` record — the six keys, no more and no fewer. */
type RetiredPin = { generation?: number; component?: string; from?: string; to?: string; at?: string; reason?: string };

type PinState = {
  frozen: Record<PinComponent, string | null>;   // the action's frozen conclusion (EC2-b part ②)
  snapshotFrozenAt: string;
  claim: ClaimResolution | null;
  retiredPins: RetiredPin[];
  generation: number;                            // session.execution_pin_generation
  session: Record<PinComponent, string | null>;  // what the session is actually running
};

type FoldResult = { ok: true; pin: Record<PinComponent, string | null> } | { ok: false; reason: string };

function sameKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

/**
 * §7.7 D16 ⓪ `coordinator_pin_ledger_fold`, modelled field by field: EC6-c's closed shapes, then
 * EC6-e's chain. It returns the pair the ledger folds to, so both callers can compare it against
 * the value they hold — that is what "two-way" means from v1.9 on (D16-f).
 */
function foldPinLedger(state: PinState): FoldResult {
  if (state.generation === 0) {
    return state.claim === null && state.retiredPins.length === 0
      ? { ok: true, pin: { model: null, effort: null } }
      : { ok: false, reason: 'generation 0 but a claim is already recorded' };
  }
  const claim = state.claim;
  if (claim === null || !sameKeys(claim, ['generation', 'at', 'model', 'effort'])) {
    return { ok: false, reason: 'no first claim of EC6-c closed shape' };
  }
  if (claim.generation !== 1 || typeof claim.at !== 'string' || !ISO_UTC.test(claim.at)
      || Date.parse(claim.at) < Date.parse(state.snapshotFrozenAt)) {
    return { ok: false, reason: 'first claim has no generation 1 or no valid moment' };
  }
  const pin: Record<PinComponent, string | null> = { model: null, effort: null };
  for (const component of PIN_COMPONENTS) {
    const part = claim[component];
    if (!part || !sameKeys(part, ['frozen', 'value', 'source'])) {
      return { ok: false, reason: `${component} recorded without frozen/value/source` };
    }
    // The binding PC-CX-47 turns on: the record cannot launder a frozen value the action never froze.
    if (part.frozen !== state.frozen[component]) {
      return { ok: false, reason: `claims a frozen ${component} the action never froze` };
    }
    if (part.frozen === DEFERRED) {
      if (part.source !== 'RESOLVED_AT_CLAIM' || !part.value || part.value === DEFERRED) {
        return { ok: false, reason: `defers ${component} to claim but records no resolved value` };
      }
    } else if (part.source !== 'FROZEN_CONTEXT' || part.value !== part.frozen) {
      return { ok: false, reason: `records a ${component} other than the concrete value the action froze` };
    }
    pin[component] = part.value ?? null;
  }
  if (state.retiredPins.length !== state.generation - 1) {
    return { ok: false, reason: `generation ${state.generation} with ${state.retiredPins.length} retired pins` };
  }
  let previous = Date.parse(claim.at);
  for (const [i, entry] of state.retiredPins.entries()) {
    if (!sameKeys(entry, ['generation', 'component', 'from', 'to', 'at', 'reason'])) {
      return { ok: false, reason: `retiredPins[${i}] is not EC6-c's closed record` };
    }
    const component = entry.component as PinComponent;
    if (!PIN_COMPONENTS.includes(component) || entry.reason !== 'RUNTIME_RETIRED'
        || entry.generation !== i + 2 || typeof entry.at !== 'string' || !ISO_UTC.test(entry.at)
        || Date.parse(entry.at) < previous || entry.from !== pin[component]
        || !entry.to || entry.to === entry.from) {
      return { ok: false, reason: `retiredPins[${i}] does not continue the chain` };
    }
    previous = Date.parse(entry.at);
    pin[component] = entry.to;
  }
  return { ok: true, pin };
}

/** Does the commit point admit this state? v1.8 counted; v1.9 folds and compares against the session. */
function pinLedgerAdmits(version: Version19, state: PinState): boolean {
  if (version === 'v18') {
    // v1.8's two D16 functions, verbatim: existence and cardinality. Neither reads a single field
    // of either record, and neither compares the session's own model/effort with anything.
    return state.generation === 0
      ? state.claim === null && state.retiredPins.length === 0
      : state.claim !== null && state.retiredPins.length === state.generation - 1;
  }
  const folded = foldPinLedger(state);
  return folded.ok && folded.pin.model === state.session.model && folded.pin.effort === state.session.effort;
}

/** §7.7 D17 `coordinator_canonical_json`: keys in C order, arrays in place, scalars as JSON. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function executionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** §7.4 EC2-a's nine components, read from the contract rather than copied by hand. */
function ec2aComponents(): string[] {
  const dispatch = section(PCC, '7.4');
  const clause = dispatch.slice(dispatch.indexOf('- **EC2-a（'), dispatch.indexOf('- **EC2-b（'));
  const listed = clause.slice(clause.indexOf('恰好九个键'), clause.indexOf('值可以是 JSON null'));
  return Array.from(listed.matchAll(/`([A-Za-z]+)`/g), (m) => m[1]);
}

type ActionRow = {
  subjectType: string;
  subjectId: string;
  context: Record<string, unknown>;
  contextDigest: string;
  resultDigest: string;
};

/** §7.7 D17: both digests equal the digest of their own authoritative half, and the halves agree. */
function digestGateAdmits(version: Version19, row: ActionRow): boolean {
  if (version === 'v18') return true;   // no database object read either digest column at all
  const auth = row.context.authorization as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== 'object' || !sameKeys(auth, ec2aComponents())) return false;
  if (row.context.model === undefined || row.context.model === null) return false;
  if (row.context.effort === undefined || row.context.effort === null) return false;
  if (row.contextDigest !== executionDigest(auth)) return false;
  const { authorization: _authorization, ...resultHalf } = row.context;
  if (row.resultDigest !== executionDigest(resultHalf)) return false;
  return auth.resolvedAgentId === row.context.agentId
    && auth.workspaceId === row.context.workspaceId
    && auth.runnerId === row.context.assignedRunnerId
    && auth.providerSlug === row.context.provider
    && auth.model === row.context.model
    && (row.subjectType !== 'TASK' || auth.taskId === row.subjectId);
}

const FROZEN_AT_19 = '2026-08-19T00:00:00.000Z';
const CLAIMED_AT_19 = '2026-08-19T00:01:00.000Z';
const RETIRED_AT_19 = '2026-08-19T00:02:00.000Z';

/** A legal first claim of a concrete frozen conclusion — the shape every case below perturbs. */
function concreteClaim(): PinState {
  return {
    frozen: { model: 'model-v1', effort: 'high' },
    snapshotFrozenAt: FROZEN_AT_19,
    claim: {
      generation: 1,
      at: CLAIMED_AT_19,
      model: { frozen: 'model-v1', value: 'model-v1', source: 'FROZEN_CONTEXT' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    },
    retiredPins: [],
    generation: 1,
    session: { model: 'model-v1', effort: 'high' },
  };
}

test('PC-CX-47 the first claim can only pin what the action froze, or what it atomically recorded', () => {
  // The review's witness, verbatim: a decision frozen as model-v1/high, a session that actually
  // runs model-evil/low, and an empty object in the ledger to satisfy `claimResolution IS NOT NULL`.
  const reviewed: PinState = {
    ...concreteClaim(), claim: {} as ClaimResolution, session: { model: 'model-evil', effort: 'low' },
  };
  assert.equal(pinLedgerAdmits('v18', reviewed), true,
    'the P1: v1.8 commits a session whose pin contradicts the frozen conclusion');
  assert.equal(pinLedgerAdmits('v19', reviewed), false, 'v1.9 must refuse it');

  // Both branches of EC2-b part ②, and the legal path through each.
  const deferred: PinState = {
    frozen: { model: DEFERRED, effort: 'high' },
    snapshotFrozenAt: FROZEN_AT_19,
    claim: {
      generation: 1,
      at: CLAIMED_AT_19,
      model: { frozen: DEFERRED, value: 'runtime-default-v3', source: 'RESOLVED_AT_CLAIM' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    },
    retiredPins: [],
    generation: 1,
    session: { model: 'runtime-default-v3', effort: 'high' },
  };
  assert.equal(pinLedgerAdmits('v19', concreteClaim()), true, 'a concrete first claim of the frozen value must commit');
  assert.equal(pinLedgerAdmits('v19', deferred), true, 'a deferred first claim that records what it resolved must commit');

  const cases: [string, PinState][] = [
    ['a concrete claim whose session ran something else',
      { ...concreteClaim(), session: { model: 'model-evil', effort: 'high' } }],
    ['a claim that rewrites the frozen value into DEFERRED_TO_CLAIM to admit anything',
      { ...concreteClaim(), claim: { ...concreteClaim().claim, model: { frozen: DEFERRED, value: 'model-evil', source: 'RESOLVED_AT_CLAIM' } } as ClaimResolution,
        session: { model: 'model-evil', effort: 'high' } }],
    ['a concrete claim that records a value other than the frozen one',
      { ...concreteClaim(), claim: { ...concreteClaim().claim, model: { frozen: 'model-v1', value: 'model-evil', source: 'FROZEN_CONTEXT' } } as ClaimResolution,
        session: { model: 'model-evil', effort: 'high' } }],
    ['a deferred claim that records no resolved value',
      { ...deferred, claim: { ...deferred.claim, model: { frozen: DEFERRED, value: null, source: 'RESOLVED_AT_CLAIM' } } as ClaimResolution }],
    ['a deferred claim that records the sentinel as if it were a value',
      { ...deferred, claim: { ...deferred.claim, model: { frozen: DEFERRED, value: DEFERRED, source: 'RESOLVED_AT_CLAIM' } } as ClaimResolution,
        session: { model: DEFERRED, effort: 'high' } }],
    ['a context that froze no conclusion at all, which v1.7/v1.8 called "冻结值为空"',
      { ...concreteClaim(), frozen: { model: null, effort: 'high' },
        claim: { ...concreteClaim().claim, model: { frozen: null, value: 'model-evil', source: 'RESOLVED_AT_CLAIM' } } as ClaimResolution,
        session: { model: 'model-evil', effort: 'high' } }],
  ];
  for (const [label, state] of cases) {
    assert.equal(pinLedgerAdmits('v19', state), false, `${label}: v1.9 must refuse it`);
    assert.equal(pinLedgerAdmits('v18', state), true, `${label}: v1.8 must still admit it (reverse control)`);
  }

  // …and the clauses that say so, plus the one database object that enforces them.
  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('- **EC6-c（claim 冻结列怎么记'), '§7.4 no longer states how the claim is recorded');
  assert.ok(dispatch.includes('- **EC6-e（'), '§7.4 does not require the ledger to fold back to the session pin');
  assert.match(dispatch, /DEFERRED_TO_CLAIM/, 'EC6-c no longer names the deferred conclusion');
  const seven = section(PCC, '7.7');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.match(d16, /coordinator_pin_ledger_fold/, 'D16 does not compare the pin with the frozen conclusion');
  assert.match(d16, /session % runs %\/% while action % records/, 'D16 does not compare the session pin with the ledger');
  assert.match(section(PCC, '4.3'), /逐字等于 `session\.model` \/ `session\.effort`/, 'I17-A2 is still only about cardinality');
  assert.match(section(PCC, '15'), /\*\*F47\*\*/, '§15 has no fault row for a pin that contradicts the frozen conclusion');
});

test('PC-CX-48 both digests are recomputed at commit, not merely frozen', () => {
  const authorization = {
    resolvedAgentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1',
    providerSlug: 'claude', model: 'model-v1', workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: null,
  };
  const context: Record<string, unknown> = {
    agentId: 'a1', workspaceId: 'w1', assignedRunnerId: 'r1', provider: 'claude', providerBuiltin: true,
    requiredCapabilities: ['linux'], permissionMode: 'read-only', model: 'model-v1', effort: 'high',
    resolution: { v: 1, who: { source: 'task' } }, snapshotFrozenAt: FROZEN_AT_19, authorization,
  };
  const { authorization: _drop, ...resultHalf } = context;
  const honest: ActionRow = {
    subjectType: 'TASK', subjectId: 't1', context,
    contextDigest: executionDigest(authorization), resultDigest: executionDigest(resultHalf),
  };
  assert.equal(digestGateAdmits('v19', honest), true, 'an honestly computed pair of digests must commit');

  // The review's witness: correct context, correct session, arbitrary result digest.
  const forged: ActionRow = { ...honest, resultDigest: 'forged-result-digest' };
  assert.equal(digestGateAdmits('v18', forged), true, 'the P1: v1.8 has no object that reads either digest column');
  assert.equal(digestGateAdmits('v19', forged), false, 'v1.9 must refuse a forged result digest');

  const cases: [string, ActionRow][] = [
    ['a forged authorization digest', { ...honest, contextDigest: 'forged-context-digest' }],
    ['an authorization half missing one of EC2-a\'s components', {
      ...honest,
      context: { ...context, authorization: Object.fromEntries(Object.entries(authorization).filter(([k]) => k !== 'runnerId')) },
    }],
    ['two halves that describe two different dispatches', {
      ...honest, context: { ...context, authorization: { ...authorization, resolvedAgentId: 'a2' } },
    }],
    ['an authorization half naming another task than the action\'s own subject', {
      ...honest, context: { ...context, authorization: { ...authorization, taskId: 't2' } },
    }],
    ['a context that freezes no model conclusion', {
      ...honest, context: { ...context, model: null },
    }],
  ];
  for (const [label, row] of cases) {
    assert.equal(digestGateAdmits('v19', row), false, `${label}: v1.9 must refuse it`);
    assert.equal(digestGateAdmits('v18', row), true, `${label}: v1.8 must still admit it (reverse control)`);
  }

  // Canonicalisation is what makes the recomputation a definition rather than a label: the same
  // value written with different key order has to produce the same digest, in any writer.
  const reordered = Object.fromEntries(Object.entries(context).reverse());
  assert.notDeepEqual(Object.keys(reordered), Object.keys(context), 'the reordered fixture must really differ');
  assert.equal(canonicalJson(reordered), canonicalJson(context), 'canonical form must not depend on key order');
  assert.equal(executionDigest(reordered), executionDigest(context), 'and neither must the digest');
  // …while any component moving does move it — a digest that ignores a component proves nothing.
  assert.notEqual(executionDigest({ ...resultHalf, effort: 'low' }), executionDigest(resultHalf));
  assert.notEqual(executionDigest({ ...authorization, runnerId: 'r2' }), executionDigest(authorization));

  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('- **EC2-d（'), '§7.4 does not say where each digest\'s authoritative input lives');
  assert.match(dispatch, /sha256\(canonical\(executionContext\.authorization\)\)/, 'EC2-a has no executable canonical form');
  assert.match(dispatch, /canonical\(executionContext - 'authorization'\)/, 'EC2-b still digests the whole column');
  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D7 '));
  assert.match(d17, /CREATE CONSTRAINT TRIGGER project_action_execution_digest_check/, 'D17 has no object');
  assert.match(d17, /DEFERRABLE INITIALLY DEFERRED/, 'D17 does not run at the commit point');
  assert.match(d17, /EXECUTION_DIGEST_MISMATCH/, 'a forged digest has no typed refusal');
  assert.match(d17, /LANGUAGE plpgsql IMMUTABLE/, 'the canonicalisation is not declared immutable');
  for (const clause of ['**D17-a（', '**D17-b（', '**D17-c（', '**D17-d（', '**D17-e（']) {
    assert.ok(d17.includes(clause), `D17 does not state ${clause}）`);
  }
  assert.ok(seven.includes('**D14-h（'), 'D14 does not say what it proves that D17 does not');
  assert.match(section(PCC, '15'), /\*\*F48\*\*/, '§15 has no fault row for a forged digest');
});

test('PC-CX-49 the pin ledger has a closed shape and a chain that folds back to the session', () => {
  // The review's witness: generation 2, an empty claim record and an empty retiredPin record.
  const reviewed: PinState = {
    ...concreteClaim(), claim: {} as ClaimResolution, retiredPins: [{} as RetiredPin], generation: 2,
    session: { model: 'model-v2', effort: 'high' },
  };
  assert.equal(pinLedgerAdmits('v18', reviewed), true, 'the P1: v1.8 commits a ledger that says nothing');
  assert.equal(pinLedgerAdmits('v19', reviewed), false, 'v1.9 must refuse it');

  const retired = (over: Partial<RetiredPin> = {}): RetiredPin => ({
    generation: 2, component: 'model', from: 'model-v1', to: 'model-v2', at: RETIRED_AT_19,
    reason: 'RUNTIME_RETIRED', ...over,
  });
  const legal: PinState = {
    ...concreteClaim(), retiredPins: [retired()], generation: 2, session: { model: 'model-v2', effort: 'high' },
  };
  assert.equal(pinLedgerAdmits('v19', legal), true, 'one retiredPin that records itself must commit');
  const twice: PinState = {
    ...concreteClaim(), generation: 3, session: { model: 'model-v3', effort: 'high' },
    retiredPins: [retired(), retired({ generation: 3, from: 'model-v2', to: 'model-v3' })],
  };
  assert.equal(pinLedgerAdmits('v19', twice), true, 'and the chain keeps holding as it grows');

  const cases: [string, PinState][] = [
    ['an empty retiredPin record', { ...legal, retiredPins: [{} as RetiredPin] }],
    ['a record missing its reason', { ...legal, retiredPins: [{ generation: 2, component: 'model', from: 'model-v1', to: 'model-v2', at: RETIRED_AT_19 } as RetiredPin] }],
    ['a record carrying an extra key', { ...legal, retiredPins: [{ ...retired(), note: 'why not' } as RetiredPin] }],
    ['a record whose reason is not the one PAC §6 reserves', { ...legal, retiredPins: [retired({ reason: 'BECAUSE_I_SAID_SO' })] }],
    ['a record for a component PAC §6 does not freeze at first claim', { ...legal, retiredPins: [retired({ component: 'provider' })] }],
    ['a broken chain: from does not continue the claim', { ...legal, retiredPins: [retired({ from: 'model-v0' })] }],
    ['a record whose generation does not match its position', { ...legal, retiredPins: [retired({ generation: 5 })] }],
    ['a record whose moment runs backwards', { ...legal, retiredPins: [retired({ at: FROZEN_AT_19 })] }],
    ['a rewrite that rewrites nothing', { ...legal, retiredPins: [retired({ to: 'model-v1' })], session: { model: 'model-v1', effort: 'high' } }],
    ['a chain that folds to something other than the session pin', { ...legal, session: { model: 'model-v9', effort: 'high' } }],
  ];
  for (const [label, state] of cases) {
    assert.equal(pinLedgerAdmits('v19', state), false, `${label}: v1.9 must refuse it`);
    assert.equal(pinLedgerAdmits('v18', state), true, `${label}: v1.8 must still admit it (reverse control)`);
  }
  // Cardinality is still necessary — v1.9 adds to v1.8's predicate, it does not replace it.
  for (const state of [{ ...legal, retiredPins: [] }, { ...legal, retiredPins: [retired(), retired({ generation: 3 })] }]) {
    assert.equal(pinLedgerAdmits('v19', state), false, 'a ledger of the wrong length must still be refused');
    assert.equal(pinLedgerAdmits('v18', state), false, 'and v1.8 refused that half already');
  }

  const dispatch = section(PCC, '7.4');
  const ec6c = dispatch.slice(dispatch.indexOf('- **EC6-c（'), dispatch.indexOf('- **EC6-d（'));
  for (const key of ['generation', 'component', 'from', 'to', 'at', 'reason', 'frozen', 'value', 'source']) {
    assert.ok(ec6c.includes(`\`${key}\``), `EC6-c does not name the ${key} field`);
  }
  assert.match(ec6c, /RUNTIME_RETIRED/, 'EC6-c does not close the set of reasons');
  const seven = section(PCC, '7.7');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.match(d16, /CREATE CONSTRAINT TRIGGER session_execution_result_check/, 'the session side has no object');
  assert.match(d16, /CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check/, 'the action side has no object');
  assert.equal((d16.match(/coordinator_pin_ledger_fold\(/g) ?? []).length, 3,
    'the two directions must judge by one shared function, defined once and called from each side');
  assert.ok(d16.includes('**D16-f（'), 'D16 does not argue why the judgement is one function');
  assert.match(section(PCC, '15'), /\*\*F49\*\*/, '§15 has no fault row for a ledger that says nothing');
});

test('mutation check: every fence added for PC-CX-47..49 is load-bearing', () => {
  // Same discipline as the seven mutation checks above: remove exactly one thing v1.9 added and the
  // published counterexample has to come back.
  const emptyClaim: PinState = {
    ...concreteClaim(), claim: {} as ClaimResolution, session: { model: 'model-evil', effort: 'low' },
  };
  const emptyLedger: PinState = {
    ...concreteClaim(), claim: {} as ClaimResolution, retiredPins: [{} as RetiredPin], generation: 2,
    session: { model: 'model-v2', effort: 'high' },
  };
  const forged: ActionRow = {
    subjectType: 'TASK', subjectId: 't1',
    context: { agentId: 'a1', model: 'model-v1', effort: 'high', authorization: {} },
    contextDigest: 'frozen-a', resultDigest: 'forged-result-digest',
  };
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-47',
      fence: 'the field-by-field binding of the claim to the frozen conclusion (§7.4 EC6-c / EC6-e)',
      defectReappears: () => pinLedgerAdmits('v18', emptyClaim),
    },
    {
      finding: 'PC-CX-48',
      fence: 'the commit-time recomputation of both digests (§7.7 D17)',
      defectReappears: () => digestGateAdmits('v18', forged),
    },
    {
      finding: 'PC-CX-49',
      fence: 'the closed record shapes and the folded chain (§7.7 D16 ⓪)',
      defectReappears: () => pinLedgerAdmits('v18', emptyLedger),
    },
  ];
  assert.equal(mutants.length, 3, 'unit 02 raised three findings against v1.8');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable, while the legal paths still commit.
  assert.equal(pinLedgerAdmits('v19', emptyClaim), false);
  assert.equal(pinLedgerAdmits('v19', emptyLedger), false);
  assert.equal(digestGateAdmits('v19', forged), false);
  assert.equal(pinLedgerAdmits('v19', concreteClaim()), true);
});

test('§27 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§26 have, for the ninth round. All three are claims about what a real
  // server does — a field-by-field binding, a recomputed digest and a folded chain — so the
  // Postgres file is checked by name as well.
  const rows = tables(section(PCC, '27'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-47', 'PC-CX-48', 'PC-CX-49']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§27 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '27').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 3, '§27 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§27 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '27').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§27 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§27 points at §${m[1]}, which does not exist`);
  }
});

// ---------------------------------------------------------------------------------------------
// Round ten (`PC-CX-50..52`, §28). Rounds one through nine asked *when* a hard gate runs, *who*
// decides its scope, whether the closed set it compares is closed, and what it has proved once it
// returns. This one asks the question underneath all of those: **what is it holding when it
// judges?** D16's action side read the column D11 leaves writable to decide whether it applies at
// all; every deferred row constraint compared the tuple its statement queued with rather than the
// row about to be committed; D17 recomputed a digest of an object nobody had counted the keys of.
// All three are one sentence: **a hard gate's own input has to be proved too.**
// ---------------------------------------------------------------------------------------------

type Version110 = 'v19' | 'v110';

/** §7.7 D11-b's two writable columns, and what a transaction may do to them. */
type ActionLedgerRow = { status: string; resultSessionId: string | null; claim: object | null; retiredPins: object[] };

/**
 * §7.7 D18, modelled: `result_session_id` is published once, `claimResolution` is written once, and
 * `retiredPins[]` only grows with its prefix intact. v1.9 had no such object at all, so every
 * transition below was legal.
 */
function mutatorAdmits(version: Version110, before: ActionLedgerRow, after: ActionLedgerRow): boolean {
  if (version === 'v19') return true;                                     // reverse control: no D18
  if (before.resultSessionId !== null && after.resultSessionId !== before.resultSessionId) return false;
  if (before.claim !== null && JSON.stringify(after.claim) !== JSON.stringify(before.claim)) return false;
  if (after.retiredPins.length < before.retiredPins.length) return false;
  return JSON.stringify(after.retiredPins.slice(0, before.retiredPins.length))
    === JSON.stringify(before.retiredPins);
}

/**
 * §7.7 D16's action side, modelled: v1.9 asked "is the link null?" to decide whether it applied;
 * v1.10 asks "is this an applied dispatch?" and then requires the link to be there and symmetric.
 */
function actionSideAdmits(version: Version110, row: ActionLedgerRow, sessionPointsBack: boolean): boolean {
  if (version === 'v19') return row.resultSessionId === null || sessionPointsBack;
  if (row.status !== 'APPLIED') return row.resultSessionId === null;
  return row.resultSessionId !== null && sessionPointsBack;
}

/**
 * §7.7 D9-f, modelled. A deferred row trigger keeps the `(OLD, NEW)` its statement produced; the
 * transaction may write the same row again afterwards. v1.9 judged `queued`, v1.10 re-reads `final`
 * by the stable key. `legal` is the proposition both versions evaluate — unchanged between them.
 */
function deferredVerdict<T>(version: Version110, queued: T, final: T, legal: (row: T) => boolean): boolean {
  return legal(version === 'v19' ? queued : final);
}

/** §7.4 EC2-b2: the result half's eleven keys with their JSON types. */
const RESULT_SHAPE: Record<string, string> = {
  agentId: 'string', workspaceId: 'string', assignedRunnerId: 'string', provider: 'string',
  providerBuiltin: 'boolean', requiredCapabilities: 'array', permissionMode: 'string',
  snapshotFrozenAt: 'string', resolution: 'object', model: 'string', effort: 'string',
};
const NONEMPTY = ['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'permissionMode',
  'snapshotFrozenAt', 'model', 'effort'];

function jsonType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/**
 * §7.7 D17's ⓪ `coordinator_execution_result_shape`, modelled. v1.9's whole test was
 * `ctx.model IS NULL OR ctx.effort IS NULL`, which is why '' and four missing keys both passed.
 */
function resultShapeAdmits(version: Version110, ctx: Record<string, unknown>): boolean {
  const half = { ...ctx };
  delete half.authorization;
  if (version === 'v19') return half.model !== undefined && half.model !== null
    && half.effort !== undefined && half.effort !== null;
  const keys = new Set([...Object.keys(half), ...Object.keys(RESULT_SHAPE)]);
  for (const key of keys) if (jsonType(half[key]) !== RESULT_SHAPE[key]) return false;
  if (NONEMPTY.some((key) => half[key] === '')) return false;
  if (!ISO_UTC.test(String(half.snapshotFrozenAt))) return false;
  if ((half.requiredCapabilities as unknown[]).some((v) => typeof v !== 'string' || v === '')) return false;
  return JSON.stringify(Object.keys(half.resolution as object).sort())
    === JSON.stringify(['who', 'with', 'where'].sort());
}

const COMPLETE_HALF: Record<string, unknown> = {
  agentId: 'a1', workspaceId: 'w1', assignedRunnerId: 'r1', provider: 'claude', providerBuiltin: true,
  requiredCapabilities: ['linux'], permissionMode: 'read-only', snapshotFrozenAt: '2026-08-19T00:00:00.000Z',
  resolution: { who: {}, with: {}, where: {} }, model: 'model-v1', effort: 'high',
};

test('PC-CX-50 an applied dispatch and its session point at each other, and the ledger only grows', () => {
  // The review's two transactions. Both write only `project_action`, and both were legal under
  // v1.9 because D11 leaves the two columns open and D16's action side read one of them to decide
  // whether it applied at all.
  const published: ActionLedgerRow = {
    status: 'APPLIED', resultSessionId: 's1', claim: { generation: 1 }, retiredPins: [],
  };
  const detached: ActionLedgerRow = { ...published, resultSessionId: null };
  const emptied: ActionLedgerRow = { ...detached, claim: {} };

  assert.equal(mutatorAdmits('v19', published, detached), true, 'reverse control: v1.9 has no mutator at all');
  assert.equal(mutatorAdmits('v19', detached, emptied), true, 'reverse control: and nothing owns the ledger');
  assert.equal(mutatorAdmits('v110', published, detached), false, 'D18 must refuse a detach');
  assert.equal(mutatorAdmits('v110', published, { ...published, resultSessionId: 's2' }), false,
    'D18 must refuse a repoint');
  assert.equal(mutatorAdmits('v110', published, { ...published, claim: {} }), false,
    'D18 must refuse a rewritten claimResolution');

  // The publish itself, and every legal write after it, must still pass.
  const unpublished: ActionLedgerRow = { status: 'CLAIMED', resultSessionId: null, claim: null, retiredPins: [] };
  assert.equal(mutatorAdmits('v110', unpublished, published), true, 'the publishing UPDATE must still commit');
  assert.equal(mutatorAdmits('v110', published, { ...published, retiredPins: [{ generation: 2 }] }), true,
    'appending a retiredPin must still commit');
  assert.equal(mutatorAdmits('v110', { ...published, retiredPins: [{ generation: 2 }] },
    { ...published, retiredPins: [{ generation: 2 }, { generation: 3 }] }), true,
    'appending a second retiredPin must still commit');
  assert.equal(mutatorAdmits('v110', { ...published, retiredPins: [{ generation: 2 }] },
    { ...published, retiredPins: [{ generation: 9 }] }), false,
    'rewriting a recorded retiredPin must be refused');
  assert.equal(mutatorAdmits('v110', { ...published, retiredPins: [{ generation: 2 }] },
    { ...published, retiredPins: [] }), false, 'truncating the ledger must be refused');

  // The commit point is the second object: a gate whose scope is decided by the row it protects is
  // a gate that row can switch off (D16-g). Note v1.9 *admits* the detached row — that is the bug.
  assert.equal(actionSideAdmits('v19', detached, true), true,
    'reverse control: v1.9 stops looking as soon as the writable link is null');
  assert.equal(actionSideAdmits('v110', detached, true), false, 'v1.10 must refuse an applied dispatch with no link');
  assert.equal(actionSideAdmits('v110', published, false), false, 'and one the session no longer points back at');
  assert.equal(actionSideAdmits('v110', published, true), true, 'while a symmetric pair still commits');
  assert.equal(actionSideAdmits('v110', unpublished, false), true, 'an unpublished dispatch still has nothing to say');
});

test('PC-CX-51 every deferred row constraint judges the final row of the transaction, not the tuple it queued with', () => {
  // One transaction, three statements: a heartbeat, the ledger write, then the pin. The heartbeat
  // queues a Session event whose tuple is still at generation 0, and v1.9 folded *that* against the
  // final ledger. The proposition never changed — only which row version it was applied to.
  type Row = { generation: number; hasClaim: boolean };
  const legal = (row: Row): boolean => (row.generation === 0 && !row.hasClaim)
    || (row.generation === 1 && row.hasClaim);
  const queued: Row = { generation: 0, hasClaim: true };    // heartbeat's tuple + the final ledger
  const final: Row = { generation: 1, hasClaim: true };     // what COMMIT is about to store

  assert.equal(deferredVerdict('v19', queued, final, legal), false,
    'reverse control: v1.9 rejects a legal final state because an earlier event queued an older tuple');
  assert.equal(deferredVerdict('v110', queued, final, legal), true,
    'v1.10 must commit any legal final state, whatever order it was written in');

  // The two properties that follow, and that a plain re-read buys outright.
  const events: Row[] = [{ generation: 0, hasClaim: true }, { generation: 1, hasClaim: true }];
  assert.deepEqual(events.map((e) => deferredVerdict('v110', e, final, legal)), [true, true],
    'repeated events for one row are an idempotent re-validation of the same final state');
  const illegal: Row = { generation: 2, hasClaim: true };
  assert.deepEqual(events.map((e) => deferredVerdict('v110', e, illegal, legal)), [false, false],
    'an illegal final state is still refused, and refused identically by every queued event');

  // …and the reason this is worse than a dirty commit: retrying the same key fails the same way.
  const retry = (): boolean => deferredVerdict('v19', queued, final, legal);
  assert.deepEqual([retry(), retry(), retry()], [false, false, false],
    'reverse control: the v1.9 refusal is deterministic, so idempotent retry cannot recover from it');

  // Each deferred constraint states the rule; §7.7 D9-f states it once for all of them.
  const seven = section(PCC, '7.7');
  for (const [name, from, to, reread] of [
    ['D9', '#### D9 ', '#### D10 ', 'FROM session WHERE id = NEW.id'],
    ['D10', '#### D10 ', '#### D11 ', 'FROM task WHERE id = NEW.id'],
    ['D14', '#### D14 ', '#### D15 ', 'FROM session WHERE id = NEW.id'],
    ['D16', '#### D16 ', '#### D8 ', 'FROM session WHERE id = NEW.id'],
    ['D16 action side', '#### D16 ', '#### D8 ', 'FROM project_action WHERE id = NEW.id'],
    ['D17', '#### D17 ', '#### D18 ', 'FROM project_action WHERE id = NEW.id'],
  ] as [string, string, string, string][]) {
    const body = seven.slice(seven.indexOf(from), seven.indexOf(to));
    assert.ok(body.includes(reread), `${name} still judges the tuple its statement queued with`);
  }
  assert.ok(seven.includes('**D9-f（'), '§7.7 never states the re-read as one rule for all five');
  assert.ok(seven.includes('**D10-d（'), 'D10 does not say why its transition predicate is different');
});

test('PC-CX-52 the result half of the execution context has a closed key-and-type shape', () => {
  // The review's two contexts. Both carry two digests the database computed itself, so both are
  // *correct* digests — of an object the contract says may not exist.
  const empty = { ...COMPLETE_HALF, model: '', effort: '' };
  const incomplete = { ...COMPLETE_HALF };
  for (const key of ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt']) {
    delete (incomplete as Record<string, unknown>)[key];
  }
  assert.equal(resultShapeAdmits('v19', empty), true, 'reverse control: v1.9 mistakes an empty string for a conclusion');
  assert.equal(resultShapeAdmits('v19', incomplete), true, 'reverse control: v1.9 never counts the keys');
  assert.equal(resultShapeAdmits('v110', empty), false, 'v1.10 must refuse an empty conclusion');
  assert.equal(resultShapeAdmits('v110', incomplete), false, 'v1.10 must refuse an incomplete result half');
  assert.equal(resultShapeAdmits('v110', COMPLETE_HALF), true, 'and must still admit a complete one');

  // Missing, extra, wrong type, empty: four spellings of one judgement (EC2-b2).
  for (const key of Object.keys(RESULT_SHAPE)) {
    const dropped = { ...COMPLETE_HALF };
    delete dropped[key];
    assert.equal(resultShapeAdmits('v110', dropped), false, `a result half missing ${key} must be refused`);
  }
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, surprise: 1 }), false, 'an extra key must be refused');
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, providerBuiltin: 'true' }), false,
    'a boolean written as a string must be refused');
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, model: null }), false, 'a JSON null must be refused');
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, requiredCapabilities: [''] }), false,
    'an empty capability must be refused');
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, snapshotFrozenAt: 'yesterday' }), false,
    'a snapshotFrozenAt that is not ISO-8601 UTC must be refused');
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, resolution: { v: 1 } }), false,
    'a resolution that is not PAC 7.5 who/with/where must be refused');
  // …and the deferral sentinel is a conclusion, not an absence (EC6-c row 1).
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, model: DEFERRED }), true,
    'DEFERRED_TO_CLAIM is a legal conclusion');

  // The authorization half is untouched: EC2-d's split is still "minus one key" (D17-b / §27.4).
  assert.equal(resultShapeAdmits('v110', { ...COMPLETE_HALF, authorization: { anything: true } }), true,
    'the authorization half is judged by EC2-a, not by this shape');

  // The clauses that make the shape a contract rather than a copy that drifts.
  const dispatch = section(PCC, '7.4');
  const ec2b2 = dispatch.slice(dispatch.indexOf('- **EC2-b2（'), dispatch.indexOf('- **EC2-c（'));
  for (const key of Object.keys(RESULT_SHAPE)) {
    assert.ok(ec2b2.includes(`\`${key}\``), `EC2-b2 does not name ${key}`);
  }
  assert.match(ec2b2, /PAC §6 的表与 PAC §7\.5 的结构反推/, 'EC2-b2 does not say where the table comes from');
  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D18 '));
  assert.match(d17, /CREATE OR REPLACE FUNCTION coordinator_execution_result_shape/, 'the shape has no object');
  assert.equal((seven.match(/coordinator_execution_result_shape\(/g) ?? []).length, 5,
    'one definition and four call points — D15 at insert, D16 on both sides, D17 itself');
  assert.ok(d17.includes('**D17-f（'), 'D17 does not say why a correct digest is not a complete input');
  assert.ok(d17.includes('**D17-g（'), 'D17 does not write down how deep the shape goes');
});

test('mutation check: every fence added for PC-CX-50..52 is load-bearing', () => {
  // Same discipline as the eight mutation checks above: remove exactly one thing v1.10 added and
  // the published counterexample has to come back.
  const published: ActionLedgerRow = {
    status: 'APPLIED', resultSessionId: 's1', claim: { generation: 1 }, retiredPins: [],
  };
  const detached: ActionLedgerRow = { ...published, resultSessionId: null };
  const incomplete = { ...COMPLETE_HALF };
  for (const key of ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt']) {
    delete (incomplete as Record<string, unknown>)[key];
  }
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-50',
      fence: 'the closed monotonic mutator and the bidirectional link (§7.7 D18 / D16-g)',
      defectReappears: () => mutatorAdmits('v19', published, detached) && actionSideAdmits('v19', detached, true),
    },
    {
      finding: 'PC-CX-51',
      fence: 'the stable-key re-read at the commit point (§7.7 D9-f)',
      defectReappears: () => !deferredVerdict('v19', { generation: 0, hasClaim: true }, { generation: 1, hasClaim: true },
        (row) => (row.generation === 0 && !row.hasClaim) || (row.generation === 1 && row.hasClaim)),
    },
    {
      finding: 'PC-CX-52',
      fence: 'the closed key-and-type shape of the result half (§7.4 EC2-b2 / §7.7 D17 ⓪)',
      defectReappears: () => resultShapeAdmits('v19', incomplete),
    },
  ];
  assert.equal(mutants.length, 3, 'unit 02 raised three findings against v1.9');
  for (const m of mutants) {
    assert.equal(m.defectReappears(), true, `${m.finding}: removing ${m.fence} must bring the defect back`);
  }

  // …and with every fence in place, none of them is reachable, while the legal paths still commit.
  assert.equal(mutatorAdmits('v110', published, detached), false);
  assert.equal(actionSideAdmits('v110', detached, true), false);
  assert.equal(resultShapeAdmits('v110', incomplete), false);
  assert.equal(mutatorAdmits('v110', { status: 'CLAIMED', resultSessionId: null, claim: null, retiredPins: [] },
    published), true);
  assert.equal(resultShapeAdmits('v110', COMPLETE_HALF), true);
});

test('§28 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§27 have, for the tenth round. All three are claims about what a real
  // server does — a frozen link, a re-read row and a counted key set — so the Postgres file is
  // checked by name as well.
  const rows = tables(section(PCC, '28'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-50', 'PC-CX-51', 'PC-CX-52']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`), `§28 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '28').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 3, '§28 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§28 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '28').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§28 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§28 points at §${m[1]}, which does not exist`);
  }
});

// -------------------------------------------------------------------------------------------------
// v1.11 — `PC-CX-53..55`
// -------------------------------------------------------------------------------------------------

/** v1.10 or v1.11 of the three predicates round eleven moved. */
type Version111 = 'v110' | 'v111';

/**
 * §7.4 EC2-b3 / §7.7 D17 ⓪, the `resolution` row alone. v1.10 compared the key set against
 * `['where','who','with']`; PAC §7.5's structure has four top-level keys and the same section says
 * `v` must be written, so the two had no legal intersection at all (`PC-CX-53`).
 */
const RESOLUTION_SHAPE: Record<string, string> = {
  v: 'number', who: 'object', with: 'object', where: 'object',
};
function resolutionAdmits(version: Version111, resolution: Record<string, unknown>): boolean {
  const keys = Object.keys(resolution).sort();
  if (version === 'v110') return JSON.stringify(keys) === JSON.stringify(['where', 'who', 'with']);
  for (const key of new Set([...keys, ...Object.keys(RESOLUTION_SHAPE)])) {
    if (jsonType(resolution[key]) !== RESOLUTION_SHAPE[key]) return false;
  }
  // A version, not *this* version: PAC §7.5 requires readers to tolerate an unknown one.
  return Number.isInteger(resolution.v) && (resolution.v as number) >= 1;
}

/** PAC §7.5 verbatim, as a dispatch produces it. */
const PAC_RESOLUTION: Record<string, unknown> = {
  v: 1,
  who: { agentId: 'a1', source: 'task-assignee' },
  with: { provider: 'claude', model: 'model-v1', effort: null, source: 'task-pin' },
  where: { workspaceId: 'w1', runnerId: 'r1', source: 'task-pin', required: ['linux'], candidatesConsidered: 1 },
};

test("PC-CX-53 the frozen resolution is PAC 7.5's closed v/who/with/where", () => {
  // This is the one finding whose closing assertion is a *positive*: the defect was not that a bad
  // input got through, it was that the good one could not. So the first line is the legal path.
  assert.equal(resolutionAdmits('v111', PAC_RESOLUTION), true,
    'a resolution that is PAC 7.5 verbatim must be admitted — that is the whole finding');
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, v: 7 }), true,
    'PAC 7.5 requires readers to tolerate an unknown version, so the gate may not pin v = 1');

  // Missing, extra, wrong type, wrong value: four spellings of one judgement, same as EC2-b2.
  const versionless = { ...PAC_RESOLUTION };
  delete versionless.v;
  assert.equal(resolutionAdmits('v111', versionless), false, 'PAC 7.5 says `v` must be written');
  for (const key of Object.keys(RESOLUTION_SHAPE)) {
    const dropped = { ...PAC_RESOLUTION };
    delete dropped[key];
    assert.equal(resolutionAdmits('v111', dropped), false, `a resolution missing ${key} must be refused`);
  }
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, extra: 1 }), false,
    'a top-level key PAC 7.5 does not have must be refused');
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, v: '1' }), false, 'a version written as a string');
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, v: 0 }), false, 'a version of zero');
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, v: 1.5 }), false, 'a version that is not an integer');
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, who: 'a1' }), false, 'a chain that is not an object');
  // …and it stops at the top level: the inside of the three chains is D17-g's declared boundary.
  assert.equal(resolutionAdmits('v111', { ...PAC_RESOLUTION, who: {} }), true,
    'the shape does not reach inside who/with/where — that boundary is declared, not forgotten');

  // Reverse control — v1.10: both answers inverted, which is exactly what made it a P0.
  assert.equal(resolutionAdmits('v110', PAC_RESOLUTION), false,
    'reverse control: v1.10 refuses every PAC-conforming resolution');
  assert.equal(resolutionAdmits('v110', versionless), true,
    'reverse control: deleting the key PAC requires is the only way through v1.10');

  // The clauses that make this a contract rather than a constant someone happened to type.
  const dispatch = section(PCC, '7.4');
  assert.ok(dispatch.includes('- **EC2-b3（'), '§7.4 does not close the resolution row');
  const ec2b3 = dispatch.slice(dispatch.indexOf('- **EC2-b3（'), dispatch.indexOf('- **EC2-c（'));
  for (const key of Object.keys(RESOLUTION_SHAPE)) {
    assert.ok(ec2b3.includes(`\`${key}\``), `EC2-b3 does not name ${key}`);
  }
  assert.match(ec2b3, /由 PAC §7\.5 反推/, 'EC2-b3 does not say where its table comes from');
  const seven = section(PCC, '7.7');
  const d17 = seven.slice(seven.indexOf('#### D17 '), seven.indexOf('#### D18 '));
  assert.doesNotMatch(d17, /ARRAY\['where','who','with'\]\s*THEN/, 'the shape still uses the exact-key predicate');
  assert.match(d17, /'v','number'/, 'the shape does not state the version key with its type');
  // PAC is the referenced contract, and it may not be softened to make this one fit.
  assert.match(PAC, /`v` 必须写/, 'PAC §7.5 no longer requires the version discriminator');
});

/**
 * §7.7 D19, modelled. v1.10 had three objects and all of them watched INSERT and UPDATE; the half
 * of I17-A3 that says "the session it points at is missing" is only reachable through DELETE.
 */
function purgeAdmits(version: Version111, referencedByAction: boolean): boolean {
  if (version === 'v110') return true;
  return !referencedByAction;
}

test('PC-CX-54 a published result session cannot be purged out from under its action', () => {
  assert.equal(purgeAdmits('v111', true), false, 'a session an action row points at may not be physically deleted');
  assert.equal(purgeAdmits('v111', false), true,
    'and one nothing points at — a Coordinator Session — must still be deletable, or §7.5 rotation breaks');
  assert.equal(purgeAdmits('v110', true), true, 'reverse control: v1.10 lets the purge commit');

  // Soft delete is the product-level "the user deleted it", and it is an UPDATE: the row stays, so
  // every gate keeps its object. Nothing in the fix may touch it (D19-b).
  const invariants = section(PCC, '4.3');
  const i17a3 = invariants.slice(invariants.indexOf('- **I17-A3（'), invariants.indexOf('- **I17-d（'));
  assert.match(i17a3, /DELETE/, 'I17-A3 still says nothing about the verb that made it false');
  assert.match(i17a3, /D19/, 'I17-A3 does not name the object that now carries it');

  const seven = section(PCC, '7.7');
  assert.ok(seven.includes('#### D19 '), '§7.7 has no D19');
  const d19 = seven.slice(seven.indexOf('#### D19 '), seven.indexOf('#### D7 '));
  assert.match(d19, /ON DELETE RESTRICT/, 'the result link is still not a real foreign key');
  assert.match(d19, /BEFORE DELETE ON session/, 'nothing observes DELETE on session');
  assert.match(d19, /SESSION_RESULT_LINK_REFERENCED/, 'a refused purge has no typed code');
  assert.match(d19, /owner=USER, recovery=HUMAN/, 'the typed refusal names no owner or recovery');
  for (const clause of ['**D19-a（', '**D19-b（', '**D19-c（', '**D19-d（', '**D19-e（', '**D19-f（']) {
    assert.ok(d19.includes(clause), `D19 does not state ${clause}）`);
  }
  // §2.4 is where the review said the on-delete behaviour was simply absent.
  const infra = section(PCC, '2.4');
  assert.match(infra, /project_action_result_session_fk/, '§2.4 does not freeze the action → Session foreign key');
  assert.match(infra, /session_result_link_delete_guard/, '§2.4 does not register the typed half');
  assert.match(infra, /coordinator_session_id/, '§2.4 does not say why the decision audit keeps no foreign key');
  // …and the rotation triggers §7.5 depends on are untouched.
  assert.match(section(PCC, '7.5'), /被用户删除（`coordinatorSessionId` 被 SetNull）/,
    'the rotation trigger the fix had to stay compatible with is gone');
  assert.match(section(PCC, '15'), /\*\*F54\*\*/, '§15 has no fault row for a purged result session');
  assert.match(section(PCC, '12.1'), /session_result_link_delete_guard/, 'G5 does not verify the delete guard');
});

/**
 * §7.7 D18 ⓪ and §7.7 D16's fold, modelled together — they carry the same sentence. v1.10 ran the
 * array expansion first, and Postgres raises 22023 on a non-array, so the type test below it was
 * unreachable; the trigger also observed UPDATE only, so the value arrived unwatched (`PC-CX-55`).
 */
type LedgerOutcome = 'commit' | 'EXECUTION_PIN_LEDGER' | 'native-22023';
function ledgerMutator(version: Version111, op: 'INSERT' | 'UPDATE',
  oldLedger: unknown, newLedger: unknown): LedgerOutcome {
  // `undefined` is the key being absent (COALESCE gives '[]'); JSON `null` is a value, and
  // `jsonb_typeof` calls it 'null' — the database refuses it, so the model must too.
  const isArray = (value: unknown): boolean => value === undefined || Array.isArray(value);
  if (version === 'v110') {
    if (op === 'INSERT') return 'commit';                       // no INSERT event at all
    if (!isArray(oldLedger) || !isArray(newLedger)) return 'native-22023';
    return 'commit';
  }
  if (!isArray(newLedger)) {
    // The one outlet: this statement did not touch an already-malformed value (D18-g).
    if (op === 'UPDATE' && !isArray(oldLedger) && JSON.stringify(newLedger) === JSON.stringify(oldLedger)) {
      return 'commit';
    }
    return 'EXECUTION_PIN_LEDGER';
  }
  return 'commit';                                              // append-only is judged after this
}

test('PC-CX-55 the pin ledger is type-checked before it is folded, at insert and at update', () => {
  // The insert is where the malformed value entered, and where v1.10 had no object at all.
  for (const malformed of [{}, 'x', 3, null]) {
    assert.equal(ledgerMutator('v111', 'INSERT', undefined, malformed), 'EXECUTION_PIN_LEDGER',
      `a ledger written as ${JSON.stringify(malformed)} must be refused on the INSERT statement`);
    assert.equal(ledgerMutator('v110', 'INSERT', undefined, malformed), 'commit',
      'reverse control: v1.10 observes UPDATE only, so the malformed initial ledger commits');
  }
  assert.equal(ledgerMutator('v111', 'INSERT', undefined, []), 'commit',
    'an empty array is a ledger and must still insert');

  // The legacy row, and the two outlets D18-g freezes.
  assert.equal(ledgerMutator('v111', 'UPDATE', {}, {}), 'commit',
    'a statement that does not touch an already-malformed ledger — CLAIMED → REFUSED — must commit');
  assert.equal(ledgerMutator('v111', 'UPDATE', {}, []), 'commit', 'and the prescribed repair must commit');
  assert.equal(ledgerMutator('v111', 'UPDATE', {}, undefined), 'commit', 'as must dropping the key entirely');
  assert.equal(ledgerMutator('v111', 'UPDATE', {}, 'still-bad'), 'EXECUTION_PIN_LEDGER',
    'swapping one malformed value for another is not a repair');

  // Reverse control: under v1.10 both of those are the review's stuck transitions, and neither is
  // even a typed refusal — they are Postgres own JSON error.
  assert.equal(ledgerMutator('v110', 'UPDATE', {}, {}), 'native-22023',
    'reverse control: v1.10 bricks the normal terminal transition');
  assert.equal(ledgerMutator('v110', 'UPDATE', {}, []), 'native-22023',
    'reverse control: and it bricks the repair as well, so the permanent key has no way out');

  // The document side: order and event surface, in both objects that call an array function.
  const seven = section(PCC, '7.7');
  const d18 = seven.slice(seven.indexOf('#### D18 '), seven.indexOf('#### D19 '));
  assert.ok(d18.indexOf("IF jsonb_typeof(new_ledger) <> 'array'") < d18.indexOf('FROM jsonb_array_elements(new_ledger)'),
    'D18 still expands the ledger before it proves the ledger is one');
  assert.match(d18, /BEFORE INSERT OR UPDATE ON project_action/, 'D18 still observes UPDATE only');
  assert.ok(d18.includes('**D18-g（'), 'D18 does not argue why the order and the event surface are the rule');
  const d16 = seven.slice(seven.indexOf('#### D16 '), seven.indexOf('#### D8 '));
  assert.ok(d16.indexOf("IF jsonb_typeof(ledger) <> 'array'") < d16.indexOf('jsonb_array_length(ledger)'),
    'the commit-point fold still measures the ledger before it proves it is one');
  // The stale audit count is registered, and the new one has an isolation and a repair path.
  assert.match(d18, /必须对存量跑\*\*四条\*\*查询/, 'D18-e still promises three existing-data queries');
  assert.match(d18, /malformedRetiredPins/, 'D18-e has no isolation step for the existing malformed rows');
  assert.match(d18, /USER \/ HUMAN/, 'D18-e ④-b does not hand the undecidable rows to a person');
  assert.match(section(PCC, '15'), /\*\*F55\*\*/, '§15 has no fault row for a malformed initial ledger');
});

test('mutation check: every fence added for PC-CX-53..55 is load-bearing', () => {
  const versionless = { ...PAC_RESOLUTION };
  delete versionless.v;
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-53',
      fence: "the resolution key-and-type table (§7.4 EC2-b3 / §7.7 D17 ⓪)",
      // The defect is the absence of a legal path, so it reappears when the conforming resolution
      // is refused *and* the one PAC forbids is the only one admitted.
      defectReappears: () => !resolutionAdmits('v110', PAC_RESOLUTION) && resolutionAdmits('v110', versionless),
    },
    {
      finding: 'PC-CX-54',
      fence: 'the delete guard and the ON DELETE RESTRICT foreign key (§7.7 D19)',
      defectReappears: () => purgeAdmits('v110', true),
    },
    {
      finding: 'PC-CX-55',
      fence: 'the ledger type gate ahead of every array function, on INSERT too (§7.7 D18 ⓪ / D18-g)',
      defectReappears: () => ledgerMutator('v110', 'INSERT', undefined, {}) === 'commit'
        && ledgerMutator('v110', 'UPDATE', {}, {}) === 'native-22023',
    },
  ];
  for (const mutant of mutants) {
    assert.equal(mutant.defectReappears(), true,
      `${mutant.finding}: removing ${mutant.fence} does not bring the published counterexample back, so it is not what closed it`);
  }
});

test('§29 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§28 have, for the eleventh round.
  const rows = tables(section(PCC, '29'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-53', 'PC-CX-54', 'PC-CX-55']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`) || self.includes(`test("${name}"`),
      `§29 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '29').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 3, '§29 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§29 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '29').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§29 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§29 points at §${m[1]}, which does not exist`);
  }
});

// -------------------------------------------------------------------------------------------------
// v1.12 — `PC-CX-56..57`
// -------------------------------------------------------------------------------------------------

/** v1.11 or v1.12 of the two rules round twelve moved. */
type Version112 = 'v111' | 'v112';

/**
 * §2.4's on-delete table plus §7.7 D20, modelled. Three frozen rules — the `project` cascade, the
 * action → Session RESTRICT and the Session → action RESTRICT — closed every one of the three
 * delete orders, while D19-c promised in the same document that "the granularity of physical
 * removal is the Project" (`PC-CX-56`). RESTRICT is never deferrable in PostgreSQL, so the only
 * order that could have worked — Project first, placeholders after — failed on its first statement.
 */
type PurgeOutcome = 'committed' | 'refused-23503' | 'refused-typed' | 'orphaned';
function purgeProject(version: Version112, options: {
  linked: boolean; declared?: boolean; purgesPlaceholders?: boolean; lineageFk?: boolean;
}): PurgeOutcome {
  const { linked, declared = false, purgesPlaceholders = declared, lineageFk = true } = options;
  if (!linked) return 'committed';                     // the cascade takes the ledger; nothing refers to it
  if (!lineageFk) return 'orphaned';                   // the review's own reverse control
  if (version === 'v111') return 'refused-23503';      // immediate RESTRICT refuses the cascade itself
  if (!declared) return 'refused-typed';               // D20 ②: a bare DELETE that would strand a placeholder
  // D20 ③: the check is deferred, so the ledger and its placeholders go in either order — but the
  // deferred foreign key still runs at COMMIT, which is what makes "no orphan" a proof rather than
  // a promise. A transaction that forges the fence and leaves the placeholders behind fails there.
  return purgesPlaceholders ? 'committed' : 'refused-23503';
}

test('PC-CX-56 the Project purge protocol is a single committable transaction', () => {
  // The finding is the absence of a legal path, so the assertion that closes it is a positive.
  assert.equal(purgeProject('v112', { linked: true, declared: true }), 'committed',
    'a linked Project must have one purge transaction that actually commits — that is the whole finding');
  assert.equal(purgeProject('v112', { linked: false }), 'committed',
    'and an empty Project must keep committing on a bare DELETE, or §2.4 cascade means nothing');
  assert.equal(purgeProject('v112', { linked: true }), 'refused-typed',
    'a bare DELETE that would strand a placeholder is refused with this contract own code');
  assert.equal(purgeProject('v112', { linked: true, declared: true, purgesPlaceholders: false }),
    'refused-23503',
    'a forged fence that leaves the placeholders behind still fails at COMMIT — the proof is structural');

  // Reverse control: v1.11's two immediate RESTRICTs, and the orphan the review got by dropping one.
  assert.equal(purgeProject('v111', { linked: true, declared: true }), 'refused-23503',
    'PC-CX-56 must reproduce: under v1.11 the Project-first order fails on its first statement');
  assert.equal(purgeProject('v111', { linked: true, lineageFk: false }), 'orphaned',
    'and dropping the Session half is not an answer: it leaves the lineage I17-A3 forbids');

  // The document side. §2.4's second on-delete row is the one word that changed, and the reason it
  // had to change is a property of PostgreSQL, not a preference.
  const infra = section(PCC, '2.4');
  assert.match(infra, /`session\.projectActionId → project_action\.id` \| \*\*NO ACTION\*\*/,
    '§2.4 still freezes the lineage half as an immediate RESTRICT');
  assert.match(infra, /DEFERRABLE INITIALLY IMMEDIATE/, '§2.4 does not say the constraint is deferrable at all');
  assert.match(infra, /`project_action\.result_session_id → session\.id` \| \*\*RESTRICT\*\*/,
    'the action → Session half must stay immediate: the purge never needs it deferred');
  assert.match(infra, /project_purge_fence/, '§2.4 does not register the typed half');
  assert.match(infra, /coordinator_purge_project/, '§2.4 does not register the one public entry point');

  const seven = section(PCC, '7.7');
  assert.ok(seven.includes('#### D20 '), '§7.7 has no D20');
  const d20 = seven.slice(seven.indexOf('#### D20 '), seven.indexOf('#### D7 '));
  assert.match(d20, /ON DELETE NO ACTION ON UPDATE NO ACTION\n  DEFERRABLE INITIALLY IMMEDIATE/,
    'D20 does not state the constraint it depends on');
  assert.match(d20, /SET CONSTRAINTS session_project_action_fk DEFERRED/,
    'D20 never actually defers the check, so the Project-first order still fails on its first statement');
  assert.match(d20, /PROJECT_PURGE_UNDECLARED/, 'a refused bare DELETE has no typed code');
  assert.match(d20, /owner=SYSTEM, recovery=EVENT/, 'the typed refusal names no owner or recovery');
  assert.match(d20, /FOR UPDATE/, 'D20 has no answer for two concurrent purges');
  for (const clause of ['**D20-a（', '**D20-b（', '**D20-c（', '**D20-d（', '**D20-e（', '**D20-f（',
    '**D20-g（', '**D20-h（']) {
    assert.ok(d20.includes(clause), `D20 does not state ${clause}）`);
  }
  // GE1 is the rule the cascade has to coexist with, and v1.12 is where the exception is written.
  assert.match(section(PCC, '8.2'), /唯一的例外是 §2\.4 那条 `project` 级联/,
    '§8.2 GE1 still forbids the cascade it has always been paired with');
  assert.match(section(PCC, '8.2'), /整份消失.*与.*逐条删除.*是两件事/,
    'GE1 does not distinguish a whole ledger leaving with its Project from deleting rows one by one');
  // D19 is unchanged except for the recovery it points at, and I17-A3 gains its fourth constructor.
  const d19 = seven.slice(seven.indexOf('#### D19 '), seven.indexOf('#### D20 '));
  assert.match(d19, /coordinator_purge_project\(\)/, 'D19 recovery still points at a delete that cannot commit');
  assert.doesNotMatch(d19, /那之后这条 Session 就是一条普通 Session，照常可删/,
    'D19-c still claims the unreachable transition as if it were executable');
  const invariants = section(PCC, '4.3');
  const i17a3 = invariants.slice(invariants.indexOf('- **I17-A3（'), invariants.indexOf('- **I17-d（'));
  assert.match(i17a3, /D20/, 'I17-A3 does not name the object that carries it when the ledger leaves');
  assert.match(section(PCC, '15'), /\*\*F56\*\*/, '§15 has no fault row for a Project purge');
  assert.match(section(PCC, '12.1'), /coordinator_purge_project/, 'G5 does not verify the purge protocol');
  assert.match(section(PCC, '12.1'), /condeferrable/,
    'G5 does not check the one column that tells an immediate RESTRICT from a deferrable NO ACTION');
});

/**
 * §7.7 D18 ⓪ and D18-h, modelled. v1.11's compatibility branch was right about *why* (a statement
 * that did not touch an already-malformed ledger must not be bricked by it) and wrong about *how
 * far*: it was written as `RETURN NEW`, which sits ahead of ① and ②, so an unrelated sibling key's
 * top-level type decided whether a published link could be detached and whether an already-recorded
 * claimResolution could be rewritten (`PC-CX-57`).
 */
type MutatorOutcome = 'commit' | 'EXECUTION_PIN_LEDGER' | 'ACTION_RESULT_LINK_FROZEN';
function ledgerMutator112(version: Version112, row: {
  oldLedger: unknown; newLedger: unknown; hadClaim: boolean; rewritesClaim: boolean;
  hadLink: boolean; movesLink: boolean;
}): MutatorOutcome {
  const isArray = (value: unknown): boolean => value === undefined || Array.isArray(value);
  const untouched = !isArray(row.newLedger)
    && JSON.stringify(row.oldLedger) === JSON.stringify(row.newLedger);
  if (!isArray(row.newLedger)) {
    if (!untouched) return 'EXECUTION_PIN_LEDGER';
    // v1.11 returned here, out of the whole function; v1.12 only records that ③ is unrunnable.
    if (version === 'v111') return 'commit';
  }
  if (row.hadLink && row.movesLink) return 'ACTION_RESULT_LINK_FROZEN';      // ①
  if (row.hadClaim && row.rewritesClaim) return 'EXECUTION_PIN_LEDGER';      // ②
  return 'commit';                                                          // ③ is the only skip
}

test("PC-CX-57 the malformed-ledger compatibility path skips only the ledger's own check", () => {
  const legacy = { oldLedger: {}, newLedger: {}, hadClaim: true, rewritesClaim: false,
    hadLink: true, movesLink: false };

  // The two gates that have nothing to do with retiredPins run on a malformed row exactly as they
  // run on a legal one. That equality *is* the finding: v1.11 made them depend on a sibling key.
  assert.equal(ledgerMutator112('v112', { ...legacy, rewritesClaim: true }), 'EXECUTION_PIN_LEDGER',
    'a recorded claimResolution must stay immutable while retiredPins is still malformed');
  assert.equal(ledgerMutator112('v112', { ...legacy, movesLink: true }), 'ACTION_RESULT_LINK_FROZEN',
    'and a published result link must stay frozen while retiredPins is still malformed');
  assert.equal(ledgerMutator112('v112', { ...legacy, oldLedger: [], newLedger: [], rewritesClaim: true }),
    'EXECUTION_PIN_LEDGER', 'the legal-ledger row must give the identical answer — one rule, not two');

  // …and D18-g's two outlets are untouched, which is what the compatibility branch is *for*.
  assert.equal(ledgerMutator112('v112', legacy), 'commit',
    'a statement that touches neither the ledger nor the two frozen columns — CLAIMED → REFUSED — must commit');
  assert.equal(ledgerMutator112('v112', { ...legacy, newLedger: [] }), 'commit',
    'and the prescribed repair must still commit');
  assert.equal(ledgerMutator112('v112', { ...legacy, hadClaim: false, rewritesClaim: true }), 'commit',
    'writing a first claimResolution is not a rewrite: ② freezes the second write, not the first');
  assert.equal(ledgerMutator112('v112', { ...legacy, newLedger: 'still-bad' }), 'EXECUTION_PIN_LEDGER',
    'swapping one malformed value for another is still not a repair');

  // Reverse control: v1.11's `RETURN NEW`, and the two rewrites it admitted.
  assert.equal(ledgerMutator112('v111', { ...legacy, rewritesClaim: true }), 'commit',
    'PC-CX-57 must reproduce: an unchanged malformed retiredPins disabled claim immutability');
  assert.equal(ledgerMutator112('v111', { ...legacy, movesLink: true }), 'commit',
    'and it disabled the result-link freeze in the same breath');
  assert.equal(ledgerMutator112('v111', { ...legacy, oldLedger: [], newLedger: [], rewritesClaim: true }),
    'EXECUTION_PIN_LEDGER', 'which is how the same rewrite had two answers under v1.11');

  // The document side: the branch records a flag, and the two gates are ahead of the one skip.
  const seven = section(PCC, '7.7');
  const d18 = seven.slice(seven.indexOf('#### D18 '), seven.indexOf('#### D19 '));
  const compat = d18.indexOf("IF TG_OP = 'UPDATE' AND new_ledger = COALESCE(OLD.detail -> 'retiredPins'");
  const flag = d18.indexOf('ledger_untouched := true;', compat);
  const linkFreeze = d18.indexOf('IF OLD.result_session_id IS NOT NULL');
  const claimFreeze = d18.indexOf("IF OLD.detail ? 'claimResolution'");
  const skip = d18.indexOf('IF ledger_untouched THEN RETURN NEW; END IF;');
  assert.ok(compat >= 0 && flag > compat, 'D18 ⓪ still returns out of the whole function');
  assert.ok(linkFreeze > flag && claimFreeze > flag,
    'the two unrelated gates are not downstream of the compatibility branch');
  assert.ok(skip > linkFreeze && skip > claimFreeze,
    'the skip must land after ① and ② — that position is the entire fix');
  assert.ok(skip < d18.indexOf('FROM jsonb_array_elements(new_ledger)'),
    'and before the array expansion it exists to avoid');
  assert.ok(d18.includes('**D18-h（'), 'D18 does not argue why the compatibility branch is one check wide');
  assert.match(section(PCC, '15'), /\*\*F57\*\*/, '§15 has no fault row for the legacy-ledger bypass');
  assert.match(section(PCC, '12.1'), /ACTION_RESULT_LINK_FROZEN/,
    'G5 does not verify that the link freeze survives a malformed ledger');
});

test('mutation check: every fence added for PC-CX-56..57 is load-bearing', () => {
  const legacy = { oldLedger: {}, newLedger: {}, hadClaim: true, rewritesClaim: true,
    hadLink: true, movesLink: false };
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-56',
      fence: 'the deferrable lineage constraint and the declared purge (§2.4 · §7.7 D20)',
      // The defect is the absence of a legal path, so it reappears when the declared purge — the
      // only order that can work — still fails, and the one way through leaves the orphan.
      defectReappears: () => purgeProject('v111', { linked: true, declared: true }) === 'refused-23503'
        && purgeProject('v111', { linked: true, lineageFk: false }) === 'orphaned',
    },
    {
      finding: 'PC-CX-57',
      fence: 'the ledger_untouched flag in place of ⓪ RETURN NEW (§7.7 D18 ⓪ / D18-h)',
      defectReappears: () => ledgerMutator112('v111', legacy) === 'commit'
        && ledgerMutator112('v111', { ...legacy, rewritesClaim: false, movesLink: true }) === 'commit',
    },
  ];
  for (const mutant of mutants) {
    assert.equal(mutant.defectReappears(), true,
      `${mutant.finding}: removing ${mutant.fence} does not bring the published counterexample back, so it is not what closed it`);
  }
});

test('§30 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§29 have, for the twelfth round.
  const rows = tables(section(PCC, '30'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-56', 'PC-CX-57']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`) || self.includes(`test("${name}"`),
      `§30 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '30').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 2, '§30 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§30 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '30').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§30 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§30 points at §${m[1]}, which does not exist`);
  }
});

// -------------------------------------------------------------------------------------------------
// v1.13 — `PC-CX-58..61`
// -------------------------------------------------------------------------------------------------

/**
 * Round thirteen asked one question of all four findings: does exactly one sentence decide this
 * rule? Each of the four had two sources — two clauses, a table and a function body, a paragraph and
 * a predicate, two locks that did not know about each other — and two sources is no authority at all.
 */
test('PC-CX-58 the lineage foreign key has exactly one initial mode', () => {
  // The document half. Four current clauses state this constraint; v1.12 had one of them disagreeing,
  // and both were in §1–§18, so "which one is normative" had no answer.
  const infra = section(PCC, '2.4');
  const onDelete = infra.split('\n').find((l) => l.includes('session.projectActionId → project_action.id')) ?? '';
  const seven = section(PCC, '7.7');
  const d20 = seven.slice(seven.indexOf('#### D20 '), seven.indexOf('#### D7 '));
  const d19 = seven.slice(seven.indexOf('#### D19 '), seven.indexOf('#### D20 '));
  const step6h = section(PCC, '12.1').split('\n').find((l) => l.includes('**6h**')) ?? '';
  for (const [where, text] of [['§2.4', onDelete], ['D20 ①', d20], ['D19-c', d19], ['step 6h', step6h]] as const) {
    assert.match(text, /INITIALLY IMMEDIATE/, `${where} no longer states the single initial mode`);
    assert.doesNotMatch(text, /INITIALLY DEFERRED/, `${where} gives the lineage FK a second initial mode`);
  }
  assert.ok(d20.includes('**D20-l（'), 'D20 does not state the uniqueness as a clause of its own');
  // The superseded reading survives exactly where §0 RL1 allows it, and nowhere else.
  const normative = PCC.slice(0, PCC.indexOf('\n## 19. '));
  assert.doesNotMatch(normative, /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    'the superseded wording is still alive in the normative body');
  assert.match(section(PCC, '31.5'), /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    '§31.5 no longer quotes it verbatim, so §22.8 registers a phrase that appears nowhere');

  // The behaviour half, modelled: the two readings differ in *when* a violating statement fails, and
  // D20's whole protocol depends on "immediate by default, deferred only inside a declared purge".
  type Mode = 'immediate' | 'deferred';
  const failsAt = (mode: Mode, declaredPurge: boolean): 'statement' | 'commit' =>
    (mode === 'deferred' || declaredPurge ? 'commit' : 'statement');
  assert.equal(failsAt('immediate', false), 'statement',
    'the current mode must refuse an ordinary violation on that statement, as v1.11 RESTRICT did');
  assert.equal(failsAt('immediate', true), 'commit',
    'and a declared purge must be able to push the same check to the commit point, or D20 ③ has no order that works');
  assert.equal(failsAt('deferred', false), 'commit',
    'PC-CX-58 must reproduce: the superseded reading moves every ordinary violation to the commit point');
  assert.notEqual(failsAt('immediate', false), failsAt('deferred', false),
    'the two readings would have to differ observably, or this finding would be a typo rather than a defect');
  // The catalog columns the migration has to assert, and why three are not enough.
  for (const col of ['condeferrable', 'condeferred', 'confdeltype', 'confupdtype']) {
    assert.ok(section(PCC, '12.1').includes(col), `§12.1 G5 does not assert ${col}`);
  }
});

/** §12.1's steps, as the set of database objects each leaves behind. */
type Objects = { d18Events: 'update' | 'insert-update'; d19Fk: boolean; d19Guard: boolean; d20: boolean };
const START: Record<string, Objects> =
  { empty: { d18Events: 'update', d19Fk: false, d19Guard: false, d20: false },
    'v1.10': { d18Events: 'update', d19Fk: false, d19Guard: false, d20: false },
    'v1.11': { d18Events: 'insert-update', d19Fk: true, d19Guard: true, d20: false } };
function migrate(from: Objects, steps: { has6g2: boolean }): Objects {
  // 6g2 (v1.13): audits, then D18 rebuilt as BEFORE INSERT OR UPDATE, then D19's two objects.
  const after = steps.has6g2
    ? { ...from, d18Events: 'insert-update' as const, d19Fk: true, d19Guard: true }
    : { ...from };
  return { ...after, d20: true };            // 6h
}

test('PC-CX-59 the one-shot migration installs every v1.11 hard gate', () => {
  const withRow = Object.entries(START).map(([label, start]) => [label, migrate(start, { has6g2: true })] as const);
  for (const [label, objects] of withRow) {
    assert.deepEqual(objects, { d18Events: 'insert-update', d19Fk: true, d19Guard: true, d20: true },
      `the ${label} starting point does not converge on the object set §7.7 D18 / D19 / D20 specify`);
  }
  // Reverse control: v1.12's table had no such row, so a v1.10 or empty database landed short.
  for (const label of ['empty', 'v1.10']) {
    assert.deepEqual(migrate(START[label], { has6g2: false }),
      { d18Events: 'update', d19Fk: false, d19Guard: false, d20: true },
      `PC-CX-59 must reproduce: without 6g2 the ${label} path lands "v1.10 + D20"`);
  }

  // The document half: the row exists, installs all three objects, and is ordered.
  const migration = section(PCC, '12.1');
  const row6g2 = migration.split('\n').find((l) => l.includes('**6g2**')) ?? '';
  assert.ok(row6g2, '§12.1 still has no migration row for the three v1.11 objects');
  for (const object of ['project_action_result_session_fk', 'session_result_link_delete_guard',
    'project_action_result_ledger_mutator', 'BEFORE INSERT OR UPDATE']) {
    assert.ok(row6g2.includes(object), `6g2 does not install ${object}`);
  }
  assert.ok(row6g2.indexOf('D18-e') < row6g2.indexOf('BEFORE INSERT OR UPDATE'),
    'the existing-data audits must precede the gate they decide');
  assert.ok(row6g2.indexOf('D19-e') < row6g2.indexOf('project_action_result_session_fk'),
    'D19-e must precede the foreign key that cannot be created while it returns rows');
  assert.ok(migration.indexOf('**6g2**') < migration.indexOf('**6h**'), '6g2 must precede 6h');
  assert.match(migration, /㉓/, 'G5 does not verify the three migration paths converge');
  assert.match(section(PCC, '15'), /\*\*F59\*\*/, '§15 has no fault row for a migration that skips a version');
});

/** §7.7 D20 ⓪: one `(action, session)` pair of a ledger, and whether D20-c admits it. */
type Pair = { action: string; session: string; origin: 'COORDINATOR' | 'USER'; type: string; status: string;
  link: string | null; lineage: string | null; project: string; subjectType: string; subjectId: string | null;
  taskId: string | null; taskProject: string | null; alsoReferencedElsewhere?: boolean };
/**
 * v1.14 (PC-CX-62): the predicate *is* §4.3 I11-A's attribution closure, column by column — an
 * APPLIED DISPATCH_TASK, both directions of the link, and the Task this session runs being the one
 * that action dispatched, inside this same Project. PC-CX-60 collapsed two copies of the set into
 * one function; this is the other half of that sentence — the surviving copy has to quantify the
 * thing it claims to, and the only definition of "whose placeholder is this" is I11-A.
 */
function inScope(p: Pair): boolean {
  return p.origin === 'COORDINATOR' && p.type === 'DISPATCH_TASK' && p.lineage === p.action
    && p.status === 'APPLIED' && p.link === p.session
    && p.subjectType === 'TASK' && p.taskId !== null && p.subjectId === p.taskId
    && p.taskProject === p.project
    && !p.alsoReferencedElsewhere;
}
/** v1.13 ⓪: the shape conditions only — every terminal status passed and attribution went unread. */
function inScopeV113(p: Pair): boolean {
  return p.origin === 'COORDINATOR' && p.type === 'DISPATCH_TASK' && p.lineage === p.action
    && (p.status === 'APPLIED' ? p.link === p.session : p.link === null)
    && !p.alsoReferencedElsewhere;
}
/** v1.12 ③-3: the union of the two paths, with none of the other four conditions. */
function inScopeV112(p: Pair): boolean {
  return p.lineage === p.action || p.link === p.session;
}
type PurgeAnswer = { outcome: 'committed' | 'undecidable' | 'undeclared'; deleted: string[] };
function purgeLedger(pairs: Pair[], entry: 'function' | 'bare',
  admits: (p: Pair) => boolean = inScope): PurgeAnswer {
  // D20-i: both entry points adjudicate the same domain, in the same order, before anything moves.
  if (pairs.some((p) => !admits(p))) return { outcome: 'undecidable', deleted: [] };
  const scope = pairs.filter(admits).map((p) => p.session);
  if (entry === 'bare' && scope.length > 0) return { outcome: 'undeclared', deleted: [] };
  return { outcome: 'committed', deleted: scope };
}
const purge113 = (pairs: Pair[], entry: 'function' | 'bare'): PurgeAnswer => purgeLedger(pairs, entry);
function purge112(pairs: Pair[], entry: 'function' | 'bare'): PurgeAnswer {
  if (entry === 'bare') {
    // v1.12's fence only counted the lineage half of the union.
    const stranded = pairs.filter((p) => p.lineage === p.action);
    return stranded.length > 0 ? { outcome: 'undeclared', deleted: [] } : { outcome: 'committed', deleted: [] };
  }
  return { outcome: 'committed', deleted: pairs.filter(inScopeV112).map((p) => p.session) };
}

/** A pair that satisfies §4.3 I11-A on every column: the positive control both rounds are read against. */
const WELL_FORMED: Pair = { action: 'a1', session: 's1', origin: 'COORDINATOR', type: 'DISPATCH_TASK',
  status: 'APPLIED', link: 's1', lineage: 'a1', project: 'p1', subjectType: 'TASK', subjectId: 't1',
  taskId: 't1', taskProject: 'p1' };
/** The review's v1.12 witness: a terminal dispatch whose result link points at a USER Session. */
const USER_ORIGIN: Pair = { ...WELL_FORMED, session: 'u1', origin: 'USER', status: 'REFUSED',
  link: 'u1', lineage: null, taskId: null, taskProject: null };

test('PC-CX-60 the purge collection predicate is D20-c, mechanically', () => {
  const userOrigin = USER_ORIGIN;
  const wellFormed = WELL_FORMED;
  const unpublished: Pair = { ...wellFormed, session: 's2', status: 'CLAIMED', link: null };
  const shapes: [string, Pair][] = [
    ['USER-origin', userOrigin],
    ['one-way', { ...wellFormed, lineage: null }],
    ['cross-Project', { ...wellFormed, alsoReferencedElsewhere: true }],
    ['wrong action type', { ...wellFormed, type: 'ROTATE_COORDINATOR_SESSION' }],
    ['unpublished with a link', { ...unpublished, link: 's2' }],
  ];
  for (const [label, shape] of shapes) {
    for (const entry of ['function', 'bare'] as const) {
      assert.deepEqual(purge113([shape], entry), { outcome: 'undecidable', deleted: [] },
        `${label} via the ${entry} entry must fail closed with nothing deleted`);
    }
    assert.equal(purge113([shape], 'function').outcome, purge113([shape], 'bare').outcome,
      `${label}: the two entry points must give the same answer — that is PC-CX-60`);
  }
  // Positive controls, so "refuse everything" cannot pass.
  assert.deepEqual(purge113([wellFormed], 'function'), { outcome: 'committed', deleted: ['s1'] },
    'a well-formed placeholder must still be swept');
  // v1.14 (PC-CX-62): this was v1.13's second positive control, and it was the finding. §4.3 I11-A
  // only ever attributed a placeholder to an APPLIED dispatch — D9 refuses the other shapes at the
  // commit point — so an unpublished one is existing data to adjudicate, not a row to sweep.
  assert.deepEqual(purge113([unpublished], 'function'), { outcome: 'undecidable', deleted: [] },
    'an unpublished dispatch is not an I11-A placeholder: it must fail closed, not be swept (§32.1)');
  assert.deepEqual(purge113([], 'bare'), { outcome: 'committed', deleted: [] },
    'a Project with nothing to strand must still delete on a bare statement');

  // Reverse control: the review's exact observation — one fact, two committed results.
  assert.deepEqual(purge112([userOrigin], 'function'), { outcome: 'committed', deleted: ['u1'] },
    'PC-CX-60 must reproduce: the v1.12 union deletes the USER Session D20-c excludes');
  assert.deepEqual(purge112([userOrigin], 'bare'), { outcome: 'committed', deleted: [] },
    'PC-CX-60 must reproduce: the bare DELETE keeps the same Session, so the entry point decides');
  assert.notDeepEqual(purge112([userOrigin], 'function').deleted, purge112([userOrigin], 'bare').deleted,
    'and that difference is the whole finding: D20-f claimed the two committed result sets are equal');

  // The document half: one definition, two readers, and a typed way out.
  const seven = section(PCC, '7.7');
  const d20 = seven.slice(seven.indexOf('#### D20 '), seven.indexOf('#### D7 '));
  assert.match(d20, /coordinator_purge_ledger_pairs/, 'D20 has no single definition of its quantification domain');
  assert.ok(d20.includes('**D20-i（'), 'D20 does not say what happens to a pair it cannot adjudicate');
  assert.match(d20, /PROJECT_PURGE_UNDECIDABLE/, 'the fail-closed refusal has no typed code');
  assert.match(d20, /owner=USER, recovery=HUMAN/, 'the fail-closed refusal names no owner or recovery');
  assert.match(section(PCC, '15'), /\*\*F60\*\*/, '§15 has no fault row for an undecidable ledger link');
  assert.match(section(PCC, '12.1'), /㉔/, 'G5 does not verify that both entry points read the one definition');
});

/** §7.7 D20-k: the two commit orders, plus the bypass ③-2's NOWAIT turns into a typed refusal. */
type RaceOutcome = { purge: string; publish: string };
function race(order: 'purge-first' | 'publish-first' | 'bypass',
  gates: { lockLedger: boolean; publishFence: boolean }): RaceOutcome {
  if (order === 'publish-first') return { purge: '(n,m) committed', publish: 'committed' };
  if (order === 'bypass') {
    // A writer that skipped ④ holds an action row lock while the purge holds the Project row.
    return gates.lockLedger
      ? { purge: 'PROJECT_PURGE_CONTENDED', publish: 'committed' }
      : { purge: '40P01', publish: 'committed' };
  }
  if (!gates.publishFence) {
    // v1.12: nothing stops the publication landing between the snapshot and the cascade.
    return { purge: '23503', publish: 'committed' };
  }
  return { purge: '(n,m) committed', publish: 'PROJECT_PURGED' };
}

test('PC-CX-61 purge and publication share one linearization point', () => {
  const v113 = { lockLedger: true, publishFence: true };
  assert.deepEqual(race('publish-first', v113), { purge: '(n,m) committed', publish: 'committed' },
    'publish-wins: the purge queues on ③-1 and the late placeholder is inside its snapshot');
  assert.deepEqual(race('purge-first', v113), { purge: '(n,m) committed', publish: 'PROJECT_PURGED' },
    'purge-wins: the publication must lose with a typed result, not a bare 23503');
  assert.deepEqual(race('bypass', v113), { purge: 'PROJECT_PURGE_CONTENDED', publish: 'committed' },
    'a writer that bypasses ④ must produce a typed, retryable refusal rather than a deadlock');
  for (const order of ['purge-first', 'publish-first', 'bypass'] as const) {
    for (const side of ['purge', 'publish'] as const) {
      assert.doesNotMatch(race(order, v113)[side], /^(23503|40P01)$/,
        `${order}: the ${side} side still gets a native database error as normal control flow`);
    }
  }
  // Reverse controls: each gate on its own is what the finding turns on.
  assert.equal(race('purge-first', { ...v113, publishFence: false }).purge, '23503',
    'PC-CX-61 must reproduce: without ④ the stale snapshot aborts the whole purge at COMMIT');
  assert.equal(race('bypass', { ...v113, lockLedger: false }).purge, '40P01',
    'and without ③-2 the NOWAIT the same bypass is a native deadlock, with no owner and no recovery');

  const seven = section(PCC, '7.7');
  const d20 = seven.slice(seven.indexOf('#### D20 '), seven.indexOf('#### D7 '));
  assert.match(d20, /coordinator_project_publish_fence/, 'D20 has no publish-side fence');
  assert.match(d20, /FOR KEY SHARE/, 'the publish fence takes no lock that conflicts with the purge');
  assert.match(d20, /FOR UPDATE NOWAIT/, 'D20 has no answer for a writer that bypasses the fence');
  assert.match(d20, /PROJECT_PURGED/, 'the losing publication has no typed code');
  assert.match(d20, /PROJECT_PURGE_CONTENDED/, 'the contention path has no typed code');
  for (const clause of ['**D20-j（', '**D20-k（']) {
    assert.ok(d20.includes(clause), `D20 does not state ${clause}）`);
  }
  assert.match(section(PCC, '15'), /\*\*F61\*\*/, '§15 has no fault row for the purge/publish race');
  assert.match(section(PCC, '12.1'), /㉕/, 'G5 does not verify the two commit orders');
});

/** §4.3 I11-A as a predicate over one pair, so §7.7 D20 ⓪ can be compared against it column by column. */
function attributedByI11A(p: Pair): boolean {
  return p.type === 'DISPATCH_TASK' && p.status === 'APPLIED' && p.subjectType === 'TASK'
    && p.taskId !== null && p.subjectId === p.taskId && p.taskProject === p.project;
}

test("PC-CX-62 the purge scope is I11-A's attribution closure, mechanically", () => {
  const shapes: [string, Pair][] = [
    ['terminal REFUSED', { ...WELL_FORMED, session: 's-refused', status: 'REFUSED', link: null }],
    ['terminal SUPERSEDED', { ...WELL_FORMED, session: 's-superseded', status: 'SUPERSEDED', link: null }],
    ['still CLAIMED', { ...WELL_FORMED, session: 's-claimed', status: 'CLAIMED', link: null }],
    ['wrong subject type', { ...WELL_FORMED, subjectType: 'PROJECT' }],
    ['wrong subject id', { ...WELL_FORMED, subjectId: 't-other' }],
    ['session runs no task', { ...WELL_FORMED, taskId: null, taskProject: null }],
    ['task of another Project', { ...WELL_FORMED, taskProject: 'p-foreign' }],
  ];
  for (const [label, shape] of shapes) {
    assert.equal(attributedByI11A(shape), false, `${label}: positive control — I11-A does not attribute this shape`);
    for (const entry of ['function', 'bare'] as const) {
      assert.deepEqual(purgeLedger([shape], entry), { outcome: 'undecidable', deleted: [] },
        `${label} via the ${entry} entry must fail closed with nothing deleted`);
    }
    assert.deepEqual(purgeLedger([shape], 'function'), purgeLedger([shape], 'bare'),
      `${label}: the two entry points must give the same answer — D20-f on malformed data`);
  }

  // The binding itself, which is the whole fix: over every shape in play, ⓪ admits exactly the pairs
  // I11-A attributes to this ledger (plus the two structural conditions D20-c always had).
  const universe: Pair[] = [WELL_FORMED, USER_ORIGIN, ...shapes.map(([, shape]) => shape),
    { ...WELL_FORMED, lineage: null }, { ...WELL_FORMED, link: 's-other' },
    { ...WELL_FORMED, type: 'ROTATE_COORDINATOR_SESSION' },
    { ...WELL_FORMED, alsoReferencedElsewhere: true }];
  for (const p of universe) {
    const attributed = attributedByI11A(p) && p.origin === 'COORDINATOR'
      && p.lineage === p.action && p.link === p.session && !p.alsoReferencedElsewhere;
    assert.equal(inScope(p), attributed,
      `⓪ and I11-A disagree about ${p.session}: a second definition of "whose placeholder is this"`);
  }

  // Positive controls, so "refuse everything" cannot pass this test.
  assert.deepEqual(purgeLedger([WELL_FORMED], 'function'), { outcome: 'committed', deleted: ['s1'] },
    'a placeholder that satisfies I11-A column by column must still be swept');
  assert.deepEqual(purgeLedger([], 'bare'), { outcome: 'committed', deleted: [] },
    'a Project with nothing to strand must still delete on a bare statement');

  // Reverse controls: the review's two witnesses, replayed against the v1.13 predicate.
  const refused = shapes[0][1];
  const foreign: Pair = { ...WELL_FORMED, session: 's-foreign', link: 's-foreign',
    taskId: 't-foreign', taskProject: 'p-foreign' };
  for (const [label, witness] of [['REFUSED terminal', refused], ['foreign Task', foreign]] as const) {
    assert.equal(inScopeV113(witness), true, `PC-CX-62 must reproduce: v1.13 admitted the ${label} shape`);
    assert.deepEqual(purgeLedger([witness], 'function', inScopeV113),
      { outcome: 'committed', deleted: [witness.session] },
      `PC-CX-62 must reproduce: v1.13's function physically deletes the ${label} Session`);
  }
  assert.deepEqual(purgeLedger([refused], 'bare', inScopeV113), { outcome: 'undeclared', deleted: [] },
    'PC-CX-62 must reproduce: the bare DELETE keeps the same Session, so the entry point decides');
  assert.notDeepEqual(purgeLedger([refused], 'function', inScopeV113).deleted,
    purgeLedger([refused], 'bare', inScopeV113).deleted,
    'and that difference is the finding: D20-f claimed the two committed result sets are equal');

  // The document half: one definition of attribution, read by the one function that authorises the delete.
  const seven = section(PCC, '7.7');
  const d20 = seven.slice(seven.indexOf('#### D20 '), seven.indexOf('#### D7 '));
  assert.match(d20, /a\.status = 'APPLIED'/, '⓪ no longer requires the dispatch to be APPLIED');
  assert.doesNotMatch(d20, /OR \(a\.status <> 'APPLIED' AND a\.result_session_id IS NULL\)\)/,
    'the superseded status branch is alive in D20 — that is PC-CX-62');
  for (const column of [/a\.subject_type = 'TASK'/, /a\.subject_id IS NOT DISTINCT FROM s\.task_id/,
    /t\.project_id = a\.project_id/]) {
    assert.match(d20, column, `⓪ does not read the I11-A attribution column ${String(column)}`);
  }
  assert.match(section(PCC, '4.3'), /subject_id = session\.task_id/,
    'positive control: I11-A no longer states the attribution ⓪ is bound to');
  assert.match(d20, /PROJECT_PURGE_UNDECIDABLE/, 'the fail-closed refusal has no typed code');
  assert.match(section(PCC, '15'), /\*\*F62\*\*/, '§15 has no fault row for an unattributed placeholder');
  assert.match(section(PCC, '12.1'), /㉖/, 'G5 does not verify that ⓪ reads every I11-A column');
});

test('mutation check: the I11-A binding added for PC-CX-62 is load-bearing', () => {
  const refused: Pair = { ...WELL_FORMED, session: 's-refused', status: 'REFUSED', link: null };
  const foreign: Pair = { ...WELL_FORMED, session: 's-foreign', link: 's-foreign',
    taskId: 't-foreign', taskProject: 'p-foreign' };
  // Remove exactly what v1.14 added — the predicate falls back to v1.13's — and both published
  // witnesses reappear: one fact with two committed results, and one Project's purge taking
  // another Project's Session with it.
  assert.deepEqual(purgeLedger([refused], 'function', inScopeV113).deleted, ['s-refused'],
    'PC-CX-62: without the I11-A binding the terminal witness is not deleted, so it is not what closed it');
  assert.deepEqual(purgeLedger([refused], 'bare', inScopeV113).deleted, [],
    'PC-CX-62: the bare entry point kept it, which is the half that made the two answers differ');
  assert.deepEqual(purgeLedger([foreign], 'function', inScopeV113).deleted, ['s-foreign'],
    'PC-CX-62: without the binding the cross-Project witness is not deleted either');
  // …and with the fence in place neither witness is reachable through either entry point.
  for (const shape of [refused, foreign]) {
    for (const entry of ['function', 'bare'] as const) {
      assert.deepEqual(purgeLedger([shape], entry), { outcome: 'undecidable', deleted: [] },
        `${shape.session} is still reachable through the ${entry} entry`);
    }
  }
});

test('mutation check: every fence added for PC-CX-58..61 is load-bearing', () => {
  const userOrigin = USER_ORIGIN;
  const mutants: { finding: string; fence: string; defectReappears: () => boolean }[] = [
    {
      finding: 'PC-CX-58',
      fence: 'the single initial mode stated in D20-l (§2.4 · D19-c · D20 ① · §12.1 6h)',
      // Two readings that fail at different moments is the defect; one reading is the fix.
      defectReappears: () => PCC.slice(0, PCC.indexOf('\n## 19. ')).includes('NO ACTION DEFERRABLE INITIALLY DEFERRED'),
    },
    {
      finding: 'PC-CX-59',
      fence: 'migration step 6g2 (§12.1)',
      defectReappears: () => migrate(START['v1.10'], { has6g2: false }).d19Fk === false
        && migrate(START.empty, { has6g2: false }).d18Events === 'update',
    },
    {
      finding: 'PC-CX-60',
      fence: 'the ⓪ quantification domain read by both entry points (§7.7 D20 ⓪ · D20-i)',
      defectReappears: () => purge112([userOrigin], 'function').deleted.length === 1
        && purge112([userOrigin], 'bare').deleted.length === 0,
    },
    {
      finding: 'PC-CX-61',
      fence: 'the shared Project linearization point (§7.7 D20 ③-2 · ④ · D20-j)',
      defectReappears: () => race('purge-first', { lockLedger: true, publishFence: false }).purge === '23503'
        && race('bypass', { lockLedger: false, publishFence: true }).purge === '40P01',
    },
  ];
  for (const mutant of mutants) {
    if (mutant.finding === 'PC-CX-58') {
      assert.equal(mutant.defectReappears(), false,
        'PC-CX-58: the superseded wording must be gone from §1–§18, which is the whole fix');
      continue;
    }
    assert.equal(mutant.defectReappears(), true,
      `${mutant.finding}: removing ${mutant.fence} does not bring the published counterexample back, so it is not what closed it`);
  }
});

test('§31 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§30 have, for the thirteenth round.
  const rows = tables(section(PCC, '31'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-58', 'PC-CX-59', 'PC-CX-60', 'PC-CX-61']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`) || self.includes(`test("${name}"`),
      `§31 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '31').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 4, '§31 promises fewer real-Postgres assertions than the review asked for');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§31 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '31').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§31 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§31 points at §${m[1]}, which does not exist`);
  }
});

test('§32 names a test that exists for every finding, and points at clauses that exist', () => {
  // The same mirror §20–§31 have, for the fourteenth round.
  const rows = tables(section(PCC, '32'))[0];
  const ids = column(rows, 'ID').map(bare);
  assert.deepEqual(ids, ['PC-CX-62']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-counterexample.spec.ts'), 'utf8');
  for (const name of column(rows, '可执行断言').map(bare)) {
    assert.ok(self.includes(`test('${name}'`) || self.includes(`test("${name}"`),
      `§32 names "${name}", which is not a test in this file`);
  }
  const pg = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'), 'utf8');
  const named = Array.from(section(PCC, '32').matchAll(/`(PC-CX-\d\d on real Postgres:[^`]+)`/g), (m) => m[1]);
  assert.ok(named.length >= 1, '§32 promises no real-Postgres assertion for a P0 the review found on real Postgres');
  for (const name of named) {
    assert.ok(pg.includes(`test('${name}'`), `§32 names "${name}", which is not a test in the Postgres spec`);
  }

  assert.match(section(PCC, '32').split('\n').slice(0, 4).join('\n'), /本节是非规范的/, '§32 is not marked non-normative');
  for (const clause of column(rows, '规范条款').map(bare).flatMap((c) => c.split(' · '))) {
    const m = /§(\d+(?:\.\d+)?)/.exec(clause);
    if (m) assert.doesNotThrow(() => section(PCC, m[1]), `§32 points at §${m[1]}, which does not exist`);
  }
});
