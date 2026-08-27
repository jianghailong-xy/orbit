import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ProjectAutomationPolicy,
  SessionDispatchOrigin,
  TaskStatus,
  type Runner,
} from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { TasksService } from '../tasks/tasks.service';
import { buildCoordinatorOpening } from './coordinator-opening';
import { buildJudgmentOpening } from './coordinator-judgment-opening';
import { attemptEndedUnsettledFact } from './coordinator-wake';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { sha256 } from './project-acceptance';

/**
 * Unit T6, where it actually bites: the SERVICE.
 *
 * `coordinator-authority.spec.ts` says what the rules are. This file says they are a boundary and
 * not advice. The role cases call the service directly; N21's credential cases first pass an
 * opaque runner token or a minted owner JWT through the real auth guard and controller, then hit
 * that same service gate. No case relies on a prompt. A model can be talked out of a prompt; it
 * cannot be talked out of the service, while a credential the service accepts is deliberately
 * shown to be a different trust question.
 *
 * The negative control runs beside every refusal rather than once at the end: a gate that refuses
 * everybody is indistinguishable from a gate that works, right up until somebody notices the
 * product stopped functioning.
 */

const OWNER = '00000000-0000-7000-8000-0000000000d1';
const PROJECT = '00000000-0000-7000-8000-0000000000d2';
const TASK = '00000000-0000-7000-8000-0000000000d3';
const SUBJECT = '00000000-0000-7000-8000-0000000000d4';
const SESSION = '00000000-0000-7000-8000-0000000000d5';
const RUN = '00000000-0000-7000-8000-0000000000d6';
const CREATED = '00000000-0000-7000-8000-0000000000d7';

/** Two criteria the owner channel recorded, and the content keys `project_get` hands back. */
const CRITERION_TEXT = ['the dispatcher starts a ready task', 'the boundary is server-side'];
const CRITERION_KEYS = CRITERION_TEXT.map((text) => sha256(text).slice(0, 32));

/** Everything past the gate is a world this fixture does not build. Reaching it IS the assertion. */
const PAST_THE_GATE = 'reached the write';

function pastTheGate(): never {
  throw new Error(PAST_THE_GATE);
}

async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
    return error.getResponse() as Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'the write was not refused' });
}

/** The write was allowed through this unit's gate and stopped where the fixture stops. */
async function reachesTheWrite(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) =>
    error instanceof Error && error.message === PAST_THE_GATE);
}

function httpContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

/** N21's credential-minting scenario: use the real JWT guard, but never expose the token. */
async function ownerFromMintedCredential() {
  const jwt = new JwtService({
    secret: 'n21-owner-signing-secret-used-only-inside-this-test',
    signOptions: { expiresIn: '1h' },
  });
  const credential = await jwt.signAsync({ sub: OWNER, email: 'owner@example.test' });
  const request: Record<string, unknown> = {
    headers: { authorization: `Bearer ${credential}` },
    query: {},
  };
  await new JwtAuthGuard(jwt, {} as never).canActivate(httpContext(request));
  assert.deepEqual(request.user, { userId: OWNER, email: 'owner@example.test' });
  return request.user as { userId: string; email: string };
}

/** The ordinary opaque runner credential an agent already holds, through the real runner guard. */
async function runnerFromAgentCredential(): Promise<Runner> {
  const credential = 'n21-agent-held-runner-credential';
  const expectedHash = createHash('sha256').update(credential).digest('hex');
  const guard = new RunnerAuthGuard({
    runner: {
      findFirst: async ({ where }: { where: { tokenHash: string } }) => {
        assert.equal(where.tokenHash, expectedHash);
        return { id: RUN, ownerId: OWNER };
      },
    },
  } as never);
  const request: Record<string, unknown> = {
    headers: { authorization: `Bearer ${credential}` },
  };
  await guard.canActivate(httpContext(request));
  return request.runner as Runner;
}

