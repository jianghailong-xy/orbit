import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * Fresh validation 04R counterexamples for the database companions introduced by 0112.
 *
 * These cases intentionally use the old-writer shape: only the project row is written.  They
 * assert the contract's final-state invariant at COMMIT, rather than merely observing that a
 * trigger fired for some earlier row image in the same transaction.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const OWNER = '00000000-0000-7000-8000-0000000004f1';
const RUNNER = '00000000-0000-7000-8000-0000000004f2';
const WORKSPACE_A = '00000000-0000-7000-8000-0000000004a1';
const WORKSPACE_B = '00000000-0000-7000-8000-0000000004b1';
const SESSION_OLD = '00000000-0000-7000-8000-0000000004c1';
const SESSION_NEW = '00000000-0000-7000-8000-0000000004c2';
const PROJECT_INSERT_DRIFT = '00000000-0000-7000-8000-0000000004d1';
const PROJECT_OLD_WRITER = '00000000-0000-7000-8000-0000000004d2';
const PROJECT_EPHEMERAL = '00000000-0000-7000-8000-0000000004d3';

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function open() {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const probe = new Ctor({ connectionString: URL });
  await probe.connect();
  await verifyCoordinatorPgIdentity(probe);

  const prisma = prismaClientFor(URL!);

  const wipe = async () => {
    await prisma.project.deleteMany({ where: { ownerId: OWNER } });
    await prisma.session.deleteMany({ where: { ownerId: OWNER } });
    await prisma.workspace.deleteMany({ where: { ownerId: OWNER } });
    await prisma.runner.deleteMany({ where: { ownerId: OWNER } });
    await prisma.user.deleteMany({ where: { id: OWNER } });
  };

  await wipe();
  await prisma.user.create({
    data: { id: OWNER, email: 'pcc04r-adversarial@example.test', name: 'pcc04r', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: { id: RUNNER, ownerId: OWNER, name: 'pcc04r runner', tokenHash: 'x' },
  });
  await prisma.workspace.createMany({
    data: [
      { id: WORKSPACE_A, ownerId: OWNER, runnerId: RUNNER, name: 'agent A' },
      { id: WORKSPACE_B, ownerId: OWNER, runnerId: RUNNER, name: 'agent B' },
    ],
  });
  await prisma.session.createMany({
    data: [
      { id: SESSION_OLD, ownerId: OWNER, creatorId: OWNER, workspaceId: WORKSPACE_A, title: 'old', prompt: 'x' },
      { id: SESSION_NEW, ownerId: OWNER, creatorId: OWNER, workspaceId: WORKSPACE_B, title: 'new', prompt: 'x' },
    ],
  });

  return {
    prisma,
    teardown: async () => {
      await wipe();
      await prisma.$disconnect();
      await probe.end();
    },
  };
}

async function oldWriterInsert(
  tx: any,
  projectId: string,
  workspaceId: string,
  sessionId: string | null,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "project"
       ("id", "title", "owner_id", "coordinator_workspace_id", "coordinator_session_id",
        "created_at", "updated_at")
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    projectId,
    `pcc04r ${projectId}`,
    OWNER,
    workspaceId,
    sessionId,
  );
}

async function finalState(prisma: any, projectId: string) {
  const [project, member, runtime] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.projectMember.findFirst({ where: { projectId, role: 'COORDINATOR' } }),
    prisma.projectRuntime.findUnique({ where: { projectId } }),
  ]);
  return { project, member, runtime };
}

test('0112 derives companions from the final project row after insert then workspace drift', { skip }, async () => {
  const f = await open();
  try {
    await f.prisma.$transaction(async (tx: any) => {
      await oldWriterInsert(tx, PROJECT_INSERT_DRIFT, WORKSPACE_A, SESSION_OLD);
      await tx.project.update({
        where: { id: PROJECT_INSERT_DRIFT },
        data: { coordinatorWorkspaceId: WORKSPACE_B, coordinatorSessionId: SESSION_NEW },
      });
    });

    const { project, member, runtime } = await finalState(f.prisma, PROJECT_INSERT_DRIFT);
    assert.equal(project.coordinatorWorkspaceId, WORKSPACE_B);
    assert.equal(member?.agentId, WORKSPACE_B, 'coordinator identity must match the final workspace');
    assert.equal(runtime?.coordinatorGeneration, 1n);
  } finally {
    await f.teardown();
  }
});

test('0110 old-writer relocation cannot leave a non-null stale identity for the new reader', { skip }, async () => {
  const f = await open();
  try {
    await oldWriterInsert(f.prisma, PROJECT_OLD_WRITER, WORKSPACE_A, SESSION_OLD);
    let before = await finalState(f.prisma, PROJECT_OLD_WRITER);
    assert.equal(before.member?.agentId, WORKSPACE_A);
    assert.equal(before.runtime?.coordinatorGeneration, 0n);

    // The 0110 writer derived both columns from the newly created session.  It knew nothing about
    // project_member or project_runtime, so 0112 is solely responsible for final consistency.
    await f.prisma.project.update({
      where: { id: PROJECT_OLD_WRITER },
      data: { coordinatorWorkspaceId: WORKSPACE_B, coordinatorSessionId: SESSION_NEW },
    });

    const after = await finalState(f.prisma, PROJECT_OLD_WRITER);
    assert.equal(after.project.coordinatorWorkspaceId, WORKSPACE_B);
    assert.equal(after.member?.agentId, WORKSPACE_B, 'new reader must not observe a stale coordinator identity');
    assert.equal(after.runtime?.coordinatorGeneration, 1n, 'old-writer rotation is counted mechanically');
  } finally {
    await f.teardown();
  }
});

test('0112 insert then delete in one transaction leaves no companion rows', { skip }, async () => {
  const f = await open();
  try {
    await f.prisma.$transaction(async (tx: any) => {
      await oldWriterInsert(tx, PROJECT_EPHEMERAL, WORKSPACE_A, null);
      await tx.project.delete({ where: { id: PROJECT_EPHEMERAL } });
    });

    assert.equal(await f.prisma.project.count({ where: { id: PROJECT_EPHEMERAL } }), 0);
    assert.equal(await f.prisma.projectMember.count({ where: { projectId: PROJECT_EPHEMERAL } }), 0);
    assert.equal(await f.prisma.projectRuntime.count({ where: { projectId: PROJECT_EPHEMERAL } }), 0);
  } finally {
    await f.teardown();
  }
});
