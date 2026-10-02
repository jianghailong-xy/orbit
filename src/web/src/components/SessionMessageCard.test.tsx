// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidToBase62, type SessionMessageCard as Card } from '@orbit/shared';
import { parseSessionMessage, sessionMessageSticky } from '../lib/sessionMessage';
import { acceptedUserTurnEvent } from '../lib/acceptedUserTurn';
import { SessionMessageCard } from './SessionMessageCard';
import { Transcript, type RunEvent } from './Transcript';

/**
 * Another Orbit session's message is drawn from who the control plane recorded as sending it — NOT
 * as the account owner's own bubble, and never from anything read out of the words.
 *
 * `session_send` and `project_send` write a turn into this conversation that the owner did not type.
 * What holds this in place is the pair, as for every other card a turn is drawn as: with the payload
 * the card names the session and the words are the sending agent's; without one — the same words, the
 * same session — the turn is the bubble it always was.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const SENT = 'The landing on criterion 3 needs a merge decision — the evidence is on the task.';

/** The block delivery appended (apiserver sessions/session-message.ts), recorded as the control plane's note. */
const BLOCK = [
  '<orbit-session-message from-session="34YCLEOsvlZDk31Ma1xAy" from-title="Worker: criterion 3" '
    + 'from-agent="orbit" task="34YR26Xq9PRtbB4nPYmPq">',
  '这条消息来自另一个 Orbit 会话，不是账号 owner 本人。',
  '</orbit-session-message>',
].join('\n');
const NOTE = `\n\n${BLOCK}`;

const CARD: Card = {
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  fromTitle: 'Worker: criterion 3',
  fromAgentName: 'orbit',
  fromTaskId: '01a0cca0-aeaa-7618-bd5a-caccc089108c',
};

/** A `user` event as ingest stores one: the echo whole, the note beside it, and the card when there was one. */
function sent(card?: unknown, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq: 9,
    type: 'user',
    turnId: 'turn-sent',
    ts: '2026-10-01T15:40:00.000Z',
    payload: {
      text: `${SENT}${NOTE}`,
      controlPlaneNote: NOTE,
      ...(card === undefined ? {} : { sessionMessage: card }),
      ...extra,
    },
  };
}

async function mount(events: RunEvent[]) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={events} />
      </MemoryRouter>,
    );
  });
}

async function remount(events: RunEvent[]) {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await mount(events);
}

const card = (): Element | null => container.querySelector('.smc');

describe('another session’s message', () => {
  it('is drawn as "From [that session]": its title opens it, and the words are the sender’s', async () => {
    await mount([sent(CARD)]);

    const el = card();
    expect(el, `no card was drawn:\n${container.innerHTML}`).not.toBeNull();
    const head = el!.querySelector('.smc-head');
    expect(head?.textContent).toContain('From');
    const from = head!.querySelector('a.smc-from');
    expect(from?.textContent).toBe('Worker: criterion 3');
    expect(from?.getAttribute('href')).toBe(`/sessions/${uuidToBase62(CARD.fromSessionId)}`);
    expect(el!.querySelector('.smc-agent')?.textContent).toBe('orbit');
    // The words are the ones that were sent — the block delivery appended is not among them.
    expect(el!.querySelector('.smc-body .md')?.textContent).toBe(SENT);
    expect(el!.querySelector('.smc-body')?.textContent).not.toContain('orbit-session-message');
    const meta = el!.querySelector('.smc-meta');
    expect(meta?.textContent).toContain('Sent by another Orbit session, not by you');
    expect(meta!.querySelector('a')?.getAttribute('href')).toBe(`/tasks/${uuidToBase62(CARD.fromTaskId!)}`);
    // What the model read is one fold away, named for what it is.
    expect(el!.querySelector('.chat-injected-head')?.textContent).toBe('⊕ Orbit attached: session message');
    // Not the owner's bubble, and not named as the owner's question by the sticky bar.
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(el!.getAttribute('data-sticky-label')).toBe('From Worker: criterion 3');
    expect(el!.getAttribute('data-sticky-text')).toBe(SENT);
  });

  it('links no task for a sender that runs none, and names an untitled sender', async () => {
    await mount([sent({ ...CARD, fromTaskId: undefined, fromTitle: '  ' })]);
    const el = card()!;
    expect(el.querySelector('.smc-meta a')).toBeNull();
    expect(el.querySelector('.smc-from')?.textContent).toBe('Untitled session');
  });

  it('says so when the session never confirmed it received the message', async () => {
    await mount([sent(CARD, { delivery: 'failed' })]);
    expect(card()!.querySelector('.smc-undelivered')?.textContent)
      .toBe('The session has not confirmed it received this.');
  });

  // The negative control: the same conversation and the same words, with nothing recorded beside them.
  it('leaves a message with no card as the bubble it always was', async () => {
    await mount([sent(undefined)]);
    expect(card()).toBeNull();
    const bubble = container.querySelector('.chat-user');
    expect(bubble, `the bubble is gone:\n${container.innerHTML}`).not.toBeNull();
    expect(bubble!.querySelector('.md')?.textContent).toBe(SENT);
  });

  it('draws a payload that is not a card as the bubble too, never as half a card', async () => {
    for (const bad of [{ ...CARD, fromSessionId: '' }, { ...CARD, fromSessionId: 42 }, 'from a session', null]) {
      await remount([sent(bad)]);
      expect(card(), `drew a card from ${JSON.stringify(bad)}`).toBeNull();
      expect(container.querySelector('.chat-user')).not.toBeNull();
    }
  });
});

