import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerStatus, type CodexAccountRemoveCommand, type RunnerCodexAccountRemoveState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { CODEX_ACCOUNT_REMOVE_V1, RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Removing a Codex account from a runner, from the Providers page.
 *
 * A runner can hold more than one Codex account, and until now nothing could take one back:
 * `DELETE /runners/:id/codex-accounts/:account` names the slot, and what the runner is told to do is
 * the `codexAccountRemoveRequest` of its next heartbeat. So the account named in the URL has to
 * arrive THERE — and a runner that cannot do it at all (an older build, which would ignore the
 * request and leave the account on the machine) is refused in words the person who pressed the
 * button can read, rather than by a request that times out ten minutes later.
 *
 * Default is never removable: it is the CODEX_HOME the machine's own environment selects, the one
 * `codex` typed in a terminal shares.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const SLOT = '1a2b3c4d';
const OTHER_SLOT = '5e6f7a8b';
const USER = { userId: OWNER } as AuthUser;
const REMOVE_CAPABLE = `session-worktree-ops-v1,${CODEX_ACCOUNT_REMOVE_V1}`;

type Row = Record<string, unknown>;

/** A where clause as the relay's statements write one: equality, a Date, or `{ not: null }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object' && 'not' in want) return have != null;
    return have === want;
  });
}

function harness(row: Row = {}) {
  const runner: Row = {
    id: RUNNER_ID,
    ownerId: OWNER,
    status: 'ONLINE',
    maxConcurrent: 4,
    minFreeDiskMb: null,
    capabilities: REMOVE_CAPABLE.split(','),
    capabilitiesReportedAt: new Date(),
    ...row,
  };
  const runnerModel = {
    findFirst: async ({ where }: { where: Row }) => (matches(runner, where) ? { ...runner } : null),
    findUnique: async ({ where }: { where: Row }) => (matches(runner, where) ? { ...runner } : null),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      assert.ok(matches(runner, where), 'update of a row that is not there');
      Object.assign(runner, data);
      return { ...runner };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (!matches(runner, where)) return { count: 0 };
      Object.assign(runner, data);
      return { count: 1 };
    },
  };
  const prisma = {
    runner: runnerModel,
    workspace: { findMany: async () => [] },
    codexRateLimitResetOperation: { findMany: async () => [] },
  } as never;
  const realtime = { drainCancellations: async () => [], drainArtifactRequests: async () => [] } as never;
  const runnerApi = new RunnerApiController(
    prisma,
    {} as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  const runners = new RunnersController(new RunnersService(prisma));
  return {
    runner,
    /** DELETE /runners/:id/codex-accounts/:account, as the page sends it. */
    remove: (account: string): Promise<RunnerCodexAccountRemoveState> =>
      runners.removeCodexAccount(USER, RUNNER_ID, account),
    /** What the runner is told to do: the `codexAccountRemoveRequest` of its next heartbeat.
     *  `null` is a runner that sends no capability header at all. */
    async beat(capabilities: string | null = REMOVE_CAPABLE): Promise<CodexAccountRemoveCommand | undefined> {
      const response = await runnerApi.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1 },
        capabilities ?? undefined,
      );
      return response.codexAccountRemoveRequest;
    },
    /** POST /runner/codex-account-remove-result, as the runner sends it. */
    report: (body: Row) =>
      (
        runnerApi as unknown as {
          codexAccountRemoveResult: (
            runner: { id: string },
            body: Row,
          ) => Promise<{ ok: boolean; applied: boolean }>;
        }
      ).codexAccountRemoveResult({ id: RUNNER_ID }, body),
    /** The state the page reads back off this runner. */
    state: (): RunnerCodexAccountRemoveState => ({
      account: runner.codexAccountRemoveStatus ? (runner.codexAccountRemoveAccount as string) ?? null : null,
      status: (runner.codexAccountRemoveStatus as RunnerCodexAccountRemoveState['status']) ?? null,
      message: (runner.codexAccountRemoveMessage as string) ?? null,
    }),
  };
}

const attemptOf = (row: Row) => (row.codexAccountRemoveAt as Date).toISOString();

test('the account the page names is the account in the removal the runner is handed', async () => {
  const h = harness();
  const state = await h.remove(SLOT);
  assert.deepEqual(state, { account: SLOT, status: 'pending', message: null });

  assert.deepEqual(await h.beat(), { account: SLOT, attempt: attemptOf(h.runner) });
  // Redelivered, unchanged, until the runner's report moves the row on.
  assert.deepEqual(await h.beat(), await h.beat());

  const applied = await h.report({
    account: SLOT,
    status: 'done',
    attempt: attemptOf(h.runner),
  });
  assert.deepEqual(applied, { ok: true, applied: true });
  assert.deepEqual(h.state(), { account: SLOT, status: 'done', message: null });
  assert.equal(await h.beat(), undefined, 'nothing is redelivered once the runner has reported');
});

