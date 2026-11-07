import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeishuMessageDetail } from '@orbit/shared';
import {
  FEISHU_CARD_ACTIONS,
  parseQuestionField,
  questionField,
  questionOtherField,
  renderFeishuCard,
  type FeishuAlert,
  type FeishuCard,
} from './cards/feishu-cards';
import { answersFromForm } from './feishu-card-actions';

/**
 * The agent's question on its Feishu card (docs/feishu-bot-design.md §6.1, §6.4, §7.2; task F2-2): in TITLES_ONLY the
 * card has only Open in Orbit, in FULL it has a form per question, and a submitted form reads back into the web app's
 * `QuestionAnswers` against the approval's own input.
 */

const URL = 'https://orbit.example/sessions/s1';
const ctx = (detail: FeishuMessageDetail, approvalsInFeishu = true) => ({ detail, approvalsInFeishu, openUrl: URL });

const INPUT = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'Postgres', description: 'the one we run' }, { label: 'SQLite' }],
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      multiSelect: true,
      options: [{ label: 'Unit' }, { label: 'Lint' }, { label: 'E2E' }],
    },
  ],
};
const alert = (input: unknown = INPUT, toolName = 'AskUserQuestion'): FeishuAlert => ({
  kind: 'approval', sessionTitle: 'Pick a database', approvals: [{ id: 'q1', toolName, input }],
});

function tagged(value: unknown, tag: string): Record<string, any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (Array.isArray(value)) return value.flatMap((v) => tagged(v, tag));
  if (!value || typeof value !== 'object') return [];
  const self = (value as { tag?: unknown }).tag === tag ? [value as Record<string, unknown>] : [];
  return [...self, ...Object.values(value).flatMap((v) => tagged(v, tag))];
}

/** Every control on a card that does anything other than open Orbit: what the owner could answer with. */
function answerControls(card: FeishuCard): string[] {
  const out: string[] = [];
  for (const tag of ['form', 'select_static', 'multi_select_static', 'input', 'checker']) {
    if (tagged(card, tag).length > 0) out.push(tag);
  }
  for (const button of tagged(card, 'button')) {
    const behaviors = (button.behaviors as { type: string }[] | undefined) ?? [];
    if (behaviors.length === 0 || behaviors.some((b) => b.type !== 'open_url')) out.push(JSON.stringify(button));
  }
  return out;
}
const openUrls = (card: FeishuCard): string[] =>
  tagged(card, 'button').flatMap((b) => (b.behaviors as { type: string; default_url?: string }[])
    .filter((x) => x.type === 'open_url').map((x) => x.default_url!));

test('TITLES_ONLY: the question card has no answer control, only Open in Orbit, and shows no question', () => {
  for (const approvalsInFeishu of [true, false]) {
    const card = renderFeishuCard(alert(), ctx('TITLES_ONLY', approvalsInFeishu));
    assert.deepEqual(answerControls(card), [], `approvalsInFeishu ${approvalsInFeishu}`);
    assert.deepEqual(openUrls(card), [URL]);
    const json = JSON.stringify(card);
    for (const word of ['Which database?', 'Postgres', 'SQLite', 'Checks', 'Lint']) assert.ok(!json.includes(word), word);
    assert.ok(json.includes('The agent asked you a question'));
  }
});

