import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerStatus, type CodexAccountRemoveCommand, type RunnerAccountRemoveState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { CODEX_ACCOUNT_REMOVE_V1, RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersController } from './runners.controller';
import { accountRemoveSessionsOf, accountRemoveStateOf, RunnersService } from './runners.service';

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
 * Default never goes to the runner: it is the CODEX_HOME the machine's own environment selects, the
 * one `codex` typed in a terminal shares. It is removed from Orbit alone, and only beside another
 * Codex account (runner-default-remove.spec.ts).
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

function harness(
  row: Row = {},
  sessions: Array<{ id: string; assignedRunnerId: string; codexAccount?: string | null }> = [],
  /** SessionsService.moveOffRemovedAccount, when the controller is built with one: the ids that cannot leave. */
  moveOff?: (runnerId: string, engine: string, account: string, ids: string[]) => Promise<string[]>,
) {
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
  /** The values of every hand-written statement: here, only the Orbit name a removal takes with it
   *  (RunnersService.renameAccount keeps those names; the done report drops the removed account's). */
  const raw: unknown[][] = [];
  const prisma = {
    runnerPresence: { upsert: async () => ({}) },
    runner: runnerModel,
    // The sessions a removal report's ids are looked up among: only those assigned to the reporting runner are kept.
    session: {
      findMany: async ({ where, select }: { where: { id: { in: string[] }; assignedRunnerId: string }; select?: Row }) =>
        sessions
          .filter((s) => where.id.in.includes(s.id) && s.assignedRunnerId === where.assignedRunnerId)
          .map((s) => ({ id: s.id, ...(select?.codexAccount ? { codexAccount: s.codexAccount ?? null } : {}) })),
    },
    workspace: { findMany: async () => [] },
    codexRateLimitResetOperation: { findMany: async () => [] },
    $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      raw.push(values);
      return 1;
    },
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
    undefined,
    undefined,
    undefined,
    undefined,
    (moveOff ? { moveOffRemovedAccount: moveOff } : undefined) as never,
  );
  const runners = new RunnersController(new RunnersService(prisma));
  return {
    runner,
    /** Which accounts' Orbit names the reports took out: each statement's engine and account. */
    namesTaken: () => raw.map((values) => values.filter((v) => v !== RUNNER_ID).slice(0, 2)),
    /** DELETE /runners/:id/codex-accounts/:account, as the page sends it. */
    remove: (account: string): Promise<RunnerAccountRemoveState> =>
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
    state: (): RunnerAccountRemoveState => ({
      // A row written before accounts-per-engine meant Codex.
      engine: (runner.accountRemoveEngine as RunnerAccountRemoveState['engine']) ?? 'codex',
      account: runner.codexAccountRemoveStatus ? (runner.codexAccountRemoveAccount as string) ?? null : null,
      status: (runner.codexAccountRemoveStatus as RunnerAccountRemoveState['status']) ?? null,
      message: (runner.codexAccountRemoveMessage as string) ?? null,
    }),
  };
}

const attemptOf = (row: Row) => (row.codexAccountRemoveAt as Date).toISOString();

test('the account the page names is the account in the removal the runner is handed', async () => {
  const h = harness();
  const state = await h.remove(SLOT);
  assert.deepEqual(state, { engine: 'codex', account: SLOT, status: 'pending', message: null });

  assert.deepEqual(await h.beat(), { account: SLOT, attempt: attemptOf(h.runner) });
  // Redelivered, unchanged, until the runner's report moves the row on.
  assert.deepEqual(await h.beat(), await h.beat());

  const applied = await h.report({
    account: SLOT,
    status: 'done',
    attempt: attemptOf(h.runner),
  });
  assert.deepEqual(applied, { ok: true, applied: true });
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'done', message: null });
  assert.deepEqual(h.namesTaken(), [['codex', SLOT]], 'the name it was given in Orbit goes with it');
  assert.equal(await h.beat(), undefined, 'nothing is redelivered once the runner has reported');
});