function ownerController() {
  return new ProjectsController(
    projectFixture() as never,
    acceptanceFixture() as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function runnerController() {
  return new RunnerProjectsController(
    projectFixture() as never,
    acceptanceFixture() as never,
    {} as never,
  );
}

// ═══ project_update: the acceptance criteria, and status = DONE ═══════════════════════════════

function projectFixture(policy: ProjectAutomationPolicy = ProjectAutomationPolicy.GUARDED_AUTO) {
  const prisma = {
    project: {
      findFirst: async () => ({
        id: PROJECT,
        coordinatorEnabled: true,
        automationPolicy: policy,
      }),
    },
    session: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        where.id === SESSION && where.ownerId === OWNER
          ? { dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR }
          : where.id === RUN && where.ownerId === OWNER
            ? { dispatchOrigin: SessionDispatchOrigin.USER }
            : null,
    },
    $transaction: pastTheGate,
  };
  return new ProjectsService(prisma as never);
}

const PROJECT_WRITES = [
  ['acceptanceCriteria', { acceptanceCriteria: 'anything I like' },
    'ACCEPTANCE_CRITERIA_HUMAN_ONLY'],
  // Both authoring shapes write the same fact. Gating one and not the other would leave the legacy
  // text as an unguarded way to rewrite the exam.
  ['acceptanceCriteriaItems', { acceptanceCriteriaItems: [{ text: 'anything I like' }] },
    'ACCEPTANCE_CRITERIA_HUMAN_ONLY'],
] as const;

for (const [what, dto, code] of PROJECT_WRITES) {
  test(`a judgment session cannot write ${what} on a project`, async () => {
    const body = await refusalOf(() => projectFixture().update(OWNER, PROJECT, dto as never, SESSION));

    assert.equal(body.code, code, 'the refusal names WHICH boundary, not merely that there was one');
    assert.equal(body.tier, 'HUMAN_ONLY');
    assert.equal(body.requiredAction, 'ASK_A_PERSON');
  });

  test(`a no-session owner/internal caller and a USER-origin session write ${what}`, async () => {
    // The user/internal door carries no acting session at all, so it never reaches the lookup.
    await reachesTheWrite(() => projectFixture().update(OWNER, PROJECT, dto as never));
    // The long-lived coordination conversation has USER origin. Neither case proves human
    // presence; both are simply outside the one-shot judgment role this contract restricts.
    await reachesTheWrite(() => projectFixture().update(OWNER, PROJECT, dto as never, RUN));
  });
}

test('a judgment session cannot write status=DONE on a project', async () => {
  await assert.rejects(
    () => projectFixture().update(OWNER, PROJECT, { status: 'DONE' } as never, SESSION),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as Record<string, unknown>).code,
        'PROJECT_DONE_AUTOMATIC_ONLY');
      return true;
    },
  );
});

test('all non-judgment callers are also refused a direct DONE because it is derived', async () => {
  for (const actingSessionId of [undefined, RUN]) {
    await assert.rejects(
      () => projectFixture().update(
        OWNER,
        PROJECT,
        { status: 'DONE' } as never,
        actingSessionId,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'PROJECT_DONE_AUTOMATIC_ONLY');
        return true;
      },
    );
  }
});

// §0's replacement claim, end to end. The three-level dial used to be the answer to "how far may
// this coordinator go"; if any of it still were, the same write would come out differently at the
// three levels.
test('the refusal does not depend on the project automation policy', async () => {
  for (const policy of Object.values(ProjectAutomationPolicy)) {
    await assert.rejects(
      () => projectFixture(policy).update(
        OWNER,
        PROJECT,
        { status: 'DONE' } as never,
        SESSION,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'PROJECT_DONE_AUTOMATIC_ONLY', `refused at ${policy}`);
        return true;
      },
    );
  }
});

test('a judgment session may still write the prose that says what the work is', async () => {
  // The bound is on the exam and on the verdict, not on coordinating. Reporting a goal more
  // clearly, or recording instructions, is exactly what a coordinator is for.
  await reachesTheWrite(
    () => projectFixture().update(OWNER, PROJECT, { goal: 'what this is for' } as never, SESSION),
  );
  // CANCELLED is not this boundary either: dropping work is not claiming its goal was met.
  await reachesTheWrite(
    () => projectFixture().update(OWNER, PROJECT, { status: 'CANCELLED' } as never, SESSION),
  );
});

