/**
 * A caller's `idempotencyKey` on a task create (docs/orbit-agent-contract.md §5.2, gap G5), through the
 * runner's task door — the door `orbit task create --idempotency-key` and the MCP `task_create` reach —
 * over real HTTP and a real PostgreSQL.
 *
 * The client half is runner-go's tool_contract_test.go, which pins that the key is sent, that a keyed
 * create whose answer was lost is resent under the same key and a keyless one is not, and what the
 * receipt says. This pins what the server does with the key, which is the only place a retry can be
 * recognised for what it is:
 *
 *   (1) the same key sent twice by one session answers with the task the first send wrote, and the
 *       table holds one row — the duplicate submission;
 *   (2) the same key with a different title is refused 409 and writes nothing;
 *   (3) another session's create under the same key is its own task: a key is the session's;
 *   (4) without a key, two identical creates outside a live turn write two rows — the non-idempotent
 *       retry the receipt tells a caller to re-read before making;
 *   (5) a batch's key answers a resend with the rows the first send wrote, item for item; a key on an
 *       item is refused 400;
 *   (6) a blank key is refused 400, and the key survives main.ts's pipe (`whitelist: true` would strip
 *       a field the DTO did not declare, which would read as case (1) failing);
 *   (7) a person's create, with no session, is keyed to the account.
 *
 * Every create names its acting session and carries that session's answered card, as the runner door
 * requires once it is carded by caller (`task-write-approval.ts`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-task-create-idempotency-key.pg.spec.ts
 *
 * Not destructive: every id is generated here and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksService } from '../tasks/tasks.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerTasksController } from './runner-tasks.controller';

declare global {
  interface BigInt { toJSON(): string; }
}
// As main.ts does before it creates the app: a task row carries BIGINT counters.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Reply {
  status: number;
  body: any;
  text: string;
}

/** Every task here declares EXECUTABLE: a criterion that needs no project to stand on. */
const EXECUTABLE = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };

