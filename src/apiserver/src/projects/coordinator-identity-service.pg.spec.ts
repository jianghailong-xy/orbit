import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * The same rules as `project-coordinator-identity.spec.ts`, but against a real database and a real
 * Prisma client — because half of what this unit persists is only true if the database agrees.
 *
 * A stub can be made to say that `runtime: { create: {} }` writes a row, that
 * `configRevision: { increment: 1 }` is a legal update, or that replacing a coordinator edits one
 * row: none of those are claims about this service, they are claims about what Postgres and Prisma
 * do with what it sends. This file makes the service send it for real.
 *
 * Skipped unless a disposable database with the full schema is pointed at it — the same one the
 * migration spec uses, in its own `public` schema:
 *
 *   COORDINATOR_PG_URL=postgres://pcc03_admin:pcc03@127.0.0.1:55437/pcc03_mig \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03_mig COORDINATOR_PG_EXPECTED_USER=pcc03_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<...> \
 *   node --test build/projects/coordinator-identity-service.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

const OWNER_ID = '00000000-0000-7000-8000-0000000003c1';
const RUNNER_ID = '00000000-0000-7000-8000-0000000003c2';
const AGENT_A = '00000000-0000-7000-8000-0000000003c3';
const AGENT_B = '00000000-0000-7000-8000-0000000003c4';
const SESSION_OLD = '00000000-0000-7000-8000-0000000003c5';
const SESSION_NEW = '00000000-0000-7000-8000-0000000003c6';

type ClientCtor = new (config: { connectionString?: string }) => Client;

/**
 * Prove the target, then seed the fixture this file owns and nothing else.
 *
 * Every row it writes is keyed by the ids above and removed again at the end of each test, so the
 * database is left as it was found whether the test passed or failed.
 */
async function open(): Promise<{ prisma: any; service: ProjectsService; teardown: () => Promise<void> }> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const probe = new Ctor({ connectionString: URL });
  await probe.connect();
  await verifyCoordinatorPgIdentity(probe);
  await probe.end();

  const prisma = prismaClientFor(URL!);

  const wipe = async () => {
    await prisma.projectMember.deleteMany({ where: { project: { ownerId: OWNER_ID } } });
    await prisma.projectRuntime.deleteMany({ where: { project: { ownerId: OWNER_ID } } });
    await prisma.project.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.session.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.workspace.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.runner.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.user.deleteMany({ where: { id: OWNER_ID } });
  };
  await wipe();

  await prisma.user.create({
    data: { id: OWNER_ID, email: `pcc03-${OWNER_ID}@example.test`, name: 'pcc03', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: { id: RUNNER_ID, ownerId: OWNER_ID, name: 'pcc03 runner', tokenHash: 'x' },
  });
  await prisma.workspace.createMany({
    data: [
      { id: AGENT_A, ownerId: OWNER_ID, runnerId: RUNNER_ID, name: 'agent A' },
      { id: AGENT_B, ownerId: OWNER_ID, runnerId: RUNNER_ID, name: 'agent B' },
    ],
  });

  // The coordinator path creates a session; here it makes the row the service is about to bind, so
  // the swap and the rotation count run against real rows and a real unique index.
  const sessions = {
    create: async () => {
      await prisma.session.create({
        data: {
          id: SESSION_NEW,
          ownerId: OWNER_ID,
          creatorId: OWNER_ID,
          workspaceId: AGENT_A,
          title: 'replacement',
          prompt: 'x',
        },
      });
      return { id: SESSION_NEW };
    },
    remove: async () => ({ ok: true }),
    end: async () => ({ ok: true }),
  };

  return {
    prisma,
    service: new ProjectsService(prisma as unknown as PrismaService, sessions as never),
    teardown: async () => {
      await wipe();
      await prisma.$disconnect();
    },
  };
}

