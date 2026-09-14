/**
 * The runner's progress door over real HTTP and a real PostgreSQL (docs/watch-contract.md §12.1): what an
 * agent's task_progress_report and `orbit task progress` reach.
 *
 * `watches/watch-advanced.pg.spec.ts` pins what TaskProgressService decides when it is called. This file
 * pins the door in front of it for the runner credential, where the owner is not a signed-in person but
 * the owner of the runner row the token matched. So it runs the real RunnerAuthGuard over real runner
 * rows, and the real route, pipe, interceptor and exception filters in main.ts's order, and it reads every
 * row it asserts about over a second connection rather than through the answer that wrote it.
 *
 *   (1) a runner reads and reports only its own owner's tasks: to another owner's runner the task is 404,
 *       read or report, and nothing is written, beside the same report from the owner's runner, which lands;
 *   (2) a report against a revision that has moved is 409 PROGRESS_REVISION_CONFLICT and writes nothing;
 *       read again, the same report against the revision read lands;
 *   (3) a task with a conclusion is 409 TASK_NOT_OPEN and writes nothing; reopened, it takes reports in
 *       its next epoch, where a report still aimed at the revision read before the reopen loses.
 *
 * The routes are read from contracts/watch.contract.json `progress.runnerDoor`, the list runner-go's
 * task_progress_test.go holds the tool to, so the two halves meet in one place.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-task-progress.pg.spec.ts
 *
 * Not destructive: every id is generated here and every assertion is scoped to the tasks it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { TaskProgressService } from '../tasks/task-progress.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerTaskProgressController } from './runner-task-progress.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// From build/runner-api back to the repository root.
const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as { progress: { runnerDoor: { routes: string[] } } };

/** An answer, kept as text as well: a body that is not JSON has to be readable in the failure. */
interface Reply {
  status: number;
  body: Record<string, any>;
  text: string;
}

/** A task's progress, as the table holds it. */
type ProgressRow = {
  lifecycle_epoch: number;
  phase: string | null;
  current: number | null;
  total: number | null;
  message: string | null;
  revision: number;
  last_progress_at: Date | null;
};

/** The named fields of an answer or a row, so each comparison states exactly what it is about. */
function pick(source: Record<string, any> | undefined, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, source?.[key]]));
}

