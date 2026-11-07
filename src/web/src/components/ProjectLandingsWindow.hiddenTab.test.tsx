// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLandingAttempt, SessionLandingView } from '@orbit/shared';
import { api, getSession, type SessionDetail } from '../api';
import { createAppQueryClient } from '../lib/queryClient';
import { ControlPlaneProvider } from '../lib/useControlPlane';
import { ProjectLandingsWindow } from './ProjectLandingsWindow';

/**
 * The one exception to the list budget (docs/list-freshness-design.md §4): a LANDING session
 * publishes no realtime event (docs/project-integration-line-contract.md LS6), so while a landing is
 * in flight the Landings window keeps reading it on its own 4 s cadence, and its running check's
 * log with it. Only while the tab is in view: a hidden tab reads none of it, not on its own clock,
 * and not when the control-plane stream reopens behind it.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSession: vi.fn(), getToken: () => 'token' };
});

const SESSION = 'landing1';
const PROJECT = 'project1';
const at = (hour: number, minute: number, second = 0): string =>
  new Date(2026, 8, 25, hour, minute, second).toISOString();
const NOW = new Date(2026, 8, 25, 14, 58, 30).getTime();

const attempt: SessionLandingAttempt = {
  jobId: 'job-1',
  kind: 'LAND_TASK',
  state: 'RUNNING',
  generation: 1,
  phase: 'CHECK',
  round: 1,
  step: null,
  claim: 1,
  runnerName: 'wikova',
  sourceSessionId: 'source-1',
  targetRef: 'refs/heads/project/p1',
  startedAt: at(14, 56, 40),
  heartbeatAt: at(14, 58, 30),
  outputMovedAt: at(14, 58, 24),
  progressProtocol: 'v2',
  check: { name: 'MERGE_CHECK', index: 1, count: 3, budgetSeconds: 3_600, startedAt: at(14, 56, 40) },
  liveness: 'LIVE',
  blockingReason: null,
  timedOut: false,
  limitSeconds: 600,
  retryable: false,
  pushBoundaryPassed: false,
};

const view: SessionLandingView = {
  sessionId: SESSION,
  projectId: PROJECT,
  subject: 'TASK',
  taskId: 'task-1',
  promotionId: null,
  episode: 1,
  openedAt: at(14, 50),
  settledAt: null,
  settledAs: null,
  phase: 'CHECK',
  round: 1,
  checks: [],
  liveness: 'LIVE',
  blockingReason: null,
  currentAttempt: attempt,
  todos: [],
  generations: [],
  // The running job's section, which is where its live check and that check's log are drawn.
  timeline: {
    sections: [{ title: 'Generation 1', jobId: 'job-1', kind: 'LAND_TASK', generation: 1, state: 'RUNNING', entries: [] }],
    facts: [],
    truncated: false,
  },
};

const detail: SessionDetail = {
  id: SESSION,
  title: 'Land · Ledger migration order',
  status: 'AWAITING_INPUT',
  sessionKind: 'LANDING',
  landing: view,
};

const row = {
  id: SESSION,
  sessionKind: 'LANDING',
  title: 'Land · Ledger migration order',
  createdAt: view.openedAt,
  lastTurnAt: view.openedAt,
  lifecycleState: 'OPEN',
  landing: { subject: 'TASK', state: 'IN_FLIGHT', settledAs: null, settledAt: null },
};

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

let calls: string[] = [];
let visibility: DocumentVisibilityState = 'visible';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const stream = (): FakeEventSource => FakeEventSource.all.filter((es) => !es.closed).at(-1)!;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Time passing with the control-plane stream live: its keepalive comes every 20 s. */
async function live(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20_000) {
    await advance(Math.min(20_000, left));
    await act(async () => stream().onmessage?.({ data: JSON.stringify({ type: 'ping' }) }));
  }
}

async function show(state: DocumentVisibilityState): Promise<void> {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const landingReads = (from: number): string[] =>
  calls.slice(from).filter((call) => call === `getSession:${SESSION}` || call.startsWith(`/sessions/${SESSION}/landing/log`));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  calls = [];
  vi.mocked(getSession).mockImplementation(((id: string) => {
    calls.push(`getSession:${id}`);
    return Promise.resolve(detail);
  }) as never);
  vi.mocked(api).mockImplementation(((path: string) => {
    calls.push(path);
    if (path.startsWith('/sessions?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      return Promise.resolve(query.get('view') === 'completed' ? [] : [row]);
    }
    if (path === `/projects/${PROJECT}`) return Promise.resolve({ id: PROJECT, title: 'Wiki server' });
    if (path === `/projects/${PROJECT}/integration`) {
      return Promise.resolve({ upstreamRef: 'refs/heads/main', inFlight: { kind: 'LAND_TASK' }, inFlightJobs: [], landTasks: [] });
    }
    if (path === `/projects/${PROJECT}/coordinator/status`) return Promise.resolve({ coordination: { sessionId: 'coord-1' } });
    if (path === `/projects/${PROJECT}/promotions/current`) return Promise.resolve(null);
    if (path === `/projects/${PROJECT}/promotions/merged`) return Promise.resolve([]);
    if (path.startsWith(`/sessions/${SESSION}/landing/log`)) {
      return Promise.resolve({ jobId: 'job-1', entries: [], nextCursor: null });
    }
    return Promise.resolve({});
  }) as never);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  FakeEventSource.all = [];
  vi.restoreAllMocks();
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a landing in flight, which no realtime event announces', () => {
  it('is read every 4 s while the tab is in view, and not at all while it is hidden', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={createAppQueryClient()}>
          <ControlPlaneProvider>
            <MemoryRouter initialEntries={[`/sessions/${SESSION}`]}>
              <ProjectLandingsWindow projectId={PROJECT} focusId={SESSION} onOpenSession={() => {}} />
            </MemoryRouter>
          </ControlPlaneProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => stream().onopen?.());
    await live(1_000);
    expect(container.textContent, 'the landing’s card is not on screen').toContain('Ledger migration order');

    // In view: the landing keeps its cadence, and so does its running check's log.
    let from = calls.length;
    await live(12_000);
    const visible = landingReads(from);
    expect(visible.filter((call) => call.startsWith('getSession')).length, 'the landing lost its 4 s cadence').toBeGreaterThanOrEqual(3);
    expect(visible.filter((call) => call.includes('/landing/log')).length, 'the running check’s log lost its 4 s cadence').toBeGreaterThanOrEqual(3);

    // Hidden: nothing, on its own clock or anyone else's.
    await show('hidden');
    from = calls.length;
    await live(60_000);
    expect(calls.slice(from), 'a hidden tab read the landing').toEqual([]);

    // Not even when the control-plane stream drops and opens again behind it.
    await act(async () => stream().onerror?.());
    await advance(2_000);
    await act(async () => stream().onopen?.());
    await live(20_000);
    expect(calls.slice(from), 'a hidden tab read when its stream reopened').toEqual([]);

    // Back in view, the landing is read again, at once and then on its cadence.
    await show('visible');
    await live(8_000);
    expect(landingReads(from).filter((call) => call.startsWith('getSession')).length).toBeGreaterThanOrEqual(2);
  });
});
