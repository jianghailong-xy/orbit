/**
 * A task's own run does not get to say what counts as that task being done.
 *
 * WHAT WENT WRONG
 * ---------------
 * Every wall Orbit has around completion is a wall around the ANSWER. A verdict cannot be
 * concluded from the run of the task it verifies (§13.2). An evidence decision cannot be made by
 * the session that produced the evidence. Writing `status: DONE` by hand is refused for every
 * actor alive. All of it implements one rule: a task is completed by a judgement its own work did
 * not make.
 *
 * Nothing was a wall around the QUESTION. `TasksService.update`'s only who-is-writing test read
 * `dto.verdict`, so `completionCriterion` was reachable from any session at all — including the
 * run of the task it decides. A run that the evidence door would have refused could therefore
 * re-declare its own task EXECUTABLE, name an acceptance command of its own choosing in the same
 * request, and have that command's exit code settle its own task a minute later. On 2026-09-05
 * exactly that sequence ran on task `34JPtYithZCi65TgVIaUu` (benignly — the criterion was changed
 * by an INDEPENDENT session, and the door could not tell the difference), and afterwards nothing
 * on the row said the standard had moved at all.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * The tightening, and — at least as important — its exact width, since a wall around completion
 * that also walls off repair turns a mis-declared task into work nothing can ever settle:
 *
 *  - the task's own run is refused when it moves any part of its own standard: the criterion, the
 *    acceptance pair, the completion policy;
 *  - the SAME request, from an independent run and from the account owner with no run at all, is
 *    accepted — and an independent run still owes the criterion-change door its reason, so the two
 *    doors are shown composing rather than one masking the other;
 *  - the existing remedy is still open: a project-less EVIDENCE_JUDGMENT row, the shape that used
 *    to be a deadlock, can still be re-declared EXECUTABLE by anybody except its own run;
 *  - the budget is deliberately NOT part of the standard. A run may still raise its own
 *    `acceptanceTimeoutSeconds`, because that bounds how long the declared command may run without
 *    changing what the command has to report — and restating the standard it already carries is
 *    not rewriting it;
 *  - the run can still say what it found: a title and a FAILED self-report are untouched.
 *
 * Nothing is stubbed: the service is the one the API wires, over a real client, and every claim is
 * read back out of the row. Refusals are asserted through a STRUCTURAL view of the response body
 * with every field optional, and the code and required action are written here as literals rather
 * than imported, so this suite compiles — and fails — against the implementation that has no such
 * door. Importing the constants the change adds would turn the negative control into a compile
 * error, which stops the suite and proves nothing.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='task-self-completion-standard\.pg\.spec\.js$' \
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

/** The refusal this change introduces, as a reader of the response body sees it. */
const SELF_REWRITE_CODE = 'TASK_COMPLETION_STANDARD_SELF_REWRITE_REFUSED';
const SELF_REWRITE_ACTION = 'HAVE_AN_INDEPENDENT_SESSION_RESTATE_THE_STANDARD';
/** The door BESIDE it, which asks why rather than who. Present already, and must stay separate. */
const UNEXPLAINED_CODE = 'TASK_COMPLETION_CRITERION_CHANGE_UNEXPLAINED';

const CHOSEN_COMMAND = 'npm run test:outcome-reconciler:fast-gate';
const DECLARED_COMMAND = 'npm run test:outcome-reconciler:full-api';

/**
 * A refusal body with every field optional.
 *
 * Read through the types this change introduces, an implementation that has no such door would
 * fail to COMPILE rather than fail to refuse — and a suite that does not build is not a negative
 * control.
 */
interface RefusalView {
  code?: string;
  kind?: string;
  requiredAction?: string;
  message?: string;
  rewritten?: string[];
}

/** The stored standard, straight out of the row rather than through a service return value. */
interface StoredStandard {
  completion_criterion: string;
  completion_policy: string;
  acceptance_command: string | null;
  acceptance_expected_exit_code: number | null;
  acceptance_timeout_seconds: number | null;
}