test('a removal the machine refused is reported back with the machine’s own words', async () => {
  const h = harness();
  await h.remove(SLOT);
  await h.beat();

  const message = 'codex account 1a2b3c4d is in use by a session running on this machine — end that session, then remove it';
  assert.deepEqual(
    await h.report({ account: SLOT, status: 'failed', message, attempt: attemptOf(h.runner) }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { account: SLOT, status: 'failed', message });

  // Asking again starts a new attempt — the first one's report does not answer it.
  await h.remove(SLOT);
  assert.equal(h.state().status, 'pending');
  assert.deepEqual(
    await h.report({ account: SLOT, status: 'done', attempt: attemptOf(h.runner) }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { account: SLOT, status: 'done', message: null });
});

test('a runner that cannot remove accounts is refused, in the words the page shows', async () => {
  // An older runner: it declares sign-in and worktree operations, and no removal.
  const h = harness({ capabilities: ['session-worktree-ops-v1'] });
  await assert.rejects(
    () => h.remove(SLOT),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException, String(error));
      assert.match(JSON.stringify(error.getResponse()), /too old to remove a Codex account/);
      return true;
    },
  );
  assert.deepEqual(h.state(), { account: null, status: null, message: null }, 'a refused request stores nothing');
  assert.equal(await h.beat('session-worktree-ops-v1'), undefined);

  // A runner that has never reported its capabilities at all is the same answer: we cannot tell
  // whether it can, and "it might" is not enough to delete an account over.
  const silent = harness({ capabilities: [], capabilitiesReportedAt: null });
  await assert.rejects(() => silent.remove(SLOT), BadRequestException);
  assert.equal(await silent.beat(null), undefined);
});

test('a runner whose declared capabilities went stale is refused at the heartbeat too', async () => {
  // The row says it can remove accounts; the process heartbeating says nothing of the sort. A
  // request filed in between must not sit pending until it times out.
  const h = harness();
  await h.remove(SLOT);
  assert.equal(await h.beat('session-worktree-ops-v1'), undefined);
  assert.equal(h.state().status, 'failed');
  assert.match(h.state().message ?? '', /too old to remove a Codex account/);
});

test('Default is never removable', async () => {
  const h = harness();
  for (const account of ['default', '../../.codex', 'Work', '']) {
    await assert.rejects(
      () => h.remove(account),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, `${account}: ${String(error)}`);
        assert.match(JSON.stringify(error.getResponse()), account === 'default' ? /Default/ : /account/);
        return true;
      },
      `removing ${JSON.stringify(account)}`,
    );
  }
  assert.deepEqual(h.state(), { account: null, status: null, message: null });
  assert.equal(await h.beat(), undefined);
});

test('a report about a removal the row has moved past changes nothing', async () => {
  const h = harness();
  await h.remove(SLOT);
  const first = attemptOf(h.runner);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The user asks about another account while the first removal is still going.
  await h.remove(OTHER_SLOT);
  const second = attemptOf(h.runner);
  assert.notEqual(first, second);

  assert.deepEqual(
    await h.report({ account: SLOT, status: 'done', attempt: first }),
    { ok: true, applied: false },
  );
  assert.deepEqual(h.state(), { account: OTHER_SLOT, status: 'pending', message: null });

  // A report about an account that is not the one being removed is not this removal's either.
  assert.deepEqual(
    await h.report({ account: SLOT, status: 'done', attempt: second }),
    { ok: true, applied: false },
  );
  assert.deepEqual(
    await h.report({ account: OTHER_SLOT, status: 'done', attempt: second }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { account: OTHER_SLOT, status: 'done', message: null });
});

test('a report that cannot be one is refused', async () => {
  const h = harness();
  await h.remove(SLOT);
  await assert.rejects(() => h.report({ account: SLOT, status: 'removing' }), BadRequestException);
  await assert.rejects(() => h.report({ account: '../../.codex', status: 'done' }), BadRequestException);
  await assert.rejects(
    () => h.report({ account: SLOT, status: 'done', attempt: 'not a request' }),
    BadRequestException,
  );
  assert.equal(h.state().status, 'pending');
});
