import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CHECK_ENDED_WITHOUT_VERDICT, settleChecksOfEndedRun } from './criterion-check-ended';
import type { CriterionConfirmationFacts } from './project-criterion-confirmation';
import {
  CRITERION_CHECK_NOT_FOUND,
  CRITERION_CHECK_REPORT_TOOL,
  ProjectCriterionConfirmationService,
} from './project-criterion-confirmation.service';
import { criterionSatisfaction } from './project-criterion-satisfaction';

/**
 * An Agent check whose run ended without calling criterion_check_report (criterion-check-ended.ts).
 * Its PENDING row is settled by the end itself, as a failed attempt naming the end: the criterion
 * reads CHECK_FAILED and unmet rather than "Checking…", and another check can be started. A row a
 * report already settled is left exactly as it is.
 */

const OWNER = 'owner-1';
const PROJECT = 'project-1';
const T0 = new Date('2026-11-12T10:00:00Z');

type Row = CriterionConfirmationFacts & {
  ownerId: string; projectId: string; definitionId: string; withdrawnByKind: string | null;
};

/** `where` as the delegates below are asked it: equality, `{ in: [...] }`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'in' in value) {
      return (value as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === value;
  });
}

/** One in-memory database serving both the service's doors and the ending transaction. */
function world() {
  const definition = {
    id: 'crit', projectId: PROJECT, ordinal: 5, text: 'ICP filing approved',
    verificationMethod: 'Read the filing record', revision: 1, satisfiedBy: 'CONFIRMATION',
  };
  const confirmations: Row[] = [];
  // Session → its task, as the runs the doors end would name them.
  const sessions = new Map<string, { taskId: string | null }>();
  /** Wake sources of a parked run: an ACTIVE watch is enough to say it goes on. */
  const watchedSessions = new Set<string>();
  let clock = 0;
  let tasksFiled = 0;
  const tick = () => new Date(T0.getTime() + (clock += 1) * 60_000);
  const delegate = {
    create: async ({ data }: any) => {
      const created: Row = {
        id: `conf-${confirmations.length + 1}`, sessionId: null, checkTaskId: null, note: null,
        attachmentIds: [], createdAt: tick(), settledAt: null, withdrawnAt: null, withdrawnByKind: null,
        ...data,
      };
      confirmations.push(created);
      return created;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of confirmations) {
        if (!matches(r as never, where)) continue;
        Object.assign(r, data, data.settledAt ? { settledAt: tick() } : {});
        count += 1;
      }
      return { count };
    },
    updateManyAndReturn: async ({ where, data }: any) => {
      const settled = confirmations.filter((r) => matches(r as never, where));
      for (const r of settled) Object.assign(r, data, { settledAt: tick() });
      return settled.map((r) => ({ ownerId: r.ownerId, projectId: r.projectId }));
    },
    findFirst: async ({ where }: any) => [...confirmations].reverse().find((r) => matches(r as never, where)) ?? null,
    findMany: async ({ where }: any) => confirmations.filter((r) => matches(r as never, where)).map((r) => ({ id: r.id })),
  };
  const prisma = {
    projectAcceptanceCriterionDefinition: {
      findFirst: async () => ({ ...definition, project: { title: 'CBAI', coordinatorSessionId: 'coord' } }),
      findFirstOrThrow: async () => ({
        revision: definition.revision,
        confirmations: confirmations.filter((r) => r.withdrawnAt === null),
      }),
    },
    projectCriterionConfirmation: delegate,
    session: { findFirst: async ({ where }: any) => sessions.get(where.id) ?? null },
    projectMember: { findFirst: async () => ({ agentId: 'coord-workspace' }) },
    attachment: { count: async () => 0 },
    // hasPendingWakeSource's reads.
    watch: { findFirst: async ({ where }: any) => (watchedSessions.has(where.observerSessionId) ? { id: 'w' } : null) },
    sessionScheduledWakeup: { findFirst: async () => null },
    sessionRequest: { findMany: async () => [], findFirst: async () => null },
    projectOpenItem: { findFirst: async () => null },
  };
  const tasks = {
    create: async () => ({ id: `check-task-${(tasksFiled += 1)}` }),
    // Each check task's run is a session of its own.
    execute: async (_owner: string, taskId: string) => {
      const sessionId = `run-of-${taskId}`;
      sessions.set(sessionId, { taskId });
      return { sessionId };
    },
  };
  const service = new (class extends ProjectCriterionConfirmationService {
    protected override async reproject() {}
  })(prisma as never, tasks as never);
  const tx = prisma as never;
  async function start() {
    const started = await service.startCheck(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {});
    return { ...started, sessionId: `run-of-${started.checkTaskId}` };
  }
  function standing() {
    const [answer] = criterionSatisfaction([{
      id: 'crit', ordinal: 5, revision: definition.revision, servingTasks: [],
      satisfiedBy: 'CONFIRMATION', confirmations: confirmations.filter((r) => r.withdrawnAt === null),
    }]);
    return answer;
  }
  return { service, confirmations, sessions, watchedSessions, tx, start, standing };
}

