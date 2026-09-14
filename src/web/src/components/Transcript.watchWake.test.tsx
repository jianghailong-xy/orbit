// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidToBase62 } from '@orbit/shared';
import { ExportCtx, type RunEvent, Transcript } from './Transcript';

/**
 * A turn a watch queued lands in the observer's transcript as a `user` event, because it went through
 * the ordinary queue (docs/watch-contract.md §6). Drawn as a bubble it reads as something the user
 * typed — a block of JSON under their name. It is drawn as the watch's card instead, with the words the
 * agent read one disclosure away, and anything that only resembles a wake stays the person's bubble.
 */

const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
const TASK = '0195c0de-0000-7000-8000-0000000000d4';

// Built the way watch-delivery.service.ts `watchTurnContent` builds it (lib/watches.test.ts holds the
// two to the same words).
const WAKE = [
  `Orbit Watch ${WATCH} matched at generation 1: ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)`,
  '',
  'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  '',
  '```json',
  JSON.stringify(
    {
      watchId: WATCH,
      generation: 1,
      matchedAt: '2026-09-14T11:59:00.000Z',
      reason: 'ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)',
      changedTargets: [{ kind: 'TASK', id: TASK, state: 'SATISFIED', observed: { status: 'FAILED' } }],
      latestSnapshot: { evaluatedAt: '2026-09-14T11:59:00.000Z', targets: [] },
    },
    null,
    2,
  ),
  '```',
].join('\n');

const userEvent = (text: string): RunEvent => ({
  seq: 7,
  type: 'user',
  turnId: 'turn-1',
  ts: '2026-09-14T11:59:01.000Z',
  payload: { text },
});

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

// Budgeted like the other watch specs: the first Transcript mount alone ran 7.8s on a loaded host, past the 5s default.
describe('a turn a watch queued', { timeout: 30_000 }, () => {
  it('is drawn as the watch’s card, not as a message the user typed', async () => {
    await mount([userEvent(WAKE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    const card = container.querySelector('.watch-wake')!;
    expect(card.getAttribute('data-seq')).toBe('7');
    expect(card.querySelector('.watch-wake-title')?.textContent?.trim()).toBe('Watch triggered');
    expect(card.querySelector('.watch-wake-why')?.textContent).toBe('2 of 3 finished · 1 of 3 failed');
    expect(card.querySelector('.watch-wake-changed')?.textContent).toBe(`Task ${uuidToBase62(TASK)} is now FAILED`);
    expect(card.querySelector('.watch-wake-meta')?.textContent).toMatch(
      /^Queued by a watch, not typed by you · generation 1 · /,
    );
    const view = [...card.querySelectorAll('a')].find((a) => a.textContent === 'View watch');
    expect(view?.getAttribute('href')).toBe(`/following?watch=${uuidToBase62(WATCH)}`);
    // What the agent read is kept, whole, one disclosure away.
    const raw = card.querySelector('details.watch-wake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('pre')?.textContent).toBe(WAKE);
  });

  it('stays the person’s bubble when it only resembles a wake', async () => {
    const pasted = WAKE.slice(0, WAKE.indexOf('```json'));
    await mount([userEvent(pasted)]);

    expect(container.querySelector('.watch-wake')).toBeNull();
    expect(container.querySelector('.chat-user')?.textContent).toContain('Orbit Watch');
  });

  it('keeps the card in an exported transcript, without a link to a page the file cannot reach', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[userEvent(WAKE)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');
    expect(exported.querySelector('.watch-wake-title')?.textContent?.trim()).toBe('Watch triggered');
    expect([...exported.querySelectorAll('a')].some((a) => a.textContent === 'View watch')).toBe(false);
    expect(exported.querySelector('details.watch-wake-raw pre')?.textContent).toBe(WAKE);
  });
});
