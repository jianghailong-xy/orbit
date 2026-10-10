// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * What the composer calls the thumbnail of a picture staged to go out with the message.
 *
 * The thumbnail is the button that opens the picture in the viewer (Orbit Image: a Tab stop that Enter and Space
 * press), so it needs a name. The picture adds nothing beside the file it came from and stays decorative (`alt=""`);
 * the button is named by the file, or "Preview image" when the file has no name. Before, the button took the empty
 * `alt` as its name, and a browser named it from the cover's icon instead: "eye".
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), uploadAttachment: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, uploadAttachment } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c3');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** Waiting for the next message, so the composer takes attachments. */
const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Name the staged picture',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-10-10T09:00:00Z',
  updatedAt: '2026-10-10T09:05:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

/** Waits with the act environment off, as RTL's asyncWrapper does, then one act flushes what the wait saw. */
const waitForUi = async (assertion: () => void): Promise<void> => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

async function mount(): Promise<void> {
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  const nextClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // The session is read: the composer under it takes attachments from here on.
  await waitForUi(() => {
    expect(mounted().querySelector('.workspace-name')?.textContent).toBe(SESSION.title);
  });
}

const png = (name: string): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

/** Pastes files into the composer, as from the clipboard. */
async function paste(files: File[]): Promise<void> {
  const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) },
  });
  await act(async () => {
    box.dispatchEvent(event);
  });
}

const thumbnails = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.composer-attach .orbit-image')];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
  let uploaded = 0;
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(uploadAttachment).mockImplementation(async () => ({ id: `att-${(uploaded += 1)}` }) as never);
  let made = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:staged-${(made += 1)}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
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
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the thumbnail of a staged picture', { timeout: 60_000 }, () => {
  it('is a button named by its file, or "Preview image" when the file has no name, over a decorative picture', async () => {
    await mount();
    await paste([png('screenshot.png'), png('')]);
    await waitForUi(() => {
      expect(uploadAttachment).toHaveBeenCalledTimes(2);
      expect(thumbnails()).toHaveLength(2);
    });

    expect(thumbnails().map((thumb) => [thumb.getAttribute('role'), thumb.tabIndex, thumb.getAttribute('aria-label')])).toEqual([
      ['button', 0, 'screenshot.png'],
      ['button', 0, 'Preview image'],
    ]);
    expect(thumbnails().map((thumb) => thumb.querySelector('img')?.getAttribute('alt'))).toEqual(['', '']);
  });
});