test('a project created through the service arrives coordinated, with its runtime row', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 create' } as never);

    const row = await prisma.project.findUnique({
      where: { id: created.id },
      include: { runtime: true, members: true },
    });
    assert.equal(row.coordinatorEnabled, true);
    assert.equal(row.automationPolicy, 'GUARDED_AUTO');
    assert.equal(row.maxConcurrentTasks, 3);
    assert.equal(row.sessionBudgetPerDay, null);
    assert.equal(row.configRevision, 0n);
    // The nested write is a real row, not a shape a stub accepted.
    assert.equal(row.runtime.coordinatorGeneration, 0n);
    assert.deepEqual(row.members, []);
  } finally {
    await teardown();
  }
});

test('a project recorded from a session has that session’s agent as its coordinator', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    await prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT_A,
        title: 'planning',
        prompt: 'x',
      },
    });

    const created: any = await service.create(OWNER_ID, { title: 'pcc03 in session' } as never, {
      sessionId: SESSION_OLD,
      workspaceId: AGENT_A,
    });

    assert.equal(created.coordinatorAgentId, AGENT_A);
    const members = await prisma.projectMember.findMany({ where: { projectId: created.id } });
    assert.equal(members.length, 1);
    assert.equal(members[0].role, 'COORDINATOR');
    assert.equal(members[0].agentId, AGENT_A);
  } finally {
    await teardown();
  }
});

test('the revision is a real counter: one step per authorization write, none for prose', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 revision' } as never);
    const read = async () =>
      (await prisma.project.findUnique({ where: { id: created.id } })).configRevision;

    await service.update(OWNER_ID, created.id, { goal: 'not authorization' } as never);
    assert.equal(await read(), 0n);

    await service.update(OWNER_ID, created.id, { maxConcurrentTasks: 7 } as never);
    assert.equal(await read(), 1n);

    // Four fields in one write is one version of the set, not four.
    await service.update(OWNER_ID, created.id, {
      coordinatorEnabled: false,
      automationPolicy: 'AUTO',
      maxConcurrentTasks: 2,
      sessionBudgetPerDay: 25,
    } as never);
    assert.equal(await read(), 2n);

    const row = await prisma.project.findUnique({ where: { id: created.id } });
    assert.equal(row.automationPolicy, 'AUTO');
    assert.equal(row.maxConcurrentTasks, 2);
    assert.equal(row.sessionBudgetPerDay, 25);
    assert.equal(row.coordinatorEnabled, false);
  } finally {
    await teardown();
  }
});

test('a coordinator is set, replaced and cleared as one row', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 agent' } as never);

    await service.update(OWNER_ID, created.id, { coordinatorAgentId: AGENT_A } as never);
    const first = await prisma.projectMember.findMany({ where: { projectId: created.id } });
    assert.equal(first.length, 1);

    const replaced: any = await service.update(OWNER_ID, created.id, {
      coordinatorAgentId: AGENT_B,
    } as never);
    const second = await prisma.projectMember.findMany({ where: { projectId: created.id } });
    assert.equal(second.length, 1);
    // The same row, edited: identity changing hands is one write, and the project is never briefly
    // uncoordinated.
    assert.equal(second[0].id, first[0].id);
    assert.equal(second[0].agentId, AGENT_B);
    assert.equal(replaced.coordinatorAgentId, AGENT_B);

    await service.update(OWNER_ID, created.id, { coordinatorAgentId: null } as never);
    assert.equal(await prisma.projectMember.count({ where: { projectId: created.id } }), 0);

    // And the agents themselves are untouched by any of it.
    assert.equal(await prisma.workspace.count({ where: { ownerId: OWNER_ID } }), 2);
  } finally {
    await teardown();
  }
});