test('FULL: one form per question card — a single or multi select per question, a box of one\'s own, and Submit', () => {
  const card = renderFeishuCard(alert(), ctx('FULL'));
  const [form, ...more] = tagged(card, 'form');
  assert.deepEqual(more, []);
  assert.equal(form!.name, 'answer_0');
  const single = tagged(form, 'select_static');
  const multi = tagged(form, 'multi_select_static');
  assert.deepEqual(single.map((s) => s.name), [questionField(0, 0)]);
  assert.deepEqual(multi.map((s) => s.name), [questionField(0, 1)]);
  assert.deepEqual(single[0]!.options.map((o: { text: { content: string }; value: string }) => [o.text.content, o.value]), [['Postgres', '0'], ['SQLite', '1']]);
  assert.deepEqual(multi[0]!.options.map((o: { value: string }) => o.value), ['0', '1', '2']);
  assert.deepEqual(tagged(form, 'input').map((i) => i.name), [questionOtherField(0, 0), questionOtherField(0, 1)]);
  const [submit] = tagged(form, 'button');
  assert.equal(submit!.form_action_type, 'submit');
  assert.deepEqual(submit!.behaviors, [{ type: 'callback', value: { action: FEISHU_CARD_ACTIONS.answer, approvalId: 'q1' } }]);
  // Each question is labelled inside the form.
  assert.ok(JSON.stringify(form).includes('"Database"') && JSON.stringify(form).includes('"Checks"'));
  // Every interactive name is unique on the card, also with two questions' forms on one card.
  const two = renderFeishuCard({
    kind: 'approval', sessionTitle: 'S',
    approvals: [{ id: 'q1', toolName: 'AskUserQuestion', input: INPUT }, { id: 'q2', toolName: 'AskUserQuestion', input: INPUT }],
  }, ctx('FULL'));
  const names = ['form', 'select_static', 'multi_select_static', 'input', 'button'].flatMap((tag) => tagged(two, tag).map((e) => e.name)).filter(Boolean);
  assert.equal(new Set(names).size, names.length, names.join(', '));
  // Approvals in Feishu off: the question is shown, but there is nothing to answer with.
  assert.deepEqual(answerControls(renderFeishuCard(alert(), ctx('FULL', false))), []);
});

test('field names read back as their question', () => {
  assert.deepEqual(parseQuestionField(questionField(3, 1)), { question: 1, other: false });
  assert.deepEqual(parseQuestionField(questionOtherField(0, 2)), { question: 2, other: true });
  assert.equal(parseQuestionField('submit'), null);
  assert.equal(parseQuestionField('q0'), null);
});

test('a submitted form becomes the web app\'s QuestionAnswers, in the agent\'s own labels', () => {
  // Single select.
  assert.deepEqual(answersFromForm(INPUT, { a0_q0: '1', a0_q1: ['0'] }), { 'Which database?': ['SQLite'], 'Which checks should run?': ['Unit'] });
  // Multi select, and a typed answer joining the picks.
  assert.deepEqual(
    answersFromForm(INPUT, { a0_q0: '0', a0_q1: ['2', '0'], a0_q1_other: '  Smoke  ' }),
    { 'Which database?': ['Postgres'], 'Which checks should run?': ['E2E', 'Unit', 'Smoke'] },
  );
  // Other text on a single select replaces the pick; alone it is the answer.
  assert.deepEqual(answersFromForm(INPUT, { a0_q0: '0', a0_q0_other: 'MySQL', a0_q1_other: 'None' }), {
    'Which database?': ['MySQL'], 'Which checks should run?': ['None'],
  });
  // The section prefix does not matter: a submission holds only its own form's fields.
  assert.deepEqual(answersFromForm(INPUT, { a2_q0: '0', a2_q1: ['1'] }), { 'Which database?': ['Postgres'], 'Which checks should run?': ['Lint'] });
  // A value that names no option is no answer, nor is blank text; a question left with nothing sends nothing.
  assert.equal(answersFromForm(INPUT, { a0_q0: '0' }), null);
  assert.equal(answersFromForm(INPUT, { a0_q0: '7', a0_q1: ['0'] }), null);
  assert.equal(answersFromForm(INPUT, { a0_q0: '0', a0_q1: [], a0_q1_other: '   ' }), null);
  assert.equal(answersFromForm(INPUT, { a0_q0: 'Postgres', a0_q1: ['0'] }), null, 'a label sent as the value is not taken');
  // Duplicated picks count once.
  assert.deepEqual(answersFromForm(INPUT, { a0_q0: '0', a0_q1: ['1', '1'] })?.['Which checks should run?'], ['Lint']);
  // No questions: nothing to answer.
  assert.equal(answersFromForm({ command: 'ls' }, { a0_q0: '0' }), null);
  assert.equal(answersFromForm(null, {}), null);
});
