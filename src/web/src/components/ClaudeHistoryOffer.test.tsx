import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaudeHistoryResult } from '../api';
import { ClaudeHistoryOffer, fmtTranscriptSize } from './ClaudeHistoryOffer';

/** renderToStaticMarkup escapes these in text nodes, so copy assertions have to look for what is
 *  actually written into the HTML — an apostrophe searched raw is a match that can never happen. */
const escaped = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

const historyOf = (count: number): ClaudeHistoryResult => ({
  workDir: '/root/take-over-me',
  windowDays: 30,
  conversations: count,
  bytes: 4_718_592,
  events: count * 85,
  transcripts: Array.from({ length: count }, (_, i) => ({
    claudeSessionId: `0000000${i}-0000-4000-8000-00000000000${i}`,
    title: i === 0 ? 'first principles' : `conversation ${i}`,
    lastActiveAt: new Date(Date.UTC(2026, 8, 15 - i, 12, 0, 0)).toISOString(),
    messages: 158 - i,
  })),
});

const render = (count: number, value: 'none' | 'latest' | 'all' = 'none'): string =>
  renderToStaticMarkup(
    <ClaudeHistoryOffer history={historyOf(count)} value={value} onChange={() => {}} />,
  );

describe('ClaudeHistoryOffer', () => {
  it('states what is in the directory, over the window the runner actually looked at', () => {
    const html = render(6);
    expect(html).toContain('6 Claude Code conversations');
    expect(html).toContain('in this directory');
    // The window is the runner's answer, not a constant this file believes: a scan that looked
    // back 30 days must not be described as "all your history".
    expect(html).toContain('last 30 days');
    expect(html).toContain('4.5 MB');
  });

  it('offers exactly three choices, with importing nothing the one already selected', () => {
    const html = render(6);
    expect(html).toContain(escaped("Don't import"));
    expect(html).toContain(escaped("Only the one I'm in the middle of"));
    expect(html).toContain('All 6');
    // Default: taking over a directory must not upload its transcripts because somebody pressed
    // Create without reading. The checked input is the one that imports nothing.
    const checked = html.match(/<input[^>]*checked[^>]*>/g) ?? [];
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="none"');
  });

  it('names the conversation the user is in the middle of — the newest one', () => {
    const html = render(6);
    expect(html).toContain('first principles');
    expect(html).toContain('158 messages');
    // The second-newest belongs to "All", not to the single-conversation offer.
    expect(html).not.toContain('157 messages');
  });

  it('says what "all of them" costs and that it does not hold the workspace up', () => {
    const html = render(6);
    expect(html).toContain('~510 events');
    expect(html).toContain('imported in the background');
    expect(html).toContain('the workspace is usable right away');
  });

  it('warns what a transcript carries, and that it can be undone', () => {
    const html = render(6);
    expect(html).toContain('rd-path-warn');
    expect(html).toContain('full tool output');
    expect(html).toContain('They can be removed later.');
  });

  it('is the same offer at six hundred conversations as at six — no list, no select all', () => {
    const small = render(6);
    const huge = render(600);
    const inputs = (html: string): number => (html.match(/<input/g) ?? []).length;
    // Three radios either way: the panel cannot grow with the directory, because the decision it
    // asks for is about the directory as a whole.
    expect(inputs(small)).toBe(3);
    expect(inputs(huge)).toBe(3);
    expect(huge).not.toContain('Select all');
    // Neither transcript list is rendered: the newest is named in one line, the rest are counted.
    expect(huge).not.toContain('conversation 2');
    expect(huge).toContain('All 600');
    expect(huge).toContain('600 Claude Code conversations');
  });

  it('counts "All N" from the transcripts it can actually import', () => {
    // A directory holding more than one scan carries: the statistic states the directory, the
    // choice states what pressing it will import, and the two are allowed to disagree out loud
    // rather than promising history this cannot reach.
    const capped: ClaudeHistoryResult = { ...historyOf(200), conversations: 640 };
    const html = renderToStaticMarkup(
      <ClaudeHistoryOffer history={capped} value="all" onChange={() => {}} />,
    );
    expect(html).toContain('640 Claude Code conversations');
    expect(html).toContain('All 200');
  });

  it('renders one conversation as a conversation, not "1 conversations"', () => {
    expect(render(1)).toContain('1 Claude Code conversation<');
  });

  it('sizes transcripts in the unit the offer states', () => {
    expect(fmtTranscriptSize(4_718_592)).toBe('4.5 MB');
    expect(fmtTranscriptSize(70_000)).toBe('68 KB');
    // Never "0 KB": a directory with transcripts in it always weighs something.
    expect(fmtTranscriptSize(12)).toBe('1 KB');
  });
});