test('the service records where every coordinator identity came from, in the same transaction', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    // Recorded FROM a session: the agent seated is the one whose session recorded the project, so
    // nobody chose it and the database must stay able to correct it if the landing moves later
    // (migration 0113, validation 04R). What the insert adds is the baseline: the landing this
    // identity was derived from, without which a later relocation cannot be told apart from an
    // owner's explicit choice (migration 0114, validation 04R2).
    await prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT_A,
        title: 'recording session',
        prompt: 'x',
      },
    });
    const derived: any = await service.create(OWNER_ID, { title: 'pcc03c derived' } as never, {
      sessionId: SESSION_OLD,
      workspaceId: AGENT_A,
    });
    const derivedRuntime = await prisma.projectRuntime.findUnique({
      where: { projectId: derived.id },
    });
    assert.equal(derived.coordinatorAgentId, AGENT_A);
    assert.equal(derivedRuntime.coordinatorIdentitySource, 'DERIVED');
    assert.equal(derivedRuntime.coordinatorIdentityLandingId, AGENT_A);

    // Setting, replacing and clearing `coordinatorAgentId` are all the owner deciding WHO, and all
    // three say so. The third is the one that cannot be recovered from the rows afterwards: the
    // membership is gone, so without this the next landing event would seat one.
    const source = async (projectId: string) =>
      (await prisma.projectRuntime.findUnique({ where: { projectId } })).coordinatorIdentitySource;

    await service.update(OWNER_ID, derived.id, { coordinatorAgentId: AGENT_B } as never);
    assert.equal(await source(derived.id), 'EXPLICIT');
    const replaced = await prisma.projectRuntime.findUnique({ where: { projectId: derived.id } });
    assert.equal(replaced.coordinatorIdentityLandingId, null, 'and claims no derivation alongside');

    await service.update(OWNER_ID, derived.id, { coordinatorAgentId: null } as never);
    assert.equal(await source(derived.id), 'EXPLICIT', 'having no coordinator is a choice');
    assert.equal(await prisma.projectMember.count({ where: { projectId: derived.id } }), 0);

    // Naming the agent that is ALREADY coordinating changes no row, and is still a decision —
    // the one case the database cannot recognise structurally, because a seat that equals the
    // landing is exactly what a derivation looks like.
    const plain: any = await service.create(OWNER_ID, { title: 'pcc03c plain' } as never);
    assert.equal(await source(plain.id), 'DERIVED');
    await prisma.project.update({
      where: { id: plain.id },
      data: { coordinatorWorkspaceId: AGENT_A },
    });
    assert.equal(
      (await prisma.projectMember.findFirst({ where: { projectId: plain.id } })).agentId,
      AGENT_A,
      'the database derived one from the landing',
    );
    await service.update(OWNER_ID, plain.id, { coordinatorAgentId: AGENT_A } as never);
    assert.equal(await source(plain.id), 'EXPLICIT');
  } finally {
    await teardown();
  }
});

test('an agent that still coordinates a project cannot be deleted', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 restrict' } as never);
    await service.update(OWNER_ID, created.id, { coordinatorAgentId: AGENT_A } as never);

    // Orbit soft-deletes agents, so this is not a path the product takes today — it is the
    // guarantee that a hard delete cannot disband a team behind the owner's back.
    await assert.rejects(
      () => prisma.workspace.delete({ where: { id: AGENT_A } }),
      (e: any) => e.code === 'P2003' || /Foreign key constraint/.test(String(e.message)),
    );
  } finally {
    await teardown();
  }
});

