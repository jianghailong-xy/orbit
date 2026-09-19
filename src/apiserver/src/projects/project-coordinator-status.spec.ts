import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { withSessionState } from '../sessions/session-state';
import { COORDINATOR_UNAVAILABLE_CODE, ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const SESSION_ID = '00000000-0000-7000-8000-0000000000b1';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000c1';
const AGENT_ID = '00000000-0000-7000-8000-0000000000c2';
const RUNNER_ID = '00000000-0000-7000-8000-0000000000d1';
const BORROWED_ID = '00000000-0000-7000-8000-0000000000c3';

/** The session columns `coordinatorStatus` selects, in the shape Prisma hands back. */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    title: 'Ship the coordinator',
    status: RunStatus.AWAITING_INPUT,
    endReason: null,
    startedAt: new Date('2026-08-24T06:00:00.000Z'),
    finishedAt: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    engineTurnActive: false,
    // NOT NULL DEFAULT '{}' on the column, and the count the card carries reads it: a conversation
    // that is not generating can still be holding a card a live runner-hosted job is reading.
    runningBgShells: [],
    ...overrides,
  };
}

/** A live, enabled workspace bound to a runner — the only landing that is usable. */
function workspaceRow(overrides: Record<string, unknown> = {}) {
  return { name: 'orbit', deletedAt: null, enabled: true, runnerId: RUNNER_ID, ...overrides };
}

/** The project row the read's `select` produces, defaulted to "never had a coordinator". */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    coordinatorSessionId: null,
    coordinatorWorkspaceId: null,
    coordinatorSession: null,
    coordinatorWorkspace: null,
    members: [] as Array<{ agentId: string; agent: { name: string } }>,
    runtime: { coordinatorGeneration: 0n },
    ...overrides,
  };
}

const COORDINATOR_MEMBER = [{ agentId: AGENT_ID, agent: { name: 'orbit' } }];

type Fixture = {
  project?: Record<string, unknown>;
  pendingApprovals?: number;
  /** What `busiestAssignee` finds, and the workspace row behind it. */
  borrowed?: { id: string; name: string } | null;
  /** The open `project_fuse_episode`, when this project is paused (§6.2). */
  pausedEpisodeId?: string | null;
  /** The newest platform delivery to the coordinator, as the union read hands it back (§7.2 V7). */
  carried?: { at: Date; returnedAt: Date | null; deliveredAt: Date | null } | null;
  /** What `assessSpend` reads, for the row that says what today cost (§6.1). */
  spend?: { selfStartedTurns: number; limit: number | null };
};

