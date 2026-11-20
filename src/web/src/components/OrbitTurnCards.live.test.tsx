// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunQuestionCard, SessionRequestView } from '@orbit/shared';
import { ANSWERED_BY_SESSION, ANSWERED_BY_YOU, RunQuestionTurnCard } from './OrbitTurnCards';
import { ExportCtx } from './Transcript';

/**
 * A run question's card is read when its turn is handed out, before anyone has answered, and the echo
 * keeps it. The card draws its request's card as it stands now over that one, so an answer given
 * after delivery shows on the card — ticked, and who gave it.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getSessionRequest: vi.fn() };
});
const { getSessionRequest } = await import('../api');
const fetchRequest = vi.mocked(getSessionRequest);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchRequest.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const STORED: RunQuestionCard = {
  requestId: '01a0cca7-0000-7000-8000-0000000000e1', approvalId: 'a1', taskId: null, taskTitle: 'Queue parity',
  runSessionId: '01a0cca7-0000-7000-8000-0000000000d3', replyBy: '2099-11-11T06:10:00.000Z', state: 'OPEN',
  approvalStatus: 'PENDING',
  questions: [{ question: 'Keep its place?', options: [{ label: 'Keep its place' }, { label: 'Go to the back' }] }],
  answers: null, answeredBy: null,
};

function view(runQuestion: RunQuestionCard): SessionRequestView {
  return {
    requestId: 'r', state: runQuestion.state as SessionRequestView['state'], fromSessionId: 'f', fromTitle: '', toSessionId: 't',
    toTitle: '', requestPreview: '', replyBy: runQuestion.replyBy, createdAt: runQuestion.replyBy, runQuestion,
  };
}

async function mount(card: RunQuestionCard, exporting = false) {
  const tree = (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RunQuestionTurnCard card={card} told="<orbit-run-question/>" />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(exporting ? <ExportCtx.Provider value={'markdown' as never}>{tree}</ExportCtx.Provider> : tree);
  });
}

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  expect(done()).toBe(true);
}

const picked = () => [...container.querySelectorAll('li.is-picked')].map((li) => li.textContent);

describe('a run question’s card, as its request stands now', () => {
  it('shows an answer given after the turn was handed out, and who gave it', async () => {
    fetchRequest.mockResolvedValue(view({
      ...STORED, state: 'REPLIED', approvalStatus: 'ALLOWED',
      answers: { 'Keep its place?': ['Go to the back'] }, answeredBy: 'SESSION',
    }));
    await mount(STORED);
    await until(() => container.textContent!.includes(ANSWERED_BY_SESSION));
    expect(fetchRequest).toHaveBeenCalledWith(STORED.requestId);
    expect(picked()).toEqual(['✓ Go to the back']);
  });

  it('says the owner answered it, once they did', async () => {
    fetchRequest.mockResolvedValue(view({
      ...STORED, state: 'OWNER_ANSWERED', approvalStatus: 'ALLOWED',
      answers: { 'Keep its place?': ['Keep its place'] }, answeredBy: 'OWNER',
    }));
    await mount(STORED);
    await until(() => container.textContent!.includes(ANSWERED_BY_YOU));
  });

  it('keeps the stored card while nothing has come back, and asks nothing once it says who answered', async () => {
    fetchRequest.mockReturnValue(new Promise(() => {}));
    await mount(STORED);
    expect(container.textContent).toContain('The run is waiting.');
    fetchRequest.mockReset();
    await mount({ ...STORED, answers: { 'Keep its place?': ['Keep its place'] }, answeredBy: 'SESSION' });
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(picked()).toEqual(['✓ Keep its place']);
  });
});
