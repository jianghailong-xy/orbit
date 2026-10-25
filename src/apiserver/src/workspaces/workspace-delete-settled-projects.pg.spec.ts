/**
 * Deleting a workspace that coordinated projects which have since settled.
 *
 * `WorkspacesService.remove` used to count every `project_member` row naming the workspace, so one
 * that had ever coordinated a project — DONE or CANCELLED long ago — could never be deleted. Now only
 * an OPEN project holds it back, or a project whose owner CHOSE it as the coordinator (migration 0114
 * fails closed on a chosen coordinator that is no longer a live agent, so that choice is changed
 * first). The coordinator conversations that ran in the deleted workspace end with it.
 *
 * A settled project can come back (a reopened criterion task, an edited criterion, its owner). The
 * last case below walks that road on real rows: the project reopens, its coordinator conversation
 * reads as completed, a new one is refused as unavailable (its workspace is gone), and the project
 * rebinds to a live workspace once the old conversation is deleted — the existing route for a
 * coordinator whose workspace is gone — with the seat following the landing, which is the trigger
 * path a deleted seat must not break.
 *
 * WHY REAL POSTGRESQL: the rule is a relation filter on `project` and `project_runtime`, and the
 * rebind runs through migration 0114's deferred trigger. A Prisma double answers whatever it was
 * built to say about both.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/workspaces/workspace-delete-settled-projects.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { ProjectIdentitySource, ProjectRole, ProjectStatus, type PrismaClient } from '@prisma/client';
import { SessionLifecycleState } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import {
  COORDINATOR_SESSION_LIVE_CODE,
  COORDINATOR_UNAVAILABLE_CODE,
  ProjectsService,
} from '../projects/projects.service';
import type { SessionsService } from '../sessions/sessions.service';
import { WorkspacesService } from './workspaces.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface World {
  prisma: PrismaClient;
  projects: ProjectsService;
  workspaces: WorkspacesService;
  ownerId: string;
  /** The workspace being deleted, which coordinates the project. */
  coordinatorHome: string;
  /** Another live workspace of the same owner. */
  elsewhere: string;
  projectId: string;
  coordinatorSessionId: string;
  /** The coordinator conversations the delete ended, in order. */
  ended: string[];
}

async function world(
  t: { after(fn: () => unknown): void },
  settle: ProjectStatus,
  identity: ProjectIdentitySource = ProjectIdentitySource.DERIVED,
): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `ws-delete-${ownerId}@settled.invalid`, name: 'owner', passwordHash: 'x' },
  });
  const coordinatorHome = (await prisma.workspace.create({ data: { ownerId, name: 'retired' } })).id;
  const elsewhere = (await prisma.workspace.create({ data: { ownerId, name: 'in use' } })).id;
  const coordinatorSessionId = (
    await prisma.session.create({
      data: {
        ownerId,
        creatorId: ownerId,
        workspaceId: coordinatorHome,
        title: 'the coordinator',
        prompt: 'coordinate',
      },
    })
  ).id;
  // As `ProjectsService.create` records a project planned in a session: the conversation, its
  // landing and the identity behind it, in one insert.
  const projectId = (
    await prisma.project.create({
      data: {
        ownerId,
        title: `coordinated from the workspace about to go (${settle})`,
        coordinatorSessionId,
        coordinatorWorkspaceId: coordinatorHome,
        members: { create: { agentId: coordinatorHome, role: ProjectRole.COORDINATOR } },
        runtime: {
          create: { coordinatorIdentityLandingId: coordinatorHome, coordinatorIdentitySource: identity },
        },
      },
    })
  ).id;

  const projects = new ProjectsService(
    prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService),
  );
  // Settled through the owner's own door, the way a project is settled by hand.
  if (settle !== ProjectStatus.OPEN) await projects.update(ownerId, projectId, { status: settle } as never);

  // Ends a conversation the way the Complete button's method leaves the row.
  const ended: string[] = [];
  const sessions = {
    complete: async (owner: string, id: string) => {
      assert.equal(owner, ownerId);
      const now = new Date();
      await prisma.session.update({ where: { id }, data: { completedAt: now, archivedAt: now } });
      ended.push(id);
      return { ok: true };
    },
  } as unknown as SessionsService;
  const workspaces = new WorkspacesService(prisma as unknown as PrismaService, sessions);

  return { prisma, projects, workspaces, ownerId, coordinatorHome, elsewhere, projectId, coordinatorSessionId, ended };
}

