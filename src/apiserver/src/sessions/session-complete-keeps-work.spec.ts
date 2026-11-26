/**
 * The signal a coordinator handing over sends its runner (docs/coordinator-handoff-v2-design.md §1): its Complete's
 * `end` turn carries KEEP_BACKGROUND_WORK_END_CONTENT, which runner-go reads (keepBackgroundWorkRequested) to leave
 * the session's SubAgent runs and bg_run jobs running, and the heartbeat names the same session in
 * `keepWorkSessionIds` (RealtimeService.keepingWork) for a runner that hears of the end there first. Any other
 * Complete's end turn says nothing, and the runner stops them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { currentWorkTerminalizationDouble } from '../test-support/prisma-transaction-double';
import { RealtimeService } from '../realtime/realtime.service';
import { KEEP_BACKGROUND_WORK_END_CONTENT } from './running-work';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';

/** Complete a live session and answer the turns it inserted. */
async function completeAndReadTurns(opts?: { handingOver?: boolean }): Promise<Array<Record<string, unknown>>> {
  const created: Array<Record<string, unknown>> = [];
  const session = {
    id: SESSION_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    assignedRunnerId: RUNNER_ID,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  };
  const currentWork = currentWorkTerminalizationDouble();
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...session, ...data }),
    },
    conversationTurn: {
      ...currentWork.conversationTurn,
      deleteMany: async () => ({ count: 1 }),
      findUnique: async () => null,
      findFirst: async () => ({ seq: 2 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = new Proxy({}, { get: () => () => undefined }) as never;
  const service = new SessionsService(prisma, {} as never, realtime);
  assert.deepEqual(await service.complete(OWNER_ID, SESSION_ID, opts), { ok: true });
  return created;
}

test("a handing-over coordinator's Complete sends an end turn that keeps its background work", async () => {
  const ends = (await completeAndReadTurns({ handingOver: true })).filter((turn) => turn.kind === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].content, KEEP_BACKGROUND_WORK_END_CONTENT);
  // The field runner-go reads, by its JSON name.
  assert.deepEqual(JSON.parse(String(ends[0].content)), { keepBackgroundWork: true });
});

test('any other Complete sends an end turn that says nothing, so the runner stops the work', async () => {
  for (const opts of [undefined, {}, { handingOver: false }]) {
    const ends = (await completeAndReadTurns(opts)).filter((turn) => turn.kind === 'end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].content, undefined, `Complete(${JSON.stringify(opts)}) said something`);
  }
});

test('the heartbeat names, among the sessions it cancels, those whose end turn keeps their work', async () => {
  const asked: Array<Record<string, unknown>> = [];
  const prisma = {
    conversationTurn: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        asked.push(args.where);
        return [{ sessionId: SESSION_ID }];
      },
    },
  };
  const realtime = Object.create(RealtimeService.prototype) as RealtimeService;
  Object.assign(realtime, { prisma });

  assert.deepEqual(await realtime.keepingWork([]), [], 'no cancellation, no read');
  assert.equal(asked.length, 0);
  assert.deepEqual(await realtime.keepingWork([SESSION_ID, RUNNER_ID]), [SESSION_ID]);
  assert.deepEqual(asked, [
    { sessionId: { in: [SESSION_ID, RUNNER_ID] }, kind: 'end', content: KEEP_BACKGROUND_WORK_END_CONTENT },
  ]);
});
