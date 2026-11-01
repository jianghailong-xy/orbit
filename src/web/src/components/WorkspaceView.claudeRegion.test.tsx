// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { claudeRegionRefusedError } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A session the control plane holds for the Claude region, drawn through the session page itself
 * (docs/claude-region-check-contract.md §9–§11, board 02 B and C): the card under the held message
 * with its three ways out, 'Anthropic unavailable on HPC' in the list and the header with no working
 * clock over a message nothing is working on, and the composer's Provider menu — which the card's Use
 * another provider opens — saying Region not supported on Anthropic's credentials, with no fix.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    getSessionMoveTargets: vi.fn(),
    listQueuedTurns: vi.fn(),
    resumeSession: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionMoveTargets, getSessionRetryMessage, listQueuedTurns } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView, sessionLine, statusLabel } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000b1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');
const REFUSAL = claudeRegionRefusedError('HPC', 'mainland China');

const BLOCKED = {
  verdict: 'blocked' as const,
  country: 'CN',
  regionCode: null,
  name: 'mainland China',
  viaProxy: false,
  checkedAt: new Date(Date.now() - 120_000).toISOString(),
};

const RUNNER = {
  id: RUNNER_ID,
  name: 'HPC',
  displayName: 'HPC',
  online: true,
  maxConcurrent: 16,
  activeSessions: 0,
  engines: [
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', name: 'Personal', home: '/root/.claude', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-accounts/1', auth: 'yes' },
      ],
    },
    { engine: 'codex', installed: true, auth: 'yes' },
  ],
  region: BLOCKED,
} satisfies Runner;

/** The account's keys, as GET /providers serves them (board 02 C's menu). */
const KEYS = [
  { slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', presetSlug: 'deepseek', engines: ['claude', 'opencode', 'dsh'],
    models: [{ value: 'deepseek-v4.1-pro', label: 'DeepSeek V4.1 Pro' }], defaultModel: 'deepseek-v4.1-pro' },
  { slug: 'anthropic', label: 'Personal Max', runtime: 'claude', presetSlug: 'anthropic', engines: ['claude'], models: [] },
  { slug: 'anthropic-2', label: 'Work', runtime: 'claude', presetSlug: 'anthropic', engines: ['claude'], models: [] },
  { slug: 'local-vllm', label: 'Local vLLM', runtime: 'claude', presetSlug: null, engines: ['claude', 'opencode'],
    models: [{ value: 'qwen3.8-27b', label: 'Qwen3.8 27B' }], defaultModel: 'qwen3.8-27b' },
];

/** Board 02 B: an answered turn, then the next message, which the runner refused for the region. */
const T1 = 't-0001';
const T2 = 't-0002';
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'The login test fails about one run in five. Find out why and fix it.' }, turnId: T1, ts: '2026-10-31T11:20:00Z' },
  { seq: 2, type: 'assistant', payload: { text: 'I replaced the sleep with a wait on the cookie itself.' }, turnId: T1, ts: '2026-10-31T11:24:00Z' },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success' }, turnId: T1, ts: '2026-10-31T11:24:00Z' },
  { seq: 4, type: 'user', payload: { text: 'Now do the same for the sign-up test.' }, turnId: T2, ts: '2026-10-31T11:59:00Z' },
  { seq: 5, type: 'error', payload: { message: REFUSAL }, turnId: T2, ts: '2026-10-31T11:59:01Z' },
];

const HELD = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: { id: WORKSPACE_PUBLIC, name: 'orbit-develop' },
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title: 'Fix the flaky login test',
  provider: 'claude',
  engine: 'claude',
  status: 'QUEUED',
  runState: 'QUEUED',
  lifecycleState: 'OPEN',
  numTurns: 1,
  createdAt: '2026-10-31T11:20:00Z',
  updatedAt: '2026-10-31T11:59:01Z',
  startedAt: '2026-10-31T11:20:00Z',
  lastTurnAt: '2026-10-31T11:24:00Z',
  engineStartedAt: '2026-10-31T11:20:02Z',
  error: REFUSAL,
};

