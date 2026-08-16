import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

// The shape listUsable selects: no id, no baseUrl, no apiKeyEnc — it never asks for them.
const DEEPSEEK = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: null,
  followsPreset: false,
};

const serviceFor = (rows: unknown[], captured?: { where?: unknown }) =>
  new ProvidersService(
    {
      modelProvider: {
        findMany: async (args: { where: unknown }) => {
          if (captured) captured.where = args.where;
          return rows;
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
    ['claude', 'codex', 'kimi', 'opencode', 'deepseek'],
  );
  // Which of the two a slug is, since only one of them takes a label or a model list.
  assert.deepEqual(
    listed.filter((p) => p.builtin).map((p) => p.slug),
    ['claude', 'codex', 'kimi', 'opencode'],
  );
});

test('a configured provider names the runtime it borrows and the models it offers', async () => {
  const [deepseek] = (await serviceFor([DEEPSEEK]).listUsable('user-1')).filter((p) => !p.builtin);

  assert.deepEqual(deepseek, {
    slug: 'deepseek',
    label: 'DeepSeek',
    // Not 'deepseek': the slug is the name to pass, the runtime is the CLI that ends up running it.
    runtime: 'claude',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    builtin: false,
  });
});

// The whole point of the list is that a slug on it is a slug the write paths accept, so it has to
// ask the same question they do: enabled, and visible to this caller.
test('the query matches the check task and session writes run', async () => {
  const captured: { where?: unknown } = {};
  await serviceFor([], captured).listUsable('user-1');

  assert.deepEqual(captured.where, {
    slug: { not: 'opencode' },
    enabled: true,
    OR: [{ ownerId: null }, { ownerId: 'user-1' }],
  });
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
