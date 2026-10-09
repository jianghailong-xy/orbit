// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWERED_BY_YOU,
  ANSWERED_HEADING,
  AnsweredQuestionCard,
  COORDINATOR_WITHDREW,
  DELIVERED_TO_COORDINATOR,
  FROM_COORDINATOR,
  OTHER_OPTION,
  RECOMMENDED,
  VIEW_DETAILS,
  WAITING_FOR_COORDINATOR,
  WITHDRAWN_BY_COORDINATOR,
  WITHDRAWN_BY_YOU,
  WITHDRAWN_HEADING,
  YOUR_ANSWER,
  YOUR_NOTE,
  YOU_WITHDREW,
  answeredHere,
  closedQuestionFooter,
  closedQuestionLead,
  closedQuestionLines,
  closedQuestionRows,
  type ProjectClosedQuestion,
  type ProjectOpenItemRow,
} from './CoordinatorQuestionCard';
import { decisionReceiptTime } from './EvidenceDecisionCard';

/**
 * WHAT A COORDINATOR'S QUESTION BECOMES ONCE IT HAS ENDED (contract §5.2 R10, R12;
 * `docs/mocks/coordinator-question-answered/`).
 *
 * The read carries every question that was answered or withdrawn (`closedQuestions`), and the
 * coordinator's conversation draws each as a record at the moment it ended: the question's opening
 * and how it ended on the card, the question and every option replayed in its review. Before this a
 * press left a line that lived in the page — a reload, another window or another device had nothing
 * — and the card vanished the moment the read stopped listing the question.
 */

const ITEM_ID = '4BLRNxGq7TOI1lIiOh4g1j';
const ASKED_AT = '2026-10-09T00:10:00.000Z';
const ANSWERED_AT = '2026-10-09T00:29:36.828Z';
const NOW = new Date('2026-10-09T01:00:00.000Z');

const QUESTION = [
  '灰度回退之后的收尾都做完了：',
  '',
  '- 新版本部署之后，维护任务恢复了',
  '- **三处修复**都已经在生产上',
  '',
  '请批准重开灰度。',
].join('\n');
const OPTIONS = [
  { label: '现在重开，接受这个代价', description: '不专门挑时间。' },
  { label: '等新一轮刚开始时再切', description: '盯着下一轮维护一开始就切。' },
  { label: '先不重开' },
];

function record(over: Partial<ProjectClosedQuestion> = {}): ProjectClosedQuestion {
  return {
    itemId: ITEM_ID,
    question: {
      question: QUESTION,
      options: OPTIONS,
      recommendedOption: 0,
      blocksTaskIds: ['34OEEALk90Y2HUbjSmS9P'],
      ifUnanswered: 'the rollout stays paused',
    },
    askedAt: ASKED_AT,
    resolution: 'ANSWERED',
    resolvedBy: 'USER',
    resolvedAt: ANSWERED_AT,
    answer: { option: 0, text: null },
    delivery: { sessionId: '34OAa5LxnQ1JXpUOfN21W', at: ANSWERED_AT },
    withdrawReason: null,
    ...over,
  };
}

const free = (over: Partial<ProjectClosedQuestion> = {}): ProjectClosedQuestion =>
  record({
    question: {
      question: '文章重写排在夜里还是白天？',
      options: [],
      recommendedOption: null,
      blocksTaskIds: [],
      ifUnanswered: null,
    },
    answer: { option: null, text: '夜里跑，出了问题等我早上看。' },
    ...over,
  });

const withdrawn = (over: Partial<ProjectClosedQuestion> = {}): ProjectClosedQuestion =>
  record({
    resolution: 'WITHDRAWN',
    resolvedBy: 'COORDINATOR',
    answer: null,
    delivery: null,
    withdrawReason: '灰度已经回退，这一步不需要了。',
    ...over,
  });

