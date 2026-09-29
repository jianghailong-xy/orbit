/**
 * `POST /projects/:id/start`: the account owner starts a project in one write, once.
 *
 * WHAT A START IS
 * ---------------
 * Until migration 0330 nothing recorded that a project had started. "Start the project" confirmed
 * the criteria and, as a side effect of the same press, turned `coordinator_enabled` on; whether a
 * project had begun was then read back off that switch and off whether a confirmation existed. The
 * owner never chose where the tasks land, Automatic was switched on without being named, and the
 * Automatic switch doubled as the project's on switch. A start is now its own fact —
 * `project.started_at` — written by one door, in one transaction, together with everything the
 * "Start this project?" card lets the owner decide: the criteria confirmed by their seal, the
 * integration line (as the owner's choice), Automatic, the concurrency limit and the merge check.
 *
 * WHAT THIS FILE HOLDS IT TO
 * --------------------------
 *   (1) a request carrying an acting session is refused 403, over real HTTP, and writes nothing;
 *   (2) a seal that moved is 409 and writes nothing — counted row by row in SQL;
 *   (3) a start writes all five at once, and its coordinator is told the settings;
 *   (4) pressing again is 409 PROJECT_ALREADY_STARTED, and the second press writes nothing;
 *   (5) a line that has already started integrating is left where it is, and the answer says so;
 *   (6) the coordinator's project-started turn and card carry the settings, and mark the one that
 *       is not what the start asked for;
 *   (7) the older confirmation door starts a project that has not started, with the defaults — the
 *       line by the default rule over its tasks and dependencies as they stand, Automatic on, its
 *       concurrency limit left alone;
 *   (8) on a started project that door only confirms;
 *   (9) the backfill: each of the three ways a project could start before 0330 gives it a start
 *       time, the earliest one it has, and a project with none of them stays unstarted.
 *   (10) a project with no repository can be started on main, and not on a branch it cannot have.
 *
 * Every fact is produced the way the product produces it: criteria through `ProjectsService.update`,
 * the start through the real controller, pipe and interceptor where the door itself is the claim,
 * and every write read back with SQL rather than through the service that made it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-start-door.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  type ProjectStartedCard,
  RunEventType,
  type StartProjectRequestBody,
  uuidToBase62,
} from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { projectAwaitingStart, projectStartedTurnId } from './project-started';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0330_project_started_at/migration.sql'),
  'utf8',
);

/** A rung of the verification ladder, so an ADDED criterion is an edit that lands (see
 *  `project-acceptance-confirmation.pg.spec.ts` on why a reworded one would be held instead). */
const METHOD = 'VERIFICATION';
const FIRST = 'the start is one write';
const SECOND = 'the start happens once';
const ADDED = 'the seal the owner read is the one that is confirmed';
const REPO = 'https://example.invalid/orbit/start-door.git';
const FIRST_TASK = 'the task that starts first';
const HELD = 'the task its coordinator starts by hand';

/** Everything a start writes, read off the rows — never off the answer that wrote them. */
interface World {
  project: {
    started_at: string | null;
    coordinator_enabled: boolean;
    max_concurrent_tasks: number;
    config_revision: string;
  };
  confirmations: Array<{ criteria_digest: string; started_with: unknown; confirmed_at: string }>;
  bindings: Array<{
    integration_ref: string;
    integration_ref_source: string;
    integration_started_at: string | null;
    merge_check_command: string | null;
  }>;
  turns: number;
}

interface Refusal {
  status: number;
  body: { code?: string; message?: string; currentDigest?: string };
}