/** Each way a run ends, spelled as the door that ends it calls the settlement. */
const ENDS: Array<{ name: string; ending: string; parked?: boolean }> = [
  {
    name: 'its turn ended without reporting (runnerApi.turnComplete, parked idle)',
    ending: `its run stopped without calling ${CRITERION_CHECK_REPORT_TOOL}`,
    parked: true,
  },
  { name: 'its turn failed (runnerApi.turnComplete)', ending: 'its run failed: API Error: 500 overloaded' },
  {
    name: 'the runner finalized it FAILED (runnerApi.finalize)',
    ending: 'the runner finalized its run as FAILED (engine exited 1)',
  },
  { name: 'it was cancelled (SessionsService.transitionEnd)', ending: 'its run was ended (cancelled)' },
  { name: 'its runner was lost (reaper.forceFinalize)', ending: 'its run was reaped as FAILED (runner offline)' },
];

for (const end of ENDS) {
  test(`a check whose run ended without a verdict is a failed attempt: ${end.name}`, async () => {
    const { confirmations, tx, start, standing } = world();
    const first = await start();
    assert.equal(first.confirmation.checkRunning?.checkTaskId, first.checkTaskId, 'Checking… before the end');

    const settled = await settleChecksOfEndedRun(
      tx,
      { sessionId: first.sessionId, taskId: first.checkTaskId },
      end.ending,
      end.parked ? { runningBgJobs: [], retryAt: null } : undefined,
    );
    assert.deepEqual(settled, [{ ownerId: OWNER, projectId: PROJECT }]);
    const [attempt] = confirmations;
    assert.equal(attempt.outcome, 'FAILED');
    assert.equal(attempt.sessionId, first.sessionId);
    assert.ok(attempt.settledAt, 'settled, with the time of the end');
    assert.equal(attempt.note, `${CHECK_ENDED_WITHOUT_VERDICT}: ${end.ending}.`, 'the note names why');

    const after = standing();
    assert.equal(after.satisfied, false);
    assert.equal(after.confirmation?.state, 'CHECK_FAILED');
    assert.equal(after.confirmation?.current?.id, attempt.id);
    assert.equal(after.confirmation?.checkRunning, null, 'no longer Checking…');

    // The criterion is free for another check, which runs and can be reported.
    const second = await start();
    assert.notEqual(second.checkTaskId, first.checkTaskId);
    assert.equal(second.confirmation.checkRunning?.checkTaskId, second.checkTaskId);
    assert.equal(second.confirmation.state, 'CHECK_FAILED', 'unmet until the new check says otherwise');
  });
}

test('the ended check\'s late report finds nothing waiting; a new check reports as usual', async () => {
  const { service, tx, start, standing } = world();
  const first = await start();
  await settleChecksOfEndedRun(tx, { sessionId: first.sessionId, taskId: first.checkTaskId }, 'its run was ended (cancelled)');
  await assert.rejects(service.reportCheck(OWNER, first.sessionId, { verdict: 'PASS' }),
    (error: any) => error.getResponse?.().code === CRITERION_CHECK_NOT_FOUND);
  const second = await start();
  const reported = await service.reportCheck(OWNER, second.sessionId, { verdict: 'PASS', note: 'record matches' });
  assert.equal(reported.confirmation.state, 'CONFIRMED');
  assert.equal(standing().satisfied, true);
});

test('a reported PASS or FAIL is untouched by the end that follows it', async () => {
  for (const verdict of ['PASS', 'FAIL'] as const) {
    const { service, confirmations, tx, start, standing } = world();
    const check = await start();
    await service.reportCheck(OWNER, check.sessionId, { verdict, note: 'what I found' });
    const before = { ...confirmations[0] };
    for (const end of ENDS) {
      const settled = await settleChecksOfEndedRun(
        tx,
        { sessionId: check.sessionId, taskId: check.checkTaskId },
        end.ending,
        end.parked ? { runningBgJobs: [], retryAt: null } : undefined,
      );
      assert.deepEqual(settled, [], `${verdict} after ${end.name}`);
    }
    assert.deepEqual(confirmations[0], before);
    assert.equal(confirmations[0].note, 'what I found');
    assert.equal(standing().confirmation?.state, verdict === 'PASS' ? 'CONFIRMED' : 'CHECK_FAILED');
    assert.equal(standing().satisfied, verdict === 'PASS');
  }
});

