// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Where a session says it is public, and the three ways out of its ⋯ menu
 * (docs/share-links-design.md §3, §8; mock 06-manage-and-entry ⑤ ⑥), on the real WorkspaceView:
 *
 *   - the list row of a session a link opens carries a globe beside its time, and no other row does;
 *   - the open conversation's header says "Shared · Live";
 *   - the ⋯ menu offers Copy link (the signed-in address), Share… (with "Live link" while one is
 *     open) and Download HTML (read as the owner — no public link needed);
 *   - moving a shared session to Trash first says its link pauses, and comes back on restore.
 */

// The helpers below call api() from inside api.ts, where mocking the export cannot reach them, so
// the three this file is about are stubbed by name.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    getShareLink: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));
// The export itself is sessionExport.download.test's subject; here, only that the menu asks for it.
vi.mock('../lib/sessionExport', () => ({ downloadSessionHtml: vi.fn(async () => {}) }));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));

const { api, deleteSession, getSession, getSessionEventPage, getShareLink } = await import('../api');
const apiMock = vi.mocked(api);
const { downloadSessionHtml } = await import('../lib/sessionExport');
const { copyText } = await import('../lib/clipboard');
const { WorkspaceView, SESSION_SHARED_TIP } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const SHARED_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c3');
const PLAIN_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c4');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const WORKSPACE = { id: WORKSPACE_PUBLIC, name: 'orbit', model: null, effort: null };

