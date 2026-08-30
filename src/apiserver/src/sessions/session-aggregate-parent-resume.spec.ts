import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * §13.1 AG6 at the two doors that do NOT go through `TasksService`.
 *
 * `SessionsService.resume` and `armAutoRetry` are public API and reach a Session directly, so a run
 * that was a legal leaf when it failed can be revived onto a task that has since become a roll-up
 * node. The database refuses that revival (migration 0132, covered against real PostgreSQL in
 * `task-aggregate-parent-dispatch.pg.spec.ts`); what these assert is the SERVICE pre-check, which
 * is what turns it into a sentence instead of a constraint violation.
 *
 * The line both of them draw is the one that matters: the aggregate gate applies to a turn that is
 * the TASK'S WORK and to nothing else. A conversation about a roll-up node — reading it, asking it
 * a question, salvaging something from a run that stopped — is a legitimate thing to resume, and
 * refusing it would remove a way out of a stuck subtree rather than a way in.
 */

const TASK = '00000000-0000-4000-8000-000000000101';
const SESSION = '00000000-0000-4000-8000-000000000102';

type TaskFacts = {
  completionPolicy: string;
  completionCriterion: 'EXECUTABLE' | 'VERIFICATION' | 'HUMAN_SIGNOFF';
  verifiesTaskId: string | null;
  hasDirectChildren: boolean;
};

/** The only two reads these paths make: the session row, and the task facts behind it. */
function serviceFor(
  session: Record<string, unknown>,
  facts: TaskFacts,
): SessionsService {
  const inner = {
    session: {
      findFirst: async () => session,
      updateMany: async (args: { where: Record<string, unknown> }) => {
        // Honour the role/task the refusal was decided against: the arm asserts them, so a fake
        // that ignored them could not see an arm landing on a row that changed underneath it.
        const where = args.where as { startsTaskWork?: boolean; taskId?: string | null };
        const hit = (where.startsTaskWork === undefined
            || where.startsTaskWork === session.startsTaskWork)
          && (where.taskId === undefined || where.taskId === (session.taskId ?? null));
        return { count: hit ? 1 : 0 };
      },
    },
    $queryRaw: async (query: unknown) => {
      const text = String((query as { text?: string }).text ?? '');
      if (text.includes('FROM "project"') || text.includes('FROM "task" t WHERE')) return [{}];
      if (text.includes('FROM "session" s LEFT JOIN')) {
        return [{
          taskId: session.taskId, startsTaskWork: session.startsTaskWork, projectId: null,
        }];
      }
      return [{
        terminalReason: null,
        supersededByTaskId: null,
        subjectTerminalReason: null,
        subjectSupersededByTaskId: null,
        ...facts,
      }];
    },
  };
  const prisma = {
    ...inner,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(inner),
  } as unknown as ConstructorParameters<typeof SessionsService>[0];
  return new SessionsService(prisma, {} as never, {} as never);
}

const AGGREGATE: TaskFacts = {
  completionPolicy: 'ALL_CHILDREN_DONE',
  completionCriterion: 'HUMAN_SIGNOFF',
  verifiesTaskId: null,
  hasDirectChildren: true,
};
const LEAF: TaskFacts = {
  completionPolicy: 'ALL_CHILDREN_DONE',
  completionCriterion: 'HUMAN_SIGNOFF',
  verifiesTaskId: null,
  hasDirectChildren: false,
};
const COMPLETION_OWNER_REFUSAL = /completed by its declared completion owner/;

function terminalRow(startsTaskWork: boolean): Record<string, unknown> {
  return {
    id: SESSION,
    ownerId: 'owner-1',
    taskId: TASK,
    status: RunStatus.FAILED,
    startsTaskWork,
    assignedRunner: null,
  };
}

test('a terminal WORK session is refused a manual resume once its task aggregates', async () => {
  const service = serviceFor(terminalRow(true), AGGREGATE);
  await assert.rejects(
    () => service.resume('owner-1', SESSION, { content: 'go on' } as never),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a 409, not a raw constraint violation');
      assert.match(String((error as Error).message), COMPLETION_OWNER_REFUSAL);
      return true;
    },
  );
});

/**
 * What `resume` refuses IMMEDIATELY AFTER the aggregate gate, for a row this fixture leaves without
 * a run history. Asserting this exact sentence — rather than swallowing whatever comes out — is
 * what makes "the gate let it through" an observation instead of an absence: the call reached a
 * later, different, identifiable decision, which it could only do by passing the gate first.
 */
const PAST_THE_GATE = /this session never ran and cannot be resumed/;

test('a terminal NON-work session on the same task is NOT refused by the aggregate gate', async () => {
  // The negative control. Nothing about this turn claims to be the task's work, so the role
  // invariant has no opinion — and the refusal it would otherwise get is the exit from a wedge.
  const service = serviceFor(terminalRow(false), AGGREGATE);
  await assert.rejects(
    () => service.resume('owner-1', SESSION, { content: 'what happened here?' } as never),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.doesNotMatch(message, COMPLETION_OWNER_REFUSAL, 'the gate had no opinion');
      assert.match(message, PAST_THE_GATE, 'and the call got past it to the next decision');
      return true;
    },
  );
});

test('arming a retry on a WORK session is refused once its task aggregates', async () => {
  const service = serviceFor(terminalRow(true), AGGREGATE);
  await assert.rejects(
    () => service.armAutoRetry('owner-1', SESSION, new Date(Date.now() + 60_000).toISOString()),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.match(String((error as Error).message), COMPLETION_OWNER_REFUSAL);
      return true;
    },
  );
});

test('arming a retry on a NON-work session is allowed', async () => {
  const service = serviceFor(terminalRow(false), AGGREGATE);
  const at = new Date(Date.now() + 60_000).toISOString();
  const armed = await service.armAutoRetry('owner-1', SESSION, at);
  assert.deepEqual(armed, { retryAt: new Date(at) });
});

test('the compatibility boundary: a childless non-MANUAL task still arms', async () => {
  const service = serviceFor(terminalRow(true), LEAF);
  const at = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await service.armAutoRetry('owner-1', SESSION, at), { retryAt: new Date(at) });
});

test('the compatibility boundary: a childless non-MANUAL task still resumes', async () => {
  // AG4 read forwards — the policy is inert without children, so this is an ordinary leaf and a
  // WORK resume on it must pass the gate exactly as it did before AG6 existed.
  const service = serviceFor(terminalRow(true), LEAF);
  await assert.rejects(
    () => service.resume('owner-1', SESSION, { content: 'again' } as never),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.doesNotMatch(message, COMPLETION_OWNER_REFUSAL);
      assert.match(message, PAST_THE_GATE);
      return true;
    },
  );
});

void Prisma;