test('the owner starts a project in one write, once', {
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

  // The conversation a project is coordinated from is told of its start through `SessionsService`,
  // so the services are built with the real one; only the publish and the queue nudge are inert.
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService, sessions);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance, sessions);
  // The runner's event door, where the echo of a turn — and the card beside it — is stored. Every
  // port it does not use here answers as a proxy, as in `project-acceptance-confirmation.pg.spec.ts`.
  const runnerApi = new RunnerApiController(
    prisma as unknown as PrismaService,
    queue,
    realtime,
    new Proxy({}, { get: () => async () => undefined }) as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `start-door-${ownerId}@project-start.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });

  // ── the door, over real HTTP: the real controller, pipe and interceptor ─────────────────────────
  // Only the collaborators the start never reaches are stubbed, and they throw: a probe that
  // answered them quietly would let a shadowed route pass as a green.
  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be reached by this probe`);
  };
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      { provide: ProjectOpenItemService, useValue: { list: refuse('open items') } },
      { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class StartDoorModule {}

  const app = await NestFactory.create(StartDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  /** The start as a browser presses it — the project addressed in base62, as every client does. */
  async function press(
    projectId: string,
    body: StartProjectRequestBody,
    sessionHeader?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}/api/projects/${uuidToBase62(projectId)}/start`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer the-account-owner',
        'content-type': 'application/json',
        ...(sessionHeader ? { 'x-orbit-session-id': sessionHeader } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  async function refused(action: () => Promise<unknown>): Promise<Refusal> {
    try {
      await action();
    } catch (error) {
      return {
        status: (error as { status?: number }).status ?? 0,
        body: (error as { response?: Refusal['body'] }).response ?? {},
      };
    }
    return assert.fail('the call was expected to be refused and was not');
  }

  async function world(projectId: string, sessionId: string | null): Promise<World> {
    const { rows: [project] } = await sql.query<World['project']>(
      `SELECT "started_at"::text AS "started_at", "coordinator_enabled", "max_concurrent_tasks",
              "config_revision"::text AS "config_revision"
         FROM "project" WHERE "id" = $1::uuid`,
      [projectId],
    );
    assert.ok(project, 'the project this assertion is about is not there');
    const { rows: confirmations } = await sql.query<World['confirmations'][number]>(
      `SELECT "criteria_digest", "started_with", "confirmed_at"::text AS "confirmed_at"
         FROM "project_standard_set_confirmation"
        WHERE "project_id" = $1::uuid ORDER BY "confirmed_at", "id"`,
      [projectId],
    );
    const { rows: bindings } = await sql.query<World['bindings'][number]>(
      `SELECT "integration_ref", "integration_ref_source",
              "integration_started_at"::text AS "integration_started_at", "merge_check_command"
         FROM "project_codebase" WHERE "project_id" = $1::uuid ORDER BY "id"`,
      [projectId],
    );
    const turns = sessionId === null ? 0 : Number((await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "conversation_turn" WHERE "session_id" = $1::uuid`,
      [sessionId],
    )).rows[0].n);
    return { project, confirmations, bindings, turns };
  }

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(projectId: string, texts: string[]) {
    const { rows } = await sql.query<{ id: string; text: string }>(
      `SELECT "id", "text" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    const known = new Map(rows.map((row) => [row.text, row.id]));
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: texts.map((text) => ({
        ...(known.has(text) ? { id: known.get(text) } : {}),
        text,
        verificationMethod: METHOD,
      })),
    } as never);
  }

  async function seal(projectId: string): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /**
   * A project nobody has started, coordinated from a conversation parked where a turn appends — on
   * a workspace whose runner is heartbeating — with two criteria and two tasks: one Orbit starts by
   * itself, and one filed to start by hand that `dependent` makes wait on the first.
   */
  async function coordinated(label: string, options: {
    repoUrl?: string | null;
    dependent?: boolean;
    maxConcurrentTasks?: number;
  } = {}) {
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const id = randomUUID();
    await prisma.runner.create({
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
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        ownerId,
        runnerId,
        name: `${label}-workspace`,
        enabled: true,
        repoUrl: options.repoUrl === undefined ? REPO : options.repoUrl,
      },
    });
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `协调：${label}`,
        prompt: `协调：${label}`,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(sessionId),
        kind: 'message',
        content: `协调：${label}`,
        status: 'ANSWERED',
      },
    });
    await prisma.project.create({
      data: {
        id,
        ownerId,
        title: `${label} 的项目`,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: sessionId,
        ...(options.maxConcurrentTasks ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    await state(id, [FIRST, SECOND]);
    const firstId = randomUUID();
    const heldId = randomUUID();
    for (const [taskId, title, autoRunWhenReady] of [
      [firstId, FIRST_TASK, true],
      [heldId, HELD, false],
    ] as const) {
      await prisma.task.create({
        data: {
          id: taskId,
          ownerId,
          projectId: id,
          title,
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          assigneeId: workspaceId,
          status: TaskStatus.OPEN,
          completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
          autoRunWhenReady,
        },
      });
    }
    if (options.dependent) {
      await prisma.taskDependency.create({ data: { taskId: heldId, dependsOnTaskId: firstId } });
    }
    const before = await world(id, sessionId);
    assert.equal(before.project.started_at, null, 'the fixture project is not started yet');
    assert.equal(before.project.coordinator_enabled, false);
    assert.deepEqual(before.confirmations, []);
    return { id, sessionId, runnerId, heldId };
  }

  /** The project-started turn on a conversation, and nothing else it holds. */
  async function startedTurns(sessionId: string) {
    const { rows } = await sql.query<{ id: string; client_turn_id: string; content: string }>(
      `SELECT "id", "client_turn_id", "content" FROM "conversation_turn"
        WHERE "session_id" = $1::uuid AND "client_turn_id" LIKE 'project-started:v1:%'
        ORDER BY "seq"`,
      [sessionId],
    );
    return rows;
  }

  /** The card the clients draw the waiting message as — off the queue, the way they read it. */
  async function queuedCard(sessionId: string): Promise<ProjectStartedCard | undefined> {
    const active = await sessions.listQueuedTurns(ownerId, sessionId, 'active') as Array<{
      projectStarted?: ProjectStartedCard;
    }>;
    assert.equal(active.length, 1, 'the one message is not the one thing queued');
    return active[0].projectStarted;
  }

  /** The runner echoing a queued turn, and the payload that echo was stored with. */
  async function echoed(runnerId: string, sessionId: string, turnId: string, text: string) {
    const last = await prisma.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
    await runnerApi.events({ id: runnerId } as never, sessionId, {
      events: [{
        seq: (last._max.seq ?? 0) + 1,
        type: RunEventType.USER,
        ts: new Date().toISOString(),
        turnId,
        payload: { text },
      }],
    } as never);
    const event = await prisma.runEvent.findFirst({
      where: { sessionId, turnId, type: RunEventType.USER },
      select: { payload: true },
    });
    assert.ok(event, 'the echo was not stored');
    return event.payload as { text?: string; projectStarted?: ProjectStartedCard };
  }

  // ═══ (1) no acting session: a request carrying one is refused, over the wire ═══════════════════

  await t.test('(1) a start carrying X-Orbit-Session-Id is refused 403 and writes nothing', async () => {
    const project = await coordinated('session-header');
    const before = await world(project.id, project.sessionId);
    const body: StartProjectRequestBody = {
      criteriaDigest: await seal(project.id),
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: 'npm test',
    };

    const sent = await press(project.id, body, uuidToBase62(project.sessionId));
    assert.equal(sent.status, 403, 'a request made from a session must not start a project');
    assert.equal(sent.json.code, 'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY',
      'refused by the rule the confirmation door is refused by');
    assert.equal(sent.json.tier, 'HUMAN_ONLY');
    assert.deepEqual(await world(project.id, project.sessionId), before,
      'a refused start wrote something');

    // And the same request without the header is the owner's, and goes through: the refusal was
    // the header's, not the request's.
    const owner = await press(project.id, body);
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
  });

  // ═══ (2) the seal the owner read is the one confirmed, or nothing is written ═══════════════════

  await t.test('(2) a seal that moved is 409 VERSION_MOVED, and not one row is written', async () => {
    const project = await coordinated('moved-seal');
    const read = await seal(project.id);
    // An edit lands between the render and the press: a third criterion.
    await state(project.id, [FIRST, SECOND, ADDED]);
    const moved = await seal(project.id);
    assert.notEqual(moved, read, 'the ruler moved');
    const before = await world(project.id, project.sessionId);

    const sent = await press(project.id, {
      criteriaDigest: read,
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 4,
      mergeCheckCommand: 'npm test',
    });
    assert.equal(sent.status, 409);
    assert.equal(sent.json.code, 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');
    assert.equal(sent.json.currentDigest, moved, 'the refusal names the seal that stands now');

    // Row by row: no confirmation, no binding, no start, no authorization write, no message.
    const counted = await sql.query<{ confirmations: string; bindings: string; started: string }>(
      `SELECT (SELECT count(*) FROM "project_standard_set_confirmation" WHERE "project_id" = $1::uuid)::text
                AS "confirmations",
              (SELECT count(*) FROM "project_codebase" WHERE "project_id" = $1::uuid)::text AS "bindings",
              (SELECT count(*) FROM "project" WHERE "id" = $1::uuid AND "started_at" IS NOT NULL)::text
                AS "started"`,
      [project.id],
    );
    assert.deepEqual(counted.rows[0], { confirmations: '0', bindings: '0', started: '0' });
    assert.deepEqual(await world(project.id, project.sessionId), before,
      'a start refused for a moved seal wrote something');
  });

  // ═══ (3) the five, in one write — and (4) never twice ══════════════════════════════════════════

  const started = await coordinated('five-at-once');

  await t.test('(3) a start writes the confirmation, the line, Automatic, concurrency, the merge check and the start', async () => {
    const digest = await seal(started.id);
    assert.deepEqual(await projectAwaitingStart(prisma, ownerId, started.id),
      { projectId: started.id, title: 'five-at-once 的项目' },
      'an agent’s task_start is held until this project is started');

    const sent = await press(started.id, {
      criteriaDigest: digest,
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'npm test',
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    const branch = `refs/heads/project/${uuidToBase62(started.id)}`;
    const settings = {
      line: 'PROJECT_BRANCH',
      projectBranchName: branch,
      automatic: true,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'npm test',
    };
    assert.equal(sent.json.projectId, uuidToBase62(started.id));
    assert.equal(sent.json.lineLocked, false);
    assert.equal(sent.json.criteriaDigest, digest);
    assert.equal(sent.json.criteriaCount, 2);
    assert.deepEqual(sent.json.settings, settings);
    assert.deepEqual(sent.json.differsFromRequest, []);

    // Off the rows.
    const after = await world(started.id, started.sessionId);
    assert.ok(after.project.started_at, 'the start was not recorded');
    assert.equal(new Date(after.project.started_at!).toISOString(), sent.json.startedAt);
    assert.equal(after.project.coordinator_enabled, true, 'Automatic');
    assert.equal(after.project.max_concurrent_tasks, 5, 'the concurrency limit');
    assert.equal(after.project.config_revision, '1',
      'one write of the authorization set is one revision, however many of its fields it carried');
    assert.equal(after.confirmations.length, 1, 'exactly one confirmation');
    assert.equal(after.confirmations[0].criteria_digest, digest, 'of the seal the owner read');
    assert.deepEqual(after.confirmations[0].started_with, { settings, differsFromRequest: [] },
      'and the confirmation records what the start left the project with');
    const { rows: [same] } = await sql.query<{ same: boolean }>(
      `SELECT (c."confirmed_at" AT TIME ZONE 'UTC') = p."started_at" AS "same"
         FROM "project_standard_set_confirmation" c JOIN "project" p ON p."id" = c."project_id"
        WHERE c."project_id" = $1::uuid`,
      [started.id],
    );
    assert.equal(same.same, true, 'the confirmation and the start are one instant');
    assert.deepEqual(after.bindings, [{
      integration_ref: branch,
      integration_ref_source: 'EXPLICIT',
      integration_started_at: null,
      merge_check_command: 'npm test',
    }], 'the line is the owner’s choice, and the merge check is set');
    assert.equal(await projectAwaitingStart(prisma, ownerId, started.id), null,
      'and task_start is no longer held');

    // The coordinator is told, once, with the settings.
    const told = await startedTurns(started.sessionId);
    assert.equal(told.length, 1, 'the start put exactly one message on its conversation');
    const { rows: [confirmation] } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "project_standard_set_confirmation" WHERE "project_id" = $1::uuid`,
      [started.id],
    );
    assert.equal(told[0].client_turn_id, projectStartedTurnId(started.id, {
      by: 'CONFIRMATION', confirmationId: confirmation.id, criteriaCount: 2, at: new Date(),
    }));
    assert.ok(told[0].content.includes(
      `It runs with: tasks land on the project branch project/${uuidToBase62(started.id)} first · `
        + 'Automatic on · at most 5 tasks at a time · merge check `npm test`.',
    ), told[0].content);
    assert.ok(!told[0].content.includes('Different from what the start asked for'),
      'everything is what was asked for, so nothing is named as different');
  });

  await t.test('(4) pressing again is 409 PROJECT_ALREADY_STARTED, and the second press writes nothing', async () => {
    const before = await world(started.id, started.sessionId);
    assert.ok(before.project.started_at, 'the project is started going in');
    const sent = await press(started.id, {
      criteriaDigest: await seal(started.id),
      line: 'MAIN',
      automatic: false,
      maxConcurrentTasks: 1,
      mergeCheckCommand: null,
    });
    assert.equal(sent.status, 409);
    assert.equal(sent.json.code, 'PROJECT_ALREADY_STARTED');
    assert.deepEqual(await world(started.id, started.sessionId), before,
      'a second press wrote something: a second confirmation, a setting, a revision or a message');
    assert.equal(before.confirmations.length, 1);

    // The same refusal reaches a direct call, where no controller stands in front of it.
    const direct = await refused(() => acceptance.startProject(ownerId, started.id, {
      criteriaDigest: before.confirmations[0].criteria_digest,
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'npm test',
    }));
    assert.equal(direct.status, 409);
    assert.equal(direct.body.code, 'PROJECT_ALREADY_STARTED');
    assert.deepEqual(await world(started.id, started.sessionId), before);
  });

  // ═══ (5) a line that has started stays where it is, and (6) the coordinator is told so ═════════

  const locked = await coordinated('locked-line');
  // Integrating into main since before the start: the default rule decided it at the first
  // integration, and from then on the line does not move.
  await prisma.projectCodebase.create({
    data: {
      ownerId,
      projectId: locked.id,
      canonicalRepoUrl: 'https://example.invalid/orbit/start-door',
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(Date.now() - 60_000),
    },
  });

  await t.test('(5) on a line that has started, the start leaves the line and says so', async () => {
    const before = await world(locked.id, locked.sessionId);
    const sent = await press(locked.id, {
      criteriaDigest: await seal(locked.id),
      line: 'PROJECT_BRANCH',
      automatic: false,
      maxConcurrentTasks: 2,
      // Whitespace is how it is typed, not a different check: stored trimmed, and not a difference.
      mergeCheckCommand: '  make check  ',
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(sent.json.lineLocked, true, 'the answer says the line had started');
    assert.deepEqual(sent.json.settings, {
      line: 'MAIN',
      automatic: false,
      maxConcurrentTasks: 2,
      mergeCheckCommand: 'make check',
    }, 'and gives the line the project is on, not the one asked for');
    assert.deepEqual(sent.json.differsFromRequest, ['line']);

    const after = await world(locked.id, locked.sessionId);
    assert.deepEqual(after.bindings, [{
      ...before.bindings[0],
      merge_check_command: 'make check',
    }], 'the line — its ref, its source and its start — is untouched; only the merge check moved');
    assert.ok(after.project.started_at, 'and the project is started all the same');
    assert.equal(after.project.coordinator_enabled, false, 'Automatic as asked: off');
    assert.equal(after.project.max_concurrent_tasks, 2);
    assert.equal(after.project.config_revision, '1');
    assert.deepEqual(after.confirmations.map((row) => row.started_with), [{
      settings: sent.json.settings,
      differsFromRequest: ['line'],
    }]);
  });

  await t.test('(6) the coordinator’s turn and card carry the settings, and mark what differs from the request', async () => {
    const told = await startedTurns(locked.sessionId);
    assert.equal(told.length, 1, 'the start put exactly one message on its conversation');
    const [message] = told;
    assert.match(message.content, /^From Orbit · project started/);
    assert.ok(message.content.includes(
      'It runs with: tasks land directly into main · Automatic off · at most 2 tasks at a time · '
        + 'merge check `make check`. Different from what the start asked for: the integration line. '
        + 'Its integration line had already started, so it stays where it was.',
    ), message.content);
    assert.ok(message.content.includes(`- ${HELD} (${uuidToBase62(locked.heldId)})`),
      'the task nothing starts but the coordinator is still named');

    const card = {
      by: 'CONFIRMATION',
      projectId: locked.id,
      projectTitle: 'locked-line 的项目',
      criteriaCount: 2,
      held: [{ id: locked.heldId, title: HELD }],
      heldCount: 1,
      settings: { line: 'MAIN', automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: 'make check' },
      differsFromRequest: ['line'],
    };
    assert.deepEqual(await queuedCard(locked.sessionId), card,
      'the card drawn while the message waits carries the settings and the difference');
    const echo = await echoed(locked.runnerId, locked.sessionId, message.id, message.content);
    assert.equal(echo.text, message.content, 'the echo is what the coordinator read, kept whole');
    assert.deepEqual(echo.projectStarted, card, 'and the echo was stored with the same card');
  });

  // ═══ (7) the older door starts an unstarted project, with the defaults ═════════════════════════

  const byRule = await coordinated('old-door-dependent', { dependent: true, maxConcurrentTasks: 7 });

  await t.test('(7) acceptance/confirmation on a project not started starts it with the default settings', async () => {
    const standing = await acceptance.confirmStandardSet(ownerId, byRule.id, {
      criteriaDigest: await seal(byRule.id),
    });
    assert.equal(standing.state, 'CONFIRMED');

    // Its tasks depend on one another, so the default rule — run now, over them as they stand —
    // puts it on a project branch. Recorded, so the first integration does not decide it again.
    const branch = `refs/heads/project/${uuidToBase62(byRule.id)}`;
    const settings = {
      line: 'PROJECT_BRANCH',
      projectBranchName: branch,
      automatic: true,
      maxConcurrentTasks: 7,
      mergeCheckCommand: null,
    };
    const after = await world(byRule.id, byRule.sessionId);
    assert.ok(after.project.started_at, 'the older press started the project');
    assert.equal(after.project.coordinator_enabled, true, 'with Automatic on');
    assert.equal(after.project.max_concurrent_tasks, 7, 'and its concurrency limit left alone');
    assert.equal(after.project.config_revision, '1');
    assert.deepEqual(after.bindings.map((row) => [row.integration_ref, row.integration_ref_source]),
      [[branch, 'EXPLICIT']]);
    assert.deepEqual(after.confirmations.map((row) => row.started_with),
      [{ settings, differsFromRequest: [] }]);
    const told = await startedTurns(byRule.sessionId);
    assert.equal(told.length, 1, 'and its coordinator was told, once');
    assert.ok(told[0].content.includes(`It runs with: tasks land on the project branch project/${
      uuidToBase62(byRule.id)} first · Automatic on · at most 7 tasks at a time · no merge check.`),
    told[0].content);
    assert.deepEqual((await queuedCard(byRule.sessionId))?.settings, settings);

    // The same door on a project whose tasks do not wait on each other: the rule says main.
    const independent = await coordinated('old-door-independent');
    await acceptance.confirmStandardSet(ownerId, independent.id, {
      criteriaDigest: await seal(independent.id),
    });
    const straight = await world(independent.id, independent.sessionId);
    assert.ok(straight.project.started_at);
    assert.deepEqual(straight.bindings.map((row) => [row.integration_ref, row.integration_ref_source]),
      [['refs/heads/main', 'EXPLICIT']]);
    assert.deepEqual((straight.confirmations[0].started_with as { settings: unknown }).settings, {
      line: 'MAIN',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: null,
    });
  });

  // ═══ (8) …and on a started project it only confirms ════════════════════════════════════════════

  await t.test('(8) acceptance/confirmation on a started project confirms and writes nothing else', async () => {
    // The owner turns Automatic off after the start, and then the criteria move.
    await projects.update(ownerId, byRule.id, { coordinatorEnabled: false } as never);
    await state(byRule.id, [FIRST, SECOND, ADDED]);
    const before = await world(byRule.id, byRule.sessionId);
    assert.equal(before.project.coordinator_enabled, false);
    assert.equal(before.project.config_revision, '2');

    // The seal it names is still compared (the existing compare-and-set on the version).
    const stale = before.confirmations[0].criteria_digest;
    const refusedStale = await refused(() => acceptance.confirmStandardSet(ownerId, byRule.id, {
      criteriaDigest: stale,
    }));
    assert.equal(refusedStale.status, 409);
    assert.equal(refusedStale.body.code, 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');
    assert.deepEqual(await world(byRule.id, byRule.sessionId), before);

    const standing = await acceptance.confirmStandardSet(ownerId, byRule.id, {
      criteriaDigest: await seal(byRule.id),
    });
    assert.equal(standing.state, 'CONFIRMED');
    const after = await world(byRule.id, byRule.sessionId);
    assert.equal(after.confirmations.length, 2, 'a second confirmation, appended');
    assert.equal(after.confirmations[1].started_with, null, 'which started nothing');
    assert.deepEqual(after.project, before.project,
      'and nothing on the project moved: not the start, not Automatic, not the revision');
    assert.deepEqual(after.bindings, before.bindings);
    assert.equal(after.turns, before.turns, 'nor was the coordinator told of a start');
  });

  // ═══ (9) the backfill ══════════════════════════════════════════════════════════════════════════

  await t.test('(9) the backfill: the earliest of confirmation, Automatic and task work; else unstarted', async () => {
    const at = (iso: string) => new Date(iso);
    const project = async (label: string, data: { coordinatorEnabled?: boolean; createdAt: Date }) => {
      const id = randomUUID();
      await prisma.project.create({
        data: { id, ownerId, title: `backfill ${label}`, ...data },
      });
      return id;
    };
    const taskIn = async (projectId: string) => {
      const id = randomUUID();
      await prisma.task.create({
        data: {
          id,
          ownerId,
          projectId,
          title: `work of ${projectId}`,
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          status: TaskStatus.OPEN,
          completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
        },
      });
      return id;
    };
    const session = async (taskId: string, startsTaskWork: boolean, createdAt: Date) => {
      await prisma.session.create({
        data: {
          ownerId,
          creatorId: ownerId,
          taskId,
          title: 'a session that ran',
          prompt: 'run it',
          provider: 'claude',
          status: RunStatus.SUCCEEDED,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork,
          createdAt,
        },
      });
    };
    const confirmation = async (projectId: string, confirmedAt: Date) => {
      await prisma.projectStandardSetConfirmation.create({
        data: {
          projectId,
          ownerId,
          confirmedById: ownerId,
          criteriaDigest: 'a'.repeat(64),
          criteriaMaterial: [],
          confirmedAt,
        },
      });
    };

    // One per source…
    const confirmed = await project('confirmed', { createdAt: at('2026-01-01T00:00:00.000Z') });
    await confirmation(confirmed, at('2026-01-02T03:04:05.678Z'));
    const switchedOn = await project('switched on', {
      coordinatorEnabled: true, createdAt: at('2026-02-03T04:05:06.789Z'),
    });
    const worked = await project('worked', { createdAt: at('2026-03-01T00:00:00.000Z') });
    const workedTask = await taskIn(worked);
    await session(workedTask, true, at('2026-03-05T00:00:00.000Z'));
    await session(workedTask, true, at('2026-03-04T05:06:07.890Z'));
    // …the earliest of several, where the creation of a switched-on project is only a fallback…
    const several = await project('several', {
      coordinatorEnabled: true, createdAt: at('2026-04-01T00:00:00.000Z'),
    });
    await confirmation(several, at('2026-04-09T00:00:00.000Z'));
    await session(await taskIn(several), true, at('2026-04-05T06:07:08.901Z'));
    // …and none: a session that did not start task work is not a start.
    const none = await project('none', { createdAt: at('2026-05-01T00:00:00.000Z') });
    await session(await taskIn(none), false, at('2026-05-02T00:00:00.000Z'));

    const ids = [confirmed, switchedOn, worked, several, none];
    const { rows: fresh } = await sql.query<{ id: string; started_at: Date | null }>(
      `SELECT "id", "started_at" FROM "project" WHERE "id" = ANY($1::uuid[])`, [ids],
    );
    assert.ok(fresh.every((row) => row.started_at === null), 'the fixtures start unstarted');

    // Replayed straight out of the migration, inside a transaction this test rolls back: the
    // statement runs over every project in the database, and the others are not this case's.
    const start = MIGRATION.indexOf('UPDATE "project" p');
    assert.ok(start >= 0, 'the backfill is no longer where this file reads it from');
    const backfill = MIGRATION.slice(start, MIGRATION.indexOf(';', start) + 1);
    await sql.query('BEGIN');
    try {
      await sql.query(backfill);
      const { rows } = await sql.query<{ id: string; started_at: Date | null }>(
        `SELECT "id", "started_at" FROM "project" WHERE "id" = ANY($1::uuid[])`, [ids],
      );
      const startedAt = new Map(rows.map((row) => [row.id, row.started_at?.toISOString() ?? null]));
      assert.deepEqual(Object.fromEntries(ids.map((id) => [id, startedAt.get(id)])), {
        [confirmed]: '2026-01-02T03:04:05.678Z',
        [switchedOn]: '2026-02-03T04:05:06.789Z',
        [worked]: '2026-03-04T05:06:07.890Z',
        [several]: '2026-04-05T06:07:08.901Z',
        [none]: null,
      });
    } finally {
      await sql.query('ROLLBACK');
    }
  });

  // ═══ (10) a project with no repository ═════════════════════════════════════════════════════════

  await t.test('(10) with no repository, a start on main writes no line, and a branch is refused', async () => {
    const bare = await coordinated('no-repository', { repoUrl: null });
    const digest = await seal(bare.id);
    const before = await world(bare.id, bare.sessionId);
    const onBranch = await press(bare.id, {
      criteriaDigest: digest,
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: null,
    });
    assert.equal(onBranch.status, 409);
    assert.equal(onBranch.json.code, 'INTEGRATION_REPOSITORY_UNKNOWN');
    assert.deepEqual(await world(bare.id, bare.sessionId), before, 'a refused start wrote something');

    const onMain = await press(bare.id, {
      criteriaDigest: digest,
      line: 'MAIN',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: null,
    });
    assert.equal(onMain.status, 201, JSON.stringify(onMain.json));
    assert.deepEqual(onMain.json.settings, {
      line: 'MAIN', automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: null,
    });
    const after = await world(bare.id, bare.sessionId);
    assert.ok(after.project.started_at);
    assert.deepEqual(after.bindings, [], 'nothing to bind, so nothing is');
  });
});
