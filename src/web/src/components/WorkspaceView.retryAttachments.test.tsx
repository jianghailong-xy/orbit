// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The files a re-send carries.
 *
 * The bytes never left: an attachment is uploaded once, the turn references it by id, and the row
 * outlives the turn that failed (`Attachment.turnId` → `ConversationTurn`). So a re-send has
 * everything it needs to carry the images with it, and every path here used to send `images: []`
 * instead and tell the reader to drag the files in again — for a message the control plane was
 * still holding whole.
 *
 * Asserted on the request, not on a callback: what settles this is the body that reaches
 * `POST /sessions/:id/turns/current-work-routing`, because that is what the server stores against
 * the new turn. A test that watched a mutation being called would stay green if the ids were
 * dropped one layer further down.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // Both call the module-local `api`, so replacing the exported one alone would not reach them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listApprovals: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0199aa00-0000-7000-8000-000000000001';
const WORKSPACE_PUBLIC = encodeId('0199aa00-0000-7000-8000-000000000002');
const SESSION_UUID = '0199aa00-0000-7000-8000-000000000003';
const SESSION_PUBLIC = encodeId(SESSION_UUID);

/** The two PNGs of the incident, by the ids the attachment rows carry. */
const PNG_A = '0199aa00-0000-7000-8000-00000000a001';
const PNG_B = '0199aa00-0000-7000-8000-00000000a002';

const ASKED = '看看这两张图，哪个对？';
const AUTH_FAILED =
  'Failed to authenticate: Claude is installed on this runner but not signed in — sign in from '
  + 'here, or run `claude login` on that machine.';

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: null,
  title: 'the turn that was swallowed',
  status: 'RUNNING',
  runStatus: 'RUNNING',
  runState: 'RUNNING',
  engineTurnActive: false,
  provider: 'claude',
  numTurns: 1,
  createdAt: '2026-09-17T18:00:00Z',
  updatedAt: '2026-09-17T18:00:16Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

/** Every `POST …/turns/current-work-routing` body the page sent, in order. */
type SentTurn = { content: string; attachmentIds?: string[]; kind?: string };
let sent: SentTurn[] = [];
/** Paths the page asked for that nothing here answers — a silent `[]` is how a mount test goes red
 *  somewhere far from what it is about. */
let unstubbed: string[] = [];
/** Every request the page made, as `METHOD path`, in order. */
let requested: string[] = [];
/** What the active-turn snapshot answers with — the pending tail is drawn from it. */
let activeTurns: unknown[] = [];
/** What the server files the next send as. `accepted` unless a case queues it. */
let placement: 'accepted' | 'queued' = 'accepted';
/** What the transcript is seeded with. */
let events: { seq: number; type: string; payload: unknown; turnId?: string; ts?: string }[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

/** What the stubbed control plane answers, for both ways a request can leave the page. */
function answer(path: string, method: string, body: unknown): unknown {
  requested.push(`${method} ${path}`);
  if (path === `/sessions/${SESSION_PUBLIC}/turns/current-work-routing`) {
    sent.push(body as SentTurn);
    return { turnId: `turn-${sent.length}`, seq: sent.length, kind: 'message', placement };
  }
  if (path.startsWith(`/sessions/${SESSION_PUBLIC}/turns/`) && method === 'DELETE') return {};
  // An interrupt drops everything queued behind the turn it stops — on the server, which is why
  // the snapshot the pending tail is drawn from comes back empty afterwards.
  if (path === `/sessions/${SESSION_PUBLIC}/interrupt`) {
    activeTurns = [];
    return { ok: true };
  }
  if (path === '/users/me') {
    return { id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} };
  }
  if (path === '/workspaces') {
    return [{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }];
  }
  if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
    if (path.includes('/turns')) return activeTurns;
    if (path.includes('/approvals')) return [];
    if (path.includes('/background')) return [];
    if (path.includes('/diff')) return { files: [] };
    return SESSION;
  }
  if (path.startsWith('/sessions')) return [SESSION];
  if (path.startsWith('/tasks/evidence-decisions/pending')) {
    return { decidingSessionId: SESSION_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] };
  }
  if (path.startsWith('/tasks/page')) return { items: [], nextCursor: null };
  if (path.startsWith('/tasks')) return { items: [], total: 0, counts: {} };
  unstubbed.push(path);
  return [];
}

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  }, 30_000);
};

