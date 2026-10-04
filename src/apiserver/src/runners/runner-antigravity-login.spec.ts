import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger, type LoggerService, ValidationPipe } from '@nestjs/common';
import { RunnerStatus, type LoginCommand, type RunnerLoginState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY, ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { StartLoginDto } from './dto';
import { loginCodeRelay } from './login-code-relay';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Antigravity's Google sign-in through the browser relay (docs/antigravity-runtime-contract.md §16.1).
 *
 * The runner drives agy's own OAuth prompt in a private terminal and reports the Google link; the
 * user approves it in their browser and pastes the code back, which has to reach that terminal and
 * nowhere else. What this file pins down is the control plane's half: the start reaches only a Linux
 * runner that relays it; the code is never stored — not even in the `login_code` column claude's relay
 * uses — but held in memory for its sign-in, handed over by exactly one heartbeat and gone the moment
 * anything settles that sign-in, never read back or logged; and a sign-in the user dismisses is
 * stopped on the machine, where a replacement sign-in had set the old Google login aside.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const USER = { userId: OWNER } as AuthUser;
const CAPABLE = `session-worktree-ops-v1,${ANTIGRAVITY_GOOGLE_LOGIN_V1}`;
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=placeholder&response_type=code';
/** Shaped like a Google authorization code (`4/0…`) so a leak would be recognisable; not a real one. */
const CODE = '4/0-placeholder-authorization-code';

type Row = Record<string, unknown>;

/** A where clause as the relay's statements write one: equality, a Date, or `{ not: value }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    // SQL's `<>`: a NULL is never "not" anything.
    if (want && typeof want === 'object' && 'not' in want) return have != null && have !== (want as { not: unknown }).not;
    return have === want;
  });
}

function harness(storedCapabilities: string[] = [ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux']) {
  // The relay is this process's; every case starts with nothing held for its runner.
  loginCodeRelay.drop(RUNNER_ID);
  const row: Row = {
    id: RUNNER_ID,
    ownerId: OWNER,
    status: 'ONLINE',
    maxConcurrent: 4,
    minFreeDiskMb: null,
    capabilities: storedCapabilities,
  };
  const writes: Row[] = [];
  const runnerModel = {
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
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  return {
    row,
    writes,
    async post(body: Row): Promise<RunnerLoginState> {
      const dto = (await pipe.transform(body, { type: 'body', metatype: StartLoginDto })) as StartLoginDto;
      return runners.startLogin(USER, RUNNER_ID, dto);
    },
    state: () => runners.loginState(USER, RUNNER_ID),
    cancel: () => runners.cancelLogin(USER, RUNNER_ID),
    code: (code: string) => runners.submitLoginCode(USER, RUNNER_ID, { code }),
    /** The `loginRequest` of the runner's next heartbeat, sent with these capabilities and OS
     *  headers (`null` sends none). */
    async beat(capabilities: string | null = CAPABLE, os: string | null = 'linux'): Promise<LoginCommand | undefined> {
      const response = await runnerApi.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1 },
        capabilities ?? undefined,
        undefined,
        os ?? undefined,
      );
      return response.loginRequest;
    },
    /** POST /runner/login-result, as the runner sends it. */
    report: (body: Row) =>
      (
        runnerApi as unknown as {
          loginResult: (runner: { id: string }, body: Row) => Promise<{ ok: boolean; applied: boolean }>;
        }
      ).loginResult({ id: RUNNER_ID }, body),
  };
}

const attemptOf = (row: Row) => (row.loginAt as Date).toISOString();

/** A started sign-in the runner has published its Google link for — where a code can be pasted. */
async function awaitingCode(h: ReturnType<typeof harness>): Promise<string> {
  await h.post({ engine: 'antigravity' });
  const attempt = attemptOf(h.row);
  await h.beat();
  await h.report({ status: 'awaiting_code', url: GOOGLE_URL, attempt });
  return attempt;
}

