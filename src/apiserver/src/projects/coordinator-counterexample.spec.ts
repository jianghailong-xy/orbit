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

test('PC-CX-10 no turnFacts column names anything that moves on its own', () => {
  // TF1 is a deny-list, so it can be checked by reading the frozen table rather than by trusting
  // that whoever writes the next `reasonCode` remembers the rule.
  const triggerTable = tables(section(PCC, '7.2')).find((t) => t[0].some((h) => h.includes('reasonCode')))!;
  const facts = column(triggerTable, 'turnFacts（进入 reasonDigest 的快照投影，§7.3）');
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
  const trigger = tableRows(section(PCC, '7.2')).find((cells) => bare(cells[0]) === 'BLOCKER_DECISION')!;
  return (/\{([^}]+)\}/.exec(trigger[1])?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
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
  assert.equal(table.length, 18, '§11.2 freezes eighteen kinds');

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
