/**
 * task-run-auto.ts: the one answer to "would this Claude Code task run have Auto", read off the assigned
 * runner's catalogue for the model the claim would hand that runner (owner rulings R1, R2).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTO_CAPABLE_CLAUDE_MODELS } from '@orbit/shared';

import {
  TASK_MODEL_HAS_NO_AUTO,
  autoModelForUnpinnedRun,
  autoModelsOn,
  claudeRunAutoRefusal,
  type TaskRunAutoRunner,
} from './task-run-auto';

const AUTO = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const NO_AUTO = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

/** A runner whose Claude catalogue lists these rows, in this order, and reports this default. */
function runner(rows: Array<[string, string[] | undefined]>, runtimeDefault?: string): TaskRunAutoRunner {
  return {
    name: 'workstation-gpu',
    modelCatalog: {
      claude: rows.map(([value, permissionModes]) => ({ value, label: value, ...(permissionModes ? { permissionModes } : {}) })),
    },
    runtimeDefaultModels: runtimeDefault ? { claude: runtimeDefault } : {},
  };
}

const HPC = runner([
  ['claude-opus-5-5', AUTO],
  ['claude-sonnet-5-5', AUTO],
  ['claude-fable-5-2', AUTO],
  ['claude-haiku-5-5', AUTO],
  ['claude-haiku-4-5', NO_AUTO],
], 'claude-opus-5-5');

test('a pinned model the runner lists with Auto is accepted, at a pin door and at a start', () => {
  assert.equal(claudeRunAutoRefusal({ model: 'claude-opus-5-5', runner: HPC }, 'pin'), null);
  assert.equal(claudeRunAutoRefusal({ model: 'claude-sonnet-5-5', runner: HPC }, 'start'), null);
});

