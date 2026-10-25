import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Through the package's own entry: what the clients import is the thing under test.
import {
  askedQuestions,
  QUESTION_RECORD_COPY,
  questionAnswerLine,
  questionLead,
  questionOutcome,
  questionReplyLine,
  type QuestionOutcome,
} from './index';

/**
 * `question-record.fixture.json` is the contract the web and the native client are both proved
 * against. This proves the fixture and the shared reader agree, case by case.
 */
interface OutcomeCase {
  name: string;
  questions: unknown[];
  result: string | null;
  isError: boolean;
  outcome: QuestionOutcome | null;
  lines: (string | null)[];
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'question-record.fixture.json'), 'utf8')) as {
  copy: Record<string, string>;
  lead: { question: string; lead: string }[];
  outcome: OutcomeCase[];
};

describe('the answered question card, read back from the result', () => {
  it('says the words the fixture says', () => {
    expect({ ...QUESTION_RECORD_COPY }).toEqual(fixture.copy);
  });

  it.each(fixture.lead.map((c) => [c.question, c.lead]))('leads with %j as %j', (question, lead) => {
    expect(questionLead(question)).toBe(lead);
  });

  it.each(fixture.outcome.map((c) => [c.name, c]))('%s', (_name, c) => {
    const questions = askedQuestions({ questions: c.questions });
    const outcome = questionOutcome(questions, c.result, c.isError);
    expect(outcome).toEqual(c.outcome);
    const lines =
      outcome?.kind === 'answered'
        ? questions.map((q, i) => questionAnswerLine(q, outcome.answers[i]))
        : outcome?.kind === 'replied'
          ? [questionReplyLine(outcome.words)]
          : [];
    expect(lines).toEqual(c.lines);
  });
});

describe('the questions a call asked', () => {
  it('reads what the input carries and nothing it does not', () => {
    expect(
      askedQuestions({
        questions: [
          { question: 'Ship it?', header: 'Ship', multiSelect: true, options: [{ label: 'Yes', description: '' }, { label: 'No' }] },
          { header: 7, options: 'none' },
        ],
      }),
    ).toEqual([
      {
        question: 'Ship it?',
        header: 'Ship',
        multiSelect: true,
        options: [
          { label: 'Yes', description: null },
          { label: 'No', description: null },
        ],
      },
      { question: '', header: null, multiSelect: false, options: [] },
    ]);
    expect(askedQuestions(null)).toEqual([]);
    expect(askedQuestions({ questions: 'none' })).toEqual([]);
  });
});