test('a removal the machine refused is reported back with the machine’s own words', async () => {
  const h = harness();
  await h.remove(SLOT);
  await h.beat();

  const message = 'codex account 1a2b3c4d is in use by a session running on this machine — end that session, then remove it';
  assert.deepEqual(
    await h.report({ engine: 'codex', account: SLOT, status: 'failed', message, attempt: attemptOf(h.runner) }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'failed', message });
  assert.deepEqual(h.namesTaken(), [], 'an account still on the machine keeps its name');

  // Asking again starts a new attempt — the first one's report does not answer it.
  await h.remove(SLOT);
  assert.equal(h.state().status, 'pending');
  assert.deepEqual(
    await h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: attemptOf(h.runner) }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'done', message: null });
});

test('a removal refused over sessions in the account keeps their ids, and the page lists only the viewer’s on this runner', async () => {
  const mine = '019fc086-c7c7-7c92-8215-778ad8a6280a';
  const elsewhere = '019fc086-c7c7-7c92-8215-778ad8a6280b';
  // Another account's session, running on its own runner: the report names it, and it is not kept.
  const theirs = '019fc086-c7c7-7c92-8215-778ad8a6280c';
  const h = harness({}, [
    { id: elsewhere, assignedRunnerId: RUNNER_ID },
    { id: mine, assignedRunnerId: RUNNER_ID },
    { id: theirs, assignedRunnerId: '22222222-2222-4222-8222-222222222222' },
  ]);
  await h.remove(SLOT);
  await h.beat();

  const message = 'codex account 1a2b3c4d is in use by a session running on this machine — end that session, then remove it';
  await h.report({ engine: 'codex', account: SLOT, status: 'failed', message, attempt: attemptOf(h.runner), sessionIds: [mine, mine, theirs, elsewhere, 'not-a-uuid', 7] });
  assert.equal(h.state().message, message, 'the machine’s own words are kept for clients that cannot list sessions');
  assert.deepEqual(h.runner.codexAccountRemoveSessions, [mine, elsewhere], 'only ids of sessions on this runner, once each, in the order named');

  // What the page reads: the viewer's sessions on this runner, by title.
  const asked: unknown[] = [];
  const db = {
    session: {
      findMany: async (args: unknown) => {
        asked.push(args);
        return [{ id: mine, title: 'Fix login redirect', turnState: 'IN_FLIGHT', status: 'RUNNING', assignedRunnerId: RUNNER_ID }];
      },
    },
  } as never;
  const listed = await accountRemoveSessionsOf(db, OWNER, [h.runner as never]);
  assert.deepEqual(listed.get(RUNNER_ID), [{ id: mine, title: 'Fix login redirect', status: 'RUNNING' }]);
  assert.deepEqual((asked[0] as { where: unknown }).where, {
    ownerId: OWNER,
    OR: [{ assignedRunnerId: RUNNER_ID, id: { in: [mine, elsewhere] } }],
  });
  assert.deepEqual(
    accountRemoveStateOf({ ...h.runner, sessions: listed.get(RUNNER_ID) } as never).sessions,
    [{ id: mine, title: 'Fix login redirect', status: 'RUNNING' }],
  );

  // Asking again forgets them; a done report names none.
  await h.remove(SLOT);
  assert.deepEqual(h.runner.codexAccountRemoveSessions, []);
  assert.deepEqual(await accountRemoveSessionsOf(db, OWNER, [h.runner as never]), new Map());
  await h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: attemptOf(h.runner), sessionIds: [mine] });
  assert.deepEqual(h.runner.codexAccountRemoveSessions, []);
  assert.equal(h.state().status, 'done');
});

