/**
 * Outside an Automatic project, a session that hands a task to the account owner names why only the
 * owner can settle it — or is pointed at EVIDENCE_JUDGMENT (the B line's rule of 2026-10-03,
 * `owner-confirmation-reason.ts`).
 *
 * WHAT IS PINNED HERE
 * -------------------
 * Both sides of the rule, at every write door, read back out of the rows:
 *
 *  - pointed elsewhere, with nothing written: a single create, a batch (whole — the item that was
 *    fine is not written either), and an update that lands on OWNER_CONFIRMED by changing the
 *    criterion or by moving the task — in no project, and in a project whose Automatic is off. The
 *    409 names EVIDENCE_JUDGMENT, the field that would have let it through, and the four reasons;
 *  - let through: each of the four reasons, with and without its sentence, at every door, and
 *    `task_get` reads both back; a write with no session header (the owner); an Automatic project,
 *    which keeps the 09-29 rule (`owner-confirmed-automatic-delegation.pg.spec.ts`) and is not asked
 *    for a reason;
 *  - rows that already stand are not re-judged by an edit that declares nothing new, and the reason
 *    belongs to OWNER_CONFIRMED: refused beside another criterion, its sentence refused without it,
 *    and both cleared by the write that takes the task off OWNER_CONFIRMED.
 *
 * Nothing is stubbed: the service is the one the API wires, over a real client. Refusals are read
 * through a structural view of the body with every field optional, and codes are literals, so this
 * suite compiles — and fails — against an implementation without the rule.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/owner-confirmation-reason.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BadRequestException, ConflictException, type HttpException } from '@nestjs/common';
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

const REASON_REQUIRED = 'OWNER_CONFIRMATION_REASON_REQUIRED';
const REASON_ACTION = 'DECLARE_EVIDENCE_JUDGMENT_THE_DISPATCHING_SESSION_SETTLES';
const NOT_DELEGATED = 'OWNER_CONFIRMATION_NOT_DELEGATED';
const REASONS = ['DEPLOY', 'IRREVERSIBLE', 'OWNER_DEVICE_OR_ACCOUNT', 'OWNER_TRADE_OFF'];

/** A refusal body with every field optional, so an implementation without the rule still compiles. */
interface RefusalView {
  code?: string;
  kind?: string;
  requiredAction?: string;
  itemIndex?: number | null;
  suggestedCriterion?: string;
  reasonField?: string;
  reasons?: string[];
  message?: string;
}

interface Stored {
  title: string;
  completion_criterion: string;
  project_id: string | null;
  owner_confirmation_reason: string | null;
  owner_confirmation_reason_note: string | null;
  updated_at: Date;
}

