// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfirmationUnderReview, OwnerConfirmationReviewView } from '@orbit/shared';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerConfirmationQuery } from '../lib/queries';
import { parseConfirmationReturn, parseConfirmationReviewRequest } from '../lib/confirmationReviewTurns';
import { ReviewRequestedCard, SentBackByReviewerCard, OPEN_TASK_SESSION } from './ConfirmationReviewTurnCards';
import { DecisionStrip, type PendingDecisionQueue } from './DecisionRail';
import {
  OWNER_CONFIRMATION_AUTHORSHIP_TITLE,
  OWNER_CONFIRMATION_STALE_CODES,
  OWNER_CONFIRM_ACTION,
  OWNER_SEND_BACK_ACTION,
  OwnerConfirmationCard,
  OwnerDecisionReceipt,
  ReviewerReturnRecord,
  SessionOwnerConfirmationCard,
  ownerDecisionRefusal,
  ownerDecisionRequest,
  reviewerReturnsIn,
  type OwnerConfirmationView,
  type OwnerConfirmationWaiting,
  type RecordedOwnerDecision,
} from './OwnerConfirmationCard';
import {
  ANSWERS_SENT_WITH_CONFIRM,
  ANSWER_NOT_SHOWN,
  BEFORE_REVIEW,
  REVIEW_EVIDENCE,
  REVIEW_REQUESTED,
  REVIEW_WILL_ASK,
  SENT_BACK_BY_REVIEWER,
  SHOW_OLD_REVIEW,
  UNDER_REVIEW,
  YOUR_ANSWERS,
  ownerAnswerLines,
  reviewAnswered,
  reviewAnswersComplete,
  reviewBar,
  reviewCameInAfter,
  reviewWindowWords,
  type ReviewChoices,
  type ReviewPlace,
} from './OwnerConfirmationReview';
import { OTHER_OPTION, RECOMMENDED } from './CoordinatorQuestionCard';
import { sessionLine, statusLabel } from './WorkspaceView';

/**
 * The owner-confirmation card's review bar (docs/owner-confirmation-review-contract.md §6–§9): the
 * lines it draws in each state, proved against the fixture OrbitKit is proved against too; the
 * answers a confirmation carries; the receipt's late review with Reopen task; the record a returned
 * report becomes; the two turns a review puts into a conversation; and the rows that say "Under
 * review" without lighting.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const fixture = JSON.parse(
  readFileSync(
    [
      resolve(process.cwd(), '../shared/src/owner-confirmation-review.fixture.json'),
      resolve(process.cwd(), 'src/shared/src/owner-confirmation-review.fixture.json'),
    ].find((path) => existsSync(path)) as string,
    'utf8',
  ),
);

/** The fixture's clock: an instant's UTC hours and minutes. */
const utcClock = (iso: string): string | null => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
};

const TASK_ID = '34PfK2xQ9aB7cD1eF3gH5';
const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const REQUEST_ID = '01920000-0000-7000-8000-0000000000f1';

/** A fixture review by the start of its case's name. */
function review(starting: string): OwnerConfirmationReviewView {
  const found = (fixture.bars as Array<{ case: string; review: OwnerConfirmationReviewView }>)
    .find((each) => each.case.startsWith(starting));
  if (!found) throw new Error(`no fixture case starts with ${starting}`);
  return structuredClone(found.review);
}

function waiting(over: Partial<OwnerConfirmationWaiting> = {}): OwnerConfirmationWaiting {
  return {
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    requestedAt: '2026-10-02T14:55:00.000Z',
    report: { text: 'All six P1 review findings are fixed.', reportedAt: '2026-10-02T14:54:00.000Z' },
    ...over,
  };
}

function view(over: Partial<OwnerConfirmationView> = {}): OwnerConfirmationView {
  return {
    taskId: TASK_ID,
    title: '会话间请求与回复：修复 P1 审查发现的问题',
    status: 'OPEN',
    projectId: null,
    completionCriterion: 'OWNER_CONFIRMED',
    acceptanceCriteria: '1. Every P1 finding is fixed.',
    waiting: waiting(),
    decisions: [],
    ...over,
  };
}