describe('the lines on the card', () => {
  it('opens with the question as plain text, its Markdown marks gone', () => {
    expect(closedQuestionLead(record().question)).toBe(
      '灰度回退之后的收尾都做完了： 新版本部署之后，维护任务恢复了 三处修复都已经在生产上 请批准重开灰度。',
    );
  });

  it('an option alone: its label, and nothing owed', () => {
    expect(closedQuestionLines(record())).toEqual({
      answer: '现在重开，接受这个代价',
      note: null,
      waiting: null,
      withdrew: null,
      reason: null,
    });
  });

  it('an option and a note: the label, then the note in quotes on a line of its own', () => {
    const lines = closedQuestionLines(record({ answer: { option: 1, text: ' 今晚 22 点以后再切。 ' } }));
    expect(lines.answer).toBe('等新一轮刚开始时再切');
    expect(lines.note).toBe('“今晚 22 点以后再切。”');
  });

  it('the Other row: the owner’s own words, quoted, as the answer', () => {
    const lines = closedQuestionLines(record({ answer: { option: null, text: '先别取文件。' } }));
    expect(lines.answer).toBe('“先别取文件。”');
    expect(lines.note).toBeNull();
  });

  it('a question with no options: the words, quoted', () => {
    expect(closedQuestionLines(free()).answer).toBe('“夜里跑，出了问题等我早上看。”');
  });

  it('an answer no coordinator has had yet says so', () => {
    expect(closedQuestionLines(record({ delivery: null })).waiting).toBe(WAITING_FOR_COORDINATOR);
  });

  it('withdrawn: who took it back and why, and no answer', () => {
    expect(closedQuestionLines(withdrawn())).toEqual({
      answer: null,
      note: null,
      waiting: null,
      withdrew: COORDINATOR_WITHDREW,
      reason: '“灰度已经回退，这一步不需要了。”',
    });
    expect(closedQuestionLines(withdrawn({ resolvedBy: 'USER' })).withdrew).toBe(YOU_WITHDREW);
  });
});

describe('the footer, where Send answer was', () => {
  const at = decisionReceiptTime(ANSWERED_AT, NOW);

  it('says who answered and when, and where the answer went', () => {
    expect(closedQuestionFooter(record(), NOW)).toEqual({
      line: `${ANSWERED_BY_YOU} · ${at}`,
      detail: DELIVERED_TO_COORDINATOR,
      waiting: false,
    });
    expect(closedQuestionFooter(record({ delivery: null }), NOW)).toEqual({
      line: `${ANSWERED_BY_YOU} · ${at}`,
      detail: WAITING_FOR_COORDINATOR,
      waiting: true,
    });
  });

  it('a withdrawn one says who withdrew it, when, and why', () => {
    expect(closedQuestionFooter(withdrawn(), NOW)).toEqual({
      line: `${WITHDRAWN_BY_COORDINATOR} · ${at}`,
      detail: '“灰度已经回退，这一步不需要了。”',
      waiting: false,
    });
    expect(closedQuestionFooter(withdrawn({ resolvedBy: 'USER' }), NOW).line).toBe(
      `${WITHDRAWN_BY_YOU} · ${at}`,
    );
  });

  it('carries the date as well once the answer is not today’s', () => {
    const later = new Date('2026-10-12T09:00:00.000Z');
    expect(closedQuestionFooter(record(), later).line).toBe(
      `${ANSWERED_BY_YOU} · ${decisionReceiptTime(ANSWERED_AT, later)}`,
    );
    expect(decisionReceiptTime(ANSWERED_AT, later)).not.toBe(decisionReceiptTime(ANSWERED_AT, NOW));
  });
});

describe('where the conversation draws it', () => {
  const events = [
    { seq: 1, ts: '2026-10-09T00:05:00.000Z' },
    { seq: 2, ts: '2026-10-09T00:20:00.000Z' },
    { seq: 3, ts: '2026-10-09T00:40:00.000Z' },
  ];

  it('at the moment it ended, after the last event at or before it', () => {
    const rows = closedQuestionRows({ needsYou: [], withCoordinator: [], closedQuestions: [record()] }, events);
    expect(rows).toEqual([{ record: record(), placement: 2 }]);
  });

  it('at the head of the window when it is older than every event loaded, and nowhere when its stamp is unreadable', () => {
    const old = record({ resolvedAt: '2026-10-08T22:05:00.000Z' });
    const broken = record({ itemId: 'broken', resolvedAt: 'not a time' });
    expect(
      closedQuestionRows({ needsYou: [], withCoordinator: [], closedQuestions: [old, broken] }, events),
    ).toEqual([{ record: old, placement: 'head' }]);
  });

  it('draws nothing for a read that predates the records', () => {
    expect(closedQuestionRows({ needsYou: [], withCoordinator: [] }, events)).toEqual([]);
    expect(closedQuestionRows(null, events)).toEqual([]);
  });
});