suite('a task\'s own run cannot rewrite the standard it is measured by', async (t) => {
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
  // `evidence-judgment-project-standard.pg.spec` builds it.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const goalId = randomUUID();
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
    data: { id: goalId, ownerId, title: 'the goal this work is filed under' },
  });

  /**
   * A task, written straight to the database, and the run that is doing it.
   *
   * Straight to the database because two of the shapes below cannot be reached through `create`
   * any more — a project-less EVIDENCE_JUDGMENT row is refused at that door now — and because
   * what is under test is the EDIT door, not how the row came to look like this.
   */
  async function work(fields: {
    title: string;
    projectId?: string | null;
    completionCriterion: string;
    acceptanceCommand?: string | null;
    acceptanceExpectedExitCode?: number | null;
  }): Promise<{ taskId: string; ownRun: string }> {
    const taskId = randomUUID();
    const ownRun = randomUUID();
    await prisma.task.create({
      data: {
        id: taskId,
        ownerId,
        projectId: fields.projectId ?? null,
        title: fields.title,
        creatorType: CreatorType.AGENT,
        creatorId: workspaceId,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: fields.completionCriterion as never,
        acceptanceCriteria: 'what would settle this task, in its own words',
        acceptanceCommand: fields.acceptanceCommand ?? null,
        acceptanceExpectedExitCode: fields.acceptanceExpectedExitCode ?? null,
      },
    });
    await prisma.session.create({
      data: {
        id: ownRun,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `the run doing ${fields.title}`,
        prompt: 'do the work',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    return { taskId, ownRun };
  }

  /** A run that is doing OTHER work: the independent session every control below acts as. */
  const elsewhere = await work({
    title: 'unrelated work in the same goal',
    projectId: goalId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  });
  const independentRun = elsewhere.ownRun;

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
    const row = outcome && typeof outcome === 'object' && 'id' in outcome ? outcome.id : outcome;
    throw new assert.AssertionError({
      message: `expected a refusal; the write was accepted and produced ${String(row)}`,
    });
  }

  async function standardOf(taskId: string): Promise<StoredStandard> {
    const { rows } = await sql.query<StoredStandard>(
      'SELECT "completion_criterion"::text AS "completion_criterion", '
      + '"completion_policy"::text AS "completion_policy", "acceptance_command", '
      + '"acceptance_expected_exit_code", "acceptance_timeout_seconds" '
      + 'FROM "task" WHERE "id" = $1',
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must exist to have a standard read off it');
    return rows[0];
  }

  /** The refusal, and the two things a reader who is stuck has to be told. */
  function assertRefusedAsSelfRewrite(body: RefusalView, moved: string[]): void {
    assert.equal(body.code, SELF_REWRITE_CODE);
    assert.equal(body.requiredAction, SELF_REWRITE_ACTION);
    assert.deepEqual(body.rewritten, moved, 'the refusal names WHICH parts of the standard moved');
    const message = body.message ?? '';
    assert.match(message, /any session other than this task's run/,
      'the refusal must name who can still make this edit');
    assert.match(message, /account owner/,
      'and the account owner, who reaches this service with no run at all');
    assert.match(message, /FAILED/,
      'and what this run itself may still say about the work');
  }

  // ═══ 1. the path this change exists to close ═══════════════════════════════════════════════
  //
  // The edit is spelled once, here, and answered three different ways by the three cases that
  // follow. Only the session making it differs.
  const REDECLARE_AS_EXECUTABLE = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: CHOSEN_COMMAND,
    acceptanceExpectedExitCode: 0,
    completionCriterionOverrideReason: 'this work is checked by a command',
  };

  await t.test('the run doing the task cannot re-declare it EXECUTABLE and pick the command',
    async () => {
      const subject = await work({
        title: 'work whose run would rather be judged by a command it chose',
        projectId: goalId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      });

      const body = await refusalOf(() => service.update(
        ownerId, subject.taskId, { ...REDECLARE_AS_EXECUTABLE } as never, subject.ownRun,
      ));

      assertRefusedAsSelfRewrite(body,
        ['completionCriterion', 'acceptanceCommand', 'acceptanceExpectedExitCode']);
      assert.deepEqual(await standardOf(subject.taskId), {
        completion_criterion: 'EVIDENCE_JUDGMENT',
        completion_policy: 'MANUAL',
        acceptance_command: null,
        acceptance_expected_exit_code: null,
        acceptance_timeout_seconds: null,
      }, 'a refused edit leaves the standard the task already had exactly as it was');
    });

  // ═══ 2. the control that makes case 1 about WHO rather than about the edit ═════════════════
  await t.test('an independent run makes the identical edit — after answering the other door',
    async () => {
      const subject = await work({
        title: 'the same work, restated by a run that is not doing it',
        projectId: goalId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      });

      // The two doors compose rather than one masking the other: an independent session is past
      // the independence question and straight into the one about explaining itself.
      const { completionCriterionOverrideReason: _reason, ...silent } = REDECLARE_AS_EXECUTABLE;
      const unexplained = await refusalOf(() => service.update(
        ownerId, subject.taskId, { ...silent } as never, independentRun,
      ));
      assert.equal(unexplained.code, UNEXPLAINED_CODE,
        'an independent session is asked WHY, which is the door beside this one');

      await service.update(
        ownerId, subject.taskId, { ...REDECLARE_AS_EXECUTABLE } as never, independentRun,
      );

      assert.deepEqual(await standardOf(subject.taskId), {
        completion_criterion: 'EXECUTABLE',
        completion_policy: 'MANUAL',
        acceptance_command: CHOSEN_COMMAND,
        acceptance_expected_exit_code: 0,
        acceptance_timeout_seconds: null,
      }, 'the edit itself was never the problem');
    });

  await t.test('the account owner, reaching this service with no run at all, makes it too',
    async () => {
      const subject = await work({
        title: 'the same work again, restated by the person who owns it',
        projectId: goalId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      });

      // No fourth argument: this is the user API's call, and there is no run behind it to be
      // independent OF. The rule is about a run judging itself, and a person is not a run.
      await service.update(ownerId, subject.taskId, { ...REDECLARE_AS_EXECUTABLE } as never);

      assert.deepEqual(await standardOf(subject.taskId), {
        completion_criterion: 'EXECUTABLE',
        completion_policy: 'MANUAL',
        acceptance_command: CHOSEN_COMMAND,
        acceptance_expected_exit_code: 0,
        acceptance_timeout_seconds: null,
      });
    });

  // ═══ 3. the same rule, where no criterion moves at all ════════════════════════════════════
  //
  // The criterion-change door cannot answer these: the task declares EXECUTABLE before and after.
  // What moves is what EXECUTABLE measures, which is the same rewrite in another spelling.
  await t.test('the run cannot swap the command it is already going to be measured by', async () => {
    const subject = await work({
      title: 'executable work whose run would rather run something shorter',
      projectId: goalId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: DECLARED_COMMAND,
      acceptanceExpectedExitCode: 0,
    });

    const swapped = await refusalOf(() => service.update(
      ownerId, subject.taskId, { acceptanceCommand: CHOSEN_COMMAND } as never, subject.ownRun,
    ));
    assertRefusedAsSelfRewrite(swapped, ['acceptanceCommand']);
    assert.notEqual(swapped.code, UNEXPLAINED_CODE,
      'no criterion moved here, so the door that asks why is not the one answering');

    const relabelled = await refusalOf(() => service.update(
      ownerId, subject.taskId, { acceptanceExpectedExitCode: 1 } as never, subject.ownRun,
    ));
    assertRefusedAsSelfRewrite(relabelled, ['acceptanceExpectedExitCode']);

    assert.deepEqual(await standardOf(subject.taskId), {
      completion_criterion: 'EXECUTABLE',
      completion_policy: 'MANUAL',
      acceptance_command: DECLARED_COMMAND,
      acceptance_expected_exit_code: 0,
      acceptance_timeout_seconds: null,
    });
  });

  await t.test('nor roll its own completion up out of children instead', async () => {
    const subject = await work({
      title: 'work whose run would rather be completed by its subtasks',
      projectId: goalId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });

    // The criterion is untouched by this write — EVIDENCE_JUDGMENT survives ALL_CHILDREN_DONE —
    // so a door watching only `completionCriterion` would wave it through, and it replaces the
    // question with a different one just as completely.
    const body = await refusalOf(() => service.update(
      ownerId, subject.taskId, { completionPolicy: 'ALL_CHILDREN_DONE' } as never, subject.ownRun,
    ));

    assertRefusedAsSelfRewrite(body, ['completionPolicy']);
    assert.equal((await standardOf(subject.taskId)).completion_policy, 'MANUAL');
  });

  // ═══ 4. the width of the wall: what a run may still do to its own task ════════════════════
  await t.test('a run may still buy its own declared command more wall clock', async () => {
    const subject = await work({
      title: 'executable work that turned out to take longer than anybody budgeted',
      projectId: goalId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: DECLARED_COMMAND,
      acceptanceExpectedExitCode: 0,
    });

    // The command and the exit code are restated verbatim beside the budget: restating a standard
    // is not rewriting it, and a door that fired on the mention would refuse this too.
    await service.update(ownerId, subject.taskId, {
      acceptanceCommand: DECLARED_COMMAND,
      acceptanceExpectedExitCode: 0,
      acceptanceTimeoutSeconds: 5400,
    } as never, subject.ownRun);

    assert.deepEqual(await standardOf(subject.taskId), {
      completion_criterion: 'EXECUTABLE',
      completion_policy: 'MANUAL',
      acceptance_command: DECLARED_COMMAND,
      acceptance_expected_exit_code: 0,
      acceptance_timeout_seconds: 5400,
    }, 'a budget bounds how long the command may run; it cannot make a failing command pass');
  });

  await t.test('and may still say what it found about its own work', async () => {
    const subject = await work({
      title: 'work that did not come off',
      projectId: goalId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: DECLARED_COMMAND,
      acceptanceExpectedExitCode: 0,
    });

    await service.update(ownerId, subject.taskId, {
      title: 'work that did not come off, and says so',
      status: TaskStatus.FAILED,
    } as never, subject.ownRun);

    const { rows } = await sql.query<{ status: string; title: string }>(
      'SELECT "status"::text AS "status", "title" FROM "task" WHERE "id" = $1', [subject.taskId],
    );
    assert.equal(rows[0].status, 'FAILED', 'the wall is around the standard, not around the run');
    assert.equal(rows[0].title, 'work that did not come off, and says so');
  });

  // ═══ 5. the remedy this must not have taken away ══════════════════════════════════════════
  //
  // A project-less EVIDENCE_JUDGMENT row is the shape that used to be a deadlock, and re-declaring
  // it EXECUTABLE is one of the two ways out. A wall that closed that path for everybody would
  // have replaced a bypass with a trap.
  await t.test('a project-less EVIDENCE_JUDGMENT row is still rescuable — by anybody but its run',
    async () => {
      const stranded = await work({
        title: 'standalone work filed under no goal at all',
        projectId: null,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      });

      const refused = await refusalOf(() => service.update(
        ownerId, stranded.taskId, { ...REDECLARE_AS_EXECUTABLE } as never, stranded.ownRun,
      ));
      assertRefusedAsSelfRewrite(refused,
        ['completionCriterion', 'acceptanceCommand', 'acceptanceExpectedExitCode']);

      await service.update(
        ownerId, stranded.taskId, { ...REDECLARE_AS_EXECUTABLE } as never, independentRun,
      );

      assert.deepEqual(await standardOf(stranded.taskId), {
        completion_criterion: 'EXECUTABLE',
        completion_policy: 'MANUAL',
        acceptance_command: CHOSEN_COMMAND,
        acceptance_expected_exit_code: 0,
        acceptance_timeout_seconds: null,
      }, 'the way out of the old deadlock stays open to every session that did not do the work');
    });
});
