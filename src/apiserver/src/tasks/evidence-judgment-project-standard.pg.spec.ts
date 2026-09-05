/**
 * EVIDENCE_JUDGMENT is declared against a PROJECT's stated standard, and the write doors say so.
 *
 * WHAT WENT WRONG
 * ---------------
 * EVIDENCE_JUDGMENT is the criterion a task falls back to when nothing else is declared, so an
 * agent filing standalone work lands on it by default. On 2026-09-05 one such row — `projectId`
 * null, one evidence revision submitted, six resolved TOOL_CALL citations — could not be settled at
 * all: check 2 of the decision door refused CONFIRM and SEND_BACK alike, the rail rendered the row
 * with both buttons disabled, and 0193's fence refuses a hand-written DONE. A person had to
 * re-declare the task EXECUTABLE to close it.
 *
 * `ef916d6d` fixed the half of that which was a lie: a task in no project DOES state a standard —
 * its own `acceptanceCriteria` — and the decision door now holds such evidence against that column
 * instead of reporting "the criterion moved" about a criterion that never existed. What that
 * commit could not do is make the combination a good one to CREATE. It works only while the task
 * also carries acceptance criteria the evidence quotes verbatim, which nothing at declaration time
 * requires it to have written, and a task that lacks them is a submission whose only answer is a
 * refusal telling the submitter to go and write some.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * The three write doors — `create`, `createMany`/`previewPlan`, `update` — refuse to DECLARE
 * EVIDENCE_JUDGMENT on work that is in no project, with one code and one required action, and the
 * refusal names both ways out. And, in the same breath, three things that must keep working:
 *
 *  - the identical declaration, once the work is filed under a project;
 *  - a project-less task declaring EXECUTABLE, which was never the problem;
 *  - the rows already in this state. A gate that made them uneditable would strand them harder
 *    than the deadlock did — the two ways out ARE edits, so both are driven here on a row that
 *    already carries a submitted evidence revision.
 *
 * Nothing is stubbed: the service is the one the API wires, over a real client, and every claim is
 * read back out of the row. A refusal is asserted through a STRUCTURAL view of the response body
 * with every field optional, and the code and required action are written here as literals rather
 * than imported. That is deliberate — importing the constants this change adds would turn the
 * negative control into a compile error, which stops the suite and proves nothing about the doors.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='evidence-judgment-project-standard\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  type PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { criterionStandingRefusal } from './task-evidence-decision';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const CRITERION_TEXT =
  'the three write doors refuse to declare EVIDENCE_JUDGMENT on work that is in no project';
const STRANDED_CRITERIA = 'the stranded row states what would settle it, in its own words';

/**
 * A refusal body as a reader of it sees it, with every field optional.
 *
 * Read through the DTO/exception types this change introduces, an unimplemented door would fail to
 * COMPILE rather than fail to refuse — and a suite that does not build is not a negative control.
 */
interface RefusalView {
  code?: string;
  kind?: string;
  requiredAction?: string;
  message?: string;
  itemIndex?: number | null;
}

/** The stored declaration, straight out of the row rather than through a service return value. */
interface StoredDeclaration {
  project_id: string | null;
  completion_criterion: string;
  acceptance_command: string | null;
}

