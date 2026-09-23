import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerEngineHealth } from '@orbit/shared';
import { isEngineSignedOut } from './engine-signin-preflight';
import { SessionsService } from './sessions.service';

/**
 * The sign-in preflight judges the Codex account the session will run on.
 *
 * A runner can hold several Codex accounts, each a CODEX_HOME with a sign-in of its own: Default,
 * which the runner's own environment selects, and every slot it added. A workspace picks one
 * (Workspace.codexAccount), and dispatch runs its Codex sessions there. The preflight used to read
 * the engine's own answer, which is Default's: a workspace on a signed-in Work account was refused
 * whenever Default had expired, and one on a signed-out Work account was let through to die a
 * second later at spawn.
 *
 * Every case goes through SessionsService.create, from the workspace row to the 409, so what is
 * checked is the account create() actually hands the preflight.
 */

const WORK = '3fa91c2e';
const WORK_HOME = '/home/dev/.orbit/codex-accounts/3fa91c2e';
const DEFAULT_HOME = '/home/dev/.codex';
// Who an account is. It never leaves the machine (codex-rate-limit-reset-contract §3), so a report
// carrying it is malformed — and a refusal must not repeat it even then.
const EMAIL = 'dev@example.com';
const ACCOUNT_ID = 'acct_6b0c1d2e3f4a';

type Auth = 'yes' | 'no' | 'unknown';

/** Codex as a runner with two accounts reports it: Default, and Work. */
function codex(defaultAuth: Auth, workAuth: Auth, overrides: Record<string, unknown> = {}): RunnerEngineHealth[] {
  return [
    { engine: 'claude', installed: true, version: '2.1.278', auth: 'yes' },
    {
      engine: 'codex',
      installed: true,
      version: '0.156.0',
      // The engine's own answer is Default's: the runner asks it in its own environment.
      auth: defaultAuth,
      accounts: [
        { id: 'default', codexHome: DEFAULT_HOME, auth: defaultAuth },
        { id: WORK, name: 'Work', codexHome: WORK_HOME, auth: workAuth, email: EMAIL, accountId: ACCOUNT_ID },
      ],
      ...overrides,
    } as RunnerEngineHealth,
  ];
}

interface Fixture {
  /** Workspace.codexAccount: the account the workspace's sessions run on; null is Default. */
  codexAccount?: string | null;
  env?: Record<string, string> | null;
  engines: unknown;
  runner?: Record<string, unknown>;
}

function makeService(f: Fixture) {
  const creates: Array<Record<string, unknown>> = [];
  const workspace: Record<string, unknown> = {
    id: 'workspace-1',
    runnerId: 'runner-1',
    enableWorktree: false,
    enabled: true,
    effort: null,
    env: f.env ?? null,
    codexAccount: f.codexAccount ?? null,
  };
  const runner: Record<string, unknown> = {
    id: 'runner-1',
    name: 'build-box',
    displayName: null,
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
    engines: f.engines,
    ...f.runner,
  };
  // Only the selected columns come back, as from Prisma: a read that forgets the account gets none.
  const selected = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
      : row;
  const prisma = {
    user: { findUnique: async () => ({ preferences: {} }) },
    workspace: { findFirst: async ({ select }: { select?: Record<string, boolean> }) => selected(workspace, select) },
    runner: { findFirst: async ({ select }: { select?: Record<string, boolean> }) => selected(runner, select) },
    // A configured provider that borrows the Codex runtime and brings its own key.
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string } }) =>
        where.slug === 'openai-proxy' ? { runtime: 'codex' } : null,
    },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: 'session-1', ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
  } as never;
  return { service: new SessionsService(prisma, queue, realtime), creates };
}

const CODEX_SESSION = { prompt: 'Fix the flaky login test', title: 'Fix', workspaceId: 'workspace-1', provider: 'codex' };
/** The same request with the runner named as well: create() reads the workspace on another path. */
const PINNED_CODEX_SESSION = { ...CODEX_SESSION, assignedRunnerId: 'runner-1' };

async function refusal(f: Fixture, dto: Record<string, unknown> = CODEX_SESSION): Promise<Error> {
  const fixture = makeService(f);
  let caught: unknown;
  await fixture.service.create('owner-1', dto as never).catch((err: unknown) => {
    caught = err;
  });
  assert.ok(caught instanceof Error, 'the session is refused');
  assert.deepEqual(fixture.creates, [], 'no session row, and so no worktree on the runner');
  return caught;
}

async function assertCreated(f: Fixture, why: string, dto: Record<string, unknown> = CODEX_SESSION): Promise<void> {
  const fixture = makeService(f);
  await fixture.service.create('owner-1', dto as never);
  assert.equal(fixture.creates.length, 1, why);
}

test("a workspace on a signed-in account starts its session while the runner's Default is signed out", async () => {
  for (const dto of [CODEX_SESSION, PINNED_CODEX_SESSION]) {
    await assertCreated({ codexAccount: WORK, engines: codex('no', 'yes') }, 'Work is signed in', dto);
  }
});

