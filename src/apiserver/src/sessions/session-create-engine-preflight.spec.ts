import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { ENGINE_SIGNED_OUT, type EngineSignedOutRefusal, type RunnerEngineHealth } from '@orbit/shared';
import { ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import { SessionsService } from './sessions.service';
import { isEngineSignedOut, signedOutEngineRefusal } from './engine-signin-preflight';

/**
 * A runtime that is signed out fails every session started against it, one or two seconds after
 * creation — and each of those sessions took a git worktree with it on the way down. The state is
 * one the control plane already knows from the heartbeat, so a session bound for it is refused at
 * creation instead: the caller hears why while it can still act on it, and no checkout is minted.
 */

const SIGNED_OUT: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, version: '2.1.0', auth: 'no' },
  { engine: 'codex', installed: true, version: '0.9.1', auth: 'yes' },
];

function makeService(engines: unknown, runnerOverrides: Record<string, unknown> = {}, configuredRuntime?: string) {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    // create() reads the owner's account-level permission default when the caller names none.
    user: { findUnique: async () => ({ preferences: {} }) },
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        runnerId: 'runner-1',
        enableWorktree: false,
        permissionMode: null,
        enabled: true,
        env: null,
      }),
    },
    // The provider seed: this project last ran on claude.
    $queryRaw: async () => [{ workspace_id: 'workspace-1', provider: 'claude', provider_builtin: true }],
    runner: {
      findFirst: async () => ({
        id: 'runner-1',
        name: 'build-box',
        displayName: null,
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        engines,
        ...runnerOverrides,
      }),
    },
    modelProvider: { findFirst: async () => configuredRuntime ? { runtime: configuredRuntime } : null },
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

const PROMPT = { prompt: 'Dispatch the next Lark message', title: 'Dispatch', workspaceId: 'workspace-1' };

test('a session bound for a signed-out runtime is refused before anything is created', async () => {
  const fixture = makeService(SIGNED_OUT);

  await assert.rejects(fixture.service.create('owner-1', PROMPT), (err: unknown) => {
    assert.ok(err instanceof ConflictException);
    const message = (err as ConflictException).message;
    // Actionable on its own terms: which engine, which machine, and what fixes it.
    assert.match(message, /Claude Code is signed out on runner "build-box"/);
    assert.match(message, /claude auth login/);
    return true;
  });
  assert.deepEqual(fixture.creates, [], 'no session row, and so no worktree on the runner');
});

test('a signed-out engine the session does not use never blocks it', async () => {
  const fixture = makeService([
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'no' },
  ]);

  await fixture.service.create('owner-1', PROMPT);

  assert.equal(fixture.creates.length, 1);
});

/**
 * Everything this must NOT refuse. A session that fails at spawn with an actionable message is a
 * much better outcome than one refused for a state we misread, so each of these stays a create.
 */
test('an ambiguous or irrelevant sign-in state lets the session through', async () => {
  for (const [name, engines, runner] of [
    ['the probe could not answer', [{ engine: 'claude', installed: true, auth: 'unknown' }], {}],
    // The runner installs engines on demand, so "not installed" is a normal first-session state.
    ['the engine is not installed yet', [{ engine: 'claude', installed: false, auth: 'no' }], {}],
    ['the runner has never reported engines', null, {}],
    ['the report is from an older runner', [{ engine: 'claude', installed: true }], {}],
    [
      // Its last report describes whenever it was last alive; queuing work for a machine that is
      // coming back is ordinary use.
      'the runner is offline',
      SIGNED_OUT,
      { status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    ],
    ['the runner has not been heard from in minutes', SIGNED_OUT, { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) }],
    ['the runner has never heartbeated', SIGNED_OUT, { lastHeartbeatAt: null }],
  ] as const) {
    const fixture = makeService(engines, runner);

    await fixture.service.create('owner-1', PROMPT);

    assert.equal(fixture.creates.length, 1, name);
  }
});

/**
 * The runner skips its own sign-in preflight for a session carrying credentials of its own
 * (engineinstall.go hasInjectedCredentials). This has to skip exactly the same ones, or it refuses
 * sessions that would have run perfectly.
 */
test('a session that brings its own credentials ignores the local sign-in', () => {
  const runner = {
    name: 'build-box',
    displayName: null,
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
    engines: SIGNED_OUT,
  };
  assert.equal(
    signedOutEngineRefusal({ runtime: 'claude', bringsOwnCredentials: true, runner }),
    null,
    'a configured provider injects its API key at dispatch',
  );
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(
      signedOutEngineRefusal({
        runtime: 'claude',
        bringsOwnCredentials: false,
        workspaceEnv: { [key]: 'sk-x' },
        runner,
      }),
      null,
      key,
    );
  }
  assert.ok(
    signedOutEngineRefusal({
      runtime: 'claude',
      bringsOwnCredentials: false,
      workspaceEnv: { ANTHROPIC_API_KEY: '  ' },
      runner,
    }),
    'a blank value is not a credential',
  );
  // OpenCode resolves credentials itself, from its own store and provider-specific environment
  // Orbit does not model, so it has no local sign-in to check.
  assert.equal(
    signedOutEngineRefusal({
      runtime: 'opencode',
      bringsOwnCredentials: false,
      runner: { ...runner, engines: [{ engine: 'opencode', installed: true, auth: 'no' }] },
    }),
    null,
  );
  // A Gemini provider brings the encrypted key it dispatches on, regardless of the runner's env.
  assert.equal(
    signedOutEngineRefusal({
      runtime: 'antigravity',
      bringsOwnCredentials: true,
      runner: { ...runner, engines: [{ engine: 'antigravity', installed: true, auth: 'no' }] },
    }),
    null,
  );
});

