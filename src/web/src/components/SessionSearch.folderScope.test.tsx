// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_FOOT_IDLE,
  SEARCH_PLACEHOLDER,
  SEARCH_SCOPE_REMOVE,
  SessionSearch,
  openSessionSearch,
  searchEmptyIn,
  searchFootIdleIn,
  searchPlaceholderIn,
  setSessionSearchScope,
} from './SessionSearch';

/**
 * ⌘K from a folder's page (docs/mocks/session-folder-page-filter, board E): the palette opens scoped
 * to the folder the list is on, says so with a chip, and searches only that folder's sessions until
 * the chip is taken off — by its ✕, by Backspace in an empty field, or by the empty answer's
 * Search everywhere.
 */

const FOLDER_ID = '0195c0de-0000-7000-8000-000000000911';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let found = 0;

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

const hits = (n: number) => ({
  q: '',
  contentSearched: true,
  total: n,
  hits: Array.from({ length: n }, (_, i) => ({
    id: `01a0d1f2-3a44-7c11-9b02-5f6e7d8c9a1${i}`,
    title: `Session ${i}`,
    status: 'AWAITING_INPUT',
    runState: 'AWAITING_INPUT',
    lifecycleState: 'OPEN',
    matchField: 'title',
    snippet: null,
    agent: { id: 'w', name: 'orbit' },
  })),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  found = 1;
  fetchMock = vi.fn(async (url: string) => (url.startsWith('/api/sessions/search') ? okJson(hits(found)) : okJson({})));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  setSessionSearchScope(null);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount() {
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
  await settle();
}

async function type(value: string) {
  const input = document.querySelector('.ssearch-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
  await settle();
}

const searches = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/sessions/search'));
const placeholder = () => document.querySelector('.ssearch-input')?.getAttribute('placeholder');
const foot = () => document.querySelector('.ssearch-foot')?.textContent ?? '';

describe('⌘K from a folder’s page', () => {
  it('opens scoped to the folder, and asks for that folder’s sessions alone', async () => {
    setSessionSearchScope({ folderId: FOLDER_ID, name: 'Release' });
    await mount();
    expect(document.querySelector('.ssearch-scope-name')?.textContent).toBe('Release');
    expect(placeholder()).toBe(searchPlaceholderIn('Release'));
    expect(foot()).toContain(searchFootIdleIn('Release'));
    expect(searches().at(-1)).toContain(`folderId=${FOLDER_ID}`);

    await type('notes');
    expect(searches().at(-1)).toMatch(/q=notes.*folderId=/u);
    // The wiki has no folders: a scoped palette does not ask it.
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.startsWith('/api/wiki/search'))).toBe(false);
  });

  it('widens to everything when the chip’s ✕ is pressed', async () => {
    setSessionSearchScope({ folderId: FOLDER_ID, name: 'Release' });
    await mount();
    await act(async () => {
      document.querySelector('.ssearch-scope-remove')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(document.querySelector('.ssearch-scope')).toBeNull();
    expect(placeholder()).toBe(SEARCH_PLACEHOLDER);
    expect(foot()).toContain(SEARCH_FOOT_IDLE);
    expect(searches().at(-1)).not.toContain('folderId=');
  });

  it('widens on Backspace in an empty field, and only then', async () => {
    setSessionSearchScope({ folderId: FOLDER_ID, name: 'Release' });
    await mount();
    const input = document.querySelector('.ssearch-input') as HTMLInputElement;
    await type('n');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(document.querySelector('.ssearch-scope'), 'a Backspace that deletes a letter keeps the scope').not.toBeNull();
    await type('');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    await settle();
    expect(document.querySelector('.ssearch-scope')).toBeNull();
  });

  it('offers Search everywhere when the folder has no match', async () => {
    setSessionSearchScope({ folderId: FOLDER_ID, name: 'Release' });
    found = 0;
    await mount();
    await type('runner');
    const empty = document.querySelector('.ssearch-empty');
    expect(empty?.textContent).toContain(searchEmptyIn('Release', 'runner'));
    const widen = empty?.querySelector('.ssearch-empty-widen');
    expect(widen?.textContent).toBe(SEARCH_SCOPE_REMOVE);
    await act(async () => {
      widen!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(searches().at(-1)).toMatch(/q=runner&limit=20$/u);
  });

  it('opens unscoped from anywhere else', async () => {
    await mount();
    expect(document.querySelector('.ssearch-scope')).toBeNull();
    expect(searches().every((url) => !url.includes('folderId='))).toBe(true);
  });
});