test('replacing the coordinator session counts a rotation and keeps the old conversation', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 rotate' } as never);
    // A coordinator that was opened and then put in Trash: the case the control loop's rotation
    // has to answer, and the one the user reaches by deleting the conversation.
    await prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT_A,
        title: 'first coordinator',
        prompt: 'x',
        deletedAt: new Date(),
      },
    });
    await prisma.project.update({
      where: { id: created.id },
      data: { coordinatorSessionId: SESSION_OLD, coordinatorWorkspaceId: AGENT_A },
    });
    await service.update(OWNER_ID, created.id, { coordinatorAgentId: AGENT_A } as never);

    const result = await service.coordinator(OWNER_ID, created.id);

    assert.equal(result.created, true);
    assert.equal(result.sessionId, SESSION_NEW);
    const after = await prisma.project.findUnique({
      where: { id: created.id },
      include: { runtime: true, members: true },
    });
    // The count moved, in the same transaction as the swap that moved the pointer.
    assert.equal(after.coordinatorSessionId, SESSION_NEW);
    assert.equal(after.runtime.coordinatorGeneration, 1n);
    // The identity did not: that is the whole distinction between a coordinator and its session.
    assert.equal(after.members[0].agentId, AGENT_A);
    // Nor did the replaced conversation go anywhere — it is still there to be read.
    const old = await prisma.session.findUnique({ where: { id: SESSION_OLD } });
    assert.equal(old.title, 'first coordinator');
    // ...and the landing place is unchanged: rotation is not a migration.
    assert.equal(after.coordinatorWorkspaceId, AGENT_A);
  } finally {
    await teardown();
  }
});

test('turning automation on without saying how far writes nothing at all', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 g3' } as never);
    await service.update(OWNER_ID, created.id, {
      coordinatorEnabled: false,
      automationPolicy: 'MANUAL',
    } as never);
    const before = await prisma.project.findUnique({ where: { id: created.id } });

    await assert.rejects(
      () => service.update(OWNER_ID, created.id, { coordinatorEnabled: true } as never),
      (e: any) => e.status === 400,
    );

    const after = await prisma.project.findUnique({ where: { id: created.id } });
    assert.equal(after.coordinatorEnabled, false);
    // Refused before the transaction, so not even the revision moved.
    assert.equal(after.configRevision, before.configRevision);
  } finally {
    await teardown();
  }
});

// ── Moving a coordination workspace (`rebindCoordinator`) ──────────────────────────────────────
//
// The rules the unit spec cannot state, because every one of them is enforced by a trigger rather
// than by the service: the pointer guard that makes the landing and the pointer one decision, the
// reconciliation that carries a DERIVED identity with its landing and leaves an EXPLICIT one, and
// the rotation counter that must NOT advance for a conversation nobody opened.

test('rebinding a landing clears the pointer, spends no rotation, and takes a derived identity with it', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    await prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT_A,
        title: 'first coordinator',
        prompt: 'x',
      },
    });
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 rebind' } as never, {
      sessionId: SESSION_OLD,
      workspaceId: AGENT_A,
    });
    // Ended, so this is a move rather than the refusal below. Written after the binding because a
    // project is recorded from a conversation somebody is having.
    await prisma.session.update({ where: { id: SESSION_OLD }, data: { status: 'SUCCEEDED' } });

    const result = await service.rebindCoordinator(OWNER_ID, created.id, AGENT_B);

    assert.equal(result.moved, true);
    assert.equal(result.coordinatorWorkspaceId, AGENT_B);
    assert.equal(result.coordinatorSessionId, null);
    assert.deepEqual(result.unbound, { sessionId: SESSION_OLD, workspaceId: AGENT_A });

    const after = await prisma.project.findUnique({
      where: { id: created.id },
      include: { runtime: true, members: true },
    });
    assert.equal(after.coordinatorWorkspaceId, AGENT_B);
    // Not tidiness: `project_coordinator_pointer_guard` refuses a project whose coordinator session
    // runs anywhere but its coordination workspace, so a landing that moved while a pointer stayed
    // is a row this database will not hold.
    assert.equal(after.coordinatorSessionId, null);
    // A cleared pointer is "a project waiting for its next run", not a rotation: no generation is
    // spent on a conversation that was never opened.
    assert.equal(after.runtime.coordinatorGeneration, 0n);
    // WHO followed WHERE because nobody had chosen WHO — the database's rule, stated once, for
    // every writer that moves this column.
    assert.equal(after.members.length, 1);
    assert.equal(after.members[0].agentId, AGENT_B);
    assert.equal(after.runtime.coordinatorIdentitySource, 'DERIVED');
    assert.equal(after.runtime.coordinatorIdentityLandingId, AGENT_B);
    // And the conversation is where it always was. Detached is not deleted.
    const old = await prisma.session.findUnique({ where: { id: SESSION_OLD } });
    assert.equal(old.title, 'first coordinator');
    assert.equal(old.workspaceId, AGENT_A);
    assert.equal(old.deletedAt, null);
  } finally {
    await teardown();
  }
});

