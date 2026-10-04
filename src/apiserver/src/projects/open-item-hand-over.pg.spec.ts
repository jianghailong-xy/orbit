import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  OPEN_ITEM_HAND_OVER_NOTE_REQUIRED,
  OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG,
  OPEN_ITEM_HAND_OVER_RACE,
  OPEN_ITEM_NOT_COORDINATOR_ITEM,
  OPEN_ITEM_NOT_OPEN,
  OPEN_ITEM_COORDINATOR_ONLY,
  ProjectOpenItemService,
} from './project-open-item.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * The deliberate coordinator-to-owner edge (§4.7), including every refusal before its CAS and the
 * durable history/read-model side of the successful edge.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/open-item-hand-over.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
async function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

interface Harness {
  db: PrismaClient;
  openItems: ProjectOpenItemService;
  pushes: string[];
}

async function connect(): Promise<Harness> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!) as unknown as PrismaClient;
  const pushes: string[] = [];
  const push = { notifyOwnerItem: async (itemId: string) => { pushes.push(itemId); } };
  const openItems = new ProjectOpenItemService(
    db as unknown as PrismaService,
    undefined as never,
    push as never,
  );
  return { db, openItems, pushes };
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@hand-over.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/${label}/${projectId}.git`,
      workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'hand over only deliberate coordinator exceptions',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

async function item(
  db: PrismaClient,
  w: World,
  options: {
    kind?: string;
    state?: string;
    assignee?: string;
    assigneeReason?: string;
    resolved?: boolean;
  } = {},
): Promise<string> {
  const now = new Date();
  const resolved = options.resolved ?? options.state === 'RESOLVED';
  const row = await db.projectOpenItem.create({
    data: {
      projectId: w.projectId,
      ownerId: w.ownerId,
      kind: options.kind ?? 'TASK_FAILED',
      state: options.state ?? 'OPEN',
      assignee: options.assignee ?? 'COORDINATOR',
      assigneeReason: options.assigneeReason ?? 'DEFAULT',
      dedupeKey: `hand-over:${randomUUID()}`,
      title: 'Task failed: hand-over fixture',
      payload: { chain: { failuresInChain: 1, limit: 3 } },
      waitingSince: now,
      assignedAt: now,
      escalateAt: options.assignee === 'OWNER' ? null : new Date(now.getTime() + 60_000),
      escalatedAt: options.assignee === 'OWNER' ? now : null,
      ...(resolved
        ? {
            resolution: 'HANDLED',
            resolvedAt: now,
            resolvedBy: 'COORDINATOR',
            resolvedBySessionId: w.coordinatorSessionId,
          }
        : {}),
    } as never,
    select: { id: true },
  });
  return row.id;
}

async function refusal(run: () => Promise<unknown>): Promise<{ status: number; code?: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `expected an HTTP refusal, got ${thrown}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? {} : body as { code?: string };
  return { status: thrown.getStatus(), code: shaped.code };
}

test('open_item_hand_over rejects closed, owner-assigned, wrong-session, blank and oversized notes',
  { skip }, async () => {
    const h = await connect();
    const w = await world(h.db, 'refusals');
    const closed = await item(h.db, w, { state: 'RESOLVED', resolved: true });
    const ownerItem = await item(h.db, w, { assignee: 'OWNER', assigneeReason: 'ESCALATED' });
    const itemWithoutDoor = await item(h.db, w, { kind: 'DELIVERY_REVIEW' });
    const wrongSession = await item(h.db, w);
    const blank = await item(h.db, w);
    const long = await item(h.db, w);

    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, closed, { note: 'already ended' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    )), { status: 409, code: OPEN_ITEM_NOT_OPEN });
    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, ownerItem, { note: 'not mine to move' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    )), { status: 409, code: OPEN_ITEM_NOT_COORDINATOR_ITEM });
    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, itemWithoutDoor, { note: 'there is no resolving door' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    )), { status: 409, code: OPEN_ITEM_NOT_COORDINATOR_ITEM });
    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, wrongSession, { note: 'wrong conversation' },
      { kind: 'SESSION', sessionId: randomUUID() },
    )), { status: 403, code: OPEN_ITEM_COORDINATOR_ONLY });
    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, blank, { note: ' \n\t ' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    )), { status: 400, code: OPEN_ITEM_HAND_OVER_NOTE_REQUIRED });
    assert.deepEqual(await refusal(() => h.openItems.handOver(
      w.ownerId, w.projectId, long, { note: 'x'.repeat(2_001) },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    )), { status: 400, code: OPEN_ITEM_HAND_OVER_NOTE_TOO_LONG });
  });

test('open_item_hand_over CAS loser is explicit and writes no owner history', { skip }, async () => {
  const h = await connect();
  const w = await world(h.db, 'race');
  const id = await item(h.db, w);
  const fake = new Proxy(h.db as unknown as PrismaService, {
    get(target, property, receiver) {
      if (property === '$queryRaw') return async () => [];
      return Reflect.get(target, property, receiver);
    },
  });
  const racing = new ProjectOpenItemService(fake, undefined as never, {
    notifyOwnerItem: async () => undefined,
  } as never);
  assert.deepEqual(await refusal(() => racing.handOver(
    w.ownerId, w.projectId, id, { note: 'lost the row race' },
    { kind: 'SESSION', sessionId: w.coordinatorSessionId },
  )), { status: 409, code: OPEN_ITEM_HAND_OVER_RACE });
  const row = await h.db.projectOpenItem.findUniqueOrThrow({ where: { id } });
  assert.equal(row.assignee, 'COORDINATOR');
  assert.equal(row.handoverNote, null);
});

test('open_item_hand_over assigns OWNER/HANDED_OVER, pushes after commit, and lists its note',
  { skip }, async () => {
    const h = await connect();
    const w = await world(h.db, 'success');
    const id = await item(h.db, w);
    const note = 'the coordinator cannot settle this safely; the owner should decide';
    const result = await h.openItems.handOver(
      w.ownerId, w.projectId, id, { note: `  ${note}  ` },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    );
    assert.equal(result.itemId, id);
    assert.equal(result.assignee, 'OWNER');
    assert.equal(result.assigneeReason, 'HANDED_OVER');
    assert.equal(result.handoverNote, note);
    assert.equal(result.handedOverBySessionId, w.coordinatorSessionId);
    assert.deepEqual(h.pushes, [id]);

    const row = await h.db.projectOpenItem.findUniqueOrThrow({ where: { id } });
    assert.equal(row.assignee, 'OWNER');
    assert.equal(row.assigneeReason, 'HANDED_OVER');
    assert.equal(row.handoverNote, note);
    assert.ok(row.handedOverAt);
    assert.equal(row.handedOverBySessionId, w.coordinatorSessionId);
    assert.equal(row.escalateAt, null);

    const view = await h.openItems.list(w.ownerId, w.projectId);
    const listed = view.needsYou.find((candidate) => candidate.itemId === id);
    assert.ok(listed, 'the handed-over item should be in the owner read model');
    assert.equal(listed.handoverNote, note);
    assert.equal(listed.assigneeReason, 'HANDED_OVER');
  });
