import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, type RunnerModelCatalog } from '@orbit/shared';
import { resolveProviderExec, type ModelProviderRow } from '../providers/custom-provider';
import { encryptSecret } from '../providers/provider-crypto';
import { normalizeEffortForRuntimeModel } from './runtime-provider';

// A Cursor CLI session names its model's context size and fast lane in its model value, the way Cursor
// writes a variant (docs/cursor-runtime-contract.md §10, shared cursorModels.ts). The server keeps such a
// value as long as the runner's catalogue lists its model. scripts/test-cursor-model-variants.mjs runs
// every case below by name.

process.env.PROVIDER_SECRET_KEY = process.env.PROVIDER_SECRET_KEY ?? 'cursor-model-variants-spec';

const VARIANT = 'claude-opus-5-5[context=1m,fast=true]';

/** The parameterized picker's catalogue as the runner reports it (cursor_models.go): bare names. */
const CATALOG = {
  cursor: [
    { value: 'default', label: 'Auto' },
    {
      value: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'medium',
      parameters: [
        { id: 'context', label: 'Context', category: 'model_config', default: '300k', values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] },
        { id: 'fast', label: 'Fast', category: 'model_config', default: 'false', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }] },
      ],
    },
    { value: 'composer-2.5', label: 'Composer 2.5' },
  ],
} as RunnerModelCatalog;

/** A Cursor key as connecting the Cursor preset stores it: its models are the runner's catalogue.
 *  Encrypted when asked for, under whichever secret the process has by then. */
const keyRow = (): ModelProviderRow & { slug: string } => ({
  slug: 'cursor-api',
  runtime: 'cursor',
  baseUrl: 'https://api2.cursor.sh',
  apiKeyEnc: encryptSecret('key_cursor-model-variants-0123456789abcdef'),
  defaultModel: '',
  presetSlug: 'cursor-api',
  followsPreset: true,
  enabled: true,
  models: [],
});

/** A Cursor session's model as dispatch resolves it: on the runner's own sign-in, or on a Cursor key. */
function cursorExec(sessionModel: string, credential: 'sign-in' | 'key', modelCatalog: unknown = CATALOG) {
  return credential === 'sign-in'
    ? resolveProviderExec({
        engine: AgentProvider.CURSOR, declaredProvider: AgentProvider.CURSOR, declaredProviderBuiltin: true, customRow: null,
        sessionModel, modelCatalog,
      })
    : resolveProviderExec({
        engine: AgentProvider.CURSOR, declaredProvider: 'cursor-api', declaredProviderBuiltin: false, customRow: keyRow(),
        sessionModel, modelCatalog,
      });
}

test('Cursor variants: a bracketed variant is kept, never replaced by Auto', () => {
  for (const credential of ['sign-in', 'key'] as const) {
    for (const model of [VARIANT, 'claude-opus-5-5[context=300k]', 'composer-2.5[fast=false]', 'claude-opus-5-5']) {
      const exec = cursorExec(model, credential);
      assert.equal(exec.model, model, `${credential}: ${model}`);
      assert.equal(exec.retiredPin, undefined, `${credential}: ${model}`);
    }
    // A setting the model does not list is the runner's to leave (it logs it), not a reason to drop the model.
    assert.equal(cursorExec('composer-2.5[context=1m]', credential).model, 'composer-2.5[context=1m]');
    // A catalogue that lists a value as it stands still offers it.
    assert.equal(cursorExec(VARIANT, credential, { cursor: [{ value: 'default', label: 'Auto' }, { value: VARIANT, label: 'Opus' }] }).model, VARIANT);
  }
});

test('Cursor variants: a variant whose model left the catalogue is retired as usual', () => {
  for (const credential of ['sign-in', 'key'] as const) {
    for (const model of ['claude-opus-4-1[context=1m,fast=true]', 'claude-opus-4-1', 'default-x[fast=true]']) {
      const exec = cursorExec(model, credential);
      assert.equal(exec.retiredPin, true, `${credential}: ${model}`);
      assert.equal(exec.model, 'default', `${credential}: ${model} falls back to the catalogue's Auto`);
    }
    // No catalogue yet: nothing can be retired.
    assert.equal(cursorExec(VARIANT, credential, undefined).model, VARIANT);
  }
});

test("Cursor variants: a variant's effort is checked against its model's levels", () => {
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'max', VARIANT, CATALOG), 'max');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'high', 'claude-opus-5-5[context=300k]', CATALOG), 'high');
  // A level the model does not list is dropped, as for the bare model.
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'ultra', VARIANT, CATALOG), '');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'ultra', 'claude-opus-5-5', CATALOG), '');
  // A model the catalogue does not describe keeps its value: the runner has not spoken for it.
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'max', 'claude-opus-4-1[context=1m]', CATALOG), 'max');
});

test('Cursor variants: other engines judge their model ids exactly as before', () => {
  const catalog = {
    claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }],
    codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoningLevels: ['low', 'medium', 'high'] }],
    antigravity: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
  } as RunnerModelCatalog;
  const builtin = (engine: AgentProvider, sessionModel: string) => resolveProviderExec({
    engine, declaredProvider: engine, declaredProviderBuiltin: true, customRow: null, sessionModel, modelCatalog: catalog,
  });
  // Brackets are no variant outside Cursor CLI: an id the catalogue does not list is retired.
  assert.equal(builtin(AgentProvider.CLAUDE, 'claude-opus-5-5').model, 'claude-opus-5-5');
  assert.equal(builtin(AgentProvider.CLAUDE, 'claude-opus-5-5[context=1m]').retiredPin, true);
  assert.equal(builtin(AgentProvider.CODEX, 'gpt-5.6-sol[fast=true]').retiredPin, true);
  // Antigravity's level-suffixed slug is still judged by its base model.
  assert.equal(builtin(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash-high').model, 'gemini-3.8-flash-high');
  assert.equal(builtin(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash-high').retiredPin, undefined);
  // Effort on another engine reads only the row of the id as it stands.
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'high', 'gpt-5.6-sol', catalog), 'high');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'high', 'gpt-5.6-sol[fast=true]', catalog), 'high');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'max', 'gpt-5.6-sol', catalog), '');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'max', 'gpt-5.6-sol[fast=true]', catalog), 'max');
});
