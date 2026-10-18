import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { MODEL_UNAVAILABLE } from '@orbit/shared';

import { assertManagedFirstSessionRuntime, managedFirstSessionKey, managedKeySupply, managedRuntimeReady, managedRuntimeSupply } from './managed-runner-supply';

// Model supply on a managed runner: what its heartbeat reported installed and signed in, and the
// order a first session takes it in. A runtime that is not reported ready is never supply.

const engine = (name: string, change: Record<string, unknown> = {}) => ({ engine: name, installed: true, auth: 'yes', ...change });

test('installed and signed in is supply; signed out, unknown, uninstalled or broken is not', () => {
  const runner = {
    engines: [
      engine('claude', { auth: 'no' }),
      engine('codex'),
      engine('kimi', { auth: 'unknown' }),
      engine('antigravity', { installed: false }),
    ],
  };
  assert.deepEqual(managedRuntimeSupply(runner), ['codex']);
  assert.equal(managedRuntimeReady(runner, 'codex'), true);
  for (const runtime of ['claude', 'kimi', 'antigravity']) assert.equal(managedRuntimeReady(runner, runtime), false, runtime);
});

test("Orbit's own default is preferred when it is ready, and never assumed when it is not", () => {
  const all = { engines: [engine('kimi'), engine('codex'), engine('claude')] };
  assert.deepEqual(managedRuntimeSupply(all), ['claude', 'codex', 'kimi']);
  const noClaude = { engines: [engine('kimi'), engine('codex')] };
  assert.deepEqual(managedRuntimeSupply(noClaude), ['codex', 'kimi']);
});

test('nothing reported, or a report that cannot be read, is no supply', () => {
  assert.deepEqual(managedRuntimeSupply({ engines: null }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: 'claude' }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: [{ engine: 'claude', installed: 'yes', auth: 'yes' }] }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: [] }), []);
});

test('Antigravity counts only on a runner that advertises it to the claim', () => {
  const engines = [engine('antigravity')];
  assert.deepEqual(managedRuntimeSupply({ engines, capabilities: [] }), []);
  assert.deepEqual(managedRuntimeSupply({ engines, capabilities: ['provider:antigravity'] }), ['antigravity']);
});

test('OpenCode and DeepSeek Harness are not supply in this version, whatever is reported', () => {
  const runner = {
    engines: [engine('opencode'), engine('dsh', { dsh: { versionCompatible: true, credentialPresent: true } })],
    capabilities: ['provider:opencode', 'provider:dsh'],
  };
  assert.deepEqual(managedRuntimeSupply(runner), []);
  assert.equal(managedRuntimeReady(runner, 'opencode', { bringsOwnCredentials: true }), false);
});

test("a session bringing its own credential needs the CLI installed, not the CLI's sign-in", () => {
  const runner = { engines: [engine('claude', { auth: 'no' }), engine('codex', { installed: false })] };
  assert.equal(managedRuntimeReady(runner, 'claude', { bringsOwnCredentials: true }), true);
  assert.equal(managedRuntimeReady(runner, 'codex', { bringsOwnCredentials: true }), false);
  assert.deepEqual(managedRuntimeSupply(runner), [], 'and it is still not supply of its own');
});

