import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decryptSecret } from '../providers/provider-crypto';
import { ProvidersService } from '../providers/providers.service';
import { RunnerProvidersController } from './runner-providers.controller';

// The runner's provider writes (`orbit provider create|update|delete`, provider_create/update/delete)
// on the real ProvidersService over an in-memory table: what they may reach, what they store, and
// what they answer with. The owner's confirmation card is the runner's half (askBeforeCreate) and is
// covered there.

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;
const KEY = 'vllm-placeholder-token';

type Row = Record<string, unknown> & { id: string; slug: string; ownerId: string | null };

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, want]) => {
    const have = row[field];
    if (want && typeof want === 'object') {
      const filter = want as { equals?: unknown; not?: unknown; startsWith?: string };
      if ('equals' in filter && have !== filter.equals) return false;
      if ('not' in filter && have === filter.not) return false;
      if (filter.startsWith !== undefined && !String(have).startsWith(filter.startsWith)) return false;
      return true;
    }
    return have === want;
  });
}

function harness(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let next = 0;
  const prisma = {
    modelProvider: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `provider-${++next}`, position: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row as unknown as Row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => candidate.id === where.id)!;
        for (const [field, value] of Object.entries(data)) if (value !== undefined) row[field] = value;
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        rows.splice(rows.findIndex((row) => row.id === where.id), 1);
      },
    },
    providerPool: { findMany: async () => [] },
    providerPoolMember: { findFirst: async () => null },
  };
  const published: string[] = [];
  const service = new ProvidersService(
    prisma as never,
    { publishForUser: (ownerId: string) => published.push(ownerId) } as never,
    {} as never,
  );
  return { controller: new RunnerProvidersController(service), rows, published };
}

const VLLM = {
  label: 'Local vLLM',
  runtime: 'claude',
  baseUrl: 'http://127.0.0.1:8000',
  apiKey: KEY,
  models: [
    {
      value: 'qwen3.8-27b-fp8',
      label: 'Qwen3.8 27B FP8',
      contextWindow: 131072,
      reasoningLevels: ['low', 'medium', 'xhigh'],
    },
  ],
};

test('create writes a personal provider for the runner owner and never answers with its key', async () => {
  const h = harness();

  const created = (await h.controller.create(RUNNER, VLLM as never)) as Record<string, unknown>;

  assert.equal(h.rows.length, 1);
  const [row] = h.rows;
  // The runner owner's own row — never a shared one, which only an admin writes.
  assert.equal(row.ownerId, 'owner-1');
  assert.equal(row.slug, 'local-vllm');
  assert.equal(row.runtime, 'claude');
  assert.equal(row.baseUrl, 'http://127.0.0.1:8000');
  assert.equal(row.defaultModel, 'qwen3.8-27b-fp8');
  // Stored encrypted, like every other provider key.
  assert.notEqual(row.apiKeyEnc, KEY);
  assert.equal(decryptSecret(row.apiKeyEnc as string), KEY);
  // The declaration is kept on the model it describes, where dispatch reads it.
  assert.deepEqual((row.models as unknown[])[0], VLLM.models[0]);

  // The answer is the row as the providers page reads it: the key only as whether there is one.
  assert.equal(created.slug, 'local-vllm');
  assert.equal(created.hasApiKey, true);
  assert.equal('apiKeyEnc' in created, false);
  const wire = JSON.stringify(created);
  assert.equal(wire.includes(KEY), false);
  assert.equal(wire.includes(row.apiKeyEnc as string), false);
  // The owner's pickers are told a provider changed.
  assert.deepEqual(h.published, ['owner-1']);
});

test('update and delete are keyed by the slug the list shows, within the runner owner only', async () => {
  const h = harness([
    { id: 'mine', slug: 'local-vllm', ownerId: 'owner-1', runtime: 'claude', baseUrl: 'http://127.0.0.1:8000', apiKeyEnc: 'x', models: [], label: 'Local vLLM' },
    { id: 'shared', slug: 'deepseek', ownerId: null, runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: 'x', models: [], label: 'DeepSeek' },
    { id: 'theirs', slug: 'their-vllm', ownerId: 'owner-2', runtime: 'claude', baseUrl: 'http://127.0.0.1:8000', apiKeyEnc: 'x', models: [], label: 'Theirs' },
  ]);

  const updated = (await h.controller.update(RUNNER, 'local-vllm', {
    baseUrl: 'http://127.0.0.1:8001',
    apiKey: 'rotated-token',
  } as never)) as Record<string, unknown>;
  assert.equal(h.rows[0].baseUrl, 'http://127.0.0.1:8001');
  assert.equal(decryptSecret(h.rows[0].apiKeyEnc as string), 'rotated-token');
  assert.equal(JSON.stringify(updated).includes('rotated-token'), false);

  // A shared provider and another owner's read as absent, exactly as they do by id on the web.
  await assert.rejects(() => h.controller.update(RUNNER, 'deepseek', { label: 'x' } as never), /provider not found/);
  await assert.rejects(() => h.controller.update(RUNNER, 'their-vllm', { label: 'x' } as never), /provider not found/);
  await assert.rejects(() => h.controller.remove(RUNNER, 'deepseek'), /provider not found/);

  assert.deepEqual(await h.controller.remove(RUNNER, 'local-vllm'), { ok: true });
  assert.deepEqual(h.rows.map((row) => row.id), ['shared', 'theirs']);
});

test('a reasoningLevels declaration dispatch could not honour is refused, not stored', async () => {
  const h = harness();

  // Not a level Claude Code has.
  await assert.rejects(
    () =>
      h.controller.create(RUNNER, {
        ...VLLM,
        models: [{ ...VLLM.models[0], reasoningLevels: ['medium', 'extreme'] }],
      } as never),
    /reasoningLevels must list only low, medium, high, xhigh, max/,
  );
  // Only the Claude runtime maps an effort onto a declaration.
  await assert.rejects(
    () => h.controller.create(RUNNER, { ...VLLM, runtime: 'codex' } as never),
    /reasoningLevels is only honoured on the claude runtime/,
  );
  assert.equal(h.rows.length, 0);

  // …and an edit that would leave one on another runtime is refused the same way.
  await h.controller.create(RUNNER, VLLM as never);
  await assert.rejects(
    () => h.controller.update(RUNNER, 'local-vllm', { runtime: 'codex' } as never),
    /reasoningLevels is only honoured on the claude runtime/,
  );
  assert.equal(h.rows[0].runtime, 'claude');
});
