import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectsService } from './projects.service';
import {
  COORDINATOR_STATUS_ABSENT_REASONS,
  COORDINATOR_STATUS_SECTIONS,
} from './project-coordinator-status';

/**
 * The control/observability surface (contract AC10, unit 20).
 *
 * Three properties, and each one is a defect this endpoint was built to make impossible:
 *
 *  - **Nothing is omitted.** Every section is present on every project, and a fact that is missing
 *    is `null` beside a closed-set `absentReason`. A dropped key reads to a client exactly like a
 *    field the server has never heard of, which is how "nothing is blocking this project" and
 *    "this build cannot tell you what is blocking it" become the same response.
 *  - **No raw UUID leaves.** The interceptor rewrites id-shaped FIELDS, so the ones that need
 *    saying-so are the ids buried inside STRINGS — an action's `idempotencyKey`, an event's
 *    `dedupeKey` — which it cannot see into. And `leaseHolder`, which is a compare-and-swap fence
 *    rather than an address, must not be served at all.
 *  - **A stale or unauthorized write is refused with nothing written.** The compare-and-swap is
 *    taken under the same row lock as the write it guards, so "refused" and "rolled back" are one
 *    outcome rather than two.
 */

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const AGENT = '019fcda0-d021-72a2-a914-2f4de38f469c';
const WORKSPACE = '019fcdad-acd0-73f1-b83e-34c901525105';
const SESSION = '019fcdae-c039-76c2-bb7b-1a7c550f8e26';
const TASK = '019fcde0-9653-7703-a10f-e8c17e4a0b1e';
const DECISION = '019fcfea-9d8b-7303-8784-e1b3078faef3';
const ACTION = '019fd08e-53b9-71a0-a1c0-bd1fc2a5683a';
const EVENT = '019fd08f-fd17-7e93-93fb-0f6989da8af6';
const BLOCKER = '019fd0d2-2c17-7b83-8864-418e1f137f8c';

const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** A project nobody has coordinated yet: every runtime column at its default, no ledger rows. */
const EMPTY_HEAD = {
  id: PROJECT,
  title: 'Coordinator control loop',
  status: 'OPEN',
  createdAt: new Date('2026-08-19T01:50:21.759Z'),
  updatedAt: new Date('2026-08-19T01:50:21.759Z'),
  acceptanceCriteria: null,
  coordinatorEnabled: false,
  automationPolicy: 'MANUAL',
  configRevision: 0n,
  maxConcurrentTasks: 3,
  sessionBudgetPerDay: null,
  coordinatorSessionId: null,
  coordinatorWorkspaceId: null,
  runState: 'PLANNING',
  nextWakeAt: null,
  nextWakeReason: null,
  coordinatorGeneration: 0n,
  identitySource: 'DERIVED',
  leaseTaken: false,
  leaseExpiresAt: null,
  leaseHeartbeatAt: null,
  fencingToken: 0n,
  acceptanceAttempt: 0n,
  coordinatorAgentId: null,
  coordinatorAgentName: null,
  sessionStatus: null,
  sessionEndReason: null,
  sessionStartedAt: null,
  sessionFinishedAt: null,
  sessionCompletedAt: null,
  sessionArchivedAt: null,
  sessionDeletedAt: null,
};

/** The same project once the loop has run on it: coordinated, leased, decided, blocked, waking. */
const LIVE_HEAD = {
  ...EMPTY_HEAD,
  acceptanceCriteria: 'every task DONE and merged',
  coordinatorEnabled: true,
  automationPolicy: 'GUARDED_AUTO',
  configRevision: 7n,
  sessionBudgetPerDay: 10,
  coordinatorSessionId: SESSION,
  coordinatorWorkspaceId: WORKSPACE,
  runState: 'EXECUTING',
  nextWakeAt: new Date('2026-08-20T12:00:00.000Z'),
  nextWakeReason: 'BLOCKER:MERGE_CONFLICT',
  coordinatorGeneration: 2n,
  identitySource: 'EXPLICIT',
  leaseTaken: true,
  leaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
  leaseHeartbeatAt: new Date('2026-08-20T11:59:40.000Z'),
  fencingToken: 41n,
  acceptanceAttempt: 1n,
  coordinatorAgentId: AGENT,
  coordinatorAgentName: 'orbit',
  sessionStatus: 'RUNNING',
  sessionEndReason: null,
  sessionStartedAt: new Date('2026-08-20T11:00:00.000Z'),
};

