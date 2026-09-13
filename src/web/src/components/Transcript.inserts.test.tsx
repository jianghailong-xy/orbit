import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type RunEvent, StreamingDraftsCtx, Transcript, type TranscriptInsert } from './Transcript';

/**
 * Where something with a moment but no seq of its own — a decision recorded from this session —
 * sits among the events around it.
 *
 * The caller names the seq it follows, worked out from the events' clocks. These pin what the
 * transcript does with that: draw it straight after the card holding that seq, draw it once even
 * while a live stretch splits the list in two, and draw nothing for one older than every event
 * loaded so far — the page that holds its moment is not on screen yet.
 */

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({ seq, type, payload });

// Terminated, so no marker is a prefix of another: `insert@1` would be counted inside `insert@10`.
const marker = (afterSeq: number) => `insert@${afterSeq}#`;

const insert = (afterSeq: number): TranscriptInsert => ({
  afterSeq,
  key: marker(afterSeq),
  element: <div className="probe">{marker(afterSeq)}</div>,
});

const render = (events: RunEvent[], inserts: TranscriptInsert[], streamingAfterSeq: number | null = null) =>
  renderToStaticMarkup(
    <StreamingDraftsCtx.Provider value={streamingAfterSeq === null ? null : { text: 'DRAFT', think: '' }}>
      <Transcript events={events} inserts={inserts} streamingAfterSeq={streamingAfterSeq} />
    </StreamingDraftsCtx.Provider>,
  );

const occurrences = (html: string, text: string) => html.split(text).length - 1;

const CONVERSATION = [
  ev(1, 'user', { text: 'first question' }),
  ev(2, 'assistant', { text: 'first answer' }),
  ev(10, 'user', { text: 'second question' }),
  ev(11, 'assistant', { text: 'second answer' }),
];

describe('an insert sits at its moment in the conversation', () => {
  it('draws it straight after the event it follows, not at the end', () => {
    const html = render(CONVERSATION, [insert(2)]);

    expect(occurrences(html, marker(2))).toBe(1);
    expect(html.indexOf('first answer')).toBeLessThan(html.indexOf(marker(2)));
    expect(html.indexOf(marker(2))).toBeLessThan(html.indexOf('second question'));
  });

  it('follows the last card at or before a seq that makes no card of its own', () => {
    // Seq 7 is between the two exchanges: whatever it was, it drew nothing, so the insert follows
    // the card before it and still comes before what happened after.
    const html = render(CONVERSATION, [insert(7)]);

    expect(html.indexOf('first answer')).toBeLessThan(html.indexOf(marker(7)));
    expect(html.indexOf(marker(7))).toBeLessThan(html.indexOf('second question'));
  });

  it('draws nothing for an insert older than every event loaded so far', () => {
    // The paired positive is the case above: the same insert over events that reach back far
    // enough is drawn. Here the earliest loaded event is later, so its moment is on another page.
    const later = CONVERSATION.map((event) => ({ ...event, seq: event.seq + 100 }));

    expect(render(later, [insert(7)])).not.toContain(marker(7));
    expect(render(later, [insert(107)])).toContain(marker(107));
  });

  it('draws each insert once, on its own side of a live stretch', () => {
    // Streaming splits the list at seq 2. One insert belongs before the drafts and one after; a
    // placement handed to both halves would draw each of them twice.
    const html = render(CONVERSATION, [insert(1), insert(10)], 2);

    expect(occurrences(html, marker(1))).toBe(1);
    expect(occurrences(html, marker(10))).toBe(1);
    expect(html.indexOf(marker(1))).toBeLessThan(html.indexOf('DRAFT'));
    expect(html.indexOf('DRAFT')).toBeLessThan(html.indexOf(marker(10)));
  });

  it('follows a folded run of tool calls as a whole when its seq is inside the run', () => {
    // Three calls in a row fold into one row, so the middle call is not a top-level card of its
    // own. An insert naming it must follow the run rather than be dropped for want of a card.
    const events = [
      ev(1, 'user', { text: 'first question' }),
      ev(2, 'tool_use', { id: 't2', name: 'Bash', input: { command: 'ls' } }),
      ev(3, 'tool_use', { id: 't3', name: 'Bash', input: { command: 'pwd' } }),
      ev(4, 'tool_use', { id: 't4', name: 'Bash', input: { command: 'whoami' } }),
      ev(5, 'assistant', { text: 'after the run' }),
    ];
    const html = render(events, [insert(3)]);

    expect(html).toContain('chat-tool-group');
    expect(occurrences(html, marker(3))).toBe(1);
    expect(html.indexOf('chat-tool-group')).toBeLessThan(html.indexOf(marker(3)));
    expect(html.indexOf(marker(3))).toBeLessThan(html.indexOf('after the run'));
  });

  it('leaves the conversation as it was when there is nothing to insert', () => {
    expect(render(CONVERSATION, [])).toBe(
      renderToStaticMarkup(<Transcript events={CONVERSATION} />),
    );
  });
});
