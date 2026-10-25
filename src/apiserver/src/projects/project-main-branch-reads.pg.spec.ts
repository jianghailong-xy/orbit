/**
 * A project's main branch by name on the reads whose words say "main" (`mainBranch`): the binding's
 * `upstream_ref` without `refs/heads/`, and null where the project has no repository bound — the
 * words then say main (`docs/project-integration-line-contract.md` L6; project
 * 34cjQN5ynG6eIH5A0neeu, criterion 4).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-main-branch-reads.pg.spec.ts
 *
 * One account, two projects: one bound to a repository whose main branch is master, one with no
 * binding at all. Each read is asked through the service method its route returns:
 *
 *   (1) GET /tasks/:id/owner-confirmation (`TaskOwnerConfirmationService.read`): `ifConfirmed`'s
 *       main branch, for a run waiting on the owner — and null for a task in no project;
 *   (2) GET /projects (`ProjectsService.list`) and GET /projects/sidebar (`listSidebar`): each row's;
 *   (3) GET /sessions (`SessionsService.list`): each owner item's on its coordinator's row;
 *   (4) GET /tasks/:id (`TasksService.get`): `integration`'s — and null for a task in no project —
 *       and the project's task rows (`ProjectsService.taskPage`), from the same read model;
 *   (5) GET /projects/:id/open-items (`ProjectOpenItemService.list`): the read's.
 *
 * The field is read through `MainBranch` rather than off the shared types, so this file compiles on
 * the tree before the change too, and each case there fails on the assertion that names what is
 * missing instead of the whole build failing on a type.
 *
 * Not destructive: every case owns freshly generated ids.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunEventType, uuidToBase62 } from '@orbit/shared';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  type PrismaClient,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Whatever carries the field, read without the shared types (see the header). */
type MainBranch = { mainBranch?: string | null };
const mainBranchOf = (carrier: unknown): string | null | undefined => (carrier as MainBranch | null)?.mainBranch;

