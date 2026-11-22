// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import {
  ZH_JOB_AND_SCHEDULED,
  ZH_JOB_DONE,
  ZH_JOB_FAILED,
  ZH_SCHEDULED,
  ZH_TWO_JOBS,
  ZH_WAKE_WITH_COORDINATOR_CONTEXT,
  EN_STALL,
  EN_STALL_SILENT,
  EN_TWO_STALLS,
} from '../lib/backgroundWake.fixtures';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A turn the control plane opened — a background job had the news its agent was waiting for, or a
 * scheduled wakeup came due — is nobody's message: the block IS the turn. It used to draw as an
 * unnamed grey strip (`⊕ Orbit attached: context`) over an empty bubble, and then as a card on the
 * reader's side of the conversation, in the tint of their own messages — which a run of wakes turned
 * into somebody cutting in, splitting one answer into pieces and taking the sticky bar with it.
 *
 * It is one event line in the agent's stream instead: what happened, which job, how it came out and
 * when, with everything else one native disclosure away and a failure's tail left out of the fold.
 * Two things are held here that a line drawn only for what ships today would break: the 73 turns
 * already in the record carry the wording that shipped until 2026-09-15 and are not migrated
 * (fixtures copied verbatim out of this deployment's `run_event` rows), and a note that carries a
 * wake AND something else keeps that something else — as a folded entry under the line, not
 * swallowed by it, and not in a bubble of its own: nobody typed this turn, so a bubble here is an
 * empty one, signed with the reader's name.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    cancelQueuedTurn: vi.fn(),
    interruptSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { ExportCtx, Transcript } = await import('./Transcript');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

// Built the way runner-api/background-job-wake.ts `buildBackgroundWakeBlock` builds it today
// (lib/backgroundWake.test.ts holds the parser to the same words).
const EN_DONE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570',
  '      output tail:',
  '        ==> recreating apiserver',
  '        ==> apiserver is healthy',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

/** A long tail whose complete contents must survive the independent output disclosure. */
const FAILED_TAIL = Array.from({ length: 12 }, (_, i) => `        error line ${i + 1}`);
const EN_FAILED = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_2955bec0e9fc｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169',
  '      ended｜failed｜exit code 1',
  '      output /root/.orbit/runs/4f50733a/bgj_2955bec0e9fc.output｜this covers bytes 0–350697',
  '      output tail:',
  ...FAILED_TAIL,
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

/** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
const wakeEvent = (block: string): RunEvent => ({
  seq: 7,
  type: 'user',
  turnId: 'turn-1',
  ts: '2026-09-15T18:10:00.000Z',
  payload: { text: block, controlPlaneNote: block },
});

describe('a wake turn in the transcript', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(events: RunEvent[]) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>,
      );
    });
  }

  const line = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.bgwake');
    if (!el) throw new Error(`no wake line was rendered:\n${container.innerHTML}`);
    return el;
  };
  const row = (): Element => line().querySelector('summary.bgwake-row')!;
  const fold = (): HTMLDetailsElement => line().querySelector<HTMLDetailsElement>('details.bgwake-fold')!;

  // Board C1 (job-card board, 2026-11-20): a background job's end, new output or stall draws NOTHING where it woke
  // the agent. The job is one card from start to end (JobCard, Transcript.jobCard.test.tsx), and the agent still
  // reads the block unchanged. Old sessions parse their history the same way (F1), so the wording that shipped
  // until 2026-09-15 draws nothing too.
  it.each([
    ['a job that finished', EN_DONE],
    ['a job that failed', EN_FAILED],
    ['the older wording of a finish', ZH_JOB_DONE],
    ['the older wording of a failure', ZH_JOB_FAILED],
    ['an older turn that answered for two jobs', ZH_TWO_JOBS],
    ['a job that went quiet', EN_STALL],
    ['a job that went quiet having written nothing', EN_STALL_SILENT],
    ['two jobs that went quiet', EN_TWO_STALLS],
    ['a wake whose note also carried a coordinator role', ZH_WAKE_WITH_COORDINATOR_CONTEXT],
  ])('draws nothing for %s: no line, no bubble, no entry', async (_name, block) => {
    await mount([wakeEvent(block)]);

    expect(container.querySelector('.bgwake'), 'no wake line').toBeNull();
    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.textContent).not.toContain('bgj_');
  });

  it('draws nothing when the same wake turn also carries the inventory block', async () => {
    const inventory = [
      '<background-jobs>',
      '  Ended while you were away:',
      '    bgj_41314cd48e66｜job｜swift test｜completed｜exit code 0｜output /root/.orbit/runs/x/bgj_41314cd48e66.output',
      '  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.',
      '  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.',
      '</background-jobs>',
    ].join('\n');

    await mount([wakeEvent(`${ZH_JOB_DONE}\n\n${inventory}`)]);

    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.querySelector('.bgwake')).toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
  });

  it('draws an older scheduled wakeup as the wakeup it was', async () => {
    await mount([wakeEvent(ZH_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    expect(row().querySelector('.bgwake-name')?.textContent).toContain('复跑负载闸门');
    expect(row().querySelector('.bgwake-status'), 'nothing has come out of a wakeup').toBeNull();
    expect(row().querySelector('.bgwake-mark')?.classList.contains('is-pending')).toBe(true);
    // The fold says why in full, when it was asked for, and what it left for this turn to read.
    expect(fold().querySelector('.bgwake-wakeup-reason')?.textContent).toContain('复跑负载闸门');
    expect(fold().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 1h out');
    expect(fold().querySelector('.bgwake-wakeup .chat-pre')?.textContent).toContain('兜底检查');
    expect(fold().querySelector('.bgwake-meta')?.textContent).toBe(
      'Queued by a scheduled wakeup, not typed by you',
    );
  });

  it('keeps the wakeup that came due beside a job’s news as its line, and only that', async () => {
    await mount([wakeEvent(ZH_JOB_AND_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(container.querySelectorAll('.bgwake')).toHaveLength(1);
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    expect(row().querySelector('.bgwake-name')?.textContent).toContain('升级作业的备份验证');
    expect(row().querySelector('.bgwake-mark')?.classList.contains('is-pending')).toBe(true);
    expect(fold().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 12m out');
    // No job row: the job's own card says how it ended.
    expect(fold().querySelectorAll('.bgwake-wakeup')).toHaveLength(1);
    expect(fold().querySelector('.bgwake-wakeups')?.textContent).not.toContain('catalog-window fix');
    expect(fold().querySelector('.bgwake-body > .bgwake-jobs, .bgwake-job')).toBeNull();
    expect(fold().querySelector('.bgwake-meta')?.textContent).toBe('Queued by a scheduled wakeup, not typed by you');
    // What the agent read is still the whole note's wake, as it read it.
    expect(fold().querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_JOB_AND_SCHEDULED);
  });

  // Owner rule 2026-11-16: such a turn is the From Orbit line in the agent's stream (OrbitEventLine).
  it('draws a turn nobody typed, carrying only a block this client cannot read, as the From Orbit line — no empty bubble', async () => {
    const unknown = '<orbit-future-block>\n  Something a later server sends.\n</orbit-future-block>';
    await mount([wakeEvent(unknown)]);

    expect(container.querySelector('.chat-user'), 'no empty bubble').toBeNull();
    expect(container.querySelector('.orbitwake .bgwake-title')?.textContent).toBe('From Orbit');
    expect(container.querySelector('.orbitwake .bgwake-name')?.textContent).toBe('context');
  });

  it('keeps a wakeup’s line, and the words behind a native disclosure, in an exported transcript', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[wakeEvent(ZH_SCHEDULED), { ...wakeEvent(EN_DONE), seq: 8 }]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');

    expect(exported.querySelectorAll('.bgwake')).toHaveLength(1);
    expect(exported.querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    // A static file has no JS: both folds have to be ones the browser itself can open.
    expect(exported.querySelector('details.bgwake-fold > summary.bgwake-row')).not.toBeNull();
    expect(exported.querySelector('details.bgwake-fold details.bgwake-raw pre')?.textContent).toBe(ZH_SCHEDULED);
  });
});

// ── the same wake, still waiting behind the running turn ──────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const TYPED = 'and check the dark theme too';

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
  title: 'Coordinator: wake rendering',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-15T18:00:00Z',
  updatedAt: '2026-09-15T18:10:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a wake still waiting in the queued tail', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    const queue: ActiveSessionTurn[] = [
      { turnId: 'turn-wake', kind: 'message', placement: 'queued', content: ZH_SCHEDULED, createdAt: '2026-09-15T18:10:01.000Z' },
      { turnId: 'turn-job', kind: 'message', placement: 'queued', content: EN_DONE, createdAt: '2026-09-15T18:10:02.000Z' },
      { turnId: 'turn-typed', kind: 'message', placement: 'queued', content: TYPED, createdAt: '2026-09-15T18:10:05.000Z' },
    ];
    apiMock.mockReset();
    vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
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

  it('is the same line for a wakeup, drawn as still queued, with the queue’s line under it; a job’s wake draws no row', async () => {
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
            <WorkspaceView runner={RUNNER} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(mounted().querySelector('.bgwake')).not.toBeNull();
          expect(mounted().querySelector('.pending-tray-row')).not.toBeNull();
        },
        { timeout: 20_000, interval: 20 },
      );
    });

    const line = mounted().querySelector<HTMLElement>('.bgwake')!;
    expect(line.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(line.querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    // A job's wake draws no row in the tail (board E1): it waits on the job's card instead.
    expect(mounted().querySelectorAll('.bgwake')).toHaveLength(1);
    expect(mounted().textContent).not.toContain('upgrade to 39551b637');
    expect(line.hasAttribute('data-seq'), 'a queued wake is no event for ⌘F to land on').toBe(false);
    // The block stays folded here too, and none of it is drawn as something the user typed.
    const fold = line.querySelector('details.bgwake-fold')!;
    expect(fold.hasAttribute('open')).toBe(false);
    expect(fold.querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_SCHEDULED);
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((b) => b.textContent?.includes('bgj_')),
      'no part of the wake is drawn as something the user typed',
    ).toBe(false);

    // The queue's own line, under the wake's.
    const queueLine = line.querySelector('.bgwake-queued .chat-queued-meta')!;
    expect(queueLine.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...queueLine.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    // The message typed behind it waits in the tray above the composer, the wake's line staying here.
    expect(mounted().querySelectorAll('.chat-queued')).toHaveLength(0);
    const rows = mounted().querySelectorAll<HTMLElement>('.pending-tray-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.pending-tray-text')?.textContent).toBe(TYPED);
  });
});