/** A Linux runner that relays Antigravity's Google sign-in (src/runner-go/login.go). */
const GOOGLE_CAPABLE = { capabilities: ['provider:antigravity', ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux'] };

test('built-in Antigravity starts on a runner signed in with Google, or one with a Gemini env key', async () => {
  for (const health of [
    { auth: 'yes', authSource: 'google' },
    { auth: 'yes', authSource: 'env_key' },
    // A runner from before Google sign-in names no source: its yes is the env key.
    { auth: 'yes' },
  ]) {
    const fixture = makeService([{ engine: 'antigravity', installed: true, ...health }], GOOGLE_CAPABLE);
    await fixture.service.create('owner-1', { ...PROMPT, provider: 'antigravity' });
    assert.equal(fixture.creates.length, 1, JSON.stringify(health));
    assert.equal(fixture.creates[0].provider, 'antigravity');
  }
});

test('with neither, built-in Antigravity is refused with the Google sign-in that clears it', async () => {
  const fixture = makeService([{ engine: 'antigravity', installed: true, auth: 'no' }], { displayName: 'HPC', ...GOOGLE_CAPABLE });
  await assert.rejects(
    fixture.service.create('owner-1', { ...PROMPT, provider: 'antigravity' }),
    (error: unknown) => {
      assert.ok(isEngineSignedOut(error), 'the availability refusal, recognisable by type');
      // Not only an API key any more: the runner's own Google sign-in comes first.
      assert.match(error.message, /Antigravity has no Google sign-in or Gemini API key on runner "HPC"/);
      assert.match(error.message, /Sign in with Google from Infrastructure, or connect Gemini/);
      assert.match(
        error.message,
        /connect Gemini under API keys on Infrastructure \(\/providers\/new\/gemini\) — Orbit stores the key encrypted — and start this session on Gemini\.$/,
      );
      // The action a client turns into a button: POST /runners/:runnerId/login with `signIn`.
      assert.deepEqual(error.getResponse(), {
        code: ENGINE_SIGNED_OUT,
        message: error.message,
        engine: 'antigravity',
        runnerId: 'runner-1',
        signIn: { engine: 'antigravity' },
      });
      return true;
    },
  );
  assert.deepEqual(fixture.creates, [], 'no session row, and so no worktree on the runner');
});

test('a Google sign-in that lapsed is named as one, with the same sign-in to clear it', async () => {
  const fixture = makeService(
    [{ engine: 'antigravity', installed: true, auth: 'no', authSource: 'google' }],
    { displayName: 'HPC', ...GOOGLE_CAPABLE },
  );
  await assert.rejects(fixture.service.create('owner-1', { ...PROMPT, provider: 'antigravity' }), (error: unknown) => {
    assert.ok(isEngineSignedOut(error));
    assert.match(error.message, /Antigravity's Google account is signed out on runner "HPC"/);
    assert.deepEqual((error.getResponse() as EngineSignedOutRefusal).signIn, { engine: 'antigravity' });
    return true;
  });
});

test('a runner that cannot relay the Google sign-in is refused without one, naming the Gemini key', async () => {
  const fixture = makeService([{ engine: 'antigravity', installed: true, auth: 'no' }], {
    displayName: 'HPC',
    capabilities: ['provider:antigravity'],
  });
  await assert.rejects(fixture.service.create('owner-1', { ...PROMPT, provider: 'antigravity' }), (error: unknown) => {
    assert.ok(isEngineSignedOut(error));
    assert.match(error.message, /needs a newer Orbit runner there/);
    assert.match(error.message, /connect Gemini under API keys on Infrastructure \(\/providers\/new\/gemini\)/);
    const body = error.getResponse() as EngineSignedOutRefusal;
    assert.equal(body.code, ENGINE_SIGNED_OUT);
    assert.equal(body.signIn, undefined, 'no button for a sign-in this runner cannot do');
    return true;
  });
});

test('a macOS runner is refused without the Google sign-in it does not support yet', async () => {
  const fixture = makeService([{ engine: 'antigravity', installed: true, auth: 'no' }], {
    displayName: 'MacBook',
    capabilities: ['provider:antigravity', ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:darwin'],
  });
  await assert.rejects(fixture.service.create('owner-1', { ...PROMPT, provider: 'antigravity' }), (error: unknown) => {
    assert.ok(isEngineSignedOut(error));
    assert.match(error.message, /Antigravity has no Google sign-in or Gemini API key on runner "MacBook"/);
    assert.match(error.message, /works on Linux runners only for now/);
    assert.match(error.message, /connect Gemini under API keys on Infrastructure \(\/providers\/new\/gemini\)/);
    assert.equal((error.getResponse() as EngineSignedOutRefusal).signIn, undefined);
    return true;
  });
  assert.deepEqual(fixture.creates, []);
});

test('an added Antigravity account that is signed out is refused by its name, with no Gemini key way out', () => {
  const message = signedOutEngineRefusal({
    runtime: 'antigravity',
    bringsOwnCredentials: false,
    accounts: { antigravityAccount: '5e1f0a2b' },
    runner: {
      name: 'build-box',
      displayName: 'HPC',
      status: 'ONLINE',
      lastHeartbeatAt: new Date(),
      engines: [
        {
          engine: 'antigravity',
          installed: true,
          auth: 'yes',
          accounts: [{ id: '5e1f0a2b', name: 'Research', home: '/home/dev/.orbit/antigravity-accounts/5e1f0a2b', auth: 'no' }],
        },
      ],
    },
  });
  assert.equal(
    message,
    'Antigravity account "Research" is signed out on runner "HPC" — every session run on that account fails immediately. ' +
      'Sign it in from Infrastructure, then start this session again.',
  );
});

test('the other engines refuse as they did, now naming the engine and runner as fields too', async () => {
  const fixture = makeService(SIGNED_OUT);
  await assert.rejects(fixture.service.create('owner-1', PROMPT), (error: unknown) => {
    assert.ok(isEngineSignedOut(error));
    assert.deepEqual(error.getResponse(), {
      code: ENGINE_SIGNED_OUT,
      message: error.message,
      engine: 'claude',
      runnerId: 'runner-1',
    });
    return true;
  });
});

test('a configured Gemini provider creates a session when the runner has no Gemini env key', async () => {
  const fixture = makeService([{ engine: 'antigravity', installed: true, auth: 'no' }], {}, 'antigravity');
  await fixture.service.create('owner-1', { ...PROMPT, provider: 'gemini' });
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.creates[0].provider, 'gemini');
  assert.equal(fixture.creates[0].providerBuiltin, false);
});

test('Antigravity credential preflight only refuses a definite no on an online runner', () => {
  const runner = { name: 'build-box', status: 'ONLINE', lastHeartbeatAt: new Date(), engines: [{ engine: 'antigravity', installed: true, auth: 'no' }] };
  const check = (overrides: Record<string, unknown> = {}, workspaceEnv?: unknown) => signedOutEngineRefusal({
    runtime: 'antigravity', bringsOwnCredentials: false, runner: { ...runner, ...overrides }, workspaceEnv,
  });
  assert.ok(check());
  assert.ok(check({}, { GEMINI_API_KEY: '   ' }));
  assert.equal(check({}, { GEMINI_API_KEY: 'test-workspace-key' }), null);
  assert.equal(check({ engines: [{ engine: 'antigravity', installed: true, auth: 'yes' }] }), null);
  assert.equal(check({ engines: [{ engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google' }] }), null);
  assert.equal(check({ engines: [{ engine: 'antigravity', installed: true, auth: 'yes', authSource: 'env_key' }] }), null);
  assert.ok(check({ engines: [{ engine: 'antigravity', installed: true, auth: 'no', authSource: 'google' }] }));
  assert.equal(
    check({ engines: [{ engine: 'antigravity', installed: true, auth: 'no', authSource: 'google' }] }, { GEMINI_API_KEY: 'test-workspace-key' }),
    null,
    'a workspace key is a credential of the session own, whatever the runner has',
  );
  assert.equal(check({ engines: [{ engine: 'antigravity', installed: true, auth: 'unknown' }] }), null);
  assert.equal(check({ engines: null }), null);
  assert.equal(check({ status: 'OFFLINE' }), null);
  assert.equal(check({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) }), null);
  assert.ok(check({ engines: [{ engine: 'antigravity', installed: false, auth: 'no' }] }), 'an explicit missing key is actionable even before install');
});

test('kimi needs both halves of its environment provider to skip the check', () => {
  const runner = {
    name: 'build-box',
    displayName: null,
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
    engines: [{ engine: 'kimi', installed: true, auth: 'no' }],
  };

  // The CLI only synthesizes its env-backed provider when the model switch and the key are both
  // set; one alone leaves it on the machine's own sign-in.
  assert.ok(
    signedOutEngineRefusal({ runtime: 'kimi', bringsOwnCredentials: false, workspaceEnv: { KIMI_MODEL_NAME: 'k2' }, runner }),
  );
  assert.equal(
    signedOutEngineRefusal({
      runtime: 'kimi',
      bringsOwnCredentials: false,
      workspaceEnv: { KIMI_MODEL_NAME: 'k2', KIMI_MODEL_API_KEY: 'sk-x' },
      runner,
    }),
    null,
  );
});
