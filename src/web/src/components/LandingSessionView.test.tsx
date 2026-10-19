// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectPromotionView,
  SessionLandingAttempt,
  SessionLandingView,
} from '@orbit/shared';
import { api, getSession, type SessionDetail } from '../api';
import { landingClockTime } from './ProjectPanoramaHeader';
import { LandingSessionView } from './LandingSessionView';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSession: vi.fn() };
});

const SESSION = 'landing1';
const PROJECT = 'project1';
const at = (hour: number, minute: number, second = 0): string =>
  new Date(2026, 8, 25, hour, minute, second).toISOString();
const NOW = new Date(2026, 8, 25, 14, 58, 30).getTime();

const attempt = (over: Partial<SessionLandingAttempt> = {}): SessionLandingAttempt => ({
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
  ...over,
});

const landing = (over: Partial<SessionLandingView> = {}): SessionLandingView => ({
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
  currentAttempt: attempt(),
  todos: [],
  generations: [],
  timeline: { sections: [], facts: [], truncated: false },
  ...over,
});

const detail = (view: SessionLandingView): SessionDetail => ({
  id: SESSION,
  title: 'Land · Ledger migration order',
  status: 'AWAITING_INPUT',
  sessionKind: 'LANDING',
  landing: view,
});

const integration = {
  upstreamRef: 'refs/heads/main',
  inFlightJobs: [{
    jobId: 'job-1', stepStartedAt: at(14, 56, 40), typicalMs: 18 * 60_000,
  }],
  landTasks: [],
};

const coordinator = { coordination: { sessionId: 'coord-1' }, readAt: at(14, 58) };

const promo = (over: Partial<ProjectPromotionView> = {}): ProjectPromotionView => ({
  promotionId: 'promo-1',
  state: 'MERGED',
  sourceKind: 'PROJECT_BRANCH',
  sourceRef: 'refs/heads/project/p1',
  sourceSha: 'a'.repeat(40),
  upstreamRef: 'refs/heads/main',
  commitsAhead: 2,
  filesChanged: 3,
  tasks: [
    { taskId: 'task-1', title: 'Ledger migration order' },
    { taskId: 'task-2', title: 'Payout retry budget' },
  ],
  taskIds: ['task-1', 'task-2'],
  checks: [],
  conflicts: [],
  blockedReason: null,
  upstreamShaChecked: 'b'.repeat(40),
  landsTreeSha: '5e5bfca000000000000000000000000000000000',
  landsAs: 'MERGE_COMMIT',
  askedAt: null,
  upstream: { syncedAt: null, conflicts: false },
  recheckedAt: null,
  recheck: null,
  merged: { sha: '8ed0ea7000000000000000000000000000000000', at: at(9, 51), automatic: true, byUserId: null },
  ...over,
});