const DECISION_ROW = {
  id: DECISION,
  createdAt: new Date('2026-08-20T11:59:00.000Z'),
  decidedBy: 'ORCHESTRATOR',
  reason: 'task.status_changed',
  decisionInputHash: 'b'.repeat(64),
  fencingToken: 41n,
  coordinatorAgentId: AGENT,
  coordinatorSessionId: SESSION,
  outcome: {
    runStateBefore: 'PLANNING',
    runStateAfter: 'EXECUTING',
    configRevision: '7',
    nextWakeAt: '2026-08-20T12:00:00.000Z',
    nextWakeReason: 'BLOCKER:MERGE_CONFLICT',
    detail: {
      wakeCandidates: [
        {
          at: '2026-08-20T12:00:00.000Z',
          source: 1,
          subjectType: 'BLOCKER',
          subjectId: uuidToBase62(BLOCKER),
          reason: 'MERGE_CONFLICT',
        },
        {
          at: '2026-08-20T12:01:00.000Z',
          source: 6,
          subjectType: 'PROJECT',
          subjectId: uuidToBase62(PROJECT),
          reason: 'PLANNING backstop',
        },
      ],
      flooredBy: null,
    },
  },
};

/** The ledger key really is built out of row UUIDs; that is the point of publicizing it. */
const ACTION_ROW = {
  id: ACTION,
  decisionId: DECISION,
  type: 'DISPATCH_TASK',
  status: 'CLAIMED',
  subjectType: 'TASK',
  subjectId: TASK,
  idempotencyKey: `pc:v1:${PROJECT}:dispatch:${TASK}:1`,
  refusalCode: null,
  reasonCode: null,
  resultSessionId: null,
  fencingToken: 41n,
  createdAt: new Date('2026-08-20T11:59:00.000Z'),
  updatedAt: new Date('2026-08-20T11:59:00.000Z'),
};

const EVENT_ROW = {
  id: EVENT,
  kind: 'user.manual_trigger',
  occurredAt: new Date('2026-08-20T11:58:00.000Z'),
  sourceType: 'USER',
  sourceId: OWNER,
  dedupeKey: `user.manual_trigger:${SESSION}`,
  occurrences: 2,
  lastAt: new Date('2026-08-20T11:58:30.000Z'),
  attempts: 1,
  nextAttemptAt: new Date('2026-08-20T11:59:30.000Z'),
  consumedAt: null,
  disposition: null,
};

const BLOCKER_ROW = {
  id: BLOCKER,
  kind: 'MERGE_CONFLICT',
  owner: 'COORDINATOR',
  recovery: 'EVENT',
  severity: 'CRITICAL',
  requiredAction: 'Resolve the merge conflict on this branch and merge again.',
  nextCheckAt: new Date('2026-08-20T12:00:00.000Z'),
  subjectType: 'TASK',
  subjectId: TASK,
  detail: {},
  dedupeKey: `MERGE_CONFLICT:TASK:${TASK}`,
  lifecycleGeneration: 1n,
  conditionVersion: 'c'.repeat(64),
  firstSeenAt: new Date('2026-08-20T11:00:00.000Z'),
  lastSeenAt: new Date('2026-08-20T11:58:00.000Z'),
  occurrences: 4,
  escalatedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  raisedByActionId: ACTION,
  raisedByActionStatus: 'APPLIED',
};