function decided(over: Partial<RecordedOwnerDecision> = {}): RecordedOwnerDecision {
  return {
    id: 'decision-1',
    decision: 'CONFIRM',
    note: null,
    decidedAt: '2026-10-02T15:00:49.000Z',
    decidedByType: 'USER',
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    report: null,
    ...over,
  };
}

/** A string as it appears in the markup rather than as it is written in source. */
function escaped(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#x27;');
}

const clients: QueryClient[] = [];
function newClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
  clients.push(qc);
  return qc;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  for (const qc of clients.splice(0)) qc.clear();
  apiMock.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The Other row's box sizes itself to its text; jsdom has no layout observer of its own.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const nextRoot = createRoot(node);
  container = node;
  root = nextRoot;
  await act(async () => nextRoot.render(ui));
  return node;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].filter((button) => {
    const hint = button.querySelector('.approval-kbd')?.textContent ?? '';
    return (button.textContent ?? '').replace(hint, '').trim() === label;
  });
  expect(found.length, `buttons labelled ${label}`).toBe(1);
  return found[0] as HTMLButtonElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

/** Types into a textarea as React listens for it. */
async function type(area: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function posts(): unknown[] {
  return apiMock.mock.calls
    .filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST')
    .map(([, options]) => (options as { body?: unknown }).body);
}

describe('the review bar, line for line (shared fixture)', () => {
  it('draws each state where it is drawn, as OrbitKit does', () => {
    expect(fixture.bars.length).toBeGreaterThan(15);
    for (const each of fixture.bars as Array<{ case: string; place: ReviewPlace; review: OwnerConfirmationReviewView; bar: unknown }>) {
      expect(reviewBar(each.review, each.place, utcClock), each.case).toEqual(each.bar);
    }
  });

  it('says a window the way the not-reviewed line says it', () => {
    for (const each of fixture.windows as Array<{ seconds: number; words: string }>) {
      expect(reviewWindowWords(each.seconds), String(each.seconds)).toBe(each.words);
    }
  });

  it('sends the record the card drew and an answer to each question, with a confirmation only', () => {
    for (const each of fixture.requests as Array<{
      case: string;
      decision: 'CONFIRM' | 'SEND_BACK';
      requestId: string;
      note?: string;
      review: OwnerConfirmationReviewView | null;
      choices: ReviewChoices;
      body: unknown;
      complete: boolean;
    }>) {
      const request = ownerDecisionRequest(TASK_ID, each.requestId, each.decision, each.note,
        reviewAnswered(each.review, each.choices));
      expect(request.body, each.case).toEqual(each.body);
      expect(reviewAnswersComplete(each.review, each.choices), each.case).toBe(each.complete);
    }
  });

  it('lists the answers a receipt shows, and says when the review came in after the decision', () => {
    for (const each of fixture.answers as Array<{
      case: string;
      decided: RecordedOwnerDecision;
      lines: unknown;
      before: boolean;
    }>) {
      expect(ownerAnswerLines(each.decided), each.case).toEqual(each.lines);
      expect(reviewCameInAfter(each.decided), each.case).toBe(each.before);
    }
  });
});

describe('the card with a review', () => {
  it('draws the bar between what the agent said and If you confirm, and locks nothing (phone ③)', () => {
    const html = renderToStaticMarkup(
      <OwnerConfirmationCard
        view={view({ ifConfirmed: { startsTasks: [{ id: 't2', title: 'Next', starts: 'NOW' }] } })}
        waiting={waiting({ review: review('under review on the card') })}
        onDecide={() => {}}
        onSendBack={() => {}}
      />,
    );
    const said = html.indexOf('WHAT THE AGENT SAID');
    const bar = html.indexOf('data-review-state="UNDER_REVIEW"');
    const consequences = html.indexOf('IF YOU CONFIRM');
    expect(said).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(said);
    expect(consequences).toBeGreaterThan(bar);
    expect(html).toContain('会话间消息参数与回复设计');
    expect(html).toContain(REVIEW_WILL_ASK);
    // The buttons are the buttons of a card with no review: neither is held back while it is reviewed.
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Confirm done/u);
    // The mark says who composed the card, now that two of its boxes are somebody else's words.
    expect(html).toContain(escaped(OWNER_CONFIRMATION_AUTHORSHIP_TITLE));
  });

  it('puts what is left first and the reviewer last, quoted (phone ④, option B)', () => {
    const html = renderToStaticMarkup(
      <OwnerConfirmationCard
        view={view()}
        waiting={waiting({ review: review('reviewed, nothing needs you') })}
        onDecide={() => {}}
        onSendBack={() => {}}
      />,
    );
    const headline = html.indexOf('1 not checked · nothing needs you');
    const checked = html.indexOf('>Checked<');
    const quote = html.indexOf(escaped('“OK to confirm. Merge after JS runs on CI.”'));
    expect(headline).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(headline);
    expect(quote).toBeGreaterThan(checked);
    expect(html).toContain('59d9815');
    expect(html).toContain('Criteria 1–6 · PG 2298/2298');
  });

  it('asks the questions one by one, recommendation chosen, and sends the answers with Confirm done', async () => {
    const qc = newClient();
    const reviewed = review('reviewed with questions for the owner, on the card');
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view({ waiting: waiting({ review: reviewed }) }));
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'CONFIRM', completed: true });
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard sessionId={SESSION_ID} taskId={TASK_ID} onSendBack={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(scope.textContent).toContain('Needs you: the 50/hour cap can overshoot — ship as is? (+1 more)');
    // Each question's recommendation is chosen and marked; the second question says its own words.
    const radios = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false, false, true, false]);
    expect(scope.textContent?.match(new RegExp(RECOMMENDED, 'gu'))?.length).toBe(2);
    expect(scope.textContent).toContain('Rename P1’s field now or later?');
    expect(scope.textContent?.match(new RegExp(OTHER_OPTION, 'gu'))?.length).toBe(2);
    expect(scope.textContent).toContain(ANSWERS_SENT_WITH_CONFIRM);
    expect(scope.textContent).toContain(REVIEW_EVIDENCE);

    // Other with no words yet: Confirm done would be refused, so it is disabled — and only it.
    await click(radios[5]);
    expect(buttonIn(scope, OWNER_CONFIRM_ACTION).disabled).toBe(true);
    expect(buttonIn(scope, OWNER_SEND_BACK_ACTION).disabled).toBe(false);
    await type(scope.querySelector('textarea')!, '  Now, with a note in the changelog.  ');
    expect(buttonIn(scope, OWNER_CONFIRM_ACTION).disabled).toBe(false);
    await click(radios[1]);

    await click(buttonIn(scope, OWNER_CONFIRM_ACTION));
    expect(posts()).toEqual([{
      decision: 'CONFIRM',
      requestId: REQUEST_ID,
      reviewRecordId: 'rec1',
      answers: [
        { key: 'n1', option: 1 },
        { key: 'n2', text: 'Now, with a note in the changelog.' },
      ],
    }]);
  });

  it('sends the key with no record behind it while the review is under way', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey,
      view({ waiting: waiting({ review: review('under review on the card') }) }));
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'CONFIRM', completed: true });
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard sessionId={SESSION_ID} taskId={TASK_ID} onSendBack={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await click(buttonIn(scope, OWNER_CONFIRM_ACTION));
    expect(posts()).toEqual([{ decision: 'CONFIRM', requestId: REQUEST_ID, reviewRecordId: null }]);
  });

  it('folds an outdated review away and asks none of its old questions', async () => {
    const scope = await mount(
      <OwnerConfirmationCard
        view={view()}
        waiting={waiting({ review: review('outdated: a newer report replaced the one reviewed') })}
        onDecide={() => {}}
        onSendBack={() => {}}
      />,
    );
    expect(scope.textContent).toContain('Written for an earlier report.');
    expect(scope.textContent).not.toContain('Keep the old column?');
    expect(scope.querySelector('.owner-confirmation-review-sha.is-struck')).toBeNull();
    await click(buttonIn(scope, SHOW_OLD_REVIEW));
    expect(scope.textContent).toContain('Needs you: Keep the old column?');
    expect(scope.querySelectorAll('input[type="radio"]').length).toBe(0);
  });

  it('opens a list to each of its lines and what they rest on', async () => {
    const scope = await mount(
      <OwnerConfirmationCard
        view={view()}
        waiting={waiting({ review: review('reviewed, nothing needs you') })}
        onDecide={() => {}}
        onSendBack={() => {}}
      />,
    );
    const notChecked = [...scope.querySelectorAll('.owner-confirmation-review-row')]
      .find((row) => row.textContent?.startsWith('Not checked'))!;
    expect(notChecked.textContent).not.toContain('The CI run predates the web change.');
    await click(notChecked);
    expect(notChecked.textContent).toContain('JS tests never ran on CI');
    expect(notChecked.textContent).toContain('The CI run predates the web change.');
    expect(notChecked.textContent).toContain('Ran the card');
  });

  it('reads the two refusals a review adds as an out-of-date card', () => {
    for (const code of ['OWNER_CONFIRMATION_REVIEW_STALE', 'OWNER_CONFIRMATION_ANSWERS_REQUIRED']) {
      expect(OWNER_CONFIRMATION_STALE_CODES).toContain(code);
      expect(ownerDecisionRefusal(Object.assign(new Error('x'), { code }))).toEqual({
        stale: true,
        title: 'Not recorded: this card is out of date',
      });
    }
  });
});

