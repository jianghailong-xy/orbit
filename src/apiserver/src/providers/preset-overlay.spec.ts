import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PROVIDER_PRESETS } from '@orbit/shared';
import { presetDefaultModel, withPreset } from './preset-overlay';

const anthropic = PROVIDER_PRESETS.find((p) => p.slug === 'anthropic')!;

test('preset-overlay', async (t) => {
  await t.test('a following row serves the preset catalogue, not its stored copy', () => {
    // What a row created before the catalogue moved on looks like.
    const row = withPreset({
      presetSlug: 'anthropic',
      models: [{ value: 'claude-opus-4-0', label: 'Claude Opus 4' }],
      defaultModel: 'claude-opus-4-0',
    });
    assert.deepEqual(row.models, anthropic.models);
    // The stored default is gone from the catalogue, so the preset's choice takes over.
    assert.equal(row.defaultModel, anthropic.defaultModel);
  });

  await t.test('a pinned default the preset still offers survives', () => {
    const pinned = anthropic.models[1].value;
    const row = withPreset({ presetSlug: 'anthropic', models: [], defaultModel: pinned });
    assert.equal(row.defaultModel, pinned);
    assert.deepEqual(row.models, anthropic.models);
  });

  await t.test('a self-maintained row is untouched', () => {
    const stored = [{ value: 'my-model', label: 'Mine' }];
    const row = withPreset({ presetSlug: null, models: stored, defaultModel: 'my-model' });
    assert.deepEqual(row.models, stored);
    assert.equal(row.defaultModel, 'my-model');
  });

  await t.test('a link to a preset we no longer ship falls back to the stored copy', () => {
    const stored = [{ value: 'retired-1', label: 'Retired' }];
    const row = withPreset({ presetSlug: 'a-vendor-we-dropped', models: stored, defaultModel: 'retired-1' });
    assert.deepEqual(row.models, stored);
    assert.equal(row.defaultModel, 'retired-1');
  });

  await t.test('presetDefaultModel: what dispatch resolves with', () => {
    assert.equal(presetDefaultModel({ presetSlug: 'anthropic', defaultModel: null }), anthropic.defaultModel);
    assert.equal(presetDefaultModel({ presetSlug: null, defaultModel: null }), null);
    assert.equal(presetDefaultModel({ defaultModel: 'kept' }), 'kept');
  });
});
