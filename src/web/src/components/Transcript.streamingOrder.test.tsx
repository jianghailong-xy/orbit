import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type RunEvent, StreamingDraftsCtx, Transcript } from './Transcript';
import { streamAnchorAfter } from '../lib/streamAnchor';

/**
 * Where the half-written reply sits among the events around it.
 *
 * The drafts (`text_delta` / `thinking_delta`) are broadcast but never persisted, so they have no
 * seq to be ordered by and used to render after the whole transcript, unconditionally. That is
 * right for as long as nothing else arrives during the generation — but a message typed mid-turn
 * is echoed back by the runner as a `user` event with a HIGHER seq than anything already on
 * screen, which put it above a bubble that keeps growing, in a pane pinned to the tail. Measured
 * on the deployed bundle against a real session's events: the moment the runner echoed it, the
 * message a user had just sent moved from y=733 (visible, at the bottom) to y=-534 — off-screen,
 * and further off with every chunk. It read as a message that never went anywhere.
 *
 * So the drafts carry an anchor — the seq the stream was at when this stretch began — and render
 * straight after it. These pin the ordering that follows from it.
 */

const DRAFT = '正在生成的回复';
const MID_TURN = '请帮我设计一个效果图';

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({ seq, type, payload });

const render = (events: RunEvent[], streamingAfterSeq: number | null, think = '') =>
  renderToStaticMarkup(
    <StreamingDraftsCtx.Provider value={{ text: DRAFT, think }}>
      <Transcript events={events} live streamingAfterSeq={streamingAfterSeq} />
    </StreamingDraftsCtx.Provider>,
  );

describe('the live drafts sit where the generation started', () => {
  it('puts a message sent mid-turn below the reply being written', () => {
    // seq 2 was the cursor when the stream began; seq 3 is the runner echoing back what the
    // user typed into the middle of it.
    const html = render(
      [ev(1, 'user', { text: 'first question' }), ev(2, 'assistant', { text: 'earlier reply' }), ev(3, 'user', { text: MID_TURN, steer: true })],
      2,
    );

    expect(html).toContain(DRAFT);
    expect(html.indexOf(DRAFT)).toBeLessThan(html.indexOf(MID_TURN));
  });

  it('still renders the drafts last when nothing arrived after them', () => {
    const html = render([ev(1, 'user', { text: 'first question' }), ev(2, 'assistant', { text: 'earlier reply' })], 2);

    expect(html.indexOf('earlier reply')).toBeLessThan(html.indexOf(DRAFT));
  });

  it('falls back to the end when there is no anchor to place them by', () => {
    // A tail-page seed that failed leaves the stream cursor at 0, so the anchor can name a
    // point older than everything loaded — or nothing at all. Either way the drafts belong at
    // the end, which is exactly where they rendered before there was an anchor.
    for (const anchor of [null, 0]) {
      const html = render([ev(5, 'user', { text: 'first question' }), ev(6, 'assistant', { text: 'earlier reply' })], anchor);

      expect(html.indexOf('earlier reply')).toBeLessThan(html.indexOf(DRAFT));
    }
  });

  it('places a thinking draft by the same anchor', () => {
    const html = renderToStaticMarkup(
      <StreamingDraftsCtx.Provider value={{ text: '', think: 'weighing it up' }}>
        <Transcript events={[ev(1, 'assistant', { text: 'earlier reply' }), ev(2, 'user', { text: MID_TURN })]} live streamingAfterSeq={1} />
      </StreamingDraftsCtx.Provider>,
    );

    expect(html.indexOf('weighing it up')).toBeLessThan(html.indexOf(MID_TURN));
  });

  it('keeps a tool call the model ran above the reply that explains it', () => {
    // Reproduces what a user saw on 2026-09-05 (session 01a07092): a Bash call, a closing
    // thinking block, a second Bash call, and then the answer describing what the second call
    // found — drawn between the two calls. The thinking block anchored the drafts and nothing
    // moved that anchor past the tool call that came after it.
    const durable: RunEvent[] = [
      ev(2900, 'tool_use', { id: 't1', name: 'Bash', input: { command: 'git commit --amend' } }),
      ev(2901, 'tool_result', { toolUseId: 't1', content: 'blocked', isError: true }),
      ev(2931, 'thinking', { text: '' }),
      ev(2932, 'system', { subtype: 'context' }),
      ev(2933, 'tool_use', { id: 't2', name: 'Bash', input: { command: 'git status --short' } }),
      ev(2934, 'tool_result', { toolUseId: 't2', content: ' M package.json' }),
      ev(2935, 'system', { subtype: 'status' }),
    ];
    // The deltas ride the same stream (with seqs of their own that are never persisted), so the
    // anchor has to come from replaying all of it, not just what the transcript keeps.
    const stream = [
      ev(2925, 'thinking_delta', { text: '…' }),
      ...durable,
      ev(2936, 'thinking_delta', { text: '…' }),
      ev(2937, 'text_delta', { text: DRAFT }),
    ];
    let anchor: number | null = null;
    let cursor = 0;
    for (const e of stream) {
      cursor = Math.max(cursor, e.seq);
      anchor = streamAnchorAfter(anchor, e, cursor);
    }

    const html = render(durable, anchor);

    expect(html).toContain(DRAFT);
    expect(html.lastIndexOf('chat-tool-card')).toBeLessThan(html.indexOf(DRAFT));
  });

  it('keeps a run of tool calls folded when nothing is streaming', () => {
    // The two halves either side of the drafts are grouped separately, so an idle transcript
    // has to stay ONE list: splitting it would break a run of calls that spans the seam out of
    // its summary row and back into three cards.
    const calls = [1, 2, 3].map((i) => ev(i, 'tool_use', { id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }));
    const html = renderToStaticMarkup(<Transcript events={calls} live />);

    expect(html).toContain('chat-tool-group');
  });
});
