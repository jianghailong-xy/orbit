import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * The two ends of a clone on the machine protocol: the request going out with a heartbeat, and
 * the result coming back.
 *
 * The workspace row IS the queue here — a workspace in CLONING is exactly a clone not yet
 * answered for — so these cover what that costs: redelivery until a result arrives, and a result
 * that only counts for the machine and the state it was asked of.
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;

function harness(options: { runner?: Row; cloning?: Row[]; matched?: number } = {}) {
  const row: Row = { maxConcurrent: 2, ...(options.runner ?? {}) };
  const updates: Array<{ where: Row; data: Row }> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Row }) => {
        // `undefined` means "leave this column alone" to Prisma, and half of what is asserted here
        // is exactly that — a stub that assigned it would report every omitted field as a wipe.
        for (const [column, value] of Object.entries(data)) {
          if (value !== undefined) row[column] = value;
        }
        return row;
      },
      findUnique: async () => row,
    },
    workspace: {
      // One method, two reads: the clone drain asks for CLONING rows, the agentDirs listing asks
      // for everything with a workDir. Keyed on the predicate so both stay honest.
      findMany: async ({ where }: { where: Row }) =>
        where.provisionState === 'CLONING' ? (options.cloning ?? []) : [],
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        updates.push({ where, data });
        return { count: options.matched ?? 1 };
      },
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  return {
    api: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never),
    updates,
    row,
  };
}

const beat = (extra: Row = {}) => ({ status: RunnerStatus.ONLINE, idleCapacity: 1, ...extra });

// ── Out with the heartbeat ────────────────────────────────────────────────────────────────────

test('a workspace still CLONING is handed to its machine, as the URL and nothing else', async () => {
  const h = harness({
    cloning: [{ id: WORKSPACE_ID, repoUrl: 'git@github.com:anthropics/orbit.git' }],
  });

  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());

  // No path travels with it: `<reposRoot>/<owner>-<repo>` is derived on the machine that owns the
  // root, and the result reports where the checkout actually ended up.
  assert.deepEqual(res.cloneRequests, [
    { workspaceId: WORKSPACE_ID, repoUrl: 'git@github.com:anthropics/orbit.git' },
  ]);
});

// A machine that never reported a repos root is still asked, deliberately: it answers with that
// as a failure the user can read, where withholding the request would leave the workspace CLONING
// for ever with nothing to show for it.
test('a runner with no repos root is still asked, and answers for itself', async () => {
  const h = harness({
    runner: { reposRoot: null },
    cloning: [{ id: WORKSPACE_ID, repoUrl: 'https://github.com/anthropics/orbit.git' }],
  });

  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());

  assert.equal(res.cloneRequests?.length, 1);
});

test('nothing in flight means an empty list, not a missing field', async () => {
  const h = harness();

  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());

  assert.deepEqual(res.cloneRequests, []);
});

// ── Back with the result ──────────────────────────────────────────────────────────────────────

test('a finished clone lands the directory, worktree isolation and the default branch', async () => {
  const h = harness();

  const res = await h.api.cloneResult(
    { id: RUNNER_ID },
    {
      workspaceId: WORKSPACE_ID,
      status: 'done',
      path: '/srv/repos/anthropics-orbit',
      defaultBranch: 'trunk',
    },
  );

  assert.deepEqual(res, { ok: true });
  assert.deepEqual(h.updates[0].data, {
    workDir: '/srv/repos/anthropics-orbit',
    provisionState: 'READY',
    enableWorktree: true,
    provisionError: null,
    defaultMergeTarget: 'trunk',
  });
  // The fence: this machine's workspace, still in the state the request was made in.
  assert.equal(h.updates[0].where.runnerId, RUNNER_ID);
  assert.equal(h.updates[0].where.provisionState, 'CLONING');
});

test('a clone that detected no default branch writes none', async () => {
  const h = harness();

  await h.api.cloneResult(
    { id: RUNNER_ID },
    { workspaceId: WORKSPACE_ID, status: 'done', path: '/srv/repos/anthropics-orbit' },
  );

  assert.equal('defaultMergeTarget' in h.updates[0].data, false);
});

