import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subagentRunView } from './subagent-run';

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
const catalog = { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] } as never;

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
    catalog,
  );
  assert.deepEqual(view, {
    toolUseId: 'toolu_1', type: 'explore', background: false, status: 'DONE', level: 'M',
    model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high',
    reasons: ['Tier M, set by the caller', "Shadow decision: this SubAgent runs on the parent's model, claude-opus-5-5"],
    costUsd: 0.21, resultSummary: 'Three callers.',
    createdAt: '2026-11-11T10:00:00.000Z', endedAt: '2026-11-11T10:03:12.000Z',
  });
});

test('an applied decision names its own pick; an unknown model keeps its id', () => {
  const view = subagentRunView(
    { ...base, endedAt: null, status: 'RUNNING', decision: { level: 'S', model: 'deepseek-chat', effort: 'low', applied: true, reasons: [] } },
    catalog,
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
