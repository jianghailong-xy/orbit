/**
 * `POST /api/link-previews` over real HTTP, against a real, fully migrated PostgreSQL.
 *
 * HTTP, because two of the claims are about the WIRE: every id leaves base62 (the response is
 * matched against a UUID pattern whole, with a runtime session id and a reply quoting a uuid sitting
 * in the fixtures as bait), and the three ways an object can be out of reach answer identically.
 * PostgreSQL, because each card is the read its own page makes — the session list row's raw SQL,
 * `readProjectPanorama`'s lanes, the task page's tallies, and `wiki_entry`'s own row — and a fake
 * store could only agree with itself about any of them.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/link-previews/link-previews.pg.spec.ts
 *
 * Not destructive: every row belongs to owners this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  RunStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { LINK_PREVIEW_MAX_REFS, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readProjectPanorama } from '../projects/project-panorama';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { LinkPreviewsController } from './link-previews.controller';
import { LinkPreviewsService } from './link-previews.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** Anywhere in the body, in either case: what `PUBLIC_ID_FIELDS` exists to keep off the wire. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Json = Record<string, any>;
type Sent = { status: number; body: string; json: Json };
type Ref = { kind: 'project' | 'task' | 'session' | 'list' | 'wiki'; id: string };

const HOUR = 3_600_000;

test('link previews: five kinds of card, one answer for everything out of reach, base62 only', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
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
  const prisma = db as unknown as PrismaService;

  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const tasks = new TasksService(prisma, sessions, publishes);
  const previews = new LinkPreviewsService(prisma, sessions, tasks);

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  async function account(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@link-previews.invalid`, name: label, passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label} runner`,
        tokenHash: `link-previews-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label} workspace`, enabled: true },
    });
    return { ownerId, runnerId, workspaceId };
  }

  async function task(
    ownerId: string,
    title: string,
    extra: { status?: TaskStatus; projectId?: string; listId?: string; assigneeId?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.task.create({
      data: {
        id,
        ownerId,
        title,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: extra.status ?? TaskStatus.OPEN,
        projectId: extra.projectId,
        listId: extra.listId,
        assigneeId: extra.assigneeId,
      },
    });
    return id;
  }

  async function run(
    ownerId: string,
    taskId: string,
    status: RunStatus,
    extra: { createdAt?: Date; numTurns?: number; finishedAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: `run of ${taskId}`,
        prompt: 'do the thing',
        status,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        ...extra,
      },
    });
    return id;
  }

  const me = await account('owner');
  const stranger = await account('stranger');
  const now = Date.now();

  // A session in the middle of something: failed with a retry armed, two processes up (one of them
  // a job), parked on watches. Its engine id and its last reply both carry a uuid, and neither may
  // reach the wire.
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: me.ownerId,
      creatorId: me.ownerId,
      workspaceId: me.workspaceId,
      assignedRunnerId: me.runnerId,
      title: 'Refactor the importer',
      prompt: 'refactor the importer',
      provider: 'claude',
      model: 'claude-opus-5',
      numTurns: 12,
      status: RunStatus.FAILED,
      error: 'engine exited with code 1',
      retryAt: new Date(now + 30_000),
      startedAt: new Date(now - 2 * HOUR),
      lastTurnAt: new Date(now - HOUR),
      runtimeSessionId: randomUUID(),
      lastAssistantText: `Filed it as ${randomUUID()}.`,
      runningBgShells: ['job-1', 'svc-1'],
      runningBgJobs: ['job-1'],
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });

  // The project: a coordinator, and work that is ready while nothing runs — the stalled shape.
  const projectId = randomUUID();
  const coordinatorId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorId,
      ownerId: me.ownerId,
      creatorId: me.ownerId,
      workspaceId: me.workspaceId,
      assignedRunnerId: me.runnerId,
      title: 'Coordinate: link cards',
      prompt: 'coordinate the link cards',
      provider: 'claude',
      model: 'claude-opus-5',
      numTurns: 3,
      status: RunStatus.AWAITING_INPUT,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId: me.ownerId,
      title: 'Link cards',
      coordinatorWorkspaceId: me.workspaceId,
      coordinatorSessionId: coordinatorId,
    },
  });
  const inProject = { projectId, assigneeId: me.workspaceId };
  const p1 = await task(me.ownerId, 'p1', { ...inProject, status: TaskStatus.DONE });
  const p2 = await task(me.ownerId, 'p2', inProject);
  const p3 = await task(me.ownerId, 'p3', inProject);
  const p4 = await task(me.ownerId, 'p4', inProject);
  await task(me.ownerId, 'p5', { ...inProject, status: TaskStatus.FAILED });
  await db.taskDependency.create({ data: { taskId: p2, dependsOnTaskId: p1 } });
  await db.taskDependency.create({ data: { taskId: p3, dependsOnTaskId: p2 } });

  // The task card's subject, filed under the project, with two runs behind it.
  const taskId = await task(me.ownerId, 'Write the batch read', { ...inProject, status: TaskStatus.DONE });
  await run(me.ownerId, taskId, RunStatus.CANCELLED, { createdAt: new Date(now - 3 * HOUR), numTurns: 2 });
  const endedAt = new Date(now - HOUR);
  await run(me.ownerId, taskId, RunStatus.SUCCEEDED, {
    createdAt: new Date(now - 2 * HOUR), numTurns: 7, finishedAt: endedAt,
  });
  // And one filed nowhere, owned by nobody, never run.
  const bareTaskId = await task(me.ownerId, 'A loose end');

  // The watches the session is parked on: two ACTIVE over one live target between them (the other
  // is GONE), and one PAUSED.
  const watch = (state: string, targets: Array<{ id: string; state?: string }>) =>
    db.watch.create({
      data: {
        ownerId: me.ownerId,
        observerType: 'SESSION',
        observerSessionId: sessionId,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        action: 'RESUME_SESSION',
        state,
        expiresAt: new Date(now + 24 * HOUR),
        targets: {
          create: targets.map((target) => ({
            targetKind: 'TASK',
            targetResourceId: target.id,
            state: target.state ?? 'OBSERVED',
          })),
        },
      },
    });
  await watch('ACTIVE', [{ id: p2 }, { id: p3, state: 'GONE' }]);
  await watch('ACTIVE', [{ id: p2 }]);
  await watch('PAUSED', [{ id: p4 }]);

  // A list: one done, two open, one failed, one of the open ones running.
  const listId = randomUUID();
  await db.taskList.create({ data: { id: listId, ownerId: me.ownerId, title: 'Release checklist' } });
  await task(me.ownerId, 'l1', { listId, status: TaskStatus.DONE });
  await task(me.ownerId, 'l2', { listId });
  await task(me.ownerId, 'l3', { listId, status: TaskStatus.FAILED });
  await run(me.ownerId, await task(me.ownerId, 'l4', { listId }), RunStatus.RUNNING);

  // A project with no coordinator and no tasks.
  const bareProjectId = randomUUID();
  await db.project.create({ data: { id: bareProjectId, ownerId: me.ownerId, title: 'Nothing yet' } });

  // A wiki entry, in a space of its own: the one kind whose card is its own row rather than a page's
  // read, and the one whose page takes a space's slug as well as its id.
  const spaceId = randomUUID();
  await db.wikiSpace.create({
    data: { id: spaceId, ownerId: me.ownerId, slug: `orbit-${RUN}`, title: 'Orbit' },
  });
  const entryId = randomUUID();
  const checkRef = '4db4f9f0c1a2b3d4e5f60718293a4b5c6d7e8f90';
  await db.wikiEntry.create({
    data: {
      id: entryId,
      ownerId: me.ownerId,
      spaceId,
      kind: 'principle',
      status: 'active',
      trust: 'owner',
      currentRevision: 1,
      title: 'A clock never starts agent work',
      summary: 'Work starts from a committed fact.',
      fields: { statement: 'Work starts from a committed fact.' },
      anchors: [{ type: 'path', path: 'open-item-escalation.service.ts' }],
      anchorState: 'verified',
      anchorCheckedRef: checkRef,
    },
  });
  const theirEntryId = randomUUID();
  const theirSpaceId = randomUUID();
  await db.wikiSpace.create({
    data: { id: theirSpaceId, ownerId: stranger.ownerId, slug: `theirs-${RUN}`, title: 'Theirs' },
  });
  await db.wikiEntry.create({
    data: {
      id: theirEntryId,
      ownerId: stranger.ownerId,
      spaceId: theirSpaceId,
      kind: 'pitfall',
      status: 'active',
      trust: 'owner',
      currentRevision: 1,
      title: 'Their note',
      summary: 'Theirs.',
      fields: { statement: 'Theirs.' },
    },
  });

  // Out of reach, three ways. Somebody else's…
  const theirs = {
    session: randomUUID(),
    task: await task(stranger.ownerId, 'their task'),
    project: randomUUID(),
    list: randomUUID(),
  };
  await db.session.create({
    data: {
      id: theirs.session, ownerId: stranger.ownerId, creatorId: stranger.ownerId, title: 'their session',
      prompt: 'theirs', status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({ data: { id: theirs.project, ownerId: stranger.ownerId, title: 'their project' } });
  await db.taskList.create({ data: { id: theirs.list, ownerId: stranger.ownerId, title: 'their list' } });
  // …deleted (a session goes to Trash; the other three are gone outright)…
  const deleted = {
    session: randomUUID(),
    task: await task(me.ownerId, 'deleted task'),
    project: randomUUID(),
    list: randomUUID(),
  };
  await db.session.create({
    data: {
      id: deleted.session, ownerId: me.ownerId, creatorId: me.ownerId, title: 'trashed session',
      prompt: 'trashed', status: RunStatus.SUCCEEDED, deletedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({ data: { id: deleted.project, ownerId: me.ownerId, title: 'deleted project' } });
  await db.taskList.create({ data: { id: deleted.list, ownerId: me.ownerId, title: 'deleted list' } });
  await db.task.delete({ where: { id: deleted.task } });
  await db.project.delete({ where: { id: deleted.project } });
  await db.taskList.delete({ where: { id: deleted.list } });
  // …and ids that are no id at all.
  const MALFORMED = ['not an id!', 'z'.repeat(22), ''];

  // ── the app: the real controller and service, and main.ts's pipe and interceptors ──────────
  @Module({
    controllers: [LinkPreviewsController],
    providers: [
      { provide: LinkPreviewsService, useValue: previews },
      JwtAuthGuard,
      Reflector,
      {
        provide: JwtService,
        useValue: { verifyAsync: async (token: string) => ({ sub: token === 'stranger' ? stranger.ownerId : me.ownerId }) },
      },
    ],
  })
  class LinkPreviewsHarness {}

  const app = await NestFactory.create(LinkPreviewsHarness, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const sent: Sent[] = [];
  async function ask(refs: unknown, who = 'owner'): Promise<Sent> {
    const response = await fetch(`${base}/api/link-previews`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      body: JSON.stringify({ refs }),
    });
    const body = await response.text();
    let json: Json = {};
    try { json = JSON.parse(body) as Json; } catch { /* asserted on by the caller */ }
    const result = { status: response.status, body, json };
    sent.push(result);
    return result;
  }
  const pub = uuidToBase62;
  /** A value as it reads once it has been through JSON. */
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));

  const mine: Ref[] = [
    { kind: 'session', id: pub(sessionId) },
    { kind: 'task', id: pub(taskId) },
    { kind: 'task', id: pub(bareTaskId) },
    { kind: 'project', id: pub(projectId) },
    { kind: 'project', id: pub(bareProjectId) },
    { kind: 'list', id: pub(listId) },
    { kind: 'wiki', id: pub(entryId) },
  ];
  const kinds = ['session', 'task', 'project', 'list'] as const;
  const outOfReach: Array<Ref & { why: string }> = [
    ...kinds.map((kind) => ({ kind, id: pub(theirs[kind]), why: `another account's ${kind}` })),
    ...kinds.map((kind) => ({ kind, id: pub(deleted[kind]), why: `a deleted ${kind}` })),
    ...kinds.flatMap((kind) => MALFORMED.map((id) => ({ kind, id, why: `a ${kind} id ${JSON.stringify(id)}` }))),
    ...kinds.map((kind) => ({ kind, id: pub(randomUUID()), why: `a ${kind} id that names nothing` })),
    // A wiki entry has no deleted state — a lineage is retired, not removed — so the two ways an
    // entry can be out of reach are somebody else's and an id that names nothing. An id that is no
    // id at all is asked for below, with the rest of the malformed ones.
    { kind: 'wiki', id: pub(theirEntryId), why: "another account's wiki entry" },
    { kind: 'wiki', id: pub(randomUUID()), why: 'a wiki id that names nothing' },
    ...MALFORMED.map((id) => ({ kind: 'wiki' as const, id, why: `a wiki id ${JSON.stringify(id)}` })),
  ];
  const answer = await ask([...mine, ...outOfReach.map(({ kind, id }) => ({ kind, id }))]);
  assert.equal(answer.status, 200, answer.body);
  const previewsOut: Json[] = answer.json.previews;
  const byId = (id: string) => previewsOut.find((preview) => preview.id === id)!;

  await t.test('one preview per ref, in the order asked, each addressed base62', () => {
    assert.equal(previewsOut.length, mine.length + outOfReach.length);
    const asked = [...mine, ...outOfReach];
    previewsOut.forEach((preview, i) => {
      assert.equal(preview.kind, asked[i].kind, `preview ${i} kind`);
      assert.equal(preview.id, asked[i].id, `preview ${i} id`);
    });
    for (const ref of mine) assert.equal(byId(ref.id).state, 'ok', `${ref.kind} ${ref.id} is the caller's`);
  });

  await t.test('a session card is its list row: the same status fields, plus watching and updatedAt', async () => {
    const card = byId(pub(sessionId)).session;
    const row = (await sessions.list(me.ownerId, {})).find((candidate) => candidate.id === sessionId)!;
    assert.ok(row, 'the session is on its owner’s list');
    for (const field of [
      'title', 'status', 'runStatus', 'runState', 'sessionState', 'lifecycleState', 'endReason',
      'error', 'retryAt', 'engineTurnActive', 'pendingApprovals', 'waitingKind', 'runningBgCount',
      'runningBgJobCount', 'model', 'numTurns', 'createdAt', 'lastTurnAt', 'projectTitle',
    ] as const) {
      assert.deepEqual(card[field], wire(row[field]), `session.${field} is the list row's`);
    }
    // Not vacuous: the fixture's values are the interesting ones, not defaults.
    assert.equal(card.runState, 'FAILED');
    assert.equal(card.error, 'engine exited with code 1');
    assert.ok(card.retryAt, 'the armed retry is on the card');
    assert.equal(card.runningBgCount, 2);
    assert.equal(card.runningBgJobCount, 1);
    assert.equal(card.numTurns, 12);
    assert.equal(card.model, 'claude-opus-5');
    assert.deepEqual(card.workspace, {
      id: pub(me.workspaceId), publicId: pub(me.workspaceId), name: 'owner workspace',
    });
    assert.deepEqual(card.watching, { active: 2, paused: 1, targets: 1 });
    assert.equal(card.projectId, null, 'it coordinates nothing');
    const { updatedAt } = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(card.updatedAt, updatedAt.toISOString());
    for (const leak of ['runtimeSessionId', 'lastAssistantText', 'lastUserText', 'lastToolUse']) {
      assert.equal(leak in card, false, `${leak} is not on a card`);
    }
  });

  await t.test('a task card: status, live overlays, project, assignee, runs and the newest run', () => {
    const card = byId(pub(taskId)).task;
    assert.equal(card.title, 'Write the batch read');
    assert.equal(card.status, 'DONE');
    assert.equal(card.running, false);
    assert.equal(card.queued, false);
    assert.deepEqual(card.project, { id: pub(projectId), publicId: pub(projectId), title: 'Link cards' });
    assert.deepEqual(card.assignee, {
      id: pub(me.workspaceId), publicId: pub(me.workspaceId), name: 'owner workspace',
    });
    assert.equal(card.runs, 2);
    assert.deepEqual(card.lastRun, {
      status: 'SUCCEEDED', runState: 'SUCCEEDED', numTurns: 7, endedAt: endedAt.toISOString(),
    });
    assert.ok(card.updatedAt);

    const bare = byId(pub(bareTaskId)).task;
    assert.equal(bare.project, null);
    assert.equal(bare.assignee, null);
    assert.equal(bare.runs, 0);
    assert.equal(bare.lastRun, null);
  });

  await t.test('a project card: readProjectPanorama’s lanes, ready with nothing running, and its coordinator', async () => {
    const card = byId(pub(projectId)).project;
    const panorama = await readProjectPanorama(prisma, me.ownerId, projectId);
    assert.deepEqual(card.buckets, wire(panorama.buckets), 'the lanes are the panorama’s, not a recount');
    assert.equal(card.total, panorama.shape.taskCount);
    // The fixture is the stalled shape the card has a line for, by hand: p2 and p4 ready, p3
    // blocked, p1 and the task card's subject done, p5 failed.
    assert.equal(card.buckets.ready, 2);
    assert.equal(card.buckets.running, 0);
    assert.equal(card.buckets.blocked, 1);
    assert.equal(card.buckets.done, 2);
    assert.equal(card.buckets.failed, 1);
    assert.equal(card.total, 6);
    assert.equal(card.title, 'Link cards');
    assert.equal(card.status, 'OPEN');

    assert.equal(card.coordinatorSessionId, pub(coordinatorId));
    const coordinator = card.coordinator;
    const row = (await sessions.list(me.ownerId, {})).find((candidate) => candidate.id === coordinatorId)!;
    for (const field of ['runState', 'engineTurnActive', 'pendingApprovals', 'numTurns', 'lastTurnAt'] as const) {
      assert.deepEqual(coordinator[field], wire(row[field]), `coordinator.${field} is the list row's`);
    }
    assert.equal(coordinator.id, pub(coordinatorId));
    assert.equal(coordinator.runState, 'AWAITING_INPUT');
    assert.equal(coordinator.engineTurnActive, true);
    assert.equal(coordinator.projectId, pub(projectId), 'the row says which project it coordinates');
    assert.equal(coordinator.projectTitle, 'Link cards');
    assert.equal(coordinator.watching, null);

    const bare = byId(pub(bareProjectId)).project;
    assert.equal(bare.coordinatorSessionId, null);
    assert.equal(bare.coordinator, null);
    assert.equal(bare.total, 0);
    assert.deepEqual(bare.buckets, wire((await readProjectPanorama(prisma, me.ownerId, bareProjectId)).buckets));
  });

  await t.test('a list card: the task page’s tallies for that list, unchanged', async () => {
    const card = byId(pub(listId)).list;
    assert.equal(card.title, 'Release checklist');
    assert.deepEqual(card.counts, wire(await tasks.taskCounts(me.ownerId, { listId })));
    assert.equal(card.counts.total, 4);
    assert.equal(card.counts.done, 1);
    assert.equal(card.counts.open, 2);
    assert.equal(card.counts.failed, 1);
    assert.equal(card.counts.running, 1);
  });

  await t.test('a wiki card: the entry’s own row, its space’s slug, and the anchor it stands on', () => {
    const card = byId(pub(entryId)).wiki;
    assert.equal(card.title, 'A clock never starts agent work');
    assert.equal(card.summary, 'Work starts from a committed fact.');
    assert.equal(card.kind, 'principle');
    assert.equal(card.status, 'active');
    assert.equal(card.trust, 'owner');
    assert.equal(card.anchorState, 'verified');
    assert.equal(card.anchorCheckedRef, checkRef);
    // The record, not a sentence: which words a path and a symbol get is the client's.
    assert.deepEqual(card.anchor, { type: 'path', path: 'open-item-escalation.service.ts' });
    // An entry's page takes its space as well as its id, so the card carries the slug — base62 id,
    // and the slug as the space spells it.
    assert.equal(card.spaceId, pub(spaceId));
    assert.equal(card.spaceSlug, `orbit-${RUN}`);
    assert.equal(card.currentRevision, undefined, 'the card is not the record');
    for (const leak of ['fields', 'anchors', 'topics', 'aliases', 'stats']) {
      assert.equal(leak in card, false, `${leak} is not on a card`);
    }
  });

  await t.test('another account’s, deleted, and malformed ids are all the same bare `unavailable`', () => {
    const asked = [...mine, ...outOfReach];
    for (const [i, ref] of outOfReach.entries()) {
      const preview = previewsOut[mine.length + i];
      assert.deepEqual(
        preview,
        { kind: ref.kind, id: asked[mine.length + i].id, state: 'unavailable' },
        `${ref.why}: nothing but its address and the one word`,
      );
    }
  });

  await t.test('the stranger can read their own objects, so it was ownership that hid them', async () => {
    const theirsAsked = kinds.map((kind) => ({ kind, id: pub(theirs[kind]) }));
    const own = await ask(theirsAsked, 'stranger');
    assert.equal(own.status, 200, own.body);
    assert.deepEqual(own.json.previews.map((preview: Json) => preview.state), ['ok', 'ok', 'ok', 'ok']);
  });

  await t.test('a publicId and a UUID for the same object read the same card', async () => {
    const objects = [
      { kind: 'session', id: sessionId },
      { kind: 'task', id: taskId },
      { kind: 'project', id: projectId },
      { kind: 'list', id: listId },
      { kind: 'wiki', id: entryId },
    ] as const;
    const byPublicId = await ask(objects.map(({ kind, id }) => ({ kind, id: pub(id) })));
    const byUuid = await ask(objects.map(({ kind, id }) => ({ kind, id })));
    const byUpperUuid = await ask(objects.map(({ kind, id }) => ({ kind, id: id.toUpperCase() })));
    assert.equal(byPublicId.status, 200, byPublicId.body);
    assert.equal(byUuid.status, 200, byUuid.body);
    assert.deepEqual(byUuid.json, byPublicId.json);
    assert.deepEqual(byUpperUuid.json, byPublicId.json);
    assert.deepEqual(byUuid.json.previews.map((preview: Json) => preview.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  await t.test(`${LINK_PREVIEW_MAX_REFS} refs are read; one more is refused`, async () => {
    const refs = (n: number) => Array.from({ length: n }, () => ({ kind: 'task', id: pub(taskId) }));
    const full = await ask(refs(LINK_PREVIEW_MAX_REFS));
    assert.equal(full.status, 200, full.body);
    assert.equal(full.json.previews.length, LINK_PREVIEW_MAX_REFS);
    const over = await ask(refs(LINK_PREVIEW_MAX_REFS + 1));
    assert.equal(over.status, 400, over.body);
    assert.equal(over.json.previews, undefined);
    assert.match(over.body, /refs/);
  });

  await t.test('no response carries a bare UUID anywhere in its JSON', () => {
    // The bait is really there to be leaked: ids everywhere, a runtime session id, a quoted uuid.
    assert.ok(sent.length >= 7);
    for (const response of sent) {
      assert.doesNotMatch(response.body, UUID_ANYWHERE, response.body.slice(0, 2_000));
    }
    assert.match(answer.body, new RegExp(pub(coordinatorId)), 'the ids are present, spelled base62');
  });
});