suite('EVIDENCE_JUDGMENT cannot be declared on work that is in no project', async (t) => {
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
  // reach here are the session service and the realtime publisher, exactly as
  // `task-criterion-declaration.pg.spec` builds it.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const evidence = new TaskCompletionEvidenceService(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const goalId = randomUUID();
  const criterionId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `standard-${ownerId}@invalid.test`, name: 'Standard', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: { id: runnerId, ownerId, name: 'standard-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'standard-workspace', enabled: true },
  });
  await prisma.project.create({
    data: { id: goalId, ownerId, title: 'the goal this work can be filed under' },
  });
  await prisma.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId: goalId,
      ordinal: 1,
      text: CRITERION_TEXT,
      verificationMethod: 'this pg spec drives the doors and reads the rows back',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });

  /** The refused call's body, with a real assertion that it WAS refused. */
  async function refusalOf(run: () => Promise<unknown>): Promise<RefusalView> {
    let outcome: unknown;
    try {
      outcome = await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a refusal, got ${error}`);
      const body = error.getResponse();
      assert.ok(body && typeof body === 'object', `expected a structured refusal, got ${body}`);
      return body as RefusalView;
    }
    throw new assert.AssertionError({
      message: `expected a refusal; the write was accepted and produced ${describe(outcome)}`,
    });
  }

  function describe(outcome: unknown): string {
    const rows = Array.isArray(outcome) ? outcome : [outcome];
    return rows
      .map((row) => (row && typeof row === 'object' && 'id' in row ? String(row.id) : String(row)))
      .join(', ');
  }

  async function declarationOf(taskId: string): Promise<StoredDeclaration> {
    const { rows } = await sql.query<StoredDeclaration>(
      'SELECT "project_id", "completion_criterion"::text AS "completion_criterion", '
      + '"acceptance_command" FROM "task" WHERE "id" = $1',
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must exist to have a declaration read off it');
    return rows[0];
  }

  async function taskCount(title: string): Promise<number> {
    const { rows } = await sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM "task" WHERE "owner_id" = $1 AND "title" = $2', [ownerId, title],
    );
    return Number(rows[0].n);
  }

  /** Both ways out, as the refusal has to name them for a reader who is stuck. */
  function assertNamesTheWaysOut(body: RefusalView): void {
    assert.equal(body.code, 'EVIDENCE_JUDGMENT_REQUIRES_PROJECT');
    assert.equal(body.requiredAction, 'FILE_UNDER_A_PROJECT_OR_DECLARE_ANOTHER_CRITERION');
    const message = body.message ?? '';
    assert.match(message, /projectId/,
      'the refusal must name filing the work under a project as a way out');
    assert.match(message, /EXECUTABLE/,
      'the refusal must name declaring a criterion this task can settle on its own');
  }

  /**
   * A row already in the state this change stops anybody from declaring: no project,
   * EVIDENCE_JUDGMENT, and one submitted evidence revision. Written straight to the database,
   * because that is how the ones on the deployed server got there and because a door that refused
   * to create it is the thing being tested.
   */
  async function stranded(title: string): Promise<string> {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await prisma.task.create({
      data: {
        id: taskId,
        ownerId,
        projectId: null,
        title,
        creatorType: CreatorType.AGENT,
        creatorId: workspaceId,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: STRANDED_CRITERIA,
      },
    });
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'the run that did the stranded work',
        prompt: 'do the work and submit the evidence',
        provider: 'claude',
        // Terminal, so the row is stranded rather than merely busy: a task with a LIVE run cannot
        // be moved between projects at all, and a control asserting the way out is still open must
        // not be measuring that unrelated wall.
        status: RunStatus.SUCCEEDED,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    await prisma.toolCall.create({
      data: {
        sessionId,
        name: 'Bash',
        toolUseId: `toolu_${uuidToBase62(taskId)}`,
        input: { command: 'npm run test:outcome-reconciler:fast-gate', description: 'the work' },
        isError: false,
      },
    });
    const submitted = await evidence.submit(
      ownerId, taskId, { type: CreatorType.AGENT, id: workspaceId },
      {
        sourceSessionId: sessionId,
        evidence: {
          claim: 'the stranded work is done',
          criterion: { key: uuidToBase62(taskId), text: STRANDED_CRITERIA },
          checks: [{ kind: 'TOOL_CALL', ref: `toolu_${uuidToBase62(taskId)}` }],
          gaps: [],
        },
      },
    );
    assert.equal(submitted.revision, '1', 'the row must really carry evidence to be stranded');
    return taskId;
  }

  // ═══ 1. the create door ═══════════════════════════════════════════════════════════════════
  await t.test('creating a project-less task with EVIDENCE_JUDGMENT is refused, with a way out',
    async () => {
      const title = 'standalone work an agent filed under nothing';

      const body = await refusalOf(() => service.create(ownerId, {
        title, completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never));

      assertNamesTheWaysOut(body);
      assert.equal(await taskCount(title), 0, 'a refused create writes no row at all');
    });

  // ═══ 2. the batch door, and the preview that promises what it would do ════════════════════
  await t.test('a batch is refused item by item at the same rule', async () => {
    const filed = 'batch work filed under the goal';
    const loose = 'batch work filed under nothing';
    const plan = {
      tasks: [
        { title: filed, projectId: goalId, completionCriterion: 'EVIDENCE_JUDGMENT' },
        { title: loose, completionCriterion: 'EVIDENCE_JUDGMENT' },
      ],
    };

    const body = await refusalOf(() => service.createMany(ownerId, plan as never));

    assertNamesTheWaysOut(body);
    assert.equal(body.itemIndex, 1, 'the refusal names WHICH item of the plan it is about');
    // All-or-nothing, which is what makes this a refusal of the plan rather than of one row: the
    // item that would have been fine is not written either.
    assert.equal(await taskCount(filed), 0, 'no item of a refused plan is written');
    assert.equal(await taskCount(loose), 0);

    // A preview that answered "this plan lands here" for a plan the write refuses is the one thing
    // a preview must not do, so it is refused in the same place and with the same words.
    const previewed = await refusalOf(() => service.previewPlan(ownerId, plan as never));
    assertNamesTheWaysOut(previewed);
    assert.equal(await taskCount(loose), 0, 'and a preview still writes nothing');
  });

  // ═══ 3. the edit door, in both of its spellings ═══════════════════════════════════════════
  await t.test('re-declaring an existing project-less task EVIDENCE_JUDGMENT is refused the same way',
    async () => {
      const created = await service.create(ownerId, {
        title: 'standalone work that started out executable',
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'npm run test:outcome-reconciler:fast-gate',
        acceptanceExpectedExitCode: 0,
      } as never) as { id: string };

      const named = await refusalOf(() => service.update(ownerId, created.id, {
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCommand: null,
        acceptanceExpectedExitCode: null,
        completionCriterionOverrideReason: 'the command was never the right question here',
      } as never));
      assertNamesTheWaysOut(named);

      // The spelling a client can reach TODAY without ever naming the criterion: clearing the
      // acceptance pair re-resolves the declaration to EVIDENCE_JUDGMENT. A door that only watched
      // `dto.completionCriterion` would refuse the name and wave the synonym through.
      const derived = await refusalOf(() => service.update(ownerId, created.id, {
        acceptanceCommand: null,
        acceptanceExpectedExitCode: null,
        completionCriterionOverrideReason: 'dropping the command, whatever that leaves behind',
      } as never));
      assertNamesTheWaysOut(derived);

      assert.deepEqual(await declarationOf(created.id), {
        project_id: null,
        completion_criterion: 'EXECUTABLE',
        acceptance_command: 'npm run test:outcome-reconciler:fast-gate',
      }, 'a refused edit leaves the declaration the task already had exactly as it was');
    });

  // ═══ 4. the reverse control: the same declaration, filed somewhere ════════════════════════
  await t.test('the identical declaration is accepted when the work lands in a project',
    async () => {
      const created = await service.create(ownerId, {
        title: 'the same work, filed under the goal it serves',
        projectId: goalId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never) as { id: string };

      assert.deepEqual(await declarationOf(created.id), {
        project_id: goalId,
        completion_criterion: 'EVIDENCE_JUDGMENT',
        acceptance_command: null,
      });
    });

  // ═══ 5. the other reverse control: the criterion was never the problem ════════════════════
  await t.test('a project-less task declaring EXECUTABLE was never the problem and still passes',
    async () => {
      const created = await service.create(ownerId, {
        title: 'standalone work that says how it is checked',
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'npm run test:outcome-reconciler:fast-gate',
        acceptanceExpectedExitCode: 0,
      } as never) as { id: string };

      assert.deepEqual(await declarationOf(created.id), {
        project_id: null,
        completion_criterion: 'EXECUTABLE',
        acceptance_command: 'npm run test:outcome-reconciler:fast-gate',
      });
    });

  // ═══ 6 & 7. the rows already in this state keep both ways out ═════════════════════════════
  await t.test('a stranded row can still be re-declared EXECUTABLE', async () => {
    const taskId = await stranded('stranded work that will say how it is checked');

    await service.update(ownerId, taskId, {
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'npm run test:outcome-reconciler:fast-gate',
      acceptanceExpectedExitCode: 0,
      completionCriterionOverrideReason:
        'this work is checked by a command, which is how it should have been filed',
    } as never);

    assert.deepEqual(await declarationOf(taskId), {
      project_id: null,
      completion_criterion: 'EXECUTABLE',
      acceptance_command: 'npm run test:outcome-reconciler:fast-gate',
    });
  });

  await t.test('a stranded row can still be filed under a project, criterion untouched', async () => {
    const taskId = await stranded('stranded work that belongs to the goal after all');

    await service.update(ownerId, taskId, { projectId: goalId } as never);

    assert.deepEqual(await declarationOf(taskId), {
      project_id: goalId,
      completion_criterion: 'EVIDENCE_JUDGMENT',
      acceptance_command: null,
    }, 'filing the work is the way out that keeps the criterion it already had');
  });

  // ═══ 8. the words ═════════════════════════════════════════════════════════════════════════
  // "There is no project" and "the project reworded its criterion" are two different facts, and
  // the refusal a submitter reads has to be about the one that is true of their row. Asked of the
  // door's own predicate rather than of a copy of its arithmetic.
  await t.test('the refusal for a task in no project is not the one for a reworded criterion',
    async () => {
      const quoted = {
        claim: 'the work is done',
        criterion: { key: uuidToBase62(criterionId), text: CRITERION_TEXT },
        checks: [],
        gaps: [],
      };

      const unfiled = await criterionStandingRefusal(
        prisma as never, { projectId: null, acceptanceCriteria: null }, quoted,
      );
      const reworded = await criterionStandingRefusal(
        prisma as never,
        { projectId: goalId, acceptanceCriteria: null },
        { ...quoted, criterion: { key: uuidToBase62(criterionId), text: `${CRITERION_TEXT}, twice` } },
      );

      assert.ok(unfiled, 'a task with no project and no criteria of its own states no standard');
      assert.ok(reworded, 'a quote the project has since reworded is refused too');
      assert.notEqual(unfiled.message, reworded.message,
        'two different facts have to read as two different sentences');
      assert.doesNotMatch(unfiled.message, /is not what the project states today/u,
        'there is no project here, so nothing about one can have moved');
      assert.match(unfiled.message, /in no project/u,
        'and the sentence has to say plainly that the task is under no project at all');
      assert.match(reworded.message, /is not what the project states today/u,
        'the sentence a task in a project reads is unchanged');
    });
});
