import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { KIMI_LOGIN_REGION_V1, RunnerStatus, type LoginCommand, type RunnerLoginState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { StartLoginDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Signing Kimi Code in on the site the user picked.
 *
 * kimi.com and kimi.ai keep separate accounts, and a bare `kimi login` goes wherever the CLI decides
 * — kimi.com, on an install Orbit made. `POST /runners/:id/login` names the site, and what the runner
 * is told to do is the `loginRequest` of its next heartbeat. So the site named in the body has to
 * arrive THERE, and a runner that would ignore it must be refused rather than handed a start it
 * would carry out on the other site.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const USER = { userId: OWNER } as AuthUser;
const SITE_CAPABLE = `session-worktree-ops-v1,${KIMI_LOGIN_REGION_V1}`;
const NOT_SITE_CAPABLE = 'session-worktree-ops-v1,codex-account-login/v1';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object' && 'not' in want) return have != null;
    return have === want;
  });
}

function harness() {
  const row: Row = { id: RUNNER_ID, ownerId: OWNER, status: 'ONLINE', maxConcurrent: 4, minFreeDiskMb: null };
  const writes: Row[] = [];
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: Row }) => (matches(row, where) ? { ...row } : null),
      findUnique: async ({ where }: { where: Row }) => (matches(row, where) ? { ...row } : null),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        assert.ok(matches(row, where), 'update of a row that is not there');
        writes.push(data);
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(row, where)) return { count: 0 };
        writes.push(data);
        Object.assign(row, data);
        return { count: 1 };
      },
    },
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
  // The pipe main.ts installs: a body field the DTO does not declare is stripped, not refused.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  return {
    row,
    writes,
    /** POST /runners/:id/login, from the raw JSON body on. */
    async post(body: Row): Promise<RunnerLoginState> {
      const dto = (await pipe.transform(body, { type: 'body', metatype: StartLoginDto })) as StartLoginDto;
      return runners.startLogin(USER, RUNNER_ID, dto);
    },
    state: () => runners.loginState(USER, RUNNER_ID),
    cancel: () => runners.cancelLogin(USER, RUNNER_ID),
    /** What the runner is told to do: the `loginRequest` of its next heartbeat. */
    async beat(capabilities: string = SITE_CAPABLE): Promise<LoginCommand | undefined> {
      const response = await runnerApi.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1 },
        capabilities,
      );
      return response.loginRequest;
    },
  };
}

const attemptOf = (row: Row) => (row.loginAt as Date).toISOString();

test('the site the body names is the site in the start a runner that can choose one is handed', async () => {
  for (const region of ['mainland-cn', 'global'] as const) {
    const h = harness();
    const state = await h.post({ engine: 'kimi', region });
    assert.equal(state.status, 'pending');
    assert.deepEqual(await h.beat(), { action: 'start', engine: 'kimi', attempt: attemptOf(h.row), region });
    // Redelivered, unchanged, until the runner's first report moves the row on.
    assert.deepEqual(await h.beat(), await h.beat());
    assert.equal((await h.beat())?.region, region);
  }
});

test('a Kimi sign-in naming no site is the bare start it always was', async () => {
  const h = harness();
  await h.post({ engine: 'kimi' });
  assert.equal(h.row.loginRegion, null);
  // Exactly the old shape, for the old runner and the new one alike.
  for (const capabilities of [SITE_CAPABLE, NOT_SITE_CAPABLE]) {
    assert.deepEqual(await h.beat(capabilities), { action: 'start', engine: 'kimi', attempt: attemptOf(h.row) });
  }
});

test('a runner that cannot choose a site is refused the start, in words the user can act on', async () => {
  const h = harness();
  await h.post({ engine: 'kimi', region: 'global' });
  // It would run a bare `kimi login` — kimi.com on an install Orbit made — whatever was asked.
  assert.equal(await h.beat(NOT_SITE_CAPABLE), undefined);
  const state = await h.state();
  assert.equal(state.status, 'failed');
  assert.match(state.message ?? '', /too old to choose a Kimi site — update it/u);
  // Refused once, not handed over later: the row is no longer pending.
  assert.equal(await h.beat(SITE_CAPABLE), undefined);
});

test('only Kimi signs in on a site of the user\'s choosing', async () => {
  const h = harness();
  for (const engine of ['claude', 'codex', 'antigravity']) {
    await assert.rejects(h.post({ engine, region: 'global' }), BadRequestException);
  }
  assert.deepEqual(h.writes, [], 'a refused start writes nothing');
});

test('a site that is not one of the two is refused at the door', async () => {
  const h = harness();
  for (const region of ['eu', 'kimi.ai', 'GLOBAL', '']) {
    await assert.rejects(h.post({ engine: 'kimi', region }), BadRequestException);
  }
  assert.deepEqual(h.writes, []);
});

test('a new sign-in replaces the site of the one before, and cancelling forgets it', async () => {
  const h = harness();
  await h.post({ engine: 'kimi', region: 'global' });
  // "Use kimi.com instead": a new attempt on the other site.
  await h.post({ engine: 'kimi', region: 'mainland-cn' });
  assert.equal((await h.beat())?.region, 'mainland-cn');
  // Then without a site at all: no leftover from the attempts before.
  await h.post({ engine: 'kimi' });
  assert.equal('region' in ((await h.beat()) ?? {}), false);
  // And the site of a sign-in the user dismissed is not kept for a later one.
  await h.post({ engine: 'kimi', region: 'global' });
  await h.cancel();
  assert.equal(h.row.loginRegion, null);
  assert.equal(await h.beat(), undefined);
});

test("another engine's sign-in never carries a site left on the row", async () => {
  const h = harness();
  await h.post({ engine: 'kimi', region: 'global' });
  // Codex's start replaces it, and the stored site goes with it.
  await h.post({ engine: 'codex' });
  assert.equal(h.row.loginRegion, null);
  assert.deepEqual(await h.beat(), { action: 'start', engine: 'codex', attempt: attemptOf(h.row) });
});
