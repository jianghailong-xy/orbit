/**
 * The dead angle a settled project used to leave behind, on real PostgreSQL.
 *
 * A coordinator session's create names no project — the server files it under the project that
 * session coordinates (unit L3's binding). The moment that project is accepted, the same binding
 * aimed every one of that session's creates at a project that takes no new work, so §4 R8 refused
 * ALL of them, including work with nothing to do with the goal that had just been settled. The
 * refusal's own advice could not be followed from there either: reopening a correctly settled
 * project to record an unrelated finding corrupts the record it settled, and filing into another
 * project is refused for this session too. So the session most likely to have noticed something —
 * the one that has just finished — was the one that could write nothing down.
 *
 * What is fixed is the DERIVATION, not the rules: a create that names no project is filed under
 * the scope the server derived while that project can still take new work, and under no project
 * once it cannot. The rules are frozen and are right, so this file spends most of its length
 * proving they still refuse everything they refused before.
 *
 * Why this is a `.pg.spec` and not a unit test. Two of the claims are claims about ROWS that a
 * stubbed Prisma cannot make: that the created task's `project_id` is really NULL rather than
 * merely absent from an argument, and that the settled project came out of it with the status it
 * went in with and not one task heavier — which is the invariant the whole remedy is judged
 * against, since a fix that quietly reopened the project would satisfy every other assertion here.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='task-project-scope-settled\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SCOPE_RULES } from '../projects/project-scope-contract';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * §4's ordered table, copied out of `project-scope-contract.ts` as it stood BEFORE this remedy —
 * every id with the refusal it lands on and what it asks for next.
 *
 * Written out as a literal rather than derived, because a comparison against the table's own value
 * would agree with itself no matter what the table said. What it locks is the shape of the fix: a
 * dead angle answered by a NEW refusal code, or by re-aiming an existing rule's required action,
 * would be a contract change dressed as a bug fix — two names for one event, which §12 E2 forbids
 * — and every reader of these codes (the clients, the blocker kinds, the decision spec's own
 * reachability census) would have to be told. Nothing below moved; the derivation above the rules
 * did. `project-scope-decision.spec.ts` still owns what each of these rules DOES.
 */
const FROZEN_SCOPE_RULES: ReadonlyArray<{
  id: string; code: string | null; requiredAction: string | null;
}> = [
  { id: 'R1_USER_AUTHORITY', code: null, requiredAction: null },
  { id: 'R2_TOKEN_INCONSISTENT', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'RE_DERIVE_SCOPE' },
  { id: 'R3_SCOPE_MOVED', code: 'COORDINATOR_GENERATION_MOVED', requiredAction: 'YIELD_TO_CURRENT_SCOPE' },
  { id: 'R4_NO_TARGET_PROJECT', code: 'UNMAPPED_PROJECT_WORK', requiredAction: 'NAME_OWNING_PROJECT' },
  { id: 'R5_NO_SCOPE', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'YIELD_TO_CURRENT_SCOPE' },
  { id: 'R6_OUT_OF_SCOPE', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R7_UNDECLARED_CROSSING', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R8_SETTLED_PROJECT', code: 'PROJECT_REOPEN_REQUIRED', requiredAction: 'REOPEN_PROJECT_FIRST' },
  { id: 'R9_APPROVAL_TARGET_MISMATCH', code: 'APPROVAL_TARGET_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R10_NO_APPROVAL', code: 'CROSS_PROJECT_APPROVAL_REQUIRED', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R11_APPROVAL_PENDING', code: 'APPROVAL_PENDING', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R12_APPROVAL_DENIED', code: 'APPROVAL_DENIED', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R13_APPROVAL_EXPIRED', code: 'APPROVAL_EXPIRED', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R14_HANDOFF_APPROVED', code: null, requiredAction: null },
  { id: 'R15_IN_SCOPE', code: null, requiredAction: null },
];

test('the frozen rule table is exactly what it was: no new refusal code says this', () => {
  assert.deepEqual(
    SCOPE_RULES.map((rule) => ({
      id: rule.id, code: rule.code ?? null, requiredAction: rule.requiredAction ?? null,
    })),
    FROZEN_SCOPE_RULES,
  );
});

/** Where a task belongs, and where it was noticed — two columns, read straight out of the row. */
interface Filing {
  project_id: string | null;
  discovered_from_project_id: string | null;
  trigger_event: string | null;
}

