// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import {
  OWNER_REQUEST_CHAT_PLACEHOLDER,
  OWNER_REQUEST_CHAT_PREFIX,
  ownerRequestChatContext,
  type OwnerRequest,
} from '../lib/ownerRequests';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * "Chat about this" on a request the session filed for the owner, in the real WorkspaceView: the
 * press arms this session's composer, the send is an ordinary turn with the request named in front
 * of the typed words, and nothing is resolved — no request door is pressed and the card stays.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
    sendTurn: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals, sendTurn } = await import('../api');
const apiMock = vi.mocked(api);
const sendTurnMock = vi.mocked(sendTurn);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000071';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000072');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000073');
const REQUEST_ID = encodeId('0195c0de-0000-7000-8000-000000000074');

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'android release',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-11T03:00:00Z',
  updatedAt: '2026-09-11T03:10:00Z',
};

const REQUEST: OwnerRequest = {
  id: REQUEST_ID,
  kind: 'MANUAL_STEP',
  state: 'PENDING',
  title: 'Register the package name io.orbitd.android',
  why: 'Play Protect blocks an unverified developer’s app.',
  blocksTaskIds: [],
  ifUnanswered: null,
  options: null,
  recommendedOption: null,
  steps: [{ text: 'Sign in to the Android Developer Console' }],
  secretSpec: null,
  secretGrant: null,
  verifyHint: null,
  expiresAt: null,
  askedBySessionId: SESSION_PUBLIC,
  projectId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  resolvedBySessionId: null,
  resolutionNote: null,
  answer: null,
  createdAt: '2026-09-11T03:10:30Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

const requested: string[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => container!;

const waitForUi = async (assertion: () => void): Promise<void> => {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requested.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({
    events: [{ seq: 1, type: 'assistant', payload: { text: 'I sent you a card' }, turnId: 'turn-1', ts: '2026-09-11T03:10:00Z' }],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  sendTurnMock.mockReset();
  sendTurnMock.mockImplementation(async () => ({ turnId: 'turn-sent', seq: 2, kind: 'message', placement: 'accepted' }));
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.startsWith('/owner-requests?')) return reply({ requests: [REQUEST] });
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
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
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(path: string): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  const [c, r] = [client, root];
  await act(async () => {
    r.render(
      <QueryClientProvider client={c}>
        <MemoryRouter initialEntries={[path]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const armedBar = (): string | null => mounted().querySelector('.composer-replyto-text')?.textContent ?? null;

describe('Chat about this on an owner request', { timeout: 60_000 }, () => {
  it('arms this composer with the request, and sends an ordinary turn naming it — through no request door', async () => {
    await mount(`/sessions/${SESSION_PUBLIC}`);
    const card = (): Element | null => mounted().querySelector(`#owner-request-${REQUEST_ID}`);
    await waitForUi(() => {
      expect(card(), 'the request card is not drawn').not.toBeNull();
    });
    const press = [...card()!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === OWNER_SEND_BACK_ACTION);
    expect(press, 'no Chat about this on the card').toBeDefined();

    await act(async () => press!.click());
    await waitForUi(() => {
      expect(armedBar()).toBe(`${OWNER_REQUEST_CHAT_PREFIX}${REQUEST.title}`);
    });
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
    expect(box.getAttribute('placeholder')).toBe(OWNER_REQUEST_CHAT_PLACEHOLDER);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'where is Add app?');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    box.focus();
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitForUi(() => {
      expect(sendTurnMock).toHaveBeenCalledTimes(1);
    });
    const [sessionId, content] = sendTurnMock.mock.calls[0]!;
    expect(sessionId).toBe(SESSION_PUBLIC);
    expect(content).toBe(`${ownerRequestChatContext(REQUEST)}\n\nwhere is Add app?`);
    expect(requested.filter((r) => r.startsWith('POST /owner-requests')), 'the chat resolved the request').toEqual([]);
    expect(armedBar(), 'the bar stayed armed after the send').toBeNull();
    expect(card(), 'the card went with the chat').not.toBeNull();
  });
});