async function deletedAt(w: World, id: string) {
  return (await w.prisma.workspace.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } })).deletedAt;
}

test('an open project still holds its coordinator’s workspace back', { skip }, async (t) => {
  const w = await world(t, ProjectStatus.OPEN);

  await assert.rejects(w.workspaces.remove(w.ownerId, w.coordinatorHome), ConflictException);
  assert.equal(await deletedAt(w, w.coordinatorHome), null);
  assert.deepEqual(w.ended, []);
});

test('a cancelled project no longer does, and its coordinator ends with the workspace', { skip }, async (t) => {
  const w = await world(t, ProjectStatus.CANCELLED);

  assert.deepEqual(await w.workspaces.remove(w.ownerId, w.coordinatorHome), { ok: true });
  assert.ok((await deletedAt(w, w.coordinatorHome)) instanceof Date);
  assert.deepEqual(w.ended, [w.coordinatorSessionId]);
});

test('a project whose owner chose this coordinator holds it back even when done', { skip }, async (t) => {
  const w = await world(t, ProjectStatus.DONE, ProjectIdentitySource.EXPLICIT);

  await assert.rejects(w.workspaces.remove(w.ownerId, w.coordinatorHome), ConflictException);
  assert.equal(await deletedAt(w, w.coordinatorHome), null);
  assert.deepEqual(w.ended, []);
});

test('a done project lets its coordinator’s workspace go, and when it reopens it is rebound', { skip }, async (t) => {
  const w = await world(t, ProjectStatus.DONE);

  assert.deepEqual(await w.workspaces.remove(w.ownerId, w.coordinatorHome), { ok: true });
  assert.ok((await deletedAt(w, w.coordinatorHome)) instanceof Date);
  assert.deepEqual(w.ended, [w.coordinatorSessionId]);

  // It comes back.
  await w.projects.update(w.ownerId, w.projectId, { status: ProjectStatus.OPEN } as never);

  // Its card draws the coordinator conversation as completed, and offers the next one. That press
  // (`replace`) is refused as unavailable — the workspace it would open in is gone — which is what
  // puts the rebind in front of the owner.
  const status = await w.projects.coordinatorStatus(w.ownerId, w.projectId);
  assert.equal(status.coordination.session?.lifecycleState, SessionLifecycleState.COMPLETED);
  await assert.rejects(
    w.projects.coordinator(w.ownerId, w.projectId, undefined, 'replace'),
    (error: unknown) =>
      error instanceof ConflictException
      && (error.getResponse() as { code?: string }).code === COORDINATOR_UNAVAILABLE_CODE,
  );

  // The rebind is the existing route for a coordinator whose workspace is gone, and it asks first
  // for the old conversation to go: the project still points at it, and 0126's pointer guard will
  // not let a project name one place and be coordinated from another.
  await assert.rejects(
    w.projects.rebindCoordinator(w.ownerId, w.projectId, w.elsewhere),
    (error: unknown) =>
      error instanceof ConflictException
      && (error.getResponse() as { code?: string }).code === COORDINATOR_SESSION_LIVE_CODE,
  );
  // Deleted permanently, as its required action says (the FK sets the pointer NULL).
  await w.prisma.session.delete({ where: { id: w.coordinatorSessionId } });

  // Now the rebind commits, and the seat follows the landing (0114's DERIVED branch) instead of
  // failing on the deleted one.
  const rebound = await w.projects.rebindCoordinator(w.ownerId, w.projectId, w.elsewhere);
  assert.equal(rebound.coordinatorWorkspaceId, w.elsewhere);
  const seats = await w.prisma.projectMember.findMany({
    where: { projectId: w.projectId, role: ProjectRole.COORDINATOR },
    select: { agentId: true },
  });
  assert.deepEqual(seats, [{ agentId: w.elsewhere }]);
});
