import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import {
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { replyTranslationsSettled } from '../sessions/reply-translation';
import { SessionsService } from '../sessions/sessions.service';
import { resetTranslationBreaker } from '../sessions/translation';
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
  // `list` asks whether the coordinator conversation can take a message, for each row's "Chat about
  // this"; these cases are about the hand-over, so it always can.
  const sessions = { receiveBlockedReasonFor: async () => null };
  const openItems = new ProjectOpenItemService(
    db as unknown as PrismaService,
    sessions as never,
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
      turnState: null,
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

test('a handed-over item\'s note is translated after hand-over, stored failed on failure, untouched with translation off',
  { skip, concurrency: 1 }, async (t) => {
    const h = await connect();
    const w = await world(h.db, 'note-translation');
    const zh = (text: string) => `ZH[${text}]`;
    const asked: string[] = [];
    let failing = false;
    const realFetch = globalThis.fetch;
    const realKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith('https://api.deepseek.com/')) return realFetch(input, init);
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const text = body.messages.find((m) => m.role === 'user')!.content;
      asked.push(text);
      if (failing) return { ok: false, status: 500, body: null } as Response;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: zh(text) } }] }) } as Response;
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = realKey;
    });
    const prefer = (translationEnabled: boolean) => h.db.user.update({
      where: { id: w.ownerId },
      data: { preferences: { translationEnabled, translationLanguage: 'zh-Hans' } },
    });
    const settle = async () => {
      // The hand-over reads the owner's languages before it queues, so the queue may be empty for a moment.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await replyTranslationsSettled();
      }
    };
    const stored = async (id: string) =>
      (await h.db.projectOpenItem.findUniqueOrThrow({ where: { id }, select: { translation: true } })).translation;
    const handOver = (id: string, note: string) => h.openItems.handOver(
      w.ownerId, w.projectId, id, { note }, { kind: 'SESSION', sessionId: w.coordinatorSessionId },
    );
    const listed = async (id: string) => {
      const row = (await h.openItems.list(w.ownerId, w.projectId)).needsYou.find((r) => r.itemId === id);
      assert.ok(row, 'the handed-over item is in needsYou');
      return row;
    };
    const note = 'The conflict is in your retry policy';

    await t.test('translated after hand-over and served as translation.handoverNote', async () => {
      await prefer(true);
      const id = await item(h.db, w);
      await handOver(id, note);
      await settle();
      assert.deepEqual(asked, [note], 'only the note is sent: a TASK_FAILED payload has no agent words');
      assert.deepEqual(await stored(id), { lang: 'zh-Hans', handoverNote: zh(note) });
      const row = await listed(id);
      assert.deepEqual(row.translation, { lang: 'zh-Hans', handoverNote: zh(note) });
      assert.equal(row.handoverNote, note, 'and the note as the coordinator wrote it beside it');
    });

    await t.test('a failed translation is stored as failed and the note served as written', async () => {
      asked.length = 0;
      failing = true;
      resetTranslationBreaker();
      const id = await item(h.db, w);
      await handOver(id, note);
      await settle();
      failing = false;
      resetTranslationBreaker();
      assert.deepEqual(await stored(id), { lang: 'zh-Hans', failed: true });
      const row = await listed(id);
      assert.deepEqual(row.translation, { lang: 'zh-Hans', failed: true });
      assert.equal(row.handoverNote, note);
      await settle();
      assert.deepEqual(await stored(id), { lang: 'zh-Hans', failed: true }, 'a read does not try it again');
    });

    await t.test('translation off: nothing is asked, stored or served; turned on, a read queues it', async () => {
      await prefer(false);
      await settle();
      asked.length = 0;
      const id = await item(h.db, w);
      await handOver(id, note);
      await settle();
      assert.deepEqual(asked, []);
      assert.equal(await stored(id), null);
      assert.equal((await listed(id)).translation, undefined);
      // Decision 1A: switched on later, reading the still-open item queues it.
      await prefer(true);
      await listed(id);
      await settle();
      assert.deepEqual((await listed(id)).translation, { lang: 'zh-Hans', handoverNote: zh(note) });
    });
  });
