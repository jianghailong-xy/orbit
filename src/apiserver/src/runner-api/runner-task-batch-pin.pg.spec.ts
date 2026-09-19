/**
 * The batch-pin door over real HTTP and a real PostgreSQL: what `orbit task batch-pin` and the MCP
 * `task_batch_pin` reach.
 *
 * `tasks/task-batch-pin.pg.spec.ts` pins what `TasksService.pinMany` decides when it is called —
 * the IS DISTINCT FROM skip, the tenant predicate, the two refusals. This file pins the DOOR in
 * front of it: the real route, the real DTO (so a Base62 projectId has to decode), the real
 * `ValidationPipe`, interceptor and exception filters in main.ts's order, and the real
 * `RunnerAuthGuard` over real runner rows, where the owner is not a signed-in person but the owner
 * of the runner row the token matched.
 *
 * "The service works" is not the claim a caller can use: the door is what they type at, and a DTO
 * that will not decode a public id, or a guard that scopes to somebody else, is invisible from
 * inside the service.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-task-batch-pin.pg.spec.ts
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
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksService } from '../tasks/tasks.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerTasksController } from './runner-tasks.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const FLASH = 'deepseek-flash';
const PRO = 'deepseek-v4-pro';
/** A day old, so "did this row get written" is a comparison and not a guess about clock skew. */
const STALE = "now() - interval '1 day'";

interface Reply {
  status: number;
  body: Record<string, any>;
  text: string;
}

test('the runner batch-pin door', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // Built here and lent to the module one method wide, for the same reason the progress door's spec
  // does it: an instance the module OWNS gets its onModuleInit, which starts the auto-run sweeps
  // over this database.
  const tasks = new TasksService(
    prisma as unknown as PrismaService,
    {} as never,
    { publishForUser: () => undefined, publishTaskChanged: () => undefined } as never,
  );

  @Module({
    controllers: [RunnerTasksController],
    providers: [
      { provide: TasksService, useValue: { pinMany: (ownerId: string, dto: unknown) => tasks.pinMany(ownerId, dto as never) } },
      { provide: TaskListsService, useValue: {} },
      { provide: ProjectAttributionService, useValue: {} },
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class RunnerBatchPinDoorModule {}

  app = await NestFactory.create(RunnerBatchPinDoorModule, { logger: false, abortOnError: false });
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

  async function insertOwner(): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'batch pin door','h')`,
      [id, `${id}@batch-pin-door.invalid`],
    );
    return id;
  }

  /** A runner row for the owner, and the token the real guard finds it by: that row's owner scopes the request. */
  async function insertRunner(owner: string): Promise<string> {
    const token = `runner-token-${randomUUID()}`;
    await sql.query(
      `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
       VALUES ($1,'batch pin door',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[])`,
      [randomUUID(), owner, sha256(token)],
    );
    return token;
  }

  async function insertProject(owner: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project"("id","title","owner_id","updated_at") VALUES ($1,'pinned work',$2,now())`,
      [id, owner],
    );
    return id;
  }

  async function insertTask(owner: string, project: string, model: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at",
                           "project_id","model","completion_criterion")
       VALUES ($1,'pinned work',$2,'AGENT',$2,${STALE},$3,$4,'EVIDENCE_JUDGMENT')`,
      [id, owner, project, model],
    );
    return id;
  }

  /** What the database holds for these rows, over this spec's own connection. */
  async function readPins(ids: string[]): Promise<Map<string, { model: string | null; stale: boolean }>> {
    const { rows } = await sql.query<{ id: string; model: string | null; stale: boolean }>(
      `SELECT "id","model", ("updated_at" < now() - interval '1 hour') AS stale
         FROM "task" WHERE "id" = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((row) => [row.id, row]));
  }

  // ── the door ──────────────────────────────────────────────────────────────────────────────────

  async function pin(token: string, body: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(`${base}/api/runner/tasks/batch-pin`, {
      method: 'POST',
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

  await t.test('a Base62 projectId decodes, the rows land, and the one already at the target is not written',
    async () => {
      const owner = await insertOwner();
      const token = await insertRunner(owner);
      const project = await insertProject(owner);
      const needsIt = await insertTask(owner, project, PRO);
      const already = await insertTask(owner, project, FLASH);

      const reply = await pin(token, { projectId: uuidToBase62(project), model: FLASH });

      // 201: Nest's default for a POST, and what every other batch-* route on this controller answers.
      assert.equal(reply.status, 201, reply.text);
      assert.deepEqual(reply.body, { changed: 1 });
      const after = await readPins([needsIt, already]);
      assert.equal(after.get(needsIt)!.model, FLASH);
      assert.equal(after.get(needsIt)!.stale, false);
      // The whole point of the door, at the door: the row that was already there is untouched, so
      // the project list's lastActivityAt (max(task.updated_at)) does not report it as activity.
      assert.equal(after.get(already)!.stale, true, 'a row already carrying the pin must not be written');
    });

  await t.test('the selection never leaves the runner owner\'s own tenant', async () => {
    const owner = await insertOwner();
    const token = await insertRunner(owner);
    const otherOwner = await insertOwner();
    const mine = await insertProject(owner);
    const theirs = await insertProject(otherOwner);
    const mineTask = await insertTask(owner, mine, PRO);
    const theirTask = await insertTask(otherOwner, theirs, PRO);

    // The other owner's project id, in the spelling that decodes, on this owner's runner.
    const reply = await pin(token, { projectId: uuidToBase62(theirs), model: FLASH });
    // 201: Nest's default for a POST, and what every other batch-* route on this controller answers.
      assert.equal(reply.status, 201, reply.text);
    assert.deepEqual(reply.body, { changed: 0 });
    const after = await readPins([mineTask, theirTask]);
    assert.equal(after.get(mineTask)!.stale, true);
    assert.equal(after.get(theirTask)!.stale, true, 'another owner\'s rows are not this runner\'s to pin');
  });

  await t.test('a request naming no selector, or no pin, is refused at the door', async () => {
    const token = await insertRunner(await insertOwner());
    const project = await insertProject(await insertOwner());

    const noSelector = await pin(token, { model: FLASH });
    assert.equal(noSelector.status, 400, noSelector.text);
    assert.match(noSelector.text, /PIN_BATCH_NO_SELECTOR/);

    const noPin = await pin(token, { projectId: uuidToBase62(project) });
    assert.equal(noPin.status, 400, noPin.text);
    assert.match(noPin.text, /PIN_BATCH_NOTHING_TO_WRITE/);

    // The DTO's own door: a project id that is neither a UUID nor a decodable public id never
    // reaches the service at all.
    const undecodable = await pin(token, { projectId: 'not-a-project-id', model: FLASH });
    assert.equal(undecodable.status, 400, undecodable.text);
  });
});