/** Everything written to Nest's loggers or the console while `run` runs. */
async function logsDuring(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  const previous = (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
  Logger.overrideLogger({ log: capture, warn: capture, error: capture, debug: capture, verbose: capture, fatal: capture });
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = consoleMethods.map((name) => console[name]);
  for (const name of consoleMethods) console[name] = capture;
  try {
    await run();
  } finally {
    consoleMethods.forEach((name, i) => (console[name] = saved[i]));
    Logger.overrideLogger(previous ?? false);
  }
  return lines.join('\n');
}

test('the Google sign-in is started only on a runner process that relays it, on Linux', async () => {
  const h = harness();
  assert.deepEqual(await h.post({ engine: 'antigravity' }), {
    status: 'pending',
    engine: 'antigravity',
    userCode: null,
    url: null,
    message: null,
    account: null,
  });
  // Redelivered until the runner reports, like every start.
  const start = { action: 'start', engine: 'antigravity', attempt: attemptOf(h.row) };
  assert.deepEqual(await h.beat(), start);
  assert.deepEqual(await h.beat(), start);

  // The stored declaration let the start through, but the process polling now is what has to carry
  // it out: one that does not declare the relay is never handed it.
  const downgraded = harness();
  await downgraded.post({ engine: 'antigravity' });
  assert.equal(await downgraded.beat('session-worktree-ops-v1'), undefined);
  const state = await downgraded.state();
  assert.equal(state.status, 'failed');
  assert.match(state.message ?? '', /too old to sign Antigravity in with Google — update it/);
  assert.equal(await downgraded.beat(null), undefined, 'a failed start is not handed over later');

  // Nor one that names another operating system.
  const mac = harness();
  await mac.post({ engine: 'antigravity' });
  assert.equal(await mac.beat(CAPABLE, 'darwin'), undefined);
  assert.deepEqual(
    [(await mac.state()).status, (await mac.state()).message],
    ['failed', ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY],
  );

  // A process that relays it but names no OS is let through: it refuses a platform it cannot do itself.
  const unnamed = harness([ANTIGRAVITY_GOOGLE_LOGIN_V1]);
  await unnamed.post({ engine: 'antigravity' });
  assert.deepEqual(await unnamed.beat(CAPABLE, null), { action: 'start', engine: 'antigravity', attempt: attemptOf(unnamed.row) });
});

test('the pasted code is handed over by one heartbeat and is never stored, read back or logged', async () => {
  const h = harness();
  const logs = await logsDuring(async () => {
    const attempt = await awaitingCode(h);
    assert.deepEqual(
      [(await h.state()).status, (await h.state()).url],
      ['awaiting_code', GOOGLE_URL],
    );

    const submitted = await h.code(`  ${CODE}  `);
    assert.equal(submitted.status, 'awaiting_code');
    assert.equal(JSON.stringify(submitted).includes(CODE), false, 'the code is not handed back to the browser');
    assert.equal(JSON.stringify(await h.state()).includes(CODE), false, 'nor to anyone polling the relay');
    assert.equal(h.row.loginCode, null, 'not even for a moment in the row claude\'s relay uses');
    assert.equal(loginCodeRelay.holds(RUNNER_ID), true);

    // Handed over on the next heartbeat with the attempt it belongs to, and gone from memory with it.
    assert.deepEqual(await h.beat(), { action: 'code', engine: 'antigravity', code: CODE, attempt });
    assert.equal(loginCodeRelay.holds(RUNNER_ID), false);
    assert.equal(await h.beat(), undefined, 'single-use: never handed over twice');

    // A rejected code: agy keeps the same link waiting, and the user pastes again.
    await h.report({
      status: 'awaiting_code',
      url: GOOGLE_URL,
      message: "That code wasn't accepted — make sure you copied all of it, then try again.",
      attempt,
    });
    assert.match((await h.state()).message ?? '', /wasn't accepted/);
    await h.code(`${CODE}-again`);
    assert.deepEqual(await h.beat(), { action: 'code', engine: 'antigravity', code: `${CODE}-again`, attempt });

    await h.report({ status: 'done', attempt });
    assert.deepEqual(await h.state(), { status: 'done', engine: 'antigravity', userCode: null, url: null, message: null, account: null });
  });
  assert.equal(logs.includes(CODE), false, 'no log line carries the code');
  assert.equal(
    h.writes.some((data) => JSON.stringify(data).includes(CODE)),
    false,
    'no write to the database ever carried the code',
  );
  assert.equal(loginCodeRelay.holds(RUNNER_ID), false);
});

test('a held code goes the moment anything settles its sign-in', async () => {
  // Dismissed: the cancel goes out instead, and the code with nothing.
  let h = harness();
  let attempt = await awaitingCode(h);
  await h.code(CODE);
  await h.cancel();
  assert.equal(loginCodeRelay.holds(RUNNER_ID), false, 'cancelled');
  assert.deepEqual(await h.beat(), { action: 'cancel', engine: 'antigravity', attempt });

  // Started again: the code was for the sign-in this replaces.
  h = harness();
  await awaitingCode(h);
  await h.code(CODE);
  await h.post({ engine: 'antigravity' });
  assert.equal(loginCodeRelay.holds(RUNNER_ID), false, 'replaced');
  assert.deepEqual(await h.beat(), { action: 'start', engine: 'antigravity', attempt: attemptOf(h.row) });

  // The runner reported on the sign-in first — it failed, or timed out on the machine.
  h = harness();
  attempt = await awaitingCode(h);
  await h.code(CODE);
  await h.report({ status: 'failed', message: 'Google sign-in timed out — start it again', attempt });
  assert.equal(loginCodeRelay.holds(RUNNER_ID), false, 'reported on');
  assert.equal(await h.beat(), undefined);

  // The relay's own timeout, swept by the heartbeat.
  h = harness();
  await awaitingCode(h);
  await h.code(CODE);
  h.row.loginAt = new Date(Date.now() - 12 * 60_000);
  assert.equal(await h.beat(), undefined);
  assert.equal(loginCodeRelay.holds(RUNNER_ID), false, 'timed out');
  assert.equal((await h.state()).status, 'failed');

  // A report about a sign-in already replaced leaves the current one's code alone.
  h = harness();
  await h.post({ engine: 'antigravity' });
  const first = attemptOf(h.row);
  await new Promise((resolve) => setTimeout(resolve, 5));
  attempt = await awaitingCode(h);
  assert.notEqual(first, attempt);
  await h.code(CODE);
  assert.deepEqual(await h.report({ status: 'failed', message: 'Google sign-in cancelled', attempt: first }), { ok: true, applied: false });
  assert.deepEqual(await h.beat(), { action: 'code', engine: 'antigravity', code: CODE, attempt });
});

test('a dismissed sign-in is stopped on the runner, once, and nothing it still reports lands', async () => {
  const h = harness();
  const attempt = await awaitingCode(h);

  const cancelled = await h.cancel();
  const nothing = { status: null, engine: null, userCode: null, url: null, message: null, account: null };
  assert.deepEqual(cancelled, nothing);
  assert.deepEqual(await h.state(), nothing, 'the card is dismissed at once');
  // The paste box is gone with it.
  await assert.rejects(h.code(CODE), /not waiting for a sign-in code/);

  // Until the runner hears of it, what it still says about that sign-in is dropped.
  assert.deepEqual(await h.report({ status: 'awaiting_code', url: GOOGLE_URL, attempt }), { ok: true, applied: false });
  assert.deepEqual(await h.report({ status: 'done', attempt }), { ok: true, applied: false });
  assert.deepEqual(await h.state(), nothing);

  // The next heartbeat carries the cancel for that attempt, once.
  assert.deepEqual(await h.beat(), { action: 'cancel', engine: 'antigravity', attempt });
  assert.equal(await h.beat(), undefined);
  assert.deepEqual([h.row.loginStatus, h.row.loginEngine, h.row.loginAt], [null, null, null]);
  // And the runner's own word on the cancelled attempt changes nothing either.
  assert.deepEqual(
    await h.report({ status: 'failed', message: 'Google sign-in cancelled', attempt }),
    { ok: true, applied: false },
  );
  assert.deepEqual(await h.state(), nothing);
});

test('a sign-in started again replaces the cancel still owed for the one before it', async () => {
  const h = harness();
  await h.post({ engine: 'antigravity' });
  const first = attemptOf(h.row);
  await h.beat();
  await h.cancel();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.post({ engine: 'antigravity' });
  const second = attemptOf(h.row);
  assert.notEqual(first, second);
  // The new start preempts the old attempt on the runner; a cancel now could only take the new one.
  assert.deepEqual(await h.beat(), { action: 'start', engine: 'antigravity', attempt: second });
});

test('dismissing any other engine sign-in clears the relay as it always has', async () => {
  const h = harness();
  await h.post({ engine: 'claude' });
  await h.beat();
  await h.cancel();
  assert.deepEqual([h.row.loginStatus, h.row.loginEngine, h.row.loginAt], [null, null, null]);
  assert.equal(await h.beat(), undefined, 'no cancel is handed to a claude relay');
});

test('a runner that names no OS but cannot sign in on its platform refuses it, and the card shows why', async () => {
  // What src/runner-go/login.go reports for a start on anything but Linux (macOS keeps agy's login
  // in the system keychain), before any process starts. The relay carries it as the outcome.
  const h = harness([ANTIGRAVITY_GOOGLE_LOGIN_V1]);
  await h.post({ engine: 'antigravity' });
  const attempt = attemptOf(h.row);
  assert.deepEqual(await h.beat(CAPABLE, null), { action: 'start', engine: 'antigravity', attempt });
  assert.deepEqual(await h.report({ status: 'failed', message: ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY, attempt }), { ok: true, applied: true });
  assert.deepEqual(await h.state(), {
    status: 'failed', engine: 'antigravity', userCode: null, url: null, message: ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY, account: null,
  });
  assert.equal(await h.beat(CAPABLE, null), undefined, 'a refused start is not handed over again');
});