describe('the answer this window just sent', () => {
  it('is the record the read will publish, built from the question it was about', () => {
    const asked: ProjectOpenItemRow = {
      itemId: ITEM_ID,
      kind: 'COORDINATOR_QUESTION',
      title: 'Coordinator asks: …',
      detailLine: '',
      assignee: 'OWNER',
      assigneeReason: 'DEFAULT',
      waitingSince: ASKED_AT,
      escalateAt: null,
      escalatedAt: null,
      taskId: null,
      sessionId: null,
      promotionId: null,
      fuseEpisodeId: null,
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
      actions: ['ANSWER'],
      facts: null,
      question: record().question,
    };
    const sent = answeredHere(
      asked,
      record().question,
      { option: 1, text: 'tonight' },
      { itemId: ITEM_ID, state: 'RESOLVED', resolution: 'ANSWERED', delivery: { sessionId: 's1', turnId: 't1' } },
      new Date(ANSWERED_AT),
    );
    expect(sent).toEqual(record({
      answer: { option: 1, text: 'tonight' },
      delivery: { sessionId: 's1', at: ANSWERED_AT },
    }));
    expect(
      answeredHere(asked, record().question, { text: 'later' },
        { itemId: ITEM_ID, state: 'RESOLVED', resolution: 'ANSWERED', delivery: null },
        new Date(ANSWERED_AT)).delivery,
    ).toBeNull();
  });
});