test('a caller idempotency key makes a task create safe to send again', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const prisma = prismaClientFor(url);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // Nothing here starts a run: every task is unassigned and none of these routes dispatches.
  const refuse = (what: string) => () => {
    throw new Error(`${what} is out of scope for the runner task door under test`);
  };
  const tasks = new TasksService(
    prisma as unknown as PrismaService,
    {
      create: refuse('sessions.create'),
      resume: refuse('sessions.resume'),
      createTurn: refuse('sessions.createTurn'),
      cancel: refuse('sessions.cancel'),
    } as never,
    { publishForUser: () => undefined, publishTaskChanged: () => undefined } as unknown as RealtimeService,
  );

  @Module({
    controllers: [RunnerTasksController],
    providers: [
      { provide: TasksService, useValue: tasks },
      { provide: TaskListsService, useValue: {} },
      { provide: ProjectAttributionService, useValue: {} },
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class RunnerTaskDoorModule {}

  app = await NestFactory.create(RunnerTaskDoorModule, { logger: false, abortOnError: false });
  // main.ts's pieces in main.ts's order, so every answer, a refusal body included, is a runner's.
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────

  const owner = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'task create idempotency key','h')`,
    [owner, `${owner}@task-create-idempotency-key.invalid`],
  );
  const token = `runner-token-${randomUUID()}`;
  const runnerId = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'task create idempotency key',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[])`,
    [runnerId, owner, sha256(token)],
  );
  // Two live sessions on this runner, neither with a turn in flight: a key must work with no turn,
  // which is the case it exists for (a retry in a LATER turn).
  const newSession = async () => {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, title: 'task create idempotency key', prompt: 'task create idempotency key', ownerId: owner,
        creatorId: owner, assignedRunnerId: runnerId, status: 'AWAITING_INPUT', startedAt: new Date(),
        runtimeSessionId: `runtime-${id}`, provider: 'claude',
      },
    });
    return id;
  };
  const sessionA = await newSession();
  const sessionB = await newSession();
  const card = (sessionId: string, toolName: string, input: Record<string, unknown>) => prisma.approval.create({
    data: { sessionId, toolName, input: input as never, status: 'ALLOWED', decidedById: owner, decidedAt: new Date() },
  });

  async function send(sessionId: string, route: string, body: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(`${base}/api/runner/${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-orbit-session-id': uuidToBase62(sessionId),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Left empty: every assertion on it prints the text.
    }
    return { status: response.status, body: parsed, text };
  }

  async function create(sessionId: string, body: Record<string, unknown>): Promise<Reply> {
    await card(sessionId, 'orbit_task_create', body);
    return send(sessionId, 'tasks', body);
  }

  async function rowsTitled(title: string): Promise<string[]> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "task" WHERE "owner_id" = $1::uuid AND "title" = $2 ORDER BY "created_at"`,
      [owner, title],
    );
    return rows.map((row) => row.id);
  }

  await t.test('(1) the same key twice answers with the first task and writes one row', async () => {
    const title = `filed once ${randomUUID()}`;
    const body = { title, ...EXECUTABLE, idempotencyKey: `file-${title}` };
    const first = await create(sessionA, body);
    assert.equal(first.status, 201, first.text);
    const second = await create(sessionA, body);
    assert.equal(second.status, 201, second.text);
    assert.equal(second.body.id, first.body.id, 'the resend wrote a second task');
    const rows = await rowsTitled(title);
    assert.equal(rows.length, 1, `rows: ${rows.join(', ')}`);
    assert.equal(uuidToBase62(rows[0]), first.body.id);
  });

  await t.test('(2) the same key with a different title is refused and writes nothing', async () => {
    const title = `keyed ${randomUUID()}`;
    const key = `reused-${title}`;
    assert.equal((await create(sessionA, { title, ...EXECUTABLE, idempotencyKey: key })).status, 201);
    const changed = `${title} renamed`;
    const refused = await create(sessionA, { title: changed, ...EXECUTABLE, idempotencyKey: key });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, /idempotency key is already held by a different write/);
    assert.deepEqual(await rowsTitled(changed), []);
    assert.equal((await rowsTitled(title)).length, 1);
  });

  await t.test("(3) another session's create under the same key is its own task", async () => {
    const title = `two conversations ${randomUUID()}`;
    const body = { title, ...EXECUTABLE, idempotencyKey: `shared-${title}` };
    const fromA = await create(sessionA, body);
    const fromB = await create(sessionB, body);
    assert.equal(fromA.status, 201, fromA.text);
    assert.equal(fromB.status, 201, fromB.text);
    assert.notEqual(fromA.body.id, fromB.body.id);
    assert.equal((await rowsTitled(title)).length, 2);
  });

  await t.test('(4) without a key, an identical create sent again writes again', async () => {
    const title = `not keyed ${randomUUID()}`;
    const body = { title, ...EXECUTABLE };
    const first = await create(sessionA, body);
    const again = await create(sessionA, body);
    assert.equal(first.status, 201, first.text);
    assert.equal(again.status, 201, again.text);
    assert.notEqual(first.body.id, again.body.id);
    assert.equal((await rowsTitled(title)).length, 2);
  });

  await t.test("(5) a batch's key answers a resend item for item; an item may not carry one", async () => {
    const stem = randomUUID();
    const items = [
      { title: `batch first ${stem}`, ...EXECUTABLE, ref: 'one' },
      { title: `batch second ${stem}`, ...EXECUTABLE, dependsOnRefs: ['one'] },
    ];
    const body = { tasks: items, idempotencyKey: `plan-${stem}` };
    await card(sessionA, 'orbit_task_batch', { tasks: items });
    const first = await send(sessionA, 'tasks/batch-create', body);
    assert.equal(first.status, 201, first.text);
    const again = await send(sessionA, 'tasks/batch-create', body);
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.body.map((row: { id: string }) => row.id), first.body.map((row: { id: string }) => row.id));
    assert.equal((await rowsTitled(`batch first ${stem}`)).length, 1);
    assert.equal((await rowsTitled(`batch second ${stem}`)).length, 1);

    const keyedItems = [{ title: `keyed item ${stem}`, ...EXECUTABLE, idempotencyKey: 'mine' }];
    await card(sessionA, 'orbit_task_batch', { tasks: keyedItems });
    const refused = await send(sessionA, 'tasks/batch-create', { tasks: keyedItems });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.text, /keyed as a whole/);
    assert.deepEqual(await rowsTitled(`keyed item ${stem}`), []);
  });

  await t.test('(6) a blank key is refused', async () => {
    const title = `blank key ${randomUUID()}`;
    const refused = await create(sessionA, { title, ...EXECUTABLE, idempotencyKey: '   ' });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(await rowsTitled(title), []);
  });

  await t.test("(7) a person's create with no session is keyed to the account", async () => {
    const title = `a person's own ${randomUUID()}`;
    const dto = { title, ...EXECUTABLE, idempotencyKey: `mine-${title}` } as never;
    const first = await tasks.create(owner, dto);
    const again = await tasks.create(owner, dto);
    assert.equal(again.id, first.id);
    assert.equal((await rowsTitled(title)).length, 1);
  });
});
