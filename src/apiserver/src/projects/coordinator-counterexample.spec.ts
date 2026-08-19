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
// What this is NOT: units 03–23 have not been written, so none of these primitives exist in
// Postgres yet. §19.9 records the boundary — `dispatch-linearization.spec.ts` (two real
// transactions with a barrier) and `mixed-version-dispatch.spec.ts` (a real rolling upgrade) are
// still owed by units 09/13/19/22. What changed is that the contract now names *which* primitive
// those tests must exercise, which is what made them writable.
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
  const conflictFacts = { kind: 'MERGE_CONFLICT', subject: 'X', occurrences: 1 };
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
  const moved = turnDecision(d, 61_000, 0, 'BLOCKER_DECISION', { ...conflictFacts, occurrences: 2 });
  assert.equal(moved.decision, 'OPEN');
  assert.notEqual((moved as { key: string }).key, (first as { key: string }).key);

  // …and the same generation is still in play, which is precisely what v1 could not express.
  assert.ok((moved as { key: string }).key.includes(':turn:0:'));
});

test('PC-CX-07 the no-progress blocker clears itself when the facts move', () => {
  // BL3: clearing is driven by recomputing the condition, so the blocker cannot outlive its reason.
  const facts = { kind: 'MERGE_CONFLICT', subject: 'X', occurrences: 1 };
  const digest = sha256(`BLOCKER_DECISION|${JSON.stringify(facts)}`);
  const b = blocker({ kind: 'COORDINATOR_NO_PROGRESS', owner: 'USER', recovery: 'HUMAN', dedupeKey: `COORDINATOR_NO_PROGRESS:${digest}` });

  const stillStuck = sha256(`BLOCKER_DECISION|${JSON.stringify(facts)}`);
  assert.equal(b.dedupeKey.endsWith(stillStuck), true, 'unchanged facts keep the blocker open');

  const moved = sha256(`BLOCKER_DECISION|${JSON.stringify({ ...facts, occurrences: 2 })}`);
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
