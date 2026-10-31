import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { DIR_PROBE_MAX_PATH, dirProbeAnswerOf, readDirProbeResult } from '../runners/dir-probe';
import { RunnerApiController } from './runner-api.controller';

/**
 * The directory probe relay's runner half (docs/first-workspace-contract.md §2.3, §2.4) and its read (§2.2): "what is
 * at this path on this machine?", asked while the folder for a machine's first workspace is being chosen.
 *
 * Only the runner can look, so the question rides a heartbeat and the answer comes back by its own POST, the way the
 * Claude history relay's does. What has to hold for that to be safe to show in a folder picker:
 *
 *  - the question is handed to ONE heartbeat (a compare-and-set from pending to probing), never redelivered;
 *  - an answer is stored only while the relay still names the path it answers, and read back only for that path, so
 *    an answer about a path the person has since retyped never becomes the verdict on the one in the field now.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const ASKED = '~/code/app';
const RESOLVED = '/home/orbit/code/app';

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
          ? { dirProbeStatus: 'pending', dirProbePath: ASKED, dirProbeAt: new Date('2026-10-31T08:00:00Z') }
          : opts.runner,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        return { count: opts.updateManyCount ?? 1 };
      },
    },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    { publishSessionUpdated: () => undefined } as never,
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
      drainDirProbeRequest: (runnerId: string) => Promise<{ path: string; requestedAt?: string } | undefined>;
    }
  ).drainDirProbeRequest(RUNNER_ID);

const answer = (controller: RunnerApiController, body: unknown) =>
  (
    controller as unknown as {
      dirProbeResult: (runner: { id: string }, body: unknown) => Promise<{ ok: boolean; applied: boolean }>;
    }
  ).dirProbeResult({ id: RUNNER_ID }, body);

const PROBE = {
  path: RESOLVED, exists: true, isDir: true, isGit: true, branch: 'main', isHome: false, freeBytes: 52_000_000_000,
};

test('a pending question is handed to the beat that claims it, pending to probing, by a compare-and-set', async () => {
  const h = makeController();
  assert.deepEqual(await drain(h.controller), { path: ASKED, requestedAt: '2026-10-31T08:00:00.000Z' });
  assert.equal(h.updateManyCalls.length, 1);
  assert.deepEqual(h.updateManyCalls[0].where, { id: RUNNER_ID, dirProbeStatus: 'pending', dirProbePath: ASKED });
  assert.deepEqual(h.updateManyCalls[0].data, { dirProbeStatus: 'probing' }, 'it leaves pending as it is handed over');
});

test('a replica that loses the claim sends nothing', async () => {
  const h = makeController({ updateManyCount: 0 });
  assert.equal(await drain(h.controller), undefined);
});

test('nothing is handed out when nobody is asking, or the question was already handed over', async () => {
  const idle = makeController({ runner: { dirProbeStatus: null, dirProbePath: null, dirProbeAt: null } });
  assert.equal(await drain(idle.controller), undefined);
  assert.deepEqual(idle.updateManyCalls, [], 'an idle relay is not written to on every heartbeat');
  for (const status of ['probing', 'done']) {
    const h = makeController({ runner: { dirProbeStatus: status, dirProbePath: ASKED, dirProbeAt: new Date() } });
    assert.equal(await drain(h.controller), undefined, `${status}: handed out once, never again`);
    assert.deepEqual(h.updateManyCalls, []);
  }
});

test('the answer is stored, and the slot done, only while the relay still names the path it answers', async () => {
  const h = makeController();
  assert.deepEqual(await answer(h.controller, { path: ASKED, result: PROBE }), { ok: true, applied: true });
  assert.deepEqual(h.updateManyCalls[0].where, { id: RUNNER_ID, dirProbePath: ASKED });
  assert.deepEqual(h.updateManyCalls[0].data, { dirProbeStatus: 'done', dirProbeResult: { path: ASKED, result: PROBE } });

  const late = makeController({ updateManyCount: 0 });
  assert.deepEqual(await answer(late.controller, { path: '~/code/old', result: PROBE }), { ok: true, applied: false },
    'an answer about a path the person moved on from applies to nothing');
});

test('a probe that could not look is done all the same, with why', async () => {
  const h = makeController();
  await answer(h.controller, { path: ASKED, result: { ...PROBE, exists: false, isDir: false, isGit: false, branch: null, error: 'permission denied' } });
  const stored = h.updateManyCalls[0].data as { dirProbeStatus: string; dirProbeResult: { result: { error?: string } } };
  assert.equal(stored.dirProbeStatus, 'done');
  assert.equal(stored.dirProbeResult.result.error, 'permission denied');
});

test('an answer with no path, or no result, is refused and writes nothing', async () => {
  for (const body of [{ result: PROBE }, { path: '  ', result: PROBE }, { path: ASKED }, { path: ASKED, result: [] }, null]) {
    const h = makeController();
    await assert.rejects(answer(h.controller, body), (err: unknown) => err instanceof BadRequestException, JSON.stringify(body));
    assert.deepEqual(h.updateManyCalls, []);
  }
});

test('the body is re-read rather than trusted: it crosses the runner boundary and a client renders it', () => {
  const read = readDirProbeResult({
    path: `  ${ASKED}  `,
    result: {
      path: ` ${RESOLVED} `, exists: 'yes', isDir: 1, isGit: true, branch: 'b'.repeat(400), isHome: null,
      freeBytes: -1, error: '   ', extra: 'dropped',
    },
  });
  assert.deepEqual(read, {
    path: ASKED,
    result: {
      path: RESOLVED, exists: false, isDir: false, isGit: true, branch: 'b'.repeat(255), isHome: false, freeBytes: null,
    },
  });
  assert.equal(readDirProbeResult({ path: ASKED, result: { freeBytes: Number.NaN } })?.result.freeBytes, null,
    'unknown, never zero: a client would read zero as a full disk');
  assert.equal(readDirProbeResult({ path: ASKED, result: { freeBytes: 12.9 } })?.result.freeBytes, 12);
  assert.equal(readDirProbeResult({ path: ASKED, result: {} })?.result.path, ASKED, 'a runner that names no path answers for the one asked');
  assert.equal(readDirProbeResult({ path: '/'.repeat(DIR_PROBE_MAX_PATH + 1), result: {} }), null);
});

test('the read answers only the path it is asked about, and never with an answer about another', () => {
  const stored = { path: ASKED, result: PROBE };
  // Asked and answered.
  assert.deepEqual(dirProbeAnswerOf({ dirProbeStatus: 'done', dirProbePath: ASKED, dirProbeResult: stored }, ASKED),
    { path: ASKED, status: 'done', result: PROBE });
  // The picker moved on to another path: the slot names it, and the old answer is not its answer.
  const moved = { dirProbeStatus: 'pending', dirProbePath: '~/code/api', dirProbeResult: stored };
  assert.deepEqual(dirProbeAnswerOf(moved, '~/code/api'), { path: '~/code/api', status: 'pending', result: null });
  assert.deepEqual(dirProbeAnswerOf(moved, ASKED), { path: ASKED, status: 'idle', result: null },
    'a path nobody is asking about any more is idle, whatever was stored for it');
  // Asked again about the same path: the last answer shows while the runner looks again.
  assert.deepEqual(dirProbeAnswerOf({ dirProbeStatus: 'probing', dirProbePath: ASKED, dirProbeResult: stored }, ASKED),
    { path: ASKED, status: 'pending', result: PROBE });
  // Never asked; asked about nothing; a stored value that is not an answer.
  assert.deepEqual(dirProbeAnswerOf({ dirProbeStatus: null, dirProbePath: null, dirProbeResult: null }, ASKED),
    { path: ASKED, status: 'idle', result: null });
  assert.deepEqual(dirProbeAnswerOf({ dirProbeStatus: 'done', dirProbePath: ASKED, dirProbeResult: stored }, ''),
    { path: '', status: 'idle', result: null });
  assert.equal(dirProbeAnswerOf({ dirProbeStatus: 'done', dirProbePath: ASKED, dirProbeResult: PROBE }, ASKED).result, null);
});