// ═══ acceptance runs: a PASS is what a project's DONE is bound to ═════════════════════════════

function acceptanceFixture() {
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === SESSION
          ? { dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR }
          : { dispatchOrigin: SessionDispatchOrigin.USER },
    },
    $transaction: pastTheGate,
  };
  return new ProjectAcceptanceService(prisma as never);
}

test('dispatch_origin=judgment cannot conclude an acceptance criterion PASS', async () => {
  const body = await refusalOf(() => acceptanceFixture().finalizeRun(
    OWNER, PROJECT, 'run-1', [{ ordinal: 1, verdict: 'PASS' as never }], SESSION,
  ));

  assert.equal(body.code, 'VERDICT_PASS_HUMAN_ONLY');
  assert.equal(body.action, 'CONCLUDE_VERDICT_PASS');
  assert.equal(body.requiredAction, 'ASK_A_PERSON');
});

test('a headless runner keeps machine attribution when it omits the acting session header', async () => {
  const body = await refusalOf(() => acceptanceFixture().finalizeRun(
    OWNER,
    PROJECT,
    'run-1',
    [{ ordinal: 1, verdict: 'PASS' as never }],
    undefined,
    RUN,
  ));

  assert.equal(body.code, 'VERDICT_PASS_HUMAN_ONLY');
  assert.equal(body.action, 'CONCLUDE_VERDICT_PASS');
});

test('one PASS among failures is still a PASS being written', async () => {
  const body = await refusalOf(() => acceptanceFixture().finalizeRun(
    OWNER, PROJECT, 'run-1',
    [{ ordinal: 1, verdict: 'FAIL' as never }, { ordinal: 2, verdict: 'PASS' as never }],
    SESSION,
  ));
  assert.equal(body.code, 'VERDICT_PASS_HUMAN_ONLY');
});

test('a judgment session may report that acceptance did NOT pass', async () => {
  // The asymmetry this unit shares with the self-DONE boundary: the conservative conclusion
  // releases nothing and requests owner review, so there is no reason to refuse it.
  await reachesTheWrite(() => acceptanceFixture().finalizeRun(
    OWNER, PROJECT, 'run-1',
    [{ ordinal: 1, verdict: 'FAIL' as never }, { ordinal: 2, verdict: 'INCONCLUSIVE' as never }],
    SESSION,
  ));
});

test('a no-session owner/internal caller and a USER-origin session conclude PASS', async () => {
  await reachesTheWrite(() => acceptanceFixture().finalizeRun(
    OWNER, PROJECT, 'run-1', [{ ordinal: 1, verdict: 'PASS' as never }],
  ));
  await reachesTheWrite(() => acceptanceFixture().finalizeRun(
    OWNER, PROJECT, 'run-1', [{ ordinal: 1, verdict: 'PASS' as never }], RUN,
  ));
});

// ═══ N21: credential possession is not human presence ═════════════════════════════════════════

test('an agent-held runner credential with no acting session can edit acceptanceCriteria', async () => {
  const runner = await runnerFromAgentCredential();
  await reachesTheWrite(() => runnerController().updateProject(
    runner,
    PROJECT,
    undefined,
    { acceptanceCriteria: 'replacement exam' } as never,
  ));
});

test('an agent-held runner credential with no acting session cannot record acceptance PASS', async () => {
  const runner = await runnerFromAgentCredential();
  const body = await refusalOf(() => runnerController().finalizeAcceptanceRun(
    runner,
    PROJECT,
    'run-1',
    undefined,
    { criteria: [{ ordinal: 1, verdict: 'PASS' }] } as never,
  ));
  assert.equal(body.code, 'VERDICT_PASS_HUMAN_ONLY');
});

test('an agent-held runner credential with no acting session cannot directly write project.status=DONE', async () => {
  const runner = await runnerFromAgentCredential();
  await assert.rejects(
    () => runnerController().updateProject(
      runner,
      PROJECT,
      undefined,
      { status: 'DONE' } as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as Record<string, unknown>).code,
        'PROJECT_DONE_AUTOMATIC_ONLY');
      return true;
    },
  );
});