test('a coordinator identity somebody chose does not move with the landing', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 rebind explicit' } as never);
    // The owner deciding WHO, which is what makes the seat EXPLICIT.
    await service.update(OWNER_ID, created.id, { coordinatorAgentId: AGENT_A } as never);
    await prisma.project.update({
      where: { id: created.id },
      data: { coordinatorWorkspaceId: AGENT_A },
    });

    await service.rebindCoordinator(OWNER_ID, created.id, AGENT_B);

    const after = await prisma.project.findUnique({
      where: { id: created.id },
      include: { runtime: true, members: true },
    });
    assert.equal(after.coordinatorWorkspaceId, AGENT_B, 'WHERE moved');
    // PAC R3: WHO is not inferred from WHERE, in either direction. An owner who means to move both
    // sends `coordinatorAgentId` as well, and gets to see that it was two decisions.
    assert.equal(after.members[0].agentId, AGENT_A, 'and WHO did not');
    assert.equal(after.runtime.coordinatorIdentitySource, 'EXPLICIT');
  } finally {
    await teardown();
  }
});

test('a coordinator somebody is still in is not moved out from under, and rebinding where it already is is not refused by it', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    await prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT_A,
        title: 'live coordinator',
        prompt: 'x',
        status: 'RUNNING',
      },
    });
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 rebind live' } as never, {
      sessionId: SESSION_OLD,
      workspaceId: AGENT_A,
    });

    await assert.rejects(
      () => service.rebindCoordinator(OWNER_ID, created.id, AGENT_B),
      (e: any) => e.status === 409 && e.getResponse().code === 'COORDINATOR_SESSION_LIVE',
    );

    const after = await prisma.project.findUnique({ where: { id: created.id } });
    assert.equal(after.coordinatorWorkspaceId, AGENT_A, 'refused AND rolled back');
    assert.equal(after.coordinatorSessionId, SESSION_OLD);

    // The same project, the same live conversation, asked to stay where it is: a retry of a rebind
    // that already landed must not be reported as a refusal.
    const again = await service.rebindCoordinator(OWNER_ID, created.id, AGENT_A);
    assert.equal(again.moved, false);
    assert.equal(again.coordinatorSessionId, SESSION_OLD, 'and its coordinator is still bound');
  } finally {
    await teardown();
  }
});

test('a landing that is not a live agent of this account is refused before anything moves', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const { prisma, service, teardown } = await open();
  try {
    const created: any = await service.create(OWNER_ID, { title: 'pcc03 rebind dead' } as never);
    await prisma.project.update({
      where: { id: created.id },
      data: { coordinatorWorkspaceId: AGENT_A },
    });
    // Agents are SOFT-deleted, so the foreign key would have accepted this one — which is the whole
    // reason the check is a query rather than a constraint.
    await prisma.workspace.update({ where: { id: AGENT_B }, data: { deletedAt: new Date() } });

    await assert.rejects(
      () => service.rebindCoordinator(OWNER_ID, created.id, AGENT_B),
      (e: any) => e.status === 400,
    );
    assert.equal(
      (await prisma.project.findUnique({ where: { id: created.id } })).coordinatorWorkspaceId,
      AGENT_A,
    );
  } finally {
    await teardown();
  }
});
