import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PROVIDER_PRESETS } from '@orbit/shared';
import {
  catalogDefaultModel,
  catalogModels,
  parseModelCatalog,
  presetCatalog,
  setModelCatalog,
} from './model-catalog';
import { withPreset } from './preset-overlay';

const moonshot = PROVIDER_PRESETS.find((p) => p.slug === 'moonshot')!;
const anthropic = PROVIDER_PRESETS.find((p) => p.slug === 'anthropic')!;

/** A models.dev api.json cut down to the fields the parser reads. */
function payload(models: Record<string, unknown>[], source = 'moonshotai') {
  return { [source]: { models: Object.fromEntries(models.map((m) => [m.id as string, m])) } };
}

const model = (over: Record<string, unknown>) => ({
  tool_call: true,
  modalities: { output: ['text'] },
  limit: { context: 262_144 },
  ...over,
});

test('model-catalog', async (t) => {
  await t.test('a refresh leads with the vendor\'s newest models', () => {
    const catalog = parseModelCatalog(
      payload([
        model({ id: 'kimi-k2.6', name: 'Kimi K2.6', release_date: '2026-04-21' }),
        model({ id: 'kimi-k3', name: 'Kimi K3', release_date: '2026-07-16', limit: { context: 1_048_576 } }),
        model({ id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', release_date: '2026-06-12' }),
      ]),
    );
    // The model this preset was shipped without is the one the picker now opens on.
    assert.deepEqual(catalog.get('moonshot')?.[0], {
      value: 'kimi-k3',
      label: 'Kimi K3',
      contextWindow: 1_048_576,
    });
    assert.deepEqual(
      catalog.get('moonshot')?.map((m) => m.value),
      ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.7-code-highspeed'],
    );
  });

  await t.test('keeps the shipped models a refresh did not surface', () => {
    // Every vendor list carries ids the catalogue may rename or retire; dropping them here would
    // take a configured provider's pinned default with them.
    const catalog = parseModelCatalog(payload([model({ id: 'kimi-k3', name: 'Kimi K3', release_date: '2026-07-16' })]));
    const values = catalog.get('moonshot')!.map((m) => m.value);
    assert.equal(values[0], 'kimi-k3');
    for (const shipped of moonshot.models) assert.ok(values.includes(shipped.value));
  });

  await t.test('skips models a coding workspace cannot drive, and other vendors\' ids', () => {
    const catalog = parseModelCatalog(
      payload([
        model({ id: 'kimi-k3', name: 'Kimi K3', release_date: '2026-07-16' }),
        model({ id: 'kimi-latest-vision', name: 'Vision', release_date: '2026-07-20', modalities: { output: ['image'] } }),
        model({ id: 'kimi-embed', name: 'Embeddings', release_date: '2026-07-20', tool_call: false }),
        model({ id: 'moonshot-v1-8k', name: 'Not matched by the preset', release_date: '2026-07-20' }),
      ]),
    );
    const values = catalog.get('moonshot')!.map((m) => m.value);
    assert.equal(values[0], 'kimi-k3');
    for (const skipped of ['kimi-latest-vision', 'kimi-embed', 'moonshot-v1-8k']) {
      assert.ok(!values.includes(skipped), `${skipped} should not be offered`);
    }
  });

  await t.test('caps how much of a back catalogue a vendor contributes', () => {
    const catalog = parseModelCatalog(
      payload(
        Array.from({ length: 20 }, (_, i) => model({ id: `kimi-k${i}`, name: `Kimi K${i}`, release_date: `2026-01-${10 + i}` })),
      ),
    );
    // Six live models, plus the shipped ones none of them replaced.
    assert.equal(catalog.get('moonshot')!.length, 6 + moonshot.models.length);
    assert.equal(catalog.get('moonshot')![0].value, 'kimi-k19');
  });

  await t.test('a vendor it says nothing usable about is left to its shipped list', () => {
    for (const junk of [null, 'nope', {}, { moonshotai: {} }, { moonshotai: { models: { x: { id: 'gpt-5' } } } }]) {
      assert.equal(parseModelCatalog(junk).has('moonshot'), false);
    }
  });

  await t.test('a preset with no catalogue link is never refreshed', () => {
    // Anthropic's list comes from the runner's own CLI probe, not from here.
    assert.equal(parseModelCatalog(payload([model({ id: 'kimi-k3' })])).has('anthropic'), false);
    assert.equal(anthropic.catalog, undefined);
  });

  await t.test('same-day variants rank behind the model they derive from', () => {
    // A vendor ships `-highspeed`/`-lite`/`-preview` alongside their base model, and the head of
    // this order becomes the default — so a tie goes to the plain id, not the alphabetical one.
    const catalog = parseModelCatalog(
      payload([
        model({ id: 'kimi-k2.7-code-highspeed', name: 'Highspeed', release_date: '2026-06-12' }),
        model({ id: 'kimi-k2.7-code', name: 'Code', release_date: '2026-06-12' }),
      ]),
    );
    assert.equal(catalog.get('moonshot')![0].value, 'kimi-k2.7-code');
  });

  await t.test('what is installed is what reads resolve through', () => {
    assert.deepEqual(catalogModels(moonshot), moonshot.models, 'falls back before any refresh');
    assert.equal(catalogDefaultModel(moonshot), moonshot.defaultModel);

    setModelCatalog(parseModelCatalog(payload([model({ id: 'kimi-k3', name: 'Kimi K3', release_date: '2026-07-16' })])));
    const fresh = catalogModels(moonshot);
    assert.equal(fresh[0].value, 'kimi-k3');
    // The row of someone who connected Kimi months ago serves the new list — and dispatches with
    // the new flagship, rather than the default it stored back then.
    const row = withPreset({
      presetSlug: 'moonshot',
      followsPreset: true,
      models: [{ value: 'kimi-k2.6', label: 'Kimi K2.6' }],
      defaultModel: 'kimi-k2.7-code',
    });
    assert.deepEqual(row.models, fresh);
    assert.equal(row.defaultModel, 'kimi-k3');
    assert.deepEqual(presetCatalog()['moonshot'], { models: fresh, defaultModel: 'kimi-k3' });
    // A vendor with no refresh keeps both halves of what it shipped.
    assert.deepEqual(presetCatalog()['anthropic'], {
      models: anthropic.models,
      defaultModel: anthropic.defaultModel,
    });

    setModelCatalog(new Map());
    assert.deepEqual(catalogModels(moonshot), moonshot.models);
    assert.equal(catalogDefaultModel(moonshot), moonshot.defaultModel);
  });
});
