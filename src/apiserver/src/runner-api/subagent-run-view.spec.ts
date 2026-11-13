import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelLabels, subagentRunView, subagentWhyLine } from './subagent-run';

const base = {
  toolUseId: 'toolu_1',
  type: 'explore',
  background: false,
  status: 'DONE',
  costUsd: 0.21,
  resultSummary: 'Three callers.',
  createdAt: new Date('2026-11-11T10:00:00.000Z'),
  endedAt: new Date('2026-11-11T10:03:12.000Z'),
};
const labels = modelLabels([], { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] } as never);

test('a shadow decision names the model the SubAgent runs on, labelled by the runner catalogue', () => {
  const view = subagentRunView(
    {
      ...base,
      decision: {
        level: 'M', model: 'deepseek-chat', effort: null, applied: false,
        runModel: 'claude-opus-5-5', runEffort: 'high',
        reasons: ['Tier M, set by the caller', "Shadow decision: this SubAgent runs on the parent's model, claude-opus-5-5"],
      },
    },
    labels,
  );
  assert.deepEqual(view, {
    toolUseId: 'toolu_1', type: 'explore', background: false, status: 'DONE', level: 'M',
    model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high',
    reasons: ['Tier M, set by the caller', "Shadow decision: this SubAgent runs on the parent's model, claude-opus-5-5"],
    why: null, removed: [],
    costUsd: 0.21, resultSummary: 'Three callers.', workspaceName: null,
    createdAt: '2026-11-11T10:00:00.000Z', endedAt: '2026-11-11T10:03:12.000Z',
  });
});

test('a remote run names its workspace: the row\'s now, else the one its decision recorded', () => {
  const remote = { ...base, decision: { applied: true, reasons: [], workspace: { id: 'w', name: 'orbit-macos', reason: 'Named' } } };
  assert.equal(subagentRunView({ ...remote, workspace: { name: 'orbit-mac-mini' } }).workspaceName, 'orbit-mac-mini');
  assert.equal(subagentRunView({ ...remote, workspace: null }).workspaceName, 'orbit-macos');
});

test('an applied decision names its own pick; an unknown model keeps its id', () => {
  const view = subagentRunView(
    { ...base, endedAt: null, status: 'RUNNING', decision: { level: 'S', model: 'deepseek-chat', effort: 'low', applied: true, reasons: [] } },
    labels,
  );
  assert.equal(view.model, 'deepseek-chat');
  assert.equal(view.modelLabel, 'deepseek-chat');
  assert.equal(view.effort, 'low');
  assert.equal(view.endedAt, null);
});

test('an older shadow row without runModel falls back to the decision, and bad reasons are dropped', () => {
  const view = subagentRunView({ ...base, decision: { level: null, model: null, applied: false, reasons: ['ok', 3] } });
  assert.equal(view.model, null);
  assert.equal(view.modelLabel, null);
  assert.equal(view.level, null);
  assert.deepEqual(view.reasons, ['ok']);
});

test('a provider table names a model ahead of the runner catalogue', () => {
  const labels = modelLabels(
    [{ models: [{ value: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }, { value: 'x' }] }, { models: 'not a list' }, {}],
    { claude: [{ value: 'deepseek-flash', label: 'catalogue' }, { value: 'claude-opus-5-5', label: 'Opus 5.5' }] } as never,
  );
  assert.equal(labels.get('deepseek-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(labels.get('x'), undefined);
  assert.equal(labels.get('claude-opus-5-5'), 'Opus 5.5');
});

test('the Why line: the tier, the pick with its provider once and why, each move, and a count of the removed', () => {
  const removed = Array.from({ length: 11 }, (_, i) => ({ provider: `p${i}`, engine: null, model: null, effort: null, reason: 'Blocked' }));
  const decision = {
    level: 'S', tierSource: 'size', optimizeFor: 'cost', engine: 'claude', provider: 'claude',
    model: 'claude-sonnet-5-5', effort: 'low', applied: true, tierNote: 'Tier S, set by the caller',
    note: 'subscription with 64% quota left', candidates: removed,
    reasons: ['Tier S, set by the caller: a search', 'Picked claude-sonnet-5-5 · low on claude (Cost): …'],
  };
  const why = 'Tier S, set by the caller · Cost: claude-sonnet-5-5 · low on claude, subscription with 64% quota left · 11 others removed';
  assert.equal(subagentWhyLine(decision as never), why);
  const view = subagentRunView({ ...base, decision }, labels);
  assert.equal(view.why, why);
  assert.equal(view.removed.length, 11, 'every removed candidate stays readable');
  assert.deepEqual(view.reasons, decision.reasons, 'and the full reasons');

  // A key on another engine names the engine once beside it; a move after a limit is its own clause.
  assert.equal(subagentWhyLine({
    ...decision, provider: 'deepseek', model: 'deepseek-v4-flash', effort: null, note: 'key at $0.42/M output tokens',
    candidates: removed.slice(0, 1), moves: ["Moved to glm-5 on glm after deepseek-v4-flash's account hit its limit"],
  } as never), 'Tier S, set by the caller · Cost: deepseek-v4-flash on deepseek (claude), key at $0.42/M output tokens · '
    + "Moved to glm-5 on glm after deepseek-v4-flash's account hit its limit · 1 other removed");

  // A named model is not routed: no Optimize For, no billing note.
  assert.equal(subagentWhyLine({
    tierSource: 'named-model', tierNote: 'Model named by the caller', optimizeFor: 'cost', engine: 'codex',
    provider: 'codex', model: 'gpt-5.5', effort: null, candidates: [],
  } as never), 'Model named by the caller · gpt-5.5 on codex');
});
