// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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
} from '../lib/backgroundWake.fixtures';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A turn the control plane opened — a background job had the news its agent was waiting for, or a
 * scheduled wakeup came due — is nobody's message: the block IS the turn. It used to draw as an
 * unnamed grey strip (`⊕ Orbit attached: context`) over an empty bubble, because its tag is in no
 * label table, with the whole block folded behind a word that said nothing about it.
 *
 * It is the control plane's card instead, built like the one a watch's wake gets, with the words the
 * agent read one native disclosure away. Two things are held here that a card drawn only for what
 * ships today would break: the 59 turns already in the record carry the wording that shipped until
 * 2026-09-15 and are not migrated (fixtures copied verbatim out of this deployment's `run_event`
 * rows), and a note that carries a wake AND something else keeps that something else where it has
 * always been — the folded entry under the card, not swallowed by it.
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

/** Twelve lines of tail, so what the fold does to a long one is witnessed rather than assumed. */
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

describe('a wake turn in the transcript', { timeout: 30_000 }, () => {
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

  const card = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.bgwake');
    if (!el) throw new Error(`no wake card was rendered:\n${container.innerHTML}`);
    return el;
  };

  it('is the control plane’s card, not a message the user typed', async () => {
    await mount([wakeEvent(EN_DONE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(card().getAttribute('data-seq')).toBe('7');
    expect(card().className).toContain('is-ok');
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    expect(card().querySelector('.bgwake-why')?.textContent).toBe('upgrade to 39551b637 exited 0.');
    expect(card().querySelector('.bgwake-meta')?.textContent).toMatch(
      /^Queued by a background job, not typed by you · /,
    );

    // One row per job: what it was, how it came out, and the command behind the description.
    const jobs = card().querySelectorAll('.bgwake-job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].querySelector('.bgwake-job-name')?.textContent).toBe('upgrade to 39551b637');
    expect(jobs[0].querySelector('.bgwake-job-exit')?.textContent).toBe('exit 0');
    expect(jobs[0].querySelector('.bgwake-job-cmd')?.textContent).toBe(
      '/root/orbit/.claude/skills/upgrade/upgrade.sh --pull',
    );
    expect(jobs[0].querySelector('.bgwake-job-meta')?.textContent).toBe(
      'bgj_13c53745a88a · 16.2 KB of output',
    );

    // What the agent read is kept, whole, one disclosure away — and nowhere else on the card.
    const raw = card().querySelector('details.bgwake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent received');
    expect(raw.querySelector('pre')?.textContent).toBe(EN_DONE);
    const shown = card().cloneNode(true) as HTMLElement;
    shown.querySelector('details')!.remove();
    expect(shown.textContent).not.toContain('The control plane recorded this for you');
  });

  it('brings a failed job’s output out of the fold, collapsed past a few lines', async () => {
    await mount([wakeEvent(EN_FAILED)]);

    expect(card().className).toContain('is-failed');
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job failed');
    expect(card().querySelector('.bgwake-why')?.textContent).toBe('watch main CI 34997433169 exited 1.');
    expect(card().querySelector('.bgwake-job-exit')?.textContent).toBe('exit 1');
    expect(card().querySelector('.bgwake-job-meta')?.textContent).toBe(
      'bgj_2955bec0e9fc · 342.5 KB of output',
    );

    const pre = card().querySelector('.bgwake-job .chat-pre')!;
    expect(pre.textContent).toContain('error line 1');
    expect(pre.textContent).toContain('error line 8');
    expect(pre.textContent, 'past the threshold, folded').not.toContain('error line 9');
    expect(card().querySelector('.bgwake-job .chat-more')?.textContent).toBe('Show 4 more lines');
  });

  it('draws the same card for the wording that shipped until 2026-09-15', async () => {
    await mount([wakeEvent(ZH_JOB_DONE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    expect(card().querySelector('.bgwake-why')?.textContent).toBe(
      'watch main CI rerun 34970575848 exited 0.',
    );
    expect(card().querySelector('.bgwake-job-meta')?.textContent).toBe('bgj_cc4b4ef84b39 · 54 B of output');
    expect(card().querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_JOB_DONE);
  });

  it('draws an older failure as a failure, output and all', async () => {
    await mount([wakeEvent(ZH_JOB_FAILED)]);

    expect(card().className).toContain('is-failed');
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job failed');
    expect(card().querySelector('.bgwake-why')?.textContent).toBe(
      'Smoke: wakeOnExit on a job that exits 3 exited 3.',
    );
    expect(card().querySelector('.bgwake-job-exit')?.textContent).toBe('exit 3');
    expect(card().querySelector('.bgwake-job-meta')?.textContent).toBe('bgj_209fc7f9f47a · no output');
  });

  it('draws an older scheduled wakeup as the wakeup it was', async () => {
    await mount([wakeEvent(ZH_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Scheduled wakeup');
    expect(card().querySelector('.bgwake-why')?.textContent).toContain('复跑负载闸门');
    expect(card().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 1h out');
    // What it left for this turn to read is shown, as a job's output is.
    expect(card().querySelector('.bgwake-wakeup .chat-pre')?.textContent).toContain('兜底检查');
    expect(card().querySelector('.bgwake-meta')?.textContent).toMatch(
      /^Queued by a scheduled wakeup, not typed by you · /,
    );
  });

  it('draws the one older turn both blocks came on as a single card', async () => {
    await mount([wakeEvent(ZH_JOB_AND_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    expect(card().querySelector('.bgwake-job-name')?.textContent).toBe(
      'upgrade to 39551b637 (catalog-window fix + session-import)',
    );
    expect(card().querySelector('.bgwake-job-meta')?.textContent).toBe(
      'bgj_13c53745a88a · 16.2 KB of output',
    );
    // The wakeup that came due while the job ran keeps its own row on the same card.
    expect(card().querySelector('.bgwake-wakeup-reason')?.textContent).toContain('升级作业的备份验证');
    expect(card().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 12m out');
    expect(card().querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_JOB_AND_SCHEDULED);
  });

  it('counts the jobs of an older turn that answered for two', async () => {
    await mount([wakeEvent(ZH_TWO_JOBS)]);

    expect(card().className).toContain('is-failed');
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe(
      '2 background jobs finished',
    );
    expect(card().querySelector('.bgwake-why')?.textContent).toBe('2 of 2 failed.');
    expect([...card().querySelectorAll('.bgwake-job-meta')].map((el) => el.textContent)).toEqual([
      'bgj_52843eb345d1 · no output',
      'bgj_974ceb2c3d52 · no output',
    ]);
  });

  it('takes only the wake out of a note that carried more, and leaves the rest its own entry', async () => {
    await mount([wakeEvent(ZH_WAKE_WITH_COORDINATOR_CONTEXT)]);

    // The card is the wake alone — the coordinator's standing role is not part of what woke anybody.
    expect(card().querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    const raw = card().querySelector('details.bgwake-raw pre')!;
    expect(raw.textContent?.startsWith('<background-job-wake>')).toBe(true);
    expect(raw.textContent).not.toContain('orbit_project_coordinator_context');

    // The rest stays exactly the entry it has always been, named for what it is.
    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('⊕ Orbit attached:'),
    );
    expect(toggle, `no entry for the rest of the note:\n${container.innerHTML}`).toBeTruthy();
    expect(toggle!.textContent).toBe('⊕ Orbit attached: project coordinator context');
    expect(container.querySelector('.chat-user')?.textContent).not.toContain('bgj_');

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const opened = toggle!.parentElement!.querySelector('pre')!;
    expect(opened.textContent?.startsWith('<orbit_project_coordinator_context>')).toBe(true);
    expect(opened.textContent).not.toContain('bgj_');
  });

  it('keeps the card, and the words behind a native disclosure, in an exported transcript', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[wakeEvent(EN_DONE)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');

    expect(exported.querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    // A static file has no JS: the fold has to be one the browser itself can open.
    expect(exported.querySelector('details.bgwake-raw pre')?.textContent).toBe(EN_DONE);
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
      { turnId: 'turn-wake', kind: 'message', placement: 'queued', content: EN_DONE, createdAt: '2026-09-15T18:10:01.000Z' },
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

  it('is the same card, drawn as still queued, with the queue’s line at its foot', async () => {
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
    });
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(mounted().querySelector('.bgwake')).not.toBeNull();
          expect(mounted().querySelector('.chat-queued')).not.toBeNull();
        },
        { timeout: 20_000, interval: 20 },
      );
    });

    const card = mounted().querySelector<HTMLElement>('.bgwake')!;
    expect(card.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(card.querySelector('.bgwake-title')?.textContent?.trim()).toBe('Background job finished');
    expect(card.querySelector('.bgwake-job-name')?.textContent).toBe('upgrade to 39551b637');
    expect(card.hasAttribute('data-seq'), 'a queued wake is no event for ⌘F to land on').toBe(false);
    // The block stays folded here too, and none of it is drawn as something the user typed.
    const raw = card.querySelector('details.bgwake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('pre')?.textContent).toBe(EN_DONE);
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((b) => b.textContent?.includes('bgj_')),
      'no part of the wake is drawn as something the user typed',
    ).toBe(false);

    // The queue's own line, at the foot of the card.
    const line = card.querySelector('.bgwake-queued .chat-queued-meta')!;
    expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...line.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    // The message typed behind it is drawn as it always was.
    const bubbles = mounted().querySelectorAll<HTMLElement>('.chat-queued');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].querySelector('.md')?.textContent?.trim()).toBe(TYPED);
  });
});