test('sessions in the account move to another, and the removal waits for them instead of being refused', async () => {
  const idle = '019fc086-c7c7-7c92-8215-778ad8a6280a';
  const running = '019fc086-c7c7-7c92-8215-778ad8a6280b';
  const moved: unknown[][] = [];
  const h = harness({}, [
    { id: idle, assignedRunnerId: RUNNER_ID },
    { id: running, assignedRunnerId: RUNNER_ID },
  ], async (...args) => {
    moved.push(args);
    return [];
  });
  await h.remove(SLOT);
  await h.beat();

  const message = 'codex account 1a2b3c4d is in use by 2 sessions on this machine';
  assert.deepEqual(
    await h.report({ engine: 'codex', account: SLOT, status: 'failed', message, attempt: attemptOf(h.runner), sessionIds: [idle, running] }),
    { ok: true, applied: true },
  );
  assert.deepEqual(moved, [[RUNNER_ID, 'codex', SLOT, [idle, running]]], 'each named session is moved off the account');
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'pending', message: null }, 'not refused: still under way');
  assert.deepEqual(h.runner.codexAccountRemoveSessions, [idle, running]);
  assert.deepEqual(accountRemoveStateOf(h.runner as never).sessions, undefined, 'the page lists no refusal while they move');
  assert.equal(accountRemoveStateOf(h.runner as never).moving, 2, 'the page says how many are moving');

  // Asked again on the next beat, even past the window a runner has to answer in: a turn moves when it ends.
  h.runner.codexAccountRemoveAt = new Date(Date.now() - 60 * 60_000);
  assert.deepEqual(await h.beat(), { account: SLOT, attempt: attemptOf(h.runner) });
  await h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: attemptOf(h.runner) });
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'done', message: null });
  assert.deepEqual(h.runner.codexAccountRemoveSessions, []);
  assert.equal(accountRemoveStateOf(h.runner as never).moving, undefined);
});

test('while it waits, the removal tells the runner where each moved session went, so one with no engine is carried now', async () => {
  const toDefault = '019fc086-c7c7-7c92-8215-778ad8a6280a';
  const toOther = '019fc086-c7c7-7c92-8215-778ad8a6280b';
  // Still on the account in its row (it could not move), and a session of another runner: neither is named.
  const stillHere = '019fc086-c7c7-7c92-8215-778ad8a6280c';
  const h = harness({}, [
    { id: toDefault, assignedRunnerId: RUNNER_ID, codexAccount: 'default' },
    { id: toOther, assignedRunnerId: RUNNER_ID, codexAccount: OTHER_SLOT },
    { id: stillHere, assignedRunnerId: RUNNER_ID, codexAccount: SLOT },
  ], async () => []);
  await h.remove(SLOT);
  assert.equal((await h.beat())?.moves, undefined, 'nothing to say before any session moved');
  await h.report({ engine: 'codex', account: SLOT, status: 'failed', message: 'in use', attempt: attemptOf(h.runner), sessionIds: [toDefault, toOther, stillHere] });
  assert.deepEqual((await h.beat())?.moves, [
    { sessionId: toDefault, account: 'default' },
    { sessionId: toOther, account: OTHER_SLOT },
  ]);
});

test('only sessions that cannot leave the account refuse its removal, and they are the ones listed', async () => {
  const movable = '019fc086-c7c7-7c92-8215-778ad8a6280a';
  const stuck = '019fc086-c7c7-7c92-8215-778ad8a6280b';
  const h = harness({}, [
    { id: movable, assignedRunnerId: RUNNER_ID },
    { id: stuck, assignedRunnerId: RUNNER_ID },
  ], async () => [stuck]);
  await h.remove(SLOT);
  await h.beat();
  const message = 'codex account 1a2b3c4d is in use by 2 sessions on this machine';
  await h.report({ engine: 'codex', account: SLOT, status: 'failed', message, attempt: attemptOf(h.runner), sessionIds: [movable, stuck] });
  assert.deepEqual(h.state(), { engine: 'codex', account: SLOT, status: 'failed', message });
  assert.deepEqual(h.runner.codexAccountRemoveSessions, [stuck]);
});

