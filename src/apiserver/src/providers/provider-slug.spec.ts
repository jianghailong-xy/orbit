import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  KIMI_ORPHAN_PROVIDER_TOMBSTONE,
  pickFreeSlug,
  slugBase,
} from './provider-slug';

test('provider-slug', async (t) => {
  await t.test('slugBase: derives a dispatchable id from what the user typed', () => {
    assert.equal(slugBase('Anthropic (Claude)'), 'anthropic-claude');
    assert.equal(slugBase('  My Provider!  '), 'my-provider');
    assert.equal(slugBase('deepseek'), 'deepseek');
  });

  await t.test('slugBase: still yields a usable id when the name has no Latin letters', () => {
    // The identifier must start with a letter; a Chinese label normalises to nothing at all.
    assert.equal(slugBase('我的供应商'), 'provider');
    assert.equal(slugBase('302.AI'), 'p-302-ai');
    assert.equal(slugBase(''), 'provider');
  });

  await t.test('pickFreeSlug: suffixes past what is taken', () => {
    assert.equal(pickFreeSlug('anthropic', []), 'anthropic');
    // The second user connecting Anthropic — the collision this exists for.
    assert.equal(pickFreeSlug('anthropic', ['anthropic']), 'anthropic-2');
    assert.equal(pickFreeSlug('anthropic', ['anthropic', 'anthropic-2']), 'anthropic-3');
    // Gaps are reused: a deleted -2 is free again.
    assert.equal(pickFreeSlug('anthropic', ['anthropic', 'anthropic-3']), 'anthropic-2');
    // A prefix match that isn't a suffix of ours doesn't push us along.
    assert.equal(pickFreeSlug('moonshot', ['moonshot-cn']), 'moonshot');
  });

  await t.test('pickFreeSlug: never hands out a runtime keyword', () => {
    // Naming a custom provider "Claude" must not produce a row that shadows the built-in runtime.
    assert.equal(pickFreeSlug(slugBase('Claude'), []), 'claude-2');
    assert.equal(pickFreeSlug(slugBase('Codex'), []), 'codex-2');
    assert.equal(pickFreeSlug(slugBase('Kimi'), []), 'kimi-2');
    assert.equal(pickFreeSlug(slugBase('OpenCode'), []), 'opencode-2');
    assert.equal(
      pickFreeSlug(KIMI_ORPHAN_PROVIDER_TOMBSTONE, []),
      `${KIMI_ORPHAN_PROVIDER_TOMBSTONE}-2`,
    );
  });

  await t.test('pickFreeSlug: reuses the first Moonshot gap used by the Kimi migration', () => {
    assert.equal(pickFreeSlug('moonshot', ['moonshot']), 'moonshot-2');
    assert.equal(
      pickFreeSlug('moonshot', ['moonshot', 'moonshot-2', 'moonshot-4']),
      'moonshot-3',
    );
  });
});