/** A few macrotask turns, so what a click set in motion has been drawn and flushed. */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/** The one element matching `selector`, or a failure naming what was not drawn. */
function one(selector: string): HTMLElement {
  const found = mounted().querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`nothing matched ${selector}`);
  return found;
}

/** The way back into the composer under an undelivered message — an anchor with no class of its
 *  own, so it is found by the words the reader clicks. */
function putBack(): HTMLElement | null {
  return action('Put back in the composer');
}

/** One of the pending tail's actions, by the words on it — they are anchors with no class. */
function action(label: string): HTMLElement | null {
  return [...mounted().querySelectorAll<HTMLElement>('.chat-queued-meta a')]
    .find((a) => a.textContent === label) ?? null;
}

const composerText = (): string | undefined =>
  mounted().querySelector<HTMLTextAreaElement>('.workspace-composer textarea')?.value;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  }, 30_000);
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  unstubbed = [];
  requested = [];
  placement = 'accepted';
  activeTurns = [];
  events = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events, hasMore: false }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation(((path: string, init?: { method?: string; body?: unknown }) =>
    Promise.resolve(answer(path, init?.method ?? 'GET', init?.body))) as unknown as typeof api);
  // `sendTurn` and `listQueuedTurns` call api.ts's module-local `api`, which the module mock above
  // cannot reach — so the one thing this file is about would never have left the page. They go out
  // over `fetch`, and are answered by the same table, which is also what makes the assertion here
  // the request body itself rather than the arguments of a function that builds one.
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const path = String(url).replace(/^.*\/api/u, '');
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    const value = answer(path, init?.method ?? 'GET', body);
    return { ok: true, status: 200, text: async () => JSON.stringify(value ?? null), json: async () => value } as Response;
  });
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
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(): Promise<void> {
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
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }, 30_000);
  await settle();
}

describe('the card that offers to re-send the last message', () => {
  it('re-sends it with the attachments it was sent with, not an empty array', async () => {
    // The message the engine never answered, echoed with the refs the runner carries back.
    events = [
      {
        seq: 1,
        type: 'user',
        turnId: 'turn-swallowed',
        ts: '2026-09-17T18:00:16Z',
        payload: {
          text: ASKED,
          attachments: [
            { id: PNG_A, mime: 'image/png', name: 'before.png' },
            { id: PNG_B, mime: 'image/png', name: 'after.png' },
          ],
        },
      },
      { seq: 2, type: 'error', payload: { message: AUTH_FAILED } },
    ];
    await mount();

    await waitForUi(() => {
      expect(mounted().querySelector('.chat-authfix-retry')).not.toBeNull();
    });
    await click(one('.chat-authfix-retry'));

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe(ASKED);
    expect(sent[0].attachmentIds).toEqual([PNG_A, PNG_B]);
  }, 30_000);

  it('sends no attachmentIds at all for a message that had none', async () => {
    // The absent key is the shape the send path has always had for a turn with nothing attached;
    // carrying the files back must not start sending an empty array where there was no key.
    events = [
      { seq: 1, type: 'user', turnId: 'turn-1', payload: { text: '部署一下' } },
      { seq: 2, type: 'error', payload: { message: AUTH_FAILED } },
    ];
    await mount();

    await waitForUi(() => {
      expect(mounted().querySelector('.chat-authfix-retry')).not.toBeNull();
    });
    await click(one('.chat-authfix-retry'));

    expect(sent).toHaveLength(1);
    expect(sent[0].attachmentIds).toBeUndefined();
  }, 30_000);
});