function serviceWith(fixture: Fixture = {}) {
  const queries: string[] = [];
  /** The `where` of every `approval.count` this read made — the rule is the filter, not the total. */
  const approvalWheres: Array<Record<string, unknown>> = [];
  const prisma = {
    project: {
      findFirst: async ({ where }: any) => {
        queries.push('project.findFirst');
        return where.id === PROJECT_ID && where.ownerId === OWNER_ID
          ? (fixture.project ?? projectRow())
          : null;
      },
    },
    approval: {
      count: async ({ where }: any) => {
        queries.push('approval.count');
        approvalWheres.push(where);
        return fixture.pendingApprovals ?? 0;
      },
    },
    task: {
      groupBy: async () => {
        queries.push('task.groupBy');
        return fixture.borrowed ? [{ assigneeId: fixture.borrowed.id, _count: { _all: 4 } }] : [];
      },
    },
    workspace: {
      findUnique: async ({ where }: any) => {
        queries.push('workspace.findUnique');
        return fixture.borrowed && where.id === fixture.borrowed.id
          ? { id: fixture.borrowed.id, name: fixture.borrowed.name }
          : null;
      },
    },
    // The two progress reads (§7.2 V9): the open pause, and the newest thing the platform sent the
    // coordinator. Raw because both are one statement over rows Prisma has no model join for.
    $queryRaw: async (query: unknown) => {
      const text = (query as { text?: string }).text ?? '';
      if (text.includes('FROM "project_fuse_episode"')) {
        queries.push('fuse.episode');
        return fixture.pausedEpisodeId ? [{ id: fixture.pausedEpisodeId }] : [];
      }
      if (text.includes('FROM "project_open_item_delivery"')) {
        queries.push('wakeups');
        return fixture.carried ? [fixture.carried] : [];
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
  };
  const acceptance = { criteriaSummary: async () => ({ total: 0, passed: 0, lastRunAt: null, criteria: [] }) };
  const convergence = {
    assessSpend: async () => ({
      spend: {
        selfStartedTurns: fixture.spend?.selfStartedTurns ?? 0,
        sessionsOpened: 0,
        successorRetries: 0,
      },
      limits: {
        maxSelfStartedTurnsPerDay: fixture.spend === undefined ? 40 : fixture.spend.limit,
        maxSessionsOpenedPerDay: 40,
        maxRetriesPerSuccessorChain: 2,
      },
    }),
  };
  // Positional, and the three in between are the ones this read never reaches: passing `undefined`
  // is what lets their own defaults stand rather than stubbing services nothing here calls.
  const service = new ProjectsService(
    prisma as never,
    acceptance as never,
    undefined as never,
    undefined as never,
    undefined as never,
    convergence as never,
  );
  return { service, queries, approvalWheres };
}

// ── The five states, each asserting WHICH reason rather than merely that a value is missing ──

test('NEVER_OPENED: nothing has ever been bound, and the read says which nothing', async () => {
  const { service } = serviceWith({ borrowed: { id: BORROWED_ID, name: 'workhorse' } });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'NEVER_OPENED');
  assert.equal(status.projectId, PROJECT_ID);
  assert.ok(status.readAt instanceof Date);

  assert.equal(status.coordination.sessionId, null);
  assert.equal(status.coordination.sessionIdAbsentReason, 'COORDINATOR_NEVER_OPENED');
  assert.equal(status.coordination.session, null);
  assert.equal(status.coordination.sessionAbsentReason, 'COORDINATOR_NEVER_OPENED');
  assert.equal(status.coordination.coordinatorGeneration, 0n);
  assert.equal(status.coordination.workspaceId, null);
  assert.equal(status.coordination.workspaceIdAbsentReason, 'NO_COORDINATION_WORKSPACE');
  assert.equal(status.coordination.workspaceName, null);
  assert.equal(status.coordination.workspaceNameAbsentReason, 'NO_COORDINATION_WORKSPACE');
  assert.equal(status.coordination.agentId, null);
  assert.equal(status.coordination.agentIdAbsentReason, 'NO_COORDINATOR_AGENT');
  assert.equal(status.coordination.agentName, null);
  assert.equal(status.coordination.agentNameAbsentReason, 'NO_COORDINATOR_AGENT');

  // It has never had one, so it gets to choose: where this project's work already runs.
  assert.equal(status.openability.canOpen, true);
  assert.equal(status.openability.willCreate, true);
  assert.equal(status.openability.refusalCode, null);
  assert.equal(status.openability.refusalDetail, null);
  assert.equal(status.openability.refusalCodeAbsentReason, 'NOTHING_REFUSES');
  assert.equal(status.openability.requiredAction, null);
  assert.equal(status.openability.requiredActionAbsentReason, 'NOTHING_REFUSES');
  assert.equal(status.openability.landing.workspaceId, BORROWED_ID);
  assert.equal(status.openability.landing.workspaceIdAbsentReason, null);
  assert.equal(status.openability.landing.workspaceName, 'workhorse');
  assert.equal(status.openability.landing.workspaceNameAbsentReason, null);
  assert.equal(status.openability.landing.fixed, false);
});

test('NEVER_OPENED with nothing to borrow: the 400 the button would give, before the press', async () => {
  const { service } = serviceWith({ borrowed: null });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'NEVER_OPENED');
  assert.equal(status.openability.canOpen, false);
  assert.equal(status.openability.refusalCode, 'NO_LANDING_WORKSPACE');
  assert.equal(status.openability.refusalDetail, 'NO_TASK_ASSIGNEE');
  assert.equal(status.openability.refusalCodeAbsentReason, null);
  assert.match(status.openability.requiredAction ?? '', /Assign a task, or pass workspaceId\./);
  assert.equal(status.openability.landing.workspaceId, null);
  assert.equal(status.openability.landing.workspaceIdAbsentReason, 'LANDING_REFUSED');
  assert.equal(status.openability.landing.workspaceNameAbsentReason, 'LANDING_REFUSED');
});