test('a first session with no runtime ready is refused, to be signed in from Infrastructure', async () => {
  const prisma = { session: { findFirst: async () => null } } as never;
  await assert.rejects(
    assertManagedFirstSessionRuntime(prisma, {
      workspaceId: 'w',
      runtime: 'claude',
      bringsOwnCredentials: false,
      runner: { engines: [engine('claude', { auth: 'no' })] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.deepEqual(error.getResponse(), {
        code: MODEL_UNAVAILABLE,
        message:
          'No runtime is installed and signed in on your managed runner yet, so this first session cannot start. ' +
          'Sign one in, or add a model key, from Infrastructure, then start the session again.',
      });
      return true;
    },
  );
});

// The owner's own model keys, when no runtime is signed in: a session on a key brings its own
// credential, so the engine the key runs on only has to be installed.

/** A key row as managedKeySupply reads it; the key itself is not a subscription token. */
const key = (slug: string, change: Record<string, unknown> = {}) => ({
  slug,
  runtime: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyEnc: 'not-decryptable',
  presetSlug: 'deepseek',
  ...change,
});

/** The owner's keys as the database answers the query, and the query it was asked. */
function keysOf(rows: unknown[]) {
  const asked: unknown[] = [];
  return {
    asked,
    prisma: { modelProvider: { findMany: async (args: unknown) => (asked.push(args), rows) } } as never,
  };
}

test("an owner's key is supply when the runner has the key's engine installed, signed in or not", async () => {
  const { prisma, asked } = keysOf([key('deepseek')]);
  const runner = { engines: [engine('claude', { auth: 'no' }), engine('codex', { auth: 'no' })] };
  assert.deepEqual(managedRuntimeSupply(runner), [], 'no runtime is signed in');
  assert.equal(await managedKeySupply(prisma, 'owner-1', runner), 'deepseek');
  // Only the owner's own enabled keys, in the order the owner arranged them.
  assert.deepEqual(asked, [{
    where: { ownerId: 'owner-1', enabled: true },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { slug: true, runtime: true, baseUrl: true, apiKeyEnc: true, presetSlug: true },
  }]);
});

test("a key is not supply where its engine is missing or not advertised to the claim", async () => {
  const { prisma } = keysOf([key('deepseek'), key('openai', { runtime: 'codex', baseUrl: 'https://api.openai.com/v1', presetSlug: 'openai' })]);
  assert.equal(await managedKeySupply(prisma, 'o', { engines: [engine('claude', { installed: false, auth: 'unknown' })] }), null);
  assert.equal(await managedKeySupply(prisma, 'o', { engines: [] }), null);
  assert.equal(await managedKeySupply(prisma, 'o', { engines: null }), null);
  // The first key whose engine the runner has: an OpenAI key on Codex, when Claude Code is missing.
  assert.equal(
    await managedKeySupply(prisma, 'o', { engines: [engine('claude', { installed: false }), engine('codex', { auth: 'no' })] }),
    'openai',
  );
  // A Gemini key runs on Antigravity, which counts only on a runner that advertises it.
  const gemini = keysOf([key('gemini', { runtime: 'antigravity', baseUrl: 'https://generativelanguage.googleapis.com', presetSlug: 'gemini' })]);
  const antigravity = [engine('antigravity', { auth: 'no' })];
  assert.equal(await managedKeySupply(gemini.prisma, 'o', { engines: antigravity, capabilities: [] }), null);
  assert.equal(await managedKeySupply(gemini.prisma, 'o', { engines: antigravity, capabilities: ['provider:antigravity'] }), 'gemini');
});

test('the owner\'s order decides between keys; a key named like a built-in runtime is passed over', async () => {
  const runner = { engines: [engine('claude', { auth: 'no' })] };
  assert.equal(await managedKeySupply(keysOf([key('first'), key('second')]).prisma, 'o', runner), 'first');
  // `initial_provider` holds a name alone: a configured `kimi` or `dsh` would read as that runtime's own sign-in.
  assert.equal(await managedKeySupply(keysOf([key('kimi'), key('dsh'), key('deepseek')]).prisma, 'o', runner), 'deepseek');
  assert.equal(await managedKeySupply(keysOf([key('kimi')]).prisma, 'o', runner), null);
});

test('a key no managed runtime runs is no supply: a Cursor key, a protocol no engine speaks', async () => {
  const runner = { engines: [engine('claude', { auth: 'no' }), engine('cursor', { auth: 'no' })], capabilities: ['provider:cursor'] };
  assert.equal(await managedKeySupply(keysOf([key('cursor-key', { runtime: 'cursor', baseUrl: 'https://api.cursor.com', presetSlug: 'cursor' })]).prisma, 'o', runner), null);
  assert.equal(await managedKeySupply(keysOf([key('odd', { runtime: 'not-a-protocol', presetSlug: null })]).prisma, 'o', runner), null);
});

// Before the runner has reported its engines — it waits for capacity, is being provisioned, or has not
// been heard from yet — a first session on one of the owner's keys is queued for it, not refused.

test('the key a first session waits on before the runner was ready is the first READY would consider', async () => {
  const { prisma, asked } = keysOf([key('kimi'), key('cursor-key', { runtime: 'cursor', baseUrl: 'https://api.cursor.com', presetSlug: 'cursor' }), key('deepseek'), key('later')]);
  assert.equal(await managedFirstSessionKey(prisma, 'owner-1'), 'deepseek');
  assert.deepEqual(asked, [{
    where: { ownerId: 'owner-1', enabled: true },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { slug: true, runtime: true, baseUrl: true, apiKeyEnc: true, presetSlug: true },
  }]);
  assert.equal(await managedFirstSessionKey(keysOf([]).prisma, 'owner-1'), null, 'no key of their own');
});

test('a first session on its own credential is queued for a runner that has reported nothing yet; one on a sign-in is not', async () => {
  const prisma = { session: { findFirst: async () => null } } as never;
  const unreported = { engines: null, capabilities: [] };
  // The owner's model key on Claude Code: queued, and run once the runner is READY.
  await assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'claude', bringsOwnCredentials: true, runner: unreported });
  await assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'codex', bringsOwnCredentials: true, runner: unreported });
  const refused = (error: unknown) => error instanceof ConflictException && (error.getResponse() as { code: string }).code === MODEL_UNAVAILABLE;
  // Claude Code's own sign-in: nobody could have signed it in on a runner that has never come up.
  await assert.rejects(assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'claude', bringsOwnCredentials: false, runner: unreported }), refused);
  // A runtime that is no supply waits for nothing.
  await assert.rejects(assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'opencode', bringsOwnCredentials: true, runner: unreported }), refused);
  // Once the runner has reported, what it said decides, as before: Claude Code not installed, the key's session is refused.
  await assert.rejects(assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'claude', bringsOwnCredentials: true, runner: { engines: [] } }), refused);
  await assert.rejects(
    assertManagedFirstSessionRuntime(prisma, { workspaceId: 'w', runtime: 'claude', bringsOwnCredentials: true, runner: { engines: [engine('claude', { installed: false })] } }),
    refused,
  );
});
