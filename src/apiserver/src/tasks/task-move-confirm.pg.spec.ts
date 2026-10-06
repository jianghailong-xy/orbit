/**
 * Unit L4, the answer to a move, on real PostgreSQL: the account owner confirms a MOVE_TASK request
 * and the task is in the target project — the agent that asked sends nothing more (account owner,
 * 2026-10-06: "确认了就好了").
 *
 * What is under test is the confirmation half. It moves the task as the owner's act and spends the
 * request on it, once; the criterion the request named is declared as it reads at that moment and
 * the source's declaration is taken back. A no, an expired yes, and a move that can no longer be
 * made all leave the task where it is — the last with the request still waiting. A run in progress
 * goes with the task and keeps writing. What files the request is `task-move-request.pg.spec.ts`;
 * the owner's own move with no session is `task-owner-move-unchanged.pg.spec.ts`.
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-move-confirm.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectsController } from '../projects/projects.controller';
import type { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TaskProgressService } from './task-progress.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const REPO = 'ssh://git@example.invalid/orbit/move-confirm';

interface World {
  label: string;
  ownerId: string;
  workspaceId: string;
  /** Where the tasks are. */
  projectA: string;
  /** Where they are asked to go. */
  projectB: string;
  /** A third project of the same owner. */
  projectC: string;
  coordA: string;
  coordB: string;
  /** An execution session, RUNNING `work`. */
  worker: string;
  work: string;
  /** A task in A declaring `criterionA`, with no run. */
  task: string;
  criterionA: string;
  criterionB: string;
}

type Refusal = { status: number; body: Record<string, unknown> };
type TaskRow = {
  project_id: string | null;
  criterion_definition_id: string | null;
  criterion_revision: number | null;
  description: string | null;
};

