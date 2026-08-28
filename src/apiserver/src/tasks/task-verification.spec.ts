import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { MAX_VERIFICATIONS_PER_TASK, TasksService } from './tasks.service';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
/** What that task is called everywhere the verifier can see it, `task_get` included. */
const TASK_PUBLIC_ID = uuidToBase62(TASK_ID);

interface Subject {
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  verifyOnDone?: boolean;
  assigned?: boolean;
  /** The assignee workspace has been soft-deleted; sessions.create refuses to run in it. */
  assigneeDeleted?: boolean;
  priorVerifications?: number;
  /** Verifications already filed that were cancelled before issuing a verdict. */
  cancelledVerifications?: number;
  /** Verifications filed and still running — no verdict yet, but not abandoned either. */
  inFlightVerifications?: number;
  executeFails?: boolean;
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
  const published: unknown[][] = [];
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
      // Modelled as real rows with statuses and filtered like Prisma would, so which statuses the
      // cap counts is the contract under test rather than an arithmetic the stub decides.
      count: async ({ where }: { where: Record<string, any> }) => {
        const rows = [
          ...Array.from({ length: subject.priorVerifications ?? 0 }, () => 'DONE'),
          ...Array.from({ length: subject.inFlightVerifications ?? 0 }, () => 'OPEN'),
          ...Array.from({ length: subject.cancelledVerifications ?? 0 }, () => 'CANCELLED'),
        ];
        return rows.filter((st) => {
          if (where?.status?.not !== undefined) return st !== where.status.not;
          if (typeof where?.status === 'string') return st === where.status;
          return true;
        }).length;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `verify-${created.length}` };
      },
    },
    taskDependency: { findMany: async () => [] },
    // The filed check's dispatch epoch (0137). A row this method has just created is at the epoch
    // its seed trigger gave it, and reading it is what makes the token below a fact taken from the
    // database rather than a constant this code assumed.
    $queryRaw: async () => [{ epoch: 0n }],
    // Honours the caller's filter rather than returning a fixed number: which question the
    // dispatcher asks of the session table is the contract under test.
    session: {
      count: async ({ where }: { where: Record<string, any> }) => {
        const all = subject.sessions ?? [{ status: 'RUNNING', numTurns: 7 }];
        // `OR` is honoured too, or the evidence question below reads as "no filter at all" and
        // every test passes whatever the dispatcher asks.
        const matches = (s: { status: string; numTurns: number }, w: Record<string, any>): boolean => {
          if (Array.isArray(w.OR)) return w.OR.some((clause: Record<string, any>) => matches(s, clause));
          if (w.numTurns?.gt !== undefined && !(s.numTurns > w.numTurns.gt)) return false;
          if (w.status !== undefined && s.status !== w.status) return false;
          return true;
        };
        return all.filter((s) => matches(s, where)).length;
      },
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
    publishTaskChanged() {},
  } as never);
  const tokens: string[] = [];
  (service as unknown as { execute: unknown }).execute = async (
    _o: string, id: string, _auto: unknown, token: string,
  ) => {
    if (subject.executeFails) throw new Error('dispatch failed');
    executed.push(id);
    tokens.push(token);
  };
  return {
    created,
    executed,
    tokens,
    published,
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
  assert.equal(f.created[0].completionCriterion, 'VERIFICATION');
  assert.equal(f.created[0].completionPolicy, 'MANUAL');
  assert.equal(f.created[0].completionCriterionOverrideReason, null);
  assert.equal(f.created[0].listId, 'list-1');
  assert.deepEqual(f.executed, ['verify-1']);
  assert.deepEqual(f.published, [[
    'owner-1',
    'task_changed',
    { taskIds: ['verify-1'], resync: false },
  ]]);
  // The one run this check exists for, named `<kind>:<task>:<epoch>` like every other automatic
  // request. Task-scoped, so two checks filed for two subjects are two requests rather than one
  // answered with the other's Session; and stamped with the moment the row was filed at, so a
  // redelivery is the same request and a later moment on the same row would not be.
  assert.deepEqual(f.tokens, ['first-run:verify-1:0']);
});

test('a filed verification is announced even when its first dispatch fails', async () => {
  const f = makeService({ executeFails: true });

  await assert.rejects(() => f.fileFor(), /dispatch failed/);

  assert.equal(f.created.length, 1);
  assert.deepEqual(f.published, [[
    'owner-1',
    'task_changed',
    { taskIds: ['verify-1'], resync: false },
  ]]);
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

test('the id the brief carries is the public one, not the uuid the column holds', async () => {
  // Prose is the boundary PublicIdInterceptor does not cover: it rewrites response fields, and
  // this id lives in a task description. Left as a uuid it is the one id in the whole run spelled
  // differently from every other — `task_get` answers base62 — and the verifier has to hand it
  // back to `task_comment` and `task_update` to land its verdict on the subject rather than on
  // itself, which is the one distinction this brief spends its last paragraph on.
  const f = makeService();

  await f.fileFor();

  const brief: string = f.created[0].description;
  assert.ok(brief.includes(TASK_PUBLIC_ID), brief);
  assert.equal(brief.includes(TASK_ID), false, 'the raw uuid reached the verifier');
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

test('a cancelled check does not spend the task\'s verification budget', async () => {
  // It issued no verdict, so it rejected nothing and is not part of the loop the cap bounds.
  // Six course tasks had two cancelled checks each and could not be re-verified at all.
  const f = makeService({
    verifyOnDone: true,
    priorVerifications: 0,
    cancelledVerifications: MAX_VERIFICATIONS_PER_TASK,
  });

  await f.fileFor();

  assert.equal(f.created.length, 1);
});

test('checks that did issue a verdict still spend it', async () => {
  const f = makeService({
    verifyOnDone: true,
    priorVerifications: MAX_VERIFICATIONS_PER_TASK,
    cancelledVerifications: 0,
  });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a check still in flight counts, so a second is not filed alongside it', async () => {
  // The cap is also the concurrency guard: two verifiers judging the same subject at once could
  // reach opposite verdicts and race each other writing the subject's status.
  const f = makeService({
    verifyOnDone: true,
    priorVerifications: 0,
    inFlightVerifications: MAX_VERIFICATIONS_PER_TASK,
  });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});


/**
 * A task is almost always marked DONE by the agent from inside the turn doing the work, and
 * `numTurns` only increments when that turn *ends* — so the run providing the evidence still reads
 * zero at the moment the check runs.
 *
 * Missing that, the unevidenced branch fired on every task that finishes in its first turn and
 * dispatched a verification regardless of the opt-in: all 22 verifications this deployment had
 * filed were for lists with verifyOnDone off, 10 of them having already spent a run. The flag
 * exists precisely to stop a list's runs doubling, and it had never once been honoured.
 */
test('a run still in flight is evidence, so a self-completing task is not re-verified', async () => {
  const f = makeService({ verifyOnDone: false, sessions: [{ status: 'RUNNING', numTurns: 0 }] });

  await f.fileFor();

  assert.deepEqual(f.created, []);
});

test('a completion with no run behind it is still checked, opt-in or not', async () => {
  // The case the branch exists for: sessions that exist and never executed anything.
  const f = makeService({
    verifyOnDone: false,
    sessions: [
      { status: 'FAILED', numTurns: 0 },
      { status: 'CANCELLED', numTurns: 0 },
    ],
  });

  await f.fileFor();

  assert.equal(f.created.length, 1);
});