const MERGE_ROW = {
  sessionId: SESSION,
  taskId: TASK,
  taskTitle: '20 API/CLI surface',
  taskStatus: 'IN_PROGRESS',
  branch: 'orbit/20-surface',
  baseSha: 'ac2032df',
  mergeStatus: 'merged',
  mergeTarget: 'feat/project',
  mergedSourceSha: 'deadbeef',
  branchMerged: true,
  mergedAt: new Date('2026-08-20T11:30:00.000Z'),
  commitStatus: 'committed',
  worktreeDirty: false,
};

interface Ledger {
  head?: unknown[];
  decisions?: unknown[];
  decisionActions?: unknown[];
  pendingActions?: unknown[];
  acceptance?: unknown[];
  events?: unknown[];
  merges?: unknown[];
  blockers?: unknown[];
  groups?: Array<{ status: string; _count: { _all: number } }>;
  /** §13.4's native acceptance record (unit 25A). Absent means this project has never run one,
   *  which is the state every scenario in this file is written against. */
  runs?: unknown[];
  /** §13.7's merge receipts, the evidence a project's branches actually landed. */
  mergeReceipts?: unknown[];
  /** §13.8: @-mentions in this project that nobody has received. */
  undeliveredMentions?: unknown[];
}

/** Both spellings a raw query arrives in: `Prisma.sql` (a Sql) and a tagged template. */
function sqlText(arg: unknown): string {
  const parts = (arg as { strings?: readonly string[] })?.strings ?? (arg as readonly string[]);
  return Array.isArray(parts) ? parts.join(' ') : String(arg);
}

function service(ledger: Ledger = {}): ProjectsService {
  const prisma = {
    project: {
      findFirst: async () => ({ id: PROJECT }),
      // The acceptance digest reads the criteria off the project row (§13.4 AE1).
      findUnique: async () => ({ acceptanceCriteria: null }),
    },
    task: {
      groupBy: async () => ledger.groups ?? [],
      // The digest's `taskSet` / `verdicts` projections. Empty here: this file is about the
      // control-loop sections, and a scenario that needed a populated digest would say so by
      // setting `runs` as well.
      findMany: async () => [],
    },
    // The two reads the acceptance summary and the DONE gate make. `projectBlocker` and
    // `taskVerificationFailure` are the gate's own counts — the raw-SQL tallies above are the
    // status page's, and they are deliberately not the same read.
    projectAcceptanceRun: { findFirst: async () => (ledger.runs ?? [])[0] ?? null },
    // §13.7's merge evidence. Empty here for the same reason `task.findMany` is: this file is
    // about the control-loop sections, and merge-receipt.pg.spec owns the receipts themselves.
    sessionMergeReceipt: { findMany: async () => ledger.mergeReceipts ?? [] },
    projectBlocker: { count: async () => 0 },
    taskVerificationFailure: { count: async () => 0 },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      // Most specific first: four of these read `project_action`, and the consumption query
      // mentions `'CLAIMED'` too — matching on that alone routed it to the wrong ledger.
      if (sql.includes('"tasksInFlight"')) {
        return [{ tasksInFlight: 2, coordinatorSessionsLast24h: 4 }];
      }
      if (sql.includes('RUN_PROJECT_ACCEPTANCE')) return ledger.acceptance ?? [];
      // The digest's `mergeEvidence` projection: newest generation per (requirement, branch).
      if (sql.includes('FROM "project_merge_evidence"')) return [];
      // §13.8's undelivered @-mentions. Empty by default for the same reason as the merge evidence
      // above: this file is about the control-loop sections, and the ledger has its own pg spec.
      if (sql.includes('FROM "task_comment_mention_delivery"')) {
        return ledger.undeliveredMentions ?? [];
      }
      if (sql.includes('a."decision_id" IN')) return ledger.decisionActions ?? [];
      if (sql.includes(`a."status"::text = 'CLAIMED'`)) return ledger.pendingActions ?? [];
      if (sql.includes('FROM "project_decision"')) return ledger.decisions ?? [];
      if (sql.includes('FROM "project_event"')) return ledger.events ?? [];
      if (sql.includes('FROM "project_blocker"')) return ledger.blockers ?? [];
      if (sql.includes('task_verification_failure')) return [{ count: 3 }];
      if (sql.includes('"inconclusive"')) {
        return [{ total: 4, pending: 1, pass: 2, fail: 1, inconclusive: 0 }];
      }
      if (sql.includes('FROM "session" s JOIN "task" t')) return ledger.merges ?? [];
      if (sql.includes('LEFT JOIN "project_runtime"')) return ledger.head ?? [];
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    },
    // The gate is evaluated in one transaction so its four projections come from one snapshot; the
    // double hands the same client straight through, which is what every other transaction in this
    // file's scenarios does.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return new ProjectsService(prisma as never, {} as never);
}