test('the reads whose words say "main" name the project’s main branch, and null with no repository',
  { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
    const url = URL!;
    assertCoordinatorPgUrlIsIsolated(url);
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db: PrismaClient = prismaClientFor(url);
    t.after(async () => {
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });

    // The production wiring over one client; only the publish and the queue nudge are inert.
    const prisma = db as unknown as PrismaService;
    const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
    const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
    const sessions = new SessionsService(prisma, queue, realtime);
    const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma, sessions), sessions);
    const openItems = new ProjectOpenItemService(prisma, sessions);
    const tasks = new TasksService(prisma, sessions, realtime);
    const confirmations = new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime);

    // ── one account ──────────────────────────────────────────────────────────────────────────────
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `reads-${ownerId}@main-branch-reads.invalid`, name: 'reads', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'reads-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
        capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: 'reads-workspace', enabled: true },
    });

    /** A conversation of this account, parked between turns unless `taskId` makes it a task's run. */
    async function conversation(label: string, taskId: string | null = null): Promise<string> {
      const id = randomUUID();
      await db.session.create({
        data: {
          id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, taskId,
          title: label, prompt: label, provider: 'claude', status: RunStatus.AWAITING_INPUT,
          dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), startsTaskWork: taskId !== null,
        },
      });
      return id;
    }

    /**
     * A started project coordinated from a conversation of its own, holding one merge approval for
     * the owner — and bound to a repository whose main branch is `upstream`, or to none.
     */
    async function project(label: string, upstream: string | null) {
      const projectId = randomUUID();
      const coordinatorSessionId = await conversation(`coordinating ${label}`);
      await db.project.create({
        data: {
          id: projectId, ownerId, title: `${label} project`, startedAt: new Date(),
          coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
        },
      });
      if (upstream) {
        await db.projectCodebase.create({
          data: {
            ownerId, projectId, canonicalRepoUrl: `https://github.com/example/reads-${projectId}`,
            upstreamRef: `refs/heads/${upstream}`,
            integrationRef: `refs/heads/project/${uuidToBase62(projectId)}`,
            integrationRefSource: 'EXPLICIT', integrationStartedAt: new Date(), refAuthority: 'REMOTE',
          },
        });
      }
      const now = new Date();
      await db.projectOpenItem.create({
        data: {
          projectId, ownerId, kind: 'PROMOTION_APPROVAL', state: 'OPEN', assignee: 'OWNER',
          assigneeReason: 'DEFAULT', dedupeKey: `reads:${projectId}`, title: 'Approve merge to main',
          payload: {}, waitingSince: now, assignedAt: now,
        },
      });
      return { projectId, coordinatorSessionId };
    }

    /** An OWNER_CONFIRMED task whose run declared its work finished and is waiting on the owner. */
    async function waitingOnTheOwner(projectId: string | null, label: string): Promise<string> {
      const taskId = randomUUID();
      await db.task.create({
        data: {
          id: taskId, ownerId, projectId, assigneeId: workspaceId, title: label, provider: 'claude',
          creatorType: CreatorType.USER, creatorId: ownerId, completionCriterion: 'OWNER_CONFIRMED',
          status: TaskStatus.IN_PROGRESS, autoRunWhenReady: false, dispatchHold: false,
        },
      });
      const sessionId = await conversation(`run of ${label}`, taskId);
      const turnId = randomUUID();
      await db.runEvent.create({
        data: { sessionId, seq: 1, type: RunEventType.ASSISTANT, payload: { text: 'Done.' }, turnId },
      });
      const claim = await db.taskOwnerConfirmationClaim.create({
        data: { taskId, ownerId, sessionId, turnId },
        select: { id: true },
      });
      await db.taskOwnerConfirmationRequest.create({
        data: { taskId, ownerId, sessionId, turnId, claimId: claim.id },
      });
      return taskId;
    }

    const master = await project('master', 'master');
    const unbound = await project('unbound', null);
    const tasksIn = {
      master: await waitingOnTheOwner(master.projectId, 'a task on master'),
      unbound: await waitingOnTheOwner(unbound.projectId, 'a task with no repository'),
      nowhere: await waitingOnTheOwner(null, 'a task in no project'),
    };

    await t.test('(1) the owner-confirmation card names the main branch its rows say main of', async () => {
      const card = async (taskId: string) => {
        const read = await confirmations.read(ownerId, taskId);
        assert.ok(read.waiting, 'CONTROL: a run is waiting on the owner');
        assert.ok(read.ifConfirmed, 'CONTROL: a waiting card says what confirming sets off');
        return read.ifConfirmed;
      };
      assert.equal(mainBranchOf(await card(tasksIn.master)), 'master');
      assert.equal(mainBranchOf(await card(tasksIn.unbound)), null, 'no repository bound: null, read as main');
      assert.equal(mainBranchOf(await card(tasksIn.nowhere)), null, 'a task in no project: null, read as main');
    });

    await t.test('(2) the projects list and the sidebar name each project’s main branch', async () => {
      for (const [read, rows] of [
        ['GET /projects', await projects.list(ownerId)],
        ['GET /projects/sidebar', await projects.listSidebar(ownerId)],
      ] as const) {
        const row = (projectId: string) => {
          const found = (rows as Array<{ id: string }>).find((each) => each.id === projectId);
          assert.ok(found, `CONTROL: ${read} lists the project`);
          return found;
        };
        assert.equal(mainBranchOf(row(master.projectId)), 'master', read);
        assert.equal(mainBranchOf(row(unbound.projectId)), null, `${read}: no repository bound`);
      }
    });

    await t.test('(3) an owner item on a coordinator’s session row names its project’s main branch', async () => {
      const rows = await sessions.list(ownerId, { view: 'open' }) as unknown as Array<{
        id: string;
        ownerItems: Array<{ kind: string } & MainBranch>;
      }>;
      const items = (sessionId: string) => {
        const row = rows.find((each) => each.id === sessionId);
        assert.ok(row, 'CONTROL: the coordinator conversation is in the Open list');
        assert.deepEqual(row.ownerItems.map((item) => item.kind), ['PROMOTION_APPROVAL'],
          'CONTROL: the row carries the merge approval');
        return row.ownerItems;
      };
      assert.equal(mainBranchOf(items(master.coordinatorSessionId)[0]), 'master');
      assert.equal(mainBranchOf(items(unbound.coordinatorSessionId)[0]), null, 'no repository bound');
    });

    await t.test('(4) a task’s page and its project’s task rows name the main branch its landing is on', async () => {
      const integration = async (taskId: string) => (await tasks.get(ownerId, taskId)).integration;
      assert.equal(mainBranchOf(await integration(tasksIn.master)), 'master');
      assert.equal(mainBranchOf(await integration(tasksIn.unbound)), null, 'no repository bound');
      assert.equal(mainBranchOf(await integration(tasksIn.nowhere)), null, 'a task in no project');
      // The same read model the project's task rows are drawn from (`readTaskIntegrationViews`).
      const row = async (projectId: string, taskId: string) => {
        const found = (await projects.taskPage(ownerId, projectId)).items.find((item) => item.id === taskId);
        assert.ok(found, 'CONTROL: the task is on its project’s page');
        return found.integration;
      };
      assert.equal(mainBranchOf(await row(master.projectId, tasksIn.master)), 'master');
      assert.equal(mainBranchOf(await row(unbound.projectId, tasksIn.unbound)), null, 'no repository bound');
    });

    await t.test('(5) the open items name the main branch a merge into main goes into', async () => {
      const listed = await openItems.list(ownerId, master.projectId);
      assert.deepEqual(listed.needsYou.map((row) => row.kind), ['PROMOTION_APPROVAL'],
        'CONTROL: the merge approval is the owner’s');
      assert.equal(mainBranchOf(listed), 'master');
      assert.equal(mainBranchOf(await openItems.list(ownerId, unbound.projectId)), null, 'no repository bound');
    });
  });
