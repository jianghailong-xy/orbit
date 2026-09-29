/**
 * In an Automatic project a session does not hand a task back to the account owner — unless the
 * project criterion the task serves asks for the owner itself.
 *
 * WHAT WENT WRONG
 * ---------------
 * OWNER_CONFIRMED is settled only by the account owner pressing Confirm done in the app. A project
 * with Automatic on (`coordinatorEnabled`) is the owner saying the coordinator settles the work, and
 * any session could still declare the criterion there: from 2026-09-14 to 2026-09-29 agents filed 35
 * such tasks in Automatic projects and the owner confirmed every one by hand, about ten of which
 * needed them at all. The owner's say over "done" is meant to come in through the ruler — a
 * criterion whose `verificationMethod` starts with OWNER_CONFIRMED — and nowhere else.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * Both sides of the rule, at every write door, read back out of the rows:
 *
 *  - refused, with nothing written: a single create, a batch (whole — the item that was fine is not
 *    written either), and an update that lands on it by changing the criterion, the criterion it
 *    serves, or the project. Against a criterion that does not ask for the owner, and against none;
 *  - let through: a criterion that asks for the owner, a write with no session header (the owner),
 *    and a project with Automatic off;
 *  - rows that already stand are not re-judged by an edit that declares nothing new, and the way
 *    out — re-declaring EVIDENCE_JUDGMENT — stays open.
 *
 * Nothing is stubbed: the service is the one the API wires, over a real client. Refusals are read
 * through a structural view of the body with every field optional, and the code and required
 * action are literals rather than imports, so this suite compiles — and fails — against an
 * implementation without the rule.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied:
 *
 *   NODE_OPTIONS=--max-old-space-size=1536 bash scripts/run-pg-spec.sh \
 *     src/apiserver/src/tasks/owner-confirmed-automatic-delegation.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException, type HttpException } from '@nestjs/common';
import { CreatorType, type PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

/** The refusal this rule introduces, as a reader of the response body sees it. */
const NOT_DELEGATED_CODE = 'OWNER_CONFIRMATION_NOT_DELEGATED';
const NOT_DELEGATED_ACTION = 'DECLARE_A_CRITERION_THE_COORDINATOR_SETTLES';

/** A refusal body with every field optional, so the old implementation still compiles. */
interface RefusalView {
  code?: string;
  kind?: string;
  requiredAction?: string;
  itemIndex?: number | null;
  message?: string;
}

/** What a refused write could have moved, straight out of the row. */
interface Stored {
  title: string;
  completion_criterion: string;
  completion_criterion_override_reason: string | null;
  project_id: string | null;
  criterion_definition_id: string | null;
  criterion_revision: number | null;
  updated_at: Date;
}

interface Project {
  id: string;
  /** The conversation that coordinates it: every session-header write below is made from one. */
  coordinator: string;
}

interface Criterion {
  id: string;
  key: string;
}

