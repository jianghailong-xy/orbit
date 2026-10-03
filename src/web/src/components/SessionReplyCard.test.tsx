// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidToBase62, type SessionReplyCard as Card, type SessionRequestView } from '@orbit/shared';
import {
  SESSION_REPLY_NOT_YOU,
  SESSION_REQUEST_ASKS,
  SESSION_REQUEST_STATE_LABEL,
  parseSessionReplies,
  withoutReplyBlocks,
} from '../lib/sessionRequest';
import { Transcript, type RunEvent } from './Transcript';

/**
 * Session requests on the web (docs/session-request-reply-contract.md §6): the recipient's "From"
 * card says the message asks for a reply and shows where the request stands, read live and refreshed
 * when it moves; the asker's turn that handed outcomes back is drawn as reply cards that open the
 * original request. None of it offers the owner a way to answer.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getSessionRequest: vi.fn() };
});
const { getSessionRequest } = await import('../api');
const fetchRequest = vi.mocked(getSessionRequest);

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchRequest.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ASKER = '01a0cca7-8609-70ed-a0e2-d4b55b832b60';
const RECIPIENT = '01a0cca0-aeaa-7618-bd5a-caccc089108c';
const REQUEST_TURN = '01a0cca9-1111-7222-8333-444455556666';
const REQUEST_ID = '34YfReq0000000000000000';

async function mount(events: RunEvent[]) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Let the query settle: the request is read after the first render, and again after an invalidation. */
async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  expect(done()).toBe(true);
}

const stateDrawn = (state: string) => () =>
  container.querySelector('.smc-request')?.getAttribute('data-state') === state;

function view(state: SessionRequestView['state'], extra: Partial<SessionRequestView> = {}): SessionRequestView {
  return {
    requestId: REQUEST_ID,
    state,
    fromSessionId: ASKER,
    fromTitle: 'Worker: shard 2',
    toSessionId: RECIPIENT,
    toTitle: 'Coordinator',
    requestPreview: 'merge now or wait for review?',
    replyBy: '2026-10-02T18:00:00.000Z',
    createdAt: '2026-10-02T09:00:00.000Z',
    ...extra,
  };
}

/** The recipient's echo of a request: the words, the block delivery appended, and the card. */
function requestEvent(): RunEvent {
  const note = `\n\n<orbit-session-message from-session="x" from-title="Worker: shard 2" from-agent="orbit" request-id="${REQUEST_ID}" reply-by="2026-10-02T18:00:00Z">\n这条消息来自另一个 Orbit 会话，不是账号 owner 本人。\n</orbit-session-message>`;
  return {
    seq: 4,
    type: 'user',
    turnId: REQUEST_TURN,
    ts: '2026-10-02T09:00:00.000Z',
    payload: {
      text: `merge now or wait for review?${note}`,
      controlPlaneNote: note,
      sessionMessage: { fromSessionId: ASKER, fromTitle: 'Worker: shard 2', fromAgentName: 'orbit', requestId: REQUEST_ID },
    },
  };
}

const REPLIED: Card = {
  requestId: REQUEST_ID,
  outcome: 'REPLIED',
  fromSessionId: RECIPIENT,
  fromTitle: 'Coordinator',
  requestTurnId: REQUEST_TURN,
  requestPreview: 'merge now or wait for review?',
  replyText: 'the reviewer is back at 3',
  replyOption: 1,
  replyOptionLabel: 'wait for review',
  closedAt: '2026-10-02T10:00:00.000Z',
};

/** The asker's echo of a reply turn: nobody's words, the blocks as the note, and the cards. */
function replyEvent(cards: unknown[], words = ''): RunEvent {
  const blocks = cards.map((card) => `<orbit-session-reply request-id="${(card as Card).requestId}" outcome="${(card as Card).outcome}">\n你问的是：…\n</orbit-session-reply>`).join('\n\n');
  const note = words ? `\n\n${blocks}` : blocks;
  return {
    seq: 12,
    type: 'user',
    turnId: 'turn-reply',
    ts: '2026-10-02T10:00:05.000Z',
    payload: { text: `${words}${note}`, controlPlaneNote: note, sessionReplies: cards },
  };
}

