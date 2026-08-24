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
    title: 'Coordinate: Ship the coordinator',
    status: RunStatus.AWAITING_INPUT,
    endReason: null,
    startedAt: new Date('2026-08-24T06:00:00.000Z'),
    finishedAt: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    engineTurnActive: false,
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
};

function serviceWith(fixture: Fixture = {}) {
  const queries: string[] = [];
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
      count: async () => {
        queries.push('approval.count');
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
  };
  const acceptance = { criteriaSummary: async () => ({ total: 0, passed: 0, lastRunAt: null, criteria: [] }) };
  return { service: new ProjectsService(prisma as never, acceptance as never), queries };
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
  assert.equal(session.title, 'Coordinate: Ship the coordinator');
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

test('only a generating session is asked for its pending approvals', async () => {
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
