// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { SidebarProject } from '../lib/projectAttention';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * How the rail's middle scrolls (docs/mocks/sidebar-projects-scroll, 02): under the fixed entries,
 * Workspaces and Projects scroll as one, except while every Workspace fits with the Projects head
 * still showing under them — then the Workspaces stay put and only Projects scrolls. jsdom lays
 * nothing out, so the boxes the panel measures are given here, and its ResizeObserver is a stand-in
 * the tests fire by hand.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');

const A = encodeId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = encodeId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const C = encodeId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const RUNNER = encodeId('0000000f-0000-4000-8000-00000000000f');
const PROJECT = encodeId('0196a000-0000-7000-8000-000000000001');

const WORKSPACES = [
  { id: A, name: 'alpha', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: RUNNER },
  { id: B, name: 'bravo', createdAt: '2026-09-02T00:00:00.000Z', position: 1, runnerId: RUNNER },
  { id: C, name: 'charlie', createdAt: '2026-09-03T00:00:00.000Z', position: 2, runnerId: RUNNER },
];
const PROJECTS: SidebarProject[] = [
  {
    id: PROJECT,
    title: 'Checkout page redesign',
    status: 'OPEN',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-02T00:00:00.000Z',
    buckets: { running: 0 },
    attention: { ownerItems: [] },
    coordinatorActivity: null,
  },
];

function serve(projects: SidebarProject[] = PROJECTS, wikis: Array<{ id: string; slug: string; title: string }> = []) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/runners') return [{ id: RUNNER, name: 'wikova', online: true }];
    if (path === '/workspaces') return WORKSPACES;
    if (path === '/projects/sidebar') return projects;
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') return wikis;
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

/**
 * The boxes the panel reads, in px from the list's top: the list's height; how far down the Projects
 * head ends (the Workspaces group starts at 0); and where the first Workspace row starts, each row
 * 36 tall, moved up by however far the list is scrolled.
 */
const geometry = { list: 0, headBottom: 0, firstRow: 0, firstWikiRow: 0 };
const rect = (top: number, height: number) =>
  ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 280, width: 280, height, toJSON: () => ({}) }) as DOMRect;
function boxOf(el: Element): DOMRect {
  const lists = document.querySelector<HTMLElement>('.tp-lists');
  const scrolled = lists?.scrollTop ?? 0;
  if (el.classList.contains('tp-lists')) return rect(0, geometry.list);
  if (el.classList.contains('tp-group-workspaces')) return rect(-scrolled, 0);
  if (el.matches('.tp-group-projects > .tp-group-head')) return rect(geometry.headBottom - 32, 32);
  const rows = [...document.querySelectorAll('.tp-group-workspaces .tp-item')];
  const index = rows.indexOf(el);
  if (index >= 0) return rect(geometry.firstRow + index * 36 - scrolled, 36);
  const wikiIndex = [...document.querySelectorAll('.tp-group-wiki .tp-item')].indexOf(el);
  if (wikiIndex >= 0) return rect(geometry.firstWikiRow + wikiIndex * 36 - scrolled, 36);
  return rect(0, 0);
}