test('a pinned model the runner lists without Auto is refused with a code, the model, and models that have it', () => {
  const pin = claudeRunAutoRefusal({ model: 'claude-haiku-4-5', runner: HPC }, 'pin', { taskId: 't1' });
  assert.ok(pin);
  assert.equal(pin.code, TASK_MODEL_HAS_NO_AUTO);
  assert.equal(pin.statusCode, 400);
  assert.equal(pin.taskId, 't1');
  assert.equal(pin.model, 'claude-haiku-4-5');
  assert.equal(pin.runsAs, 'claude-haiku-4-5');
  assert.equal(pin.engine, 'claude');
  assert.equal(pin.runner, 'workstation-gpu');
  assert.deepEqual(pin.autoModels, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']);
  assert.equal(
    pin.message,
    'Task runs start in Auto, and claude-haiku-4-5 has no Auto on runner "workstation-gpu", so nothing was written. '
      + 'Pin a model that has Auto there, such as claude-opus-5-5, claude-sonnet-5-5 or claude-fable-5-2, '
      + 'or clear the model pin so the run gets one.',
  );
  const start = claudeRunAutoRefusal({ model: 'claude-haiku-4-5', runner: HPC }, 'start', { taskId: 't1' });
  assert.ok(start);
  assert.equal(start.code, TASK_MODEL_HAS_NO_AUTO);
  assert.equal(
    start.message,
    'Task runs start in Auto, and this task is pinned to claude-haiku-4-5, which has no Auto on runner '
      + '"workstation-gpu", so it was not started. Pin a model that has Auto there, such as claude-opus-5-5, '
      + 'claude-sonnet-5-5 or claude-fable-5-2, or clear the model pin so the run gets one, then start the task again.',
  );
});

test("the runner's row wins over the static list, in both directions", () => {
  // Listed without Auto although the static list has it: the CLI that will run it said no.
  const withheld = runner([['claude-opus-5-5', NO_AUTO], ['claude-sonnet-5-5', AUTO]]);
  assert.equal(claudeRunAutoRefusal({ model: 'claude-opus-5-5', runner: withheld }, 'pin')?.code, TASK_MODEL_HAS_NO_AUTO);
  // Listed with Auto although the static list does not know it.
  const newer = runner([['claude-opus-5-6', AUTO]]);
  assert.equal(claudeRunAutoRefusal({ model: 'claude-opus-5-6', runner: newer }, 'pin'), null);
});

test('a row that reports no modes, and a runner with no catalogue, fall back to the static list', () => {
  const old = runner([['claude-opus-5-5', undefined], ['claude-haiku-4-5', undefined]]);
  assert.equal(claudeRunAutoRefusal({ model: 'claude-opus-5-5', runner: old }, 'pin'), null);
  assert.equal(claudeRunAutoRefusal({ model: 'claude-haiku-4-5', runner: old }, 'pin')?.code, TASK_MODEL_HAS_NO_AUTO);
  const none = claudeRunAutoRefusal({ model: 'claude-haiku-4-5', runner: null }, 'pin');
  assert.ok(none);
  assert.equal(none.runner, null);
  assert.deepEqual(none.autoModels, [...AUTO_CAPABLE_CLAUDE_MODELS]);
  assert.match(String(none.message), /^Task runs start in Auto, and claude-haiku-4-5 has no Auto, so nothing was written\. /);
});

test('the model judged is the one the claim would run', () => {
  // An alias a catalogue does not list reads as retired there: the claim runs the runner's default, which has Auto.
  const retiredAlias = claudeRunAutoRefusal({ model: 'opus', runner: HPC }, 'pin');
  assert.equal(retiredAlias, null);
  // The same alias as the runner's own default is handed over as it stands, and no row answers for it, so the
  // claim runs it in Default (normalizeBuiltinPermissionMode).
  const aliasDefault = runner([['claude-opus-5-5', AUTO]], 'opus');
  const refusal = claudeRunAutoRefusal({ model: 'opus', runner: aliasDefault }, 'pin');
  assert.equal(refusal?.code, TASK_MODEL_HAS_NO_AUTO);
  assert.equal(refusal?.runsAs, 'opus');
  // Another vendor's id is not one Claude Code runs: the claim runs the Claude default, which has Auto.
  assert.equal(claudeRunAutoRefusal({ model: 'gpt-5.6-sol', runner: HPC }, 'pin'), null);
});

test('a retired pin is judged as the default it falls back to, and named as both', () => {
  const runsDefaultWithout = runner([['claude-haiku-4-5', NO_AUTO], ['claude-opus-5-5', AUTO]], 'claude-haiku-4-5');
  const refusal = claudeRunAutoRefusal({ model: 'claude-sonnet-4', runner: runsDefaultWithout }, 'pin');
  assert.ok(refusal);
  assert.equal(refusal.runsAs, 'claude-haiku-4-5');
  assert.match(String(refusal.message), /claude-sonnet-4 \(it runs as claude-haiku-4-5 there\) has no Auto/);
  const runsDefaultWith = runner([['claude-opus-5-5', AUTO]], 'claude-opus-5-5');
  assert.equal(claudeRunAutoRefusal({ model: 'claude-sonnet-4', runner: runsDefaultWith }, 'pin'), null);
});

test('an unpinned run is never refused at a pin door, and at a start only when no model on its runner has Auto', () => {
  const defaultWithout = runner([['claude-haiku-4-5', NO_AUTO], ['claude-opus-5-5', AUTO]], 'claude-haiku-4-5');
  assert.equal(claudeRunAutoRefusal({ model: null, runner: defaultWithout }, 'pin'), null);
  assert.equal(claudeRunAutoRefusal({ model: null, runner: defaultWithout }, 'start'), null);
  const nothing = runner([['claude-haiku-4-5', NO_AUTO], ['claude-opus-4-8', NO_AUTO]], 'claude-haiku-4-5');
  const refusal = claudeRunAutoRefusal({ model: null, runner: nothing }, 'start', { taskId: 't2' });
  assert.ok(refusal);
  assert.equal(refusal.code, TASK_MODEL_HAS_NO_AUTO);
  assert.equal(refusal.model, null);
  assert.deepEqual(refusal.autoModels, []);
  assert.equal(
    refusal.message,
    'Task runs start in Auto, and no Claude model on runner "workstation-gpu" has Auto, so this task was not started. '
      + 'Update Claude Code there, or pin the task to another engine, then start the task again.',
  );
});

test("an unpinned run gets the runner's first model with Auto only when its default has none", () => {
  assert.equal(autoModelForUnpinnedRun(HPC), null, 'the default has Auto: nothing is named');
  const defaultWithout = runner([['claude-haiku-4-5', NO_AUTO], ['claude-sonnet-5-5', AUTO], ['claude-opus-5-5', AUTO]], 'claude-haiku-4-5');
  assert.equal(autoModelForUnpinnedRun(defaultWithout), 'claude-sonnet-5-5', "the runner's own order decides");
  // No default reported: the claim runs the catalogue's first row.
  const firstWithout = runner([['claude-haiku-4-5', NO_AUTO], ['claude-opus-5-5', AUTO]]);
  assert.equal(autoModelForUnpinnedRun(firstWithout), 'claude-opus-5-5');
  // A default alias with no row: the claim would run it in Default, so a model with Auto is named.
  const alias = runner([['claude-opus-5-5', AUTO]], 'opus');
  assert.equal(autoModelForUnpinnedRun(alias), 'claude-opus-5-5');
  assert.equal(autoModelForUnpinnedRun(null), null, 'no runner in view: the built-in default has Auto');
  const nothing = runner([['claude-haiku-4-5', NO_AUTO]], 'claude-haiku-4-5');
  assert.equal(autoModelForUnpinnedRun(nothing), null, 'nothing to give: a start has already refused it');
});

test('autoModelsOn lists the Auto models in catalogue order, once each', () => {
  const rows = runner([['claude-sonnet-5-5', AUTO], ['claude-haiku-4-5', NO_AUTO], ['claude-sonnet-5-5', AUTO], ['claude-opus-5-5', AUTO]]);
  assert.deepEqual(autoModelsOn(rows), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(autoModelsOn({ name: 'x', modelCatalog: { codex: [{ value: 'gpt-5.6-sol' }] }, runtimeDefaultModels: null }),
    [...AUTO_CAPABLE_CLAUDE_MODELS], 'no Claude catalogue: the static list');
});