describe('the words a held session wears', () => {
  it('reads Anthropic unavailable on its machine in the list and the header', () => {
    expect(sessionLine(HELD, true, null, true, 'HPC')).toEqual({ text: 'Anthropic unavailable on HPC', tone: 'queued' });
    expect(statusLabel(HELD, null, 'HPC')).toBe('Anthropic unavailable on HPC');
  });

  it('keeps the queue’s own words for any other queued session, and where the machine is not known', () => {
    const waiting = { ...HELD, error: null };
    expect(sessionLine(waiting, true, null, true, 'HPC')).toEqual(sessionLine(waiting, true));
    expect(statusLabel(waiting, null, 'HPC')).toBe(statusLabel(waiting));
    expect(statusLabel(HELD)).toBe(statusLabel(waiting));
  });
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a session held for the Claude region', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const card = (): HTMLElement | null => mounted().querySelector<HTMLElement>('[data-run-never-started]');
  const button = (label: string): HTMLButtonElement | null =>
    [...mounted().querySelectorAll<HTMLButtonElement>('.chat-authfix button')].find((b) => (b.textContent ?? '').trim() === label) ?? null;
  const waitFor = (check: () => void) =>
    act(async () => {
      await vi.waitFor(check, { timeout: 20_000, interval: 20 });
    });

  const mount = async (session: typeof HELD = HELD, runner: Runner = RUNNER): Promise<void> => {
    vi.mocked(getSession).mockResolvedValue(session as never);
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
            <WorkspaceView runner={runner} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // The history is on the page, and the card under it.
    await waitFor(() => {
      expect(mounted().textContent).toContain('Now do the same for the sign-up test.');
      expect(card()).not.toBeNull();
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSession).mockReset();
    vi.mocked(getSessionEventPage).mockReset();
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS, hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' });
    vi.mocked(getSessionMoveTargets).mockReset();
    vi.mocked(getSessionMoveTargets).mockResolvedValue({ folders: [], targets: [] } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit-develop', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z',
          lastProvider: 'claude', lastEngine: 'claude', runner: { id: RUNNER_ID, name: 'HPC', displayName: 'HPC' } }]);
      }
      if (path === '/providers') return reply(KEYS);
      if (path.endsWith('/region-check')) return reply({ requestedAt: new Date().toISOString() });
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: EVENTS, hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      }
      // The workspace's list holds the held session.
      if (path.startsWith('/sessions?')) return reply([HELD]);
      if (path.startsWith('/sessions')) return reply([]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    });
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

  it('draws the region card under the held message, with its three ways out', async () => {
    await mount();
    const found = card()!;
    expect(found.getAttribute('data-run-never-started')).toBe('REGION_UNSUPPORTED');
    const text = found.textContent ?? '';
    expect(text).toContain('This run never started');
    expect(text).toContain('Claude Code can’t use Anthropic on HPC');
    expect(text).toContain('HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.');
    expect(text).toContain('Supported regions');
    expect(text).toContain('CLAUDE_REGION_UNSUPPORTED · CN');
    expect(text).toContain('Claude’s connection: mainland China (no proxy)');
    expect(text).toContain('No engine ran · your message is still here');
    expect([...found.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Use another provider',
      'Move to another machine',
      'Check again',
    ]);
    // Under the conversation's last turn, not above its history.
    const html = mounted().innerHTML;
    expect(html.indexOf('data-run-never-started')).toBeGreaterThan(html.indexOf('Now do the same for the sign-up test.'));
  });

  it('says Anthropic unavailable on HPC in the header and the list, with no working clock and no coded line', async () => {
    await mount();
    expect(mounted().querySelector('.workspace-sub')?.textContent).toContain('Anthropic unavailable on HPC');
    await waitFor(() =>
      expect([...mounted().querySelectorAll('.session-sub')].map((n) => n.textContent)).toContain('Anthropic unavailable on HPC'),
    );
    const page = mounted().textContent ?? '';
    expect(page).not.toContain('Waiting for slot');
    expect(page).not.toMatch(/Working for|Working…/);
    // The refusal's own error event draws no red line: the card says it.
    expect(mounted().querySelectorAll('.chat-error')).toHaveLength(0);
    expect(page).not.toContain('CLAUDE_REGION_UNSUPPORTED:');
    // The answered turn keeps its own clock.
    expect(page).toContain('Worked for 4m');
  });

  it('asks the runner to check again', async () => {
    await mount();
    await act(async () => button('Check again')!.click());
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/region-check'))).toBe(true));
    const call = apiMock.mock.calls.find(([path]) => String(path).endsWith('/region-check'))!;
    expect(call[0]).toBe(`/runners/${encodeId(RUNNER_ID)}/region-check`);
    expect(call[1]).toEqual({ method: 'POST' });
  });

  it('opens Move, for a workspace on another machine', async () => {
    await mount();
    await act(async () => button('Move to another machine')!.click());
    await waitFor(() => expect(vi.mocked(getSessionMoveTargets)).toHaveBeenCalledWith(SESSION_PUBLIC));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Move');
  });

  it('opens the composer’s Provider menu, where Anthropic’s credentials read Region not supported with no fix', async () => {
    await mount();
    await act(async () => button('Use another provider')!.click());
    let rows: string[] = [];
    await waitFor(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) => m.textContent?.includes('API keys'));
      expect(menu).toBeTruthy();
      // Each row's words, without its vendor mark (a key with no glyph draws its first letter).
      rows = [...menu!.querySelectorAll('.composer-provider-name')].map((n) => {
        const words = n.cloneNode(true) as HTMLElement;
        words.querySelectorAll('.provider-tile').forEach((mark) => mark.remove());
        return words.textContent ?? '';
      });
      expect(rows.length).toBeGreaterThan(3);
    });
    // The sign-in the session is on stays as it is: the card already says why.
    expect(rows).toEqual([
      'Default',
      'DeepSeek',
      'Personal Max — Region not supported',
      'Work — Region not supported',
      'Local vLLM',
    ]);
    expect(document.body.textContent).not.toContain('fix it →');
  });
});
