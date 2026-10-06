/**
 * A task moved OUT of a settled project, on real PostgreSQL — the request this project started from,
 * replayed.
 *
 * On 2026-10-06 two tasks were filed under project 34ZurCP3bv9yLXGVyUGnx, DONE — derived, every
 * criterion met, landed and confirmed, its DONE recorded against a criteria digest — and belonged to
 * the OPEN project 34b7qmu7w992fd5pVBHYW: 34ayVD7EJu0uIG1SCgBPv, OPEN with a run going, and
 * 34b0v5mmSmPFJUa70Acxr, DONE. Neither served any of the settled project's criteria. The target's
 * coordinator asked for them, and §4 R8 refused because one end of the move was settled — approved
 * or not, so the account owner's confirmation could not have helped either.
 *
 * The account owner's rule since (2026-10-06): with their confirmation a task may be moved from a
 * settled (DONE or CANCELLED) project into an OPEN one, provided it serves none of the settled
 * project's criteria. One that serves one is refused, with a code that says so, even when the
 * request would take the declaration back; a move INTO a settled project is refused as before; and
 * the settled project's status, derived DONE and DONE digest do not move. Only that move is let out:
 * new work filed from a settled project is still R8's, and a dependency edge onto one is asked as it
 * always was.
 *
 * The cases:
 *  (1) the 10-06 shape: B's coordinator asks for both tasks, the owner confirms each at the card's
 *      door, both are in B, the run goes with its task — and the settled project reads the same
 *      before and after: its row, its derived DONE, and what the post-commit projection (wired below
 *      as production wires it) and a projection run afterwards make of it;
 *  (2) a task one of its criteria counts is refused MOVE_TASK_SERVES_SETTLED_CRITERION from either
 *      end, asked with a target criterion (which takes the source's back) or without, and no question
 *      is filed;
 *  (3) a criterion declared while a question waits: the confirmation is refused, writes nothing, the
 *      question stays PENDING — and once the declaration is gone, the same question is confirmed;
 *  (4) into a settled project: refused when asked, and refused at confirmation when the target
 *      settled while the question waited;
 *  (5) everything else at a settled end is as it was: a filing from the settled project is R8's, and
 *      a dependency edge onto its finished work still files its question.
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-move-out-of-settled.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { CreatorType, RunStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import type { CompletionInputRouter } from '../projects/completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { readDerivedProjectDone, storeDerivedProjectStatus } from '../projects/project-done-derived';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

type Refusal = { status: number; body: Record<string, unknown> };

/** The settled project's DONE, as its row records it. */
type DoneRecord = {
  status: string;
  done_by: string | null;
  done_at: Date | null;
  done_criteria_digest: string | null;
  accepted_gaps: unknown;
  updated_at: Date;
};

