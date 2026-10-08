// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_QUESTION_HEADING,
  CoordinatorQuestionCard,
  CoordinatorQuestions,
  DELIVERED_TO_COORDINATOR,
  FROM_COORDINATOR,
  NOTE_PROMPT,
  OTHER_OPTION,
  OWN_ANSWER_PROMPT,
  RECOMMENDED,
  SEND_ANSWER,
  WAITING_FOR_COORDINATOR,
  coordinatorQuestions,
  type ProjectOpenItemRow,
  type ProjectOpenItemsView,
} from './CoordinatorQuestionCard';

/**
 * The coordinator's question as a card (mock 5, contract §5.2): what it says, that it is marked as
 * the platform's rather than an agent's, and that pressing Send answer posts the option the owner
 * chose to the answer door — the one place an answer is given.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const ITEM_ID = '4BLRNxGq7TOI1lIiOh4g1j';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60 * 1000;

const QUESTION = 'Two ready tasks both rewrite session_pool.go. Which one starts first?';

function row(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: ITEM_ID,
    kind: 'COORDINATOR_QUESTION',
    title: `Coordinator asks: ${QUESTION}`,
    detailLine: 'Blocks 2 tasks · If you don’t answer: nothing starts; reminder at 2h',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    facts: null,
    waitingSince: new Date(NOW - 35 * MINUTE).toISOString(),
    question: {
      question: QUESTION,
      options: [
        { label: 'Start t4 first, then t7 once t4 lands', description: 'One conflict fewer' },
        { label: 'Start both now — expect a merge conflict to resolve' },
      ],
      recommendedOption: 0,
      blocksTaskIds: ['34OEEALk90Y2HUbjSmS9P', '34OEEAV0AnK22u1YYnnOA'],
      ifUnanswered: 'nothing starts; reminder at 2h',
    },
    ...over,
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function markup(ui: JSX.Element): string {
  return renderToStaticMarkup(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
}

describe('what the card says', () => {
  it('asks the question, marked as the platform’s and not an agent’s', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    expect(html).toContain(COORDINATOR_QUESTION_HEADING);
    expect(html).toContain(FROM_COORDINATOR);
    expect(html).toContain(QUESTION);
    expect(html).not.toContain('review-card-preview');
    expect(html).toContain(SEND_ANSWER);
  });

  it('offers the options, marks the recommended one, and says what it holds up', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    expect(html).toContain('Start t4 first, then t7 once t4 lands');
    expect(html).toContain('Start both now — expect a merge conflict to resolve');
    expect(html).toContain(RECOMMENDED);
    expect(html).toContain('Blocks 2 tasks');
    expect(html).toContain('If you don’t answer: nothing starts; reminder at 2h');
    expect(html).toContain('asked 35m ago');
  });

  it('draws the recommended option as the one already chosen', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    // The chosen row is outlined, and it is the one the coordinator recommended.
    const chosen = html.indexOf('coordinator-question-option is-chosen');
    expect(chosen).toBeGreaterThan(-1);
    expect(html.indexOf('Start t4 first')).toBeGreaterThan(chosen);
  });

  it('keeps a box beside the options, for a note on the choice', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    // The recommendation starts out chosen, so what the box takes is a note on it.
    expect(html).toContain('textarea');
    expect(html).toContain(NOTE_PROMPT);
  });

  it('ends the options with the row that means “in my own words”', () => {
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    // After every option the coordinator offered, so it reads as one more answer rather than as a
    // footnote to the last one — and the recommendation is still the chosen row, because something
    // the coordinator proposed is what the question starts out answered with.
    expect(html).toContain(OTHER_OPTION);
    expect(html.indexOf(OTHER_OPTION)).toBeGreaterThan(html.indexOf('Start both now'));
    expect(html.indexOf('coordinator-question-option is-chosen')).toBeLessThan(
      html.indexOf(OTHER_OPTION),
    );
  });

  it('grows with its question instead of scrolling inside the card', () => {
    // `.approval-body` alone is capped at 360px, and a long question with its options and the box
    // outgrows that — what spills over is the part the owner answers with.
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    expect(html).toContain('approval-body is-questions');
  });

  it('renders the question as the markdown the coordinator wrote', () => {
    // The question body arrives as Markdown (bullets, emphasis), as in the approval cards — a
    // bulleted question draws a list, not the raw "- " spelling.
    const asked = row({
      question: {
        question: 'Which fix ships first?\n\n- the anchor re-check\n- the stuck job',
        options: [],
        recommendedOption: null,
        blocksTaskIds: [],
        ifUnanswered: null,
      },
    });
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={asked} now={NOW} />);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>the anchor re-check</li>');
    expect(html).not.toContain('- the anchor re-check');
  });

  it('takes prose when the coordinator named no alternatives', () => {
    const asked = row({
      question: {
        question: 'What should the integration branch be called?',
        options: [],
        recommendedOption: null,
        blocksTaskIds: [],
        ifUnanswered: null,
      },
      detailLine: '',
    });
    const html = markup(<CoordinatorQuestionCard projectId={PROJECT_ID} row={asked} now={NOW} />);
    expect(html).toContain('What should the integration branch be called?');
    expect(html).toContain('textarea');
    expect(html).not.toContain(RECOMMENDED);
    // No options means the box is the answer, so the Other row would say nothing the card has not.
    expect(html).not.toContain(OTHER_OPTION);
  });
});

describe('which rows are questions', () => {
  it('takes the owner’s questions and leaves every other item alone', () => {
    const items: ProjectOpenItemsView = {
      needsYou: [row(), row({ itemId: 'other', kind: 'TASK_FAILED', question: null })],
      withCoordinator: [row({ itemId: 'theirs', assignee: 'COORDINATOR' })],
    };
    expect(coordinatorQuestions(items).map((r) => r.itemId)).toEqual([ITEM_ID]);
  });

  it('is nothing at all when the project has none', () => {
    expect(coordinatorQuestions({ needsYou: [], withCoordinator: [] })).toEqual([]);
    expect(coordinatorQuestions(null)).toEqual([]);
  });
});

describe('answering it', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiMock.mockReset();
    // The answer box sizes itself with a ResizeObserver, which jsdom does not have. Its height is
    // not what these tests are about.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function draw(ui: JSX.Element) {
    await act(async () => {
      root.render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
    });
  }

  /**
   * How long a wait is given before it gives up, in wall clock. The budget a file's waits have is
   * the 30s test timeout (vite.config.ts); this sits inside it, so a wait that is never satisfied
   * still fails, and fails naming what never appeared.
   */
  const UNTIL_MS = 10_000;

  /**
   * Wait for what the render is supposed to show, by the clock rather than by a count of ticks. A
   * tick is one turn of the event loop and costs whatever the machine charges for it, and 50 of them
   * cost no time at all exactly when the wait has nothing to flush — measured on the CI that reds
   * this file: 50 ticks in 0ms, with a `setTimeout(0)` armed before the first of them still unfired
   * when the last ran out. What a read needs is time, so every turn here hands the event loop a
   * macrotask — which is where a read lands: react-query notifies its subscribers through
   * `setTimeout`, and a real door answers on a macrotask too.
   */
  async function until(held: () => boolean, what: string) {
    const deadline = Date.now() + UNTIL_MS;
    for (;;) {
      if (held()) return;
      if (Date.now() >= deadline) {
        throw new Error(`never became true within ${UNTIL_MS}ms: ${what}`);
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function press(label: string) {
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.includes(label),
    );
    if (!button) throw new Error(`no ${label} button`);
    return button;
  }

  function box(): HTMLTextAreaElement {
    const field = host.querySelector('textarea');
    if (!field) throw new Error('no answer box');
    return field;
  }

  async function type(value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(box(), value);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const DELIVERED = {
    itemId: ITEM_ID,
    state: 'RESOLVED',
    resolution: 'ANSWERED',
    delivery: { sessionId: '34OAa5LxnQ1JXpUOfN21W', turnId: '4L0l8RFe6zL6GgEFbUBh6L' },
  };

  it('posts the chosen option to the answer door and leaves a receipt', async () => {
    apiMock.mockResolvedValue({
      itemId: ITEM_ID,
      state: 'RESOLVED',
      resolution: 'ANSWERED',
      delivery: { sessionId: '34OAa5LxnQ1JXpUOfN21W', turnId: '4L0l8RFe6zL6GgEFbUBh6L' },
    });
    await draw(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);

    // The second option, so what is sent is the owner's press and not the recommendation.
    const options = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => options[1]!.click());
    await act(async () => press(SEND_ANSWER).click());
    await until(() => host.textContent!.includes(DELIVERED_TO_COORDINATOR), 'the receipt');

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]![0]).toBe(
      `/projects/${PROJECT_ID}/open-items/${ITEM_ID}/answer`,
    );
    expect(apiMock.mock.calls[0]![1]).toEqual({ method: 'POST', body: { option: 1 } });
    expect(host.textContent).toContain('Start both now');
    expect(host.textContent).toContain(DELIVERED_TO_COORDINATOR);
  });

  it('sends a note with the chosen option, and the receipt says both', async () => {
    apiMock.mockResolvedValue(DELIVERED);
    await draw(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);

    const options = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => options[1]!.click());
    await type(' they can share a runner ');
    await act(async () => press(SEND_ANSWER).click());
    await until(() => host.textContent!.includes(DELIVERED_TO_COORDINATOR), 'the receipt');

    expect(apiMock.mock.calls[0]![1]).toEqual({
      method: 'POST',
      body: { option: 1, text: 'they can share a runner' },
    });
    expect(host.textContent).toContain(
      'Start both now — expect a merge conflict to resolve — they can share a runner',
    );
  });

  it('takes words alone from the Other row, with no option on the answer', async () => {
    apiMock.mockResolvedValue(DELIVERED);
    await draw(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);

    // The recommendation came chosen; the Other row — drawn last, after the coordinator's own —
    // takes the choice off it, and the box says its text is now the whole answer.
    const options = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const other = options[options.length - 1]!;
    await act(async () => other.click());
    expect(other.checked).toBe(true);
    expect(options[0]!.checked).toBe(false);
    expect(box().placeholder).toBe(OWN_ANSWER_PROMPT);
    // Nothing chosen as an option and nothing written is not an answer: the door refuses it.
    expect(press(SEND_ANSWER).disabled).toBe(true);

    await type('Neither: split session_pool.go first');
    expect(press(SEND_ANSWER).disabled).toBe(false);
    await act(async () => press(SEND_ANSWER).click());
    await until(() => host.textContent!.includes(DELIVERED_TO_COORDINATOR), 'the receipt');

    expect(apiMock.mock.calls[0]![1]).toEqual({
      method: 'POST',
      body: { text: 'Neither: split session_pool.go first' },
    });
    expect(host.textContent).toContain('✓ Neither: split session_pool.go first');
  });

  it('keeps a chosen option chosen when its own row is pressed again', async () => {
    // The Other row is the way back to words alone now, so a second press on a chosen option — the
    // gesture this card used to carry — must not quietly take the choice away and leave the box
    // meaning something else than it says.
    await draw(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    const options = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => options[0]!.click());
    expect(options[0]!.checked).toBe(true);
    expect(box().placeholder).toBe(NOTE_PROMPT);
    expect(press(SEND_ANSWER).disabled).toBe(false);
  });

  it('says the answer is waiting when no conversation coordinates the project', async () => {
    apiMock.mockResolvedValue({
      itemId: ITEM_ID,
      state: 'RESOLVED',
      resolution: 'ANSWERED',
      delivery: null,
    });
    await draw(<CoordinatorQuestionCard projectId={PROJECT_ID} row={row()} now={NOW} />);
    await act(async () => press(SEND_ANSWER).click());
    await until(() => host.textContent!.includes(WAITING_FOR_COORDINATOR), 'the receipt');
    expect(host.textContent).toContain(WAITING_FOR_COORDINATOR);
  });

  it('asks the door nothing for a session that coordinates no project', async () => {
    await draw(<CoordinatorQuestions projectId={null} />);
    expect(apiMock).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });

  it('draws the project’s open questions from the one read both places share', async () => {
    apiMock.mockResolvedValue({ needsYou: [row()], withCoordinator: [] });
    await draw(<CoordinatorQuestions projectId={PROJECT_ID} now={NOW} />);
    await until(() => host.textContent!.includes(QUESTION), 'the question on screen');
    expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/open-items`);
    expect(host.textContent).toContain(QUESTION);
    expect(host.textContent).toContain(FROM_COORDINATOR);
  });

  it('waits for a door that answers on a macrotask, not within a count of ticks', async () => {
    // The same read one macrotask later, which is when a real door answers: this one is a fetch.
    // `mockResolvedValue` answers on a microtask, and that is the whole reason a wait counted in
    // ticks ever reached a read here — the ticks it spent on one still in flight cost no time at all
    // (measured on the CI that reds this file: 50 ticks in 0ms), so the budget ran out before the
    // answer was even due.
    apiMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { needsYou: [row()], withCoordinator: [] };
    });
    await draw(<CoordinatorQuestions projectId={PROJECT_ID} now={NOW} />);
    await until(() => host.textContent!.includes(QUESTION), 'the question on screen');
    expect(host.textContent).toContain(QUESTION);
  });
});