/** A stand-in ResizeObserver: the panel's callbacks, fired by `resize()` as a resize would. */
const observing = new Set<() => void>();
const observed = new Set<Element>();
class FakeResizeObserver {
  private readonly fire: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.fire = () => callback([], this as unknown as ResizeObserver);
    observing.add(this.fire);
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve() {}
  disconnect() {
    observing.delete(this.fire);
  }
}
async function resize(next: Partial<typeof geometry>): Promise<void> {
  Object.assign(geometry, next);
  await act(async () => {
    for (const fire of observing) fire();
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function press(key: 'ArrowUp' | 'ArrowDown'): Promise<void> {
  const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  await act(async () => {
    document.activeElement!.dispatchEvent(event);
  });
  await settle();
}

const lists = () => container!.querySelector<HTMLElement>('.tp-lists')!;
const pinned = () => lists().classList.contains('pin-workspaces');

beforeEach(() => {
  serve();
  Object.assign(geometry, { list: 0, headBottom: 0, firstRow: 0, firstWikiRow: 0 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return boxOf(this);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observing.clear();
  observed.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the rail scrolls Workspaces and Projects as one, or only Projects while every Workspace fits', () => {
  it('holds both groups in one list under the fixed entries, which no scroll reaches', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await visit(`/workspaces/${A}`);
    const middle = container!.querySelector('.tp-scroll')!;
    expect([...middle.children].map((child) => child.className)).toEqual([
      'tp-section',
      'tp-divider',
      'tp-lists autohide-scrollbar',
    ]);
    expect([...lists().children].map((child) => child.className)).toEqual([
      'tp-group tp-group-workspaces',
      'tp-divider',
      'tp-group tp-group-projects autohide-scrollbar',
    ]);
    expect(middle.classList.contains('autohide-scrollbar')).toBe(false);
  });

  it('keeps the Workspaces put once they and the Projects head fit, to the pixel', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await visit(`/workspaces/${A}`);
    // Not laid out yet: no room, so the two scroll as one.
    expect(pinned()).toBe(false);

    // 13 rows of 36, the 17 px gap and the 32 px head: 549 px, in a list exactly that tall.
    await resize({ list: 549, headBottom: 549 });
    expect(pinned()).toBe(true);

    // A pixel short, as a window shrinks: Projects would lose its head, so they scroll as one again.
    await resize({ list: 548 });
    expect(pinned()).toBe(false);

    // And back as it grows.
    await resize({ list: 800 });
    expect(pinned()).toBe(true);
  });

  it('watches the Wiki group too: it stands above the Projects head, so folding it moves the head', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    serve(PROJECTS, [{ id: 'wiki-1', slug: 'orbit', title: 'orbit' }]);
    await visit(`/workspaces/${A}`);
    expect(observed.has(container!.querySelector('.tp-group-wiki')!)).toBe(true);

    await resize({ list: 549, headBottom: 549 });
    expect(pinned()).toBe(true);
    // The Wiki rows bring the head past the room there is, as they do with the group unfolded.
    await resize({ headBottom: 549 + 36 });
    expect(pinned()).toBe(false);
  });

  it('scrolls the wiki `/wiki` lit into the list, or nothing lit would say where you are', async () => {
    Object.assign(geometry, { list: 550, firstWikiRow: 600 });
    serve(PROJECTS, [
      { id: 'wiki-1', slug: 'cbai', title: 'cbai' },
      { id: 'wiki-2', slug: 'orbit', title: 'orbit' },
    ]);
    await visit('/wiki/orbit/activity');
    // The second row ends at 600 + 36 + 36, in a list 550 tall.
    expect(lists().scrollTop).toBe(122);
  });

  it('pins nothing with no open project, or a list with no height (the rail folded to its icons)', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    serve([]);
    await visit(`/workspaces/${A}`);
    await resize({ list: 800, headBottom: 549 });
    expect(container!.querySelector('.tp-group-projects')).toBeNull();
    expect(pinned()).toBe(false);

    act(() => root?.unmount());
    container?.remove();
    serve();
    await visit(`/workspaces/${A}`);
    await resize({ list: 0, headBottom: 0 });
    expect(pinned()).toBe(false);
  });

  it('leaves the two scrolling as one where there is no ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    Object.assign(geometry, { list: 800, headBottom: 549 });
    await visit(`/workspaces/${A}`);
    expect(pinned()).toBe(false);
  });

  it('scrolls a Workspace reached with ⌘↓ or ⌘↑ into the shared list, moving the list alone', async () => {
    // The list is 100 tall and its rows start 40 down: alpha (40–76) shows, bravo (76–112) is cut.
    Object.assign(geometry, { list: 100, headBottom: 200, firstRow: 40 });
    await visit(`/workspaces/${A}`);
    expect(lists().scrollTop).toBe(0);

    await press('ArrowDown');
    expect(container!.querySelector('.tp-item.active .tp-workspace-name')?.textContent).toBe('bravo');
    // Just enough to show bravo's foot.
    expect(lists().scrollTop).toBe(12);

    // Scrolled on past it by hand, ⌘↑ from charlie brings bravo's top back.
    await press('ArrowDown');
    expect(lists().scrollTop).toBe(48);
    lists().scrollTop = 100;
    await press('ArrowUp');
    expect(container!.querySelector('.tp-item.active .tp-workspace-name')?.textContent).toBe('bravo');
    expect(lists().scrollTop).toBe(76);
  });
});
