/**
 * The done card's "Move to a follow-up…" against PostgreSQL (`ProjectsService.moveCriterion`,
 * `criterion-move.ts`): the rows the unit spec models in memory, written by the real schema and its
 * triggers.
 *
 *  (1) into an existing project: the definition row and the open serving tasks are re-filed, the
 *      FAILED task's TASK_FAILED item goes with it, the DONE task stays and its declaration reads as
 *      one whose criterion is gone; A's seal moves, the move is recorded with both seals, A's owner
 *      confirmation is NOT carried to the new seal (owner decision 2026-11-12), and A's done-check
 *      (`readProjectDoneCheck`) no longer names the criterion and refuses nothing;
 *  (2) into a new project created with the title and goal given;
 *  (3) each refusal answers with its code, and the rows are as they were (the landing-in-flight
 *      refusal, which needs a whole integration line, is the unit spec's);
 *  (4) the last unmet criterion moved out of a project whose remaining criteria are met: A stays
 *      OPEN with no `done_by` after the move's own re-projection, its done-check has no finding at
 *      all, and the owner's Record as done records DONE by OWNER with no accepted gap.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criterion-move.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import { RunStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CRITERION_MOVED_ACTIVITY } from './criterion-move';
import { readCriterionMoveRecord } from './criterion-move-record';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const METHOD = 'Read it and say whether it holds';

test('an unmet criterion and its open tasks move to a follow-up project; each refusal has its code',
  { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
    const url = URL!;
    assertCoordinatorPgUrlIsIsolated(url);
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma: PrismaClient = prismaClientFor(url);
    t.after(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });

    const db = prisma as unknown as PrismaService;
    const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
    const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
    const sessions = new SessionsService(db, queue, realtime);
    const acceptance = new ProjectAcceptanceService(db, sessions);
    const projects = new ProjectsService(db, acceptance, sessions, realtime);
    const completionInputs = {
      routeSettledUnmerged: async () => [],
      routeSettledProjects: async () => [],
      routeReadyCriteria: async () => [],
      routeUnlandedCriteria: async () => [],
      routeReadyDependents: async () => [],
      routeTaskExceptions: async () => [],
    } as unknown as CompletionInputRouter;
    const tasks = new TasksService(
      prisma as never,
      {} as never,
      { publishTaskChanged() {}, publishForUser() {}, publishTaskResync() {} } as never,
      undefined,
      completionInputs,
    );

    const ownerId = randomUUID();
    await prisma.user.create({
      data: { id: ownerId, email: `move-${ownerId}@criterion-move.invalid`, name: 'Owner', passwordHash: 'x' },
    });

    async function project(title: string, criteria: string[]) {
      const id = randomUUID();
      await prisma.project.create({ data: { id, ownerId, title } });
      const written = await projects.update(ownerId, id, {
        acceptanceCriteriaItems: criteria.map((text) => ({ text, verificationMethod: METHOD })),
      } as never);
      return { id, keys: (written.acceptanceCriteriaItems as Array<{ id: string; key: string }>) };
    }
    async function task(projectId: string, title: string, criterionKey: string, status = 'OPEN') {
      const created = await tasks.create(ownerId, {
        title,
        projectId,
        criterionKey,
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
      } as never);
      if (status === 'DONE') {
        const done = await sql.query(
          `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "acceptance_command" = 'true'`,
          [created.id]);
        assert.equal(done.rowCount, 1);
      } else if (status !== 'OPEN') {
        await prisma.task.update({ where: { id: created.id }, data: { status: status as never } });
      }
      return created.id;
    }
    async function taskFailedItem(projectId: string, taskId: string, kind = 'TASK_FAILED') {
      const id = randomUUID();
      await prisma.projectOpenItem.create({
        data: {
          id, projectId, ownerId, kind, assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR', taskId,
          dedupeKey: `${kind}:${taskId}`, title: `${kind} about ${taskId}`, payload: {},
          waitingSince: new Date(), assignedAt: new Date(),
        },
      });
      return id;
    }
    /** The usual shape: criterion 1 met, criterion 2 held by an open task, a FAILED one and a DONE one. */
    async function shape(title: string) {
      const a = await project(title, ['the first holds', 'the second holds']);
      const [c1, c2] = a.keys;
      const met = await task(a.id, 'met', c1.key, 'DONE');
      const open = await task(a.id, 'open', c2.key);
      const failed = await task(a.id, 'failed', c2.key, 'FAILED');
      const done = await task(a.id, 'done', c2.key, 'DONE');
      const item = await taskFailedItem(a.id, failed);
      const seal = (await acceptance.standardSetConfirmation(ownerId, a.id)).currentVersion.digest;
      await acceptance.confirmStandardSet(ownerId, a.id, { criteriaDigest: seal });
      return { a: a.id, c1Key: c1.key, c2: c2.id, c2Key: c2.key, met, open, failed, done, item };
    }
    const unsatisfied = async (projectId: string) => (await acceptance.readProjectDoneCheck(ownerId, projectId))
      .findings.filter((finding) => finding.severity === 'REFUSE');

    await t.test('(1) into an existing project', async () => {
      const s = await shape('A, existing');
      const b = await project('B, existing', ['B already states this']);
      const before = await unsatisfied(s.a);
      assert.deepEqual(before.map((f) => f.code).sort(), ['DONE_CRITERION_UNSATISFIED', 'DONE_OWNER_ITEMS_OPEN']);

      const result = await projects.moveCriterion(ownerId, s.a, s.c2Key, { toProjectId: b.id });
      assert.equal(result.toProjectId, b.id);
      assert.deepEqual([...result.movedTaskIds].sort(), [s.open, s.failed].sort());
      assert.deepEqual(result.keptTaskIds, [s.done]);
      assert.deepEqual(result.movedOpenItemIds, [s.item]);

      const definition = await prisma.projectAcceptanceCriterionDefinition.findUniqueOrThrow({ where: { id: s.c2 } });
      assert.equal(definition.projectId, b.id);
      assert.equal(definition.ordinal, 2);
      assert.equal(definition.revision, 1);
      const rows = new Map((await prisma.task.findMany({
        where: { id: { in: [s.open, s.failed, s.done, s.met] } },
        select: { id: true, projectId: true, criterionDefinitionId: true, criterionRevision: true },
      })).map((row) => [row.id, row]));
      assert.equal(rows.get(s.open)!.projectId, b.id);
      assert.equal(rows.get(s.open)!.criterionDefinitionId, s.c2);
      assert.equal(rows.get(s.failed)!.projectId, b.id);
      assert.equal(rows.get(s.done)!.projectId, s.a);
      assert.equal(rows.get(s.done)!.criterionDefinitionId, null);
      assert.equal(rows.get(s.done)!.criterionRevision, 1);
      assert.equal((await prisma.projectOpenItem.findUniqueOrThrow({ where: { id: s.item } })).projectId, b.id);

      // A's criteria revision: one criterion left, a new seal, recorded beside the old one. The
      // owner's confirmation stays on the old seal: A's reduced set is theirs to record done.
      const confirmation = await acceptance.standardSetConfirmation(ownerId, s.a);
      assert.equal(confirmation.currentVersion.digest, result.fromCriteriaDigest.after);
      assert.notEqual(result.fromCriteriaDigest.after, result.fromCriteriaDigest.before);
      assert.equal(confirmation.state, 'STALE');
      assert.equal(confirmation.confirmation?.criteriaDigest, result.fromCriteriaDigest.before);
      assert.equal(await prisma.projectStandardSetConfirmation.count({ where: { projectId: s.a } }), 1);
      const recorded = await prisma.activity.findFirstOrThrow({
        where: { type: CRITERION_MOVED_ACTIVITY, actorId: ownerId, payload: { path: ['toProjectId'], equals: b.id } },
      });
      assert.equal((recorded.payload as Record<string, unknown>).fromCriteriaDigestBefore, result.fromCriteriaDigest.before);
      // B gained a criterion nobody confirmed there.
      assert.equal((await prisma.projectAcceptanceCriterionDefinition.count({ where: { projectId: b.id } })), 2);

      // A's done-check no longer names the criterion, and nothing refuses: recordable done, no gap
      // beyond the landing warnings every unlanded criterion carries.
      const check = await acceptance.readProjectDoneCheck(ownerId, s.a);
      assert.deepEqual(check.criteria.map((c) => c.stated.text), ['the first holds']);
      assert.deepEqual(await unsatisfied(s.a), []);
      assert.ok(check.findings.every((f) => f.criterion?.key !== s.c2Key));

      // The move record on both project reads (board 02 G/I, 0555): A lists the criterion it moved
      // out — its number on A's cards, its words, where it went and when — and B's criterion row
      // says where it came from. B's own criterion came from nowhere.
      const aRead = await projects.get(ownerId, s.a);
      assert.equal(aRead.criteriaMovedOut.length, 1);
      const out = aRead.criteriaMovedOut[0];
      assert.equal(out.criterionKey, s.c2Key);
      assert.equal(out.ordinal, 2);
      assert.equal(out.text, definition.text);
      assert.equal(out.toProjectId, b.id);
      assert.equal(out.toProjectTitle, 'B, existing');
      assert.equal(out.movedAt.getTime(), recorded.createdAt.getTime());
      assert.ok(aRead.acceptanceCriteriaItems.every((item) => item.movedFrom === null));
      const bRead = await projects.get(ownerId, b.id);
      assert.deepEqual(bRead.criteriaMovedOut, []);
      const moved = bRead.acceptanceCriteriaItems.find((item) => item.id === s.c2)!;
      assert.equal(moved.movedFrom?.fromProjectId, s.a);
      assert.equal(moved.movedFrom?.fromProjectTitle, 'A, existing');
      assert.equal(moved.movedFrom?.movedAt.getTime(), recorded.createdAt.getTime());
      assert.equal(bRead.acceptanceCriteriaItems.find((item) => item.id !== s.c2)!.movedFrom, null);

      // Another owner's read of the same ids sees no record of this owner's move.
      const stranger = randomUUID();
      const none = await readCriterionMoveRecord(prisma, stranger, s.a, (id) => id);
      assert.deepEqual(none.movedOut, []);

      // The read is served by 0555's partial indexes — bounded by the move rows, never a scan of
      // activity. (On a table this small the planner may read one of them whole rather than both.)
      await sql.query('BEGIN');
      try {
        await sql.query('SET LOCAL enable_seqscan = off');
        const { rows: plan } = await sql.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT a."id" FROM "activity" a
            WHERE a."type" = 'project.criterion_moved' AND a."actor_id" = $1::uuid
              AND (a.payload->>'fromProjectId' = $2 OR a.payload->>'toProjectId' = $2)`, [ownerId, s.a]);
        const text = plan.map((row) => row['QUERY PLAN']).join('\n');
        assert.match(text, /Index Scan on activity_criterion_moved_(from|to)_idx/);
        assert.doesNotMatch(text, /Seq Scan on activity/);
      } finally {
        await sql.query('ROLLBACK');
      }
    });

    await t.test('(1b) a criterion moved back is no longer "moved out", and reads "moved from" again', async () => {
      const s = await shape('A, round trip');
      const b = await project('B, round trip', ['B states this']);
      await projects.moveCriterion(ownerId, s.a, s.c2Key, { toProjectId: b.id });
      await prisma.task.updateMany({ where: { projectId: b.id, status: { notIn: ['DONE', 'CANCELLED'] } }, data: { status: 'CANCELLED' } });
      await projects.moveCriterion(ownerId, b.id, s.c2Key, { toProjectId: s.a });
      const aRead = await projects.get(ownerId, s.a);
      assert.deepEqual(aRead.criteriaMovedOut, []);
      assert.equal(aRead.acceptanceCriteriaItems.find((item) => item.id === s.c2)!.movedFrom?.fromProjectId, b.id);
      const bRead = await projects.get(ownerId, b.id);
      assert.equal(bRead.criteriaMovedOut.length, 1);
      assert.equal(bRead.criteriaMovedOut[0].toProjectId, s.a);
      assert.equal(bRead.criteriaMovedOut[0].ordinal, 2, 'its number on B, the project it left');
    });

    await t.test('(2) into a new project', async () => {
      const s = await shape('A, new');
      const result = await projects.moveCriterion(ownerId, s.a, s.c2Key, {
        newProject: { title: 'Follow-up of A', goal: 'Finish the second' },
      });
      assert.equal(result.createdProject, true);
      const created = await prisma.project.findUniqueOrThrow({ where: { id: result.toProjectId } });
      assert.equal(created.ownerId, ownerId);
      assert.equal(created.title, 'Follow-up of A');
      assert.equal(created.goal, 'Finish the second');
      assert.equal(created.status, 'OPEN');
      const definition = await prisma.projectAcceptanceCriterionDefinition.findUniqueOrThrow({ where: { id: s.c2 } });
      assert.equal(definition.projectId, created.id);
      assert.equal(definition.ordinal, 1);
      assert.equal(await prisma.task.count({ where: { projectId: created.id } }), 2);
      assert.deepEqual(await unsatisfied(s.a), []);
    });

    await t.test('(3) each refusal answers with its code and writes nothing', async () => {
      const snapshot = async (a: string) => JSON.stringify({
        definitions: await prisma.projectAcceptanceCriterionDefinition.findMany({
          where: { projectId: a }, orderBy: { id: 'asc' }, select: { id: true, projectId: true, ordinal: true },
        }),
        tasks: await prisma.task.findMany({
          where: { ownerId }, orderBy: { id: 'asc' }, select: { id: true, projectId: true, criterionDefinitionId: true },
        }),
        projects: await prisma.project.count({ where: { ownerId } }),
      });
      const refused = async (
        code: string,
        arrange: (s: Awaited<ReturnType<typeof shape>>, b: string) => Promise<unknown>,
        criterion: 'c1' | 'c2' = 'c2',
      ) => {
        const s = await shape(`A, ${code}`);
        const b = await project(`B, ${code}`, ['B states this']);
        await arrange(s, b.id);
        const before = await snapshot(s.a);
        const key = criterion === 'c1' ? s.c1Key : s.c2Key;
        const error = await projects.moveCriterion(ownerId, s.a, key, { toProjectId: b.id }).then(
          () => assert.fail(`${code}: the move was not refused`), (e: unknown) => e);
        assert.ok(error instanceof HttpException, `${code}: ${String(error)}`);
        assert.equal((error.getResponse() as { code?: string }).code, code);
        assert.equal(await snapshot(s.a), before, `${code}: nothing was written`);
      };

      await refused('CRITERION_MOVE_TARGET_NOT_OPEN', (_s, b) =>
        prisma.project.update({ where: { id: b }, data: { status: 'CANCELLED' } }));
      await refused('CRITERION_MOVE_CRITERION_MET', async () => undefined, 'c1');
      await refused('CRITERION_MOVE_TASK_RUNNING', (s) => prisma.session.create({
        data: {
          ownerId, creatorId: ownerId, taskId: s.open, title: 'a run', prompt: 'work', status: RunStatus.RUNNING,
        },
      }));
      // CRITERION_MOVE_TASK_LANDING needs a line and a queued landing job; the unit spec holds it.
      await refused('CRITERION_MOVE_DEPENDENCY_CROSSES', async (s) => {
        const other = await tasks.create(ownerId, { title: 'stays', projectId: s.a } as never);
        await prisma.taskDependency.create({ data: { taskId: other.id, dependsOnTaskId: s.open } });
      });
      await refused('CRITERION_MOVE_LINK_CROSSES', async (s) => {
        const parent = await tasks.create(ownerId, { title: 'parent', projectId: s.a } as never);
        await prisma.task.update({ where: { id: s.open }, data: { parentTaskId: parent.id } });
      });
      await refused('CRITERION_MOVE_TASK_ITEM_OPEN', (s) => taskFailedItem(s.a, s.open, 'INTEGRATION_CONFLICT'));
    });

    await t.test('(4) the last unmet criterion moved out: A is not done by itself, the owner records it', async () => {
      // A marked non-code, so landing reads nothing and the only thing between A and a derived DONE
      // is the set's confirmation — the one fact this case is about. Carrying the confirmation to
      // the new seal (the old behaviour) made the move's re-projection record A DONE by DERIVED.
      const a = await project('A, last unmet', ['the first holds', 'the second holds']);
      const [c1, c2] = a.keys;
      await prisma.project.update({
        where: { id: a.id },
        data: { nonCode: true, nonCodeSetBy: 'OWNER', nonCodeSetAt: new Date() },
      });
      await task(a.id, 'met', c1.key, 'DONE');
      await task(a.id, 'open', c2.key);
      const seal = (await acceptance.standardSetConfirmation(ownerId, a.id)).currentVersion.digest;
      await acceptance.confirmStandardSet(ownerId, a.id, { criteriaDigest: seal });
      const before = await acceptance.readProjectDoneCheck(ownerId, a.id);
      assert.deepEqual(before.findings.map((f) => f.code), ['DONE_CRITERION_UNSATISFIED']);

      await projects.moveCriterion(ownerId, a.id, c2.key, {
        newProject: { title: 'Follow-up of A, last unmet', goal: 'Finish the second' },
      });

      // The move's post-commit re-projection has run; A is still the owner's to record.
      const after = await prisma.project.findUniqueOrThrow({ where: { id: a.id } });
      assert.equal(after.status, 'OPEN', 'Orbit does not record A done by itself');
      assert.equal(after.doneBy, null);
      assert.equal(after.doneAt, null);

      // The card: one criterion, met, and nothing in the way — no refusal and no gap.
      const check = await acceptance.readProjectDoneCheck(ownerId, a.id);
      assert.deepEqual(check.criteria.map((c) => [c.stated.text, c.satisfied]), [['the first holds', true]]);
      assert.deepEqual(check.findings, []);

      // The owner's plain Record as done.
      const done = await acceptance.recordProjectDone(ownerId, a.id, {
        criteriaDigest: check.criteriaDigest,
        acceptedGaps: [],
      });
      assert.equal(done.doneBy, 'OWNER');
      assert.deepEqual(done.acceptedGaps, []);
      const recorded = await prisma.project.findUniqueOrThrow({ where: { id: a.id } });
      assert.equal(recorded.status, 'DONE');
      assert.equal(recorded.doneBy, 'OWNER');
      assert.deepEqual(recorded.acceptedGaps, []);
      assert.equal(recorded.doneCriteriaDigest, check.criteriaDigest);
    });
  });