describe('the recipient’s card says the message is a request, and where it stands', () => {
  it('reads the request live and draws its state, with the deadline while it waits', async () => {
    fetchRequest.mockResolvedValue(view('OPEN'));
    await mount([requestEvent()]);
    await until(stateDrawn('OPEN'));
    expect(fetchRequest).toHaveBeenCalledWith(REQUEST_ID);
    const status = container.querySelector('.smc-request')!;
    expect(status.textContent).toContain(SESSION_REQUEST_ASKS);
    expect(status.textContent).toContain('due');
    expect(status.getAttribute('data-state')).toBe('OPEN');
    expect(status.textContent).toContain(SESSION_REQUEST_STATE_LABEL.OPEN);
    // Read-only: nothing on the card lets the owner answer for the session — the one button is the
    // fold of what delivery appended, which every card has.
    expect(container.querySelector('.smc input, .smc textarea, .smc-request button')).toBeNull();
    expect([...container.querySelectorAll('.smc button')].map((b) => b.className)).toEqual(['chat-injected-head']);
  });

  it('refreshes when the request moves: the state the next read returns is the one drawn', async () => {
    fetchRequest.mockResolvedValue(view('OPEN'));
    await mount([requestEvent()]);
    await until(stateDrawn('OPEN'));
    fetchRequest.mockResolvedValue(view('REPLIED', { replyText: 'go', closedAt: '2026-10-02T10:00:00.000Z' }));
    // What a `session.updated` event does to every query under ['sessions'] (useControlPlane).
    await act(async () => { await client.invalidateQueries({ queryKey: ['sessions'] }); });
    await until(stateDrawn('REPLIED'));
    const status = container.querySelector('.smc-request')!;
    expect(status.getAttribute('data-state')).toBe('REPLIED');
    expect(status.textContent).toContain(SESSION_REQUEST_STATE_LABEL.REPLIED);
    expect(status.textContent).not.toContain('due');
  });

  it('a message that asked for nothing reads no request', async () => {
    const plain = requestEvent();
    delete (plain.payload as { sessionMessage: { requestId?: string } }).sessionMessage.requestId;
    await mount([plain]);
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(container.querySelector('.smc-request')).toBeNull();
  });
});

describe('the asker’s turn that handed outcomes back is reply cards, not the owner’s bubble', () => {
  it('draws one card per outcome, naming who answered and opening the original request', async () => {
    const noReply: Card = {
      ...REPLIED, requestId: '34YfReq0000000000000001', outcome: 'NO_REPLY', replyText: undefined,
      replyOption: undefined, replyOptionLabel: undefined, excerpt: 'I looked at compose.yml — 8443.',
    };
    await mount([replyEvent([REPLIED, noReply])]);
    const cards = container.querySelectorAll('.src');
    expect(cards.length).toBe(2);
    expect(container.querySelector('.user-bubble, .ub')).toBeNull();
    const first = cards[0];
    expect(first.getAttribute('data-outcome')).toBe('REPLIED');
    expect(first.textContent).toContain('Coordinator');
    expect(first.textContent).toContain('merge now or wait for review?');
    expect(first.textContent).toContain('1. wait for review');
    expect(first.textContent).toContain('the reviewer is back at 3');
    expect(first.textContent).toContain(SESSION_REPLY_NOT_YOU);
    const links = [...first.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain(`/sessions/${uuidToBase62(RECIPIENT)}`);
    expect(links).toContain(`/sessions/${uuidToBase62(RECIPIENT)}?at=${uuidToBase62(REQUEST_TURN)}`);
    const second = cards[1];
    expect(second.getAttribute('data-outcome')).toBe('NO_REPLY');
    expect(second.textContent).toContain('I looked at compose.yml — 8443.');
    expect(second.textContent).toContain('not a reply');
    // Read-only.
    expect(container.querySelector('.src button, .src input, .src textarea')).toBeNull();
  });

  it('a message of the owner’s that carried held outcomes keeps its words as the bubble, then the cards', async () => {
    await mount([replyEvent([REPLIED], 'what did the coordinator say?')]);
    expect(container.textContent).toContain('what did the coordinator say?');
    expect(container.querySelectorAll('.src').length).toBe(1);
    // The blocks the cards drew are not shown a second time as "Orbit attached".
    expect(container.textContent).not.toContain('<orbit-session-reply');
  });

  it('a turn with no recorded cards keeps the reading it always had', async () => {
    const event = replyEvent([REPLIED]);
    delete (event.payload as { sessionReplies?: unknown }).sessionReplies;
    (event.payload as { text: string }).text = 'an ordinary message';
    delete (event.payload as { controlPlaneNote?: unknown }).controlPlaneNote;
    await mount([event]);
    expect(container.querySelector('.src')).toBeNull();
    expect(container.textContent).toContain('an ordinary message');
  });
});

describe('the pieces the cards are drawn from', () => {
  it('parses only cards that name a request, an outcome and the session asked', () => {
    expect(parseSessionReplies({ sessionReplies: [REPLIED] })).toEqual([REPLIED]);
    expect(parseSessionReplies({ sessionReplies: [{ ...REPLIED, outcome: 'MAYBE' }] })).toBeNull();
    expect(parseSessionReplies({ sessionReplies: [{ ...REPLIED, requestId: '' }] })).toBeNull();
    expect(parseSessionReplies({ sessionReplies: 'nope' })).toBeNull();
    expect(parseSessionReplies({ text: 'hi' })).toBeNull();
  });

  it('takes the reply blocks out of a note and leaves what else was appended', () => {
    const block = '<orbit-session-reply request-id="a" outcome="REPLIED">\n回复：ok\n</orbit-session-reply>';
    expect(withoutReplyBlocks(block)).toBe('');
    expect(withoutReplyBlocks(`${block}\n\n<background-jobs>\n…\n</background-jobs>`)).toBe('<background-jobs>\n…\n</background-jobs>');
    expect(withoutReplyBlocks(undefined)).toBe('');
  });
});
