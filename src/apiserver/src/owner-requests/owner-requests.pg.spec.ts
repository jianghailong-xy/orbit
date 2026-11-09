/**
 * OWNER REQUESTS: ANY SESSION FILES ONE, AND EVERY ENDING IS FINAL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/owner-requests.pg.spec.ts
 *
 * THE CASES
 * =========
 *   (a) a session that is NOT its project's coordinator — refused by ask_owner — files one request of
 *       each kind (DECISION, SECRET, MANUAL_STEP, CONFIRM) through the runner door, and each reads
 *       back PENDING, from the owner's list and by id, with what it asked; the owner is told once each;
 *   (b) the same clientRequestId again is the same request, and the owner is not told twice;
 *   (c) a filing its kind cannot carry, or naming what the account does not have, writes nothing;
 *   (d) every legal transition: PENDING → DONE, DECLINED, WITHDRAWN, EXPIRED;
 *   (e) every illegal one: from each terminal state, each of the four endings is refused (409) or
 *       matches nothing (the sweep), and the row is unchanged;
 *   (f) a PENDING request past its deadline is refused as expired before the sweep reaches it;
 *       only the asker may withdraw; a decline needs a reason; a runner cannot speak for a session
 *       it does not host.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, type Runner } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { ASK_OWNER_COORDINATOR_ONLY, ProjectOpenItemService } from '../projects/project-open-item.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerOwnerRequestsController } from '../runner-api/runner-owner-requests.controller';
import {
  OWNER_REQUEST_EXPIRED,
  OWNER_REQUEST_NOT_ASKER,
  OWNER_REQUEST_NOT_PENDING,
  OWNER_REQUEST_STATES,
  canTransition,
  type OwnerRequestState,
} from './owner-request';
import { OwnerRequestsService, type OwnerRequestView } from './owner-requests.service';
import type { FileOwnerRequestDto } from './dto';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Account {
  ownerId: string;
  runner: Runner;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** A task's own run: a session of the project that is not its coordinator. */
  workerSessionId: string;
  taskId: string;
}

type Ending = 'DONE' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';
const ENDINGS: readonly Ending[] = ['DONE', 'DECLINED', 'WITHDRAWN', 'EXPIRED'];

