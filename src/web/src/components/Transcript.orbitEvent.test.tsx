// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZH_JOB_DONE, ZH_SCHEDULED } from '../lib/backgroundWake.fixtures';
import { SUBAGENT_DONE } from '../lib/subagentFinished.fixtures';
import type { RunEvent } from './Transcript';

/**
 * Owner rule (2026-11-16): the right side of a conversation is only for words the person typed. A
 * turn Orbit opened whose note is a block no client knows used to fall through to the reader's own
 * bubble — empty, with `⊕ Orbit attached: context` and the raw block — which is how a SubAgent's end
 * first reached the owner. It is a generic `From Orbit` line in the agent's stream instead, so the
 * next new block cannot regress the same way. Known blocks keep their own lines; typed words keep
 * their bubble.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { Transcript } = await import('./Transcript');

const TS = '2026-11-16T09:00:00.000Z';
const FUTURE = '<orbit-future-thing>\n  Something the control plane will say one day.\n</orbit-future-thing>';

/** A `user` event as ingest stores it: the echo (typed words, then the note) and the note. */
const userEvent = (typed: string, note?: string): RunEvent => ({
  seq: 9,
  type: 'user',
  turnId: 'turn-9',
  ts: TS,
  payload: note === undefined ? { text: typed } : { text: `${typed}${typed ? '\n\n' : ''}${note}`, controlPlaneNote: note },
});

// A watch's expiry turn, as watch-delivery.service.ts `watchExpiryTurnContent` builds it: its words
// are the turn's text, not a note.
const WATCH_EXPIRED = [
  'Orbit Watch 34wat0000000000000000 EXPIRED at 2026-09-14T12:59:00.000Z without its condition ever holding.',
  '',
  'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again. What its last evaluation saw:',
  '',
  '```json',
  JSON.stringify({ watchId: '34wat0000000000000000', state: 'EXPIRED', latestSnapshot: { targets: [] } }, null, 2),
  '```',
].join('\n');

describe('a turn carrying only Orbit’s blocks', () => {
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
  });

  async function mount(events: RunEvent[]) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>,
      );
    });
  }

  it('draws an unknown block as the left-side From Orbit line, the raw block under Details', async () => {
    await mount([userEvent('', FUTURE)]);

    expect(container.querySelector('.chat-user'), 'no bubble on the reader’s side').toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.querySelector('[data-orbit-round]'), 'no sticky anchor').toBeNull();
    const line = container.querySelector<HTMLElement>('.bgwake.orbitwake');
    expect(line, container.innerHTML).not.toBeNull();
    expect(line!.getAttribute('data-seq')).toBe('9');
    const row = line!.querySelector('summary.bgwake-row')!;
    expect(row.querySelector('.bgwake-mark')?.textContent).toBe('⊕');
    expect(row.querySelector('.bgwake-title')?.textContent).toBe('From Orbit');
    expect(row.querySelector('.bgwake-name')?.textContent).toBe('context');
    expect(row.querySelector('.bgwake-time')?.textContent).not.toBe('');
    expect(row.querySelector('.bgwake-details-label')?.textContent).toBe('Details');
    const raw = line!.querySelector('.bgwake-body details.bgwake-raw')!;
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent read');
    expect(raw.querySelector('pre')?.textContent).toBe(FUTURE);
  });

  it('names a block describeNote knows, and is still not the reader’s bubble', async () => {
    const note = '<orbit-session-reply>\n  a reply\n</orbit-session-reply>';
    await mount([userEvent('', `${FUTURE}\n\n${note}`)]);
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.querySelector('.orbitwake .bgwake-name')?.textContent).toBe('context, session reply');
  });

  it('leaves the known blocks their own lines', async () => {
    for (const [event, selector] of [
      [userEvent('', ZH_SCHEDULED), '.bgwake:not(.orbitwake)'],
      [userEvent(WATCH_EXPIRED), '.watch-wake'],
    ] as const) {
      await mount([event]);
      expect(container.querySelector(selector), container.innerHTML).not.toBeNull();
      expect(container.querySelector('.orbitwake'), 'no generic line').toBeNull();
      expect(container.querySelector('.chat-user'), 'no bubble').toBeNull();
    }
  });

  // A background job's news is drawn on its job's card (JobCard), so its turn draws nothing either.
  it('draws nothing for a background job’s news, which its card draws', async () => {
    await mount([userEvent('', ZH_JOB_DONE)]);
    expect(container.querySelector('.bgwake, .orbitwake, .chat-user'), container.innerHTML).toBeNull();
  });

  // A SubAgent's end is drawn on its card (SubagentCardEnd), so its turn draws nothing at all: not its own
  // line, not this generic one, not the reader's bubble.
  it('draws nothing for a SubAgent’s end, which its card draws', async () => {
    await mount([userEvent('', SUBAGENT_DONE)]);
    expect(container.querySelector('.bgwake, .orbitwake, .chat-user'), container.innerHTML).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('keeps typed words in the reader’s bubble and omits the appended note', async () => {
    await mount([userEvent('Ship it', FUTURE)]);
    expect(container.querySelector('.orbitwake')).toBeNull();
    expect(container.querySelector('.chat-user')?.textContent).toContain('Ship it');
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain('orbit-future');
  });
});