test('a parked run something will still wake has not ended: its check keeps running', async () => {
  const { confirmations, watchedSessions, tx, start, standing } = world();
  const check = await start();
  const run = { sessionId: check.sessionId, taskId: check.checkTaskId };
  const ending = `its run stopped without calling ${CRITERION_CHECK_REPORT_TOOL}`;
  // A background job it started, an armed retry, a watch it waits on: each wakes it again.
  assert.deepEqual(await settleChecksOfEndedRun(tx, run, ending, { runningBgJobs: ['bgj_1'], retryAt: null }), []);
  assert.deepEqual(await settleChecksOfEndedRun(tx, run, ending, { runningBgJobs: [], retryAt: new Date() }), []);
  watchedSessions.add(check.sessionId);
  assert.deepEqual(await settleChecksOfEndedRun(tx, run, ending, { runningBgJobs: [], retryAt: null }), []);
  assert.equal(confirmations[0].outcome, 'PENDING');
  assert.equal(standing().confirmation?.checkRunning?.id, confirmations[0].id);
  // Once nothing will, it has.
  watchedSessions.delete(check.sessionId);
  assert.equal((await settleChecksOfEndedRun(tx, run, ending, { runningBgJobs: [], retryAt: null })).length, 1);
  assert.equal(confirmations[0].outcome, 'FAILED');
});

test('only the ended run\'s own check is settled; a run of no task settles nothing', async () => {
  const { confirmations, tx, start } = world();
  const mine = await start();
  const theirs = await start();
  assert.deepEqual(await settleChecksOfEndedRun(tx, { sessionId: 'a-chat', taskId: null }, 'its run was ended (ended)'), []);
  await settleChecksOfEndedRun(tx, { sessionId: mine.sessionId, taskId: mine.checkTaskId }, 'its run was ended (ended)');
  assert.deepEqual(confirmations.map((r) => [r.checkTaskId, r.outcome]), [
    [mine.checkTaskId, 'FAILED'],
    [theirs.checkTaskId, 'PENDING'],
  ]);
});

test('every door that ends a run settles its check in the ending transaction, and not with a retry armed', () => {
  const read = (path: string) => readFileSync(join(__dirname, '..', '..', 'src', path), 'utf8');
  /** The body of one method: from its signature to the next method at the same indent. */
  const method = (source: string, signature: string) => {
    const from = source.indexOf(signature);
    assert.ok(from >= 0, signature);
    const rest = source.slice(from + signature.length);
    const next = rest.search(/\n {2}(?:(?:private|protected|public) )?(?:async )?[a-zA-Z]+\(/);
    return rest.slice(0, next < 0 ? undefined : next);
  };
  const runnerApi = read('runner-api/runner-api.controller.ts');
  const turnComplete = method(runnerApi, '  async turnComplete(');
  assert.match(turnComplete, /retryPending \? \[\] : await settleChecksOfEndedRun\(/);
  assert.match(turnComplete, /nextStatus === RunStatus\.AWAITING_INPUT\s*\? await settleChecksOfEndedRun\(/);
  assert.match(turnComplete, /reprojectAfterSettledChecks\(/);
  const finalize = method(runnerApi, '  async finalize(');
  assert.match(finalize, /retryAt != null \? \[\] : await settleChecksOfEndedRun\(/);
  assert.match(finalize, /reprojectAfterSettledChecks\(/);
  const reaper = method(read('realtime/reaper.service.ts'), '  private async forceFinalize(');
  assert.match(reaper, /retryAt != null \? \[\] : await settleChecksOfEndedRun\(/);
  assert.match(reaper, /reprojectAfterSettledChecks\(/);
  const sessions = read('sessions/sessions.service.ts');
  assert.match(method(sessions, '  private async transitionEndLocked('), /await settleChecksOfEndedRun\(\s*tx,/);
  assert.match(method(sessions, '  private async transitionEnd('), /reprojectAfterSettledChecks\(/);
  // Every one of them inside the transaction it ends the run in: through `tx`, never `this.prisma`.
  for (const body of [turnComplete, finalize, reaper]) {
    assert.doesNotMatch(body, /settleChecksOfEndedRun\(\s*this\.prisma/);
  }
});
