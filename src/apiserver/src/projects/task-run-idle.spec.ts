import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wakeIdempotencyKey, type WakeFact } from './coordinator-wake';
import { describeWakeFact } from './coordinator-judgment-opening';
import { isTaskRunIdle, TASK_RUN_IDLE_THRESHOLD_MS } from './task-run-idle';
import { TaskRunIdleService } from './task-run-idle.service';

const MIN = 60_000;
const SESSION = '01a19ef3-88ce-7789-a094-0f2cca249425';
const TASK = '01a19ef3-88ce-7789-a094-0f2cca249427';
const TURN_END = new Date('2026-11-12T00:53:00Z');
const at = (minutes: number) => new Date(TURN_END.getTime() + minutes * MIN);

interface Rig { progressAt: Date | null; evidence: { submittedAt: Date; decided: boolean } | null }

/** A one-run database: what `findIdleRuns` selects, filtered on the same `lastTurnAt` cutoff the query states. */
function build(rig: Rig) {
  const ledger = new Set<string>();
  const queued: WakeFact[] = [];
  const prisma = {
    session: {
      findMany: async (args: { where: { lastTurnAt: { lt: Date } } }) => TURN_END < args.where.lastTurnAt.lt ? [{
        id: SESSION, status: 'AWAITING_INPUT', endReason: null, completedAt: null, archivedAt: null, deletedAt: null,
        lastTurnAt: TURN_END, lastAssistantText: 'queued behind the heavy lock',
        task: {
          id: TASK, title: 'D2', projectId: '01a19ef3-88ce-7789-a094-0f2cca249426',
          progress: { phase: 'build', current: 5, total: 6, message: 'tests running', lastProgressAt: rig.progressAt },
          completionEvidence: rig.evidence
            ? [{ submittedAt: rig.evidence.submittedAt, decisions: rig.evidence.decided ? [{ id: 'd' }] : [] }] : [],
        },
      }] : [],
    },
    $queryRaw: async () => [],
    projectCoordinatorWake: {
      findFirst: async (args: { where: { idempotencyKey: string } }) => ledger.has(args.where.idempotencyKey) ? { id: 'w' } : null,
    },
  };
  const deliveries = { queue: async (fact: WakeFact) => { ledger.add(wakeIdempotencyKey(fact)); queued.push(fact); } };
  const service = new TaskRunIdleService(prisma as never, { authorize: async () => ({ allowed: true }) } as never, deliveries as never);
  return { prisma, service, queued };
}

test('the threshold is the agreed 30 minutes', () => {
  assert.equal(TASK_RUN_IDLE_THRESHOLD_MS, 30 * MIN);
});

test('an idle run past the threshold gives exactly one notice, naming the task, its last progress and the session', async () => {
  const { service, queued, prisma } = build({ progressAt: null, evidence: null });
  assert.equal(await service.tick(at(30)), 0, 'exactly at the threshold is not past it');
  assert.equal(await service.tick(at(31)), 1);
  assert.equal(await service.tick(at(32)), 0);
  assert.equal(await service.tick(at(600)), 0);
  assert.equal(queued.length, 1);
  const [fact] = queued;
  assert.equal(fact.subjectId, TASK);
  assert.equal(fact.detail?.sessionId, SESSION);
  assert.equal(fact.detail?.lastProgress, 'build · 5/6 · tests running');
  const text = describeWakeFact(fact);
  assert.match(text, /D2/);
  assert.match(text, /build · 5\/6 · tests running/);
  // The reusable check answers the same question for another caller.
  assert.equal(await isTaskRunIdle(prisma as never, TASK, at(31)), true);
  assert.equal(await isTaskRunIdle(prisma as never, TASK, at(10)), false);
});

test('a run that reported progress inside the window gives no notice until it has been quiet past the threshold again', async () => {
  const { service, queued } = build({ progressAt: at(20), evidence: null });
  assert.equal(await service.tick(at(31)), 0);
  assert.equal(await service.tick(at(50)), 0);
  assert.equal(await service.tick(at(51)), 1);
  assert.equal(await service.tick(at(52)), 0);
  assert.equal(queued.length, 1);
});

test('a run that submitted evidence gives no notice: undecided evidence is the evidence queue\'s, decided evidence restarts the clock', async () => {
  const waiting = build({ progressAt: null, evidence: { submittedAt: at(20), decided: false } });
  assert.equal(await waiting.service.tick(at(600)), 0);
  const sentBack = build({ progressAt: null, evidence: { submittedAt: at(20), decided: true } });
  assert.equal(await sentBack.service.tick(at(31)), 0);
  assert.equal(await sentBack.service.tick(at(51)), 1);
});
