import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { claudeRegionRefusedError, claudeRegionStoppedError, CLAUDE_REGION_REFUSED_SUBTYPE, CLAUDE_REGION_STOPPED_SUBTYPE } from '@orbit/shared';
import { describe, expect, it } from 'vitest';
import { TURN_ENDED_WITHOUT_REPLY, type RunEvent, Transcript } from './Transcript';

/**
 * The runner's error events for the Claude region check (docs/claude-region-check-contract.md §9,
 * §10). A refused turn's session is held with a card that says why and offers the ways out, so the
 * transcript draws no red line with the raw `CLAUDE_REGION_UNSUPPORTED: …` under it. A turn stopped by
 * a confirmed flip (owner decision ④) has no card: its sentence stands, without the code.
 */

const dom = (html: string) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
const render = (events: RunEvent[], live = false) => dom(renderToStaticMarkup(<Transcript events={events} live={live} />));
const lines = (doc: Document) => [...doc.querySelectorAll('.chat-error')].map((n) => n.textContent?.replace(/^✖\s*/, '') ?? '');

const user = (seq: number, text = 'Now do the same for the sign-up test.'): RunEvent => ({
  seq,
  type: 'user',
  payload: { text },
  turnId: 't2',
  ts: '2026-10-31T11:59:00Z',
});
const error = (seq: number, message: string): RunEvent => ({ seq, type: 'error', payload: { message }, turnId: 't2' });
const turnEnd = (seq: number, subtype: string): RunEvent => ({ seq, type: 'turn_end', payload: { subtype }, turnId: 't2' });

const REFUSAL = claudeRegionRefusedError('HPC', 'mainland China');
const STOPPED = claudeRegionStoppedError('HPC', 'mainland China');

describe('a region refusal in the transcript', () => {
  it('draws no line: the held session’s card says it', () => {
    const doc = render([user(1), error(2, REFUSAL)]);
    expect(lines(doc)).toEqual([]);
    expect(doc.body.textContent).not.toContain('CLAUDE_REGION_UNSUPPORTED');
    // The message it refused is still drawn, waiting.
    expect(doc.body.textContent).toContain('Now do the same for the sign-up test.');
  });

  it('accounts for the turn, so a refused turn’s end is no unexplained failure', () => {
    const doc = render([user(1), error(2, REFUSAL), turnEnd(3, CLAUDE_REGION_REFUSED_SUBTYPE)]);
    expect(lines(doc)).toEqual([]);
    expect(doc.body.textContent).not.toContain(TURN_ENDED_WITHOUT_REPLY);
  });
});

describe('a turn stopped for the region', () => {
  it('says the stopped sentence without its code', () => {
    const doc = render([user(1), error(2, STOPPED), turnEnd(3, CLAUDE_REGION_STOPPED_SUBTYPE)]);
    expect(lines(doc)).toEqual([
      'Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude.',
    ]);
    expect(doc.body.textContent).not.toContain('CLAUDE_REGION_UNSUPPORTED');
  });
});

describe('other error events', () => {
  it('are drawn as they always were', () => {
    const doc = render([user(1), error(2, 'spawn claude ENOENT')]);
    expect(lines(doc)).toEqual(['spawn claude ENOENT']);
  });
});