test('unit L4: the account owner confirms a move, and the task moves', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged: () => undefined, publishForUser: () => undefined } as never,
    handoffs,
  );
  const evidence = new TaskCompletionEvidenceService(prisma as unknown as PrismaService);
  const progress = new TaskProgressService(prisma as unknown as PrismaService);
  // The door the confirmation card posts to: `POST /projects/:id/handoffs/:handoffId/decision`.
  // Nothing but the handoff service is reached from it.
  const card = new ProjectsController(
    {} as never, {} as never, handoffs, {} as never, {} as never, {} as never, {} as never,
  );

  async function insertTask(
    w: Pick<World, 'ownerId'>,
    title: string,
    projectId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    const row: Record<string, unknown> = {
      id, owner_id: w.ownerId, title, status: 'OPEN', project_id: projectId, creator_type: 'USER',
      creator_id: w.ownerId, updated_at: new Date(), completion_criterion: 'EVIDENCE_JUDGMENT',
      ...extra,
    };
    const columns = Object.keys(row);
    const values = Object.values(row);
    await admin.query(
      `INSERT INTO "task" (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`,
      values,
    );
    return id;
  }

  async function insertCriterion(projectId: string, text: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
       VALUES ($1,$2,1,$3,'a pg spec',$4,now(),now())`,
      [id, projectId, text, createHash('sha256').update(text).digest('hex')],
    );
    return id;
  }

  async function seed(label: string): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [ownerId, `${label}-${ownerId}@move.invalid`, label],
    );
    await admin.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,$3,'ONLINE',$4,now())`,
      [runnerId, ownerId, `${label}-runner`, `${label}-${runnerId}`],
    );
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      [workspaceId, ownerId, `${label}-agent`, runnerId],
    );
    const [projectA, projectB, projectC] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[projectA, 'A'], [projectB, 'B'], [projectC, 'C']]) {
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,$3,true,now())`,
        [id, ownerId, `${label} project ${name}`],
      );
      await admin.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`,
        [id],
      );
    }
    const [coordA, coordB, worker] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[coordA, 'coordinator of A'], [coordB, 'coordinator of B'],
      [worker, 'a run in A']]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, ownerId, workspaceId, `${label}: ${name}`],
      );
    }
    for (const [project, session] of [[projectA, coordA], [projectB, coordB]]) {
      await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [project, session]);
    }
    const criterionA = await insertCriterion(projectA, `${label}: what A wants`);
    const criterionB = await insertCriterion(projectB, `${label}: what B wants`);
    const w = { ownerId };
    const work = await insertTask(w, `${label}: the work the run is doing`, projectA);
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid', [worker, work]);
    const task = await insertTask(w, `${label}: work that belongs to B`, projectA, {
      criterion_definition_id: criterionA, criterion_revision: 1,
    });
    return {
      label, ownerId, workspaceId, projectA, projectB, projectC, coordA, coordB, worker, work, task,
      criterionA, criterionB,
    };
  }

  /** The request, as `task_update` sends it: another project, and the declaration. */
  const ask = (w: World, sessionId: string, over: Record<string, unknown> = {}, taskId = w.task) =>
    tasks.update(w.ownerId, taskId, {
      projectId: w.projectB, handoff: { reason: 'it serves B' }, ...over,
    } as never, sessionId);

  async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    throw new assert.AssertionError({ message: 'the request was not refused' });
  }

  async function requestRow(id: string): Promise<Record<string, unknown>> {
    const { rows: [row] } = await admin.query(
      'SELECT * FROM "project_handoff_approval" WHERE "id" = $1::uuid', [id]);
    return row;
  }

  async function requests(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await admin.query(
      `SELECT * FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid
        ORDER BY "requested_at", "id"`, [ownerId]);
    return rows;
  }

  /** The question an agent's first request files, read back. Nothing else is asked of the agent. */
  async function asked(
    w: World,
    sessionId: string,
    over: Record<string, unknown> = {},
    taskId = w.task,
  ): Promise<Record<string, unknown> & { id: string; crossing_key: string }> {
    const refusal = await refusalOf(() => ask(w, sessionId, over, taskId));
    assert.equal(refusal.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
    const row = await requestRow(String(refusal.body.handoffId));
    assert.equal(row.kind, 'MOVE_TASK');
    assert.equal(row.state, 'PENDING');
    return row as Record<string, unknown> & { id: string; crossing_key: string };
  }

  async function taskRow(id: string): Promise<TaskRow> {
    const { rows: [row] } = await admin.query<TaskRow>(
      `SELECT "project_id", "criterion_definition_id", "criterion_revision", "description"
         FROM "task" WHERE "id" = $1::uuid`, [id]);
    return row;
  }

  /** What `activity` records as moves this owner made. */
  async function moves(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await admin.query(
      `SELECT "actor_id", "type", "payload", "credential_kind", "credential_id" FROM "activity"
        WHERE "actor_id" = $1::uuid AND "type" = 'task.moved' ORDER BY "created_at", "id"`,
      [ownerId]);
    return rows;
  }

  const owner = (w: World) => ({
    userId: w.ownerId, email: `${w.label}@move.invalid`, credential: { kind: 'LOGIN' as const },
  });
  const confirm = (w: World, id: string) =>
    handoffs.decide(w.ownerId, w.ownerId, id, 'APPROVE', new Date(), { kind: 'LOGIN' });
  const deny = (w: World, id: string) =>
    handoffs.decide(w.ownerId, w.ownerId, id, 'DENY', new Date());

  // ------------------------------------------------------------------------------------------
  // The yes is the move.
  // ------------------------------------------------------------------------------------------

  await t.test('confirming at the card moves the task, as the owner\'s act, with nothing more from the agent', async () => {
    const w = await seed('confirm');
    // The target's coordinator pulls the task over and names the criterion it will serve there —
    // the shape of the 2026-10-06 request this project started from.
    const question = await asked(w, w.coordB, { criterionKey: criterionKeyOf(w.criterionB) });
    // B rewords that criterion while the question waits: the move declares it as it reads when the
    // owner answers, not as it read when the agent asked.
    await admin.query(
      `UPDATE "project_acceptance_criterion_definition" SET "text" = "text" || ' (reworded)'
        WHERE "id" = $1::uuid`, [w.criterionB]);
    const { rows: [{ revision }] } = await admin.query<{ revision: number }>(
      'SELECT "revision" FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid',
      [w.criterionB]);
    assert.equal(revision, 2);
    assert.deepEqual(await taskRow(w.task), {
      project_id: w.projectA, criterion_definition_id: w.criterionA, criterion_revision: 1,
      description: null,
    });

    // The owner answers at the card. The agent is not asked to do, or send, anything more.
    const answer = await card.decideHandoff(owner(w), w.projectB, question.id, {
      decision: 'APPROVE', acknowledgedCrossingKey: question.crossing_key,
    } as never);
    assert.equal(answer.row.state, 'APPLIED');
    assert.equal(answer.row.appliedTaskId, w.task);

    assert.deepEqual(await taskRow(w.task), {
      project_id: w.projectB,
      criterion_definition_id: w.criterionB,
      criterion_revision: 2,
      description: null,
    }, 'in B, serving the criterion the request named at its revision now; A\'s declaration taken back');

    const row = await requestRow(question.id);
    assert.equal(row.state, 'APPLIED');
    assert.equal(row.applied_task_id, w.task);
    assert.ok(row.applied_at instanceof Date);
    assert.equal(row.decided_by, 'USER');
    assert.equal(row.decided_by_user_id, w.ownerId, 'answered by the account owner');
    assert.ok(row.decided_at instanceof Date);
    assert.ok(row.expires_at instanceof Date);
    assert.equal(row.requested_by_session_id, w.coordB);
    assert.equal((await requests(w.ownerId)).length, 1, 'the one question the agent asked, and no other');

    const recorded = await moves(w.ownerId);
    assert.deepEqual(recorded, [{
      actor_id: w.ownerId,
      type: 'task.moved',
      payload: {
        taskId: w.task,
        fromProjectId: w.projectA,
        toProjectId: w.projectB,
        handoffId: question.id,
        requestedBySessionId: w.coordB,
        criterionDefinitionId: w.criterionB,
        withdrawnCriterionDefinitionId: w.criterionA,
      },
      credential_kind: 'LOGIN',
      credential_id: null,
    }], 'one move, recorded as the owner\'s, naming the request it applied');
  });

  await t.test('a request that names no criterion takes the source\'s back and declares none', async () => {
    const w = await seed('no-criterion');
    const question = await asked(w, w.coordA);
    const answer = await confirm(w, question.id);
    assert.equal(answer.row.state, 'APPLIED');
    assert.deepEqual(await taskRow(w.task), {
      project_id: w.projectB, criterion_definition_id: null, criterion_revision: null, description: null,
    });
    const [recorded] = await moves(w.ownerId);
    assert.equal((recorded.payload as Record<string, unknown>).criterionDefinitionId, null);
    assert.equal((recorded.payload as Record<string, unknown>).withdrawnCriterionDefinitionId, w.criterionA);
  });

  await t.test('a yes recorded before confirmations moved anything is applied by confirming it again', async () => {
    // An APPROVED row with its yes still live: what an earlier build wrote when the answer only
    // changed state. Confirming it again is how the owner's yes takes effect now.
    const w = await seed('earlier-yes');
    const question = await asked(w, w.coordA);
    await admin.query(
      `UPDATE "project_handoff_approval"
          SET "state" = 'APPROVED', "decided_by" = 'USER', "decided_by_user_id" = $2::uuid,
              "decided_at" = (now() AT TIME ZONE 'UTC') - interval '1 hour',
              "expires_at" = (now() AT TIME ZONE 'UTC') + interval '6 days'
        WHERE "id" = $1::uuid`, [question.id, w.ownerId]);
    const approved = await requestRow(question.id);
    const answer = await confirm(w, question.id);
    assert.equal(answer.row.state, 'APPLIED');
    assert.equal((await taskRow(w.task)).project_id, w.projectB);
    const row = await requestRow(question.id);
    assert.deepEqual(
      [row.decided_by, row.decided_by_user_id, row.decided_at, row.expires_at],
      [approved.decided_by, approved.decided_by_user_id, approved.decided_at, approved.expires_at],
      'the yes that was given is the one spent',
    );
    assert.equal((await moves(w.ownerId)).length, 1);
  });

  // ------------------------------------------------------------------------------------------
  // Once.
  // ------------------------------------------------------------------------------------------

  await t.test('the same confirmation used again moves nothing a second time', async () => {
    const w = await seed('once');
    const question = await asked(w, w.coordA);
    await confirm(w, question.id);
    const spent = await requestRow(question.id);

    const again = await refusalOf(() => confirm(w, question.id));
    assert.equal(again.status, 409);
    assert.match(String(again.body.message), /APPLIED/);
    assert.deepEqual(await requestRow(question.id), spent, 'the spent answer is not touched');

    // Even with the task back where it started, the spent answer cannot move it again.
    await tasks.update(w.ownerId, w.task, { projectId: w.projectA } as never);
    assert.equal((await taskRow(w.task)).project_id, w.projectA);
    const later = await refusalOf(() => confirm(w, question.id));
    assert.equal(later.status, 409);
    assert.equal((await taskRow(w.task)).project_id, w.projectA, 'no second move');
    assert.deepEqual(await requestRow(question.id), spent);
    assert.equal((await moves(w.ownerId)).length, 1, 'one move recorded, for the one confirmation');
    // And the database refuses to make the spent answer live again (0155).
    await assert.rejects(
      () => admin.query(
        `UPDATE "project_handoff_approval" SET "state" = 'APPROVED', "applied_task_id" = NULL,
            "applied_at" = NULL WHERE "id" = $1::uuid`, [question.id]),
      /PROJECT_HANDOFF_SPENT/,
    );
  });

  await t.test('confirmations given at once move the task once', async () => {
    const w = await seed('double');
    const question = await asked(w, w.coordA);
    const results = await Promise.allSettled([1, 2, 3].map(() => confirm(w, question.id)));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'one confirmation applies');
    for (const result of rejected) {
      assert.ok(result.reason instanceof HttpException, String(result.reason));
      assert.equal(result.reason.getStatus(), 409);
    }
    assert.equal((await taskRow(w.task)).project_id, w.projectB);
    assert.equal((await requestRow(question.id)).state, 'APPLIED');
    assert.equal((await moves(w.ownerId)).length, 1);
  });

  await t.test('the agent sending the same move again afterwards is an ordinary write: no error, no question', async () => {
    // Pushed out by the source's coordinator, which no longer holds the task: it gets the task back.
    const push = await seed('resend-push');
    const pushed = await asked(push, push.coordA);
    await confirm(push, pushed.id);
    const applied = await requestRow(pushed.id);
    const resent = await ask(push, push.coordA) as { id: string; projectId: string | null };
    assert.equal(resent.id, push.task);
    assert.equal(resent.projectId, push.projectB);
    assert.deepEqual(await requests(push.ownerId), [applied], 'nothing filed, nothing rewritten');
    assert.equal((await moves(push.ownerId)).length, 1);
    // Anything else it sends about the task is outside its scope now, exactly as before.
    const other = await refusalOf(() =>
      tasks.update(push.ownerId, push.task, { title: 'renamed from the old project' } as never, push.coordA));
    assert.equal(other.body.code, 'PROJECT_SCOPE_MISMATCH');

    // Pulled in by the target's coordinator, which holds it now: an ordinary update in its scope.
    const pull = await seed('resend-pull');
    const pulled = await asked(pull, pull.coordB, { criterionKey: criterionKeyOf(pull.criterionB) });
    await confirm(pull, pulled.id);
    const again = await ask(pull, pull.coordB, { criterionKey: criterionKeyOf(pull.criterionB) }) as {
      projectId: string | null;
    };
    assert.equal(again.projectId, pull.projectB);
    assert.equal((await taskRow(pull.task)).criterion_definition_id, pull.criterionB);
    assert.deepEqual((await requests(pull.ownerId)).map((row) => row.state), ['APPLIED']);
  });

  // ------------------------------------------------------------------------------------------
  // No, and a yes that has expired.
  // ------------------------------------------------------------------------------------------

  await t.test('a no leaves the task where it is', async () => {
    const w = await seed('deny');
    const question = await asked(w, w.coordA);
    const before = await taskRow(w.task);
    const answer = await deny(w, question.id);
    assert.equal(answer.row.state, 'DENIED');
    assert.deepEqual(await taskRow(w.task), before);
    const late = await refusalOf(() => confirm(w, question.id));
    assert.equal(late.status, 409);
    assert.deepEqual(await taskRow(w.task), before);
    assert.equal((await requestRow(question.id)).state, 'DENIED');
    assert.deepEqual(await moves(w.ownerId), []);
  });

  await t.test('an expired yes moves nothing, whether the agent asks again or the owner confirms', async () => {
    // A yes that outlived its deadline without moving anything. A confirmation applies the move it
    // answers, so no current path leaves one; it is written here directly.
    const w = await seed('expired');
    const question = await asked(w, w.coordA);
    await admin.query(
      `UPDATE "project_handoff_approval"
          SET "state" = 'APPROVED', "decided_by" = 'USER', "decided_by_user_id" = $2::uuid,
              "decided_at" = (now() AT TIME ZONE 'UTC') - interval '8 days',
              "expires_at" = (now() AT TIME ZONE 'UTC') - interval '1 day'
        WHERE "id" = $1::uuid`, [question.id, w.ownerId]);
    const stale = await requestRow(question.id);
    const before = await taskRow(w.task);

    const resent = await refusalOf(() => ask(w, w.coordA));
    assert.equal(resent.body.code, 'APPROVAL_EXPIRED');
    assert.equal(resent.body.handoffId, question.id);

    const confirmed = await refusalOf(() => confirm(w, question.id));
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.code, 'APPROVAL_EXPIRED');
    assert.equal(confirmed.body.handoffId, question.id);

    assert.deepEqual(await taskRow(w.task), before);
    assert.deepEqual(await requestRow(question.id), stale);
    assert.deepEqual(await moves(w.ownerId), []);
  });

  // ------------------------------------------------------------------------------------------
  // A move that can no longer be made: refused, nothing written, the request still waiting.
  // ------------------------------------------------------------------------------------------

  await t.test('a confirmation while the task is being landed fails, writes nothing, and works once it has ended', async () => {
    const w = await seed('landing');
    const question = await asked(w, w.coordA);
    const pending = await requestRow(question.id);
    const codebase = randomUUID();
    await admin.query(
      `INSERT INTO "project_codebase"("id","project_id","owner_id","canonical_repo_url","upstream_ref",
         "integration_ref","ref_authority","updated_at")
       VALUES ($1,$2,$3,$4,'refs/heads/main','refs/heads/main','REMOTE',now())`,
      [codebase, w.projectA, w.ownerId, REPO]);
    const job = randomUUID();
    await admin.query(
      `INSERT INTO "project_integration_job"("id","project_id","owner_id","codebase_id","kind","state",
         "task_id","serial_key","target_ref","upstream_ref","source_ref","idempotency_key","updated_at")
       VALUES ($1,$2,$3,$4,'LAND_TASK','QUEUED',$5,$6,'refs/heads/main','refs/heads/main',
         'refs/heads/orbit/move-confirm',$7,now())`,
      [job, w.projectA, w.ownerId, codebase, w.task, `${REPO}#main#${job}`, `move-confirm-${job}`]);
    for (const state of ['QUEUED', 'RUNNING']) {
      await admin.query('UPDATE "project_integration_job" SET "state" = $2 WHERE "id" = $1::uuid', [job, state]);
      const refused = await refusalOf(() => confirm(w, question.id));
      assert.equal(refused.status, 409, state);
      assert.equal(refused.body.code, 'MOVE_TASK_LANDING_IN_FLIGHT', state);
      assert.equal(refused.body.jobId, job, state);
      assert.equal(refused.body.taskId, w.task, state);
      assert.equal(refused.body.handoffId, question.id, state);
      assert.equal(refused.body.handoffState, 'PENDING', state);
      assert.deepEqual(await requestRow(question.id), pending, `${state}: the request is untouched`);
      assert.equal((await taskRow(w.task)).project_id, w.projectA, state);
      assert.deepEqual(await moves(w.ownerId), [], state);
    }
    await admin.query(
      `UPDATE "project_integration_job" SET "state" = 'CANCELLED', "finished_at" = now() WHERE "id" = $1::uuid`,
      [job]);
    const answer = await confirm(w, question.id);
    assert.equal(answer.row.state, 'APPLIED');
    assert.equal((await taskRow(w.task)).project_id, w.projectB);
  });

  await t.test('a confirmation after the task has gone elsewhere fails, and the request can still be denied', async () => {
    const w = await seed('moved-away');
    const question = await asked(w, w.coordA);
    // The owner files it somewhere else themselves while the question waits.
    await tasks.update(w.ownerId, w.task, { projectId: w.projectC, criterionKey: null } as never);
    const refused = await refusalOf(() => confirm(w, question.id));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'MOVE_TASK_SUBJECT_MOVED');
    assert.equal(refused.body.handoffState, 'PENDING');
    assert.match(String(refused.body.message), /nothing was written/);
    assert.equal((await taskRow(w.task)).project_id, w.projectC);
    assert.equal((await requestRow(question.id)).state, 'PENDING');
    assert.equal((await deny(w, question.id)).row.state, 'DENIED');
    assert.deepEqual(await moves(w.ownerId), []);
  });

  await t.test('a confirmation that would leave work behind, or meets a settled or changed target, fails', async () => {
    // A subtask filed under the task after the question was asked.
    const split = await seed('subtask');
    const question = await asked(split, split.coordA);
    const subtask = await insertTask(split, 'subtask: a part of it', split.projectA, {
      parent_task_id: split.task,
    });
    const refused = await refusalOf(() => confirm(split, question.id));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'MOVE_TASK_HIERARCHY_CONFLICT');
    assert.match(String(refused.body.message), /subtask/);
    assert.equal((await requestRow(question.id)).state, 'PENDING');
    assert.equal((await taskRow(split.task)).project_id, split.projectA);
    // Once nothing would be left behind, the same request is confirmed.
    await admin.query('UPDATE "task" SET "parent_task_id" = NULL WHERE "id" = $1::uuid', [subtask]);
    assert.equal((await confirm(split, question.id)).row.state, 'APPLIED');
    assert.equal((await taskRow(split.task)).project_id, split.projectB);

    // The target settled while the question waited.
    const settled = await seed('settled');
    const toSettled = await asked(settled, settled.coordA);
    await admin.query(`UPDATE "project" SET "status" = 'CANCELLED'::"project_status" WHERE "id" = $1::uuid`,
      [settled.projectB]);
    const closed = await refusalOf(() => confirm(settled, toSettled.id));
    assert.equal(closed.status, 409);
    assert.equal(closed.body.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal((await requestRow(toSettled.id)).state, 'PENDING');
    assert.equal((await taskRow(settled.task)).project_id, settled.projectA);

    // The criterion the request named was deleted while it waited.
    const gone = await seed('criterion-gone');
    const named = await asked(gone, gone.coordB, { criterionKey: criterionKeyOf(gone.criterionB) });
    await admin.query('DELETE FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid',
      [gone.criterionB]);
    const missing = await refusalOf(() => confirm(gone, named.id));
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'MOVE_TASK_CRITERION_GONE');
    assert.equal((await requestRow(named.id)).state, 'PENDING');
    assert.equal((await taskRow(gone.task)).project_id, gone.projectA);
    assert.deepEqual(
      [...await moves(split.ownerId), ...await moves(settled.ownerId), ...await moves(gone.ownerId)]
        .map((row) => (row.payload as Record<string, unknown>).handoffId),
      [question.id],
      'only the confirmation that applied recorded a move',
    );
  });

  // ------------------------------------------------------------------------------------------
  // A run in progress goes with its task, and keeps working.
  // ------------------------------------------------------------------------------------------

  await t.test('a task whose run is live moves with it, and the run goes on writing in the new project', async () => {
    const w = await seed('live-run');
    const question = await asked(w, w.coordB, { criterionKey: criterionKeyOf(w.criterionB) }, w.work);
    await confirm(w, question.id);
    assert.deepEqual(await taskRow(w.work), {
      project_id: w.projectB, criterion_definition_id: w.criterionB, criterion_revision: 1,
      description: null,
    });
    const { rows: [run] } = await admin.query(
      'SELECT "status"::text AS "status", "task_id" FROM "session" WHERE "id" = $1::uuid', [w.worker]);
    assert.deepEqual(run, { status: 'RUNNING', task_id: w.work }, 'the run is untouched and still holds its task');

    // Its own task, in the scope that moved with it — not refused as a takeover.
    const edited = await tasks.update(w.ownerId, w.work, {
      description: 'still working, now for B',
    } as never, w.worker) as { projectId: string | null };
    assert.equal(edited.projectId, w.projectB);
    assert.equal((await taskRow(w.work)).description, 'still working, now for B');

    // Its progress.
    const reported = await progress.report(w.ownerId, w.work, { phase: 'after the move' } as never);
    assert.equal((reported as { phase: string | null }).phase, 'after the move');

    // Its evidence, judged against the standard of the project it is in now.
    const toolUseId = `toolu_${uuidToBase62(w.work)}`;
    await prisma.toolCall.create({
      data: { sessionId: w.worker, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false },
    });
    const submitted = await evidence.submit(
      w.ownerId, w.work, { type: CreatorType.AGENT, id: w.workspaceId },
      {
        sourceSessionId: w.worker,
        evidence: {
          claim: 'the work is done, in the project it moved to',
          criterion: { key: criterionKeyOf(w.criterionB), text: 'live-run: what B wants' },
          checks: [{ kind: 'TOOL_CALL', ref: toolUseId }],
          gaps: [],
        },
      },
    ) as { revision: string; criterionMatch: { key: string; matchesLive: boolean } | null };
    assert.equal(submitted.revision, '1');
    assert.deepEqual(
      submitted.criterionMatch && {
        key: submitted.criterionMatch.key, matchesLive: submitted.criterionMatch.matchesLive,
      },
      { key: criterionKeyOf(w.criterionB), matchesLive: true },
      'quoted against the criterion the task serves in B',
    );

    // And what it notices is filed under the project it works for now.
    const noticed = await tasks.create(w.ownerId, {
      title: 'live-run: noticed after the move', completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'it is written down',
    } as never, { type: CreatorType.AGENT, id: w.workspaceId } as never, w.worker) as { projectId: string | null };
    assert.equal(noticed.projectId, w.projectB);

    // Every other move of a task whose run is live is still refused. The owner's own:
    const ownMove = await refusalOf(() =>
      tasks.update(w.ownerId, w.work, { projectId: w.projectC, criterionKey: null } as never));
    assert.equal(ownMove.status, 409);
    assert.match(String(ownMove.body.message), /live run/);
    // A raw writer:
    await assert.rejects(
      () => admin.query('UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid', [w.work, w.projectC]),
      /TASK_CLAIMED_PROJECT_MOVE/,
    );
    // And a writer naming the spent yes: it was good for one move.
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('orbit.move_task_handoff_id', $1, true)`, [question.id]);
      await assert.rejects(
        () => admin.query('UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid', [w.work, w.projectA]),
        /TASK_CLAIMED_PROJECT_MOVE/,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.equal((await taskRow(w.work)).project_id, w.projectB);
  });

  await t.test('a run whose task moves while its write is on the way is told to send it again, not to yield', async () => {
    const w = await seed('race');
    const question = await asked(w, w.coordB, {}, w.work);
    // Hold A's row, the lock the run's write takes before it re-reads its scope, and move the task
    // in that same transaction, as the confirmation does — so the write was admitted under A and
    // re-reads its scope after the task is in B.
    const mover = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await mover.connect();
    try {
      await mover.query('BEGIN');
      await mover.query('SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [w.projectA]);
      const write = refusalOf(() =>
        tasks.update(w.ownerId, w.work, { description: 'racing the move' } as never, w.worker));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows: [{ waiting }] } = await admin.query<{ waiting: number }>(
          `SELECT count(*)::int AS "waiting" FROM "pg_stat_activity"
            WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`);
        if (waiting > 0) break;
        assert.ok(Date.now() < deadline, 'the write never reached the project lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await mover.query(
        `UPDATE "project_handoff_approval"
            SET "state" = 'APPROVED', "decided_by" = 'USER', "decided_by_user_id" = $2::uuid,
                "decided_at" = now() AT TIME ZONE 'UTC',
                "expires_at" = (now() AT TIME ZONE 'UTC') + interval '7 days'
          WHERE "id" = $1::uuid`, [question.id, w.ownerId]);
      await mover.query(`SELECT set_config('orbit.move_task_handoff_id', $1, true)`, [question.id]);
      await mover.query('UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid', [w.work, w.projectB]);
      await mover.query(
        `UPDATE "project_handoff_approval"
            SET "state" = 'APPLIED', "applied_task_id" = $2::uuid, "applied_at" = now() AT TIME ZONE 'UTC'
          WHERE "id" = $1::uuid`, [question.id, w.work]);
      await mover.query('COMMIT');
      const refused = await write;
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'TASK_FACT_SCOPE_MOVED');
      assert.equal(refused.body.requiredAction, 'RETRY');
      assert.match(String(refused.body.message), /nothing was written/);
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined);
      await mover.end().catch(() => undefined);
    }
    assert.equal((await taskRow(w.work)).description, null, 'the refused write wrote nothing');
    // Sent again, it is admitted under the scope the run holds now.
    const retried = await tasks.update(w.ownerId, w.work, {
      description: 'racing the move',
    } as never, w.worker) as { projectId: string | null };
    assert.equal(retried.projectId, w.projectB);
    assert.equal((await taskRow(w.work)).description, 'racing the move');
  });
});
