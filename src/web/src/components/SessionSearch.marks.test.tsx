// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MARKS, sessionMarks } from '../lib/sessionDisplay';
import { SessionSearch, openSessionSearch } from './SessionSearch';

/**
 * The ⌘K palette's session rows draw the state word and every mark (docs/mocks/session-display-three-states), over the
 * cross-client check's search cases. search/search-payloads.json is server-built (search/make-search-payloads.cjs: each
 * case's hit beside its list row, read through the server's services on a real PostgreSQL); Android's search tests
 * read the same file.
 */

type Row = { name: string; searchHit: Record<string, any>; listRow: Record<string, any> };
const ROWS: Row[] = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../scripts/acceptance/session-three-state-check/search/search-payloads.json'),
    'utf8',
  ),
);

/** The state word and the marks of each case, as Apple's search row and the board draw them. */
const EXPECTED: Record<string, [state: string, marks: string[]]> = {
  PENDING: ['Queued', []],
  RUNNING: ['Running', []],
  AWAITING_INPUT: ['Idle', []],
  INTERRUPTED: ['Idle', ['Interrupted']],
  SUCCEEDED: ['Idle', ['Finished']],
  FAILED: ['Idle', ['Failed']],
  CANCELLED: ['Idle', ['Ended']],
  'job running': ['Running', ['Background']],
  'waiting on an approval': ['Running', ['Needs you']],
  'watch armed': ['Idle', []],
  'paused account': ['Queued', ['On hold']],
  'ended, runner never confirmed': ['Idle', ['Ended']],
  'old plain row stored SUCCEEDED': ['Idle', ['Ended']],
  'ending after an interrupted turn': ['Idle', ['Interrupted']],
  'parked, engine started its own turn': ['Running', []],
  'parked, sub-agent running': ['Running', []],
  'parked, background process left up': ['Idle', ['Background']],
  'parked, retry armed': ['Idle', []],
  'failed, retry armed': ['Idle', ['Retrying']],
  'failed, runner offline': ['Idle', ['Failed']],
  'approval beside a background job': ['Running', ['Needs you', 'Background']],
  'interrupted, a process up, retry armed': ['Idle', ['Interrupted', 'Background']],
};

const FACTS = ['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'workFinished', 'activity', 'runningBgCount'];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Opens the palette on one hit and returns its row. */
async function searchRow(hit: Record<string, any>): Promise<Element> {
  const body = { q: '', contentSearched: true, total: 1, hits: [hit] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = url.startsWith('/api/sessions/search') ? body : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json } as unknown as Response;
  }));
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <MemoryRouter>
          <SessionSearch />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => openSessionSearch());
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((done) => setTimeout(done, 0)));
  }
  const row = document.querySelector('.ssearch-row');
  expect(row).not.toBeNull();
  return row!;
}

const drawnMarks = (row: Element) => [...row.querySelectorAll('[data-mark]')].map((el) => el.textContent);
const stateWord = (row: Element) => row.querySelector('.ssearch-meta > .ssearch-workspace + span')?.textContent;

describe('search rows over the server-built search payloads', () => {
  it('covers the 22 cases', () => {
    expect(ROWS.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(ROWS)('$name: draws the state word and every mark, as its list row does', async ({ name, searchHit, listRow }) => {
    const [state, marks] = EXPECTED[name];
    const row = await searchRow(searchHit);
    expect(stateWord(row)).toBe(state);
    expect(drawnMarks(row)).toEqual(marks);
    expect(marks).toEqual((sessionMarks(listRow) ?? []).map((m) => SESSION_MARKS[m].word));
  });

  it.each(ROWS)('$name: draws no marks when the server sends no facts', async ({ searchHit }) => {
    const older = Object.fromEntries(Object.entries(searchHit).filter(([key]) => !FACTS.includes(key)));
    const row = await searchRow(older);
    expect(row.querySelector('.session-marks')).toBeNull();
    expect(stateWord(row)).toBeTruthy();
  });
});
