import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

// The shape listUsable selects: no id. The endpoint and the key are read only to say which engines the
// key runs on, and never answered with.
const DEEPSEEK = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: null,
  followsPreset: false,
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyEnc: encryptSecret('sk-deepseek'),
};

const serviceFor = (
  rows: unknown[],
  captured?: { where?: unknown; poolWhere?: unknown },
  pools: unknown[] = [],
  role = 'MEMBER',
) =>
  new ProvidersService(
    {
      // Whether the caller is an admin decides whether a shared row is theirs (usableProviderScope).
      user: { findUnique: async () => ({ role }) },
      modelProvider: {
        findMany: async (args: { where: unknown }) => {
          if (captured) captured.where = args.where;
          return rows;
        },
      },
      providerPool: {
        findMany: async (args: { where: unknown }) => {
          if (captured) captured.poolWhere = args.where;
          return pools;
        },
      },
    } as never,
    {} as never,
    {} as never,
  );

test('every built-in engine is listed alongside the configured providers', async () => {
  const listed = await serviceFor([DEEPSEEK]).listUsable('user-1');

  assert.deepEqual(
    listed.map((p) => p.slug),
    ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'dsh', 'deepseek'],
  );
  // Which of the two a slug is, since only one of them takes a label or a model list.
  assert.deepEqual(
    listed.filter((p) => p.builtin).map((p) => p.slug),
    ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'dsh'],
  );
  // A built-in runs on itself: Antigravity is agy, not a provider borrowing some other CLI.
  assert.deepEqual(
    listed.find((p) => p.slug === 'antigravity'),
    { slug: 'antigravity', runtime: 'antigravity', engines: ['antigravity'], builtin: true },
  );
  // The built-in dsh is DeepSeek Harness, on the caller's default DeepSeek key.
  assert.deepEqual(listed.find((p) => p.slug === 'dsh')?.engines, ['dsh']);
});

test('a configured provider names the runtime it borrows and the models it offers', async () => {
  const [deepseek] = (await serviceFor([DEEPSEEK]).listUsable('user-1')).filter((p) => !p.builtin);

  assert.deepEqual(deepseek, {
    slug: 'deepseek',
    label: 'DeepSeek',
    // Not 'deepseek': the slug is the name to pass, the runtime is the protocol its endpoint speaks.
    runtime: 'claude',
    // …and these are the engines that run it, the one a caller naming only the slug gets first: a DeepSeek
    // key runs on Claude Code, OpenCode and DeepSeek Harness (docs/provider-engine-contract.md §6.3).
    engines: ['claude', 'opencode', 'dsh'],
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    builtin: false,
  });
});

// The whole point of the list is that a slug on it is a slug the write paths accept, so it has to
// ask the same question they do: enabled, and one this caller may use — their own, and the shared
// ones only when they are an admin.
test('the query matches the check task and session writes run', async () => {
  const captured: { where?: unknown } = {};
  await serviceFor([], captured).listUsable('user-1');

  assert.deepEqual(captured.where, {
    // Not the compatibility rows migrations 0080 and 0367 parked on the two built-in names.
    slug: { notIn: ['opencode', 'antigravity'] },
    AND: [{ OR: [{ enabled: true }, { slug: 'dsh' }] }],
    ownerId: 'user-1',
  });

  await serviceFor([], captured, [], 'ADMIN').listUsable('user-1');
  assert.deepEqual(captured.where, {
    slug: { notIn: ['opencode', 'antigravity'] },
    AND: [{ OR: [{ enabled: true }, { slug: 'dsh' }] }],
    OR: [{ ownerId: null }, { ownerId: 'user-1' }],
  });
});

// A pool is a slug to dispatch with like any provider, but only its owner's: the claim resolves it
// for nobody else, and so do the write paths.
test("the caller's own account pools are listed by name, on Claude, and only theirs", async () => {
  const captured: { poolWhere?: unknown } = {};
  const listed = await serviceFor([DEEPSEEK], captured, [
    { slug: 'claude-accounts', label: 'Claude accounts' },
  ]).listUsable('user-1');

  // Their own account pools, and the Codex pools they are one of the people of — a shared pool
  // (migration 0321), or somebody else's own pool its owner added them to (migration 0358) — nobody else's.
  assert.deepEqual(captured.poolWhere, {
    OR: [{ ownerId: 'user-1', shared: false }, { engine: 'codex', people: { some: { userId: 'user-1' } } }],
  });
  assert.deepEqual(listed.at(-1), {
    slug: 'claude-accounts',
    label: 'Claude accounts',
    runtime: 'claude',
    engines: ['claude'],
    builtin: false,
  });
});

test('a shared pool the caller is in is listed by name, on Codex', async () => {
  const listed = await serviceFor([DEEPSEEK], undefined, [
    { slug: 'claude-accounts', label: 'Claude accounts', shared: false },
    { slug: 'team-codex', label: 'Team Codex', shared: true },
  ]).listUsable('user-1');

  assert.deepEqual(listed.slice(-2), [
    { slug: 'claude-accounts', label: 'Claude accounts', runtime: 'claude', engines: ['claude'], builtin: false },
    { slug: 'team-codex', label: 'Team Codex', runtime: 'codex', engines: ['codex'], builtin: false },
  ]);
});

test('a preset-backed row is described by the preset, not by the copy it stored', async () => {
  const stale = {
    ...DEEPSEEK,
    slug: 'anthropic',
    label: 'Anthropic (Claude)',
    models: [{ value: 'claude-3-opus', label: 'stale' }],
    defaultModel: 'claude-3-opus',
    presetSlug: 'anthropic',
    followsPreset: true,
  };

  const [anthropic] = (await serviceFor([stale]).listUsable('user-1')).filter((p) => !p.builtin);

  assert.notDeepEqual(anthropic.models, stale.models);
  assert.notEqual(anthropic.defaultModel, 'claude-3-opus');
  // Which preset backs it is the picker's business; the caller asked what to type.
  assert.equal('presetSlug' in anthropic, false);
  assert.equal('followsPreset' in anthropic, false);
});
