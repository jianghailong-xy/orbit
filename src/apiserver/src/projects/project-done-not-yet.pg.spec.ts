/**
 * The owner's "Not yet…" answer to a coordinator's `DONE_REQUEST`.
 *
 * This is deliberately an HTTP/PG spec: the route is the owner JWT door, while the assertions read
 * the rows that make the card disappear and the conversation turn that carries the answer.  The
 * same project is then asked again through the runner's real `project_request_done` path, so a
 * declined card is not merely a terminal row — it really opens the next closing question.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-done-not-yet.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  Prisma,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  type PrismaClient,
} from '@prisma/client';
import type { DoneRequest, RequestProjectDoneBody } from '@orbit/shared';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionKeyOf, criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import {
  DONE_REQUEST_DEDUPE_KEY,
  DONE_REQUEST_KIND,
  DONE_REQUEST_TITLE,
} from './project-done-request';
import { ProjectDoneNotYetController } from './project-done-not-yet.controller';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CALL: RequestProjectDoneBody = {
  judgment: 'The work is complete enough to ask, but the owner may know one last gap.',
  gaps: [],
};

interface StoredItem {
  id: string;
  state: string;
  kind: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_by_user_id: string | null;
  resolved_at: Date | null;
  answer: unknown;
  resolution_note: string | null;
  payload: DoneRequest;
}

test('the owner sends a done request back with a note', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
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

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  const tasks = new TasksService(db, sessions, realtime);
  const runnerDoor = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('request_done must not ask for orchestration authorization') } as never,
    openItems,
  );

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `done-not-yet-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'done-not-yet-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: 'done-not-yet-workspace',
      enabled: true,
      repoUrl: 'ssh://git@example.invalid/orbit/done-not-yet',
      workDir: `/srv/done-not-yet/${projectId}`,
    },
  });
  await prisma.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'Coordinating the closing question',
      prompt: 'Coordinate the closing question',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await prisma.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: 'Coordinate the closing question',
      status: 'ANSWERED',
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      ownerId,
      title: 'The closing question',
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await prisma.projectRuntime.upsert({
    where: { projectId }, create: { projectId }, update: {},
  });

  // A real criterion and a codeless DONE task make the later request_done call pass its readiness
  // checks without involving a runner process or a repository checkout.
  const updated = await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [{
      text: 'the closing question is implemented',
      verificationMethod: 'HUMAN',
    }],
  } as never);
  const [criterion] = criteriaFromDefinitions(updated.acceptanceCriteriaItems);
  assert.ok(criterion, 'the fixture must have one criterion');
  const task = await tasks.create(ownerId, {
    title: 'implement the closing question',
    projectId,
    criterionKey: criterion.key,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    autoRunWhenReady: false,
  } as never) as unknown as { id: string };
  await prisma.task.update({ where: { id: task.id }, data: { codeless: true } });
  const settled = await sql.query(
    `UPDATE "task" SET "status" = 'DONE'
       WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
    [task.id],
  );
  assert.equal(settled.rowCount, 1, 'the fixture task must be DONE');

  @Module({
    controllers: [ProjectDoneNotYetController],
    providers: [
      { provide: ProjectOpenItemService, useValue: openItems },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
    ],
  })
  class DoneNotYetModule {}
  const app = await NestFactory.create(DoneNotYetModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const note = '请补上生产环境的迁移，并把最后一条验收证据贴回来。';
  const initialGap = {
    criterionKey: criterionKeyOf(criterion.definitionId),
    title: 'production migration',
    whyNotProven: 'the production migration has not run',
    coordinatorChecked: 'the staging migration only',
    evidenceRefs: ['deploy:staging'],
  };

  async function ask(judgment: string): Promise<{ itemId: string; state: string }> {
    return runnerDoor.requestDone(
      { id: runnerId, ownerId } as never,
      coordinatorSessionId,
      projectId,
      { judgment, gaps: [initialGap] } as never,
    ) as Promise<{ itemId: string; state: string }>;
  }

  async function item(itemId: string): Promise<StoredItem> {
    const { rows } = await sql.query<StoredItem>(
      `SELECT "id", "state", "kind", "resolution", "resolved_by", "resolved_by_user_id"::text,
              "resolved_at", "answer", "resolution_note", "payload"
         FROM "project_open_item" WHERE "id" = $1::uuid`,
      [itemId],
    );
    assert.equal(rows.length, 1);
    return rows[0]!;
  }

  async function snapshot(): Promise<unknown> {
    const { rows: [project] } = await sql.query(
      `SELECT row_to_json(p) AS "row" FROM "project" p WHERE p."id" = $1::uuid`, [projectId],
    );
    const { rows: [items] } = await sql.query(
      `SELECT coalesce(json_agg(i ORDER BY i."id"), '[]'::json) AS "rows"
         FROM "project_open_item" i WHERE i."project_id" = $1::uuid`, [projectId],
    );
    const { rows: [turns] } = await sql.query(
      `SELECT coalesce(json_agg(t ORDER BY t."seq"), '[]'::json) AS "rows"
         FROM "conversation_turn" t WHERE t."session_id" = $1::uuid`, [coordinatorSessionId],
    );
    const { rows: [deliveries] } = await sql.query(
      `SELECT coalesce(json_agg(d ORDER BY d."id"), '[]'::json) AS "rows"
         FROM "project_open_item_delivery" d WHERE d."project_id" = $1::uuid`, [projectId],
    );
    return { project, items, turns, deliveries };
  }

  async function press(
    itemId: string,
    body: unknown,
    actingSessionId?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(
      `${base}/api/projects/${uuidToBase62(projectId)}/done-requests/${uuidToBase62(itemId)}/decline`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner',
          'content-type': 'application/json',
          ...(actingSessionId ? { 'x-orbit-session-id': uuidToBase62(actingSessionId) } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async function sessionWaitingKind(): Promise<string | null> {
    const rows = await sessions.list(ownerId, {}) as unknown as Array<{
      id: string;
      waitingKind: string | null;
    }>;
    return rows.find((row) => row.id === coordinatorSessionId)?.waitingKind ?? null;
  }

  async function projectDoneRequest(): Promise<unknown> {
    const rows = await projects.list(ownerId);
    const found = rows.find((row) => row.id === projectId) as unknown as {
      attention: { doneRequest: unknown | null };
    } | undefined;
    assert.ok(found, 'the project must be on the owner list');
    return found.attention.doneRequest;
  }

  // First file one real request.  A second call with a changed judgment supersedes it, which gives
  // the stale-door assertion a production-created terminal row rather than a hand-written state.
  const first = await ask(CALL.judgment);
  assert.equal(first.state, 'OPEN');
  const replacement = await ask('The coordinator checked again, and this is a newer request.');
  assert.equal(replacement.state, 'OPEN');
  const beforeSuperseded = await snapshot();
  const supersededResponse = await press(first.itemId, { note });
  assert.equal(supersededResponse.status, 409);
  assert.deepEqual(await snapshot(), beforeSuperseded, 'a superseded request is not rewritten');

  await t.test('an acting session is refused before any write', async () => {
    const before = await snapshot();
    const response = await press(replacement.itemId, { note }, coordinatorSessionId);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE');
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('a blank note is a 400 before any write', async () => {
    const before = await snapshot();
    const response = await press(replacement.itemId, { note: '   \n  ' });
    assert.equal(response.status, 400);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('Not yet resolves the request, stores the note and tells the coordinator once', async () => {
    const response = await press(replacement.itemId, { note: `  ${note}  ` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.state, 'RESOLVED');
    assert.equal(response.body.resolution, 'DECLINED');
    assert.equal(response.body.note, note);

    const stored = await item(replacement.itemId);
    assert.equal(stored.kind, DONE_REQUEST_KIND);
    assert.equal(stored.state, 'RESOLVED');
    assert.equal(stored.resolution, 'DECLINED');
    assert.equal(stored.resolved_by, 'USER');
    assert.equal(stored.resolved_by_user_id, ownerId);
    assert.deepEqual(stored.answer, { note });
    assert.equal(stored.resolution_note, note);
    assert.ok(stored.resolved_at);

    const { rows: turns } = await sql.query<{ content: string; client_turn_id: string }>(
      `SELECT "content", "client_turn_id" FROM "conversation_turn"
        WHERE "session_id" = $1::uuid AND "client_turn_id" LIKE $2
        ORDER BY "seq"`,
      [coordinatorSessionId, `owner-answer:v1:${replacement.itemId}:%`],
    );
    assert.equal(turns.length, 1, 'one coordinator turn is queued');
    assert.match(turns[0]!.content, /What’s missing before it’s done\?/u);
    assert.ok(turns[0]!.content.includes(note));
    assert.ok(turns[0]!.content.includes('The coordinator checked again'));
    assert.ok(turns[0]!.content.includes(initialGap.whyNotProven));
    assert.ok(turns[0]!.content.includes('Warnings on the card:'));
    for (const warning of stored.payload.warnings ?? []) {
      assert.ok(turns[0]!.content.includes(warning.message),
        `the decline carries warning ${warning.code} to the coordinator`);
    }
    assert.match(turns[0]!.content, /call project_request_done again/u);

    const { rows: deliveries } = await sql.query<{ item_id: string; purpose: string }>(
      `SELECT "item_id", "purpose" FROM "project_open_item_delivery"
        WHERE "item_id" = $1::uuid AND "session_id" = $2::uuid`,
      [replacement.itemId, coordinatorSessionId],
    );
    assert.deepEqual(deliveries, [{ item_id: replacement.itemId, purpose: 'ANSWER' }]);

    const afterFirst = await snapshot();
    const replay = await press(replacement.itemId, { note });
    assert.equal(replay.status, 409);
    assert.deepEqual(await snapshot(), afterFirst, 'replaying the press adds no turn or delivery');
  });

  await t.test('the Ready to close projections go dark after the card closes', async () => {
    assert.notEqual(await sessionWaitingKind(), 'DONE_REQUEST');
    assert.equal(await projectDoneRequest(), null);
  });

  await t.test('the coordinator can ask again after Not yet', async () => {
    const again = await ask('The missing migration is now the only thing to check.');
    assert.equal(again.state, 'OPEN');
    assert.notEqual(again.itemId, replacement.itemId);
    const current = await item(again.itemId);
    assert.equal(current.state, 'OPEN');
    assert.equal(current.kind, DONE_REQUEST_KIND);
  });

  await t.test('a request answered by Record as done cannot be declined afterwards', async () => {
    const open = await ask('The owner may now record this project done.');
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    const before = await snapshot();
    const recorded = await acceptance.recordProjectDone(ownerId, projectId, {
      requestId: open.itemId,
      criteriaDigest: standing.currentVersion.digest,
      acceptedGaps: [],
    });
    assert.equal(recorded.status, 'DONE');
    const approved = await item(open.itemId);
    assert.equal(approved.resolution, 'APPROVED');
    const beforeDecline = await snapshot();
    assert.notDeepEqual(beforeDecline, before, 'Record as done changed the project and request');
    const response = await press(open.itemId, { note });
    assert.equal(response.status, 409);
    assert.deepEqual(await snapshot(), beforeDecline);
  });

  await t.test('without a coordinator session the durable decline has no delivery', async () => {
    const noSessionProjectId = randomUUID();
    const noSessionItemId = randomUUID();
    await prisma.project.create({ data: { id: noSessionProjectId, ownerId, title: 'No coordinator' } });
    await prisma.projectRuntime.upsert({
      where: { projectId: noSessionProjectId },
      create: { projectId: noSessionProjectId },
      update: {},
    });
    const payload: DoneRequest = {
      criteriaDigest: '0'.repeat(64),
      stateDigest: '1'.repeat(64),
      judgment: 'No coordinator is bound.',
      gaps: [{ ...initialGap }],
      warnings: [],
    };
    await prisma.projectOpenItem.create({
      data: {
        id: noSessionItemId,
        projectId: noSessionProjectId,
        ownerId,
        kind: DONE_REQUEST_KIND,
        state: 'OPEN',
        assignee: 'OWNER',
        assigneeReason: 'DEFAULT',
        dedupeKey: DONE_REQUEST_DEDUPE_KEY,
        title: DONE_REQUEST_TITLE,
        payload: payload as unknown as Prisma.InputJsonValue,
        waitingSince: new Date(),
        assignedAt: new Date(),
      },
    });
    const response = await fetch(
      `${base}/api/projects/${uuidToBase62(noSessionProjectId)}/done-requests/${uuidToBase62(noSessionItemId)}/decline`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
        body: JSON.stringify({ note }),
      },
    );
    assert.equal(response.status, 201);
    const { rows } = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM "project_open_item_delivery" WHERE "item_id" = $1::uuid`,
      [noSessionItemId],
    );
    assert.equal(rows[0]!.count, 0);
    const stored = await item(noSessionItemId);
    assert.equal(stored.resolution, 'DECLINED');
  });
});