test('a headless runner can still record a conservative acceptance conclusion', async () => {
  const runner = await runnerFromAgentCredential();
  await reachesTheWrite(() => runnerController().finalizeAcceptanceRun(
    runner,
    PROJECT,
    'run-1',
    undefined,
    { criteria: [{ ordinal: 1, verdict: 'INCONCLUSIVE' }] } as never,
  ));
});

test('an owner JWT minted with the shared secret can edit acceptanceCriteria without a session', async () => {
  const user = await ownerFromMintedCredential();
  await reachesTheWrite(() => ownerController().update(
    user,
    PROJECT,
    { acceptanceCriteria: 'replacement exam' } as never,
  ));
});

test('an owner JWT minted with the shared secret can record PASS without a session', async () => {
  const user = await ownerFromMintedCredential();
  await reachesTheWrite(() => ownerController().finalizeAcceptanceRun(
    user,
    PROJECT,
    'run-1',
    { criteria: [{ ordinal: 1, verdict: 'PASS' }] } as never,
  ));
});

test('an owner JWT minted with the shared secret cannot directly write project.status=DONE', async () => {
  const user = await ownerFromMintedCredential();
  await assert.rejects(
    () => ownerController().update(
      user,
      PROJECT,
      { status: 'DONE' } as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as Record<string, unknown>).code,
        'PROJECT_DONE_AUTOMATIC_ONLY');
      return true;
    },
  );
});

// ═══ task_update: a verification's PASS completes the task it checks ══════════════════════════

function taskUpdateFixture(dispatchOrigin: SessionDispatchOrigin) {
  const writes: Array<Record<string, unknown>> = [];
  const task = {
    id: TASK,
    ownerId: OWNER,
    title: 'Check it',
    status: TaskStatus.IN_PROGRESS,
    projectId: PROJECT,
    listId: null,
    completionPolicy: 'MANUAL',
    isForeman: false,
    verifiesTaskId: SUBJECT,
    verdict: null,
    verdictRevision: 0n,
    supersededByTaskId: null,
    supersededAt: null,
    terminalReason: null,
    creatorSessionId: null,
    assignee: null,
    comments: [],
    sessions: [],
    creatorSession: null,
    dependsOn: [],
    dependedOnBy: [],
  };
  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    project: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        ({ id: where.id, runtime: { coordinatorGeneration: 0n } }),
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({
          id, status: 'OPEN', acceptanceEpoch: 0n, maxConcurrentTasks: 3,
          sessionBudgetPerDay: null, members: [],
        })),
    },
    taskList: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    session: {
      findFirst: async () => ({
        id: SESSION,
        taskId: null,
        task: null,
        coordinatorForProject: null,
        judgmentForWake: { projectId: PROJECT },
        dispatchOrigin,
      }),
    },
    taskDependency: { findMany: async () => [] },
    task: {
      findFirst: async () => ({ ...task }),
      findMany: async () => [],
      count: async () => 0,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...task, ...data };
      },
    },
    taskListEvent: { upsert: async () => ({}) },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser() {}, publishTaskChanged() {},
  } as never);
  return {
    service,
    writes,
    conclude: (verdict: string) =>
      service.update(OWNER, TASK, { verdict } as never, SESSION),
  };
}

test('a judgment session cannot conclude a verification PASS', async () => {
  // A PASS here is not an opinion filed beside the work: `task-aggregation.ts` completes the
  // subject on `status DONE && verdict PASS`, so this write finishes SUBJECT for everybody
  // downstream of it.
  const f = taskUpdateFixture(SessionDispatchOrigin.PROJECT_COORDINATOR);

  const body = await refusalOf(() => f.conclude('PASS'));

  assert.equal(body.code, 'VERDICT_PASS_HUMAN_ONLY');
  assert.equal(body.tier, 'HUMAN_ONLY');
  assert.deepEqual(f.writes, [], 'a refusal that leaves the row moved has prevented nothing');
});