describe('the receipt, when the review came in after the decision', () => {
  it('draws the review under it, with Reopen task once the task has settled (second row)', () => {
    const late = (fixture.answers as Array<{ case: string; decided: RecordedOwnerDecision }>)
      .find((each) => each.case.startsWith('confirmed while it was under review'))!.decided;
    const html = renderToStaticMarkup(
      <OwnerDecisionReceipt
        view={view({ status: 'DONE' })}
        decided={late}
        reopen={<button type="button">Reopen task</button>}
      />,
    );
    expect(html).toContain('Confirmed done by you');
    expect(html).toContain(BEFORE_REVIEW);
    expect(html).toContain('1 problem found after you confirmed');
    expect(html).toContain('JS tests fail on CI');
    expect(html).toContain('>Reopen task<');
  });

  it('offers no Reopen task while nothing was found, and lists the answers it recorded', () => {
    const answered = (fixture.answers as Array<{ case: string; decided: RecordedOwnerDecision }>)
      .find((each) => each.case.startsWith('an older app recorded'))!.decided;
    const html = renderToStaticMarkup(
      <OwnerDecisionReceipt view={view()} decided={answered} reopen={<button type="button">Reopen task</button>} />,
    );
    expect(html).not.toContain('>Reopen task<');
    expect(html).not.toContain(BEFORE_REVIEW);
    expect(html).toContain(YOUR_ANSWERS);
    expect(html).toContain('Keep the old column? — Keep it');
    expect(html).toContain(ANSWER_NOT_SHOWN);
    // Under a receipt a review asks nothing: no answer controls.
    expect(html).not.toContain('type="radio"');
  });

  it('draws a receipt with no review as it always was', () => {
    const html = renderToStaticMarkup(<OwnerDecisionReceipt view={view()} decided={decided()} />);
    expect(html).not.toContain('data-review-state');
    expect(html).not.toContain(BEFORE_REVIEW);
  });
});