/** A list row as GET /sessions answers it; `shared` is the list's own flag. */
const row = (id: string, title: string, shared: boolean) => ({
  id,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-09-22T09:00:00Z',
  lastTurnAt: '2026-09-22T09:05:00Z',
  shared,
});
const SHARED = row(SHARED_PUBLIC, '子代理模型由伺服器端設定', true);
const PLAIN = row(PLAIN_PUBLIC, 'T8 收尾：各端统一「池不可用」口径', false);
/** The detail carries the open link's token (null when none opens it). */
const DETAIL: Record<string, Record<string, unknown>> = {
  [SHARED_PUBLIC]: { ...SHARED, shareToken: 'k3Qx9vR2mT7wLp4sYb8nZc1eHf6uJd0a' },
  [PLAIN_PUBLIC]: { ...PLAIN, shareToken: null },
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
/** Every write the page sent, as `METHOD path`. */
const writes: string[] = [];

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(sessionId: string): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Both list rows drawn, and the detail read (the header's pill waits for nothing but the list).
  await act(async () => {
    await vi.waitFor(() => expect(mounted().querySelectorAll('.session-row')).toHaveLength(2), {
      timeout: 20_000,
      interval: 20,
    });
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const listRow = (title: string): HTMLElement => {
  const found = [...mounted().querySelectorAll<HTMLElement>('.session-row')].find(
    (el) => el.querySelector('.session-title')?.textContent === title,
  );
  if (!found) throw new Error(`no list row titled ${title}`);
  return found;
};

/** Opens the conversation header's ⋯ menu and hands back the popup antd mounted. */
async function openHeaderMenu(): Promise<HTMLElement> {
  await click(mounted().querySelector('.workspace-header button[title="More actions"]'), 'the header ⋯ button');
  await act(async () => {
    await vi.waitFor(() => expect(document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')).not.toBeNull(), {
      timeout: 10_000,
      interval: 20,
    });
  });
  return document.querySelector<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')!;
}

/** The menu's rows below the tags, top to bottom; a divider is a row of its own. */
const drawn = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll(':scope > .ant-dropdown-menu-item, :scope > .ant-dropdown-menu-item-divider')].map((el) =>
    el.classList.contains('ant-dropdown-menu-item-divider') ? '─' : (el.textContent ?? '').trim(),
  );

const item = (menu: HTMLElement, label: string): HTMLElement => {
  const found = [...menu.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find((el) =>
    (el.textContent ?? '').trim().startsWith(label),
  );
  if (!found) throw new Error(`no ${label} row in the menu:\n${menu.outerHTML}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writes.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(downloadSessionHtml).mockClear();
  vi.mocked(copyText).mockClear();
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (id: string) => DETAIL[id] as never);
  vi.mocked(deleteSession).mockReset();
  vi.mocked(deleteSession).mockImplementation(async (id: string) => {
    writes.push(`DELETE /sessions/${id}`);
  });
  vi.mocked(getShareLink).mockReset();
  vi.mocked(getShareLink).mockResolvedValue({ link: null, counts: { messages: 2, toolCalls: 0 } });
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') {
      writes.push(`${init.method} ${path}`);
      return reply(undefined);
    }
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    for (const id of [SHARED_PUBLIC, PLAIN_PUBLIC]) {
      if (path.startsWith(`/sessions/${id}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(DETAIL[id]);
      }
    }
    if (path.startsWith('/sessions')) return reply([SHARED, PLAIN]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('a shared session in the session list and its conversation', { timeout: 60_000 }, () => {
  it('puts a globe beside the time of the row a link opens, and on no other row', async () => {
    await mount(SHARED_PUBLIC);

    const globe = listRow(SHARED.title).querySelector<HTMLElement>('.session-title-row .session-shared');
    expect(globe, 'the shared row has no globe').not.toBeNull();
    expect(globe!.getAttribute('title')).toBe('Shared · anyone with the link');
    expect(globe!.getAttribute('title')).toBe(SESSION_SHARED_TIP);
    expect(globe!.querySelector('.anticon-global')).not.toBeNull();
    // Beside the time: the globe is the element right before it.
    expect(globe!.nextElementSibling?.classList.contains('session-time')).toBe(true);
    expect(listRow(PLAIN.title).querySelector('.session-shared')).toBeNull();
  });

  it('says "Shared · Live" in the header of a shared conversation, and nothing in one nobody shared', async () => {
    await mount(SHARED_PUBLIC);
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.workspace-header .session-shared-pill')).not.toBeNull());
    });
    expect(mounted().querySelector('.workspace-header .session-shared-pill')?.textContent?.trim()).toBe('Shared · Live');

    await act(async () => root!.unmount());
    root = null;
    container?.remove();
    await mount(PLAIN_PUBLIC);
    expect(mounted().querySelector('.workspace-header .session-shared-pill')).toBeNull();
  });

  it('offers Copy link, Share… · Live link and Download HTML, in that order, above Delete', async () => {
    await mount(SHARED_PUBLIC);
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.workspace-header .session-shared-pill')).not.toBeNull());
    });
    const menu = await openHeaderMenu();

    const rows = drawn(menu);
    expect(rows.slice(rows.indexOf('Complete'))).toEqual([
      'Complete',
      '─',
      'Copy link',
      'Share…Live link',
      'Download HTML',
      '─',
      'Delete',
    ]);
    expect(item(menu, 'Share…').querySelector('.scope-menu-value')?.textContent).toBe('Live link');
  });

  it('a session nobody shared offers plain Share…', async () => {
    await mount(PLAIN_PUBLIC);
    const menu = await openHeaderMenu();
    expect(drawn(menu)).toContain('Share…');
    expect(item(menu, 'Share…').querySelector('.scope-menu-value')).toBeNull();
    expect(drawn(menu)).toContain('Copy link');
    expect(drawn(menu)).toContain('Download HTML');
  });

  it('Copy link copies the signed-in address, not the public one', async () => {
    await mount(SHARED_PUBLIC);
    const menu = await openHeaderMenu();
    await click(item(menu, 'Copy link'), 'Copy link');
    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/sessions/${SHARED_PUBLIC}`);
  });

  it('Download HTML exports this session as its owner', async () => {
    await mount(SHARED_PUBLIC);
    const menu = await openHeaderMenu();
    await click(item(menu, 'Download HTML'), 'Download HTML');
    await act(async () => {
      await vi.waitFor(() => expect(downloadSessionHtml).toHaveBeenCalledTimes(1));
    });
    expect(vi.mocked(downloadSessionHtml).mock.calls[0][0]).toMatchObject({
      id: SHARED_PUBLIC,
      title: SHARED.title,
      workspace: { name: 'orbit' },
    });
  });

  it('Share… opens the unified dialog on this session', async () => {
    await mount(PLAIN_PUBLIC);
    const menu = await openHeaderMenu();
    await click(item(menu, 'Share…'), 'Share…');
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('.ant-modal.share-dialog')).not.toBeNull());
    });
    expect(document.querySelector('.ant-modal.share-dialog .ant-modal-title')?.textContent).toBe('Share session');
    expect(getShareLink).toHaveBeenCalledWith('SESSION', PLAIN_PUBLIC);
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.querySelector('.ant-modal.share-dialog .share-access-select')?.textContent?.trim()).toBe('Only you'),
      );
    });
  });

  it('moving a shared session to Trash first says its link pauses and comes back on restore', async () => {
    await mount(SHARED_PUBLIC);
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.workspace-header .session-shared-pill')).not.toBeNull());
    });
    const menu = await openHeaderMenu();
    await click(item(menu, 'Delete'), 'Delete');

    const confirm = document.querySelector<HTMLElement>('.ant-modal-confirm');
    expect(confirm, 'no question before trashing a shared session').not.toBeNull();
    expect(confirm!.querySelector('.ant-modal-confirm-title')?.textContent).toBe('Move to Trash?');
    expect(confirm!.querySelector('.ant-modal-confirm-content')?.textContent).toBe(
      'Its public link is paused while the session is in Trash. Restoring the session turns the link back on.',
    );
    expect(writes, 'trashed before it was confirmed').toEqual([]);

    await click(
      [...confirm!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Move to Trash'),
      'Move to Trash',
    );
    expect(writes).toEqual([`DELETE /sessions/${SHARED_PUBLIC}`]);
  });

  it('a session nobody shared moves to Trash at once, as before', async () => {
    await mount(PLAIN_PUBLIC);
    const menu = await openHeaderMenu();
    await click(item(menu, 'Delete'), 'Delete');
    expect(document.querySelector('.ant-modal-confirm')).toBeNull();
    expect(writes).toEqual([`DELETE /sessions/${PLAIN_PUBLIC}`]);
  });
});