test('owner requests: any session files one, and every ending is final', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const prisma = db as unknown as PrismaService;
  const told: string[] = [];
  const push = { notifyOwnerRequest: async (id: string) => { told.push(id); } } as unknown as PushService;
  const service = new OwnerRequestsService(prisma, push);
  const door = new RunnerOwnerRequestsController(prisma, service);
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const openItems = new ProjectOpenItemService(prisma, new SessionsService(prisma, queue, realtime));

  const a = await account(db, 'main');

  /** A request filed by the worker session through the runner door, which is how a session reaches it. */
  const file = (body: Partial<FileOwnerRequestDto> & Pick<FileOwnerRequestDto, 'kind'>, acc: Account = a) =>
    door.file(acc.runner, acc.workerSessionId, {
      title: `a ${body.kind} request`,
      why: 'the task cannot go on without it',
      ...body,
    } as FileOwnerRequestDto);

  const code = (error: unknown): string | undefined =>
    ((error as HttpException).getResponse?.() as { code?: string } | undefined)?.code;

  await t.test('(a) a non-coordinator session files each of the four kinds, and each reads back PENDING', async () => {
    // The contrast: ask_owner refuses this very session, because it is not the project's coordinator.
    await assert.rejects(
      openItems.askOwner(a.ownerId, a.projectId, a.workerSessionId, { question: 'which one?' }),
      (e) => e instanceof ForbiddenException && code(e) === ASK_OWNER_COORDINATOR_ONLY,
    );

    told.length = 0;
    const decision = await file({
      kind: 'DECISION',
      title: 'Which database should the cache use?',
      options: [{ label: 'Redis', description: 'already deployed' }, { label: 'Postgres' }],
      recommendedOption: 0,
      blocksTaskIds: [a.taskId],
      ifUnanswered: 'I will use Redis',
      projectId: a.projectId,
      clientRequestId: 'decision-1',
    });
    const secret = await file({
      kind: 'SECRET',
      title: 'Stripe test key',
      secretSpec: { name: 'Stripe test key', runnerId: a.runner.id, envVar: 'STRIPE_KEY' },
      verifyHint: 'curl https://api.stripe.com/v1/balance answers 200',
    });
    const step = await file({
      kind: 'MANUAL_STEP',
      title: 'Approve the OAuth app',
      steps: [
        { text: 'Open the GitHub app settings', link: 'https://github.com/settings/apps' },
        { text: 'Run the install script', command: 'make install-app' },
        { text: 'Tell me when it is done' },
      ],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const confirm = await file({ kind: 'CONFIRM', title: 'Delete the staging bucket?' });

    const filed = [decision, secret, step, confirm];
    assert.deepEqual(filed.map((r) => r.kind), ['DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM']);
    for (const request of filed) {
      assert.equal(request.state, 'PENDING');
      assert.equal(request.askedBySessionId, a.workerSessionId, 'filed by the worker, not the coordinator');
      const byId = await service.get(a.ownerId, request.id);
      assert.equal(byId.state, 'PENDING', `${request.kind} reads back PENDING by id`);
      assert.equal(byId.resolvedAt, null);
    }
    const open = (await service.list(a.ownerId, 'open')).requests.map((r) => r.id).sort();
    assert.deepEqual(open, filed.map((r) => r.id).sort(), 'all four are in the owner’s open list');
    assert.deepEqual([...told].sort(), filed.map((r) => r.id).sort(), 'the owner is told once about each');

    assert.deepEqual(decision.options, [{ label: 'Redis', description: 'already deployed' }, { label: 'Postgres' }]);
    assert.equal(decision.recommendedOption, 0);
    assert.deepEqual(decision.blocksTaskIds, [a.taskId]);
    assert.equal(decision.projectId, a.projectId);
    assert.equal(decision.ifUnanswered, 'I will use Redis');
    assert.deepEqual(secret.secretSpec, { name: 'Stripe test key', runnerId: a.runner.id, envVar: 'STRIPE_KEY' },
      'where the secret goes, and no value');
    assert.equal(secret.verifyHint, 'curl https://api.stripe.com/v1/balance answers 200');
    assert.equal((step.steps as unknown[]).length, 3);
    assert.ok(step.expiresAt instanceof Date);
    assert.equal(confirm.options, null);
  });

  await t.test('(b) the same clientRequestId is the same request, told once', async () => {
    told.length = 0;
    const first = await file({ kind: 'CONFIRM', title: 'Ship it?', clientRequestId: 'retry-me' });
    const again = await file({ kind: 'CONFIRM', title: 'Ship it?', clientRequestId: 'retry-me' });
    assert.equal(again.id, first.id);
    assert.deepEqual(told, [first.id]);
    const rows = await db.ownerRequest.count({ where: { askedBySessionId: a.workerSessionId, clientRequestId: 'retry-me' } });
    assert.equal(rows, 1);
    // Ended, then retried: the retry reads the ended request rather than filing a second one.
    await service.complete(a.ownerId, first.id, {});
    const late = await file({ kind: 'CONFIRM', title: 'Ship it?', clientRequestId: 'retry-me' });
    assert.equal(late.id, first.id);
    assert.equal(late.state, 'DONE');
  });

  await t.test('(c) a filing its kind cannot carry writes nothing', async () => {
    const before = await db.ownerRequest.count({ where: { ownerId: a.ownerId } });
    const refused = [
      () => file({ kind: 'MANUAL_STEP', title: 'no steps' }),
      () => file({ kind: 'SECRET', title: 'no spec' }),
      () => file({ kind: 'SECRET', secretSpec: { name: 'k', runnerId: a.runner.id } }),
      () => file({ kind: 'SECRET', secretSpec: { name: 'k', runnerId: a.runner.id, envVar: 'A', filePath: '/x' } }),
      () => file({ kind: 'SECRET', secretSpec: { name: 'k', runnerId: a.runner.id, envVar: 'not a name' } }),
      () => file({ kind: 'CONFIRM', options: [{ label: 'x' }] }),
      () => file({ kind: 'DECISION', options: [{ label: 'x' }], recommendedOption: 1 }),
      () => file({ kind: 'CONFIRM', expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      () => file({ kind: 'CONFIRM', title: '   ' }),
    ];
    for (const attempt of refused) await assert.rejects(attempt(), BadRequestException);
    const other = await account(db, 'other');
    await assert.rejects(file({ kind: 'CONFIRM', blocksTaskIds: [other.taskId] }), NotFoundException);
    await assert.rejects(file({ kind: 'CONFIRM', projectId: other.projectId }), NotFoundException);
    await assert.rejects(
      file({ kind: 'SECRET', secretSpec: { name: 'k', runnerId: other.runner.id, envVar: 'K' } }),
      NotFoundException,
    );
    assert.equal(await db.ownerRequest.count({ where: { ownerId: a.ownerId } }), before);
  });

  /** One PENDING request moved to `ending` by the door that writes it. */
  const end = async (id: string, ending: Ending): Promise<OwnerRequestView> => {
    switch (ending) {
      case 'DONE': return service.complete(a.ownerId, id, { text: 'done' });
      case 'DECLINED': return service.decline(a.ownerId, id, 'not now');
      case 'WITHDRAWN': return door.withdraw(a.runner, a.workerSessionId, id, { reason: 'no longer needed' });
      case 'EXPIRED': {
        await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
        const swept = await service.expireDue(new Date());
        assert.ok(swept.includes(id), 'the sweep expires a PENDING request past its deadline');
        return service.get(a.ownerId, id);
      }
    }
  };

  await t.test('(d) every legal transition: PENDING → DONE, DECLINED, WITHDRAWN, EXPIRED', async () => {
    for (const ending of ENDINGS) {
      assert.ok(canTransition('PENDING', ending));
      const request = await file({ kind: 'CONFIRM', title: `to ${ending}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const ended = await end(request.id, ending);
      assert.equal(ended.state, ending);
      assert.ok(ended.resolvedAt instanceof Date, `${ending} records when it ended`);
      if (ending === 'DONE') {
        assert.deepEqual(ended.answer, { text: 'done' });
        assert.equal(ended.resolvedByUserId, a.ownerId);
      }
      if (ending === 'DECLINED') {
        assert.equal(ended.resolutionNote, 'not now');
        assert.equal(ended.resolvedByUserId, a.ownerId);
      }
      if (ending === 'WITHDRAWN') {
        assert.equal(ended.resolutionNote, 'no longer needed');
        assert.equal(ended.resolvedBySessionId, a.workerSessionId);
      }
    }
    // A DECISION is done with an option it offered, or with words.
    const decision = await file({ kind: 'DECISION', options: [{ label: 'A' }, { label: 'B' }] });
    await assert.rejects(service.complete(a.ownerId, decision.id, {}), BadRequestException);
    await assert.rejects(service.complete(a.ownerId, decision.id, { option: 2 }), BadRequestException);
    const chosen = await service.complete(a.ownerId, decision.id, { option: 1, text: ' because ' });
    assert.deepEqual(chosen.answer, { option: 1, text: 'because' });
    // The owner's lists by state.
    const done = (await service.list(a.ownerId, 'done')).requests.map((r) => r.id);
    assert.ok(done.includes(decision.id));
    const declined = (await service.list(a.ownerId, 'declined')).requests;
    assert.ok(declined.length >= 1 && declined.every((r) => r.state === 'DECLINED'));
    await assert.rejects(service.list(a.ownerId, 'nonsense'), BadRequestException);
  });

  await t.test('(e) every illegal transition: a terminal state is final', async () => {
    const terminal = OWNER_REQUEST_STATES.filter((s): s is Exclude<OwnerRequestState, 'PENDING'> => s !== 'PENDING');
    for (const from of terminal) {
      for (const to of ENDINGS) {
        assert.equal(canTransition(from, to), false, `${from} → ${to} is not in the table`);
        const request = await file({ kind: 'CONFIRM', title: `${from} then ${to}` });
        await end(request.id, from);
        const before = await db.ownerRequest.findUniqueOrThrow({ where: { id: request.id } });
        if (to === 'EXPIRED') {
          await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [request.id]);
          const swept = await service.expireDue(new Date());
          assert.ok(!swept.includes(request.id), `the sweep does not move a ${from} request`);
        } else {
          await assert.rejects(
            end(request.id, to),
            (e) => e instanceof ConflictException && code(e) === OWNER_REQUEST_NOT_PENDING,
            `${from} → ${to} is refused`,
          );
        }
        const after = await db.ownerRequest.findUniqueOrThrow({ where: { id: request.id } });
        assert.equal(after.state, from);
        assert.equal(after.resolutionNote, before.resolutionNote);
        assert.deepEqual(after.answer, before.answer);
        assert.deepEqual(after.resolvedAt, before.resolvedAt);
      }
    }
  });

  await t.test('(f) deadline, asker, reason and host are each enforced', async () => {
    // Past its deadline but not yet swept: no ending but EXPIRED.
    const late = await file({ kind: 'CONFIRM', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [late.id]);
    for (const ending of ['DONE', 'DECLINED', 'WITHDRAWN'] as const) {
      await assert.rejects(end(late.id, ending), (e) => e instanceof ConflictException && code(e) === OWNER_REQUEST_EXPIRED);
    }
    assert.equal((await service.get(a.ownerId, late.id)).state, 'PENDING');
    assert.ok((await service.expireDue(new Date())).includes(late.id));
    assert.equal((await service.get(a.ownerId, late.id)).state, 'EXPIRED');

    // Only the session that asked may withdraw: not the coordinator, not the owner's door.
    const mine = await file({ kind: 'CONFIRM' });
    await assert.rejects(
      door.withdraw(a.runner, a.coordinatorSessionId, mine.id, {}),
      (e) => e instanceof ForbiddenException && code(e) === OWNER_REQUEST_NOT_ASKER,
    );
    // A decline needs its reason.
    await assert.rejects(service.decline(a.ownerId, mine.id, '   '), BadRequestException);
    assert.equal((await service.get(a.ownerId, mine.id)).state, 'PENDING');

    // A runner cannot file for, or read across to, another account's session or request.
    const other = await account(db, 'host');
    await assert.rejects(
      door.file(a.runner, other.workerSessionId, { kind: 'CONFIRM', title: 't', why: 'w' } as FileOwnerRequestDto),
      ForbiddenException,
    );
    await assert.rejects(door.file(a.runner, undefined, { kind: 'CONFIRM', title: 't', why: 'w' } as FileOwnerRequestDto), BadRequestException);
    await assert.rejects(door.get(other.runner, mine.id), NotFoundException);
    await assert.rejects(service.complete(other.ownerId, mine.id, {}), NotFoundException);
  });
});

/** An account with a runner, a project coordinated by one session, and a worker session beside it. */
async function account(db: PrismaClient, label: string): Promise<Account> {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-requests-${ownerId}@owner-requests.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  const runner = await db.runner.create({
    data: {
      id: randomUUID(),
      ownerId,
      name: `owner-requests-runner-${label}`,
      tokenHash: `hash-${randomUUID()}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: runner.id, name: `owner-requests-${label}`, enabled: true } });
  const session = async (title: string): Promise<string> => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runner.id,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
      },
    });
    return id;
  };
  const coordinatorSessionId = await session(`coordinator ${label}`);
  const workerSessionId = await session(`worker ${label}`);
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `owner requests: ${label}`,
      goal: 'any session can ask its owner to act',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `blocked work (${label})`,
      creatorType: 'USER',
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: 'OPEN',
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    },
  });
  return { ownerId, runner, workspaceId, projectId, coordinatorSessionId, workerSessionId, taskId };
}