test('LIVE: the conversation is alive, so nothing refuses and nothing would be created', async () => {
  const { service } = serviceWith({
    pendingApprovals: 2,
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ status: RunStatus.RUNNING }),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 3n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'LIVE');
  assert.equal(status.coordination.sessionId, SESSION_ID);
  assert.equal(status.coordination.sessionIdAbsentReason, null);
  assert.equal(status.coordination.sessionAbsentReason, null);
  assert.equal(status.coordination.coordinatorGeneration, 3n);
  assert.equal(status.coordination.workspaceId, WORKSPACE_ID);
  assert.equal(status.coordination.workspaceIdAbsentReason, null);
  assert.equal(status.coordination.workspaceName, 'orbit');
  assert.equal(status.coordination.workspaceNameAbsentReason, null);
  assert.equal(status.coordination.agentId, AGENT_ID);
  assert.equal(status.coordination.agentName, 'orbit');
  assert.equal(status.coordination.agentIdAbsentReason, null);

  const session = status.coordination.session;
  assert.ok(session);
  assert.equal(session.id, SESSION_ID);
  assert.equal(session.title, 'Ship the coordinator');
  assert.equal(session.runStatus, RunStatus.RUNNING);
  assert.equal(session.runState, 'RUNNING');
  assert.equal(session.lifecycleState, 'OPEN');
  assert.equal(session.filingState, 'OPEN');
  assert.equal(session.pendingApprovals, 2);
  assert.equal(session.engineTurnActive, false);
  // Every missing timestamp names the state it is missing FROM, never a bare null.
  assert.equal(session.endReason, null);
  assert.equal(session.endReasonAbsentReason, 'SESSION_NOT_ENDED');
  assert.equal(session.startedAtAbsentReason, null);
  assert.equal(session.finishedAt, null);
  assert.equal(session.finishedAtAbsentReason, 'SESSION_STILL_RUNNING');
  assert.equal(session.completedAt, null);
  assert.equal(session.completedAtAbsentReason, 'SESSION_NOT_COMPLETED');
  assert.equal(session.deletedAt, null);
  assert.equal(session.deletedAtAbsentReason, 'SESSION_NOT_TRASHED');

  assert.equal(status.openability.canOpen, true);
  // The reuse branch: pressing the button hands this same conversation back.
  assert.equal(status.openability.willCreate, false);
  assert.equal(status.openability.refusalCodeAbsentReason, 'NOTHING_REFUSES');
  assert.equal(status.openability.landing.workspaceId, null);
  assert.equal(status.openability.landing.workspaceIdAbsentReason, 'COORDINATOR_ALREADY_LIVE');
  assert.equal(status.openability.landing.workspaceNameAbsentReason, 'COORDINATOR_ALREADY_LIVE');
  assert.equal(status.openability.landing.fixed, true);
});

test('TRASHED: the conversation is in Trash, and the replacement already has a home', async () => {
  const trashedAt = new Date('2026-08-24T07:00:00.000Z');
  const { service } = serviceWith({
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ deletedAt: trashedAt }),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 1n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'TRASHED');
  // The pointer survives a soft delete, so the session is still named — that is the affordance
  // ("restore it") the purged case does not have.
  assert.equal(status.coordination.sessionId, SESSION_ID);
  assert.equal(status.coordination.sessionIdAbsentReason, null);
  assert.equal(status.coordination.session?.deletedAt, trashedAt);
  assert.equal(status.coordination.session?.deletedAtAbsentReason, null);
  assert.equal(status.coordination.session?.lifecycleState, 'TRASH');
  assert.equal(status.coordination.session?.filingState, 'TRASH');

  assert.equal(status.openability.canOpen, true);
  assert.equal(status.openability.willCreate, true);
  assert.equal(status.openability.refusalCode, null);
  assert.equal(status.openability.landing.workspaceId, WORKSPACE_ID);
  assert.equal(status.openability.landing.workspaceName, 'orbit');
  // Fixed: §7.5 replaces the SESSION, never the workspace, so this cannot be redirected.
  assert.equal(status.openability.landing.fixed, true);
});