test('a workspace on a signed-out account is refused as an engine sign-out, naming the account', async () => {
  for (const dto of [CODEX_SESSION, PINNED_CODEX_SESSION]) {
    // Default is signed in, which is the one the preflight used to read.
    const err = await refusal({ codexAccount: WORK, engines: codex('yes', 'no') }, dto);

    // The @-mention ledger tells "sign in and it delivers itself" from a refusal that never will by
    // this, not by the wording.
    assert.ok(isEngineSignedOut(err), 'recognised as an engine sign-out');
    assert.equal(err.runtime, 'codex');
    assert.equal(err.getStatus(), 409);
    assert.match(err.message, /^Codex account "Work" is signed out on runner "build-box"/);
    // Signing in on the machine has to happen in that account's CODEX_HOME: a bare `codex login`
    // would sign Default in and leave this session exactly as refused.
    assert.ok(err.message.includes(`\`CODEX_HOME='${WORK_HOME}' codex login --device-auth\``), err.message);
    assert.ok(!err.message.includes(EMAIL), 'no email');
    assert.ok(!err.message.includes(ACCOUNT_ID), 'no account id');
  }
});

test('an account the runner reports without a name is named by its slot id', async () => {
  const [claude, engine] = codex('yes', 'no');
  const accounts = engine.accounts!.map((account) => (account.id === WORK ? { ...account, name: undefined } : account));

  const err = await refusal({ codexAccount: WORK, engines: [claude, { ...engine, accounts }] });

  assert.ok(isEngineSignedOut(err));
  assert.match(err.message, new RegExp(`^Codex account ${WORK} is signed out on runner "build-box"`));
});

test('a workspace on Default is judged on Default, and named as such only among several accounts', async () => {
  for (const codexAccount of [null, 'default']) {
    const err = await refusal({ codexAccount, engines: codex('no', 'yes') });

    assert.ok(isEngineSignedOut(err), String(codexAccount));
    assert.match(err.message, /^Codex account "Default" is signed out on runner "build-box"/);
    assert.ok(err.message.includes('`codex login --device-auth`'), 'Default signs in in the runner’s own environment');
    assert.ok(!err.message.includes('CODEX_HOME'), err.message);
  }
  // The only account: the refusal reads exactly as it did before accounts.
  for (const accounts of [[{ id: 'default', codexHome: DEFAULT_HOME, auth: 'no' }], undefined]) {
    const err = await refusal({
      codexAccount: null,
      engines: [{ engine: 'codex', installed: true, auth: 'no', ...(accounts ? { accounts } : {}) }],
    });

    assert.ok(isEngineSignedOut(err));
    assert.match(err.message, /^Codex is signed out on runner "build-box" — every session started there fails immediately\./);
  }
});

/**
 * Everything that must NOT be refused. Each case picks Work and would be refused were its rule
 * missing: a session that fails at spawn with an actionable message is a far better outcome than
 * one refused for a state misread here.
 */
test('the probe could not answer for the account', async () => {
  await assertCreated({ codexAccount: WORK, engines: codex('no', 'unknown') }, 'unknown is not signed out');
});

test('Codex is not installed on the runner yet', async () => {
  // The runner installs engines on demand, so this is a normal first-session state.
  await assertCreated(
    { codexAccount: WORK, engines: codex('no', 'no', { installed: false }) },
    'not installed is not signed out',
  );
});

test('the runner is offline', async () => {
  for (const [why, runner] of [
    ['offline', { status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) }],
    ['not heard from in minutes', { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) }],
    ['never heartbeated', { lastHeartbeatAt: null }],
  ] as const) {
    await assertCreated({ codexAccount: WORK, engines: codex('no', 'no'), runner }, why);
  }
});

test('the session brings its own key', async () => {
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    await assertCreated({ codexAccount: WORK, env: { [key]: 'sk-x' }, engines: codex('no', 'no') }, key);
  }
  // A configured provider on the Codex runtime injects its key at dispatch.
  await assertCreated(
    { codexAccount: WORK, engines: codex('no', 'no') },
    'configured provider',
    { ...CODEX_SESSION, provider: 'openai-proxy' },
  );
});

test('the picked account does not resolve on this runner', async () => {
  // Dispatch runs these on Default, which is signed out here, and they are still not refused.
  for (const [why, codexAccount, engines] of [
    ['a slot this runner does not report', 'deadbeef', codex('no', 'no')],
    ['a runner too old to list its accounts', WORK, [{ engine: 'codex', installed: true, auth: 'no' }]],
  ] as const) {
    await assertCreated({ codexAccount, engines }, why);
  }
});

test('a CODEX_HOME typed into the workspace runs the session outside Default, unless an account replaces it', async () => {
  const env = { CODEX_HOME: '/srv/codex-ci' };

  await assertCreated({ codexAccount: null, env, engines: codex('no', 'no') }, 'the typed CODEX_HOME is not Default');
  // The picked account replaces a typed CODEX_HOME at dispatch, so it is judged here too.
  const err = await refusal({ codexAccount: WORK, env, engines: codex('yes', 'no') });
  assert.ok(isEngineSignedOut(err));
  assert.match(err.message, /^Codex account "Work" is signed out/);
});