describe('the card and its review', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function draw(drawn: ProjectClosedQuestion) {
    await act(async () => {
      root.render(<AnsweredQuestionCard record={drawn} now={NOW} />);
    });
  }

  const card = (): string => host.querySelector('.answered-question-card')?.textContent ?? '';
  /** The review is mounted behind the card (`ReviewCard` keeps it) — wherever its dialog is. */
  const reviewEl = (): Element | null => document.querySelector(`[data-question-record="${ITEM_ID}"]`);
  const review = (): string => reviewEl()?.textContent ?? '';
  const chosen = (): string[] =>
    [...(reviewEl()?.querySelectorAll('.answered-question-option.is-chosen') ?? [])]
      .map((row) => row.querySelector('.answered-question-option-label')?.textContent ?? '');

  it('an option alone: heading and time, the question’s opening, the option ticked', async () => {
    await draw(record());
    expect(card()).toContain(ANSWERED_HEADING);
    expect(card()).toContain(decisionReceiptTime(ANSWERED_AT, NOW));
    expect(host.querySelector('.answered-question-lead')?.textContent).toBe(closedQuestionLead(record().question));
    expect(host.querySelector('.answered-question-answer')?.textContent).toBe('现在重开，接受这个代价');
    expect(host.querySelector('.answered-question-note')).toBeNull();
    expect(host.querySelector('.answered-question-waiting')).toBeNull();
    expect(card()).toContain(VIEW_DETAILS);

    // The review replays it: the mark, when it was asked, every option with its reason, the
    // recommendation where the coordinator put it, the one chosen ticked — and no line about what
    // the question blocked while it waited.
    expect(review()).toContain(FROM_COORDINATOR);
    expect(review()).toContain(`asked ${decisionReceiptTime(ASKED_AT, NOW)}`);
    expect(reviewEl()?.querySelector('.coordinator-question-text li')?.textContent).toBe(
      '新版本部署之后，维护任务恢复了',
    );
    for (const option of OPTIONS) expect(review()).toContain(option.label);
    expect(review()).toContain('盯着下一轮维护一开始就切。');
    expect(reviewEl()?.querySelectorAll('.answered-question-recommended')).toHaveLength(1);
    expect(review()).toContain(RECOMMENDED);
    expect(chosen()).toEqual(['现在重开，接受这个代价']);
    expect(review()).not.toContain('the rollout stays paused');
    expect(review()).toContain(`${ANSWERED_BY_YOU} · ${decisionReceiptTime(ANSWERED_AT, NOW)}`);
    expect(review()).toContain(DELIVERED_TO_COORDINATOR);
  });

  it('an option and a note: the note under the answer, and inside the chosen option', async () => {
    await draw(record({ answer: { option: 1, text: '今晚 22 点以后再切，白天有人在用。' } }));
    expect(host.querySelector('.answered-question-answer')?.textContent).toBe('等新一轮刚开始时再切');
    expect(host.querySelector('.answered-question-note')?.textContent).toBe('“今晚 22 点以后再切，白天有人在用。”');
    expect(chosen()).toEqual(['等新一轮刚开始时再切']);
    const inside = reviewEl()?.querySelector('.answered-question-option.is-chosen .answered-question-words');
    expect(inside?.textContent).toBe(`${YOUR_NOTE}今晚 22 点以后再切，白天有人在用。`);
  });

  it('the Other row: the words as the answer, and the Other row ticked over them', async () => {
    await draw(record({ answer: { option: null, text: '先别取文件，等我明天看过导出脚本再说。' } }));
    expect(host.querySelector('.answered-question-answer')?.textContent).toBe(
      '“先别取文件，等我明天看过导出脚本再说。”',
    );
    expect(chosen()).toEqual([OTHER_OPTION]);
    expect(review()).toContain(`${OTHER_OPTION}先别取文件，等我明天看过导出脚本再说。`);
    expect(review()).not.toContain(YOUR_NOTE);
  });

  it('a question with no options: the words, and a read-only Your answer box', async () => {
    await draw(free());
    expect(host.querySelector('.answered-question-answer')?.textContent).toBe('“夜里跑，出了问题等我早上看。”');
    expect(chosen()).toEqual([]);
    expect(reviewEl()?.querySelector('.answered-question-words.is-free')?.textContent).toBe(
      `${YOUR_ANSWER}夜里跑，出了问题等我早上看。`,
    );
    expect(reviewEl()?.querySelector('textarea')).toBeNull();
  });

  it('waiting for a coordinator: the orange line on the card and in the footer', async () => {
    await draw(record({ delivery: null }));
    expect(host.querySelector('.answered-question-waiting')?.textContent).toContain(WAITING_FOR_COORDINATOR);
    expect(reviewEl()?.querySelector('.answered-question-footer-detail.is-waiting')?.textContent).toBe(
      WAITING_FOR_COORDINATOR,
    );
  });

  it('withdrawn: its heading, who withdrew it and why, and the options with nothing ticked', async () => {
    await draw(withdrawn());
    expect(card()).toContain(WITHDRAWN_HEADING);
    expect(host.querySelector('.answered-question-card.is-withdrawn')).not.toBeNull();
    expect(host.querySelector('.answered-question-answer')).toBeNull();
    expect(host.querySelector('.answered-question-withdrew')?.textContent).toBe(COORDINATOR_WITHDREW);
    expect(host.querySelector('.answered-question-reason')?.textContent).toBe('“灰度已经回退，这一步不需要了。”');
    for (const option of OPTIONS) expect(review()).toContain(option.label);
    expect(chosen()).toEqual([]);
    expect(review()).toContain(`${WITHDRAWN_BY_COORDINATOR} · ${decisionReceiptTime(ANSWERED_AT, NOW)}`);
    expect(review()).not.toContain(ANSWERED_BY_YOU);
  });
});

describe('where the records are drawn from', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const source = (file: string): string => {
    const found = [`src/${file}`, `src/web/src/${file}`]
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    if (!found) throw new Error(`${file} is not under ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('the coordinator’s conversation draws each from the read, where it ended', () => {
    const view = source('components/WorkspaceView.tsx');
    expect(view, 'the records are not read off the open items').toContain(
      'closedQuestionRows(openItems.data, transcriptEvents)',
    );
    expect(view, 'the row is not drawn as the record card').toContain('element: <AnsweredQuestionCard');
    expect(view, 'the records are not handed to the transcript').toMatch(
      /const transcriptInserts = useMemo\(\s*\(\) => \[[^\]]*\.\.\.questionRecords/,
    );
  });

  it('the project page lists only the questions still waiting for the owner', () => {
    expect(source('pages/ProjectsPage.tsx')).not.toContain('AnsweredQuestionCard');
    expect(source('pages/ProjectsPage.tsx')).not.toContain('closedQuestions');
  });
});