function through<T>(body: T): Promise<T> {
  class Controller {}
  return lastValueFrom(
    new PublicIdInterceptor().intercept(
      { getClass: () => Controller } as never,
      { handle: () => of(body) } as never,
    ),
  ) as Promise<T>;
}

function live(): Promise<Record<string, any>> {
  return service({
    head: [LIVE_HEAD],
    groups: [{ status: 'DONE', _count: { _all: 39 } }, { status: 'OPEN', _count: { _all: 4 } }],
    decisions: [DECISION_ROW],
    decisionActions: [ACTION_ROW],
    pendingActions: [ACTION_ROW],
    acceptance: [{ ...ACTION_ROW, type: 'RUN_PROJECT_ACCEPTANCE', status: 'APPLIED' }],
    events: [EVENT_ROW],
    merges: [MERGE_ROW],
    blockers: [BLOCKER_ROW, { ...BLOCKER_ROW, resolvedAt: new Date(), resolvedBy: 'AUTO' }],
  }).coordinatorStatus(OWNER, PROJECT) as Promise<Record<string, any>>;
}

// ── Nothing is omitted ────────────────────────────────────────────────────────────────────────

test('a project nobody has coordinated returns every section, none of them missing', async () => {
  const status = await service({ head: [EMPTY_HEAD] }).coordinatorStatus(OWNER, PROJECT);
  for (const section of COORDINATOR_STATUS_SECTIONS) {
    assert.ok(section in status, `section ${section} is missing from an empty project's status`);
  }
});

test('every absent fact says WHY, from the closed set', async () => {
  const status = await service({ head: [EMPTY_HEAD] }).coordinatorStatus(OWNER, PROJECT) as any;
  const reasons: Array<[string, unknown]> = [
    ['coordination.agentId', status.coordination.agentIdAbsentReason],
    ['coordination.workspaceId', status.coordination.workspaceIdAbsentReason],
    ['coordination.sessionId', status.coordination.sessionIdAbsentReason],
    ['coordination.session', status.coordination.sessionAbsentReason],
    ['policy.sessionBudgetPerDay', status.policy.sessionBudgetPerDayAbsentReason],
    ['consumption.budgetRemaining', status.consumption.budgetRemainingAbsentReason],
    ['runtime.lease', status.runtime.leaseAbsentReason],
    ['nextWake', status.nextWake.absentReason],
    ['nextWake.candidates', status.nextWake.candidatesAbsentReason],
    ['decisions', status.decisionsEmptyReason],
    ['pendingActions', status.pendingActionsEmptyReason],
    ['blockers.open', status.blockers.openEmptyReason],
    ['events.pending', status.events.pendingEmptyReason],
    ['acceptance.criteria', status.acceptance.criteriaAbsentReason],
    ['acceptance.lastRun', status.acceptance.lastRunAbsentReason],
    ['acceptance.evidence.merges', status.acceptance.evidence.mergesEmptyReason],
  ];
  // Every one of those is a null with a reason beside it, never a key that is simply not there.
  for (const [field, value] of [
    ['coordination.agentId', status.coordination.agentId],
    ['coordination.sessionId', status.coordination.sessionId],
    ['runtime.lease', status.runtime.lease],
    ['acceptance.lastRun', status.acceptance.lastRun],
  ] as Array<[string, unknown]>) {
    assert.equal(value, null, `${field} should be an explicit null`);
  }
  for (const [field, reason] of reasons) {
    assert.ok(reason !== null && reason !== undefined, `${field} is absent without saying why`);
    assert.ok(
      (COORDINATOR_STATUS_ABSENT_REASONS as readonly string[]).includes(reason as string),
      `${field} gave an off-vocabulary reason: ${reason}`,
    );
  }
});