describe('another session’s message, while it waits to be delivered', () => {
  it('is the same card, dashed, with the queue’s line at its foot and out of the sticky bar’s reach', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SessionMessageCard card={CARD} text={SENT} queued={<span className="the-queue-line">Queued</span>} />
        </MemoryRouter>,
      );
    });
    const el = card()!;
    expect(el.classList.contains('is-queued')).toBe(true);
    expect(el.hasAttribute('data-seq'), 'a queued message is no event for ⌘F to land on').toBe(false);
    expect(el.querySelector('.smc-from')?.textContent).toBe('Worker: criterion 3');
    expect(el.querySelector('.smc-body .md')?.textContent).toBe(SENT);
    expect(el.querySelector('.smc-queued .the-queue-line')?.textContent).toBe('Queued');
    expect(container.querySelector('.chat-user')).toBeNull();
  });

  it('is drawn as the card while its echo is on the way, from whichever read recovered the row', async () => {
    const base = { key: 'turn-sent', sessionId: 'session-1', turnId: 'turn-sent', text: SENT, acceptedAt: '2026-10-01T15:40:00.000Z', attachments: [] };
    for (const source of ['activeSnapshot', 'local'] as const) {
      const event = acceptedUserTurnEvent({ ...base, source, sessionMessage: CARD }, 0.5);
      expect(event.payload).toEqual({ text: SENT, sessionMessage: CARD });
    }
    await mount([acceptedUserTurnEvent({ ...base, source: 'activeSnapshot', sessionMessage: CARD }, 0.5) as RunEvent]);
    expect(card()?.querySelector('.smc-from')?.textContent).toBe('Worker: criterion 3');
    expect(container.querySelector('.chat-user'), 'the placeholder was drawn as the reader’s own bubble').toBeNull();
    // And a turn the reader typed carries no card at all, as the control plane stores none.
    expect(acceptedUserTurnEvent({ ...base, source: 'local' }, 0.5).payload).toEqual({ text: SENT });
  });
});

describe('parseSessionMessage', () => {
  it('reads every field, and leaves a missing task absent rather than empty', () => {
    expect(parseSessionMessage({ text: SENT, sessionMessage: CARD })).toEqual(CARD);
    expect(parseSessionMessage({ sessionMessage: { fromSessionId: CARD.fromSessionId, fromTaskId: '' } }))
      .toEqual({ fromSessionId: CARD.fromSessionId, fromTitle: '', fromAgentName: '' });
    expect(parseSessionMessage({ text: SENT })).toBeNull();
    expect(parseSessionMessage(null)).toBeNull();
  });

  it('names the turn on the sticky bar by who sent it', () => {
    expect(sessionMessageSticky(CARD, SENT)).toEqual({ label: 'From Worker: criterion 3', text: SENT });
  });
});
