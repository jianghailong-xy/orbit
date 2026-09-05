import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Where the pending strip is MOUNTED, which is the half of this that no render can answer.
 *
 * The rule the strip exists to satisfy is about layout, not about markup: what is recomputed every
 * turn is pinned under the header and does not move when the conversation does, and what happened
 * once stays in the log and scrolls with it. Rendering the strip on its own cannot tell you which
 * side of that line it ended up on — only the composition can, and the composition lives in a
 * component that needs a router, a query client and a live session to render at all.
 *
 * So this reads the composition as text. It is a weaker instrument than a render and it is the
 * right one here: the failure it has to catch is somebody moving one JSX element a few lines down,
 * into the scroller, where the strip would look identical in every screenshot and then scroll away
 * the moment a long answer arrived. That is exactly how it got into the transcript's vertical flow
 * the first time.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');

/** The scroller itself, and the wrapper that holds it: everything inside these moves with the
 *  conversation. `scrollRef` is attached to `.workspace-sessions`, which is what makes it the
 *  scrolling element rather than merely the one with the messages in it. */
const SCROLL_WRAP = '<div className="workspace-scroll-wrap">';

describe('the pending strip is pinned, and the decision log is not', () => {
  it('mounts the strip above the element that scrolls', () => {
    const strip = SOURCE.indexOf('<SessionDecisionStrip');
    const scroller = SOURCE.indexOf(SCROLL_WRAP);

    expect(strip, 'the strip is not mounted at all').toBeGreaterThan(-1);
    expect(scroller, 'the transcript scroller was renamed; this scan is reading the wrong thing')
      .toBeGreaterThan(-1);
    expect(strip, 'the strip was moved into the scrolling area').toBeLessThan(scroller);
    // Once, and above: a second mount inside the scroller would satisfy an `indexOf` and put the
    // thing back in the flow.
    expect(SOURCE.split('<SessionDecisionStrip').length - 1).toBe(1);
  });

  it('puts the strip under the header rather than in the conversation column', () => {
    // Above the sticky question too, which is the other thing pinned there. On the screenshot this
    // came from, the strip sat below it — between `↑ Your question` and the next reply, with no
    // boundary of its own, which is what made it read as a message nobody sent.
    const strip = SOURCE.indexOf('<SessionDecisionStrip');
    const stickyQuestion = SOURCE.indexOf('chat-sticky-label');
    expect(stickyQuestion).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(stickyQuestion);
    // And it is not a child of the message list: the scroller opens after it and closes after the
    // transcript, so nothing between those two points can be the strip.
    const insideScroller = SOURCE.slice(SOURCE.indexOf(SCROLL_WRAP));
    expect(insideScroller).not.toContain('<SessionDecisionStrip');
  });

  it('keeps the decision log inside the scroller, where the rest of the history is', () => {
    const scroller = SOURCE.indexOf(SCROLL_WRAP);
    const log = SOURCE.indexOf('<DecisionLog');
    const transcript = SOURCE.indexOf('<Transcript');

    expect(log, 'a decision leaves nothing behind in the log').toBeGreaterThan(-1);
    // An event, in the flow, after the conversation it happened during.
    expect(log).toBeGreaterThan(scroller);
    expect(log).toBeGreaterThan(transcript);
  });

  it('scopes the log to the session it was decided in', () => {
    // One tab can answer questions belonging to several sessions in turn. Keyed by session id, so
    // switching does not carry one conversation's answers into another's transcript.
    expect(SOURCE).toMatch(/decisionEvents\[selectedId\]/);
    expect(SOURCE).toMatch(/useState<Record<string, string\[\]>>/);
  });
});
