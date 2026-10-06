import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { CreatorType } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalJson } from '../projects/canonical-json';
import { buildCoordinatorDeliveryInstructions, buildCoordinatorInstructions } from '../projects/coordinator-opening';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import { handoffPayloadDigest, type HandoffRequestIdentity } from '../projects/project-handoff';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { TaskListsService } from '../task-lists/task-lists.service';
import { type CreateTaskBatchItemDto } from './dto';
import { TasksService } from './tasks.service';

declare global { interface BigInt { toJSON(): string; } }
BigInt.prototype.toJSON = function toJSON(this: bigint): string { return this.toString(); };

const URL = process.env.COORDINATOR_PG_URL;
const EXECUTABLE = { completionCriterion: 'EXECUTABLE' as const, acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };
const REASON = '  跨模块修复："并发"\n保留原文  ';

// Real HTTP with main.ts's whitelist and a second connection reading the committed columns.
test('task model suggestions survive create, batch, update, clearing and approval identity', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(URL!);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    await prisma.$disconnect();
    await sql.end();
  });
  const tasks = new TasksService(prisma as unknown as PrismaService, {} as never, {
    publishForUser: () => undefined, publishTaskChanged: () => undefined,
  } as never);

  @Module({
    controllers: [RunnerTasksController],
    providers: [
      { provide: TasksService, useValue: tasks },
      { provide: TaskListsService, useValue: {} },
      { provide: ProjectAttributionService, useValue: {} },
      { provide: PrismaService, useValue: prisma },
      RunnerAuthGuard,
    ],
  })
  class TaskModelHintModule {}
  app = await NestFactory.create(TaskModelHintModule, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const owner = randomUUID();
  const runnerId = randomUUID();
  const token = `model-hint-${randomUUID()}`;
  // An account that never turned smart model selection on: suggestions are accepted and kept with it off.
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'model hints','h')`, [owner, `${owner}@model-hint.invalid`]);
  await sql.query(`INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
    VALUES ($1,'model hints',$2,$3,'ONLINE',now(),'{}'::text[])`, [runnerId, owner, sha256(token)]);

  async function send(method: string, route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api/runner/${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }
  async function stored(title: string) {
    const { rows } = await sql.query<{ id: string; modelHint: string | null; modelHintReason: string | null }>(
      `SELECT "id", "model_hint" AS "modelHint", "model_hint_reason" AS "modelHintReason" FROM "task" WHERE "owner_id"=$1 AND "title"=$2`,
      [owner, title],
    );
    assert.equal(rows.length, 1, title);
    return rows[0];
  }
  function suggestion(body: Record<string, unknown>) {
    return { modelHint: body.modelHint, modelHintReason: body.modelHintReason };
  }
  let updateTitle = '';
  let updateId = '';

  await t.test('create stores all four tiers verbatim, and permits omitted or null suggestions', async () => {
    for (const fields of [
      ...['S', 'M', 'L', 'XL'].map((modelHint) => ({ modelHint, modelHintReason: REASON })),
      {}, { modelHint: null, modelHintReason: null },
    ]) {
      const title = `single ${randomUUID()}`;
      const reply = await send('POST', 'tasks', { title, ...EXECUTABLE, provider: 'codex', model: 'pinned-model', ...fields });
      assert.equal(reply.status, 201, reply.text);
      const want = { modelHint: null, modelHintReason: null, ...fields };
      assert.deepEqual(suggestion(reply.body), want);
      assert.deepEqual(suggestion(await stored(title)), want);
      assert.equal(reply.body.provider, 'codex');
      assert.equal(reply.body.model, 'pinned-model');
      if (want.modelHint === 'M') { updateTitle = title; updateId = reply.body.id; }
    }
  });

  await t.test('batch stores each item independently and list projections return the suggestion', async () => {
    const items = [
      ...['S', 'M', 'L', 'XL'].map((modelHint) => ({ title: `batch ${randomUUID()}`, ...EXECUTABLE, modelHint, modelHintReason: `${REASON}${modelHint}` })),
      { title: `batch omitted ${randomUUID()}`, ...EXECUTABLE },
      { title: `batch null ${randomUUID()}`, ...EXECUTABLE, modelHint: null, modelHintReason: null },
    ];
    const reply = await send('POST', 'tasks/batch-create', { tasks: items });
    assert.equal(reply.status, 201, reply.text);
    const listed = await send('GET', 'tasks?limit=100');
    assert.equal(listed.status, 200, listed.text);
    for (const item of items) {
      const want = suggestion({ modelHint: null, modelHintReason: null, ...item });
      assert.deepEqual(suggestion(await stored(item.title)), want);
      assert.deepEqual(suggestion(reply.body.find((row: any) => row.title === item.title)), want);
      assert.deepEqual(suggestion(listed.body.find((row: any) => row.title === item.title)), want);
    }
  });

  await t.test('update has three states for each field, including independent and paired clearing', async () => {
    assert.ok(updateId);
    for (const [fields, want] of [
      [{ modelHint: 'XL', modelHintReason: REASON }, { modelHint: 'XL', modelHintReason: REASON }],
      [{ description: 'unrelated edit' }, { modelHint: 'XL', modelHintReason: REASON }],
      [{ modelHintReason: null }, { modelHint: 'XL', modelHintReason: null }],
      [{ modelHintReason: '' }, { modelHint: 'XL', modelHintReason: '' }],
      [{ modelHint: null }, { modelHint: null, modelHintReason: '' }],
      [{ modelHint: 'S', modelHintReason: '文'.repeat(500) }, { modelHint: 'S', modelHintReason: '文'.repeat(500) }],
      [{ modelHint: null, modelHintReason: null }, { modelHint: null, modelHintReason: null }],
    ] as const) {
      const reply = await send('PATCH', `tasks/${updateId}`, fields);
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(suggestion(reply.body), want);
      assert.deepEqual(suggestion(await stored(updateTitle)), want);
    }
  });

  await t.test('whitelisted DTOs reject invalid tiers and reasons over 500 characters at every door', async () => {
    for (const fields of [{ modelHint: 'XXL' }, { modelHint: 1 }, { modelHintReason: '文'.repeat(501) }]) {
      for (const [method, route, body] of [
        ['POST', 'tasks', { title: `invalid ${randomUUID()}`, ...EXECUTABLE, ...fields }],
        ['POST', 'tasks/batch-create', { tasks: [{ title: `invalid batch ${randomUUID()}`, ...EXECUTABLE, ...fields }] }],
        ['PATCH', `tasks/${updateId}`, fields],
      ] as const) {
        const reply = await send(method, route, body);
        assert.equal(reply.status, 400, reply.text);
      }
    }
    assert.deepEqual(suggestion(await stored(updateTitle)), { modelHint: null, modelHintReason: null });
  });

  await t.test('the stored batch crossing digest binds the tier and reason with version 6', async () => {
    const workspace = randomUUID(), session = randomUUID(), projectA = randomUUID(), projectB = randomUUID();
    await sql.query(`INSERT INTO "workspace"("id","owner_id","name","runner_id","can_create_tasks","can_delegate") VALUES ($1,$2,'coordinator',$3,true,true)`, [workspace, owner, runnerId]);
    for (const project of [projectA, projectB]) {
      await sql.query(`INSERT INTO "project"("id","owner_id","title","coordinator_enabled","updated_at") VALUES ($1,$2,'model hints',true,now())`, [project, owner]);
      await sql.query(`INSERT INTO "project_runtime"("project_id","updated_at") VALUES ($1,now()) ON CONFLICT DO NOTHING`, [project]);
    }
    await sql.query(`INSERT INTO "session"("id","owner_id","workspace_id","title","prompt","creator_id","provider","status","dispatch_origin","updated_at")
      VALUES ($1,$2,$3,'coordinator','fixture',$2,'claude','RUNNING'::"run_status",'USER'::"session_dispatch_origin",now())`, [session, owner, workspace]);
    await sql.query(`UPDATE "project" SET "coordinator_session_id"=$2 WHERE "id"=$1`, [projectA, session]);
    const digests = new Set<string>();
    for (const [modelHint, modelHintReason] of [['M', REASON], ['L', REASON], ['L', 'different reason']] as const) {
      const item: CreateTaskBatchItemDto = { title: 'same crossing', projectId: projectB, ...EXECUTABLE, modelHint, modelHintReason, handoff: { reason: 'work belongs there' } };
      await assert.rejects(tasks.createMany(owner, { tasks: [item] }, { type: CreatorType.AGENT, id: owner }, session));
      const identity: HandoffRequestIdentity = {
        plan: { title: item.title, ...EXECUTABLE, modelHint, modelHintReason },
        source: { projectId: projectA, taskId: null, sessionId: session, triggerEvent: 'coordinator.session_filed' },
      };
      const digest = handoffPayloadDigest(identity);
      const { rows } = await sql.query(`SELECT "state" FROM "project_handoff_approval" WHERE "owner_id"=$1 AND "payload_digest"=$2`, [owner, digest]);
      assert.equal(rows.length, 1, 'the actual batch identity must carry the suggestion');
      assert.equal(rows[0].state, 'PENDING');
      digests.add(digest);
      const preimage = { v: 6, plan: {
        title: item.title, description: null, acceptanceCriteria: null, ...EXECUTABLE,
        labels: [], assigneeId: null, listId: null, provider: null, model: null, modelHint, modelHintReason,
        autoRunWhenReady: null, runAt: null, dueDate: null, completionPolicy: null,
        parentTaskId: null, parentRefDigest: null, verifiesTaskId: null, verifiesRefDigest: null, supersedesTaskId: null,
        dependsOnTaskIds: [], dependsOnRefDigests: [],
      }, source: identity.source };
      assert.equal(digest, createHash('sha256').update(canonicalJson(preimage)).digest('hex'));
    }
    assert.equal(digests.size, 3, 'changing only the tier or reason requires a different approval');
    const empty: HandoffRequestIdentity = { plan: { title: 'old request' }, source: {} };
    assert.equal(handoffPayloadDigest(empty), handoffPayloadDigest({ ...empty, plan: { ...empty.plan, modelHint: null, modelHintReason: null } }));
  });

  await t.test('coordinator opening and delivery forms require suggestions even with Automatic off', () => {
    for (const enabled of [true, false]) {
      // Rendered for an owner with smart model selection on, the only owner they ask a tier of.
      for (const form of [buildCoordinatorInstructions('model hints', randomUUID(), enabled, true), buildCoordinatorDeliveryInstructions(randomUUID(), enabled, true)]) {
        assert.match(form, /每个任务填 modelHint（S\/M\/L\/XL）和一句 modelHintReason/);
        assert.match(form, /缺建议的任务也用 task_update 补上/);
        assert.match(form, /引擎仍用 provider 字段指定/);
      }
    }
  });
});
