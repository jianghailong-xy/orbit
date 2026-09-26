// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPreview } from '@orbit/shared';
import { WikiContextNote, WIKI_CONTEXT_FILTER_NOTE } from './WikiContextNote';
import { OrbitLinkCardsProvider } from './OrbitLinkCard';
import { statusLabel } from './WorkspaceView';
import { decodeId } from '../lib/idCodec';
import type { WikiContext } from '../lib/wikiContext';

/**
 * The wiki context a session was handed, opened — mock 05a's list.
 *
 * The rows are drawn from the block's own lines, and the TRUST beside each one is not in it: the
 * push block goes to the model, which needs the note rather than who stands behind it. So each row
 * asks the control plane the same question a link card asks (`POST /api/link-previews`), and what
 * this file pins is both halves of that — the row list, and that a row wears no dot until its answer
 * arrives rather than guessing one.
 */

const HOST = 'localhost:3000';
const ENTRY = '34UDFnrgM4q5oGQloG3uq';
const OTHER = '34UDFnrgM4q5odj4MVdXD';

const context: WikiContext = {
  entries: [
    {
      kind: 'Principle',
      title: 'A clock never starts agent work',
      summary: 'Work starts from a committed fact.',
      id: ENTRY,
    },
    {
      kind: 'Pitfall',
      title: 'Piping a test run into grep hides its exit code',
      summary: 'A pipeline reports the last command.',
      id: OTHER,
    },
  ],
  text: '<orbit_wiki_context entries="2">…</orbit_wiki_context>',
  rest: '',
};

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const preview = (id: string, trust: string): LinkPreview => ({
  kind: 'wiki',
  id,
  state: 'ok',
  wiki: {
    spaceId: '34Tcl0kralZrY8opuLJU4',
    spaceSlug: 'orbit',
    kind: 'principle',
    title: 'A principle',
    summary: 'A summary.',
    trust: trust as 'owner',
    status: 'active',
    anchorState: 'verified',
    anchorCheckedRef: '4db4f9f0c1a2b3d4e5f60718293a4b5c6d7e8f90',
    anchor: { type: 'path', path: 'open-item-escalation.service.ts' },
  },
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = url === '/api/link-previews'
      ? { previews: (JSON.parse(String(init.body)) as { refs: Array<{ kind: string; id: string }> }).refs.map(
          // The wire carries the canonical uuid, not the public id the block spelled.
          (ref) => preview(ref.id, ref.id === decodeId(ENTRY) ? 'owner' : 'confirmed'),
        ) }
      : {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(withCards: boolean) {
  const inner = <WikiContextNote context={context} />;
  await act(async () => {
    root.render(
      withCards ? (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
          <MemoryRouter>
            <OrbitLinkCardsProvider stateWord={statusLabel} host={HOST}>
              {inner}
            </OrbitLinkCardsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      ) : (
        <MemoryRouter>{inner}</MemoryRouter>
      ),
    );
  });
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const texts = (selector: string) =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent ?? '');

describe('the entries under the folded Wiki context line', () => {
  it('lists each one as its kind and its title, and says what the block was filtered by', async () => {
    await mount(true);
    expect(texts('.wkctx-kind')).toEqual(['Principle', 'Pitfall']);
    expect(texts('.wkctx-title')).toEqual([
      'A clock never starts agent work',
      'Piping a test run into grep hides its exit code',
    ]);
    expect(texts('.wkctx-foot')).toEqual([WIKI_CONTEXT_FILTER_NOTE]);
    // The summary is the row's tooltip, not a second line: the mock's rows are one line each.
    expect(container.querySelector('.wkctx-title')?.getAttribute('title')).toBe(
      'Work starts from a committed fact.',
    );
  });

  it('reads who stands behind each entry, and opens the entry its title names', async () => {
    await mount(true);
    // Two rows, one request: the entries ride the same batch a card's link does.
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/link-previews')).toHaveLength(1);
    expect(texts('.wk-dot')).toEqual(['', '']);
    expect(texts('.wk-dot.owner')).toHaveLength(1);
    expect(texts('.wk-dot.confirmed')).toHaveLength(1);
    // The href takes the space as well as the entry — `/wiki/<space>/e/<id>` — which is why each
    // row asked for the entry rather than being told about it.
    expect(container.querySelector('.wkctx-title')?.getAttribute('href')).toBe(`/wiki/orbit/e/${ENTRY}`);
  });

  it('draws the same rows outside a conversation view, with no dot and no link', async () => {
    await mount(false);
    expect(texts('.wkctx-title')).toEqual([
      'A clock never starts agent work',
      'Piping a test run into grep hides its exit code',
    ]);
    expect(texts('.wk-dot')).toEqual([]);
    expect(container.querySelector('a.wkctx-title')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