test('"never opened" and "opened then trashed" are different answers', async () => {
  const never = await service({ head: [EMPTY_HEAD] }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(never.coordination.sessionAbsentReason, 'COORDINATOR_NEVER_OPENED');
  // Same empty pointer, but the generation says this project HAS been coordinated before, so
  // there is history to go and read — and telling somebody "never opened" would be false.
  const rotated = await service({
    head: [{ ...EMPTY_HEAD, coordinatorGeneration: 3n }],
  }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(rotated.coordination.sessionAbsentReason, 'COORDINATOR_SESSION_TRASHED');
});

test('a live project reports state, decisions, blockers, wake and acceptance evidence', async () => {
  const status = await live();
  assert.equal(status.runtime.runState, 'EXECUTING');
  assert.equal(status.policy.automationPolicy, 'GUARDED_AUTO');
  assert.equal(status.policy.configRevision, '7');
  assert.equal(status.coordination.generation, '2');
  assert.equal(status.coordination.session.runStatus, 'RUNNING');
  assert.equal(status.coordination.session.lifecycleState, 'OPEN');
  // The numbers the admission gates compare against, not a second count of the same things.
  assert.equal(status.consumption.tasksInFlight, 2);
  assert.equal(status.consumption.concurrencyRemaining, 1);
  assert.equal(status.consumption.budgetRemaining, 6);
  assert.equal(status.nextWake.reason, 'BLOCKER:MERGE_CONFLICT');
  assert.equal(status.decisions[0].runStateAfter, 'EXECUTING');
  assert.equal(status.decisions[0].actions.length, 1);
  assert.equal(status.pendingActions[0].type, 'DISPATCH_TASK');
  assert.equal(status.blockers.open.length, 1);
  assert.equal(status.blockers.resolved.length, 1);
  assert.equal(status.blockers.open[0].requiredAction, BLOCKER_ROW.requiredAction);
  assert.equal(status.events.pending.length, 1);
  assert.equal(status.events.pending[0].attempts, 1);
  assert.equal(status.acceptance.evidence.verifications.unresolvedFailures, 3);
  assert.equal(status.acceptance.evidence.verifications.pass, 2);
  // §13.4 clause 6: merge state is read from reported content, not from `--contains`.
  assert.equal(status.acceptance.evidence.merges[0].branchMerged, true);
  assert.equal(status.acceptance.evidence.merges[0].mergedSourceSha, 'deadbeef');
});

test('the wake candidate table is the one the decision recorded, losers included', async () => {
  const status = await live();
  assert.equal(status.nextWake.candidates.length, 2);
  assert.equal(status.nextWake.candidatesAbsentReason, null);
  assert.equal(status.nextWake.candidates[1].reason, 'PLANNING backstop');
  assert.equal(status.nextWake.decisionId, DECISION);
});

test('no decision and an old decision are told apart, not both reported as "none"', async () => {
  const none = await service({ head: [LIVE_HEAD] }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(none.nextWake.candidatesAbsentReason, 'NO_DECISION_YET');
  const old = await service({
    head: [LIVE_HEAD],
    decisions: [{ ...DECISION_ROW, outcome: { runStateAfter: 'EXECUTING' } }],
  }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(old.nextWake.candidatesAbsentReason, 'DECISION_PREDATES_WAKE_AUDIT');
});

// ── No raw UUID leaves ────────────────────────────────────────────────────────────────────────

test('every id is Base62 once the response has been served', async () => {
  const status = await through(await live());
  const json = JSON.stringify(status);
  const leak = UUID_ANYWHERE.exec(json);
  assert.equal(leak, null, `a raw UUID reached the wire: ${leak?.[0]}`);
});

test('the ids buried inside key strings are publicized by the service itself', async () => {
  // The interceptor rewrites FIELDS holding an id. These two are ids in the middle of a string,
  // which it cannot see into — so if the service did not do it, nothing would.
  const status = await live();
  assert.equal(
    status.pendingActions[0].idempotencyKey,
    `pc:v1:${uuidToBase62(PROJECT)}:dispatch:${uuidToBase62(TASK)}:1`,
  );
  assert.equal(
    status.events.pending[0].dedupeKey,
    `user.manual_trigger:${uuidToBase62(SESSION)}`,
  );
});

test('the lease fence is reported as held-until, never as who holds it', async () => {
  const status = await live();
  assert.equal(status.runtime.lease.fencingToken, '41');
  assert.ok(!('leaseHolder' in status.runtime.lease), 'the lease holder must not be served');
  assert.equal(JSON.stringify(status).includes('leaseHolder'), false);
  // An expired lease is not a held one: the row keeps its holder until the next acquisition.
  const stale = await service({
    head: [{ ...LIVE_HEAD, leaseExpiresAt: new Date('2020-01-01T00:00:00.000Z') }],
  }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(stale.runtime.lease, null);
  assert.equal(stale.runtime.leaseAbsentReason, 'NOT_LEASED');
});

test('the monotonic counters are strings, so two of them never compare equal by rounding', async () => {
  const status = await service({
    head: [{ ...LIVE_HEAD, configRevision: 9007199254740993n, fencingToken: 9007199254740993n }],
  }).coordinatorStatus(OWNER, PROJECT) as any;
  assert.equal(status.policy.configRevision, '9007199254740993');
  assert.equal(status.runtime.fencingToken, '9007199254740993');
});

// ── Authorization ─────────────────────────────────────────────────────────────────────────────

test('another account’s project is the same 404 every project read gives', async () => {
  const prisma = {
    project: { findFirst: async () => null },
    task: { groupBy: async () => [] },
    // The owner predicate is in the query itself, so a project belonging to somebody else simply
    // does not come back — there is no window where it is read and then checked.
    $queryRaw: async () => [],
  };
  await assert.rejects(
    new ProjectsService(prisma as never, {} as never).coordinatorStatus(OWNER, PROJECT),
    /project not found/,
  );
});

test('the status read is scoped by owner in the query, not after it', async () => {
  const seen: unknown[][] = [];
  const prisma: Record<string, unknown> = {
    project: {
      findFirst: async () => ({ id: PROJECT }),
      findUnique: async () => ({ acceptanceCriteria: null }),
    },
    task: { groupBy: async () => [], findMany: async () => [] },
    projectAcceptanceRun: { findFirst: async () => null },
    sessionMergeReceipt: { findMany: async () => [] },
    projectBlocker: { count: async () => 0 },
    taskVerificationFailure: { count: async () => 0 },
    $queryRaw: async (arg: any) => {
      const sql = sqlText(arg);
      seen.push(arg.values ?? []);
      if (sql.includes('LEFT JOIN "project_runtime"')) return [EMPTY_HEAD];
      // The aggregate queries return one row by construction, so an empty array here would be a
      // fixture bug reported as a product one.
      if (sql.includes('"tasksInFlight"')) {
        return [{ tasksInFlight: 0, coordinatorSessionsLast24h: 0 }];
      }
      if (sql.includes('"inconclusive"')) {
        return [{ total: 0, pending: 0, pass: 0, fail: 0, inconclusive: 0 }];
      }
      if (sql.includes('task_verification_failure')) return [{ count: 0 }];
      return [];
    },
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  await new ProjectsService(prisma as never, {} as never).coordinatorStatus(OWNER, PROJECT);
  assert.ok(seen[0].includes(OWNER), 'the head query must carry the owner');
});
