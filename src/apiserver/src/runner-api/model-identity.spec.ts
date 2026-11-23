/**
 * Which model ids are one model (model-identity.ts) without a database: the id rules, reading what model_identity
 * holds, and what DeepSeek's answer is allowed to say.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  identityRows,
  learnModelIdentities,
  modelRuleKey,
  readModelIdentities,
  resetModelIdentityLearning,
  type ModelIdentityDb,
} from './model-identity';

beforeEach(() => resetModelIdentityLearning());

/** A model_identity table in memory, as the client sees it. */
function memoryDb(rows: Array<{ ruleKey: string; canonicalKey: string; name: string | null }> = []) {
  const table = new Map(rows.map((row) => [row.ruleKey, row]));
  const db: ModelIdentityDb = {
    modelIdentity: {
      findMany: async ({ where }) => where.ruleKey.in.flatMap((key) => (table.has(key) ? [table.get(key)!] : [])),
      createMany: async ({ data }) => {
        for (const row of data) if (!table.has(row.ruleKey)) table.set(row.ruleKey, row);
      },
    },
  };
  return { db, table };
}

test('the id rules take off what an engine wraps a model id in', () => {
  assert.equal(modelRuleKey('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(modelRuleKey('qwen3.7-max'), 'qwen3-7-max', 'a trailing -max is part of the name, not a level');
  assert.equal(modelRuleKey('claude-sonnet-5-5-medium'), 'claude-sonnet-5-5-medium', "an Antigravity level is its caller's to fold");
  assert.equal(modelRuleKey('claude-opus-5-5[context=1m,fast=true]'), 'claude-opus-5-5', 'a Cursor variant');
  assert.equal(modelRuleKey('["deepseek", "deepseek-v4-pro"]'), 'deepseek-v4-pro', 'a DeepSeek Harness token');
  assert.equal(modelRuleKey('kimi-code/k3'), 'k3', 'a tool prefix');
  assert.equal(modelRuleKey('Claude-Sonnet-5.5'), 'claude-sonnet-5-5', 'case and a dotted version');
  assert.equal(modelRuleKey('kimi-k3.1-pro-highspeed'), 'kimi-k3-1-pro-highspeed', 'highspeed is not a level');
});

test('an id takes the identity model_identity holds for its key, else its key alone', async () => {
  const { db } = memoryDb([
    { ruleKey: 'k3', canonicalKey: 'kimi-k3', name: 'Kimi K3' },
    { ruleKey: 'kimi-k3', canonicalKey: 'kimi-k3', name: 'Kimi K3' },
  ]);
  const identities = await readModelIdentities(db, ['kimi-code/k3', 'kimi-k3', 'claude-sonnet-5-5']);
  assert.deepEqual(identities.get('kimi-code/k3'), { key: 'kimi-k3', name: 'Kimi K3' });
  assert.deepEqual(identities.get('kimi-k3'), { key: 'kimi-k3', name: 'Kimi K3' });
  assert.deepEqual(identities.get('claude-sonnet-5-5'), { key: 'claude-sonnet-5-5', name: null });
});

test("DeepSeek's answer joins a key to a known model or one of the batch, and nothing else", () => {
  const known = new Map([['kimi-k3', 'Kimi K3']]);
  const rows = identityRows(
    'Here: {"models":[' +
      '{"key":"k3","sameAs":"kimi-k3","name":"K3"},' +
      '{"key":"deepseek-flash","sameAs":"deepseek-v4-flash","name":"DeepSeek Flash"},' +
      '{"key":"deepseek-v4-flash","sameAs":null,"name":"DeepSeek V4 Flash"},' +
      '{"key":"gpt-6-2-sol","sameAs":"gpt-unknown","name":"GPT-6.2 Sol"},' +
      '{"key":"not-asked","sameAs":null,"name":"X"}]}',
    ['k3', 'deepseek-flash', 'deepseek-v4-flash', 'gpt-6-2-sol', 'left-out'],
    known,
  );
  assert.deepEqual(rows, [
    { ruleKey: 'k3', canonicalKey: 'kimi-k3', name: 'Kimi K3' },
    { ruleKey: 'deepseek-flash', canonicalKey: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { ruleKey: 'deepseek-v4-flash', canonicalKey: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    // A sameAs naming neither: its own model.
    { ruleKey: 'gpt-6-2-sol', canonicalKey: 'gpt-6-2-sol', name: 'GPT-6.2 Sol' },
  ]);
  assert.throws(() => identityRows('no idea', ['k3'], known), /no JSON/);
});

test('a cycle in the answer ends instead of looping', () => {
  const rows = identityRows('{"models":[{"key":"a","sameAs":"b"},{"key":"b","sameAs":"a"}]}', ['a', 'b'], new Map());
  assert.equal(rows.length, 2);
});

test('learning asks only about undecided keys, keeps the answer, and asks nothing the second time', async () => {
  const { db, table } = memoryDb([{ ruleKey: 'kimi-k3', canonicalKey: 'kimi-k3', name: 'Kimi K3' }]);
  const asked: string[] = [];
  const ask = async (_system: string, task: string) => {
    asked.push(task);
    return '{"models":[{"key":"k3","sameAs":"kimi-k3","name":"K3"}]}';
  };
  const sightings = [
    { model: 'kimi-code/k3', label: 'K3', provider: 'kimi' },
    { model: 'kimi-k3', provider: 'moonshot' },
  ];
  await learnModelIdentities(db, sightings, ask);
  assert.equal(asked.length, 1);
  const task = JSON.parse(asked[0]) as { known: unknown[]; new: Array<{ key: string; ids: string[]; labels: string[] }> };
  assert.deepEqual(task.known, [{ key: 'kimi-k3', name: 'Kimi K3' }]);
  assert.deepEqual(task.new, [{ key: 'k3', ids: ['kimi-code/k3'], labels: ['K3'], providers: ['kimi'] }]);
  assert.deepEqual(table.get('k3'), { ruleKey: 'k3', canonicalKey: 'kimi-k3', name: 'Kimi K3' });

  await learnModelIdentities(db, sightings, ask);
  assert.equal(asked.length, 1, 'a decided key is not asked again');
});

test('a failed question writes nothing and holds off further questions', async () => {
  const { db, table } = memoryDb();
  let asks = 0;
  const failing = async () => {
    asks += 1;
    throw new Error('DeepSeek answered 503');
  };
  const sightings = [{ model: 'k3', provider: 'kimi' }];
  await learnModelIdentities(db, sightings, failing, 1_000);
  assert.equal(table.size, 0);
  await learnModelIdentities(db, sightings, failing, 2_000);
  assert.equal(asks, 1, 'asked again only after the back-off');
  await learnModelIdentities(db, sightings, failing, 1_000 + 10 * 60_000);
  assert.equal(asks, 2);
});
