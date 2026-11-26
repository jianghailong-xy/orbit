// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { ToastViewport } from './ToastViewport';
import { clearToasts } from '../lib/toastStore';

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
    { engine: 'codex', installed: true, auth: 'yes' },
    { engine: 'kimi', installed: true, auth: 'no' },
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
const visited: string[] = [];
function Where() {
  pathname = useLocation().pathname;
  if (visited[visited.length - 1] !== pathname) visited.push(pathname);
  return null;
}

describe('Compact and Start a new coordinator', { timeout: 120_000 }, () => {
  let runner: Runner = runnerFor('claude');
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let detail: Record<string, unknown> = session();
  /** What GET …/coordinator/pending-waits answers: by default two waits from a server without `kind`. */
  let pendingWaits: Record<string, unknown>[] = [];

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
            <ToastViewport />
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
  /** The confirm dialog's wait lines, one per wait. */
  const waitLines = (dialog: Element) => [...dialog.querySelectorAll('.handoff-facts li:nth-child(2) .sub')].map((n) => n.textContent);
  const contextActions = async () => {
    await click(mounted().querySelector('.composer-usage'));
    await waitFor(() => expect(document.querySelector('.cu-pop')).not.toBeNull());
    return [...document.querySelectorAll<HTMLButtonElement>('.ctx-act')];
  };
  const titleOf = (row: Element) => row.querySelector('b')?.textContent;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
  const successorPicker = (scope: Element) => scope.querySelector('.handoff-successor [role="combobox"]');
  const pickCodex = async (scope: Element) => {
    await click(successorPicker(scope));
    const options = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    await waitFor(() => expect(options()[0]?.textContent).toBe('Same as this one'));
    expect(options().find((option) => option.textContent?.includes('Not signed in'))?.getAttribute('aria-disabled')).toBe('true');
    const codex = options().find((option) => option.textContent === 'Codex')!;
    await act(async () => {
      codex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    });
    await click(codex);
    expect(successorPicker(scope)?.textContent).toBe('Codex');
  };

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
    pendingWaits = [
      { id: 'w1', label: 'Fix login redirect reaching Done', paused: false },
      { id: 'w2', label: 'Session “Payment retries” finishing its turn', paused: true },
    ];
    apiMock.mockReset();
    apiMock.mockImplementation(((p: string, init?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p.endsWith('/coordinator/pending-waits')) {
        return reply(pendingWaits);
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
      await act(async () => clearToasts());
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
    // Waits without a kind (an older server) read as watches: the label alone, one line each.
    expect(waitLines(dialog)).toEqual(['Fix login redirect reaching Done', 'Session “Payment retries” finishing its turn (paused)']);
    expect(successorPicker(dialog)?.textContent).toBe('Same as this one');
    await click(button('Hand over'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT}/coordinator/handoff`, { method: 'POST', body: {} }),
    );
  });

  it('hands over on the engine and provider picked in the confirm dialog', async () => {
    detail = session({ projectId: PROJECT, projectMembership: coordinator });
    await mount();
    await click((await contextActions())[1]);
    await waitFor(() => expect(document.querySelector('.handoff-confirm')).not.toBeNull());
    await pickCodex(document.querySelector('.handoff-confirm')!);
    await click(button('Hand over'));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT}/coordinator/handoff`, {
      method: 'POST', body: { successor: { engine: 'codex', provider: 'codex' } },
    }));
  });

  it('names each pending wait\'s kind after its label in the confirm dialog, a watch by its label alone', async () => {
    pendingWaits = [
      { id: 'w1', kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
      { id: 'r1', kind: 'SUBAGENT', label: 'Deploy 55a189aa3 to production', paused: false },
      { id: 'sw1', kind: 'WAKEUP', label: 'Check the deploy', paused: false },
      { id: 'bgj_1', kind: 'JOB', label: 'pnpm test', paused: false },
      { id: 'l1', kind: 'LOOP', label: 'Babysit CI', paused: false },
    ];
    detail = session({ projectId: PROJECT, projectMembership: coordinator });
    await mount();
    const rows = await contextActions();
    await click(rows[1]);
    await waitFor(() => expect(document.querySelector('.handoff-confirm')).not.toBeNull());
    const dialog = document.querySelector('.handoff-confirm')!;
    await waitFor(() => expect(dialog.textContent).toContain('5 pending waits move over'));
    expect(waitLines(dialog)).toEqual([
      'Waiting for "Fix login redirect" to be DONE',
      'Deploy 55a189aa3 to production · SubAgent',
      'Check the deploy · Scheduled wakeup',
      'pnpm test · Background job',
      'Babysit CI · Wakeup loop',
    ]);
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

  it('02-2: leaves the queued note turn out of the queued tail and the tray, keeping the turns around it', async () => {
    // Start a new coordinator confirmed while a turn runs: the platform's note turn waits behind it.
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING',
      coordinatorHandoff: { state: 'WRITING', startedAt: new Date().toISOString(), failureCode: null, failureReason: null, handedOverToSessionId: null },
    });
    vi.mocked(listQueuedTurns).mockImplementation(async () => [
      { turnId: 'q-owner', kind: 'prompt', placement: 'queued', content: 'Also check the retries', createdAt: '2026-11-14T01:17:00Z' },
      { turnId: 'q-note', kind: 'prompt', placement: 'queued', authoredByOrbit: true, createdAt: '2026-11-14T01:18:00Z',
        content: 'From Orbit · handoff note\n\nThe owner is handing this project over to a new coordinator conversation.' },
      { turnId: 'q-wake', kind: 'prompt', placement: 'queued', authoredByOrbit: true, content: 'Orbit wake: a job finished', createdAt: '2026-11-14T01:18:30Z' },
    ] as never);
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="WRITING"]')).not.toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain('Also check the retries'));
    expect(document.body.textContent).toContain('Orbit wake: a job finished');
    expect(document.body.textContent).not.toContain('From Orbit · handoff note');
    expect(document.body.textContent).not.toContain('The owner is handing this project over');
    // Nor an empty bubble with the queue's line and a Cancel: of the two Orbit queued, only the wake has a row in the tail.
    const tail = [...mounted().querySelectorAll('.chat-queued-meta')].map((meta) => meta.closest('[class*="chat-"]')?.parentElement?.textContent ?? '');
    expect(tail).toHaveLength(1);
    expect(tail[0]).toContain('Orbit wake: a job finished');
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

  it.each([
    ['WRITING', true],
    ['HANDING_OVER', true],
    ['FAILED', false],
    ['COMPLETED', false],
    [null, false],
  ] as const)('02-2: the header reads "Handing over" only while the handoff is in flight (%s)', async (state, shown) => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: state
        ? { state, startedAt: new Date().toISOString(), failureCode: state === 'FAILED' ? 'TURN_FAILED' : null,
          failureReason: null, handedOverToSessionId: state === 'COMPLETED' ? SUCCESSOR : null }
        : null,
    });
    await mount();
    // A wide header has no status line (docs/mocks/session-header-compact): the word rides beside the title.
    const line = () => mounted().querySelector('.workspace-title-line');
    await waitFor(() => expect(line()?.querySelector('.workspace-name-text')).not.toBeNull());
    const badges = () => [...line()!.querySelectorAll('.coordinator-badge')].map((n) => n.textContent);
    if (shown) {
      expect(badges()).toContain('Handing over');
    } else {
      expect(badges()).not.toContain('Handing over');
    }
  });

  it('links the header to the project through the Coordinator badge, with no second line repeating the title', async () => {
    // docs/mocks/session-header-project-link (C): a coordinator session is named after its project.
    detail = session({ projectId: PROJECT, projectTitle: 'Checkout redesign', projectMembership: coordinator });
    await mount();
    const line = () => mounted().querySelector('.workspace-title-line');
    await waitFor(() => expect(line()?.querySelector('.workspace-name-text')).not.toBeNull());
    expect(mounted().querySelector('.workspace-header-main > .workspace-header-task')).toBeNull();
    const badge = line()!.querySelector<HTMLButtonElement>('button.coordinator-badge-link');
    expect(badge?.textContent).toBe('Coordinator');
    expect(badge?.getAttribute('title')).toBe('Open project · Checkout redesign');
    expect(badge?.getAttribute('aria-label')).toBe('Coordinator · Open project Checkout redesign');
    await act(async () => badge!.click());
    // The test's one catch-all route keeps WorkspaceView mounted on /projects/…, which may route on from there.
    await waitFor(() => expect(visited).toContain(`/projects/${PROJECT}`));
  });

  it('02-3: opens the successor with the note card and the waits that moved here', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoffReceived: {
        handoffFromSessionId: PREVIOUS,
        note: 'Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\nRulings not yet recorded\n- Don’t merge Payment retries before Friday’s release.\nWaiting on\n- Evidence for Fix login redirect.\nNext\n- Ask for the merge once that evidence is in.',
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
    expect([...card.querySelectorAll('h5')].map((h) => h.textContent)).toEqual(['Where things stand', 'Rulings not yet recorded', 'Waiting on', 'Next']);
    expect(card.querySelector('li')?.textContent).toBe('4 of 6 tasks done; Fix login redirect in review.');
    expect(mounted().querySelector('.handoff-chip')?.textContent).toBe('2 waits moved here');
    // Moved waits without a kind (recorded before kinds) read as before: the label alone.
    await click(mounted().querySelector('.handoff-chip'));
    await waitFor(() => expect(document.querySelector('.handoff-chip-list')).not.toBeNull());
    expect([...document.querySelectorAll('.handoff-chip-list li')].map((li) => li.textContent)).toEqual([
      'Fix login redirect reaching Done',
      'Session “Payment retries” finishing its turn',
    ]);
    await click(card.querySelector('.handoff-card-h a'));
    await waitFor(() => expect(pathname).toBe(`/sessions/${PREVIOUS}`));
  });

  it('02-3: names each moved wait\'s kind after its label in the successor\'s moved-here list', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoffReceived: {
        handoffFromSessionId: PREVIOUS,
        note: null,
        handedOverAt: '2026-11-14T07:42:00Z',
        movedWaits: [
          { id: 'w1', kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: true },
          { id: 'r1', kind: 'SUBAGENT', label: 'Deploy 55a189aa3 to production', paused: false },
          { id: 'sw1', kind: 'WAKEUP', label: 'Check the deploy', paused: false },
        ],
      },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('.handoff-chip')).not.toBeNull());
    expect(mounted().querySelector('.handoff-chip')?.textContent).toBe('3 waits moved here');
    await click(mounted().querySelector('.handoff-chip'));
    await waitFor(() => expect(document.querySelector('.handoff-chip-list')).not.toBeNull());
    expect([...document.querySelectorAll('.handoff-chip-list li')].map((li) => li.textContent)).toEqual([
      'Waiting for "Fix login redirect" to be DONE (paused)',
      'Deploy 55a189aa3 to production · SubAgent',
      'Check the deploy · Scheduled wakeup',
    ]);
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
    expect([...row.querySelectorAll('button:not([role="combobox"])')].map((b) => b.textContent)).toEqual(['Try again', 'Hand over without a note', 'Keep this coordinator']);
    await click(button('Keep this coordinator'));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p]) => p === `/projects/${PROJECT}/coordinator/handoff/cancel`)).toBe(true),
    );
  });

  it.each([['Hand over without a note', 'skip'], ['Try again', 'retry']])('preselects the stored successor and sends a new pick with %s', async (action, endpoint) => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TURN_FAILED',
        successor: { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5' } },
    });
    await mount();
    const failure = () => mounted().querySelector('[data-handoff-state="FAILED"]')!;
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(successorPicker(failure())?.textContent).toBe('Claude Code · claude-opus-5-5');
    await pickCodex(failure());
    await click(button(action));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT}/coordinator/handoff/${endpoint}`, {
      method: 'POST', body: { successor: { engine: 'codex', provider: 'codex' } },
    }));
  });

  it('"Same as this one" after a stored pick sends successor: null, which clears it', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TURN_FAILED',
        successor: { engine: 'codex', provider: 'codex' } },
    });
    await mount();
    const failure = () => mounted().querySelector('[data-handoff-state="FAILED"]')!;
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(successorPicker(failure())?.textContent).toBe('Codex');
    await click(successorPicker(failure()));
    const options = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    await waitFor(() => expect(options()[0]?.textContent).toBe('Same as this one'));
    const same = options()[0];
    await act(async () => {
      same.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    });
    await click(same);
    expect(successorPicker(failure())?.textContent).toBe('Same as this one');
    await click(button('Hand over without a note'));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/projects/${PROJECT}/coordinator/handoff/skip`, {
      method: 'POST', body: { successor: null },
    }));
  });

  it('02-5: does not offer Start a new coordinator while a handoff has failed: the row has its own doors', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TURN_FAILED',
        failureReason: "The handoff note wasn't written: the turn failed.", handedOverToSessionId: null },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="FAILED"]')).not.toBeNull());
    expect((await contextActions()).map(titleOf)).toEqual(['Compact']);
  });

  it('02-5: falls back to the shared failure sentence when the handoff carries no failureReason', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TIMED_OUT',
        failureReason: null, handedOverToSessionId: null },
    });
    await mount();
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="FAILED"]')).not.toBeNull());
    const row = mounted().querySelector('[data-handoff-state="FAILED"]')!;
    expect(row.textContent).toMatch(/^The handoff note wasn't written: the turn timed out\./);
  });

  it('reads "the project" in the confirm when the project has no title', async () => {
    detail = session({ projectId: PROJECT, projectMembership: { ...coordinator, projectTitle: null } });
    await mount();
    const rows = await contextActions();
    await click(rows.find((r) => titleOf(r) === 'Start a new coordinator'));
    await waitFor(() => expect(document.querySelector('.handoff-confirm-body')).not.toBeNull());
    expect(document.querySelector('.handoff-confirm-body')?.textContent).toBe(
      'This coordinator writes a handoff note, then the project continues in a new conversation that starts from that note. This one is completed — nothing is deleted.',
    );
  });

  it('says "Couldn\'t hand over" and the server\'s reason when the confirm\'s press is refused', async () => {
    detail = session({ projectId: PROJECT, projectMembership: coordinator });
    await mount();
    const post = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(((p: string, init?: { method?: string }) =>
      p.includes('/coordinator/handoff') && init?.method === 'POST'
        ? Promise.reject(new Error('This project already has a handoff under way.'))
        : post(p, init as never)) as never);
    const rows = await contextActions();
    await click(rows.find((r) => titleOf(r) === 'Start a new coordinator'));
    await waitFor(() => expect(document.querySelector('.handoff-confirm')).not.toBeNull());
    await click(button('Hand over'));
    await waitFor(() => expect(document.querySelector('.orbit-confirm-error')?.textContent)
      .toBe("Couldn't hand over: This project already has a handoff under way."));
  });

  it('toasts "Couldn\'t hand over" and the server\'s reason when a press on the handoff\'s row is refused', async () => {
    detail = session({
      projectId: PROJECT,
      projectMembership: coordinator,
      coordinatorHandoff: { state: 'FAILED', startedAt: new Date().toISOString(), failureCode: 'TURN_FAILED',
        failureReason: null, handedOverToSessionId: null },
    });
    await mount();
    const post = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(((p: string, init?: { method?: string }) =>
      p.includes('/coordinator/handoff/') ? Promise.reject(new Error('The handoff already ended.')) : post(p, init as never)) as never);
    await waitFor(() => expect(mounted().querySelector('[data-handoff-state="FAILED"]')).not.toBeNull());
    await click(button('Keep this coordinator'));
    await waitFor(() => expect(document.body.querySelector('.toast-viewport .toast-head')?.textContent).toBe("Couldn't hand over"));
    expect(document.body.querySelector('.toast-viewport .toast-detail, .toast-viewport .toast-reason')?.textContent)
      .toBe('The handoff already ended.');
  });
});