describe('taking an undelivered message back into the composer', () => {
  /** A message that settled undelivered, with both PNGs still referenced by its row. */
  const undelivered = {
    turnId: 'turn-undelivered',
    kind: 'steer',
    placement: 'steer',
    content: ASKED,
    createdAt: '2026-09-17T18:00:16Z',
    delivery: 'failed',
    deliveryCode: 'CURRENT_WORK_TARGET_COMPLETED',
    deliveryReason: 'The target turn completed before the engine acknowledged this message.',
    attachments: [
      { id: PNG_A, mimeType: 'image/png' },
      { id: PNG_B, mimeType: 'image/png' },
    ],
  };

  /** A live conversation with something in it, and the undelivered message waiting under it. */
  async function openWithUndelivered(): Promise<void> {
    events = [{ seq: 1, type: 'assistant', turnId: 'turn-0', payload: { text: '在看了' } }];
    activeTurns = [undelivered];
    await mount();
  }

  it('brings the attachments back with the text, as chips the reader can see', async () => {
    await openWithUndelivered();

    await waitForUi(() => {
      expect(putBack()).not.toBeNull();
    });
    await click(putBack()!);

    // The text is back in the composer…
    await waitForUi(() => {
      expect(composerText()).toBe(ASKED);
    });
    // …and so are its two files, drawn as staged attachments rather than described in a toast.
    expect(mounted().querySelectorAll('.composer-attachments .composer-pill')).toHaveLength(2);
  }, 30_000);

  it('sends them again without the reader finding the files a second time', async () => {
    await openWithUndelivered();

    await waitForUi(() => {
      expect(putBack()).not.toBeNull();
    });
    await click(putBack()!);
    await waitForUi(() => {
      expect(composerText()).toBe(ASKED);
    });
    await click(one('button[aria-label="Send"], button[aria-label="Add to current work"]'));

    await waitForUi(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0].content).toBe(ASKED);
    expect(sent[0].attachmentIds).toEqual([PNG_A, PNG_B]);
  }, 30_000);

  it('hands back a re-send withdrawn from the queue, files and all', async () => {
    // Cancel is the way back for a message still waiting its turn, and the row it acts on is the
    // client's own until the server's active-turn snapshot comes round. Withdrawing in that window
    // used to restore the words alone: the local row knew nothing about the files, only the
    // snapshot did.
    events = [
      {
        seq: 1,
        type: 'user',
        turnId: 'turn-swallowed',
        payload: {
          text: ASKED,
          attachments: [{ id: PNG_A, mime: 'image/png' }, { id: PNG_B, mime: 'image/png' }],
        },
      },
      { seq: 2, type: 'error', payload: { message: AUTH_FAILED } },
    ];
    placement = 'queued';
    await mount();

    await waitForUi(() => {
      expect(mounted().querySelector('.chat-authfix-retry')).not.toBeNull();
    });
    await click(one('.chat-authfix-retry'));
    await waitForUi(() => {
      expect(sent).toHaveLength(1);
    });

    // Its queued row offers Cancel, and withdrawing brings both files back with the words.
    await waitForUi(() => {
      expect(action('Cancel')).not.toBeNull();
    });
    await click(action('Cancel')!);

    await waitForUi(() => {
      expect(composerText()).toBe(ASKED);
    });
    expect(mounted().querySelectorAll('.composer-attachments .composer-pill')).toHaveLength(2);
  }, 30_000);

  it('says nothing about files it failed to restore, because it no longer fails to', async () => {
    await openWithUndelivered();

    await waitForUi(() => {
      expect(putBack()).not.toBeNull();
    });
    await click(putBack()!);

    expect(document.body.textContent).not.toContain("weren't restored");
    expect(document.body.textContent).not.toContain('re-add if needed');
  }, 30_000);
});

describe('stopping the turn folds the queue back', () => {
  /** A message still waiting its turn, with its two files already on the control plane. */
  const queuedTurn = {
    turnId: 'turn-queued',
    kind: 'message',
    placement: 'queued',
    content: ASKED,
    createdAt: '2026-09-17T18:00:16Z',
    attachments: [
      { id: PNG_A, mimeType: 'image/png' },
      { id: PNG_B, mimeType: 'image/png' },
    ],
  };

  it('brings the queued message’s files back with its words', async () => {
    // Stop is offered only with an empty composer, so the fold always lands — and the files it
    // carries come with it, rather than being left behind with a toast telling the reader to go
    // and find two images the queue's own row was still holding by id.
    activeTurns = [queuedTurn];
    await mount();

    await waitForUi(() => {
      expect(action('Cancel')).not.toBeNull();
    });
    await click(one('[aria-label="Stop"]'));

    await waitForUi(() => {
      expect(composerText()).toBe(ASKED);
    });
    expect(mounted().querySelectorAll('.composer-attachments .composer-pill')).toHaveLength(2);
  }, 30_000);
});