test('UNAVAILABLE: the bound workspace is disabled, and it is still named so it can be enabled', async () => {
  const { service } = serviceWith({
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ deletedAt: new Date('2026-08-24T07:00:00.000Z') }),
      coordinatorWorkspace: workspaceRow({ enabled: false }),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 1n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'UNAVAILABLE');
  assert.equal(status.coordination.workspaceId, WORKSPACE_ID);
  assert.equal(status.coordination.workspaceIdAbsentReason, null);
  // Live, merely disabled — so the name is served and the card can say which one to enable.
  assert.equal(status.coordination.workspaceName, 'orbit');
  assert.equal(status.coordination.workspaceNameAbsentReason, null);

  assert.equal(status.openability.canOpen, false);
  assert.equal(status.openability.refusalCode, COORDINATOR_UNAVAILABLE_CODE);
  assert.equal(status.openability.refusalDetail, 'WORKSPACE_DISABLED');
  assert.equal(status.openability.refusalCodeAbsentReason, null);
  assert.match(status.openability.requiredAction ?? '', /rebind this project’s coordination workspace/);
  assert.equal(status.openability.requiredActionAbsentReason, null);
  assert.equal(status.openability.landing.workspaceIdAbsentReason, 'LANDING_REFUSED');
  assert.equal(status.openability.landing.fixed, true);
});