describe('a report its reviewer sent back', () => {
  const returned = review('returned by the reviewer');

  it('becomes a record of the session it was asked in, with no buttons at all', () => {
    const read = view({
      waiting: null,
      reviewerReturns: [{ requestId: REQUEST_ID, sessionId: SESSION_ID, requestedAt: '2026-10-02T14:55:00.000Z', review: returned }],
    });
    expect(reviewerReturnsIn(read, SESSION_ID).map((each) => each.requestId)).toEqual([REQUEST_ID]);
    expect(reviewerReturnsIn(read, 'another-session')).toEqual([]);
    const html = renderToStaticMarkup(<ReviewerReturnRecord view={read} returned={read.reviewerReturns![0]} />);
    expect(html).toContain('Returned to the agent');
    expect(html).toContain(escaped('“Two of the six findings are not fixed on the branch.”'));
    expect(html).toContain('P1-3 still sends the reply twice');
    expect(html).toContain('The agent got this as its next message. You were not asked.');
    expect(html).not.toContain('<button');
  });

  it('reaches the run as Sent back by the reviewer, never as the owner’s message', () => {
    const card = parseConfirmationReturn({
      text: '<orbit-confirmation-return …>',
      confirmationReturn: {
        requestId: REQUEST_ID,
        recordId: 'ret1',
        reviewerSessionId: '34ReviewerSessionAbcde',
        reviewerTitle: '会话间消息参数与回复设计',
        reason: 'Two of the six findings are not fixed on the branch.',
        problems: [{ key: 'p1', text: 'P1-3 still sends the reply twice' }],
      },
    });
    expect(card).not.toBeNull();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SentBackByReviewerCard card={card!} />
      </MemoryRouter>,
    );
    expect(html).toContain(SENT_BACK_BY_REVIEWER);
    expect(html).toContain('会话间消息参数与回复设计');
    expect(html).toContain('P1-3 still sends the reply twice');
    expect(parseConfirmationReturn({ text: 'hi' })).toBeNull();
  });

  it('asks its reviewer with a card naming the task, when it is due, and the way onto the run', () => {
    const card = parseConfirmationReviewRequest({
      text: '',
      confirmationReviewRequest: {
        requestId: REQUEST_ID,
        reviewId: 'rv1',
        taskId: TASK_ID,
        title: '会话间请求与回复：修复 P1 审查发现的问题',
        runSessionId: SESSION_ID,
        branch: 'orbit/p1-1c207b',
        sha: '59d98153ef85c565646fede291f66f61940573c7',
        dueAt: '2026-10-02T15:25:00.000Z',
      },
    });
    expect(card).not.toBeNull();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewRequestedCard card={card!} />
      </MemoryRouter>,
    );
    expect(html).toContain(REVIEW_REQUESTED);
    expect(html).toContain('会话间请求与回复：修复 P1 审查发现的问题');
    expect(html).toMatch(/Due \d/u);
    expect(html).toContain(OPEN_TASK_SESSION);
    expect(parseConfirmationReviewRequest({ confirmationReviewRequest: { requestId: 'x' } })).toBeNull();
  });
});

