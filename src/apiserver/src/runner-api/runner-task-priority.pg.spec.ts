/**
 * A task's priority written and read through the runner's task door — the door `orbit task update
 * --priority` and the MCP `task_update` reach, and the one `orbit task list --json` reads — over real
 * HTTP and a real PostgreSQL.
 *
 * The client half is runner-go's task_priority_test.go, which pins what each of those sends. This
 * pins what the server does with it, in main.ts's pipe, interceptor and filters: a field the DTO does
 * not declare is STRIPPED by that pipe (`whitelist: true`, `forbidNonWhitelisted: false`), so a
 * server that lost it would answer 200 and change nothing — which is why every write here is read
 * back over a second connection rather than trusted from its answer.
 *
 *   (1) PATCH tasks/:id with a priority stores it;
 *   (2) PATCH tasks/:id with priority null returns the task to 0;
 *   (3) a priority that is not an integer in the column's range is refused 400 and stores nothing;
 *   (4) GET tasks — the filtered page and the unfiltered list both — carries each row's priority.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-task-priority.pg.spec.ts
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
// `main.ts` installs this before it creates the app, and a task response needs it: the task row
// carries BIGINT counters that Prisma maps to native BigInts, which `JSON.stringify` throws on.
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

test('the runner task door stores, clears and reads back a task priority', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // Nothing here starts a run: every task this file makes is unassigned, and none of these routes
  // dispatches. A call that reaches the session layer anyway is a failure, not a no-op.
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
  // main.ts's pieces in main.ts's order, so every answer, a refusal body included, is what a runner receives.
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
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'runner task priority door','h')`,
    [owner, `${owner}@runner-task-priority.invalid`],
  );
  const token = `runner-token-${randomUUID()}`;
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'runner task priority door',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[])`,
    [randomUUID(), owner, sha256(token)],
  );
  const listId = randomUUID();
  await sql.query(
    `INSERT INTO "task_list"("id","owner_id","title","max_concurrent","updated_at")
     VALUES ($1,$2,'runner task priority door',1,clock_timestamp())`,
    [listId, owner],
  );

  async function priorityOf(taskId: string): Promise<number> {
    const { rows } = await sql.query<{ priority: number }>(
      `SELECT "priority" FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, `task ${taskId} is not in the table`);
    return rows[0].priority;
  }

  async function send(method: 'GET' | 'POST' | 'PATCH', route: string, body?: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(`${base}/api/runner/${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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

  const title = `prioritised through the runner door ${randomUUID()}`;
  const created = await send('POST', 'tasks', { title, listId: uuidToBase62(listId), ...EXECUTABLE });
  assert.equal(created.status, 201, created.text);
  const { rows: [{ id: task }] } = await sql.query<{ id: string }>(
    `SELECT "id" FROM "task" WHERE "owner_id" = $1::uuid AND "title" = $2`,
    [owner, title],
  );
  const other = `left alone through the runner door ${randomUUID()}`;
  assert.equal((await send('POST', 'tasks', { title: other, listId: uuidToBase62(listId), ...EXECUTABLE })).status, 201);
  const address = `tasks/${uuidToBase62(task)}`;

  await t.test('(1) PATCH tasks/:id with a priority stores it', async () => {
    assert.equal(await priorityOf(task), 0, 'a new task does not start at the default');
    const raised = await send('PATCH', address, { priority: 82 });
    assert.equal(raised.status, 200, raised.text);
    assert.equal(await priorityOf(task), 82);
    assert.equal(raised.body.priority, 82, 'the answer does not say what was stored');
  });

  await t.test('(2) PATCH tasks/:id with priority null returns the task to 0', async () => {
    assert.equal(await priorityOf(task), 82, 'case (1) left nothing to clear');
    const cleared = await send('PATCH', address, { priority: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(await priorityOf(task), 0);
  });

  await t.test('(3) a priority that is not an integer in range is refused and stores nothing', async () => {
    assert.equal((await send('PATCH', address, { priority: 7 })).status, 200);
    for (const bad of [1.5, '8', 2_147_483_648, -2_147_483_649]) {
      const refused = await send('PATCH', address, { priority: bad });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)}: ${refused.text}`);
      assert.match(refused.text, /priority/, `the refusal of ${JSON.stringify(bad)} does not name the field`);
    }
    assert.equal(await priorityOf(task), 7, 'a refused write moved the stored priority');
  });

  await t.test('(4) GET tasks carries each row\'s priority, filtered and unfiltered', async () => {
    const wanted = new Map([[uuidToBase62(task), 7]]);
    const page = await send('GET', `tasks?listId=${uuidToBase62(listId)}`);
    assert.equal(page.status, 200, page.text);
    const pageRows = (page.body as Array<{ id: string; title: string; priority: number }>);
    assert.equal(pageRows.length, 2);
    for (const row of pageRows) {
      assert.equal(row.priority, wanted.get(row.id) ?? 0, `${row.title} reads ${row.priority}`);
    }
    const all = await send('GET', 'tasks');
    assert.equal(all.status, 200, all.text);
    const ours = (all.body as Array<{ id: string; priority: number }>).filter((row) => wanted.has(row.id));
    assert.deepEqual(ours.map((row) => row.priority), [7], 'the unfiltered list does not carry the priority');
  });
});
