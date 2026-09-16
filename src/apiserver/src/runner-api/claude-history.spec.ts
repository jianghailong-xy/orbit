import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';

/**
 * The one-slot relay behind "this directory already has Claude Code conversations in it".
 *
 * Only the runner can answer the question — `~/.claude/projects` is on its disk and the control
 * plane never sees it — so the question rides a heartbeat and the answer comes back by its own
 * POST. Two things have to hold for that to be safe to render in a form:
 *
 *  - the scan is handed to ONE heartbeat (a compare-and-set), never redelivered, because what is
 *    waiting on it is a person and not a queue; and
 *  - an answer is stored only while the relay still names the path it answers for, because
 *    somebody typing a directory asks about several in a row and an answer about an abandoned one
 *    must never become the verdict on what is in the field now.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const WORK_DIR = '/root/orbit';

function makeController(opts: {
  runner?: Record<string, unknown> | null;
  /** What the CAS / store updateMany answers. */
  updateManyCount?: number;
} = {}) {
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    runner: {
      findUnique: async () =>
        opts.runner === undefined
          ? { claudeHistoryStatus: 'pending', claudeHistoryPath: WORK_DIR, claudeHistoryAt: new Date('2026-09-15T12:00:00Z') }
          : opts.runner,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        return { count: opts.updateManyCount ?? 1 };
      },
    },
  } as never;
  const realtime = { publishSessionUpdated: () => undefined } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return { controller, updateManyCalls };
}

/** The drain is private: it is reached here the way the heartbeat reaches it. */
const drain = (controller: RunnerApiController) =>
  (
    controller as unknown as {
      drainClaudeHistoryRequest: (runnerId: string) => Promise<{ workDir: string; requestedAt?: string } | undefined>;
    }
  ).drainClaudeHistoryRequest(RUNNER_ID);

const result = (
  controller: RunnerApiController,
  body: Record<string, unknown>,
) =>
  (
    controller as unknown as {
      claudeHistoryResult: (
        runner: { id: string },
        body: Record<string, unknown>,
      ) => Promise<{ ok: boolean; applied: boolean }>;
    }
  ).claudeHistoryResult({ id: RUNNER_ID }, body);

test('a pending request is handed to the beat that claims it, and the claim is a compare-and-set', async () => {
  const h = makeController();
  const command = await drain(h.controller);

  assert.deepEqual(command, { workDir: WORK_DIR, requestedAt: '2026-09-15T12:00:00.000Z' });
  assert.equal(h.updateManyCalls.length, 1);
  assert.deepEqual(h.updateManyCalls[0].where, {
    id: RUNNER_ID,
    claudeHistoryStatus: 'pending',
    claudeHistoryPath: WORK_DIR,
  });
  assert.deepEqual(
    h.updateManyCalls[0].data,
    { claudeHistoryStatus: 'scanning' },
    'the row leaves pending as it is handed over, so the next beat does not scan it again',
  );
});

test('a replica that loses the claim sends no command', async () => {
  const h = makeController({ updateManyCount: 0 });
  assert.equal(await drain(h.controller), undefined);
});

test('a runner nobody is asking about is given nothing to do', async () => {
  const idle = makeController({ runner: { claudeHistoryStatus: null, claudeHistoryPath: null, claudeHistoryAt: null } });
  assert.equal(await drain(idle.controller), undefined);
  assert.deepEqual(idle.updateManyCalls, [], 'an idle relay is not written to on every heartbeat');

  // Already handed over: the scan is in flight, and redelivering it would scan the same directory
  // twice for one question.
  const scanning = makeController({
    runner: { claudeHistoryStatus: 'scanning', claudeHistoryPath: WORK_DIR, claudeHistoryAt: new Date() },
  });
  assert.equal(await drain(scanning.controller), undefined);
});

test('the answer is stored only while the relay still names the path it answers for', async () => {
  const h = makeController();
  await result(h.controller, {
    workDir: WORK_DIR,
    windowDays: 30,
    conversations: 11,
    bytes: 4_718_592,
    events: 1348,
    transcripts: [{ claudeSessionId: '4e453ab7-f37c-494d-8017-bb4e9beffeef', title: 'first principles', lastActiveAt: '2026-09-15T03:07:49.000Z', messages: 158 }],
  });

  assert.deepEqual(h.updateManyCalls[0].where, { id: RUNNER_ID, claudeHistoryPath: WORK_DIR });
  assert.equal(h.updateManyCalls[0].data.claudeHistoryStatus, 'done');
});

test('an answer that lands after the field moved on applies to nothing', async () => {
  const h = makeController({ updateManyCount: 0 });
  const answer = await result(h.controller, { workDir: '/root/some-other-project', transcripts: [] });
  assert.deepEqual(answer, { ok: true, applied: false });
});

test('a scan that could not look is recorded as failed, not as an empty directory', async () => {
  const h = makeController();
  await result(h.controller, { workDir: WORK_DIR, windowDays: 30, conversations: 0, transcripts: [], error: 'permission denied' });
  assert.equal(
    h.updateManyCalls[0].data.claudeHistoryStatus,
    'failed',
    '"there is nothing here" and "I could not tell" must not read alike',
  );
});

test('an answer with no directory in it is refused', async () => {
  const h = makeController();
  await assert.rejects(
    result(h.controller, { conversations: 5, transcripts: [] }),
    (err: unknown) => err instanceof BadRequestException,
  );
  assert.deepEqual(h.updateManyCalls, []);
});

test('the body is re-read rather than trusted: it crosses the runner boundary and is rendered', async () => {
  const h = makeController();
  await result(h.controller, {
    workDir: `  ${WORK_DIR}  `,
    windowDays: -3,
    conversations: 'lots',
    bytes: Number.NaN,
    events: 9.7,
    transcripts: [
      { claudeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'x'.repeat(500), lastActiveAt: '2026-09-15T03:07:49.000Z', messages: -5 },
      { title: 'no id at all', lastActiveAt: '2026-09-15T03:07:49.000Z', messages: 3 },
      ...Array.from({ length: 400 }, (_, i) => ({
        claudeSessionId: `bbbbbbbb-bbbb-4bbb-8bbb-${i.toString().padStart(12, '0')}`,
        lastActiveAt: '2026-09-15T03:07:49.000Z',
        messages: 1,
      })),
    ],
  });

  const stored = h.updateManyCalls[0].data.claudeHistoryResult as {
    workDir: string;
    windowDays: number;
    conversations: number;
    bytes: number;
    events: number;
    transcripts: Array<{ claudeSessionId: string; title?: string; messages: number }>;
  };
  assert.equal(stored.workDir, WORK_DIR, 'the path is matched and stored trimmed');
  assert.equal(stored.windowDays, 0, 'a nonsense window becomes unknown rather than a negative promise');
  assert.equal(stored.bytes, 0);
  assert.equal(stored.events, 9);
  assert.equal(stored.transcripts.length, 200, 'one answer carries at most one scan of them');
  assert.equal(stored.transcripts[0].title?.length, 200, 'a title cannot be arbitrarily long');
  assert.equal(stored.transcripts[0].messages, 0);
  assert.ok(
    stored.transcripts.every((t) => !!t.claudeSessionId),
    'an entry with no id could never be imported, so it is not offered',
  );
  assert.equal(
    stored.conversations,
    200,
    'the statistic can never claim fewer conversations than the choices below it offer',
  );
});