test('UNAVAILABLE: the bound workspace was hard-deleted, and there is nothing to offer', async () => {
  const { service } = serviceWith({
    project: projectRow({
      // The FK's SET NULL fired: the project no longer records where its coordinator ran.
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: null,
      coordinatorSession: sessionRow({ deletedAt: new Date('2026-08-24T07:00:00.000Z') }),
      coordinatorWorkspace: null,
      members: [],
      runtime: { coordinatorGeneration: 2n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'UNAVAILABLE');
  assert.equal(status.coordination.workspaceId, null);
  assert.equal(status.coordination.workspaceIdAbsentReason, 'COORDINATION_WORKSPACE_PURGED');
  assert.equal(status.coordination.workspaceName, null);
  assert.equal(status.coordination.workspaceNameAbsentReason, 'COORDINATION_WORKSPACE_PURGED');
  // The trigger drops the coordinator membership when the landing cannot carry an identity.
  assert.equal(status.coordination.agentIdAbsentReason, 'NO_COORDINATOR_AGENT');

  assert.equal(status.openability.canOpen, false);
  assert.equal(status.openability.refusalCode, COORDINATOR_UNAVAILABLE_CODE);
  assert.equal(status.openability.refusalDetail, 'WORKSPACE_FORGOTTEN');
  assert.equal(status.openability.landing.workspaceIdAbsentReason, 'LANDING_REFUSED');
  assert.equal(status.openability.landing.fixed, false);
});

// ── The two distinctions the frozen contract corrects or introduces ──

test('a FIRST coordinator that was purged is PURGED, not NEVER_OPENED — a first bind is generation 0', async () => {
  const { service } = serviceWith({
    project: projectRow({
      // Session hard-deleted (SET NULL) while the workspace pointer stands. Nothing has rotated,
      // so the generation is still 0 — which is exactly what the old rule got wrong.
      coordinatorSessionId: null,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: null,
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 0n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.coordination.sessionIdAbsentReason, 'COORDINATOR_SESSION_PURGED');
  assert.equal(status.coordination.sessionAbsentReason, 'COORDINATOR_SESSION_PURGED');
  // It has had a coordinator, it is unreachable, and the replacement's home is already decided.
  assert.equal(status.state, 'TRASHED');
  assert.equal(status.openability.landing.workspaceId, WORKSPACE_ID);
});

test('the generation is the fallback when BOTH pointers were purged', async () => {
  const { service } = serviceWith({
    project: projectRow({ runtime: { coordinatorGeneration: 4n } }),
    borrowed: null,
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.coordination.sessionIdAbsentReason, 'COORDINATOR_SESSION_PURGED');
  assert.equal(status.coordination.workspaceIdAbsentReason, 'COORDINATION_WORKSPACE_PURGED');
});

test('a soft-deleted workspace keeps its id and loses its name', async () => {
  const { service } = serviceWith({
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ deletedAt: new Date('2026-08-24T07:00:00.000Z') }),
      coordinatorWorkspace: workspaceRow({ deletedAt: new Date('2026-08-23T00:00:00.000Z') }),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 1n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'UNAVAILABLE');
  // The id is what the owner needs in order to restore it, so it is served.
  assert.equal(status.coordination.workspaceId, WORKSPACE_ID);
  assert.equal(status.coordination.workspaceIdAbsentReason, null);
  // The name is not, so nothing can print a workspace in Trash as though it were there.
  assert.equal(status.coordination.workspaceName, null);
  assert.equal(status.coordination.workspaceNameAbsentReason, 'COORDINATION_WORKSPACE_TRASHED');
  assert.equal(status.openability.refusalDetail, 'WORKSPACE_TRASHED');
});

test('a live, enabled workspace with no runner is UNBOUND rather than merely unopenable', async () => {
  const { service } = serviceWith({
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ deletedAt: new Date('2026-08-24T07:00:00.000Z') }),
      coordinatorWorkspace: workspaceRow({ runnerId: null }),
      members: COORDINATOR_MEMBER,
      runtime: { coordinatorGeneration: 1n },
    }),
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.equal(status.state, 'UNAVAILABLE');
  assert.equal(status.openability.refusalDetail, 'WORKSPACE_UNBOUND');
  assert.equal(status.coordination.workspaceName, 'orbit');
});

// ── One answer to "is it finished", not two ──

test('the session’s three derived states are the ones withSessionState derives, row for row', async () => {
  const rows = [
    sessionRow({ status: RunStatus.PENDING }),
    sessionRow({ status: RunStatus.RUNNING }),
    sessionRow({ status: RunStatus.AWAITING_INPUT }),
    sessionRow({ status: RunStatus.INTERRUPTED }),
    sessionRow({ status: RunStatus.INTERRUPTED, endReason: 'user_ended' }),
    sessionRow({ status: RunStatus.SUCCEEDED, completedAt: new Date('2026-08-24T07:30:00.000Z') }),
    // The legacy mirror alone: `completedAt` is the fold of both, never a second reading.
    sessionRow({ status: RunStatus.SUCCEEDED, archivedAt: new Date('2026-08-24T07:30:00.000Z') }),
    sessionRow({ status: RunStatus.FAILED }),
    sessionRow({ status: RunStatus.CANCELLED, endReason: 'cancelled' }),
    sessionRow({ status: RunStatus.RUNNING, deletedAt: new Date('2026-08-24T07:45:00.000Z') }),
  ];

  for (const row of rows) {
    const { service } = serviceWith({
      project: projectRow({
        coordinatorSessionId: SESSION_ID,
        coordinatorWorkspaceId: WORKSPACE_ID,
        coordinatorSession: row,
        coordinatorWorkspace: workspaceRow(),
        members: COORDINATOR_MEMBER,
      }),
    });
    const served = (await service.coordinatorStatus(OWNER_ID, PROJECT_ID)).coordination.session;
    const derived = withSessionState(row);
    assert.ok(served, `no session served for ${row.status}`);
    assert.deepEqual(
      {
        runStatus: served.runStatus,
        runState: served.runState,
        lifecycleState: served.lifecycleState,
        filingState: served.filingState,
        completedAt: served.completedAt,
      },
      {
        runStatus: derived.runStatus,
        runState: derived.runState,
        lifecycleState: derived.lifecycleState,
        filingState: derived.filingState,
        completedAt: derived.completedAt,
      },
      `endpoint and withSessionState disagree about ${row.status}`,
    );
  }
});

test('the count is taken for a live reader: the turn, or the job a card names', async () => {
  // Nothing is reading a card on a conversation that has ended, so the read is not made at all —
  // not merely answered 0 — and the row says nothing is waiting.
  const idle = serviceWith({
    pendingApprovals: 7,
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ status: RunStatus.SUCCEEDED }),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
    }),
  });
  const idleStatus = await idle.service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(idleStatus.coordination.session?.pendingApprovals, 0);
  assert.equal(idle.queries.includes('approval.count'), false);
  // Including a parked conversation whose shells have all gone: the job that was reading is not up
  // any more, which is the state the reap collects the row in.
  const parked = serviceWith({
    pendingApprovals: 7,
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow(),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
    }),
  });
  assert.equal(
    (await parked.service.coordinatorStatus(OWNER_ID, PROJECT_ID)).coordination.session?.pendingApprovals,
    0,
  );
  assert.equal(parked.queries.includes('approval.count'), false);

  // A self-driven turn stays at AWAITING_INPUT while it runs; its prompt is no less blocking.
  const waking = serviceWith({
    pendingApprovals: 7,
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ status: RunStatus.AWAITING_INPUT, engineTurnActive: true }),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
    }),
  });
  const wakingStatus = await waking.service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(wakingStatus.coordination.session?.pendingApprovals, 7);
  assert.equal(waking.queries.includes('approval.count'), true);
  // A generating session holds its turn's cards, so the count is of the session and nothing narrower.
  assert.deepEqual(waking.approvalWheres, [{ sessionId: SESSION_ID, status: 'PENDING' }]);

  // And the second reader, on the conversation shape a runner-hosted job asks on: PARKED, with the
  // runner still reporting the job up. The card that job is polling for is a question the owner has
  // to be shown — the count that was blind to it is the one the card went dark under.
  const jobbed = serviceWith({
    pendingApprovals: 1,
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorSession: sessionRow({ runningBgShells: ['bgj_still_polling'] }),
      coordinatorWorkspace: workspaceRow(),
      members: COORDINATOR_MEMBER,
    }),
  });
  const jobbedStatus = await jobbed.service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(jobbedStatus.coordination.session?.pendingApprovals, 1);
  // Asked for that job's cards and no others: a card whose own job has gone is not this one's, and
  // a card naming no job at all is the turn's, which is over.
  assert.deepEqual(jobbed.approvalWheres, [
    { sessionId: SESSION_ID, status: 'PENDING', backgroundJobId: { in: ['bgj_still_polling'] } },
  ]);
});

