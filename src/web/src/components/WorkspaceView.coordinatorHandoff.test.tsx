// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Compact and Start a new coordinator in the Context popover (board 01), and the handoff as the
 * conversation shows it (board 02): Compact where the engine advertises `compact` — not on Cursor —
 * and waiting while a turn runs; Start a new coordinator only in a project's current, open
 * coordinator, through the confirm dialog; and the rows for writing, failing, handing over, and the
 * successor's opening.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    getSession: vi.fn(),
    sendTurn: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, sendTurn } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000e1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000e2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000e3');
const SUCCESSOR = encodeId('0195c0de-0000-7000-8000-0000000000e4');
const PREVIOUS = encodeId('0195c0de-0000-7000-8000-0000000000e5');
const PROJECT = '34whUBBDhBJyNfSdEmheD';

const runnerFor = (engine: 'claude' | 'cursor'): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  maxConcurrent: 4,
  activeSessions: 0,
  capabilities: ['provider:cursor'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'cursor', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/h', auth: 'yes' }] },
  ],
  // Claude Code registers `compact` itself; Cursor CLI reports no such command.
  commands: [
    { name: 'compact', type: 'command', provider: 'claude', builtin: true },
    ...(engine === 'cursor' ? [{ name: 'review', type: 'command', provider: 'cursor' }] : []),
  ],
  modelCatalog: {
    claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }],
    cursor: [{ value: 'default', label: 'Auto' }],
  },
} as unknown as Runner);

const coordinator = { projectId: PROJECT, projectTitle: 'Checkout redesign', projectStatus: 'ACTIVE', role: 'COORDINATOR' };

const session = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title: 'Checkout redesign',
  status: 'AWAITING_INPUT',
  engine: 'claude',
  provider: 'claude',
  model: 'claude-opus-5-5',
  permissionMode: 'acceptEdits',
  workspace: { id: WORKSPACE },
  numTurns: 3,
  runtimeSessionId: '7f3b0c1e-2d4a-4e5f-9a8b-0c1d2e3f4a5b',
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-11-14T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-11-14T01:10:00Z',
  updatedAt: '2026-11-14T01:18:00Z',
  ...over,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let pathname = '';
function Where() {
  pathname = useLocation().pathname;
  return null;
}