test('a session whose project has settled can still write down what it noticed', {
  skip, concurrency: 1, timeout: 180_000,
}, async (t) => {
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
  await sql.query(
    'TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE',
  );

  // Nothing is stubbed: the service the API wires, over the real client, as the sibling scope specs
  // build it. The two constructor arguments unused here are the session service and the realtime
  // publisher.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'settled','x')`,
    [ownerId, `settled-${ownerId}@task-project-scope-settled.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

  async function filingOf(taskId: string): Promise<Filing> {
    const { rows } = await sql.query<Filing>(
      `SELECT "project_id"::text AS project_id,
              "discovered_from_project_id"::text AS discovered_from_project_id,
              "trigger_event"
         FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must exist to have a filing');
    return rows[0];
  }

  /** The scope contract's refusal body, with a real assertion that it WAS refused. */
  async function scopeRefusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof ForbiddenException, `expected a scope refusal, got ${error}`);
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the write was not refused' });
  }

  const goal = await project('the goal this session coordinates');
  const elsewhere = await project('a goal this session does not coordinate');
  const beyond = await project('a third goal, so a move has somewhere to go');

  // The session the incident happens through. Its scope is SERVER-derived from this pointer on
  // every write, which is why one session can be used before and after the project settles: it is
  // not carrying a cached answer that a test would have to refresh.
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await sql.query(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
     VALUES ($1,$2,'settled-runner','ONLINE',$3,now())`,
    [runnerId, ownerId, `settled-${runnerId}`],
  );
  await sql.query(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
     VALUES ($1,$2,'settled-agent',$3,true,true)`,
    [workspaceId, ownerId, runnerId],
  );
  await sql.query(
    `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
       "provider","status","dispatch_origin","updated_at")
     VALUES ($1,$2,$3,'settled-coordinator','fixture',$2,'claude','RUNNING'::"run_status",
       'USER'::"session_dispatch_origin",now())`,
    [coordinatorSessionId, ownerId, workspaceId],
  );
  await sql.query(
    `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
       ON CONFLICT ("project_id") DO NOTHING`,
    [goal],
  );
  await sql.query(
    'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
    [goal, coordinatorSessionId],
  );

  /** A create from the coordinator session, exactly as the runner makes it. */
  async function coordinatorFiles(
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; projectId: string | null }> {
    return service.create(
      ownerId,
      { title, completionCriterion: 'EVIDENCE_JUDGMENT', ...extra } as never,
      { type: CreatorType.AGENT, id: workspaceId },
      coordinatorSessionId,
    ) as Promise<{ id: string; projectId: string | null }>;
  }

  /** The two facts about the settled project that no remedy for this may move. */
  async function goalState(): Promise<{ status: string; tasks: number }> {
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: goal },
      select: { status: true, _count: { select: { tasks: true } } },
    });
    return { status: String(row.status), tasks: row._count.tasks };
  }

  // ═══ 1. while the goal is open, nothing about the filing changes ═══════════════════════════
  // First, and against the same session that runs every case below: the remedy is allowed to
  // change what happens once a project settles and nothing else. A fix that switched the implicit
  // filing off altogether would pass every refusal case in this file and fail here.
  await t.test('an unnamed create is still filed under the project the session coordinates',
    async () => {
      const task = await coordinatorFiles('work this goal counts');

      assert.equal(task.projectId, goal);
      assert.deepEqual(await filingOf(task.id), {
        project_id: goal,
        discovered_from_project_id: goal,
        trigger_event: 'coordinator.session_filed',
      }, 'the server-derived filing, unchanged');
    });

  await sql.query(`UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [goal]);
  const settled = await goalState();
  assert.deepEqual(settled, { status: 'DONE', tasks: 1 },
    'the rest of this test is about a project that is settled and owns the work above');

  // ═══ 2. the dead angle ════════════════════════════════════════════════════════════════════
  await t.test('the coordinator of a settled project still records work that belongs to no project',
    async () => {
      // EXECUTABLE, because the work being recorded here lands under NO project and
      // EVIDENCE_JUDGMENT is declared against a project's stated criterion. That is the same fact
      // this case is about, seen from the write door: work a settled project cannot take is still
      // recorded, and it says how it is checked instead of naming a standard nobody states.
      const task = await coordinatorFiles('a web-only finding, noticed after the goal was accepted', {
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'npm run test:outcome-reconciler:fast-gate',
        acceptanceExpectedExitCode: 0,
      });

      assert.equal(task.projectId, null,
        'work the settled project cannot take is filed under no project, not refused');
      const filing = await filingOf(task.id);
      assert.equal(filing.project_id, null, 'and the row says so, not just the answer');
      // Belonging is gone; the evidence of where it was noticed is not. The two are different
      // columns precisely so that unattributable work still says where it came from.
      assert.equal(filing.discovered_from_project_id, goal);
      assert.equal(filing.trigger_event, 'coordinator.session_filed');

      // The invariant the remedy is judged against: nothing about the accepted project moved. Not
      // its status — a reopen here would start a new acceptance epoch behind the owner's back —
      // and not its work, which is what a silent re-filing would look like from the outside.
      assert.deepEqual(await goalState(), settled);
    });

  // ═══ 3. R8 is not weakened ════════════════════════════════════════════════════════════════
  // The write R8 exists for, spelled the only way a CREATE can reach it: naming the settled
  // project itself. (A create that names a DIFFERENT settled project is a crossing, and §4 answers
  // crossings first — R7 — which is the rule order doing its job, not R8 going missing.)
  await t.test('new work aimed at the settled project is still refused, and the project stands',
    async () => {
      const body = await scopeRefusalOf(
        () => coordinatorFiles('new work for a goal that is finished', { projectId: goal }),
      );

      assert.equal(body.rule, 'R8_SETTLED_PROJECT');
      assert.equal(body.code, 'PROJECT_REOPEN_REQUIRED');
      assert.equal(body.requiredAction, 'REOPEN_PROJECT_FIRST');
      assert.equal(body.responsible, 'USER');
      assert.deepEqual(body.target, { projectId: goal });
      assert.deepEqual(await goalState(), settled);
    });

  // ═══ 4. R6 is not weakened ════════════════════════════════════════════════════════════════
  // "The scope has settled" must not become "the scope stopped applying". Both shapes of writing
  // into somebody else's project are checked, because a create and an update reach the answer by
  // different rules: for new work the two ends are the scope and the target, so naming another
  // project is a CROSSING (R7); an edit's ends are both the task's own project, which is the one
  // input that reaches R6 itself. Same code, same required action, and the fix touches neither.
  await t.test('writing into a project this session does not hold is still refused, both ways',
    async () => {
      const filing = await scopeRefusalOf(
        () => coordinatorFiles('work for a goal this session does not hold', { projectId: elsewhere }),
      );

      assert.equal(filing.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(filing.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
      assert.equal(filing.rule, 'R7_UNDECLARED_CROSSING');
      assert.deepEqual(filing.target, { projectId: elsewhere });

      // The owner files the task this session then tries to edit; nothing a coordinator does here
      // could have created it, which is the point.
      const theirs = await service.create(ownerId, {
        title: 'work that belongs to another goal', completionCriterion: 'EVIDENCE_JUDGMENT',
        projectId: elsewhere,
      } as never) as { id: string };

      const editing = await scopeRefusalOf(
        () => service.update(ownerId, theirs.id, { title: 'renamed' } as never, coordinatorSessionId),
      );

      assert.equal(editing.rule, 'R6_OUT_OF_SCOPE');
      assert.equal(editing.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(editing.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
      assert.equal((await filingOf(theirs.id)).project_id, elsewhere, 'a refused edit writes nothing');
    });

  // ═══ 5. the update path still reads the task, not the scope ═══════════════════════════════
  // The other candidate remedy was to stop the decision's `from` falling back to the scope. This
  // is what that fallback is FOR, and it has to keep working: an update's `from` is the project
  // losing the work, which is the task's own — here a third project, so a `from` taken from the
  // scope would name the settled goal and be visible in the refusal.
  await t.test('a move still leaves the project that owns the task, not the one the session holds',
    async () => {
      const theirs = await service.create(ownerId, {
        title: 'work that is being moved between two goals this session does not hold',
        completionCriterion: 'EVIDENCE_JUDGMENT', projectId: elsewhere,
      } as never) as { id: string };

      const body = await scopeRefusalOf(
        () => service.update(ownerId, theirs.id, { projectId: beyond } as never, coordinatorSessionId),
      );

      assert.deepEqual(body.scope, { projectId: elsewhere },
        'the end the work leaves is the task\'s project, not the scope the write was made under');
      assert.deepEqual(body.target, { projectId: beyond });
      assert.equal(body.rule, 'R7_UNDECLARED_CROSSING');
      assert.equal((await filingOf(theirs.id)).project_id, elsewhere, 'and it did not move');
    });
});
