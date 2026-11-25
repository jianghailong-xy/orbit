// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleRunSessionStatus, ScheduleRunView } from '@orbit/shared';
import type { Runner } from './TasksSidePanel';
import {
  BUMP_MISSED_RUN,
  BUMP_QUEUED_RUN,
  BUMP_STARTED_RUN,
  bumpMissedStatus,
  bumpQueuedStatus,
  bumpStartedStatus,
  scheduleDetail,
} from '../test/scheduleFixtures';

/**
 * A run's session where the run did not get under way (board docs/mocks/scheduled-run-not-started ②③④, owner's B1
 * and C1), on the real session page: the run card in place of the composer, the red report and the "never started"
 * note; opened by id from the run's history, from no list. An ordinary session that never started keeps both.
 */

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  getToken: () => 'token',
  api: vi.fn(), getSession: vi.fn(), getSessionEventPage: vi.fn(), getShareLink: vi.fn(),
}));
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null, saveTranscript: async () => {},
}));
// The fixture's clock labels are for a viewer in Shanghai.
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/schedules')>(),
  viewerTimezone: () => 'Asia/Shanghai',
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { ControlPlaneProvider } = await import('../lib/useControlPlane');
const { encodeId } = await import('../lib/idCodec');
const uuid = (n: number) => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const RUNNER_ID = uuid(981);
const WORKSPACE_ID = encodeId(uuid(982));
const TRY_ID = encodeId(uuid(983));
const RUNNER = {
  id: RUNNER_ID, name: 'HPC', online: true, maxConcurrent: 20, activeSessions: 20,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
const NEVER_STARTED_NOTE = 'This session never started, so there is no context to resume.';

/** A session whose first turn never reached its engine, ended (the run retired it) or still queued. */
function trySession(runSource: 'SCHEDULE' | 'MANUAL', queued = false) {
  return {
    id: TRY_ID, title: 'Engine version bump', workspaceId: WORKSPACE_ID, workspace: { id: WORKSPACE_ID, name: 'apiserver' },
    runnerId: RUNNER_ID, assignedRunnerId: RUNNER_ID, provider: 'claude', engine: 'claude', runSource,
    status: queued ? 'PENDING' : 'CANCELLED', runState: queued ? 'QUEUED' : 'ENDED', lifecycleState: 'OPEN',
    createdAt: '2025-11-13T19:32:00Z', lastTurnAt: '2025-11-13T19:32:00Z', startedAt: null, finishedAt: queued ? null : '2025-11-13T19:42:00Z',
    numTurns: 0, pinnedAt: null as string | null, shared: false,
    ...(queued ? { queuedReason: 'runner_at_capacity', queuedActive: 20, queuedLimit: 20, queuedHeldByJobs: 0 } : {}),
    capabilities: queued
      ? { canSend: true, canResume: false, resumeBlockedReason: 'NOT_TERMINAL', canComplete: true, canRestore: false }
      : { canSend: false, canResume: false, resumeBlockedReason: 'NOT_STARTED', canComplete: true, canRestore: false },
  };
}

let session: ReturnType<typeof trySession>;
let scheduleCards: { run: ScheduleRunView | null; runStatus: ScheduleRunSessionStatus | null };
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

async function until(assertion: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try { await vi.waitFor(assertion, { timeout: 10_000, interval: 20 }); }
  finally { env.IS_REACT_ACT_ENVIRONMENT = previous; }
  await act(async () => {});
}

/** A try's run status, named for the session on the page. */
function asThisSession(status: ScheduleRunSessionStatus): ScheduleRunSessionStatus {
  const i = (status.thisTry ?? 1) - 1;
  return { ...status, tries: status.tries.map((t, n) => (n === i ? { ...t, sessionId: TRY_ID } : t)) };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('EventSource', class { onopen = null; onmessage = null; onerror = null; close() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)', media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async () => session as never);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getShareLink).mockReset();
  vi.mocked(apiModule.getShareLink).mockResolvedValue({ link: null, counts: { messages: 0, toolCalls: 0 } });
  vi.mocked(apiModule.api).mockReset();
  vi.mocked(apiModule.api).mockImplementation(async (path: string) => {
    if (path === '/users/me') return { id: 'user-1', name: 'Reader', email: 'reader@example.com', preferences: {} } as never;
    if (path === '/workspaces') return [{ id: WORKSPACE_ID, name: 'apiserver', runnerId: RUNNER_ID, lastProvider: 'claude' }] as never;
    // C1: a try that never reached its engine is in no list, the Scheduled runs folder included.
    if (path.startsWith('/sessions?')) return [] as never;
    if (path === `/sessions/${TRY_ID}/schedule-cards`) return { ...scheduleCards, cards: [], records: [] } as never;
    if (path === '/schedules/sch-bump') return scheduleDetail('sch-bump') as never;
    if (path.startsWith('/sessions/')) {
      if (path.includes('/created-tasks')) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] } as never;
      if (path.includes('/diff')) return { files: [] } as never;
      return [] as never;
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) return { decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] } as never;
    if (path.startsWith('/tasks/page')) return { items: [], nextCursor: null } as never;
    if (path.startsWith('/tasks')) return { items: [], total: 0, counts: {} } as never;
    return [] as never;
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  if (client) { await client.cancelQueries(); client.clear(); }
  root = null;
  client = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The run's history opens its session by id (scheduleRunSessionPath); the list goes to the Scheduled runs folder. */
async function openFromRunHistory(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <ControlPlaneProvider>
          <MemoryRouter initialEntries={[`/sessions/${TRY_ID}`]}>
            <WorkspaceView runner={RUNNER} />
          </MemoryRouter>
        </ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
}

const card = () => container!.querySelector<HTMLElement>('[data-schedule-run-card]');
const doors = () => [...card()!.querySelectorAll('button')].map((b) => b.textContent);
const composer = () => container!.querySelector('.workspace-composer');

describe('a run’s session where the run did not get under way', () => {
  it('② Didn’t run: the card and its doors, no composer, no red card, no "never started" note', async () => {
    session = trySession('SCHEDULE');
    scheduleCards = { run: { ...BUMP_MISSED_RUN, sessionId: TRY_ID }, runStatus: asThisSession(bumpMissedStatus()) };
    await openFromRunHistory();
    await until(() => expect(card()?.dataset.scheduleRunCard).toBe('DIDNT_RUN'));
    // Its address names no list page: the list goes to Scheduled runs from the run's own session.
    await until(() => expect(container!.querySelector('.session-folder-title')?.textContent).toBe('Scheduled runs'));
    expect(card()!.querySelector('.sched-run-title')!.textContent).toBe("Didn't run");
    expect(card()!.querySelector('.sched-run-body')!.textContent)
      .toBe("HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.");
    expect(doors()).toEqual(['Run now', 'Open schedule']);
    expect(composer()).toBeNull();
    expect(container!.textContent).not.toContain(NEVER_STARTED_NOTE);
    expect(container!.querySelector('[data-schedule-report]')).toBeNull();
    expect(container!.textContent).not.toContain('Found no runner online');
  }, 60_000);

  it('③ Queued · runner full: the card and Cancel run, no composer, no queued notice of its own', async () => {
    session = trySession('SCHEDULE', true);
    scheduleCards = { run: { ...BUMP_QUEUED_RUN, sessionId: TRY_ID }, runStatus: asThisSession(bumpQueuedStatus()) };
    await openFromRunHistory();
    await until(() => expect(card()?.dataset.scheduleRunCard).toBe('QUEUED_FULL'));
    expect(card()!.querySelector('.sched-run-title')!.textContent).toBe('Queued · runner full');
    expect(card()!.querySelector('.sched-run-body')!.textContent)
      .toBe('HPC is running 20 of 20 sessions. The run starts as soon as one finishes.');
    expect(doors()).toEqual(['Cancel run', 'Open schedule']);
    expect(composer()).toBeNull();
    expect(container!.querySelector('.chat-queued-state')).toBeNull();
    expect(container!.textContent).not.toContain(NEVER_STARTED_NOTE);
  }, 60_000);

  it('④ Started on try 3: the card and Open the run, no composer, no "never started" note', async () => {
    session = trySession('SCHEDULE');
    scheduleCards = { run: BUMP_STARTED_RUN, runStatus: asThisSession(bumpStartedStatus(2)) };
    await openFromRunHistory();
    await until(() => expect(card()?.dataset.scheduleRunCard).toBe('STARTED_ON'));
    expect(card()!.querySelector('.sched-run-title')!.textContent).toBe('Started on try 3');
    expect(card()!.querySelector('.sched-run-body')!.textContent)
      .toBe('This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.');
    expect(doors()).toEqual(['Open the run →']);
    expect(composer()).toBeNull();
    expect(container!.textContent).not.toContain(NEVER_STARTED_NOTE);
  }, 60_000);

  it('an ordinary session that never started keeps its composer and its note', async () => {
    session = trySession('MANUAL');
    scheduleCards = { run: null, runStatus: null };
    await openFromRunHistory();
    await until(() => expect(container!.textContent).toContain(NEVER_STARTED_NOTE));
    expect(composer()).not.toBeNull();
    expect(card()).toBeNull();
  }, 60_000);
});
