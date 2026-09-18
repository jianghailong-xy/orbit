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
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function draw(ui: JSX.Element) {
    await act(async () => {
      root.render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
    });
  }

  /** A read or a mutation settles a tick after the press that started it; this is that tick. */
  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function press(label: string) {
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.includes(label),
    );
    if (!button) throw new Error(`no ${label} button`);
    return button;
  }

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
    await settle();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]![0]).toBe(
      `/projects/${PROJECT_ID}/open-items/${ITEM_ID}/answer`,
    );
    expect(apiMock.mock.calls[0]![1]).toEqual({ method: 'POST', body: { option: 1 } });
    expect(host.textContent).toContain('Start both now');
    expect(host.textContent).toContain(DELIVERED_TO_COORDINATOR);
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
    await settle();
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
    await settle();
    expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/open-items`);
    expect(host.textContent).toContain(QUESTION);
    expect(host.textContent).toContain(FROM_COORDINATOR);
  });
});
