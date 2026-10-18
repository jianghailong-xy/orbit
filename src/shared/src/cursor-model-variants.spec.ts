import { describe, expect, it } from 'vitest';
import {
  CURSOR_AUTO_MODEL,
  CURSOR_VARIANT_PARAMETERS,
  decodeCursorModel,
  encodeCursorModel,
} from './cursorModels';
import type { RunnerModelCatalog } from './dto';
import { AgentProvider } from './enums';
import { fastModeAvailable, runnerCatalogRow } from './models';

// How a Cursor CLI session names the context size and fast lane of its model (docs/cursor-runtime-contract.md
// §10): in its model value, the way Cursor writes a variant. scripts/test-cursor-model-variants.mjs runs
// every case below by name.

// The parameterized picker's own rows for these models, as the runner reports them
// (testdata/cursor/parameterized-model-picker, cursor/list_available_models).
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
        { id: 'fast', label: 'Fast', category: 'model_config', default: 'false', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }] },
      ],
    },
  ],
  claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', fastMode: true }],
};

describe('Cursor model variants', () => {
  it('Cursor variants: a model value carries context and fast in brackets, and reads back the same', () => {
    expect(CURSOR_VARIANT_PARAMETERS).toEqual(['context', 'fast']);
    const value = encodeCursorModel('claude-opus-5-5', { fast: 'true', context: '1m' });
    // The board's chip, "Claude Opus 5.5 High · 1M · Fast": the effort is the session's own field.
    expect(value).toBe('claude-opus-5-5[context=1m,fast=true]');
    expect(decodeCursorModel(value)).toEqual({ model: 'claude-opus-5-5', parameters: { context: '1m', fast: 'true' } });
    // One setting; with no catalogue row to say the model's own, every setting given is written.
    expect(encodeCursorModel('claude-opus-5-5', { context: '300k' })).toBe('claude-opus-5-5[context=300k]');
    expect(encodeCursorModel('composer-2.5', { fast: 'false' })).toBe('composer-2.5[fast=false]');
    // A bare model is its own value, with no settings.
    expect(encodeCursorModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(decodeCursorModel('claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5', parameters: {} });
    // Read the way Cursor's own variants are written, whatever their settings, ids in any order.
    expect(decodeCursorModel(' gpt-5.5[context=272k,reasoning=medium,fast=false] ')).toEqual({
      model: 'gpt-5.5',
      parameters: { context: '272k', reasoning: 'medium', fast: 'false' },
    });
    expect(encodeCursorModel('gpt-5.5', decodeCursorModel('gpt-5.5[fast=false,context=272k]').parameters)).toBe(
      'gpt-5.5[context=272k,fast=false]',
    );
  });

  it("Cursor variants: Auto takes no settings, and a setting with no value or at the model's default is left out", () => {
    expect(CURSOR_AUTO_MODEL).toBe('default');
    expect(encodeCursorModel('default', { context: '1m', fast: 'true' })).toBe('default');
    expect(encodeCursorModel('', { fast: 'true' })).toBe('');
    expect(decodeCursorModel('')).toEqual({ model: '', parameters: {} });
    expect(decodeCursorModel(null)).toEqual({ model: '', parameters: {} });
    expect(encodeCursorModel('claude-opus-5-5', { context: '', fast: undefined })).toBe('claude-opus-5-5');
    expect(encodeCursorModel('claude-opus-5-5', { context: null, fast: 'true' })).toBe('claude-opus-5-5[fast=true]');
    // Nothing the syntax cannot hold is written.
    expect(encodeCursorModel('claude-opus-5-5', { context: '1m,fast=true', 'fa st': 'true' })).toBe('claude-opus-5-5');
    // A model on its own defaults is its bare name: a value is written once, whichever way it was reached.
    const opus = catalog.cursor![1];
    expect(encodeCursorModel('claude-opus-5-5', { context: '300k', fast: 'false' }, opus)).toBe('claude-opus-5-5');
    expect(encodeCursorModel('claude-opus-5-5', { context: '300k', fast: 'true' }, opus)).toBe('claude-opus-5-5[fast=true]');
    expect(encodeCursorModel('claude-opus-5-5', { context: '1m', fast: 'true' }, opus)).toBe('claude-opus-5-5[context=1m,fast=true]');
    // Composer 2.5's fast lane is on by default, so off is what is written.
    const composer = { parameters: [{ id: 'fast', label: 'Fast', default: 'true', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }] }] };
    expect(encodeCursorModel('composer-2.5', { fast: 'true' }, composer)).toBe('composer-2.5');
    expect(encodeCursorModel('composer-2.5', { fast: 'false' }, composer)).toBe('composer-2.5[fast=false]');
  });

  it('Cursor variants: a value not written as a variant is a model name as it stands', () => {
    for (const value of [
      // Empty brackets name no settings: Cursor CLI reads such a value itself, as it always has.
      'default[]',
      'no-such-model[]',
      'claude-opus-5[1m]', // Claude Code's 1M model id
      '["deepseek", "deepseek-v4-pro"]', // DeepSeek Harness's opaque ACP value
      '[context=1m]',
      'claude-opus-5-5[context=1m',
      'claude-opus-5-5[context=1m]x',
      'claude-opus-5-5[context=1m][fast=true]',
      'claude-opus-5-5[context]',
      'claude-opus-5-5[context=]',
      'claude-opus-5-5[context=1m,]',
      'claude-opus-5-5[context=1m,context=300k]',
    ]) {
      expect(decodeCursorModel(value), value).toEqual({ model: value, parameters: {} });
    }
  });

  it('Cursor variants: a variant is its model\'s row in the catalogue, on Cursor CLI alone', () => {
    const opus = catalog.cursor![1];
    expect(runnerCatalogRow(AgentProvider.CURSOR, 'claude-opus-5-5[context=1m,fast=true]', catalog)).toBe(opus);
    expect(runnerCatalogRow(AgentProvider.CURSOR, 'claude-opus-5-5', catalog)).toBe(opus);
    expect(runnerCatalogRow(AgentProvider.CURSOR, 'gemini-3.1-pro[fast=true]', catalog)).toBeUndefined();
    // Another engine's ids are its own: brackets are no variant there.
    expect(runnerCatalogRow(AgentProvider.CLAUDE, 'claude-opus-5-5[context=1m]', catalog)).toBeUndefined();
    expect(runnerCatalogRow(AgentProvider.CLAUDE, 'claude-opus-5-5', catalog)).toBe(catalog.claude![0]);
    // Cursor CLI still declares no engine-level fast mode: its fast lane is a model setting.
    expect(fastModeAvailable(AgentProvider.CURSOR, 'claude-opus-5-5[fast=true]', catalog)).toBe(false);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5-5', catalog)).toBe(true);
  });
});