let view: SessionLandingView = landing();
let mergedRows: ProjectPromotionView[] = [];
let currentPromotion: ProjectPromotionView | null = null;
let sessionAnswer: () => Promise<unknown> = () => Promise.resolve(detail(view));
let retryAnswer: () => Promise<unknown> = () => Promise.resolve({});
let logAnswer: () => Promise<unknown> = () => Promise.resolve({ jobId: 'job-1', entries: [], nextCursor: null });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let opened: string | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReactNode): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION}`]}>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function page(): HTMLElement {
  return container!;
}

function button(text: string): HTMLButtonElement | null {
  return [...page().querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent === text) ?? null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no ResizeObserver; the ⋯ menu measures its anchor with one. Inert is enough here:
  // nothing in this suite is about where the popup lands, only what is in it.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  view = landing();
  mergedRows = [];
  currentPromotion = null;
  sessionAnswer = () => Promise.resolve(detail(view));
  retryAnswer = () => Promise.resolve({});
  logAnswer = () => Promise.resolve({ jobId: 'job-1', entries: [], nextCursor: null });
  opened = null;
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation((() => sessionAnswer()) as never);
  vi.mocked(api).mockImplementation(((path: string, options?: { method?: string }) => {
    opened = path;
    if (path === `/projects/${PROJECT}/integration`) return Promise.resolve(integration);
    if (path === `/projects/${PROJECT}/coordinator/status`) return Promise.resolve(coordinator);
    if (path === `/projects/${PROJECT}/promotions/current`) return Promise.resolve(currentPromotion);
    if (path === `/projects/${PROJECT}/promotions/merged`) return Promise.resolve(mergedRows);
    if (path.startsWith(`/sessions/${SESSION}/landing/log`)) return logAnswer();
    if (options?.method === 'POST' && path.endsWith('/integration/jobs/job-1/retry')) return retryAnswer();
    return Promise.resolve({});
  }) as never);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the landing session page', () => {
  it('draws the header, the status card, the sections and the read-only footer', async () => {
    view = landing({
      timeline: {
        sections: [
          {
            title: 'Generation 1',
            jobId: 'job-0',
            kind: 'LAND_TASK',
            generation: 1,
            state: 'CHECK_FAILED',
            entries: [
              {
                id: 'e1', seq: 1, kind: 'ENQUEUED', at: at(11, 2), claim: 0, round: null,
                check: null, phase: null, step: null, actor: null, reason: null, data: null,
                text: 'Task marked done · queued to land on project/p1',
              },
              {
                id: 'e2', seq: 2, kind: 'RESULT', at: at(11, 7), claim: 1, round: null,
                check: null, phase: 'CHECK', step: null, actor: { type: 'RUNNER' }, reason: null,
                data: null, text: 'Check failed · nothing was pushed',
              },
            ],
          },
          {
            title: 'Generation 2',
            jobId: 'job-1',
            kind: 'LAND_TASK',
            generation: 2,
            state: 'RUNNING',
            entries: [
              {
                id: 'e3', seq: 3, kind: 'CLAIMED', at: at(14, 56), claim: 2, round: null,
                check: null, phase: 'FETCH', step: null, actor: { type: 'RUNNER' }, reason: null,
                data: null, text: 'Claimed by runner wikova · claim 2',
              },
              {
                id: 'e4', seq: 4, kind: 'ROUND', at: at(14, 56), claim: 2, round: 1,
                check: null, phase: null, step: null, actor: null, reason: null, data: null,
                text: 'Round 1',
              },
              {
                id: 'e5', seq: 5, kind: 'TAKEN_OVER', at: at(14, 57), claim: 2, round: null,
                check: null, phase: 'REBASE', step: null, actor: { type: 'RUNNER' }, reason: null,
                data: null, text: 'Taken over by a new process on runner wikova · claim 2',
              },
              {
                id: 'e6', seq: 6, kind: 'RELEASED', at: at(14, 57, 30), claim: 2, round: null,
                check: null, phase: 'CHECK', step: null, actor: { type: 'RUNNER' }, reason: null,
                data: null, text: 'Handed back by runner wikova · claim 2',
              },
              {
                id: 'e7', seq: 7, kind: 'CHECK_FINISHED', at: at(14, 58), claim: 2, round: 1,
                check: { name: 'MERGE_CHECK', index: 1 }, phase: 'CHECK', step: null,
                actor: { type: 'RUNNER' }, reason: null, data: null,
                text: 'Merge check passed · 17m 02s',
              },
            ],
          },
        ],
        facts: [],
        truncated: false,
      },
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);

    expect(page().textContent).toContain('Land · Ledger migration order');
    expect(page().textContent).toContain('Run by Orbit · runner wikova');
    expect(page().textContent).toContain('Landing');
    expect(page().textContent).toContain('checking');
    expect(page().textContent).toContain('Output 6s ago · Updated just now');
    // The timeline: every generation, every claim, round, takeover and hand-back.
    expect(page().textContent).toContain('Generation 1');
    expect(page().textContent).toContain('Generation 2');
    expect(page().textContent).toContain('Task marked done · queued to land on project/p1');
    expect(page().textContent).toContain('Check failed · nothing was pushed');
    expect(page().textContent).toContain('Claimed by runner wikova · claim 2');
    expect(page().textContent).toContain('Round 1');
    expect(page().textContent).toContain('Taken over by a new process on runner wikova · claim 2');
    expect(page().textContent).toContain('Handed back by runner wikova · claim 2');
    expect(page().textContent).toContain('Merge check passed · 17m 02s');
    expect(page().textContent).toContain('Orbit runs this landing — nothing to type here.');
    expect(page().textContent).toContain('Decisions: the coordinator');
    // No conversation anatomy: no composer, no model, no rename, no share.
    expect(page().querySelector('textarea')).toBeNull();
    expect(page().querySelector('.composer-model-chip')).toBeNull();
    expect(page().querySelector('.workspace-name-input')).toBeNull();
    expect(page().querySelector('.session-shared-pill')).toBeNull();
  });

  it('opens a check’s output from its line', async () => {
    view = landing({
      timeline: {
        sections: [{
          title: 'Generation 1',
          jobId: 'job-1',
          kind: 'LAND_TASK',
          generation: 1,
          state: 'CHECK_FAILED',
          entries: [{
            id: 'e1', seq: 1, kind: 'CHECK_FINISHED', at: at(14, 58), claim: 1, round: 1,
            check: { name: 'MERGE_CHECK', index: 1 }, phase: 'CHECK', step: null,
            actor: { type: 'RUNNER' }, reason: null, data: null, text: 'Merge check failed · exit 1 · 3m 52s',
          }],
        }],
        facts: [], truncated: false,
      },
    });
    logAnswer = () => Promise.resolve({
      jobId: 'job-1',
      entries: [{
        jobId: 'job-1', claim: 1, round: 1, check: { name: 'MERGE_CHECK', index: 1 },
        seq: 0, text: 'FAIL  server-execution > runs on the server', truncatedBytes: 0, at: at(14, 58),
      }],
      nextCursor: null,
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    await click(button('Log ›'), 'the log press');
    expect(opened).toContain(`/sessions/${SESSION}/landing/log?jobId=job-1&claim=1&round=1&check=1`);
    expect(page().textContent).toContain('FAIL  server-execution > runs on the server');
    await click(button('Log ›'), 'the log press again');
    expect(page().textContent).not.toContain('FAIL  server-execution > runs on the server');
  });
});

describe('a timed-out landing', () => {
  it('draws the server’s Timed out head, the claim line and J12’s nothing-pushed sentence', async () => {
    view = landing({
      currentAttempt: attempt({
        phase: 'REBASE', liveness: 'LEASE_EXPIRED', timedOut: true, heartbeatAt: at(14, 35, 30),
      }),
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    expect(page().textContent).toContain('Timed out');
    expect(page().textContent).toContain('No report for 23m · limit 10m');
    expect(page().textContent).toContain(
      `Runner wikova took it at ${landingClockTime(at(14, 56, 40))} · stopped at rebasing · claim 1 · round 1 of 3`,
    );
    expect(page().textContent).toContain('Nothing was pushed');
    // eslint-disable-next-line no-console
    expect(button('Retry')).toBeTruthy();
    expect(button('Abandon')).toBeTruthy();
    // The server's own refusal is said under the card in the Landing card's shape.
    retryAnswer = () => Promise.reject(new Error('this job is not in flight any more.'));
    await click(button('Retry'), 'Retry');
    expect(page().textContent).toContain('Retry failed — this job is not in flight any more.');
  });

  it('a merge check says a check pushes nothing and offers Re-run the check', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({
        kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true,
      }),
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    expect(page().textContent).toContain('A check pushes nothing — main is as it was.');
    expect(button('Re-run the check')).toBeTruthy();
    expect(button('Abandon')).toBeTruthy();
    expect(button('Retry')).toBeNull();
  });
});

describe('a read this device cannot make', () => {
  it('freezes the card at Update unavailable and opens no door', async () => {
    view = landing({
      currentAttempt: attempt({ liveness: 'LEASE_EXPIRED', timedOut: true }),
    });
    sessionAnswer = () => Promise.reject(new Error('network down'));
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    expect(page().textContent).toContain('Update unavailable');
    expect(button('Retry')).toBeNull();
    expect(button('Abandon')).toBeNull();
  });
});

describe('the merge round’s sections and its gates', () => {
  it('lays the round out by job: Merge check · N and Merge to main · N', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'CHECK_PROMOTION', phase: 'CHECK', claim: 1, round: null }),
      timeline: {
        sections: [
          {
            title: 'Merge check · 1', jobId: 'job-1', kind: 'CHECK_PROMOTION', generation: 1,
            state: 'RUNNING',
            entries: [{
              id: 'e1', seq: 1, kind: 'CHECK_STARTED', at: at(14, 56), claim: 1, round: null,
              check: { name: 'MERGE_CHECK', index: 1 }, phase: 'CHECK', step: null,
              actor: { type: 'RUNNER' }, reason: null, data: null, text: 'Merge check started · claim 1 · wikova',
            }],
          },
          {
            title: 'Merge to main · 1', jobId: 'job-0', kind: 'LAND_PROMOTION', generation: 1,
            state: 'MERGED',
            entries: [{
              id: 'e2', seq: 2, kind: 'RESULT', at: at(9, 51), claim: 1, round: null,
              check: null, phase: 'PUSH', step: null, actor: { type: 'RUNNER' }, reason: null,
              data: null, text: 'Landed on main · 8ed0ea7',
            }],
          },
        ],
        facts: [], truncated: false,
      },
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    expect(page().textContent).toContain('Merge check · 1');
    expect(page().textContent).toContain('Merge to main · 1');
    expect(page().textContent).toContain('Merge check started · claim 1 · wikova');
  });

  it('a merge round’s menu has Review Card and Cancel Merge, never Stop Landing', async () => {
    currentPromotion = promo({ state: 'CONFIRMED', merged: null, landsTreeSha: null });
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'LAND_PROMOTION', phase: 'CHECK' }),
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    await click(page().querySelector('button[aria-label="More actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).toContain('Review Card');
    expect(document.body.textContent).toContain('Cancel Merge');
    expect(document.body.textContent).toContain('Before the push only · stops at the runner’s next report');
    expect(document.body.textContent).not.toContain('Stop Landing');
    expect(document.body.textContent).not.toContain('Copy Link');
  });

  it('a lease-expired task landing gives only Abandon and the server’s Retry', async () => {
    view = landing({
      currentAttempt: attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, phase: 'REBASE' }),
    });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    await click(page().querySelector('button[aria-label="More actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).toContain('Abandon');
    expect(document.body.textContent).toContain('Retry');
    expect(document.body.textContent).toContain('Ends this attempt · nothing was pushed');
    expect(document.body.textContent).not.toContain('Stop Landing');
  });

  it('drops Stop Landing once the attempt is past the push boundary', async () => {
    view = landing({ currentAttempt: attempt({ phase: 'PUSH' }) });
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    await click(page().querySelector('button[aria-label="More actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).not.toContain('Stop Landing');
  });

  it('offers Stop Landing before the push, and takes it away after', async () => {
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    const trigger = page().querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    await click(trigger, 'the ⋯ menu');
    expect(document.body.textContent).toContain('Stop Landing');
    expect(document.body.textContent).toContain('Before the push only · nothing pushed yet');
    expect(document.body.textContent).not.toContain('Copy Link');
  });
});

describe('a settled merge round', () => {
  it('draws the outcome head and the tasks now on main', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      settledAt: at(9, 51),
      settledAs: 'MERGED',
      checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 41_000 }],
    });
    mergedRows = [promo()];
    await mount(<LandingSessionView sessionId={SESSION} detail={detail(view)} onOpenCoordinator={() => {}} />);
    expect(page().textContent).toContain('Merged into main');
    expect(page().textContent).toContain('8ed0ea7 · 2 tasks · automatically');
    expect(page().textContent).toContain('Now on main · 2 tasks');
    expect(page().textContent).toContain('Ledger migration order');
    expect(page().textContent).toContain('✓ Passed on the combined tree · 17m 41s');
    expect(page().textContent).toContain('Landed exactly the tested tree 5e5bfca · as a merge commit');
    expect(page().textContent).toContain('This landing is complete — nothing to type here.');
    expect(page().textContent).toContain('The next merge into main opens a new landing (#2).');
    expect(page().textContent).toContain(`Run by Orbit · settled ${landingClockTime(at(9, 51))}`);
  });
});