test('a judgment session may conclude FAIL or INCONCLUSIVE', async () => {
  for (const verdict of ['FAIL', 'INCONCLUSIVE']) {
    const f = taskUpdateFixture(SessionDispatchOrigin.PROJECT_COORDINATOR);
    await f.conclude(verdict);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].verdict, verdict);
  }
});

test('the same PASS from a USER-origin session is written', async () => {
  const f = taskUpdateFixture(SessionDispatchOrigin.USER);

  await f.conclude('PASS');

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].verdict, 'PASS');
});

test('an agent-held runner credential with no acting session can write task verdict=PASS', async () => {
  const runner = await runnerFromAgentCredential();
  const f = taskUpdateFixture(SessionDispatchOrigin.USER);
  const controller = new RunnerTasksController(f.service, {} as never, {} as never);

  await controller.updateTask(runner, TASK, undefined, { verdict: 'PASS' } as never);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].verdict, 'PASS');
});

// ═══ task_create: bounded, not refused ════════════════════════════════════════════════════════

function createFixture(options: {
  dispatchOrigin?: SessionDispatchOrigin;
  openedInWindow?: number;
  budgetPerDay?: number | null;
  criteria?: string[];
} = {}) {
  const criteria = options.criteria ?? CRITERION_TEXT;
  const writes: Array<Record<string, unknown>> = [];
  const counted: Array<Record<string, unknown>> = [];
  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    project: {
      // A superset of the three selects this path makes: the scope derivation reads `runtime`, the
      // T6 gate reads the criteria and the budget.
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        runtime: { coordinatorGeneration: 0n },
        acceptanceCriteria: null,
        sessionBudgetPerDay: options.budgetPerDay === undefined ? 5 : options.budgetPerDay,
        acceptanceCriterionDefinitions: criteria.map((text, index) => ({
          id: `def-${index}`, ordinal: index + 1, text, revision: 1, contentHash: sha256(text),
        })),
      }),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id, status: 'OPEN', acceptanceEpoch: 0n, maxConcurrentTasks: 3,
          sessionBudgetPerDay: null, members: [],
        })),
    },
    taskList: { findMany: async () => [] },
    workspace: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    session: {
      findFirst: async () => ({
        id: SESSION,
        taskId: null,
        task: null,
        coordinatorForProject: null,
        // What makes this a judgment session rather than a USER-origin conversation: it is
        // bound to the wake it was opened for, and to nothing else.
        judgmentForWake: { projectId: PROJECT },
        dispatchOrigin: options.dispatchOrigin ?? SessionDispatchOrigin.PROJECT_COORDINATOR,
      }),
    },
    conversationTurn: { findFirst: async () => null },
    task: {
      findMany: async () => [],
      findUnique: async () => null,
      count: async (args: Record<string, unknown>) => {
        counted.push(args);
        return options.openedInWindow ?? 0;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...data, id: CREATED, parentTaskId: null, verifiesTaskId: null };
      },
    },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser() {},
    publishTaskChanged() {},
  } as never);
  return {
    writes,
    counted,
    open: (dto: Record<string, unknown>) =>
      service.create(OWNER, { title: 'Repair the dispatcher', ...dto } as never, undefined, SESSION),
  };
}

test('a judgment session opening a task must say which criterion it serves', async () => {
  const f = createFixture();

  const body = await refusalOf(() => f.open({}));

  assert.equal(body.code, 'TASK_CRITERION_UNDECLARED');
  assert.equal(body.action, 'OPEN_TASK');
  assert.equal(body.tier, 'COORDINATOR_BOUNDED');
  assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
  assert.deepEqual(f.writes, []);
});

test('a criterion key this project does not state is refused', async () => {
  const f = createFixture();

  const body = await refusalOf(() => f.open({ criterionKey: 'f'.repeat(32) }));

  assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
  assert.deepEqual(f.writes, []);
});

test('a declared criterion inside the daily budget opens the task', async () => {
  const f = createFixture({ budgetPerDay: 5, openedInWindow: 4 });

  await f.open({ criterionKey: CRITERION_KEYS[1] });

  assert.equal(f.writes.length, 1, 'the bound is a bound, not a ban');
  assert.equal(f.writes[0].title, 'Repair the dispatcher');
  // The declaration is not stored: it says the work was ASKED FOR at the moment it was filed, and
  // a criterion the project no longer states must not go on justifying tasks written under it.
  assert.equal(f.writes[0].criterionKey, undefined);
});

