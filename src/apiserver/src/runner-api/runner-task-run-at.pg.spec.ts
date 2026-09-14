/**
 * A scheduled start written through the runner's task door lands on `task.run_at`: set on create,
 * cleared by an explicit null, moved by a new instant — over real HTTP and a real PostgreSQL.
 *
 * CreateTaskDto.runAt and UpdateTaskDto.runAt (omitted keeps the schedule, null cancels it, an
 * instant sets it) were already served here. What agents lacked was the client half: runner-go's
 * task_create, task_create_batch and task_update, and `orbit task create|update --run-at`, which
 * runner-go's task_run_at_test.go pins to the wire. This file pins the door those requests reach, so
 * a server-side regression cannot hide behind a client that now sends the field. It runs the real
 * RunnerAuthGuard over a real runner row, the real RunnerTasksController and TasksService, and
 * main.ts's pipe, interceptor and filters in main.ts's order, and it reads `run_at` over a second
 * connection after every write rather than trusting the answer that wrote it.
 *
 *   (1) POST tasks with runAt stores that instant;
 *   (2) PATCH tasks/:id with runAt null leaves the task unscheduled;
 *   (3) PATCH tasks/:id with a new instant stores the new one;
 *   (4) POST tasks/batch-create stores each item's own runAt, and none for the item that named none.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-task-run-at.pg.spec.ts
 *
 * Not destructive: every id is generated here and every assertion is scoped to the tasks it made.
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

/** The two appointments, in the spelling the database is read back in. */
const FIRST = '2026-09-21T12:34:00.000Z';
const MOVED = '2026-09-28T08:00:00.000Z';

/** An answer, kept as text as well: a body that is not JSON has to be readable in the failure. */
interface Reply {
  status: number;
  body: Record<string, any>;
  text: string;
}

/** Every task here declares EXECUTABLE: a criterion that needs no project to stand on. */
const EXECUTABLE = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };

test('the runner task door stores, clears and moves a scheduled start', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // Nothing here starts a run: every task this file makes is unassigned, and none of the three routes
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

  // ── fixtures, written the way the rest of the system writes them ───────────────────────────────

  async function insertOwner(): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'runner task run_at door','h')`,
      [id, `${id}@runner-task-run-at.invalid`],
    );
    return id;
  }

  /** A runner row for the owner, and the token the real guard finds it by: that row's owner scopes every request. */
  async function insertRunner(owner: string): Promise<string> {
    const token = `runner-token-${randomUUID()}`;
    await sql.query(
      `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
       VALUES ($1,'runner task run_at door',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[])`,
      [randomUUID(), owner, sha256(token)],
    );
    return token;
  }

  /** The one task this owner holds under that title. Titles carry a fresh uuid, so one is all there can be. */
  async function taskIdByTitle(owner: string, title: string): Promise<string> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "task" WHERE "owner_id" = $1::uuid AND "title" = $2`,
      [owner, title],
    );
    assert.equal(rows.length, 1, `expected exactly one task titled ${JSON.stringify(title)}`);
    return rows[0].id;
  }

  /**
   * `run_at` as the table holds it, or null. The column is TIMESTAMP(3) without a zone and Prisma writes
   * UTC into it, so the database spells the stored value itself rather than a driver reading it back in
   * this process's zone.
   */
  async function runAtOf(taskId: string): Promise<string | null> {
    const { rows } = await sql.query<{ run_at: string | null }>(
      `SELECT to_char("run_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "run_at" FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, `task ${taskId} is not in the table`);
    return rows[0].run_at;
  }

  // ── the door, addressed the way the runner addresses it ────────────────────────────────────────

  async function send(token: string, method: 'POST' | 'PATCH', route: string, body: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(`${base}/api/runner/${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text) as Record<string, any>;
    } catch {
      // Left empty: every assertion on it prints the text.
    }
    return { status: response.status, body: parsed, text };
  }

  const owner = await insertOwner();
  const token = await insertRunner(owner);
  let scheduled = '';

  // ═══ (1) create ═══════════════════════════════════════════════════════════════════════════════

  await t.test('(1) POST tasks with runAt stores that instant', async () => {
    const title = `scheduled through the runner door ${randomUUID()}`;
    const created = await send(token, 'POST', 'tasks', { title, runAt: FIRST, ...EXECUTABLE });
    assert.equal(created.status, 201, created.text);
    scheduled = await taskIdByTitle(owner, title);
    assert.equal(await runAtOf(scheduled), FIRST);
  });

  // ═══ (2) cancel ═══════════════════════════════════════════════════════════════════════════════

  await t.test('(2) PATCH tasks/:id with runAt null leaves the task unscheduled', async () => {
    assert.ok(scheduled, 'case (1) created no task to cancel');
    // Not vacuous: (1) has just read FIRST off this row.
    const cleared = await send(token, 'PATCH', `tasks/${uuidToBase62(scheduled)}`, { runAt: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(await runAtOf(scheduled), null);
  });

  // ═══ (3) reschedule ═══════════════════════════════════════════════════════════════════════════

  await t.test('(3) PATCH tasks/:id with a new instant stores the new one', async () => {
    assert.ok(scheduled, 'case (1) created no task to reschedule');
    const moved = await send(token, 'PATCH', `tasks/${uuidToBase62(scheduled)}`, { runAt: MOVED });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(await runAtOf(scheduled), MOVED);
  });

  // ═══ (4) batch ════════════════════════════════════════════════════════════════════════════════

  await t.test("(4) POST tasks/batch-create stores each item's own runAt", async () => {
    const withSchedule = `batch item with a schedule ${randomUUID()}`;
    const withoutSchedule = `batch item without one ${randomUUID()}`;
    const created = await send(token, 'POST', 'tasks/batch-create', {
      tasks: [
        { title: withSchedule, runAt: FIRST, ...EXECUTABLE },
        { title: withoutSchedule, ...EXECUTABLE },
      ],
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(await runAtOf(await taskIdByTitle(owner, withSchedule)), FIRST);
    assert.equal(await runAtOf(await taskIdByTitle(owner, withoutSchedule)), null);
  });
});