describe('Under review: drawn, not counted', () => {
  const underReview: ConfirmationUnderReview = {
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    reviewerSessionId: '34ReviewerSessionAbcde',
    reviewerTitle: '会话间消息参数与回复设计',
    since: '2026-10-02T14:55:00.000Z',
    dueAt: '2026-10-02T15:25:00.000Z',
  };
  const parked = { status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', pendingApprovals: 0, waitingKind: null };

  it('says who has it on the row, in the quiet tone, and Under review in the header', () => {
    const row = { ...parked, confirmationUnderReview: underReview };
    expect(sessionLine(row, true)).toEqual({ text: 'Under review · 会话间消息参数与回复设计', tone: 'review' });
    expect(statusLabel(row)).toBe(UNDER_REVIEW);
    expect(sessionLine({ ...row, confirmationUnderReview: { ...underReview, reviewerTitle: null } }, true).text)
      .toBe('Under review · Reviewer');
    // Something else waiting on the owner still outranks it, and a row without one reads as before.
    expect(sessionLine({ ...row, pendingApprovals: 1 }, true).tone).toBe('approval');
    expect(statusLabel({ ...parked, confirmationUnderReview: null })).not.toBe(UNDER_REVIEW);
  });

  it('pins no line pointing at a card that is still being reviewed', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/WorkspaceView.tsx'), 'utf8');
    expect(source).toContain("ownerWaiting && ownerConfirmation.data && ownerWaiting.review?.state !== 'UNDER_REVIEW'");
    const queue: PendingDecisionQueue = { decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [] };
    expect(renderToStaticMarkup(
      <DecisionStrip queue={queue} open={false} onToggle={() => {}} ownerConfirmation={null} />,
    )).toBe('');
  });
});

// The card's content/decision contract is tested inline; real dialogs are covered in ReviewCard.test.tsx.
vi.mock('./ReviewCard', () => import('../test/inlineReviewCard'));
