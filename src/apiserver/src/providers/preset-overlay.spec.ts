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
      followsPreset: true,
      models: [{ value: 'claude-opus-4-0', label: 'Claude Opus 4' }],
      defaultModel: 'claude-opus-4-0',
    });
    assert.deepEqual(row.models, anthropic.models);
    // The stored default is gone from the catalogue, so the preset's choice takes over.
    assert.equal(row.defaultModel, anthropic.defaultModel);
  });

  await t.test("a following row's stored default yields to the catalogue's current pick", () => {
    // Following the vendor includes which model it recommends, so a default stored at creation
    // time doesn't hold a provider on last year's model. Keeping one means taking the list over.
    const stale = anthropic.models[1].value;
    const row = withPreset({ presetSlug: 'anthropic', followsPreset: true, models: [], defaultModel: stale });
    assert.equal(row.defaultModel, anthropic.defaultModel);
    assert.deepEqual(row.models, anthropic.models);
  });

  await t.test('a self-maintained row is untouched', () => {
    const stored = [{ value: 'my-model', label: 'Mine' }];
    const row = withPreset({ presetSlug: null, followsPreset: false, models: stored, defaultModel: 'my-model' });
    assert.deepEqual(row.models, stored);
    assert.equal(row.defaultModel, 'my-model');
  });

  await t.test('a row that kept its vendor but took back the list keeps its own models', () => {
    // Editing the list detaches ownership without erasing which vendor this is — the logo, and the
    // way back to the preset, both hang off presetSlug.
    const mine = [{ value: 'claude-opus-4-8', label: 'Opus' }, { value: 'internal-preview', label: 'Preview' }];
    const row = withPreset({
      presetSlug: 'anthropic',
      followsPreset: false,
      models: mine,
      defaultModel: 'internal-preview',
    });
    assert.deepEqual(row.models, mine);
    assert.equal(row.defaultModel, 'internal-preview');
  });

  await t.test('a link to a preset we no longer ship falls back to the stored copy', () => {
    const stored = [{ value: 'retired-1', label: 'Retired' }];
    const row = withPreset({
      presetSlug: 'a-vendor-we-dropped',
      followsPreset: true,
      models: stored,
      defaultModel: 'retired-1',
    });
    assert.deepEqual(row.models, stored);
    assert.equal(row.defaultModel, 'retired-1');
  });

  await t.test('presetDefaultModel: what dispatch resolves with', () => {
    assert.equal(
      presetDefaultModel({ presetSlug: 'anthropic', followsPreset: true, defaultModel: null }),
      anthropic.defaultModel,
    );
    assert.equal(presetDefaultModel({ presetSlug: null, followsPreset: false, defaultModel: null }), null);
    assert.equal(presetDefaultModel({ presetSlug: 'anthropic', followsPreset: false, defaultModel: 'mine' }), 'mine');
    assert.equal(presetDefaultModel({ defaultModel: 'kept' }), 'kept');
  });
});