test('a task none of a settled project\'s criteria count leaves it by a confirmed move, and nothing else does', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
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

  // The production wiring over one client. The publishes are inert, and so is the router — what a
  // write WAKES is another unit's question — but the router is there: it is the guard the task
  // writer's post-commit edge sits behind, and that edge is what re-projects `project.status` after
  // a move (`deliverSettledProjects` → `storeDerivedProjectStatus`). Without it nothing here could
  // have reopened the settled project, and its standing still would prove nothing.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined });
  const completionInputs = {
    routeSettledUnmerged: async () => [],
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeReadyDependents: async () => [],
    routeTaskExceptions: async () => [],
  } as unknown as CompletionInputRouter;
  const acceptance = new ProjectAcceptanceService(db);
  const projects = new ProjectsService(db, acceptance);
  const receipts = new MergeReceiptService(db, completionInputs);
  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(prisma as never, {} as never, realtime as never, handoffs, completionInputs);
  // The door the confirmation card posts to: `POST /projects/:id/handoffs/:handoffId/decision`.
  const card = new ProjectsController(
    {} as never, {} as never, handoffs, {} as never, {} as never, {} as never, {} as never,
  );

  // ── the account, its runner and the four projects ──────────────────────────────────────────────

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await admin.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'The account owner','x')`,
    [ownerId, `owner-${ownerId}@move-out-of-settled.invalid`],
  );
  await admin.query(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
     VALUES ($1,$2,'the runner','ONLINE',$3,now())`,
    [runnerId, ownerId, `move-out-of-settled-${runnerId}`],
  );
  await admin.query(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
     VALUES ($1,$2,'the workspace',$3,true,true)`,
    [workspaceId, ownerId, runnerId],
  );

  async function session(title: string, status = 'RUNNING'): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'fixture',$2,'claude',$5::"run_status",'USER'::"session_dispatch_origin",now())`,
      [id, ownerId, workspaceId, title, status],
    );
    return id;
  }

  /** A project with a coordinator conversation, as every end of a move here has. */
  async function coordinated(title: string): Promise<{ id: string; coordinator: string }> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
       VALUES ($1,$2,$3,true,now())`,
      [id, ownerId, title],
    );
    await admin.query(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
         ON CONFLICT ("project_id") DO NOTHING`,
      [id],
    );
    const coordinator = await session(`coordinator of ${title}`);
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [id, coordinator]);
    return { id, coordinator };
  }

  async function stateCriteria(projectId: string, texts: string[]) {
    return criteriaFromDefinitions((await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: 'HUMAN' })),
    } as never)).acceptanceCriteriaItems);
  }

  /** An EXECUTABLE task filed by the owner, as task_create files one. */
  async function filed(
    projectId: string,
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const task = await tasks.create(ownerId, {
      title,
      projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      ...extra,
    } as never) as { id: string };
    return task.id;
  }

  /** Settle it the way `runnerApi.turnComplete` does, through 0193/0230's DONE fence. */
  async function settle(taskId: string) {
    const written = await admin.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** The finished work for one criterion, and its merge into the default branch. */
  async function landedWork(projectId: string, criterionKey: string, title: string, nibble: string) {
    const taskId = await filed(projectId, title, { criterionKey });
    await settle(taskId);
    const ran = randomUUID();
    await prisma.session.create({
      data: {
        id: ran, ownerId, creatorId: ownerId, taskId, title: `ran ${title}`, prompt: 'do the work',
        status: RunStatus.SUCCEEDED, branch: `orbit/${nibble}`, isolationStatus: 'worktree',
      },
    });
    await receipts.record(ownerId, ran, {
      result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
      targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
    } as never, 'AGENT');
    return taskId;
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    throw new assert.AssertionError({ message: 'the call was not refused' });
  }

  async function projectOf(taskId: string): Promise<string | null> {
    const { rows: [row] } = await admin.query<{ project_id: string | null }>(
      'SELECT "project_id" FROM "task" WHERE "id" = $1::uuid', [taskId]);
    return row.project_id;
  }

  async function requestsFor(taskId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await admin.query(
      `SELECT * FROM "project_handoff_approval" WHERE "subject_task_id" = $1::uuid
        ORDER BY "requested_at", "id"`, [taskId]);
    return rows;
  }

  async function requestRow(id: string): Promise<Record<string, unknown>> {
    const { rows: [row] } = await admin.query(
      'SELECT * FROM "project_handoff_approval" WHERE "id" = $1::uuid', [id]);
    return row;
  }

  async function doneRecord(projectId: string): Promise<DoneRecord> {
    const { rows: [row] } = await admin.query<DoneRecord>(
      `SELECT "status"::text AS "status", "done_by", "done_at", "done_criteria_digest",
              "accepted_gaps", "updated_at"
         FROM "project" WHERE "id" = $1::uuid`, [projectId]);
    return row;
  }

  /** Everything the settled project's acceptance is: its row, and what the projection reads. */
  async function standing(projectId: string) {
    return {
      record: await doneRecord(projectId),
      derived: await readDerivedProjectDone(db, ownerId, projectId),
    };
  }

  /** The request, as `task_update` sends it: another project, and the declaration. */
  const ask = (taskId: string, to: string, asker: string, over: Record<string, unknown> = {}) =>
    tasks.update(ownerId, taskId, {
      projectId: to, handoff: { reason: 'it belongs to the follow-up project' }, ...over,
    } as never, asker);

  /** A first request, read back: the question it filed. */
  async function asked(taskId: string, to: string, asker: string) {
    const refusal = await refusalOf(() => ask(taskId, to, asker));
    assert.equal(refusal.status, 403);
    assert.equal(refusal.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED',
      `the request files a question: ${JSON.stringify(refusal.body)}`);
    assert.equal(refusal.body.rule, 'R10_NO_APPROVAL');
    const row = await requestRow(String(refusal.body.handoffId));
    assert.equal(row.kind, 'MOVE_TASK');
    assert.equal(row.state, 'PENDING');
    assert.equal(row.subject_task_id, taskId);
    assert.equal(await projectOf(taskId), row.from_project_id, 'a request moves nothing');
    return row as Record<string, unknown> & { id: string; crossing_key: string };
  }

  const owner = { userId: ownerId, email: 'owner@move-out-of-settled.invalid', credential: { kind: 'LOGIN' as const } };
  const confirm = (projectId: string, row: { id: string; crossing_key: string }) =>
    card.decideHandoff(owner, projectId, row.id, {
      decision: 'APPROVE', acknowledgedCrossingKey: row.crossing_key,
    } as never);

  // ═══ the settled project, as 34ZurCP3bv9yLXGVyUGnx stood on 2026-10-06 ═══════════════════════

  const settled = await coordinated('DeepSeek Harness 原生接入（核心首版）');
  const followUp = await coordinated('DeepSeek Harness 首版后续改进');
  const [first, second] = await stateCriteria(settled.id, [
    'tasks created through the DeepSeek Harness entry are run by a supported dsh',
    'existing DeepSeek configurations keep running through Claude',
  ]);
  const [followUpCriterion] = await stateCriteria(followUp.id, ['the follow-up improvements ship']);
  const servingFirst = await landedWork(settled.id, first.key, 'the work criterion 1 counts', 'a');
  const servingSecond = await landedWork(settled.id, second.key, 'the work criterion 2 counts', 'b');

  // The two tasks of the incident. Neither declares a criterion.
  const running = await filed(settled.id, 'a finding still being worked on (34ayVD7EJu0uIG1SCgBPv)');
  const run = await session('the run working on it');
  await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid', [run, running]);
  const finished = await filed(settled.id, 'a finding already done (34b0v5mmSmPFJUa70Acxr)');
  await settle(finished);
  // Two more of the same kind, for (3) and (4): finished work with nothing of its own to land, and
  // open work.
  const later = await filed(settled.id, 'a rollout, done, that commits nothing', {
    codeless: true,
  });
  await settle(later);
  const open = await filed(settled.id, 'more open work none of its criteria count');

  // The owner confirms the standard set, and the projection records the project done by itself.
  const set = await acceptance.standardSetConfirmation(ownerId, settled.id);
  await acceptance.confirmStandardSet(ownerId, settled.id, { criteriaDigest: set.currentVersion.digest });
  const before = await standing(settled.id);
  assert.equal(before.record.status, 'DONE', 'the source is settled');
  assert.equal(before.record.done_by, 'DERIVED');
  assert.equal(before.record.done_criteria_digest, set.currentVersion.digest,
    'and its DONE is recorded against the criteria it was confirmed on');
  assert.equal(before.derived.done, true);
  assert.deepEqual(before.derived.withheld, []);
  assert.deepEqual(before.derived.criteria.map((criterion) => criterion.landing), ['LANDED', 'LANDED']);
  assert.equal((await doneRecord(followUp.id)).status, 'OPEN', 'the target is open');

  // ═══ (1) the 10-06 request ════════════════════════════════════════════════════════════════════

  await t.test('(1) the target\'s coordinator asks, the owner confirms, and both tasks are in the target — the settled project unchanged', async () => {
    const forRunning = await asked(running, followUp.id, followUp.coordinator);
    const forFinished = await asked(finished, followUp.id, followUp.coordinator);
    assert.equal(forRunning.from_project_id, settled.id);
    assert.equal(forRunning.to_project_id, followUp.id);
    assert.equal(forRunning.requested_by_session_id, followUp.coordinator);
    assert.deepEqual(await standing(settled.id), before, 'asking moves nothing, here either');

    for (const [taskId, question] of [[running, forRunning], [finished, forFinished]] as const) {
      const answer = await confirm(followUp.id, question);
      assert.equal(answer.row.state, 'APPLIED');
      assert.equal(answer.row.appliedTaskId, taskId);
      assert.equal(await projectOf(taskId), followUp.id, 'in the target, with nothing more from the agent');
      const row = await requestRow(question.id);
      assert.equal(row.state, 'APPLIED');
      assert.equal(row.decided_by, 'USER');
      assert.equal(row.decided_by_user_id, ownerId, 'answered by the account owner');
    }

    // The run went with its task.
    const { rows: [after] } = await admin.query(
      'SELECT "status"::text AS "status", "task_id" FROM "session" WHERE "id" = $1::uuid', [run]);
    assert.deepEqual(after, { status: 'RUNNING', task_id: running });
    const { rows: moved } = await admin.query(
      `SELECT "payload" FROM "activity" WHERE "actor_id" = $1::uuid AND "type" = 'task.moved'
        ORDER BY "created_at", "id"`, [ownerId]);
    assert.deepEqual(moved.map((row) => (row.payload as Record<string, unknown>).taskId), [running, finished],
      'two moves, each recorded as the owner\'s');

    // The settled project. Its row was not written — not its status, not the DONE it recorded, not
    // even `updated_at` — and the projection over its rows still derives the same DONE.
    assert.deepEqual(await standing(settled.id), before,
      'status, derived DONE and DONE digest are what they were before the moves');
    // ...and so does every later projection: the edge the next task write runs, run here by hand.
    await storeDerivedProjectStatus(db, ownerId, settled.id);
    assert.deepEqual(await standing(settled.id), before, 'a projection after the moves reopens nothing');
    const { rows: remaining } = await admin.query<{ id: string }>(
      'SELECT "id" FROM "task" WHERE "project_id" = $1::uuid ORDER BY "id"', [settled.id]);
    assert.deepEqual(remaining.map((row) => row.id).sort(),
      [servingFirst, servingSecond, later, open].sort(),
      'the work its criteria count stays; only the two tasks the request named left');
  });

  // ═══ (2) work the settled project's acceptance counts ═════════════════════════════════════════

  await t.test('(2) a task one of its criteria counts is refused with its own code, from either end, and nothing is filed', async () => {
    const tries: Array<[string, string, Record<string, unknown>]> = [
      ['the target\'s coordinator', followUp.coordinator, {}],
      ['the target\'s coordinator, naming the criterion it would serve there', followUp.coordinator,
        { criterionKey: followUpCriterion.key }],
      ['the settled project\'s own coordinator', settled.coordinator, {}],
      ['the settled project\'s own coordinator, with no criterion', settled.coordinator, { criterionKey: null }],
    ];
    for (const [who, asker, over] of tries) {
      const refused = await refusalOf(() => ask(servingFirst, followUp.id, asker, over));
      assert.equal(refused.status, 403, who);
      assert.equal(refused.body.code, 'MOVE_TASK_SERVES_SETTLED_CRITERION', who);
      assert.equal(refused.body.rule, 'R8B_SETTLED_CRITERION_SERVED', who);
      assert.equal(refused.body.requiredAction, 'REOPEN_PROJECT_FIRST', who);
      assert.equal(refused.body.responsible, 'USER', who);
      assert.equal(refused.body.taskId, servingFirst, who);
      assert.deepEqual(refused.body.scope, { projectId: settled.id }, who);
      assert.deepEqual(refused.body.target, { projectId: followUp.id }, who);
      assert.match(String(refused.body.message), /serves an acceptance criterion/, who);
      assert.equal(refused.body.handoffId, null, `${who}: no question`);
    }
    assert.deepEqual(await requestsFor(servingFirst), [], 'nobody is asked');
    assert.equal(await projectOf(servingFirst), settled.id);
    assert.deepEqual(await standing(settled.id), before);
  });

  // ═══ (3) a criterion declared while the question waits ════════════════════════════════════════

  await t.test('(3) a task that came to serve one while its question waited is refused at confirmation, and the question waits on', async () => {
    const question = await asked(later, followUp.id, followUp.coordinator);
    // The account owner decides, in the meantime, that this finished rollout is part of what
    // criterion 1 counted. Finished and with nothing of its own to land, it leaves the settled
    // project's DONE standing.
    await tasks.update(ownerId, later, { criterionKey: first.key } as never);
    assert.equal(before.record.done_criteria_digest, (await doneRecord(settled.id)).done_criteria_digest);
    assert.equal((await doneRecord(settled.id)).status, 'DONE');
    const pending = await requestRow(question.id);

    const refused = await refusalOf(() => confirm(followUp.id, question));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'MOVE_TASK_SERVES_SETTLED_CRITERION');
    assert.equal(refused.body.requiredAction, 'REOPEN_PROJECT_FIRST');
    assert.equal(refused.body.taskId, later);
    assert.equal(refused.body.handoffId, question.id);
    assert.equal(refused.body.handoffState, 'PENDING');
    assert.match(String(refused.body.message), /nothing was written, and the request is still waiting/);
    assert.deepEqual(await requestRow(question.id), pending, 'the question is exactly as it was');
    assert.equal(await projectOf(later), settled.id);

    // Once the declaration is gone again, the same question is confirmed.
    await tasks.update(ownerId, later, { criterionKey: null } as never);
    const answer = await confirm(followUp.id, question);
    assert.equal(answer.row.state, 'APPLIED');
    assert.equal(await projectOf(later), followUp.id);
    assert.deepEqual(await standing(settled.id), before,
      'declared, refused, taken back and moved: the settled project reads as it did throughout');
  });

  // ═══ (4) into a settled project ═══════════════════════════════════════════════════════════════

  await t.test('(4) nothing is moved into a settled project — asked, or confirmed after the target settled', async () => {
    for (const status of ['DONE', 'CANCELLED']) {
      const closed = await coordinated(`a project that is ${status}`);
      await admin.query(`UPDATE "project" SET "status" = $2::"project_status" WHERE "id" = $1::uuid`,
        [closed.id, status]);
      for (const [who, asker] of [['the settled source', settled.coordinator], ['the settled target', closed.coordinator]]) {
        const refused = await refusalOf(() => ask(open, closed.id, asker));
        assert.equal(refused.status, 403, `${status}, ${who}`);
        assert.equal(refused.body.code, 'PROJECT_REOPEN_REQUIRED', `${status}, ${who}`);
        assert.equal(refused.body.rule, 'R8_SETTLED_PROJECT', `${status}, ${who}`);
        assert.equal(refused.body.handoffId, null, `${status}, ${who}`);
      }
    }
    assert.deepEqual(await requestsFor(open), [], 'no question about a move into a settled project');

    // Asked while the target was open; the target is cancelled before the owner answers.
    const closing = await coordinated('a project cancelled while the question waits');
    const question = await asked(open, closing.id, closing.coordinator);
    await admin.query(`UPDATE "project" SET "status" = 'CANCELLED'::"project_status" WHERE "id" = $1::uuid`,
      [closing.id]);
    const pending = await requestRow(question.id);
    const refused = await refusalOf(() => confirm(closing.id, question));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal(refused.body.handoffState, 'PENDING');
    assert.deepEqual(await requestRow(question.id), pending);
    assert.equal(await projectOf(open), settled.id);
    assert.deepEqual(await standing(settled.id), before);
  });

  // ═══ (5) everything else at a settled end ═════════════════════════════════════════════════════

  await t.test('(5) only the move is let out: a filing from the settled project is R8\'s, and an edge onto its work is asked as before', async () => {
    const filing = await refusalOf(() => tasks.create(ownerId, {
      title: 'new work the settled project noticed', projectId: followUp.id,
      handoff: { reason: 'it belongs to the follow-up' },
    } as never, { type: CreatorType.AGENT, id: workspaceId } as never, settled.coordinator));
    assert.equal(filing.body.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal(filing.body.rule, 'R8_SETTLED_PROJECT');
    const { rows: filings } = await admin.query(
      `SELECT 1 FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid AND "kind" = 'FILE_TASK'`,
      [ownerId]);
    assert.deepEqual(filings, [], 'and files no question');

    // Work in the follow-up that waits on finished work of the settled project: the edge's question
    // is filed exactly as it was before settled projects could give anything up.
    const edge = await refusalOf(() => tasks.create(ownerId, {
      title: 'builds on what the first version shipped', projectId: followUp.id,
      dependsOnTaskIds: [servingSecond], handoff: { reason: 'it builds on it' },
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never, { type: CreatorType.AGENT, id: workspaceId } as never, followUp.coordinator));
    // The plan waits on the question its edge filed — the preflight's answer to an unanswered edge.
    assert.equal(edge.body.code, 'PLAN_PREFLIGHT_FAILED', JSON.stringify(edge.body));
    assert.deepEqual(
      (edge.body.findings as Array<{ dimension: string; code: string }>).map((finding) =>
        [finding.dimension, finding.code]),
      [['DEPENDENCY_AUTHORITY', 'APPROVAL_PENDING']],
      'the edge is a question for the owner, not a settled-project refusal',
    );
    const edges = await requestsFor(servingSecond);
    assert.deepEqual(edges.map((row) => [row.kind, row.state]), [['DEPEND_ON_TASK', 'PENDING']]);
    assert.deepEqual(await standing(settled.id), before);
  });
});
