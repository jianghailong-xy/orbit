import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type RunEvent, StreamingDraftsCtx, Transcript } from './Transcript';

/**
 * How a turn's reasoning reads — while it streams, and after it settles.
 *
 * Measured on this deployment: a DeepSeek turn closes 10 thinking blocks at the median, 51 at p90
 * and 115 at the worst, totalling 23k characters at the median and 122k at p90. Rendered a block
 * per row that was a stack of identical "Thinking" lines; rendered unbounded while streaming it
 * was a wall that pushed the answer out of the viewport.
 */

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({ seq, type, payload });
const heads = (html: string): number => html.match(/chat-think-head/g)?.length ?? 0;

describe('a settled stretch of reasoning', () => {
  it('folds a run of adjacent blocks into a single row that counts them', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          ev(1, 'thinking', { text: 'a'.repeat(400) }),
          ev(2, 'thinking', { text: 'b'.repeat(600) }),
          ev(3, 'thinking', { text: 'c'.repeat(1000) }),
        ]}
      />,
    );

    expect(heads(html)).toBe(1);
    expect(html).toContain('3 blocks');
  });

  it('keeps a block either side of a tool call on its own row', () => {
    // Those two are not one thought: each explains the call it sits against, and merging across
    // the call would attribute the second one's reasoning to the first one's card.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          ev(1, 'thinking', { text: 'why I am about to run this' }),
          ev(2, 'tool_use', { id: 't1', name: 'Bash', input: { command: 'nvidia-smi' } }),
          ev(3, 'tool_result', { toolUseId: 't1', content: '300 W' }),
          ev(4, 'thinking', { text: 'what the output means' }),
        ]}
      />,
    );

    expect(heads(html)).toBe(2);
    expect(html).not.toContain('blocks');
  });

  it('states how long it took when the page watched it stream', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[ev(1, 'thinking', { text: 'weighing it up', thinkingMs: 12_000 })]} />,
    );

    expect(html).toContain('Thought for 12s');
  });

  it('states size alone after a reload, rather than a duration it cannot know', () => {
    // `thinking_delta` is broadcast and never persisted, so a reloaded block has no clock behind
    // it. Size still answers "is opening this worth it".
    const html = renderToStaticMarkup(<Transcript events={[ev(1, 'thinking', { text: 'x'.repeat(2300) })]} />);

    expect(html).toContain('2.3k chars');
    expect(html).not.toContain('Thought for');
  });

  it('draws nothing for a block whose text never arrived', () => {
    // Claude closes every block with {"thinking":"","signature":"…"} — 84% of the durable rows on
    // this deployment. Rendering those would paper a reloaded transcript with blank rows.
    const html = renderToStaticMarkup(<Transcript events={[ev(1, 'thinking', { text: '' })]} />);

    expect(heads(html)).toBe(0);
  });
});

describe('a stretch still being written', () => {
  it('holds the live reasoning in a scrolling viewport, with its clock running', () => {
    // `LiveSeconds` prints `Date.now() - startedAt` as it renders, through a formatter that rounds,
    // so a 12s reading tolerates 500ms of the render itself — and a loaded host's mount runs past
    // that. Date alone is frozen: the test's own clock is what moves, not the tolerance.
    vi.useFakeTimers({ toFake: ['Date'] });
    const html = renderToStaticMarkup(
      <StreamingDraftsCtx.Provider value={{ text: '', think: 'weighing it up', thinkStartedAt: Date.now() - 12_000 }}>
        <Transcript events={[ev(1, 'user', { text: 'go' })]} live streamingAfterSeq={1} />
      </StreamingDraftsCtx.Provider>,
    );
    vi.useRealTimers();

    expect(html).toContain('chat-think-port');
    expect(html).toContain('weighing it up');
    expect(html).toContain('12s');
  });

  it('runs no clock on a page that opened mid-block', () => {
    // Nothing timed the part that arrived before the page did, so it reports no duration rather
    // than one measured from when the tab happened to open.
    const html = renderToStaticMarkup(
      <StreamingDraftsCtx.Provider value={{ text: '', think: 'weighing it up' }}>
        <Transcript events={[ev(1, 'user', { text: 'go' })]} live streamingAfterSeq={1} />
      </StreamingDraftsCtx.Provider>,
    );

    expect(html).toContain('chat-think-port');
    expect(html).not.toMatch(/\d+s</);
  });
});
