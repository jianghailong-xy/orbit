// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidToBase62 } from '@orbit/shared';
import { ExportCtx, type RunEvent, Transcript } from './Transcript';
import { WatchWakeNamesCtx } from './WatchWakeCard';

/**
 * A turn a watch queued lands in the observer's transcript as a `user` event, because it went through
 * the ordinary queue (docs/watch-contract.md §6). Drawn as a bubble it reads as something the user
 * typed — a block of JSON under their name. It is drawn as one event line in the agent's stream
 * instead, the grammar a background job's news uses (BackgroundWakeCard): what happened, which target
 * moved, how it came out and when, with why, every target, the way to the watch and the words the
 * agent read one disclosure away. Anything that only resembles a wake stays the person's bubble.
 */

const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
const TASK = '0195c0de-0000-7000-8000-0000000000d4';
const OTHERS = ['0195c0de-0000-7000-8000-0000000000d5', '0195c0de-0000-7000-8000-0000000000d6'];

type Changed = { kind: string; id: string; state: string; observed?: { status: string } };

/** Built the way watch-delivery.service.ts `watchTurnContent` builds it (lib/watches.test.ts holds the
 *  two to the same words). */
function matchWake(reason: string, changedTargets: Changed[]): string {
  return [
    `Orbit Watch ${WATCH} matched at generation 1: ${reason}`,
    '',
    'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
    '',
    '```json',
    JSON.stringify(
      {
        watchId: WATCH,
        generation: 1,
        matchedAt: '2026-09-14T11:59:00.000Z',
        reason,
        changedTargets,
        latestSnapshot: { evaluatedAt: '2026-09-14T11:59:00.000Z', targets: [] },
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}

const changed = (id: string, status: string): Changed => ({ kind: 'TASK', id, state: 'SATISFIED', observed: { status } });

const WAKE = matchWake('ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)', [changed(TASK, 'FAILED')]);
const DONE = matchWake('ANY TASK_TERMINAL 1/1', [changed(TASK, 'DONE')]);
const THREE = matchWake('ANY_OF(ALL TASK_TERMINAL 3/3, ANY TASK_FAILED 1/3)', [
  changed(TASK, 'FAILED'),
  ...OTHERS.map((id) => changed(id, 'DONE')),
]);

// Built the way watch-delivery.service.ts `watchExpiryTurnContent` builds it.
const EXPIRED = [
  `Orbit Watch ${WATCH} EXPIRED at 2026-09-14T12:59:00.000Z without its condition ever holding.`,
  '',
  'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again. What its last evaluation saw:',
  '',
  '```json',
  JSON.stringify(
    { watchId: WATCH, state: 'EXPIRED', expiresAt: '2026-09-14T12:59:00.000Z', latestSnapshot: { targets: [] } },
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

async function mount(events: RunEvent[], names?: (watchId: string, target: { id: string }) => string | undefined) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WatchWakeNamesCtx.Provider value={names ?? null}>
          <Transcript events={events} />
        </WatchWakeNamesCtx.Provider>
      </MemoryRouter>,
    );
  });
}

const text = (el: Element | null, selector: string) => el?.querySelector(selector)?.textContent?.trim();

describe('a turn a watch queued', () => {
  it('is one line in the agent’s stream, not a message the user typed', async () => {
    await mount([userEvent(WAKE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    const line = container.querySelector('.watch-wake')!;
    expect(line.getAttribute('data-seq')).toBe('7');
    // What happened, which target, how it came out, when — on the line itself.
    const row = line.querySelector('.bgwake-row')!;
    expect(text(row, '.bgwake-title')).toBe('Watch triggered');
    // No title held for the task here, so its kind and the end of its id — not the start, which is
    // the creation time every task made in the same minute shares.
    expect(text(row, '.bgwake-name')).toBe(`Task ${uuidToBase62(TASK).slice(-8)}`);
    expect(text(row, '.bgwake-status')).toBe('FAILED');
    expect(row.querySelector('.bgwake-time')?.textContent).not.toBe('');
    expect(text(row, '.bgwake-details-label')).toBe('详情');
    // A task that failed takes the error tone, as a failed job's line does.
    expect(line.classList.contains('is-failed')).toBe(true);
  });

  it('keeps why, every target, who queued it and what the agent read in its fold', async () => {
    await mount([userEvent(WAKE)]);

    const line = container.querySelector('.watch-wake')!;
    const fold = line.querySelector('details.bgwake-fold')!;
    expect(fold.hasAttribute('open'), 'folded until the line is pressed').toBe(false);
    expect(text(fold, '.watch-wake-why')).toBe('2 of 3 finished · 1 of 3 failed');
    expect(text(fold, '.watch-wake-changed')).toBe(`Task ${uuidToBase62(TASK)} is now FAILED`);
    // Who queued it, said in the fold: when is on the line.
    expect(text(fold, '.bgwake-meta')).toBe('Queued by a watch, not typed by you · generation 1');
    const view = [...fold.querySelectorAll('a')].find((a) => a.textContent === 'View watch');
    expect(view?.getAttribute('href')).toBe(`/following?watch=${uuidToBase62(WATCH)}`);
    // What the agent read is kept, whole, one more disclosure away.
    const raw = fold.querySelector('details.bgwake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('pre')?.textContent).toBe(WAKE);
    // A lone target is the line itself: nothing of it is kept out of the fold.
    expect(line.querySelector('.watch-wake-failures')).toBeNull();
  });

  it('is no turn the sticky bar points at', async () => {
    await mount([userEvent(WAKE)]);
    expect(container.querySelector('[data-sticky-label]')).toBeNull();
    expect(container.querySelector('[data-sticky-text]')).toBeNull();
  });

  it('names a target by the title the console holds for it, on the line and in its row', async () => {
    await mount([userEvent(DONE)], (watchId, target) =>
      watchId === WATCH && target.id === TASK ? 'Keep the question once it is answered' : undefined,
    );

    const line = container.querySelector('.watch-wake')!;
    expect(text(line, '.bgwake-name')).toBe('Keep the question once it is answered');
    expect(text(line, '.bgwake-status')).toBe('DONE');
    expect(text(line, '.watch-wake-changed')).toBe('Task Keep the question once it is answered is now DONE');
    // Done is no failure: the watch's eye in the line's quiet tone.
    expect(line.classList.contains('is-ok')).toBe(true);
  });

  it('counts several targets, and keeps the failed one in view under the line', async () => {
    await mount([userEvent(THREE)]);

    const line = container.querySelector('.watch-wake')!;
    expect(text(line, '.bgwake-name')).toBe('3 tasks');
    expect(text(line, '.bgwake-status')).toBe('1 of 3 failed');
    expect(line.classList.contains('is-failed')).toBe(true);
    // Every target in the fold…
    expect(line.querySelectorAll('.bgwake-fold .watch-wake-changed li')).toHaveLength(3);
    // …and the failed one outside it, linked, for as long as the fold is closed (index.css hides it
    // under an open fold, which lists it with the rest).
    const failures = line.querySelector('.watch-wake-failures')!;
    expect(failures.parentElement).toBe(line);
    expect([...failures.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      `Task ${uuidToBase62(TASK)} is now FAILED`,
    ]);
    expect(failures.querySelector('a')?.getAttribute('href')).toBe(`/tasks/${uuidToBase62(TASK)}`);
  });

  it('says a watch ran out in its title, with no target to name and no failure', async () => {
    await mount([userEvent(EXPIRED)]);

    const line = container.querySelector('.watch-wake')!;
    expect(text(line, '.bgwake-title')).toBe('Watch expired');
    expect(line.querySelector('.bgwake-name')).toBeNull();
    expect(line.querySelector('.bgwake-status')).toBeNull();
    expect(line.classList.contains('is-ok')).toBe(true);
    expect(text(line, '.watch-wake-why')).toBe(
      'Its deadline passed before its condition held. It will not wake this session again.',
    );
    expect(text(line, '.bgwake-meta')).toBe('Queued by a watch, not typed by you');
  });

  it('stays the person’s bubble when it only resembles a wake', async () => {
    const pasted = WAKE.slice(0, WAKE.indexOf('```json'));
    await mount([userEvent(pasted)]);

    expect(container.querySelector('.watch-wake')).toBeNull();
    expect(container.querySelector('.chat-user')?.textContent).toContain('Orbit Watch');
  });

  it('keeps the line in an exported transcript, without a link to a page the file cannot reach', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[userEvent(WAKE)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');
    expect(exported.querySelector('.watch-wake .bgwake-title')?.textContent?.trim()).toBe('Watch triggered');
    expect([...exported.querySelectorAll('a')].some((a) => a.textContent === 'View watch')).toBe(false);
    expect(exported.querySelector('details.bgwake-raw pre')?.textContent).toBe(WAKE);
  });
});