suite('outside an Automatic project a session names why only the owner can settle what it hands them',
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

    const service = new TasksService(prisma as never, {} as never, {
      publishTaskChanged: () => undefined,
      publishForUser: () => undefined,
    } as never);

    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await sql.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'reasons','x')`,
      [ownerId, `reasons-${ownerId}@owner-confirmation-reason.invalid`],
    );
    await sql.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,'reasons-runner','ONLINE',$3,now())`,
      [runnerId, ownerId, `reasons-${runnerId}`],
    );
    await sql.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,'reasons-agent',$3,true,true)`,
      [workspaceId, ownerId, runnerId],
    );

    /** A conversation of this account that runs no task — the session work is dispatched from. */
    async function conversation(title: string): Promise<string> {
      const id = randomUUID();
      await sql.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'work',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, ownerId, workspaceId, title],
      );
      return id;
    }

    /** A project coordinated from a conversation of its own, Automatic on or off. */
    async function project(title: string, coordinatorEnabled: boolean) {
      const id = randomUUID();
      const coordinator = await conversation(`${title} coordinator`);
      await sql.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","coordinator_session_id",
           "updated_at") VALUES ($1,$2,$3,$4,$5,now())`,
        [id, ownerId, title, coordinatorEnabled, coordinator],
      );
      return { id, coordinator };
    }

    async function criterion(projectId: string, ordinal: number, verificationMethod: string) {
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

    const dispatcher = await conversation('a conversation that files work');
    const manual = await project('manual', false);
    const automatic = await project('automatic', true);
    const automaticPlain = await criterion(automatic.id, 1, 'EXECUTABLE：跑 spec，退出 0');
    const automaticAsks = await criterion(automatic.id, 2, 'OWNER_CONFIRMED：owner 在自己的手机上装好看过');

    const agent = { type: CreatorType.AGENT, id: workspaceId };
    const createFrom = (sessionId: string | undefined, dto: Record<string, unknown>) =>
      service.create(ownerId, dto as never, sessionId ? agent : undefined, sessionId);
    const createManyFrom = (sessionId: string | undefined, tasks: Array<Record<string, unknown>>) =>
      service.createMany(ownerId, { tasks } as never, sessionId ? agent : undefined, sessionId);
    const updateFrom = (sessionId: string | undefined, taskId: string, dto: Record<string, unknown>) =>
      service.update(ownerId, taskId, dto as never, sessionId);

    async function refusalOf(
      call: () => Promise<unknown>,
      kind: typeof ConflictException | typeof BadRequestException = ConflictException,
    ): Promise<RefusalView & { text: string }> {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown !== undefined, 'the write was accepted; nothing refused it');
      assert.ok(thrown instanceof kind,
        `expected ${kind.name}, got ${(thrown as Error)?.constructor?.name}: ${(thrown as Error)?.message}`);
      const body = (thrown as HttpException).getResponse();
      return typeof body === 'string'
        ? { text: body }
        : { ...(body as RefusalView), text: JSON.stringify(body) };
    }

    /** The 409 this rule answers with, and everything a caller needs to act on it. */
    function assertPointedAtJudgment(body: RefusalView, itemIndex: number | null, inProject: boolean) {
      assert.equal(body.code, REASON_REQUIRED);
      assert.equal(body.kind, 'REFUSAL');
      assert.equal(body.requiredAction, REASON_ACTION);
      assert.equal(body.itemIndex, itemIndex);
      assert.equal(body.suggestedCriterion, 'EVIDENCE_JUDGMENT');
      assert.equal(body.reasonField, 'ownerConfirmationReason');
      assert.deepEqual(body.reasons, REASONS);
      const message = body.message ?? '';
      for (const words of [
        /Nothing was written|nothing was written/,
        /declare EVIDENCE_JUDGMENT/,
        /task_evidence_decide/,
        /ownerConfirmationReason/,
        /ownerConfirmationReasonNote/,
        ...REASONS.map((reason) => new RegExp(reason)),
      ]) {
        assert.match(message, words);
      }
      if (inProject) {
        assert.match(message, /Automatic is off/);
      } else {
        assert.match(message, /delivered to the session that dispatched the work/);
        assert.match(message, /30 minutes/);
        assert.match(message, /acceptanceCriteria/);
      }
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
                "project_id"::text AS project_id,
                "owner_confirmation_reason"::text AS owner_confirmation_reason,
                "owner_confirmation_reason_note", "updated_at"
           FROM "task" WHERE "id" = $1::uuid`,
        [taskId],
      );
      assert.equal(rows.length, 1, 'the task must be there to be read');
      return rows[0];
    }

    // ═══ pointed at EVIDENCE_JUDGMENT, and nothing written ═════════════════════════════════════
    await t.test('in no project, a session that names no reason is pointed at EVIDENCE_JUDGMENT at every door',
      async () => {
        const single = await refusalOf(() => createFrom(dispatcher, {
          title: 'unfiled-no-reason', completionCriterion: 'OWNER_CONFIRMED',
        }));
        assertPointedAtJudgment(single, null, false);
        assert.equal(await titled('unfiled-no-reason'), 0, 'no row');

        // A note alone is not a reason.
        const noteOnly = await refusalOf(() => createFrom(dispatcher, {
          title: 'unfiled-note-only', completionCriterion: 'OWNER_CONFIRMED',
          ownerConfirmationReasonNote: 'the owner should look',
        }), BadRequestException);
        assert.match(noteOnly.text, /ownerConfirmationReasonNote/);
        assert.equal(await titled('unfiled-note-only'), 0);

        const batch = await refusalOf(() => createManyFrom(dispatcher, [
          {
            title: 'batch-judged', completionCriterion: 'EVIDENCE_JUDGMENT',
            acceptanceCriteria: 'the suite passes',
          },
          { title: 'batch-handed-to-owner', completionCriterion: 'OWNER_CONFIRMED' },
        ]));
        assertPointedAtJudgment(batch, 1, false);
        assert.equal(await titled('batch-judged'), 0, 'the item that was fine is not written either');
        assert.equal(await titled('batch-handed-to-owner'), 0);

        // An update that lands on it by changing the criterion. The criterion-change door is
        // satisfied, so what refuses is this rule; the row is exactly as it was.
        const judged = await createFrom(dispatcher, {
          title: 'update-to-owner', completionCriterion: 'EVIDENCE_JUDGMENT',
          acceptanceCriteria: 'the suite passes',
        });
        const before = await stored(judged.id);
        assertPointedAtJudgment(await refusalOf(() => updateFrom(dispatcher, judged.id, {
          completionCriterion: 'OWNER_CONFIRMED',
          completionCriterionOverrideReason: 'the owner should look at this one',
        })), null, false);
        assert.deepEqual(await stored(judged.id), before, 'the refused update changed nothing');
      });

    await t.test('in a project whose Automatic is off, the same — and moving a task there is judged too',
      async () => {
        const single = await refusalOf(() => createFrom(manual.coordinator, {
          title: 'manual-no-reason', projectId: manual.id, completionCriterion: 'OWNER_CONFIRMED',
        }));
        assertPointedAtJudgment(single, null, true);
        assert.equal(await titled('manual-no-reason'), 0);

        // Work the owner filed under nothing, OWNER_CONFIRMED with no reason, moved in by a session:
        // the write moves the project, so the task as it would be left is judged.
        const owners = await createFrom(undefined, { title: 'owners-unfiled', completionCriterion: 'OWNER_CONFIRMED' });
        const before = await stored(owners.id);
        assertPointedAtJudgment(await refusalOf(() => updateFrom(manual.coordinator, owners.id, {
          projectId: manual.id,
        })), null, true);
        assert.deepEqual(await stored(owners.id), before, 'still filed under nothing');
      });

    // ═══ let through ═══════════════════════════════════════════════════════════════════════════
    await t.test('each of the four reasons lets it through at every door, and task_get reads it back',
      async () => {
        for (const [index, reason] of REASONS.entries()) {
          const created = await createFrom(dispatcher, {
            title: `reason-${reason}`, completionCriterion: 'OWNER_CONFIRMED',
            ownerConfirmationReason: reason,
            ...(index % 2 === 0 ? { ownerConfirmationReasonNote: `  why ${reason}  ` } : {}),
          });
          const row = await stored(created.id);
          assert.equal(row.completion_criterion, 'OWNER_CONFIRMED');
          assert.equal(row.owner_confirmation_reason, reason);
          assert.equal(row.owner_confirmation_reason_note, index % 2 === 0 ? `why ${reason}` : null,
            'the sentence is stored trimmed, and only when one was given');
          const read = await service.get(ownerId, created.id) as unknown as Record<string, unknown>;
          assert.equal(read.ownerConfirmationReason, reason, 'task_get reads the reason back');
          assert.equal(read.ownerConfirmationReasonNote, index % 2 === 0 ? `why ${reason}` : null);
        }

        const inManual = await createFrom(manual.coordinator, {
          title: 'manual-deploy', projectId: manual.id, completionCriterion: 'OWNER_CONFIRMED',
          ownerConfirmationReason: 'DEPLOY', ownerConfirmationReasonNote: 'ships 1.4 to the App Store',
        });
        assert.equal((await stored(inManual.id)).owner_confirmation_reason, 'DEPLOY');

        const batch = await createManyFrom(dispatcher, [
          { title: 'batch-ok-judged', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'it passes' },
          {
            title: 'batch-ok-owner', completionCriterion: 'OWNER_CONFIRMED',
            ownerConfirmationReason: 'IRREVERSIBLE', ownerConfirmationReasonNote: 'drops the old table',
          },
        ]);
        assert.equal(batch.length, 2);
        const batchRow = await stored(batch[1].id);
        assert.equal(batchRow.owner_confirmation_reason, 'IRREVERSIBLE');
        assert.equal(batchRow.owner_confirmation_reason_note, 'drops the old table');

        const judged = await createFrom(dispatcher, {
          title: 'update-ok', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'it passes',
        });
        await updateFrom(dispatcher, judged.id, {
          completionCriterion: 'OWNER_CONFIRMED',
          completionCriterionOverrideReason: 'it is signed in with the owner’s own Apple ID',
          ownerConfirmationReason: 'OWNER_DEVICE_OR_ACCOUNT',
        });
        const after = await stored(judged.id);
        assert.equal(after.completion_criterion, 'OWNER_CONFIRMED');
        assert.equal(after.owner_confirmation_reason, 'OWNER_DEVICE_OR_ACCOUNT');
      });

    await t.test('the owner, writing with no session header, is not asked', async () => {
      const single = await createFrom(undefined, { title: 'owner-single', completionCriterion: 'OWNER_CONFIRMED' });
      assert.equal((await stored(single.id)).owner_confirmation_reason, null);
      const inManual = await createFrom(undefined, {
        title: 'owner-manual', projectId: manual.id, completionCriterion: 'OWNER_CONFIRMED',
      });
      assert.equal((await stored(inManual.id)).completion_criterion, 'OWNER_CONFIRMED');
      const batch = await createManyFrom(undefined, [{ title: 'owner-batch', completionCriterion: 'OWNER_CONFIRMED' }]);
      assert.equal((await stored(batch[0].id)).completion_criterion, 'OWNER_CONFIRMED');
      const judged = await createFrom(dispatcher, {
        title: 'owner-update', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'it passes',
      });
      await updateFrom(undefined, judged.id, {
        completionCriterion: 'OWNER_CONFIRMED',
        completionCriterionOverrideReason: 'I will look at this one myself',
      });
      assert.equal((await stored(judged.id)).completion_criterion, 'OWNER_CONFIRMED');
    });

    await t.test('an Automatic project keeps the 09-29 rule and is not asked for a reason', async () => {
      // The criterion asks for the owner: through, with no reason named.
      const asked = await createFrom(automatic.coordinator, {
        title: 'automatic-asked', projectId: automatic.id,
        completionCriterion: 'OWNER_CONFIRMED', criterionKey: automaticAsks.key,
      });
      assert.equal((await stored(asked.id)).completion_criterion, 'OWNER_CONFIRMED');
      // It does not: the 09-29 refusal, which a reason does not buy a way past.
      const plain = await refusalOf(() => createFrom(automatic.coordinator, {
        title: 'automatic-plain', projectId: automatic.id, completionCriterion: 'OWNER_CONFIRMED',
        criterionKey: automaticPlain.key, ownerConfirmationReason: 'DEPLOY',
      }));
      assert.equal(plain.code, NOT_DELEGATED);
      assert.equal(await titled('automatic-plain'), 0);
    });

    // ═══ standing rows, and what the reason belongs to ═════════════════════════════════════════
    await t.test('a row that already stands is not re-judged by an edit that declares nothing new', async () => {
      // As an agent left one before this rule: OWNER_CONFIRMED, no project, no reason. Written
      // straight to the table, because no door writes this shape for a session any more.
      const standing = randomUUID();
      await prisma.task.create({
        data: {
          id: standing,
          ownerId,
          title: 'standing',
          creatorType: CreatorType.AGENT,
          creatorId: workspaceId,
          creatorSessionId: dispatcher,
          status: TaskStatus.OPEN,
          completionCriterion: 'OWNER_CONFIRMED',
          autoRunWhenReady: false,
        },
      });
      await updateFrom(dispatcher, standing, { title: 'standing, renamed' });
      await updateFrom(dispatcher, standing, { completionCriterion: 'OWNER_CONFIRMED' });
      await updateFrom(dispatcher, standing, { labels: ['kept'] });
      let row = await stored(standing);
      assert.equal(row.title, 'standing, renamed');
      assert.equal(row.completion_criterion, 'OWNER_CONFIRMED', 'nothing rewrote the standing row');
      // A reason can be added to it afterwards, with nothing else moving.
      await updateFrom(dispatcher, standing, { ownerConfirmationReason: 'OWNER_TRADE_OFF' });
      row = await stored(standing);
      assert.equal(row.owner_confirmation_reason, 'OWNER_TRADE_OFF');
      // And the way out stays open: the dispatching session settles it on evidence instead.
      await updateFrom(dispatcher, standing, {
        completionCriterion: 'EVIDENCE_JUDGMENT',
        completionCriterionOverrideReason: 'a test settles this; the dispatching session decides',
      });
      row = await stored(standing);
      assert.equal(row.completion_criterion, 'EVIDENCE_JUDGMENT');
      assert.equal(row.owner_confirmation_reason, null, 'leaving OWNER_CONFIRMED takes the reason with it');
      assert.equal(row.owner_confirmation_reason_note, null);
    });

    await t.test('the reason belongs to OWNER_CONFIRMED, and its sentence to the reason', async () => {
      const beside = await refusalOf(() => createFrom(dispatcher, {
        title: 'reason-beside-judgment', completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: 'it passes', ownerConfirmationReason: 'DEPLOY',
      }), BadRequestException);
      assert.match(beside.text, /ownerConfirmationReason explains an OWNER_CONFIRMED declaration/);
      assert.equal(await titled('reason-beside-judgment'), 0);

      const batchBeside = await refusalOf(() => createManyFrom(dispatcher, [
        { title: 'batch-beside', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'it passes',
          ownerConfirmationReason: 'DEPLOY' },
      ]), BadRequestException);
      assert.match(batchBeside.text, /tasks\[0\]/);

      const withReason = await createFrom(dispatcher, {
        title: 'reason-cleared', completionCriterion: 'OWNER_CONFIRMED',
        ownerConfirmationReason: 'DEPLOY', ownerConfirmationReasonNote: 'cuts the release',
      });
      // Null takes both back; the row is OWNER_CONFIRMED with no reason, and stays as it is.
      await updateFrom(undefined, withReason.id, { ownerConfirmationReason: null });
      let row = await stored(withReason.id);
      assert.equal(row.owner_confirmation_reason, null);
      assert.equal(row.owner_confirmation_reason_note, null);
      // A sentence with no reason to go with is refused, on the update door too.
      const lonely = await refusalOf(() => updateFrom(undefined, withReason.id, {
        ownerConfirmationReasonNote: 'a sentence with nothing to explain',
      }), BadRequestException);
      assert.match(lonely.text, /ownerConfirmationReasonNote/);
      // And a reason sent with a move off OWNER_CONFIRMED is refused rather than dropped.
      await updateFrom(undefined, withReason.id, { ownerConfirmationReason: 'IRREVERSIBLE' });
      const offWith = await refusalOf(() => updateFrom(undefined, withReason.id, {
        completionCriterion: 'EVIDENCE_JUDGMENT',
        completionCriterionOverrideReason: 'judged on evidence after all',
        ownerConfirmationReason: 'IRREVERSIBLE',
      }), BadRequestException);
      assert.match(offWith.text, /explains an OWNER_CONFIRMED declaration/);
      row = await stored(withReason.id);
      assert.equal(row.completion_criterion, 'OWNER_CONFIRMED', 'the refused move wrote nothing');
      assert.equal(row.owner_confirmation_reason, 'IRREVERSIBLE');
    });
  });