describe('Compact and Start a new coordinator', { timeout: 120_000 }, () => {
  let runner: Runner = runnerFor('claude');
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let detail: Record<string, unknown> = session();

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const waitFor = async (check: () => void) => {
    await act(async () => {
      await vi.waitFor(check, { timeout: 20_000, interval: 20 });
    });
  };
  const mount = async (model: RegExp = /Opus 5.5|Auto/) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const nextClient = client;
    const nextRoot = root;
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${SESSION}`]}>
            <Where />
            <Routes>
              <Route path="*" element={<WorkspaceView runner={runner} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(vi.mocked(getSession)).toHaveBeenCalled());
    // The detail row — its engine, its handoff — lands a beat later: the model chip, or the banner in its place.
    await waitFor(() =>
      expect(!!mounted().querySelector('.handoff-ended') || model.test(mounted().querySelector('.composer-model-name')?.textContent ?? '')).toBe(true),
    );
  };
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  /** Opens the Context popover and returns its action rows by title. */
  const contextActions = async () => {
    await click(mounted().querySelector('.composer-usage'));
    await waitFor(() => expect(document.querySelector('.cu-pop')).not.toBeNull());
    return [...document.querySelectorAll<HTMLButtonElement>('.ctx-act')];
  };
  const titleOf = (row: Element) => row.querySelector('b')?.textContent;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runner = runnerFor('claude');
    detail = session();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(sendTurn).mockReset();
    vi.mocked(sendTurn).mockResolvedValue({ turnId: 'turn-compact', placement: 'NEXT_TURN', delivery: 'QUEUED' } as never);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => detail as never);
    apiMock.mockReset();
    apiMock.mockImplementation(((p: string, init?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p.endsWith('/coordinator/pending-waits')) {
        return reply([
          { id: 'w1', label: 'Fix login redirect reaching Done', paused: false },
          { id: 'w2', label: 'Session “Payment retries” finishing its turn', paused: true },
        ]);
      }
      if (p.includes('/coordinator/handoff') && init?.method === 'POST') {
        return reply({ projectId: PROJECT, sessionId: SESSION, state: 'WRITING', startedAt: new Date().toISOString(),
          failureCode: null, failureReason: null, handedOverToSessionId: null, movedWaits: [] });
      }
      if (p.endsWith('/criteria-decisions/pending')) return reply({ pending: [] });
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z' }]);
      }
      if (p.startsWith('/sessions/')) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        return reply(detail);
      }
      if (p.startsWith('/sessions')) return reply([detail]);
      if (p.includes('/owner-confirmation')) return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    }) as never);
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

  it('offers Compact alone in an ordinary Claude Code session, and sends /compact through the send path', async () => {
    await mount();
    const rows = await contextActions();
    expect(rows.map(titleOf)).toEqual(['Compact']);
    expect(rows[0].textContent).toContain('Summarize earlier turns and keep going here.');
    expect(rows[0].disabled).toBe(false);
    await click(rows[0]);
    await waitFor(() => expect(vi.mocked(sendTurn)).toHaveBeenCalled());
    const [sessionId, content] = vi.mocked(sendTurn).mock.calls[0];
    expect(sessionId).toBe(SESSION);
    expect(content).toBe('/compact');
  });

  it('shows no action area on Cursor CLI, whose engine does not advertise compact', async () => {
    runner = runnerFor('cursor');
    detail = session({ engine: 'cursor', provider: 'cursor', model: 'default' });
    await mount(/Auto/);
    await contextActions();
    expect(document.querySelector('.ctx-acts')).toBeNull();
  });

  it('disables Compact while a turn runs, and says why', async () => {
    detail = session({ status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING' });
    await mount();
    const rows = await contextActions();
    const compact = rows.find((r) => titleOf(r) === 'Compact')!;
    expect(compact.disabled).toBe(true);
    expect(compact.textContent).toContain('Available when this turn ends.');
  });

  it('offers Start a new coordinator in the current coordinator, and hands over through the confirm dialog', async () => {
    detail = session({ projectId: PROJECT, projectMembership: coordinator });
    await mount();
    const rows = await contextActions();
    expect(rows.map(titleOf)).toEqual(['Compact', 'Start a new coordinator']);
    expect(rows[1].textContent).toContain('This one writes a handoff note, then the project continues in a fresh conversation.');
    await click(rows[1]);
    await waitFor(() => expect(document.querySelector('.handoff-confirm')).not.toBeNull());
    const dialog = document.querySelector('.handoff-confirm')!;
    expect(dialog.textContent).toContain('Hand over to a new coordinator?');
    expect(dialog.querySelector('.handoff-confirm-body')?.textContent).toBe(
      'This coordinator writes a handoff note, then Checkout redesign continues in a new conversation that starts from that note. This one is completed — nothing is deleted.',
    );
    await waitFor(() => expect(dialog.textContent).toContain('2 pending waits move over'));
    expect(dialog.textContent).toContain('Fix login redirect reaching Done · Session “Payment retries” finishing its turn (paused)');
    await click(button('Hand over'));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p, init]) => p === `/projects/${PROJECT}/coordinator/handoff` && (init as { method?: string })?.method === 'POST')).toBe(true),
    );
  });

  it('words the confirm for a running turn as running after it', async () => {
    detail = session({ projectId: PROJECT, projectMembership: coordinator, status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING' });
    await mount();
    const rows = await contextActions();
    const start = rows.find((r) => titleOf(r) === 'Start a new coordinator')!;
    expect(start.disabled).toBe(false);
    expect(start.textContent).toContain('Begins after this turn ends: a handoff note, then a fresh conversation.');
    await click(start);
    await waitFor(() => expect(document.querySelector('.handoff-confirm-body')?.textContent).toMatch(/^After the current turn ends, this coordinator writes/));
  });

  it('does not offer Start a new coordinator in a completed coordinator or an earlier one', async () => {
    detail = session({ projectId: PROJECT, projectMembership: coordinator, lifecycleState: 'COMPLETED', completedAt: '2026-11-14T02:00:00Z' });
    await mount();
    expect((await contextActions()).map(titleOf)).not.toContain('Start a new coordinator');
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    detail = session({ projectId: PROJECT, projectMembership: null });
    await mount();
    expect((await contextActions()).map(titleOf)).toEqual(['Compact']);
  });

  it('02-2: shows the note being written with its clock, Skip the note and Cancel handover, and disables the composer', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'WRITING', startedAt: new Date(Date.now() - 24_000).toISOString(), failureCode: null, failureReason: null, handedOverToSessionId: null },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="WRITING"]')).not.toBeNull());
    const row = mounted().querySelector('[data-handoff-state="WRITING"]')!;
    expect(row.textContent).toMatch(/^Writing the handoff note0:2\d/);
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Skip the note', 'Cancel handover']);
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('Handing over to a new coordinator…');
    await click(button('Skip the note'));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p]) => p === `/projects/${PROJECT}/coordinator/handoff/skip`)).toBe(true),
    );
  });

  it('02-2: says it is handing over once the note is in', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'HANDING_OVER', startedAt: new Date().toISOString(), failureCode: null, failureReason: null, handedOverToSessionId: null },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="HANDING_OVER"]')?.textContent).toBe('Handing over to a new coordinator…'));
  });

  it('02-3: opens the successor with the note card and the waits that moved here', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoffReceived: {
        handoffFromSessionId: PREVIOUS,
        note: 'Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\nAgreed with the owner\n- Don’t merge Payment retries before Friday’s release.\nWaiting on\n- Evidence for Fix login redirect.\nNext\n- Ask for the merge once that evidence is in.',
        handedOverAt: '2026-11-14T07:42:00Z',
        movedWaits: [
          { id: 'w1', label: 'Fix login redirect reaching Done', paused: false },
          { id: 'w2', label: 'Session “Payment retries” finishing its turn', paused: false },
        ],
      },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('.handoff-card')).not.toBeNull());
    const card = mounted().querySelector('.handoff-card')!;
    expect(card.querySelector('.handoff-card-h')?.textContent).toMatch(/^Handoff from the previous coordinator · /);
    expect([...card.querySelectorAll('h5')].map((h) => h.textContent)).toEqual(['Where things stand', 'Agreed with the owner', 'Waiting on', 'Next']);
    expect(card.querySelector('li')?.textContent).toBe('4 of 6 tasks done; Fix login redirect in review.');
    expect(mounted().querySelector('.handoff-chip')?.textContent).toBe('2 waits moved here');
    await click(card.querySelector('.handoff-card-h a'));
    await waitFor(() => expect(pathname).toBe(`/sessions/${PREVIOUS}`));
  });

  it('02-4: puts the handed-over banner with Open it in place of the composer', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: null,
      lifecycleState: 'COMPLETED',
      completedAt: '2026-11-14T02:00:00Z',
      coordinatorHandoff: { state: 'COMPLETED', startedAt: new Date().toISOString(), failureCode: null, failureReason: null, handedOverToSessionId: SUCCESSOR },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('.handoff-ended')).not.toBeNull());
    expect(mounted().querySelector('.handoff-ended')?.textContent).toBe('Handed over to a new coordinator.Open it');
    expect(mounted().querySelector('.composer-box textarea')).toBeNull();
    await click(button('Open it'));
    await waitFor(() => expect(pathname).toBe(`/sessions/${SUCCESSOR}`));
  });

  it('02-5: says why the note was not written, with Try again, Hand over without a note and Keep this coordinator', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TURN_FAILED',
        failureReason: "The handoff note wasn't written: the turn failed.", handedOverToSessionId: null },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="FAILED"]')).not.toBeNull());
    const row = mounted().querySelector('[data-handoff-state="FAILED"]')!;
    expect(row.textContent).toMatch(/^The handoff note wasn't written: the turn failed\./);
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again', 'Hand over without a note', 'Keep this coordinator']);
    await click(button('Keep this coordinator'));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p]) => p === `/projects/${PROJECT}/coordinator/handoff/cancel`)).toBe(true),
    );
  });
});