suite('in an Automatic project a session cannot hand a task to the owner unless its criterion asks',
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    const prisma: PrismaClient = prismaClientFor(URL!);
    t.after(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query(
      'TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE',
    );

    // The service the API wires, over the real client. The two constructor arguments it does not
    // reach here are the session service and the realtime publisher.
    const service = new TasksService(prisma as never, {} as never, {
      publishTaskChanged: () => undefined,
      publishForUser: () => undefined,
    } as never);

    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await sql.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'automatic','x')`,
      [ownerId, `automatic-${ownerId}@owner-confirmed-delegation.invalid`],
    );
    await sql.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,'automatic-runner','ONLINE',$3,now())`,
      [runnerId, ownerId, `automatic-${runnerId}`],
    );
    await sql.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,'automatic-agent',$3,true,true)`,
      [workspaceId, ownerId, runnerId],
    );

    /** A project with the conversation that coordinates it, Automatic on or off. */
    async function project(title: string, coordinatorEnabled: boolean): Promise<Project> {
      const id = randomUUID();
      const coordinator = randomUUID();
      await sql.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,$3,$4,now())`,
        [id, ownerId, title, coordinatorEnabled],
      );
      await sql.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'coordinate',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [coordinator, ownerId, workspaceId, `${title} coordinator`],
      );
      await sql.query(
        'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [id, coordinator],
      );
      return { id, coordinator };
    }

    /** One stated criterion, and the key a caller names it by. */
    async function criterion(
      projectId: string,
      ordinal: number,
      verificationMethod: string,
    ): Promise<Criterion> {
      const id = randomUUID();
      await sql.query(
        `INSERT INTO "project_acceptance_criterion_definition"
           ("id","project_id","ordinal","text","verification_method",
            "content_hash","semantic_hash","updated_at")
         VALUES ($1,$2,$3,$4,$5, repeat('0',64), repeat('0',64), now())`,
        [id, projectId, ordinal, `criterion ${ordinal} of ${projectId}`, verificationMethod],
      );
      return { id, key: criterionKeyOf(id) };
    }

    const automatic = await project('automatic', true);
    const plain = await criterion(automatic.id, 1, 'EXECUTABLE：跑 spec，退出 0 且 0 skip');
    const asksOwner = await criterion(automatic.id, 2,
      'OWNER_CONFIRMED：owner 在自己的 iPhone 上装好这一版，看过后确认');
    const manual = await project('manual', false);
    const manualPlain = await criterion(manual.id, 1, 'EXECUTABLE：跑 spec，退出 0 且 0 skip');

    const agent = { type: CreatorType.AGENT, id: workspaceId };
    /** The service's three write doors, as the runner reaches them with a session header, and as
     *  the owner's app reaches them with none (`sessionId` undefined). */
    const createFrom = (sessionId: string | undefined, dto: Record<string, unknown>) =>
      service.create(ownerId, dto as never, sessionId ? agent : undefined, sessionId);
    const createManyFrom = (sessionId: string | undefined, tasks: Array<Record<string, unknown>>) =>
      service.createMany(ownerId, { tasks } as never, sessionId ? agent : undefined, sessionId);
    const updateFrom = (sessionId: string | undefined, taskId: string, dto: Record<string, unknown>) =>
      service.update(ownerId, taskId, dto as never, sessionId);

    async function refusalOf(call: () => Promise<unknown>): Promise<RefusalView> {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown !== undefined, 'the write was accepted; nothing refused it');
      assert.ok(
        thrown instanceof ConflictException,
        `expected a 409, got ${(thrown as Error)?.constructor?.name}: ${(thrown as Error)?.message}`,
      );
      return (thrown as HttpException).getResponse() as RefusalView;
    }

    /** The refusal, and the remedy it has to carry: every way forward the rule leaves open. */
    function assertNotDelegated(body: RefusalView, itemIndex: number | null, served: Criterion | null) {
      assert.equal(body.code, NOT_DELEGATED_CODE);
      assert.equal(body.kind, 'REFUSAL');
      assert.equal(body.requiredAction, NOT_DELEGATED_ACTION);
      assert.equal(body.itemIndex, itemIndex);
      const message = body.message ?? '';
      for (const next of [
        /Nothing was written/,
        /EVIDENCE_JUDGMENT/,
        /task_evidence_decide/,
        /EXECUTABLE/,
        /ask_owner/,
        /authorisation in advance/,
        /verificationMethod/,
        /starts with OWNER_CONFIRMED/,
        /proposal for the owner to decide/,
      ]) {
        assert.match(message, next);
      }
      if (served) assert.ok(message.includes(served.key), 'it names the criterion the task serves');
      else assert.match(message, /serves none of the project’s acceptance criteria/);
    }

    async function titled(title: string): Promise<number> {
      const { rows } = await sql.query<{ n: string }>(
        'SELECT count(*) AS n FROM "task" WHERE "title" = $1', [title],
      );
      return Number(rows[0].n);
    }

    async function stored(taskId: string): Promise<Stored> {
      const { rows } = await sql.query<Stored>(
        `SELECT "title", "completion_criterion"::text AS completion_criterion,
                "completion_criterion_override_reason", "project_id"::text AS project_id,
                "criterion_definition_id"::text AS criterion_definition_id, "criterion_revision",
                "updated_at"
           FROM "task" WHERE "id" = $1::uuid`,
        [taskId],
      );
      assert.equal(rows.length, 1, 'the task must be there to be read');
      return rows[0];
    }

    /** A task the coordinator filed as EVIDENCE_JUDGMENT — the criterion it is told to use. */
    async function judgedWork(title: string, project: Project, served: Criterion): Promise<string> {
      const created = await createFrom(project.coordinator, {
        title, projectId: project.id, completionCriterion: 'EVIDENCE_JUDGMENT', criterionKey: served.key,
      });
      return created.id;
    }

    // ═══ refused, and nothing written ════════════════════════════════════════════════════════
    await t.test('a single create is refused against a criterion that does not ask, and against none',
      async () => {
        const plainBody = await refusalOf(() => createFrom(automatic.coordinator, {
          title: 'create-serving-plain', projectId: automatic.id,
          completionCriterion: 'OWNER_CONFIRMED', criterionKey: plain.key,
        }));
        assertNotDelegated(plainBody, null, plain);
        assert.equal(await titled('create-serving-plain'), 0, 'no row');

        const noneBody = await refusalOf(() => createFrom(automatic.coordinator, {
          title: 'create-serving-none', projectId: automatic.id, completionCriterion: 'OWNER_CONFIRMED',
        }));
        assertNotDelegated(noneBody, null, null);
        assert.equal(await titled('create-serving-none'), 0, 'no row');

        // Judged in the project the write LANDS in: a coordinator that names no project still
        // files its work under the one it coordinates.
        const boundBody = await refusalOf(() => createFrom(automatic.coordinator, {
          title: 'create-bound-by-scope', completionCriterion: 'OWNER_CONFIRMED', criterionKey: plain.key,
        }));
        assertNotDelegated(boundBody, null, plain);
        assert.equal(await titled('create-bound-by-scope'), 0, 'no row');
      });

    await t.test('a batch carrying one such item is refused whole', async () => {
      const body = await refusalOf(() => createManyFrom(automatic.coordinator, [
        {
          title: 'batch-judged', projectId: automatic.id,
          completionCriterion: 'EVIDENCE_JUDGMENT', criterionKey: plain.key,
        },
        {
          title: 'batch-handed-back', projectId: automatic.id,
          completionCriterion: 'OWNER_CONFIRMED', criterionKey: plain.key,
        },
      ]));
      assertNotDelegated(body, 1, plain);
      assert.equal(await titled('batch-judged'), 0, 'the item that was fine is not written either');
      assert.equal(await titled('batch-handed-back'), 0);
    });

    await t.test('an update that lands on it is refused, and the row is exactly as it was', async () => {
      // By changing the criterion. The criterion-change door is satisfied, so what refuses is this.
      const judged = await judgedWork('update-criterion', automatic, plain);
      const judgedBefore = await stored(judged);
      const criterionBody = await refusalOf(() => updateFrom(automatic.coordinator, judged, {
        completionCriterion: 'OWNER_CONFIRMED',
        completionCriterionOverrideReason: 'the owner should look at this one',
      }));
      assertNotDelegated(criterionBody, null, plain);
      assert.deepEqual(await stored(judged), judgedBefore, 'the refused update changed nothing');

      // By changing the criterion it serves, away from the one that asks for the owner — or by
      // taking the declaration back, which leaves it serving none.
      const asked = await createFrom(automatic.coordinator, {
        title: 'update-served', projectId: automatic.id,
        completionCriterion: 'OWNER_CONFIRMED', criterionKey: asksOwner.key,
      });
      const askedBefore = await stored(asked.id);
      assert.equal(askedBefore.criterion_definition_id, asksOwner.id);
      assertNotDelegated(await refusalOf(() => updateFrom(automatic.coordinator, asked.id, {
        criterionKey: plain.key,
      })), null, plain);
      assertNotDelegated(await refusalOf(() => updateFrom(automatic.coordinator, asked.id, {
        criterionKey: null,
      })), null, null);
      assert.deepEqual(await stored(asked.id), askedBefore, 'the declaration it had is untouched');

      // By filing it into the project: work the owner filed under nothing, moved in by a session.
      const unfiled = await createFrom(undefined, {
        title: 'update-project', completionCriterion: 'OWNER_CONFIRMED',
      });
      const unfiledBefore = await stored(unfiled.id);
      assert.equal(unfiledBefore.project_id, null);
      assertNotDelegated(await refusalOf(() => updateFrom(automatic.coordinator, unfiled.id, {
        projectId: automatic.id,
      })), null, null);
      assert.deepEqual(await stored(unfiled.id), unfiledBefore, 'still filed under nothing');
    });

    // ═══ let through ═════════════════════════════════════════════════════════════════════════
    await t.test('a criterion that asks for the owner lets the declaration through, at every door',
      async () => {
        const single = await createFrom(automatic.coordinator, {
          title: 'asks-single', projectId: automatic.id,
          completionCriterion: 'OWNER_CONFIRMED', criterionKey: asksOwner.key,
        });
        assert.equal((await stored(single.id)).completion_criterion, 'OWNER_CONFIRMED');
        assert.equal((await stored(single.id)).criterion_definition_id, asksOwner.id);

        const batch = await createManyFrom(automatic.coordinator, [
          {
            title: 'asks-batch-judged', projectId: automatic.id,
            completionCriterion: 'EVIDENCE_JUDGMENT', criterionKey: plain.key,
          },
          {
            title: 'asks-batch-owner', projectId: automatic.id,
            completionCriterion: 'OWNER_CONFIRMED', criterionKey: asksOwner.key,
          },
        ]);
        assert.equal(batch.length, 2);
        assert.equal((await stored(batch[1].id)).completion_criterion, 'OWNER_CONFIRMED');

        const judged = await judgedWork('asks-update', automatic, plain);
        await updateFrom(automatic.coordinator, judged, {
          completionCriterion: 'OWNER_CONFIRMED',
          completionCriterionOverrideReason: 'the owner checks this on their own phone',
          criterionKey: asksOwner.key,
        });
        const after = await stored(judged);
        assert.equal(after.completion_criterion, 'OWNER_CONFIRMED');
        assert.equal(after.criterion_definition_id, asksOwner.id);
      });

    await t.test('the owner, writing with no session header, is not asked', async () => {
      const single = await createFrom(undefined, {
        title: 'owner-single', projectId: automatic.id,
        completionCriterion: 'OWNER_CONFIRMED', criterionKey: plain.key,
      });
      assert.equal((await stored(single.id)).completion_criterion, 'OWNER_CONFIRMED');
      const none = await createFrom(undefined, {
        title: 'owner-single-none', projectId: automatic.id, completionCriterion: 'OWNER_CONFIRMED',
      });
      assert.equal((await stored(none.id)).criterion_definition_id, null);

      const batch = await createManyFrom(undefined, [
        {
          title: 'owner-batch', projectId: automatic.id,
          completionCriterion: 'OWNER_CONFIRMED', criterionKey: plain.key,
        },
      ]);
      assert.equal((await stored(batch[0].id)).completion_criterion, 'OWNER_CONFIRMED');

      const judged = await judgedWork('owner-update', automatic, plain);
      await updateFrom(undefined, judged, {
        completionCriterion: 'OWNER_CONFIRMED',
        completionCriterionOverrideReason: 'I will look at this one myself',
      });
      assert.equal((await stored(judged)).completion_criterion, 'OWNER_CONFIRMED');
    });

    await t.test('with Automatic off, a session declares it exactly as before', async () => {
      const single = await createFrom(manual.coordinator, {
        title: 'manual-single', projectId: manual.id,
        completionCriterion: 'OWNER_CONFIRMED', criterionKey: manualPlain.key,
      });
      assert.equal((await stored(single.id)).completion_criterion, 'OWNER_CONFIRMED');
      const none = await createFrom(manual.coordinator, {
        title: 'manual-single-none', projectId: manual.id, completionCriterion: 'OWNER_CONFIRMED',
      });
      assert.equal((await stored(none.id)).completion_criterion, 'OWNER_CONFIRMED');

      const batch = await createManyFrom(manual.coordinator, [
        {
          title: 'manual-batch', projectId: manual.id,
          completionCriterion: 'OWNER_CONFIRMED', criterionKey: manualPlain.key,
        },
      ]);
      assert.equal((await stored(batch[0].id)).completion_criterion, 'OWNER_CONFIRMED');

      const judged = await judgedWork('manual-update', manual, manualPlain);
      await updateFrom(manual.coordinator, judged, {
        completionCriterion: 'OWNER_CONFIRMED',
        completionCriterionOverrideReason: 'the owner confirms this one',
      });
      assert.equal((await stored(judged)).completion_criterion, 'OWNER_CONFIRMED');
    });

    await t.test('a row that already stands is not re-judged by an edit that declares nothing new',
      async () => {
        // As the world before this rule left it: an agent's OWNER_CONFIRMED task in an Automatic
        // project, serving a criterion that does not ask for the owner. Written straight to the
        // table, because no door writes this shape any more.
        const standing = randomUUID();
        await prisma.task.create({
          data: {
            id: standing,
            ownerId,
            projectId: automatic.id,
            title: 'standing',
            creatorType: CreatorType.AGENT,
            creatorId: workspaceId,
            status: TaskStatus.OPEN,
            completionCriterion: 'OWNER_CONFIRMED',
            criterionDefinitionId: plain.id,
            criterionRevision: 1,
            autoRunWhenReady: false,
          },
        });

        await updateFrom(automatic.coordinator, standing, { title: 'standing, renamed' });
        await updateFrom(automatic.coordinator, standing, { criterionKey: plain.key });
        await updateFrom(automatic.coordinator, standing, { completionCriterion: 'OWNER_CONFIRMED' });
        let row = await stored(standing);
        assert.equal(row.title, 'standing, renamed');
        assert.equal(row.completion_criterion, 'OWNER_CONFIRMED', 'nothing rewrote the standing row');
        assert.equal(row.criterion_definition_id, plain.id);

        // And the way out stays open: the coordinator takes the task over as EVIDENCE_JUDGMENT.
        await updateFrom(automatic.coordinator, standing, {
          completionCriterion: 'EVIDENCE_JUDGMENT',
          completionCriterionOverrideReason: 'the coordinator settles this on its evidence',
        });
        row = await stored(standing);
        assert.equal(row.completion_criterion, 'EVIDENCE_JUDGMENT');
      });
  });
