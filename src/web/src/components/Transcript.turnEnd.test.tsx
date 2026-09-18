import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TURN_ENDED_WITHOUT_REPLY, type RunEvent, Transcript } from './Transcript';

/**
 * A turn that ended without answering has to say so.
 *
 * The runner has always reported it — `turn_end` carries the engine's `subtype`, and the four
 * emitters send `success` / `completed` when the turn finished and something else when it did not.
 * The transcript dropped the payload and drew a bare divider whose entire style is `margin: 12px 0`,
 * so an engine that never spawned reached the reader as twelve pixels of blank.
 *
 * The rule is stated the way round that survives a new failure: the two subtypes that mean the turn
 * finished are named, and everything else is a turn that did not. What the marker must NOT do is
 * say it twice — in the recorded corpus every codex `failed` turn already carries its own `error`
 * event, and 190 of the 200 `error_during_execution` turns are the user pressing stop and already
 * carry an `interrupt` row.
 */

const dom = (html: string) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;

const render = (events: RunEvent[]) => dom(renderToStaticMarkup(<Transcript events={events} />));

const userEvent = (seq: number): RunEvent => ({ seq, type: 'user', payload: { text: 'go' } });
const turnEnd = (seq: number, subtype: string): RunEvent => ({
  seq,
  type: 'turn_end',
  payload: { subtype, numTurns: 0, costUsd: 0 },
});

const markers = (doc: Document) =>
  [...doc.querySelectorAll('.chat-error')].map((n) => n.textContent?.replace(/^✖\s*/, '') ?? '');

describe('a turn_end that did not finish the turn', () => {
  it('leaves a visible marker instead of the 12-pixel divider', () => {
    const doc = render([userEvent(1), turnEnd(2, 'error_during_execution')]);

    expect(markers(doc)).toContain(TURN_ENDED_WITHOUT_REPLY);
    expect(doc.querySelectorAll('.chat-turn-divider')).toHaveLength(0);
  });

  it('says it in words a reader can act on, never the engine’s subtype', () => {
    const doc = render([userEvent(1), turnEnd(2, 'error_during_execution')]);

    expect(doc.body.textContent).not.toContain('error_during_execution');
  });

  it('marks a subtype nobody has seen yet, because the rule names the good endings', () => {
    const doc = render([userEvent(1), turnEnd(2, 'error_starting_engine')]);

    expect(markers(doc)).toContain(TURN_ENDED_WITHOUT_REPLY);
  });

  it('still draws a plain divider when the turn finished', () => {
    for (const subtype of ['success', 'completed']) {
      const doc = render([userEvent(1), turnEnd(2, subtype)]);

      expect(markers(doc)).toHaveLength(0);
      expect(doc.querySelectorAll('.chat-turn-divider')).toHaveLength(1);
    }
  });

  it('does not accuse the engine when the user is the one who stopped the turn', () => {
    const doc = render([
      userEvent(1),
      { seq: 2, type: 'interrupt', payload: {} },
      turnEnd(3, 'error_during_execution'),
    ]);

    expect(markers(doc)).toHaveLength(0);
  });

  it('does not repeat a failure the turn already reported as an error', () => {
    const doc = render([
      userEvent(1),
      { seq: 2, type: 'error', payload: { message: 'stream disconnected' } },
      turnEnd(3, 'failed'),
    ]);

    expect(markers(doc)).toEqual(['stream disconnected']);
  });

  it('marks each failing turn on its own, so one accounted-for turn does not cover the next', () => {
    const doc = render([
      userEvent(1),
      { seq: 2, type: 'error', payload: { message: 'stream disconnected' } },
      turnEnd(3, 'failed'),
      userEvent(4),
      turnEnd(5, 'error_during_execution'),
    ]);

    expect(markers(doc)).toEqual(['stream disconnected', TURN_ENDED_WITHOUT_REPLY]);
  });
});
