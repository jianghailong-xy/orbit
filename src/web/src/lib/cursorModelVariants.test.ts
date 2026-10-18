import { describe, expect, it } from 'vitest';
import { AgentProvider, type RunnerModelCatalog } from '@orbit/shared';
import { cursorChipSettings, cursorModelPick, cursorSettingRows } from './cursorRuntime';
import { effectiveSessionModel, effortOptionsFor, livePinnedModel, normalizeEffortFor } from './workspaceDefaults';

// What the web reads off a Cursor CLI session's model value, which names the model's context size and fast
// lane beside it (shared cursorModels.ts, contract §10), against the runner's catalogue. The menu's rows and
// the chip are WorkspaceView.cursor.test.tsx's. scripts/test-cursor-model-variants.mjs runs every case below
// by name.

const { CURSOR, CLAUDE } = AgentProvider;

const fastLane = (defaultValue: string) => ({
  id: 'fast', label: 'Fast', category: 'model_config', default: defaultValue,
  values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }],
});

// As the runner reports the parameterized picker (testdata/cursor/parameterized-model-picker).
const catalog: RunnerModelCatalog = {
  cursor: [
    { value: 'default', label: 'Auto' },
    {
      value: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'medium',
      parameters: [
        { id: 'context', label: 'Context', category: 'model_config', default: '300k', values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] },
        { id: 'effort', label: 'Effort', category: 'thought_level', default: 'medium', values: [{ value: 'medium', label: 'Medium' }] },
        fastLane('false'),
      ],
    },
    {
      value: 'grok-4.7',
      label: 'Grok 4.7',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      parameters: [
        { id: 'context', label: 'Context', category: 'model_config', default: '256k', values: [{ value: '256k', label: '256K' }, { value: '500k', label: '500K' }] },
        fastLane('true'),
      ],
    },
    { value: 'composer-2.5', label: 'Composer 2.5', parameters: [fastLane('true')] },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  ],
  claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', fastMode: true }],
};

const rows = (value: string) => cursorSettingRows(cursorModelPick(value, catalog));
const shown = (value: string) => rows(value).map((row) => `${row.title} ${row.label}`);

describe('a Cursor model value on the web', () => {
  it('Cursor variants: a value is read as its model and the settings it names', () => {
    expect(cursorModelPick('claude-opus-5-5[context=1m,fast=true]', catalog)).toEqual({
      model: 'claude-opus-5-5', row: catalog.cursor![1], parameters: { context: '1m', fast: 'true' },
    });
    expect(cursorModelPick('claude-opus-5-5', catalog)).toEqual({ model: 'claude-opus-5-5', row: catalog.cursor![1], parameters: {} });
    expect(cursorModelPick('default', catalog)).toEqual({ model: 'default', row: catalog.cursor![0], parameters: {} });
    // A model the catalogue does not list keeps its name and settings; it has no row to offer settings from.
    expect(cursorModelPick('claude-opus-4-1[context=1m]', catalog)).toEqual({ model: 'claude-opus-4-1', row: undefined, parameters: { context: '1m' } });
    // A catalogue that lists a value as it stands has it as a model of its own.
    const listed = { cursor: [{ value: 'gpt-5.5[context=272k,fast=false]', label: 'GPT-5.5' }] };
    expect(cursorModelPick('gpt-5.5[context=272k,fast=false]', listed)).toEqual({
      model: 'gpt-5.5[context=272k,fast=false]', row: listed.cursor[0], parameters: {},
    });
  });

  it('Cursor variants: Context and Speed are offered where the model lists them, at the value in effect', () => {
    expect(shown('claude-opus-5-5')).toEqual(['Context 300K', 'Speed Standard']);
    expect(shown('claude-opus-5-5[context=1m,fast=true]')).toEqual(['Context 1M', 'Speed Fast']);
    expect(rows('claude-opus-5-5')[0].values).toEqual([{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }]);
    // Speed reads Standard or Fast, as every engine's Speed row does: Fast is the catalogue's own name.
    expect(rows('claude-opus-5-5')[1].values).toEqual([{ value: 'false', label: 'Standard' }, { value: 'true', label: 'Fast' }]);
    expect(shown('grok-4.7[context=500k]')).toEqual(['Context 500K', 'Speed Fast']);
    expect(shown('composer-2.5[fast=false]')).toEqual(['Speed Standard']);
    // A value the model does not offer is left at the model's own, as the runner leaves it.
    expect(shown('claude-opus-5-5[context=2m]')).toEqual(['Context 300K', 'Speed Standard']);
    expect(shown('gemini-3.1-pro[context=1m,fast=true]')).toEqual([]);
    expect(shown('default')).toEqual([]);
    expect(cursorSettingRows(null)).toEqual([]);
  });

  it('Cursor variants: the chip names a context other than the model’s own, and Fast while it is on', () => {
    const chip = (value: string) => cursorChipSettings(rows(value));
    expect(chip('claude-opus-5-5[context=1m,fast=true]')).toEqual(['1M', 'Fast']);
    expect(chip('claude-opus-5-5[context=300k,fast=false]')).toEqual([]);
    expect(chip('claude-opus-5-5')).toEqual([]);
    expect(chip('claude-opus-5-5[fast=true]')).toEqual(['Fast']);
    expect(chip('grok-4.7')).toEqual(['Fast']);
    expect(chip('grok-4.7[context=500k,fast=false]')).toEqual(['500K']);
  });

  it('Cursor variants: a variant is kept as long as its model is offered, with its model’s efforts', () => {
    expect(livePinnedModel('claude-opus-5-5[context=1m,fast=true]', CURSOR, CURSOR, catalog)).toBe('claude-opus-5-5[context=1m,fast=true]');
    expect(livePinnedModel('claude-opus-4-1[context=1m]', CURSOR, CURSOR, catalog)).toBeUndefined();
    expect(effectiveSessionModel(CURSOR, CURSOR, 'claude-opus-5-5[context=1m]', null, catalog)).toBe('claude-opus-5-5[context=1m]');
    expect(effectiveSessionModel(CURSOR, CURSOR, 'claude-opus-4-1[context=1m]', null, catalog)).toBe('default');
    expect(effortOptionsFor(CURSOR, CURSOR, 'claude-opus-5-5[context=1m]', catalog).map((option) => option.value)).toEqual(
      ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
    expect(normalizeEffortFor(CURSOR, CURSOR, 'max', 'claude-opus-5-5[fast=true]', catalog)).toBe('max');
    expect(normalizeEffortFor(CURSOR, CURSOR, 'max', 'composer-2.5[fast=true]', catalog)).toBe('');
    // Another engine's ids are its own: brackets are no variant there.
    expect(livePinnedModel('claude-opus-5-5[context=1m]', CLAUDE, CLAUDE, catalog)).toBeUndefined();
    expect(livePinnedModel('claude-opus-5-5', CLAUDE, CLAUDE, catalog)).toBe('claude-opus-5-5');
  });
});