// ── Wire-shape rules the interceptors impose on this payload ──

test('all four alias-mirrored names are emitted, and the landing suppresses its identity half', async () => {
  const { service } = serviceWith({ borrowed: { id: BORROWED_ID, name: 'workhorse' } });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  // WorkspaceAliasInterceptor only ADDS the missing half, so an explicit null is what stops it
  // filling `agentId` in from the workspace beside it.
  for (const key of ['workspaceId', 'workspaceName', 'agentId', 'agentName']) {
    assert.ok(key in status.coordination, `coordination is missing ${key}`);
  }
  assert.ok('agentId' in status.openability.landing);
  assert.ok('agentName' in status.openability.landing);
  assert.equal(status.openability.landing.agentId, null);
  assert.equal(status.openability.landing.agentName, null);
});

test('the counter is a BigInt, so the wire gets a decimal string rather than a double', async () => {
  const { service } = serviceWith({ project: projectRow({ runtime: { coordinatorGeneration: 9007199254740993n } }) });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(typeof status.coordination.coordinatorGeneration, 'bigint');
  assert.equal(status.coordination.coordinatorGeneration.toString(), '9007199254740993');
});

test('a project with no runtime row reads generation 0 rather than failing the read', async () => {
  const { service } = serviceWith({ project: projectRow({ runtime: null }) });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(status.coordination.coordinatorGeneration, 0n);
  assert.equal(status.coordination.sessionIdAbsentReason, 'COORDINATOR_NEVER_OPENED');
});

// ── Tenancy ──

