/**
 * Pause project and Resume project tell the conversation the project is coordinated from.
 *
 * Both presses are driven through their real HTTP routes, controller and service. Each fact gets
 * one durable turn keyed by the pause episode's `paused_at`; a repeated press changes nothing and
 * says nothing. The turns remain ordinary messages rather than ProjectStarted cards, and a request
 * carrying an acting session is refused before either the project row or its conversation moves.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-pause-tells-coordinator.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { uuidToBase62 } from '@orbit/shared';
import type { ProjectStartedCard } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const PREFIX = 'project-started:v1:';

interface Fixture {
  id: string;
  title: string;
  sessionId: string | null;
  heldId: string | null;
}

interface Notice {
  clientTurnId: string;
  content: string;
}

test('Pause and Resume tell the coordinator once per changed pause episode', {
  skip,
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma, sessions);
  const projects = new ProjectsService(prisma, acceptance, sessions, realtime);

  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `pause-tells-${ownerId}@project.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });

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
  class PauseDoorModule {}

  const app = await NestFactory.create(PauseDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  async function press(
    projectId: string,
    action: 'pause' | 'resume',
    sessionHeader?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(
      `${base}/api/projects/${uuidToBase62(projectId)}/${action}`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer the-account-owner',
          ...(sessionHeader ? { 'x-orbit-session-id': sessionHeader } : {}),
        },
      },
    );
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  async function fixture(label: string, coordinated = true): Promise<Fixture> {
    const id = randomUUID();
    const title = `${label} project`;
    let workspaceId: string | null = null;
    let sessionId: string | null = null;
    if (coordinated) {
      const runnerId = randomUUID();
      workspaceId = randomUUID();
      sessionId = randomUUID();
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
        },
      });
      await db.session.create({
        data: {
          id: sessionId,
          ownerId,
          creatorId: ownerId,
          workspaceId,
          assignedRunnerId: runnerId,
          title: `Coordinate ${label}`,
          prompt: `Coordinate ${label}`,
          provider: 'claude',
          status: RunStatus.AWAITING_INPUT,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startedAt: new Date(),
          runtimeSessionId: randomUUID(),
        },
      });
      await db.conversationTurn.create({
        data: {
          sessionId,
          seq: 1,
          clientTurnId: SessionsService.initialTurnClientId(sessionId),
          kind: 'message',
          content: `Coordinate ${label}`,
          status: 'ANSWERED',
        },
      });
    }
    await db.project.create({
      data: {
        id,
        ownerId,
        title,
        startedAt: new Date(),
        coordinatorEnabled: true,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: sessionId,
      },
    });
    if (!workspaceId) return { id, title, sessionId, heldId: null };

    const heldId = randomUUID();
    for (const [taskId, taskTitle, autoRunWhenReady] of [
      [randomUUID(), `${label} automatic task`, true],
      [heldId, `${label} manual task`, false],
    ] as const) {
      await db.task.create({
        data: {
          id: taskId,
          ownerId,
          projectId: id,
          title: taskTitle,
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
    return { id, title, sessionId, heldId };
  }

  async function notices(sessionId: string): Promise<Notice[]> {
    const rows = await db.conversationTurn.findMany({
      where: { sessionId, clientTurnId: { startsWith: PREFIX } },
      select: { clientTurnId: true, content: true },
      orderBy: { seq: 'asc' },
    });
    return rows.map((row) => ({ clientTurnId: row.clientTurnId!, content: row.content ?? '' }));
  }

  async function pauseState(projectId: string) {
    return db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { pausedAt: true, pausedReason: true },
    });
  }

  await t.test('a changed Pause and Resume each append one fact-keyed ordinary message', async () => {
    const f = await fixture('moves');
    const sessionId = f.sessionId!;
    assert.deepEqual(await notices(sessionId), []);

    const paused = await press(f.id, 'pause');
    assert.equal(paused.status, 201, JSON.stringify(paused.json));
    assert.equal(paused.json.pausedReason, 'OWNER');
    const pausedAt = new Date(String(paused.json.pausedAt));
    assert.ok(Number.isFinite(pausedAt.getTime()), 'the pause response did not name its fact');

    let told = await notices(sessionId);
    assert.equal(told.length, 1, 'Pause did not add exactly one turn');
    assert.equal(
      told[0].clientTurnId,
      `${PREFIX}pause:${f.id}:${pausedAt.getTime()}`,
      'Pause is not keyed by the pause episode it wrote',
    );
    assert.equal(told[0].content, [
      'From Orbit · project paused',
      `The account owner paused project “${f.title}” (${uuidToBase62(f.id)}).`,
      'While the project is paused, task_start is refused with 409 PROJECT_PAUSED. Orbit does '
        + 'not start any of this project’s tasks automatically and does not merge anything into '
        + 'main automatically. Sessions already running are not affected.',
      'This is a notification, not a request to start work. The project stays paused until the '
        + 'account owner presses Resume project.',
    ].join('\n\n'));

    assert.equal((await press(f.id, 'pause')).status, 201);
    assert.equal((await notices(sessionId)).length, 1, 'a repeated Pause said the same fact again');

    const resumed = await press(f.id, 'resume');
    assert.equal(resumed.status, 201, JSON.stringify(resumed.json));
    assert.equal(resumed.json.pausedAt, null);
    told = await notices(sessionId);
    assert.equal(told.length, 2, 'Resume did not add exactly one turn');
    assert.equal(
      told[1].clientTurnId,
      `${PREFIX}resume:${f.id}:${pausedAt.getTime()}`,
      'Resume is not keyed by the pause episode it lifted',
    );
    assert.match(told[1].content, /^From Orbit · project resumed\n\n/);
    assert.ok(told[1].content.includes(
      `The account owner resumed project “${f.title}” (${uuidToBase62(f.id)})`,
    ));
    assert.ok(told[1].content.includes(
      'From now on Orbit starts this project’s tasks that are set to run on their own '
        + '(autoRunWhenReady), within its concurrency limit.',
    ));
    assert.ok(told[1].content.includes(
      `- moves manual task (${uuidToBase62(f.heldId!)})`,
    ), 'Resume did not name the task waiting on the coordinator');

    assert.equal((await press(f.id, 'resume')).status, 201);
    assert.equal((await notices(sessionId)).length, 2, 'a repeated Resume said the same fact again');

    const queued = await sessions.listQueuedTurns(ownerId, sessionId, 'active') as Array<{
      projectStarted?: ProjectStartedCard;
    }>;
    assert.equal(queued.length, 2, 'the two notifications are not the two queued turns');
    assert.deepEqual(queued.map((turn) => turn.projectStarted), [undefined, undefined],
      'Pause or Resume was projected as a Project started card');
  });

  await t.test('claiming a legacy Automatic-off pause is a changed Pause, once', async () => {
    const f = await fixture('legacy');
    await projects.update(ownerId, f.id, { coordinatorEnabled: false } as never);
    const before = await pauseState(f.id);
    assert.ok(before.pausedAt);
    assert.equal(before.pausedReason, 'LEGACY_AUTOMATIC_OFF');
    assert.deepEqual(await notices(f.sessionId!), []);

    const claimed = await press(f.id, 'pause');
    assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
    assert.equal(claimed.json.pausedReason, 'OWNER');
    assert.equal(claimed.json.pausedAt, before.pausedAt!.toISOString(),
      'claiming the pause changed the pause episode');
    const told = await notices(f.sessionId!);
    assert.equal(told.length, 1);
    assert.equal(told[0].clientTurnId, `${PREFIX}pause:${f.id}:${before.pausedAt!.getTime()}`);

    await press(f.id, 'pause');
    assert.equal((await notices(f.sessionId!)).length, 1,
      'the owner pause was announced again after it was already theirs');
  });

  await t.test('a project with no coordinator succeeds and has nobody to tell', async () => {
    const f = await fixture('uncoordinated', false);
    const paused = await press(f.id, 'pause');
    assert.equal(paused.status, 201, JSON.stringify(paused.json));
    const resumed = await press(f.id, 'resume');
    assert.equal(resumed.status, 201, JSON.stringify(resumed.json));
    assert.deepEqual(await pauseState(f.id), { pausedAt: null, pausedReason: null });
  });

  await t.test('an ended coordinator is not revived for either notification', async () => {
    const f = await fixture('ended');
    await db.session.update({
      where: { id: f.sessionId! },
      data: { status: RunStatus.FAILED, completedAt: new Date() },
    });
    const before = await db.conversationTurn.count({ where: { sessionId: f.sessionId! } });
    assert.equal((await press(f.id, 'pause')).status, 201);
    assert.equal((await press(f.id, 'resume')).status, 201);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: f.sessionId! } }), before,
      'Pause or Resume revived the ended coordinator');
  });

  await t.test('X-Orbit-Session-Id refuses both doors 403 and writes no row', async () => {
    const f = await fixture('session-header');
    const sessionId = f.sessionId!;
    const beforePause = {
      state: await pauseState(f.id),
      turns: await db.conversationTurn.count({ where: { sessionId } }),
    };
    const deniedPause = await press(f.id, 'pause', uuidToBase62(sessionId));
    assert.equal(deniedPause.status, 403);
    assert.equal(deniedPause.json.code, 'PROJECT_PAUSE_OWNER_ONLY');
    assert.deepEqual({
      state: await pauseState(f.id),
      turns: await db.conversationTurn.count({ where: { sessionId } }),
    }, beforePause, 'a refused Pause wrote the project or a turn');

    assert.equal((await press(f.id, 'pause')).status, 201, 'CONTROL: the owner could not pause');
    const beforeResume = {
      state: await pauseState(f.id),
      turns: await db.conversationTurn.count({ where: { sessionId } }),
    };
    const deniedResume = await press(f.id, 'resume', uuidToBase62(sessionId));
    assert.equal(deniedResume.status, 403);
    assert.equal(deniedResume.json.code, 'PROJECT_PAUSE_OWNER_ONLY');
    assert.deepEqual({
      state: await pauseState(f.id),
      turns: await db.conversationTurn.count({ where: { sessionId } }),
    }, beforeResume, 'a refused Resume wrote the project or a turn');

    assert.equal((await press(f.id, 'resume')).status, 201, 'CONTROL: the owner could not resume');
    assert.equal((await notices(sessionId)).length, 2,
      'the owner controls did not each produce their one notification');
  });
});