test('the runner progress door', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  @Module({
    controllers: [RunnerTaskProgressController],
    providers: [
      { provide: TaskProgressService, useValue: new TaskProgressService(prisma as unknown as PrismaService) },
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class RunnerProgressDoorModule {}

  app = await NestFactory.create(RunnerProgressDoorModule, { logger: false, abortOnError: false });
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
      `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'runner progress door','h')`,
      [id, `${id}@runner-progress.invalid`],
    );
    return id;
  }

  /** A runner row for the owner, and the token the real guard finds it by: that row's owner scopes every request. */
  async function insertRunner(owner: string): Promise<string> {
    const token = `runner-token-${randomUUID()}`;
    await sql.query(
      `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
       VALUES ($1,'runner progress door',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[])`,
      [randomUUID(), owner, sha256(token)],
    );
    return token;
  }

  async function insertTask(owner: string, status: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
       VALUES ($1,'reporting work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
      [id, owner, status],
    );
    return id;
  }

  async function setStatus(taskId: string, status: string): Promise<void> {
    await sql.query(`UPDATE "task" SET "status" = $2 WHERE "id" = $1::uuid`, [taskId, status]);
  }

  /** The task's progress row over this spec's own connection, or undefined when the task has none. */
  async function row(taskId: string): Promise<ProgressRow | undefined> {
    const { rows } = await sql.query<ProgressRow>(
      `SELECT "lifecycle_epoch", "phase", "current", "total", "message", "revision", "last_progress_at"
         FROM "task_progress" WHERE "task_id" = $1::uuid`,
      [taskId],
    );
    return rows[0];
  }

  // ── the door, addressed the way the runner addresses it ────────────────────────────────────────

  /** The contract's route for this method, naming one task in the base62 spelling an agent holds. */
  function route(method: 'GET' | 'POST', taskId: string): string {
    const declared = CONTRACT.progress.runnerDoor.routes.find((candidate) => candidate.startsWith(`${method} `));
    assert.ok(declared, `contracts/watch.contract.json names no ${method} route for the runner progress door`);
    return declared.slice(method.length + 1).replace(':id', uuidToBase62(taskId));
  }

  async function send(token: string, method: 'GET' | 'POST', taskId: string, report?: Record<string, unknown>): Promise<Reply> {
    const response = await fetch(`${base}${route(method, taskId)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: report === undefined ? undefined : JSON.stringify(report),
    });
    const text = await response.text();
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      // Left empty: every assertion on it prints the text.
    }
    return { status: response.status, body, text };
  }

  const read = (token: string, taskId: string) => send(token, 'GET', taskId);
  const report = (token: string, taskId: string, body: Record<string, unknown>) => send(token, 'POST', taskId, body);

  const owner = await insertOwner();
  const stranger = await insertOwner();
  const ownRunner = await insertRunner(owner);
  const strangerRunner = await insertRunner(stranger);

  // ═══ (1) owner isolation ══════════════════════════════════════════════════════════════════════

  await t.test('(1) a runner reads and reports only the tasks of its own owner', async () => {
    const task = await insertTask(owner, 'IN_PROGRESS');
    const position = { phase: 'build', current: 1, total: 4, message: 'compiling' };

    // First, before there is anything to see: to another owner's runner the task is not there, for a
    // report and for a read alike, and the report writes nothing.
    const foreignReport = await report(strangerRunner, task, position);
    assert.equal(foreignReport.status, 404, foreignReport.text);
    const foreignRead = await read(strangerRunner, task);
    assert.equal(foreignRead.status, 404, foreignRead.text);
    assert.equal(await row(task), undefined, 'a report through another owner’s runner made a progress row');

    // The same report through the owner's own runner lands: the 404 above is a scope, not a door that
    // answers nobody.
    const landed = await report(ownRunner, task, position);
    assert.equal(landed.status, 200, landed.text);
    assert.equal(landed.body.taskId, uuidToBase62(task), 'the answer spells the task for the model that reads it');
    assert.deepEqual(
      pick(landed.body, 'lifecycleEpoch', 'phase', 'current', 'total', 'message', 'revision', 'changed', 'progressed'),
      { lifecycleEpoch: 0, phase: 'build', current: 1, total: 4, message: 'compiling', revision: 1, changed: true, progressed: true },
    );
    assert.deepEqual(pick(await row(task), 'phase', 'current', 'total', 'message', 'revision'),
      { phase: 'build', current: 1, total: 4, message: 'compiling', revision: 1 });
    const readBack = await read(ownRunner, task);
    assert.equal(readBack.status, 200, readBack.text);
    assert.deepEqual(pick(readBack.body, 'phase', 'current', 'total', 'message', 'revision'),
      { phase: 'build', current: 1, total: 4, message: 'compiling', revision: 1 });

    // With progress there to see, the other owner's runner still sees no task and moves nothing.
    const foreignReread = await read(strangerRunner, task);
    assert.equal(foreignReread.status, 404, foreignReread.text);
    const foreignOverwrite = await report(strangerRunner, task, { current: 3, message: 'written by another owner' });
    assert.equal(foreignOverwrite.status, 404, foreignOverwrite.text);
    assert.deepEqual(pick(await row(task), 'phase', 'current', 'total', 'message', 'revision'),
      { phase: 'build', current: 1, total: 4, message: 'compiling', revision: 1 });

    // That runner is a working credential on its own owner's task, which the first runner cannot read;
    // and a token no runner holds is not let in at all.
    const theirs = await insertTask(stranger, 'OPEN');
    const ownTask = await report(strangerRunner, theirs, { phase: 'plan' });
    assert.equal(ownTask.status, 200, ownTask.text);
    assert.equal((await read(strangerRunner, theirs)).body.phase, 'plan');
    const crossRead = await read(ownRunner, theirs);
    assert.equal(crossRead.status, 404, crossRead.text);
    const unknown = await report(`not-a-runner-${randomUUID()}`, task, { current: 2 });
    assert.equal(unknown.status, 401, unknown.text);
    assert.equal((await row(task))?.current, 1);
  });

  // ═══ (2) revision compare-and-set ═════════════════════════════════════════════════════════════

  await t.test('(2) a report against a revision that has moved is refused, and writes nothing', async () => {
    const task = await insertTask(owner, 'IN_PROGRESS');
    // A task that never reported is at revision 0, so a compare-and-set can start from nothing.
    const first = await report(ownRunner, task, { phase: 'test', current: 1, total: 8, expectedRevision: 0 });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.revision, 1);
    const second = await report(ownRunner, task, { current: 2, expectedRevision: 1 });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.revision, 2);
    const before = await row(task);

    const stale = await report(ownRunner, task, { current: 3, message: 'from a stale read', expectedRevision: 1 });
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual(pick(stale.body, 'code', 'revision', 'lifecycleEpoch'),
      { code: 'PROGRESS_REVISION_CONFLICT', revision: 2, lifecycleEpoch: 0 });
    assert.deepEqual(await row(task), before, 'a refused compare-and-set wrote to the progress row');

    // Read again, then report against the revision read: the same report lands.
    const reread = await read(ownRunner, task);
    assert.equal(reread.status, 200, reread.text);
    assert.equal(reread.body.revision, 2);
    const retried = await report(ownRunner, task, { current: 3, message: 'from a stale read', expectedRevision: reread.body.revision });
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(pick(retried.body, 'phase', 'current', 'total', 'message', 'revision', 'progressed'),
      { phase: 'test', current: 3, total: 8, message: 'from a stale read', revision: 3, progressed: true });
  });

  // ═══ (3) a task with a conclusion ═════════════════════════════════════════════════════════════

  await t.test('(3) a task with a conclusion takes no report, and reopening it starts the next epoch', async () => {
    const failed = await insertTask(owner, 'IN_PROGRESS');
    const started = await report(ownRunner, failed, { phase: 'migrate', current: 5, total: 10 });
    assert.equal(started.status, 200, started.text);
    await setStatus(failed, 'FAILED');
    const concluded = await row(failed);

    const refused = await report(ownRunner, failed, { current: 6 });
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual(pick(refused.body, 'code', 'status'), { code: 'TASK_NOT_OPEN', status: 'FAILED' });
    assert.deepEqual(await row(failed), concluded, 'a report on a FAILED task wrote to its progress row');

    const cancelled = await insertTask(owner, 'CANCELLED');
    const alsoRefused = await report(ownRunner, cancelled, { phase: 'plan' });
    assert.equal(alsoRefused.status, 409, alsoRefused.text);
    assert.deepEqual(pick(alsoRefused.body, 'code', 'status'), { code: 'TASK_NOT_OPEN', status: 'CANCELLED' });
    assert.equal(await row(cancelled), undefined, 'a report on a CANCELLED task made a progress row');

    // What a concluded task last reported can still be read.
    const last = await read(ownRunner, failed);
    assert.equal(last.status, 200, last.text);
    assert.deepEqual(pick(last.body, 'lifecycleEpoch', 'phase', 'current', 'revision'),
      { lifecycleEpoch: 0, phase: 'migrate', current: 5, revision: 1 });

    // Reopened, the task is in its next epoch with nothing reported, and a report aimed at the revision
    // read before the reopen loses its compare-and-set instead of landing in the wrong epoch.
    await setStatus(failed, 'OPEN');
    const aimedAtTheOldEpoch = await report(ownRunner, failed, { current: 6, expectedRevision: last.body.revision });
    assert.equal(aimedAtTheOldEpoch.status, 409, aimedAtTheOldEpoch.text);
    assert.equal(aimedAtTheOldEpoch.body.code, 'PROGRESS_REVISION_CONFLICT');
    const fresh = await read(ownRunner, failed);
    assert.equal(fresh.status, 200, fresh.text);
    assert.deepEqual(pick(fresh.body, 'lifecycleEpoch', 'phase', 'current', 'total', 'revision'),
      { lifecycleEpoch: 1, phase: null, current: null, total: null, revision: 2 });
    const reported = await report(ownRunner, failed, { current: 6, expectedRevision: fresh.body.revision });
    assert.equal(reported.status, 200, reported.text);
    assert.deepEqual(pick(reported.body, 'lifecycleEpoch', 'current', 'revision', 'progressed'),
      { lifecycleEpoch: 1, current: 6, revision: 3, progressed: true });

    // And the report the CANCELLED task refused is taken once that task is open again.
    await setStatus(cancelled, 'IN_PROGRESS');
    const reopened = await report(ownRunner, cancelled, { phase: 'plan' });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal((await row(cancelled))?.phase, 'plan');
  });
});
