import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import type { RunnerEngineHealth } from '@orbit/shared';
import { SessionsService } from './sessions.service';
import { signedOutEngineRefusal } from './engine-signin-preflight';

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

function makeService(engines: unknown, runnerOverrides: Record<string, unknown> = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    agent: {
      findFirst: async () => ({
        id: 'agent-1',
        runnerId: 'runner-1',
        enableWorktree: false,
        permissionMode: null,
        enabled: true,
        env: null,
      }),
    },
    // The provider seed: this project last ran on claude.
    $queryRaw: async () => [{ agent_id: 'agent-1', provider: 'claude', provider_builtin: true }],
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
    modelProvider: { findFirst: async () => null },
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
    publishAgentChanged: () => undefined,
  } as never;
  return { service: new SessionsService(prisma, queue, realtime), creates };
}

const PROMPT = { prompt: 'Dispatch the next Lark message', title: 'Dispatch', agentId: 'agent-1' };

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
        agentEnv: { [key]: 'sk-x' },
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
      agentEnv: { ANTHROPIC_API_KEY: '  ' },
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
    signedOutEngineRefusal({ runtime: 'kimi', bringsOwnCredentials: false, agentEnv: { KIMI_MODEL_NAME: 'k2' }, runner }),
  );
  assert.equal(
    signedOutEngineRefusal({
      runtime: 'kimi',
      bringsOwnCredentials: false,
      agentEnv: { KIMI_MODEL_NAME: 'k2', KIMI_MODEL_API_KEY: 'sk-x' },
      runner,
    }),
    null,
  );
});