test('an unknown id and another owner’s id get the same 404', async () => {
  const { service } = serviceWith();
  await assert.rejects(
    () => service.coordinatorStatus(OWNER_ID, '00000000-0000-7000-8000-00000000ffff'),
    /project not found/,
  );
  await assert.rejects(() => service.coordinatorStatus(OTHER_OWNER_ID, PROJECT_ID), /project not found/);
});

// ── The two progress rows the card gained (§7.2 V9) ──

test('the last thing the platform sent the coordinator is DELIVERED once a turn was handed over', async () => {
  const handed = new Date('2026-08-24T06:56:00.000Z');
  const { service } = serviceWith({
    project: projectRow({
      coordinatorSessionId: SESSION_ID,
      coordinatorSession: sessionRow(),
      coordinatorWorkspaceId: WORKSPACE_ID,
      coordinatorWorkspace: workspaceRow(),
    }),
    carried: { at: new Date('2026-08-24T06:55:00.000Z'), returnedAt: null, deliveredAt: handed },
    spend: { selfStartedTurns: 6, limit: 30 },
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);

  assert.deepEqual(status.coordination.wakeups, { state: 'DELIVERED', at: handed });
  assert.deepEqual(status.coordination.fuse, {
    selfStartedToday: 6,
    limit: 30,
    paused: false,
    episodeId: null,
  });
});

test('a turn nobody has taken yet is QUEUED, and one handed back is RETURNED', async () => {
  const written = new Date('2026-08-24T06:55:00.000Z');
  const queued = await serviceWith({
    project: projectRow({ coordinatorSessionId: SESSION_ID, coordinatorSession: sessionRow() }),
    carried: { at: written, returnedAt: null, deliveredAt: null },
  }).service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.deepEqual(queued.coordination.wakeups, { state: 'QUEUED', at: written });

  const taken = new Date('2026-08-24T06:57:00.000Z');
  const returned = await serviceWith({
    project: projectRow({ coordinatorSessionId: SESSION_ID, coordinatorSession: sessionRow() }),
    // A delivery that was taken back at a drain point is not a delivery, whatever the turn says.
    carried: { at: written, returnedAt: taken, deliveredAt: taken },
  }).service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.deepEqual(returned.coordination.wakeups, { state: 'RETURNED', at: taken });
});

test('a project with no coordinator is asked nothing, and reads NONE', async () => {
  const { service, queries } = serviceWith();
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.deepEqual(status.coordination.wakeups, { state: 'NONE', at: null });
  assert.equal(queries.includes('wakeups'), false);
});

test('an open episode is what makes the card say paused, not the reading beside it', async () => {
  const episode = '00000000-0000-7000-8000-0000000000e1';
  const paused = await serviceWith({
    project: projectRow({ coordinatorSessionId: SESSION_ID, coordinatorSession: sessionRow() }),
    pausedEpisodeId: episode,
    spend: { selfStartedTurns: 31, limit: 30 },
  }).service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.deepEqual(paused.coordination.fuse, {
    selfStartedToday: 31,
    limit: 30,
    paused: true,
    episodeId: episode,
  });

  // Resumed: the day's spend has not moved, and the card must not go on saying it is stopped.
  const resumed = await serviceWith({
    project: projectRow({ coordinatorSessionId: SESSION_ID, coordinatorSession: sessionRow() }),
    pausedEpisodeId: null,
    spend: { selfStartedTurns: 31, limit: 30 },
  }).service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(resumed.coordination.fuse.paused, false);
  assert.equal(resumed.coordination.fuse.selfStartedToday, 31);
});

test('a limit the owner signed away reads as no limit rather than as zero', async () => {
  const { service } = serviceWith({
    project: projectRow({ coordinatorSessionId: SESSION_ID, coordinatorSession: sessionRow() }),
    spend: { selfStartedTurns: 12, limit: null },
  });
  const status = await service.coordinatorStatus(OWNER_ID, PROJECT_ID);
  assert.equal(status.coordination.fuse.limit, null);
  assert.equal(status.coordination.fuse.selfStartedToday, 12);
});
