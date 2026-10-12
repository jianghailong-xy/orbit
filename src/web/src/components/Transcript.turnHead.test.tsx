// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';

/**
 * The row at the head of a turn, over the turn's own output: how long it worked, or has been
 * working — the line Codex draws above an answer (owner, 2026-10-10). The span runs between the
 * turn's `user` message and its `turn_end`, both of them stored, so a turn read back later states
 * the same span the turn that was on screen stated; a duration this page would have had to
 * remember instead is exactly what a reload loses.
 */

const START = '2026-10-10T07:12:00.000Z';
const AFTER_66S = '2026-10-10T07:13:06.000Z';
const NOW = new Date(Date.parse(START) + 12_000);

/** `ts: null` is the event an older runner stored with no stamp at all. */
const user = (seq: number, at: string | null = START): RunEvent => ({
  seq,
  type: 'user',
  payload: { text: 'go' },
  ...(at ? { ts: at } : {}),
});
const said = (seq: number, text = 'done'): RunEvent => ({ seq, type: 'assistant', payload: { text }, ts: START });
const ended = (seq: number, ts = AFTER_66S, subtype = 'success'): RunEvent => ({
  seq,
  type: 'turn_end',
  payload: { subtype },
  ts,
});

const page = (events: RunEvent[], live?: boolean): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Transcript events={events} live={live} />);
  return host;
};
const heads = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('.chat-turn-head')];
const text = (host: ParentNode) => heads(host).map((h) => h.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the head of a finished turn', () => {
  it('states the span, above the turn’s own output and below its message', () => {
    const host = page([user(1), said(2), ended(3)]);

    const [row] = heads(host);
    const bubble = host.querySelector('.chat-user')!;
    const answer = host.querySelector('.chat-assistant')!;
    expect(row.textContent).toBe('Worked for 1m 6s');
    expect(bubble.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is stated from the stored stamps, so a turn read back later says what it said on screen', () => {
    // Nothing here was measured by this page: a turn from yesterday keeps its span.
    const yesterday = '2026-10-09T02:40:00.000Z';
    const host = page([
      { seq: 1, type: 'user', payload: { text: 'go' }, ts: yesterday },
      said(2),
      ended(3, '2026-10-09T02:42:30.000Z'),
    ]);

    expect(text(host)).toEqual(['Worked for 2m 30s']);
  });

  it('counts in hours once a turn runs past one', () => {
    const host = page([user(1, '2026-10-10T07:00:00.000Z'), said(2), ended(3, '2026-10-10T09:05:00.000Z')]);

    expect(text(host)).toEqual(['Worked for 2h 5m']);
  });

  it('never says a turn took no time at all', () => {
    const host = page([user(1), said(2), ended(3, '2026-10-10T07:12:00.400Z')]);

    expect(text(host)).toEqual(['Worked for 1s']);
  });

  it('states it over a turn that failed too: the answer above the error line took that long', () => {
    const host = page([user(1), ended(3, AFTER_66S, 'error_during_execution')]);

    expect(text(host)).toEqual(['Worked for 1m 6s']);
    expect(host.textContent).toContain('This turn ended without a reply');
  });

  it('gives each turn of a conversation its own row', () => {
    const host = page([
      user(1),
      said(2),
      ended(3, '2026-10-10T07:13:06.000Z'),
      user(4, '2026-10-10T07:30:00.000Z'),
      said(5),
      ended(6, '2026-10-10T07:30:45.000Z'),
    ]);

    expect(text(host)).toEqual(['Worked for 1m 6s', 'Worked for 45s']);
    expect(heads(host)[0].compareDocumentPosition(heads(host)[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens no turn of its own for a steer, which joins the turn already running', () => {
    const steer: RunEvent = {
      seq: 4,
      type: 'user',
      payload: { text: 'and the tests?', steer: true },
      turnId: 'b',
      ts: '2026-10-10T07:12:40.000Z',
    };
    const host = page([user(1), said(2), steer, ended(5)]);

    expect(text(host)).toEqual(['Worked for 1m 6s']);
    const answer = host.querySelector('.chat-assistant')!;
    expect(heads(host)[0].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('states nothing for a turn that neither ended nor is still running', () => {
    // A mid-turn crash skips turn_end. Its span is not knowable, and "Working" for the rest of the
    // session's life would be a claim nothing supports.
    const host = page([user(1), said(2)]);

    expect(heads(host)).toHaveLength(0);
  });

  it('states nothing for an old turn whose message carried no stamp', () => {
    const host = page([user(1, null), said(2), ended(3)]);

    expect(heads(host)).toHaveLength(0);
  });
});

describe('the head of a turn still running', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  const show = (events: RunEvent[], live?: boolean) => act(() => root.render(<Transcript events={events} live={live} />));
  const row = () => container.querySelector<HTMLElement>('.chat-turn-head');

  it('counts up from the turn’s own message, once a second', () => {
    show([user(1), said(2)], true);

    expect(row()?.textContent).toBe('Working for 12s');
    act(() => vi.advanceTimersByTime(1_000));
    expect(row()?.textContent).toBe('Working for 13s');
  });

  it('stops counting and states the span the moment the turn ends', () => {
    show([user(1), said(2)], true);
    expect(row()?.textContent).toBe('Working for 12s');

    show([user(1), said(2), ended(3)], true);

    expect(row()?.textContent).toBe('Worked for 1m 6s');
    act(() => vi.advanceTimersByTime(5_000));
    expect(row()?.textContent).toBe('Worked for 1m 6s');
  });

  it('claims no duration for a start the loaded window never reached', () => {
    show([user(1, null), said(2)], true);

    expect(row()?.textContent).toBe('Working…');
  });

  it('counts only the turn that is running: an earlier turn of a live session keeps its span', () => {
    show([user(1, '2026-10-10T07:11:00.000Z'), said(2), ended(3, '2026-10-10T07:12:06.000Z'), user(4), said(5)], true);

    expect(text(container)).toEqual(['Worked for 1m 6s', 'Working for 12s']);
  });
});
