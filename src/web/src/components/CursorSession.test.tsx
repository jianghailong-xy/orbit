// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CURSOR_QUEUE_NOTE } from '../lib/cursorRuntime';
import { PendingTray, type PendingTrayRow } from './PendingTray';
import { AutoRetryCtx, type AutoRetryHelp, type RunEvent, Transcript } from './Transcript';

/**
 * A Cursor CLI session's own words (the owner's board, docs/mocks/cursor-engine Web 5): the tray says
 * why a message sent mid-turn waits for the next turn (contract §3.2), and the usage-limit card names the
 * account in Orbit's words, quotes Cursor, says until when, and — the conversation not moving to another
 * account yet (D5) — where a new session can go instead.
 */

const queued = (over: Partial<PendingTrayRow> = {}): PendingTrayRow => ({
  key: 'q1',
  heading: 'next',
  text: 'Also add a line about the fix to CHANGELOG.md',
  previews: [],
  imageIds: [],
  files: 0,
  state: 'Queued for next turn',
  ...over,
});

describe('the tray under a running Cursor CLI turn', () => {
  it('says under the queued rows why none goes into the running turn', () => {
    const html = renderToStaticMarkup(<PendingTray rows={[queued()]} note={CURSOR_QUEUE_NOTE} />);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('.pending-tray-note')?.textContent).toBe(
      'Cursor CLI can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends.',
    );
    // The note comes after every row.
    expect(doc.querySelector('.pending-tray')?.lastElementChild?.className).toBe('pending-tray-note');
  });

  it('says nothing of the kind over a steer, nor on an engine that has no note to give', () => {
    expect(renderToStaticMarkup(<PendingTray rows={[queued({ heading: 'current', state: 'Waiting to be read' })]} note={CURSOR_QUEUE_NOTE} />)).not.toContain(
      'pending-tray-note',
    );
    expect(renderToStaticMarkup(<PendingTray rows={[queued()]} />)).not.toContain('pending-tray-note');
  });
});

// What the runner reports for a turn Cursor ended on the account's usage limit (cursorUsageLimitText).
const LIMIT = 'You\'ve hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."';
const render = (help: AutoRetryHelp) =>
  renderToStaticMarkup(
    <AutoRetryCtx.Provider value={help}>
      <Transcript events={[{ seq: 1, type: 'error', payload: { message: LIMIT } } as RunEvent]} />
    </AutoRetryCtx.Provider>,
  );
const text = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ') ?? '';

describe('the usage-limit card of a Cursor CLI session', () => {
  it('names the account and its plan, quotes Cursor, and offers a new session on an account with room', () => {
    const html = render({
      provider: 'cursor',
      runnerName: 'hpc',
      cursor: { account: 'Default', plan: 'Free', resetsAt: '2026-10-02T16:00:00.000Z', elsewhere: { label: 'Team', start: () => {} } },
    });
    expect(html).toContain('Usage limit reached');
    const words = text(html);
    expect(words).toContain('The quota for Default (Cursor CLI) on “hpc” is used up.');
    expect(words).toMatch(/Cursor answered “Upgrade your plan to continue”: Default’s Free plan has no requests left until Oct [23]\./);
    expect(words).toContain('This conversation can’t move to Team yet — start a new session on Team.');
    expect(html).toContain('class="chat-quota-link"');
    // Never the engine's slug as whose quota it was.
    expect(words).not.toContain('for cursor');
  });

  it('says only what Cursor said when nothing is known of the plan, and offers no account there is none of', () => {
    const words = text(render({ provider: 'cursor', runnerName: 'hpc', cursor: { account: 'Cursor', elsewhere: null } }));
    expect(words).toContain('The quota for Cursor (Cursor CLI) on “hpc” is used up.');
    expect(words).toContain('Cursor answered “Upgrade your plan to continue”.');
    expect(words).not.toContain('start a new session');
  });

  it('speaks of a paid plan’s included usage, not its requests', () => {
    const words = text(render({ provider: 'cursor', cursor: { account: 'Team', plan: 'Pro', resetsAt: null } }));
    expect(words).toContain('Team’s Pro plan has no included usage left.');
  });
});