test('a removal whose sessions never leave the account gives up after its own window, and says why', async () => {
  const session = '019fc086-c7c7-7c92-8215-778ad8a6280a';
  const h = harness({}, [{ id: session, assignedRunnerId: RUNNER_ID }], async () => []);
  await h.remove(SLOT);
  await h.beat();
  await h.report({ engine: 'codex', account: SLOT, status: 'failed', message: 'in use', attempt: attemptOf(h.runner), sessionIds: [session] });
  assert.equal(h.state().status, 'pending');

  h.runner.codexAccountRemoveAt = new Date(Date.now() - 7 * 60 * 60_000);
  assert.equal(await h.beat(), undefined);
  assert.deepEqual(h.state(), {
    engine: 'codex',
    account: SLOT,
    status: 'failed',
    message: 'Its sessions did not leave this account in time — try again once their turns finish.',
  });
  assert.deepEqual(h.runner.codexAccountRemoveSessions, []);
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
  assert.deepEqual(h.state(), { engine: 'codex', account: null, status: null, message: null }, 'a refused request stores nothing');
  assert.equal(await h.beat('session-worktree-ops-v1'), undefined);

  // A runner that has never reported its capabilities at all is the same answer: we cannot tell
  // whether it can, and "it might" is not enough to delete an account over.
  const silent = harness({ capabilities: [], capabilitiesReportedAt: null });
  await assert.rejects(() => silent.remove(SLOT), BadRequestException);
  assert.equal(await silent.beat(null), undefined);
});

test('Default is never handed to the runner: removed from Orbit only, and only beside another Codex account', async () => {
  const h = harness();
  for (const account of ['default', '../../.codex', 'Work', '']) {
    await assert.rejects(
      () => h.remove(account),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, `${account}: ${String(error)}`);
        assert.match(
          JSON.stringify(error.getResponse()),
          // A runner that reports no other Codex account: Default is the one Orbit has there.
          account === 'default' ? /Add another Codex account to this machine before removing Default\./ : /account/,
        );
        return true;
      },
      `removing ${JSON.stringify(account)}`,
    );
  }
  assert.deepEqual(h.state(), { engine: 'codex', account: null, status: null, message: null });
  assert.equal(await h.beat(), undefined);

  // Beside an added account it is removed from Orbit, at once, and still nothing reaches the machine.
  h.runner.engines = [{
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', auth: 'yes' },
      { id: SLOT, home: `/root/.orbit/codex-accounts/${SLOT}`, auth: 'yes' },
    ],
  }];
  assert.deepEqual(await h.remove('default'), { engine: 'codex', account: 'default', status: 'done', message: null });
  assert.deepEqual(h.state(), { engine: 'codex', account: null, status: null, message: null }, 'no relay row');
  assert.equal(await h.beat(), undefined, 'the heartbeat hands the runner nothing to remove');
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
    await h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: first }),
    { ok: true, applied: false },
  );
  assert.deepEqual(h.state(), { engine: 'codex', account: OTHER_SLOT, status: 'pending', message: null });
  assert.deepEqual(h.namesTaken(), [], 'a report that does not apply takes no name');

  // A report about an account that is not the one being removed is not this removal's either.
  assert.deepEqual(
    await h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: second }),
    { ok: true, applied: false },
  );
  assert.deepEqual(
    await h.report({ engine: 'codex', account: OTHER_SLOT, status: 'done', attempt: second }),
    { ok: true, applied: true },
  );
  assert.deepEqual(h.state(), { engine: 'codex', account: OTHER_SLOT, status: 'done', message: null });
  assert.deepEqual(h.namesTaken(), [['codex', OTHER_SLOT]]);
});

test('a report that cannot be one is refused', async () => {
  const h = harness();
  await h.remove(SLOT);
  await assert.rejects(() => h.report({ engine: 'codex', account: SLOT, status: 'removing' }), BadRequestException);
  await assert.rejects(() => h.report({ engine: 'codex', account: '../../.codex', status: 'done' }), BadRequestException);
  await assert.rejects(
    () => h.report({ engine: 'codex', account: SLOT, status: 'done', attempt: 'not a request' }),
    BadRequestException,
  );
  assert.equal(h.state().status, 'pending');
});
