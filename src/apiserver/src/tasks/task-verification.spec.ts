import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_VERIFICATIONS_PER_TASK, TasksService } from './tasks.service';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

interface Subject {
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  verifyOnDone?: boolean;
  assigned?: boolean;
  /** The assignee workspace has been soft-deleted; sessions.create refuses to run in it. */
  assigneeDeleted?: boolean;
  priorVerifications?: number;
  /**
   * The subject's sessions. Defaults to the shape a normal completion actually has at the moment
   * DONE is written: the agent's own session is still RUNNING — success is not recorded until
   * after — but its turns already are. A stub that skipped this could not tell `numTurns > 0`
   * from `status = SUCCEEDED`, and the latter would call all 613 evidenced completions
   * unevidenced.
   */
  sessions?: Array<{ status: string; numTurns: number }>;
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
    assignee:
      subject.assigned === false
        ? null
        : {
            id: 'workspace-1',
            runnerId: 'runner-1',
            deletedAt: subject.assigneeDeleted ? new Date() : null,
          },
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
    // Honours the caller's filter rather than returning a fixed number: which question the
    // dispatcher asks of the session table is the contract under test.
    session: {
      count: async ({ where }: { where: Record<string, any> }) => {
        const all = subject.sessions ?? [{ status: 'RUNNING', numTurns: 7 }];
        return all.filter((s) => {
          if (where.numTurns?.gt !== undefined && !(s.numTurns > where.numTurns.gt)) return false;
          if (where.status !== undefined && s.status !== where.status) return false;
          return true;
        }).length;
      },
    },
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
  // The rule, not the sentence that happened to carry it: a self-report is not evidence.
  assert.match(brief, /自述一律不可采信/);
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

// The opt-in governs checking work that demonstrably happened, which is the expensive case. A
// completion with nothing behind it is neither expensive nor ambiguous, and requiring opt-in for
// it would mean the one case nobody would decline is the one that has to be asked for.
test('a completion with no executed run is verified even without the opt-in', async () => {
  const f = makeService({ verifyOnDone: false, sessions: [] });

  await f.fileFor();

  assert.equal(f.created.length, 1);
});

test('that verifier is told up front that nothing ran', async () => {
  const f = makeService({ verifyOnDone: false, sessions: [] });

  await f.fileFor();

  // Handing it the system's own finding keeps it from re-deriving it.
  assert.match(f.created[0].description, /没有任何一次运行执行过哪怕一个 turn/);
});

test('a missing run record raises the bar rather than ending the inquiry', async () => {
  // The first real verdict this produced rejected a task whose comment carried a byte count and a
  // SHA-256, having declined to check either — because the brief said an evidence gap "is enough
  // to fail, no need to look at the content". The verifier followed that exactly. Establishing
  // the truth was one `sha256sum` away, on the machine it was already running on.
  const f = makeService({ verifyOnDone: false, sessions: [] });

  await f.fileFor();

  const brief: string = f.created[0].description;
  assert.match(brief, /不是结论/);
  assert.match(brief, /必须亲自去验/);
  assert.match(brief, /不要因为第 1 步存疑就跳过/);
  // The self-report still cannot be taken at face value — that part was right.
  assert.match(brief, /自述一律不可采信/);
});

test('an evidenced completion still needs the opt-in', async () => {
  // Otherwise every DONE in the deployment files a run — 613 of 621 have execution behind them.
  const f = makeService({ verifyOnDone: false, sessions: [{ status: 'SUCCEEDED', numTurns: 4 }] });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('an evidenced completion in an opted-in list is verified without that warning', async () => {
  const f = makeService({ verifyOnDone: true, sessions: [{ status: 'SUCCEEDED', numTurns: 4 }] });

  await f.fileFor();

  assert.equal(f.created.length, 1);
  assert.ok(!f.created[0].description.includes('没有任何一次运行'), f.created[0].description);
});

test('the cap still applies to an unevidenced completion', async () => {
  // Bypassing the opt-in must not also bypass the loop guard.
  const f = makeService({
    verifyOnDone: false,
    sessions: [],
    priorVerifications: MAX_VERIFICATIONS_PER_TASK,
  });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('evidence is turns executed, not a session that already succeeded', async () => {
  // The discriminating case, and the normal one: an agent writes DONE from inside its own run, so
  // that run is RUNNING and has turns but is not yet SUCCEEDED. Keying on success would call
  // every ordinary completion unevidenced and file a verification for all of them.
  const f = makeService({
    verifyOnDone: false,
    sessions: [{ status: 'RUNNING', numTurns: 7 }],
  });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a soft-deleted assignee files nothing', async () => {
  // sessions.create refuses a deleted workspace, so the verification would sit OPEN forever and
  // read as pending work. Six were filed this way against a workspace deleted in August, and
  // `runnerId` alone did not notice — the row keeps its binding after the delete.
  const f = makeService({ verifyOnDone: true, assigneeDeleted: true });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});