// Verbatim is the whole point: the text git printed is the only thing that tells the user what to
// change, and any rewriting of it eventually lies.
test('a failed clone stores git’s stderr byte for byte', async () => {
  const h = harness();
  const stderr =
    "Cloning into '/srv/repos/anthropics-orbit'...\n" +
    'git@github.com: Permission denied (publickey).\n' +
    'fatal: Could not read from remote repository.\n';

  await h.api.cloneResult({ id: RUNNER_ID }, { workspaceId: WORKSPACE_ID, status: 'failed', stderr });

  assert.deepEqual(h.updates[0].data, { provisionState: 'FAILED', provisionError: stderr });
});

// A checkout that was already there is still where the workspace runs; the flag says nothing was
// cloned, and nothing about the row that follows from it.
test('a clone the runner found already on the disk lands the same way', async () => {
  const h = harness();

  await h.api.cloneResult(
    { id: RUNNER_ID },
    {
      workspaceId: WORKSPACE_ID,
      status: 'done',
      path: '/srv/repos/anthropics-orbit',
      defaultBranch: 'main',
      reused: true,
    },
  );

  assert.equal(h.updates[0].data.workDir, '/srv/repos/anthropics-orbit');
  assert.equal(h.updates[0].data.provisionState, 'READY');
});

// git never ran, so there is no stderr — the runner's own words are all there is, and dropping
// them would leave a failed workspace with nothing on it at all.
test('a failure git never saw keeps the runner’s own message', async () => {
  const h = harness();

  await h.api.cloneResult(
    { id: RUNNER_ID },
    { workspaceId: WORKSPACE_ID, status: 'failed', message: 'this machine has no repos root to clone into' },
  );

  assert.equal(
    h.updates[0].data.provisionError,
    'this machine has no repos root to clone into',
  );
});

// The occupied-directory case sends both: git's refusal, which does not say what is in the way,
// and the runner's line naming the remote that is. Both are kept, git's first.
test('git’s words and the runner’s line are kept together, in that order', async () => {
  const h = harness();

  await h.api.cloneResult(
    { id: RUNNER_ID },
    {
      workspaceId: WORKSPACE_ID,
      status: 'failed',
      stderr: "fatal: destination path '/srv/repos/anthropics-orbit' already exists\n",
      message: '/srv/repos/anthropics-orbit is a checkout of git@github.com:someone/else.git',
    },
  );

  assert.equal(
    h.updates[0].data.provisionError,
    "fatal: destination path '/srv/repos/anthropics-orbit' already exists\n\n" +
      '/srv/repos/anthropics-orbit is a checkout of git@github.com:someone/else.git',
  );
});

test('a NUL in the stderr is dropped rather than failing the whole write', async () => {
  const h = harness();

  await h.api.cloneResult(
    { id: RUNNER_ID },
    { workspaceId: WORKSPACE_ID, status: 'failed', stderr: 'fatal: bad \u0000object' },
  );

  assert.equal(h.updates[0].data.provisionError, 'fatal: bad object');
});

test('a result nothing matches is reported as such, not as an error', async () => {
  const h = harness({ matched: 0 });

  const res = await h.api.cloneResult(
    { id: RUNNER_ID },
    { workspaceId: WORKSPACE_ID, status: 'done', path: '/srv/repos/anthropics-orbit' },
  );

  assert.deepEqual(res, { ok: false });
});

test('a success that names no directory is refused', async () => {
  const h = harness();

  await assert.rejects(
    () => h.api.cloneResult({ id: RUNNER_ID }, { workspaceId: WORKSPACE_ID, status: 'done' }),
    (e: unknown) => e instanceof BadRequestException && /where it landed/i.test(String((e as Error).message)),
  );
  assert.equal(h.updates.length, 0);
});

test('an unknown status writes nothing', async () => {
  const h = harness();

  await assert.rejects(
    () =>
      h.api.cloneResult({ id: RUNNER_ID }, {
        workspaceId: WORKSPACE_ID,
        status: 'partially' as never,
      }),
    (e: unknown) => e instanceof BadRequestException,
  );
  assert.equal(h.updates.length, 0);
});
