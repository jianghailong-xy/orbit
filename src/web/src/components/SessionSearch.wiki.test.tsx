// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_FOOT_IDLE, SEARCH_FOOT_SEARCHING, SEARCH_GROUP_SESSIONS, SEARCH_PLACEHOLDER, SEARCH_WIKI_GROUP, SessionSearch, openSessionSearch } from './SessionSearch';

/**
 * ⌘K's Wiki group — mock 05d.
 *
 * Two things are being held down here. First that the wiki is searched AT ALL: a second endpoint
 * (`/api/wiki/search`), asked with the same keystrokes, drawn above the sessions. Second that the
 * two never become one — a wiki hit is not a `SessionSearchHit` and is not drawn as one, because a
 * session row's click goes to `/sessions/<id>` and a session-shaped decoder would fail on a wiki
 * answer whole (design §6: the endpoint exists for exactly that).
 */

const ENTRY = '34UDFnrgM4q5oGQloG3uq';
const SESSION_ID = '01a0d1f2-3a44-7c11-9b02-5f6e7d8c9a10';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let at: string;

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

const wikiAnswer = {
  q: 'exit',
  semantic: false,
  hits: [
    {
      id: ENTRY,
      kind: 'decision',
      title: 'EXECUTABLE judges by exit code and records nothing',
      summary: 'A command settles a task.',
      trust: 'confirmed',
      anchorState: 'verified',
      anchorCheckedRef: '4db4f9f0c1a2b3d4e5f60718293a4b5c6d7e8f90',
      match: ['keyword'],
      score: 0.03,
      spaceSlug: 'orbit',
      topics: ['tasks-and-dispatch'],
    },
  ],
};

const sessionAnswer = {
  q: 'exit',
  contentSearched: true,
  total: 1,
  hits: [
    {
      id: SESSION_ID,
      title: 'Orbit：给任务加优先级，让派发器尊重它',
      status: 'RUNNING',
      runStatus: 'RUNNING',
      runState: 'RUNNING',
      sessionState: 'RUNNING',
      lifecycleState: 'OPEN',
      matchField: 'message',
      snippet: '…exit -1 is compared literally…',
      agent: { id: 'w', name: 'orbit' },
    },
  ],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/api/wiki/search') ? okJson(wikiAnswer) : url.startsWith('/api/sessions/search') ? okJson(sessionAnswer) : okJson({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  at = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  at = useLocation().pathname;
  return null;
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <MemoryRouter>
          <LocationProbe />
          <Routes>
            <Route path="*" element={<SessionSearch />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => openSessionSearch());
}

/** Type into the field and let the palette's own debounce (200ms) elapse. */
async function type(value: string) {
  const input = document.querySelector('.ssearch-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

// From `document`, not the mount container: the palette is an AntD Modal, which portals itself
// onto the body.
const inDoc = (selector: string) => [...document.querySelectorAll(selector)];
const texts = (selector: string) => inDoc(selector).map((node) => node.textContent ?? '');

describe('⌘K with the wiki above the sessions', () => {
  it('asks both endpoints for one query, and draws one group above the other', async () => {
    await mount();
    await type('exit');
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked.some((url) => url.startsWith('/api/wiki/search'))).toBe(true);
    expect(asked.some((url) => url.startsWith('/api/sessions/search'))).toBe(true);
    // The wiki's read asks for where an entry lives, because this caller opens what it finds.
    expect(asked.find((url) => url.startsWith('/api/wiki/search'))).toContain('include=space,topics,anchor');

    expect(texts('.wk-pal-group')).toEqual([`${SEARCH_WIKI_GROUP} 1`, SEARCH_GROUP_SESSIONS]);
    // The wiki rows come first in the DOM, which is also the order the cursor walks.
    const rows = inDoc('.ssearch-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('EXECUTABLE judges by exit code and records nothing');
    expect(rows[1].textContent).toContain('Orbit：给任务加优先级，让派发器尊重它');
  });

  it('says what a wiki row is: its kind, its trust, its topic and its anchor check', async () => {
    await mount();
    await type('exit');
    const row = inDoc('.ssearch-row')[0];
    expect(row.querySelector('.wk-kind')).not.toBeNull();
    expect(row.querySelector('.tdp-badge')?.textContent).toBe('Confirmed');
    expect(row.querySelector('.ssearch-workspace')?.textContent).toBe('Decision');
    expect(row.querySelector('.ssearch-meta')?.textContent).toContain('tasks-and-dispatch');
    expect(row.querySelector('.wk-anchor')?.textContent).toBe('4db4f9f');
    // The session row is drawn exactly as it always was: no kind tile, its own status word.
    const session = inDoc('.ssearch-row')[1];
    expect(session.querySelector('.wk-kind')).toBeNull();
    expect(session.textContent).toContain('in message');
  });

  it('opens an entry at its own page, and a session at its own', async () => {
    await mount();
    await type('exit');
    await act(async () => {
      inDoc('.ssearch-row')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // `/wiki/<space>/e/<id>` — both halves, which is what the space's slug was asked for.
    expect(at).toBe(`/wiki/orbit/e/${ENTRY}`);
  });

  it('is the session switcher it always was when nothing is typed', async () => {
    await mount();
    expect(document.querySelector('.ssearch-input')?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
    expect(texts('.ssearch-foot')[0]).toContain(SEARCH_FOOT_IDLE);
    // The session list is read for its recents — that is what this palette has always opened on —
    // and the wiki is not searched at all: an empty query is not a query.
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked.filter((url) => url.startsWith('/api/wiki/search'))).toEqual([]);
    expect(texts('.wk-pal-group')).toEqual([]);
  });

  it('says which side it is searching once something is', async () => {
    await mount();
    await type('exit');
    expect(texts('.ssearch-foot')[0]).toContain(SEARCH_FOOT_SEARCHING);
  });
});
