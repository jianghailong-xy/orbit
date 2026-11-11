// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, StreamingDraftsCtx, Transcript } from './Transcript';

/**
 * Reasoning still being written is one folded row until the reader opens it
 * (docs/mocks/thinking-fold-live), and their choice carries to the next block of the same turn.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  events = firstTurn;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const firstTurn: RunEvent[] = [{ seq: 1, type: 'user', payload: { text: 'go' } }];
let events = firstTurn;

function draw(think: string) {
  act(() =>
    root.render(
      <StreamingDraftsCtx.Provider value={think ? { text: '', think } : null}>
        <Transcript events={events} live streamingAfterSeq={think ? events[events.length - 1].seq : null} />
      </StreamingDraftsCtx.Provider>,
    ),
  );
}
const head = () => container.querySelector<HTMLButtonElement>('.chat-think-live-head');
const port = () => container.querySelector('.chat-think-port');

describe('a stretch of reasoning still being written', () => {
  it('starts folded and opens on a click', () => {
    draw('weighing it up');
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    expect(port()).toBeNull();

    act(() => head()!.click());
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(port()?.textContent).toBe('weighing it up');

    act(() => head()!.click());
    expect(port()).toBeNull();
  });

  it('keeps the next block of the same turn open, and folds again once the turn ends', () => {
    draw('first block');
    act(() => head()!.click());

    // The block settles (the drafts go), then the next one starts streaming.
    draw('');
    expect(head()).toBeNull();
    draw('second block');
    expect(port()?.textContent).toBe('second block');

    // The turn ends and the next one starts at once: the session never reads as idle in between
    // (`live` stays true), and the next turn's reasoning still starts folded.
    events = [
      ...firstTurn,
      { seq: 2, type: 'assistant', payload: { text: 'done' } },
      { seq: 3, type: 'turn_end', payload: {} },
      { seq: 4, type: 'user', payload: { text: 'again' } },
    ];
    draw('next turn');
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    expect(port()).toBeNull();
  });
});