test('over the day’s allowance, the same task is refused', async () => {
  const f = createFixture({ budgetPerDay: 5, openedInWindow: 5 });

  const body = await refusalOf(() => f.open({ criterionKey: CRITERION_KEYS[1] }));

  assert.equal(body.code, 'TASK_BUDGET_SPENT');
  assert.equal(body.requiredAction, 'WAIT_FOR_THE_BUDGET_WINDOW');
  assert.deepEqual(f.writes, []);
  // Counted over this project's tasks, inside the window, by the dispatch origin of the session
  // that created them — one spelling of "a judgment opened this", and the same one §1 derives the
  // principal from.
  const where = (f.counted[0] as { where: Record<string, any> }).where;
  assert.equal(where.projectId, PROJECT);
  assert.equal(where.creatorSession.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
  assert.ok(where.createdAt.gte instanceof Date);
});

test('a project that states no acceptance criteria has nothing for it to serve', async () => {
  const f = createFixture({ criteria: [] });

  const body = await refusalOf(() => f.open({ criterionKey: CRITERION_KEYS[0] }));

  assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
});

test('a USER-origin session opens tasks with no criterion and no budget', async () => {
  // The negative control for the whole of `OPEN_TASK`: the same call, the same project, the same
  // empty declaration, from a session outside the one-shot judgment role.
  const f = createFixture({
    dispatchOrigin: SessionDispatchOrigin.USER,
    budgetPerDay: 1,
    openedInWindow: 99,
  });

  await f.open({});

  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.counted, [], 'and it pays no query for a boundary that does not apply to it');
});

// ═══ the openings: advice that agrees with the boundary ═══════════════════════════════════════

/**
 * The prompts are not the boundary and nothing above depends on them. What they can still do is be
 * WRONG — an opening that hands a coordinator a tool the server refuses spends the first turn on a
 * promise, and then reports confidently on whatever it did instead. That is the failure 60dece5e
 * removed from the old opening (it described a policy matrix no code enforced), and this unit
 * arrived at the same place from the other direction: the code moved, so the copy has to.
 *
 * Asserted as predicates over the RENDERED string rather than by reading the source, because what
 * a reader is told is the rendered string.
 */
test('the conversational opening no longer offers the criteria or DONE as its own tools', () => {
  const opening = buildCoordinatorOpening('协调重做', randomUUID());

  // It still says what project_update IS for.
  assert.match(opening, /project_update/);
  // And no longer sells it as the way to rewrite the exam or to record that the goal was met.
  assert.doesNotMatch(opening, /project_update[^。]*验收标准/);
  assert.doesNotMatch(opening, /status\s*记成\s*DONE/);
  // Naming the two, and naming who decides them, rather than falling silent: a coordinator that
  // is told nothing goes looking, which is the same wasted turn by another route.
  assert.match(opening, /验收标准/);
  assert.match(opening, /DONE/);
  assert.match(opening, /账号所有者通道记录/);
  assert.match(opening, /不是服务器对“真人在场”的密码学证明/);
});

test('the judgment opening states the three boundaries the server enforces', () => {
  const fact = attemptEndedUnsettledFact({
    projectId: randomUUID(),
    taskId: randomUUID(),
    taskStatus: 'IN_PROGRESS',
    sessionId: randomUUID(),
  })!;

  const opening = buildJudgmentOpening(fact, '协调重做');

  // What it must DECLARE to open work, and what bounds how much of it there can be.
  assert.match(opening, /criterionKey/);
  assert.match(opening, /预算/);
  // And the three it cannot write, said as refusals rather than as etiquette — the reader is
  // about to meet them as HTTP 403s.
  assert.match(opening, /服务端会照着拒/);
  assert.match(opening, /验收标准/);
  assert.match(opening, /PASS/);
  assert.match(opening, /status=DONE/);
  assert.match(opening, /不是对“真人在场”的密码学证明/);
});
