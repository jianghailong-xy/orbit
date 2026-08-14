import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_VERIFICATIONS_PER_TASK, TasksService } from './tasks.service';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

interface Subject {
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  verifyOnDone?: boolean;
  assigned?: boolean;
  priorVerifications?: number;
}

/**
 * Drives the DONE transition on a task and records the verification it files, if any.
 *
 * update() is the single point every DONE flows through — the user PATCH and the agent's
 * task_update alike — so hooking the check there is what makes it unavoidable rather than
 * something a particular caller has to remember.
 */
function makeService(subject: Subject = {}) {
  const created: any[] = [];
  const executed: string[] = [];
  const task = {
    id: TASK_ID,
    title: 'Download the WARCs',
    listId: 'list-1',
    isForeman: subject.isForeman ?? false,
    verifiesTaskId: subject.verifiesTaskId ?? null,
    list: { verifyOnDone: subject.verifyOnDone ?? true },
    assignee: subject.assigned === false ? null : { id: 'workspace-1', runnerId: 'runner-1' },
  };
  const prisma = {
    task: {
      findFirst: async () => ({ ...task, status: 'IN_PROGRESS' }),
      findUnique: async () => ({ ...task, status: 'IN_PROGRESS' }),
      update: async () => ({ ...task, status: 'DONE' }),
      count: async () => subject.priorVerifications ?? 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `verify-${created.length}` };
      },
    },
    taskDependency: { findMany: async () => [] },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser() {},
    publishTaskChanged() {},
  } as never);
  (service as unknown as { execute: unknown }).execute = async (_o: string, id: string) => {
    executed.push(id);
  };
  return {
    created,
    executed,
    fileFor: () =>
      (
        service as unknown as { fileVerification(o: string, t: string): Promise<void> }
      ).fileVerification('owner-1', TASK_ID),
  };
}

test('a task reporting DONE in an opted-in list gets a verification run', async () => {
  const f = makeService();

  await f.fileFor();

  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].verifiesTaskId, TASK_ID);
  assert.equal(f.created[0].listId, 'list-1');
  assert.deepEqual(f.executed, ['verify-1']);
});

test('the brief leads with the evidence question, not the content one', async () => {
  // The case this actually caught here was a task claiming "执行完成并通过验收" whose 18 runs had
  // all failed without executing a turn. "Is there any trace of this happening" is cheap and
  // makes the correctness question moot when the answer is no.
  const f = makeService();

  await f.fileFor();

  const brief: string = f.created[0].description;
  assert.match(brief, /有没有干过的证据/);
  assert.match(brief, /不要采信任务评论里的自述/);
  // It must not quietly do the work itself — that would launder a failure into a success.
  assert.match(brief, /不要替它把活干了/);
});

test('a list that has not opted in files nothing', async () => {
  const f = makeService({ verifyOnDone: false });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

// Everything below is the loop guard. A rejected verification puts the subject back to
// IN_PROGRESS, which lets it run, reach DONE, and be verified again — the same unbounded respawn
// shape that has now bitten this codebase twice, so it is bounded here from the start rather
// than after someone watches it happen.
test('a verification run is never itself verified', async () => {
  const f = makeService({ verifiesTaskId: 'some-other-task' });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a foreman is not verified — its output is a diagnosis, not a unit of work', async () => {
  const f = makeService({ isForeman: true });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a task already checked to the cap is left for a human', async () => {
  const f = makeService({ priorVerifications: MAX_VERIFICATIONS_PER_TASK });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a task one short of the cap is still checked', async () => {
  const f = makeService({ priorVerifications: MAX_VERIFICATIONS_PER_TASK - 1 });

  await f.fileFor();

  assert.equal(f.created.length, 1);
});

test('a task with no runnable assignee files nothing', async () => {
  // Filing a check nothing can run would leave an OPEN task that looks like pending work forever.
  const f = makeService({ assigned: false });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('the verification does not auto-run — the DONE dispatched it, not a prerequisite', async () => {
  const f = makeService();

  await f.fileFor();

  assert.equal(f.created[0].autoRunWhenReady, false);
});
