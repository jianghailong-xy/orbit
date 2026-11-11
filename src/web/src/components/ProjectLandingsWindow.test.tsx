// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IntegrationTimelineEntry,
  ProjectPromotionView,
  SessionLandingAttempt,
  SessionLandingView,
} from '@orbit/shared';
import { api, getSession, type SessionDetail } from '../api';
import { landingClockTime } from './ProjectPanoramaHeader';
import { ProjectLandingsWindow } from './ProjectLandingsWindow';

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
  retryable: false,
  pushBoundaryPassed: false,
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
/** The project's other landings, as its LANDING rows list them; `view`'s own row is added from it. */
let otherRows: Array<Record<string, unknown>> = [];
/** Their views, read when a row is opened. */
let otherViews: Record<string, SessionLandingView> = {};
let awaiting = false;
let mergedRows: ProjectPromotionView[] = [];
let currentPromotion: ProjectPromotionView | null = null;
/** What the project's coordinator read answers: a project may have none. */
let coordinatorStatus: unknown = coordinator;
let sessionAnswer: () => Promise<unknown> = () => Promise.resolve(detail(view));
let retryAnswer: () => Promise<unknown> = () => Promise.resolve({});
let logAnswer: () => Promise<unknown> = () => Promise.resolve({ jobId: 'job-1', entries: [], nextCursor: null });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let opened: string | null = null;
let openedSession: string | null = null;
/** Every api() call the page made, with its options: the presses' bodies are what the owner routes read. */
let calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The landing's own row on the project's list (`includeLanding=1`): its summary, from its view. */
function ownRow(): Record<string, unknown> {
  return {
    id: SESSION,
    sessionKind: 'LANDING',
    title: view.subject === 'PROMOTION' ? 'Merge project/p1 → main · #1' : 'Land · Ledger migration order',
    createdAt: view.openedAt,
    lastTurnAt: view.openedAt,
    lifecycleState: view.settledAt ? 'COMPLETED' : 'OPEN',
    landing: {
      subject: view.subject,
      state: view.settledAt ? 'SETTLED' : awaiting ? 'AWAITING_DECISION' : 'IN_FLIGHT',
      settledAs: view.settledAs,
      settledAt: view.settledAt,
    },
  };
}

/** Every row the project's two list reads answer, by view. */
function listRows(viewName: string): Array<Record<string, unknown>> {
  return [ownRow(), ...otherRows].filter((row) => (row.lifecycleState === 'COMPLETED') === (viewName === 'completed'));
}

/** The window, opened on this landing (a landing id's route) unless told otherwise. */
function windowOn(focusId: string | null = SESSION): ReactNode {
  return <ProjectLandingsWindow projectId={PROJECT} focusId={focusId} onOpenSession={(id) => { openedSession = id; }} />;
}

async function mount(node: ReactNode = windowOn()): Promise<void> {
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

/** Opens every folded step of every landing drawn open, so each of the server's lines is on screen. */
/** Opens every folded attempt and every folded step of every landing, so each of the server's lines is on screen. */
async function openSteps(): Promise<void> {
  for (;;) {
    const folded = page().querySelector<HTMLButtonElement>('.landings-window-steps-line[aria-expanded="false"]')
      ?? page().querySelector<HTMLButtonElement>('.landing-step-row[aria-expanded="false"]');
    if (!folded) return;
    await click(folded, 'a folded attempt or step');
  }
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
  otherRows = [];
  otherViews = {};
  awaiting = false;
  openedSession = null;
  mergedRows = [];
  currentPromotion = null;
  coordinatorStatus = coordinator;
  sessionAnswer = () => Promise.resolve(detail(view));
  retryAnswer = () => Promise.resolve({});
  logAnswer = () => Promise.resolve({ jobId: 'job-1', entries: [], nextCursor: null });
  opened = null;
  calls = [];
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(((id: string) => {
    calls.push({ path: `getSession:${id}` });
    if (id !== SESSION) {
      const other = otherViews[id];
      return other ? Promise.resolve({ ...detail(other), id, title: String(otherRows.find((row) => row.id === id)?.title) })
        : Promise.reject(new Error('not found'));
    }
    return sessionAnswer();
  }) as never);
  vi.mocked(api).mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
    opened = path;
    calls.push({ path, options });
    if (path.startsWith('/sessions?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      expect(query.get('projectId')).toBe(PROJECT);
      expect(query.get('includeLanding')).toBe('1');
      return Promise.resolve(listRows(query.get('view') ?? 'open'));
    }
    if (path === `/projects/${PROJECT}`) return Promise.resolve({ id: PROJECT, title: 'Wiki server' });
    if (path === `/projects/${PROJECT}/integration`) return Promise.resolve(integration);
    if (path === `/projects/${PROJECT}/coordinator/status`) return Promise.resolve(coordinatorStatus);
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

describe('a landing in the window', () => {
  it('draws the window’s head, the landing’s card and its record, and the read-only footer', async () => {
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
                data: { state: 'CHECK_FAILED' }, text: 'Check failed · nothing was pushed',
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
                actor: { type: 'RUNNER' }, reason: null,
                data: {
                  name: 'MERGE_CHECK', index: 1, exitCode: 0, expectedExitCode: 0, timedOut: false,
                  durationMs: 1_022_000,
                },
                text: 'Merge check passed · 17m 02s',
              },
            ],
          },
        ],
        facts: [],
        truncated: false,
      },
    });
    await mount();

    // The window's own head: Landings over the project's name (the footer says Orbit runs them).
    expect(page().querySelector('.landing-page-title')?.textContent).toBe('Landings');
    expect(page().querySelector('.landing-page-sub')?.textContent).toBe('Wiki server');
    // The landing is a turn under Now: the chat's Working for head, and its reply names the task in bold.
    expect(page().querySelector('.landings-window-now .landings-window-day-head')?.textContent).toBe('Now');
    expect(page().querySelector('.landings-window-now .landings-window-reply strong')?.textContent).toBe('Ledger migration order');
    expect(page().textContent).toContain('Landing');
    // The live row carries its green dot; the budget bar marks where the check USUALLY finishes.
    expect(page().querySelector('.landing-live-dot')).toBeTruthy();
    expect(page().querySelector('.landing-card-meter-tick')).toBeTruthy();
    // The check in hand says its name and how long it has been live.
    expect(page().textContent).toContain('Merge check · live 1m 50s');
    expect(page().textContent).toContain('checking');
    expect(page().textContent).toContain('Output 6s ago · Updated just now');
    // The timeline: every generation, every claim, round, takeover and hand-back — each step opened.
    await openSteps();
    expect(page().textContent).toContain('Generation 1');
    expect(page().textContent).toContain('Generation 2');
    expect(page().textContent).toContain('Task marked done · queued to land on project/p1');
    expect(page().textContent).toContain('Check failed · nothing was pushed');
    expect(page().textContent).toContain('Claimed by runner wikova · claim 2');
    expect(page().textContent).toContain('Round 1');
    expect(page().textContent).toContain('Taken over by a new process on runner wikova · claim 2');
    expect(page().textContent).toContain('Handed back by runner wikova · claim 2');
    expect(page().textContent).toContain('Merge check passed · 17m 02s');
    // The marks carry the status (05 a/e/i): queued ≡, in hand ↻, done ✓, failed ✗, takeover ↗,
    // hand-back ↩ — not a neutral dot/ring/triangle. Each line sits in its step: generation 2's claim,
    // takeover and hand-back under Claim, its round under Sync, its check under Merge check.
    const marks = [...page().querySelectorAll<HTMLElement>('.landing-timeline-glyph')]
      .map((mark) => `${mark.textContent}:${mark.className.replace('landing-timeline-glyph ', '')}`);
    expect(marks).toEqual([
      '≡:is-queued', '✗:is-failed',
      '↻:is-running', '↗:is-takeover', '↩:is-queued', '↻:is-running', '✓:is-ok',
    ]);
    expect([...page().querySelectorAll('.landing-step .chat-tool-name')].map((name) => name.textContent))
      .toEqual(['Queue', 'Claim', 'Sync', 'Merge check']);
    // The footer is one plain line with nothing to type into: a lock and the sentence's first half (the
    // whole sentence for a screen reader), and the door to who decides at the end
    // (docs/mocks/landings-ui-polish ③).
    const foot = page().querySelector('.landing-page-foot')!;
    const line = foot.querySelector('.landing-page-foot-line')!;
    expect(line.querySelector('.anticon-lock')).not.toBeNull();
    expect(line.querySelector('.landing-page-foot-words')?.textContent).toBe('Orbit runs these landings');
    expect(line.querySelector('.sr-only')?.textContent).toBe('Orbit runs these landings — nothing to type here.');
    const door = foot.querySelector<HTMLButtonElement>('button.landing-page-foot-open')!;
    expect(door.textContent).toBe('Open coordinator');
    expect(door.getAttribute('title')).toBe('Decisions: the coordinator');
    expect(door.querySelector('.anticon-user')).not.toBeNull();
    expect(foot.querySelector('input, textarea, [contenteditable]')).toBeNull();
    await click(door, 'Open coordinator');
    expect(openedSession).toBe('coord-1');
    // No conversation anatomy: no composer, no model, no rename, no share.
    expect(page().querySelector('textarea')).toBeNull();
    expect(page().querySelector('.composer-model-chip')).toBeNull();
    expect(page().querySelector('.workspace-name-input')).toBeNull();
    expect(page().querySelector('.session-shared-pill')).toBeNull();
  });

  it('opens a check’s output from its line', async () => {
    view = landing({
      currentAttempt: attempt({ state: 'CHECK_FAILED' }),
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
            actor: { type: 'RUNNER' }, reason: null,
            data: { exitCode: 1, expectedExitCode: 0, timedOut: false },
            text: 'Merge check failed · exit 1 · 3m 52s',
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
    await mount();
    // A failed check shows the tail it died on inline (05 g), and its Log › still opens the page.
    expect(page().querySelector('.landing-live-output')?.textContent)
      .toContain('FAIL  server-execution > runs on the server');
    await click(button('Log ›'), 'the log press');
    expect(opened).toContain(`/sessions/${SESSION}/landing/log?jobId=job-1&claim=1&round=1&check=1`);
    expect(page().textContent).toContain('FAIL  server-execution > runs on the server');
    await click(button('Log ›'), 'the log press again');
    expect(page().querySelector('.landing-log')).toBeNull();
  });

  it('marks a check or result line by its fields: the wording changed, the ✓ did not', async () => {
    const line = (
      id: string,
      kind: 'CHECK_FINISHED' | 'RESULT' | 'RESULT_FALLBACK',
      text: string,
      data: Record<string, unknown> | null,
      check: number | null = null,
    ): IntegrationTimelineEntry => ({
      id, seq: Number(id.slice(1)), kind, at: at(14, 58), claim: 1, round: 1,
      check: check == null ? null : { name: 'MERGE_CHECK', index: check }, phase: 'CHECK',
      step: null, actor: { type: 'RUNNER' }, reason: null, data, text,
    });
    view = landing({
      currentAttempt: attempt({ state: 'CHECK_FAILED' }),
      timeline: {
        sections: [{
          title: 'Generation 1',
          jobId: 'job-1',
          kind: 'LAND_TASK',
          generation: 1,
          state: 'CHECK_FAILED',
          entries: [
            line('r1', 'CHECK_FINISHED', 'Merge check green · 17m 02s',
              { exitCode: 0, expectedExitCode: 0, timedOut: false }, 1),
            line('r2', 'CHECK_FINISHED', 'Merge check passed · 3m 52s',
              { exitCode: 1, expectedExitCode: 0, timedOut: false }, 2),
            line('r3', 'CHECK_FINISHED', 'Merge check passed · 1m 10s', null, 3),
            line('r4', 'RESULT', 'Put on main · 8ed0ea7', { state: 'LANDED' }),
            line('r5', 'RESULT', 'Ready to merge into fix/passed-x', { state: 'READY' }),
            line('r6', 'RESULT_FALLBACK', 'Landed on main · 8ed0ea7', null),
          ],
        }],
        facts: [], truncated: false,
      },
    });
    logAnswer = () => Promise.resolve({
      jobId: 'job-1',
      entries: [{
        jobId: 'job-1', claim: 1, round: 1, check: { name: 'MERGE_CHECK', index: 2 },
        seq: 0, text: 'FAIL  server-execution > runs on the server', truncatedBytes: 0, at: at(14, 58),
      }],
      nextCursor: null,
    });
    await mount();
    const marks = [...page().querySelectorAll<HTMLElement>('.landing-timeline-glyph')]
      .map((mark) => `${mark.textContent}:${mark.className.replace('landing-timeline-glyph ', '')}`);
    expect(marks).toEqual([
      '✓:is-ok', '✗:is-failed', '✗:is-failed', '✓:is-ok', '✗:is-failed', '✗:is-failed',
    ]);
    // Only the checks that did not pass read their tail inline (05 g); the reworded pass stays one line.
    const inline = calls
      .map((call) => call.path)
      .filter((path) => path.startsWith(`/sessions/${SESSION}/landing/log?`))
      .map((path) => new URLSearchParams(path.split('?')[1]).get('check'));
    expect(inline.sort()).toEqual(['2', '3']);
    expect(page().querySelectorAll('.landing-live-output')).toHaveLength(2);
  });

  it('a merge check that ends READY draws ✓; a merge to main that answers READY keeps its ✗', async () => {
    const line = (id: string, kind: 'CHECK_FINISHED' | 'RESULT', text: string, data: Record<string, unknown>,
      check: number | null = null): IntegrationTimelineEntry => ({
      id, seq: Number(id.slice(1)), kind, at: at(14, 58), claim: 1, round: 1,
      check: check == null ? null : { name: 'MERGE_CHECK', index: check }, phase: 'CHECK',
      step: null, actor: { type: 'RUNNER' }, reason: null, data, text,
    });
    const passed = { exitCode: 0, expectedExitCode: 0, timedOut: false };
    // The round as it goes: checked and ready, handed back by a merge whose main moved, checked again.
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({ jobId: 'job-3', kind: 'CHECK_PROMOTION', state: 'READY', check: null }),
      timeline: {
        sections: [{
          title: 'Merge check · 1', jobId: 'job-1', kind: 'CHECK_PROMOTION', generation: 1, state: 'READY',
          entries: [
            line('r1', 'CHECK_FINISHED', 'Merge check passed · 17m 02s', passed, 1),
            line('r2', 'RESULT', 'Ready to merge into main', { state: 'READY' }),
          ],
        }, {
          title: 'Merge to main · 1', jobId: 'job-2', kind: 'LAND_PROMOTION', generation: 1, state: 'READY',
          entries: [line('r3', 'RESULT', 'Ready to merge into main', { state: 'READY' })],
        }, {
          title: 'Merge check · 2', jobId: 'job-3', kind: 'CHECK_PROMOTION', generation: 2, state: 'READY',
          entries: [
            line('r4', 'CHECK_FINISHED', 'Merge check passed · 16m 40s', passed, 1),
            line('r5', 'RESULT', 'Ready to merge into main', { state: 'READY' }),
          ],
        }],
        facts: [], truncated: false,
      },
    });
    await mount();
    await openSteps();
    const marks = (job: string) => [
      ...page().querySelectorAll<HTMLElement>(`section[data-job="${job}"] .landing-timeline-glyph`),
    ].map((mark) => `${mark.textContent}:${mark.className.replace('landing-timeline-glyph ', '')}`);
    expect(marks('job-1')).toEqual(['✓:is-ok', '✓:is-ok']);
    expect(marks('job-2')).toEqual(['✗:is-failed']);
    expect(marks('job-3')).toEqual(['✓:is-ok', '✓:is-ok']);
  });

  it('a merge check that ended READY writes no Stopped · not landed on its card', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'CHECK_PROMOTION', state: 'READY', phase: null, check: null, liveness: null }),
    });
    await mount();
    const card = page().querySelector('.landings-window-card')!;
    expect(card.textContent).toContain('Passed the check · waiting for the owner');
    expect(card.textContent).not.toContain('Stopped · not landed');
    expect(card.querySelectorAll('.landing-card-line')).toHaveLength(0);
    // The round's word leads its name in the reply.
    expect(page().querySelector('.landings-window-reply strong')?.textContent).toMatch(/^Merge check · /u);
  });

  it('a cancelled landing really stopped, and its card still says so', async () => {
    view = landing({ currentAttempt: attempt({ state: 'CANCELLED', phase: null, check: null, liveness: null }) });
    await mount();
    // The reply says it stopped; the status card under it does not repeat the sentence.
    expect(page().querySelector('.landings-window-reply')?.textContent).toMatch(/^Did not land .+: stopped · not landed\.$/u);
    const card = page().querySelector('.landings-window-card')!;
    expect(card.querySelectorAll('.landing-card-line')).toHaveLength(0);
    // A stop is not a failure: the card keeps the quiet mark, not the red ✕.
    expect(card.classList.contains('is-failed')).toBe(false);
    expect(card.querySelector('.landings-window-status-icon.is-failed')).toBeNull();
  });
});

describe('the check in hand', () => {
  it('streams the running check’s tail inline, and its Log still opens a finished one', async () => {
    view = landing({
      timeline: {
        sections: [{
          title: 'Generation 2', jobId: 'job-1', kind: 'LAND_TASK', generation: 2, state: 'RUNNING',
          entries: [{
            id: 'c1', seq: 1, kind: 'CLAIMED', at: at(14, 56), claim: 1, round: 1,
            check: null, phase: 'FETCH', step: null, actor: { type: 'RUNNER' }, reason: null,
            data: null, text: 'Claimed by runner wikova · claim 1',
          }, {
            id: 'c2', seq: 2, kind: 'CHECK_STARTED', at: at(14, 56, 40), claim: 1, round: 1,
            check: { name: 'MERGE_CHECK', index: 1 }, phase: 'CHECK', step: null,
            actor: { type: 'RUNNER' }, reason: null, data: null,
            text: 'Merge check started · claim 1 · wikova',
          }],
        }],
        facts: [], truncated: false,
      },
    });
    logAnswer = () => Promise.resolve({
      jobId: 'job-1',
      entries: [
        { jobId: 'job-1', claim: 1, round: 1, check: { name: 'MERGE_CHECK', index: 1 }, seq: 0,
          text: '$ npm run build && npm test -w @orbit/apiserver\n ✔ wiki-daily-limit.spec.ts\n', truncatedBytes: 0, at: at(14, 58) },
        { jobId: 'job-1', claim: 1, round: 1, check: { name: 'MERGE_CHECK', index: 1 }, seq: 1,
          text: ' ✔ wiki-dossier-pages.spec.ts\n ▶ project-integration-line.spec.ts\n', truncatedBytes: 0, at: at(14, 58, 10) },
      ],
      nextCursor: null,
    });
    await mount();
    expect(page().textContent).toContain('Merge check · live 1m 50s');
    const block = page().querySelector('.landing-live-output');
    expect(block?.textContent).toContain('$ npm run build && npm test -w @orbit/apiserver');
    expect(block?.textContent).toContain('▶ project-integration-line.spec.ts');
  });
});

describe('a timed-out landing', () => {
  it('draws the server’s Timed out head, the claim line and J12’s nothing-pushed sentence', async () => {
    view = landing({
      currentAttempt: attempt({
        phase: 'REBASE', liveness: 'LEASE_EXPIRED', timedOut: true, retryable: true,
        heartbeatAt: at(14, 35, 30),
      }),
      timeline: {
        sections: [{
          title: 'Generation 2', jobId: 'job-1', kind: 'LAND_TASK', generation: 2, state: 'RUNNING',
          entries: [{
            id: 't1', seq: 1, kind: 'STEP', at: at(14, 34), claim: 1, round: 1,
            check: null, phase: 'FETCH', step: null, actor: { type: 'RUNNER' }, reason: null,
            data: null, text: 'Fetched · synced main',
          }, {
            id: 't2', seq: 2, kind: 'STEP', at: at(14, 35), claim: 1, round: 1,
            check: null, phase: 'REBASE', step: null, actor: { type: 'RUNNER' }, reason: null,
            data: null, text: 'Rebasing onto project/p1',
          }],
        }],
        facts: [], truncated: false,
      },
    });
    await mount();
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

  it('a merge check offers Re-run the check, and writes no push sentence', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({
        kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true,
      }),
    });
    await mount();
    // The facts line says where the runner was; the push sentence is not written for a check
    // (owner 2026-10-19: "检查作业超时不写推送一句").
    expect(page().textContent).not.toContain('A check pushes nothing');
    expect(page().textContent).not.toContain('main is as it was');
    expect(page().textContent).toContain('stopped at');
    expect(button('Re-run the check')).toBeTruthy();
    expect(button('Abandon')).toBeTruthy();
    expect(button('Retry')).toBeNull();
  });

  it('records a reason with Re-run the check, which the owner route requires', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      currentAttempt: attempt({
        kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true,
      }),
    });
    await mount();
    await click(button('Re-run the check'), 'Re-run the check');
    // RetryIntegrationDto.reason is @MinLength(1): a bodyless press is refused before the queue sees it.
    const press = calls.find((call) => call.path.endsWith('/promotions/promo-1/integration/retry'));
    expect(press?.options).toEqual({
      method: 'POST',
      body: { reason: 'Re-run the timed-out check from the landing page.' },
    });
  });
});

describe('a read this device cannot make', () => {
  it('freezes the card at Update unavailable and opens no door', async () => {
    view = landing({
      currentAttempt: attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, retryable: true }),
    });
    sessionAnswer = () => Promise.reject(new Error('network down'));
    await mount();
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
              data: { state: 'LANDED' }, text: 'Landed on main · 8ed0ea7',
            }],
          },
        ],
        facts: [], truncated: false,
      },
    });
    await mount();
    await openSteps();
    // A round's sections are its check and its merge, each named by the server's title on its steps line.
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
    await mount();
    await click(page().querySelector('button[aria-label="Landing actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).toContain('Review Card');
    expect(document.body.textContent).toContain('Cancel Merge');
    expect(document.body.textContent).toContain('Before the push only · stops at the runner’s next report');
    expect(document.body.textContent).not.toContain('Stop Landing');
    expect(document.body.textContent).not.toContain('Copy Link');
  });

  it('a lease-expired task landing gives only Abandon and the server’s Retry', async () => {
    view = landing({
      currentAttempt: attempt({
        liveness: 'LEASE_EXPIRED', timedOut: true, retryable: true, phase: 'REBASE',
      }),
    });
    await mount();
    await click(page().querySelector('button[aria-label="Landing actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).toContain('Abandon');
    expect(document.body.textContent).toContain('Retry');
    expect(document.body.textContent).toContain('Ends this attempt · nothing was pushed');
    expect(document.body.textContent).not.toContain('Stop Landing');
  });

  it('drops Stop Landing once the attempt is past the push boundary', async () => {
    view = landing({ currentAttempt: attempt({ phase: 'PUSH', pushBoundaryPassed: true }) });
    await mount();
    await click(page().querySelector('button[aria-label="Landing actions"]'), 'the ⋯ menu');
    expect(document.body.textContent).not.toContain('Stop Landing');
  });

  it('offers Stop Landing before the push, and takes it away after', async () => {
    await mount();
    const trigger = page().querySelector<HTMLButtonElement>('button[aria-label="Landing actions"]');
    await click(trigger, 'the ⋯ menu');
    expect(document.body.textContent).toContain('Stop Landing');
    expect(document.body.textContent).toContain('Before the push only · nothing pushed yet');
    expect(document.body.textContent).not.toContain('Copy Link');
  });
});

describe('a settled merge round', () => {
  it('is one Merged into main row that opens to its receipt and its own record', async () => {
    view = landing({
      subject: 'PROMOTION',
      taskId: null,
      promotionId: 'promo-1',
      settledAt: at(9, 51),
      settledAs: 'MERGED',
      currentAttempt: attempt({ kind: 'LAND_PROMOTION', state: 'LANDED', phase: null, check: null, liveness: null }),
      timeline: {
        sections: [{
          title: 'Merge check · 1', jobId: 'job-0', kind: 'CHECK_PROMOTION', generation: 1, state: 'READY',
          entries: [{
            id: 'm1', seq: 1, kind: 'CHECK_FINISHED', at: at(9, 50), claim: 1, round: 1,
            check: { name: 'MERGE_CHECK', index: 1 }, phase: 'CHECK', step: null, actor: { type: 'RUNNER' },
            reason: null, data: { exitCode: 0, expectedExitCode: 0, timedOut: false },
            text: 'Merge check passed · 17m 41s',
          }],
        }],
        facts: [{ kind: 'PROMOTION_STATE', text: 'Merge round · merged', data: null }],
        truncated: false,
      },
      checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 41_000 }],
    });
    mergedRows = [promo({ landingSessionId: SESSION })];
    await mount();
    // One turn, not a session's and a merge's: the record and the round, joined by landingSessionId. Its reply says what
    // merged, from the round's merged record (docs/mocks/landings-chat-turns).
    const rows = [...page().querySelectorAll<HTMLElement>('.landings-window-reply')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('Merged 2 tasks into main · 8ed0ea7 · automatically.');
    expect([...rows[0].querySelectorAll('strong, code')].map((part) => part.textContent)).toEqual(['2 tasks', '8ed0ea7']);
    expect(page().querySelector(`[data-landing-entry="${SESSION}"] .chat-time`)?.textContent).toBe(landingClockTime(at(9, 51)));
    // Opened on it: the receipt under the reply, with the round's own steps above it.
    expect(rows[0].getAttribute('aria-expanded')).toBe('true');
    expect(rows[0].querySelector('.landings-window-record')).toBeNull();
    const record = page().querySelector('.landings-window-record')!;
    expect(record.parentElement?.getAttribute('data-landing-entry')).toBe(SESSION);
    expect(record.querySelector('.landings-window-receipt')?.textContent).toBe([
      'Now on main · 2 tasks', 'Ledger migration order', 'Payout retry budget',
      '✓ Passed on the combined tree · 17m 41s', 'Landed exactly the tested tree 5e5bfca · as a merge commit',
    ].join(''));
    // One attempt: its steps line is `1 step`, open, and its check is a step whose row says how it ended.
    expect(page().querySelector(`[data-landing-entry="${SESSION}"] .landings-window-steps-line`)?.textContent).toBe('1 step');
    // The sentence comes first and the steps under it, as the chat says what it does before its tool calls.
    const turn = page().querySelector(`[data-landing-entry="${SESSION}"]`)!;
    expect(turn.querySelector('.landings-window-reply')!.compareDocumentPosition(turn.querySelector('.landings-window-steps-line')!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page().querySelector(`[data-landing-entry="${SESSION}"] .landing-step[data-step="check:MERGE_CHECK"] .chat-tool-summary`)?.textContent)
      .toBe('Merge check passed · 17m 41s');
    // The round's state is said by its row; the board does not repeat it as a timeline fact.
    expect(page().textContent).not.toContain('Merge round · merged');
    // Pressing the row closes it.
    await click(rows[0], 'the merge row');
    expect(page().querySelector('.landings-window-record')).toBeNull();
  });
});

describe('the window', () => {
  const settledRow = (id: string, title: string, settledAs: string, settledAt: string, subject = 'TASK') => ({
    id, sessionKind: 'LANDING', title, createdAt: settledAt, lastTurnAt: settledAt, lifecycleState: 'COMPLETED',
    landing: { subject, state: 'SETTLED', settledAs, settledAt },
  });
  const yesterday = (hour: number, minute: number): string => new Date(2026, 8, 24, hour, minute).toISOString();

  it('groups the settled landings by day above Now, oldest first, one row each', async () => {
    otherRows = [
      settledRow('landed-yesterday', 'Land · Wiki review link', 'LANDED', yesterday(18, 10)),
      settledRow('nothing-today', 'Land · Fix the deep link', 'NOTHING_TO_LAND', at(8, 30)),
      settledRow('landed-today', 'Land · Runner model order', 'LANDED', at(10, 2)),
    ];
    await mount(windowOn(null));
    const days = [...page().querySelectorAll<HTMLElement>('.landings-window-day')].map((day) => [
      day.querySelector('.landings-window-day-head')?.textContent,
      [...day.querySelectorAll('.landings-window-reply strong')].map((title) => title.textContent),
    ]);
    expect(days).toEqual([
      ['Yesterday', ['Wiki review link']],
      ['Today', ['Fix the deep link', 'Runner model order']],
      ['Now', ['Ledger migration order']],
    ]);
    const today = [...page().querySelectorAll<HTMLElement>('.landings-window-day')][1];
    // Each turn's reply says how it ended (before its record is read, in the row's own words), and its foot says when.
    expect([...today.querySelectorAll('.landings-window-reply')].map((reply) => reply.textContent))
      .toEqual(['Nothing to land Fix the deep link.', 'Landed Runner model order.']);
    expect([...today.querySelectorAll('.chat-time')].map((time) => time.textContent))
      .toEqual([landingClockTime(at(8, 30)), landingClockTime(at(10, 2))]);
    // Opened from the Landings row, no settled landing is opened and nothing is outlined (a landing that runs keeps its
    // steps open, as the chat keeps the turn in hand).
    expect(page().querySelector('.landings-window-turn:not(.is-card) .landings-window-record')).toBeNull();
    expect(page().querySelector('.is-outlined')).toBeNull();
  });

  // In a browser a line also reads its record when it first comes into view; jsdom has no
  // IntersectionObserver, so here only the press reads it.
  it('reads a settled row’s record only when it is opened, and opens it in place', async () => {
    otherRows = [settledRow('landed-today', 'Land · Runner model order', 'LANDED', at(10, 2))];
    otherViews = {
      'landed-today': landing({
        sessionId: 'landed-today', settledAt: at(10, 2), settledAs: 'LANDED',
        currentAttempt: attempt({ state: 'LANDED', sourceSessionId: 'source-9' }),
        timeline: {
          sections: [{
            title: 'Generation 1', jobId: 'job-9', kind: 'LAND_TASK', generation: 1, state: 'LANDED',
            entries: [{
              id: 'x1', seq: 1, kind: 'RESULT', at: at(10, 2), claim: 1, round: 1, check: null, phase: 'PUSH',
              step: null, actor: { type: 'RUNNER' }, reason: null, data: { state: 'LANDED' },
              text: 'Landed on project/p1 · 9c2e7d1',
            }],
          }],
          facts: [], truncated: false,
        },
      }),
    };
    await mount(windowOn(null));
    expect(calls.some((call) => call.path === 'getSession:landed-today')).toBe(false);
    const row = page().querySelector<HTMLElement>('[data-landing-entry="landed-today"] .landings-window-reply');
    await click(row, 'the settled row');
    expect(calls.filter((call) => call.path === 'getSession:landed-today')).toHaveLength(1);
    const entry = page().querySelector('[data-landing-entry="landed-today"]')!;
    const record = entry.querySelector('.landings-window-record')!;
    // Its one line is the Push step's own summary; the reply, once read, says where it landed.
    expect(entry.querySelector('.landing-step[data-step="push"] .chat-tool-name')?.textContent).toBe('Push');
    expect(entry.querySelector('.landing-step[data-step="push"] .chat-tool-summary')?.textContent)
      .toBe('Landed on project/p1 · 9c2e7d1');
    expect(entry.querySelector('.landings-window-reply')?.textContent).toMatch(/^Landed Runner model order( on .+)?\.$/u);
    // A task segment's record ends in its two ways out.
    expect([...record.querySelectorAll('.landings-window-links button')].map((link) => link.textContent))
      .toEqual(['Open Task ›', 'Open Source Session ›']);
  });

  it('opens a merge older than landing sessions to its receipt alone', async () => {
    mergedRows = [promo({ promotionId: 'promo-old', landingSessionId: null, merged: {
      sha: '3f1c2a9000000000000000000000000000000000', at: at(9, 51), automatic: false, byUserId: 'u1',
    } })];
    await mount(windowOn(null));
    const row = page().querySelector<HTMLElement>('[data-landing-entry="merge:promo-old"] .landings-window-reply');
    expect(row?.textContent).toBe('Merged 2 tasks into main · 3f1c2a9 · by you.');
    await click(row, 'the old merge');
    const record = page().querySelector('[data-landing-entry="merge:promo-old"] .landings-window-record')!;
    expect(record.querySelector('.landings-window-receipt')?.textContent).toContain('Now on main · 2 tasks');
    expect(record.querySelector('.landing-timeline')).toBeNull();
    expect(calls.some((call) => call.path.startsWith('getSession:merge'))).toBe(false);
  });

  it('opens a row’s menu on a right-click, with the old page’s ⋯ rows', async () => {
    otherRows = [settledRow('landed-today', 'Land · Runner model order', 'LANDED', at(10, 2))];
    otherViews = { 'landed-today': landing({ sessionId: 'landed-today', settledAt: at(10, 2), settledAs: 'LANDED',
      currentAttempt: attempt({ state: 'LANDED' }) }) };
    await mount(windowOn(null));
    const entry = page().querySelector<HTMLElement>('[data-landing-entry="landed-today"]')!;
    await act(async () => {
      entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await settle();
    const menu = [...document.querySelectorAll<HTMLElement>('.orbit-menu-item')].map((item) => item.textContent);
    expect(menu).toEqual(['Open Task', 'Open Source Session', 'Open Coordinator']);
  });

  it('gives a landing that waits for a decision its doors to the people who decide', async () => {
    awaiting = true;
    view = landing({
      currentAttempt: attempt({ state: 'CHECK_FAILED', phase: null, check: null, liveness: null }),
      checks: [{ name: 'MERGE_CHECK', exitCode: 1, expectedExitCode: 0, timedOut: false, durationMs: 232_000 }],
    });
    await mount();
    // The reply says it did not land; under it, the chat's status card in the failure's red, with who decides and the
    // doors (docs/mocks/landings-chat-turns d).
    expect(page().querySelector(`[data-landing-entry="${SESSION}"] .landings-window-reply`)?.textContent).toMatch(/^Did not land /u);
    const card = page().querySelector('.landings-window-card')!;
    expect(card.classList.contains('is-failed')).toBe(true);
    expect(card.querySelector('.landings-window-status-icon.is-failed')).not.toBeNull();
    expect(card.querySelector('.landings-window-status-title')?.textContent).toBe('Not landed · waiting for a decision');
    expect(card.textContent).toContain('checks failed · exit 1 after 3m 52s');
    expect(card.querySelector('.landings-window-wait-line')?.textContent).toBe('Decisions: the coordinator');
    expect([...card.querySelectorAll('.landings-window-wait .landing-card-actions button')].map((door) => door.textContent))
      .toEqual(['Open Coordinator', 'Open Task']);
    await click(button('Open Coordinator'), 'Open Coordinator');
    expect(openedSession).toBe('coord-1');
  });

  it('outlines the landing it was opened on for a moment, opened', async () => {
    await mount();
    const entry = page().querySelector<HTMLElement>(`[data-landing-entry="${SESSION}"]`)!;
    expect(entry.className).toContain('is-outlined');
    expect(entry.className).toContain('is-open');
    expect(entry.querySelector('.landings-window-reply')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    expect(entry.className).not.toContain('is-outlined');
    expect(entry.className).toContain('is-open');
  });

  it('keeps the window’s own ⋯ to the coordinator and the project', async () => {
    await mount();
    await click(page().querySelector('.landings-window-head button[aria-label="More actions"]'), 'the window ⋯');
    expect([...document.querySelectorAll<HTMLElement>('.orbit-menu-item')].map((item) => item.textContent))
      .toEqual(['Open Coordinator', 'Open Project']);
  });

  it('draws what Orbit sent close together as one group, with no avatar, under the day’s chip', async () => {
    otherRows = [
      settledRow('t1', 'Land · T1 install.sh: keep one orbit binary per account', 'LANDED', yesterday(22, 11)),
      settledRow('round-1', 'Merge project/p1 → main · #1', 'MERGED', yesterday(22, 13), 'PROMOTION'),
      settledRow('t2', 'Land · T2 host setup refuses a binary it did not install', 'LANDED', yesterday(23, 7)),
      settledRow('t3', 'Land · T3 sudo hints name the binary’s real path', 'LANDED', at(0, 19)),
    ];
    await mount(windowOn(null));
    const groups = (day: Element) => [...day.querySelectorAll(':scope > .landings-window-group')].map((group) => {
      // Only the column the messages stand in: every message here is Orbit's, so no avatar.
      expect([...group.children].map((part) => part.getAttribute('class'))).toEqual(['landings-window-column']);
      return [...group.querySelectorAll('[data-landing-entry]')].map((entry) => entry.getAttribute('data-landing-entry'));
    });
    const [yesterdaySection, todaySection, nowSection] = [...page().querySelectorAll('.landings-window-day')];
    expect(yesterdaySection.querySelector('.landings-window-day-head')?.textContent).toBe('Yesterday');
    expect(groups(yesterdaySection)).toEqual([['t1', 'round-1'], ['t2']]);
    expect(todaySection.querySelector('.landings-window-day-head')?.textContent).toBe('Today');
    expect(groups(todaySection)).toEqual([['t3']]);
    // What is in hand is one group of its own under Now.
    expect(nowSection.querySelector('.landings-window-day-head')?.textContent).toBe('Now');
    expect(groups(nowSection)).toEqual([[SESSION]]);
    expect(nowSection.querySelector('.landings-window-column .landings-window-turn.is-card')).not.toBeNull();
    expect(page().querySelector('.landings-window-avatar')).toBeNull();
    // A reply names the task whole, in bold.
    expect(page().querySelector('[data-landing-entry="t3"] .landings-window-reply strong')?.textContent)
      .toBe('T3 sudo hints name the binary’s real path');
  });

  it('says so when the project has had no landing, and only once it knows', async () => {
    coordinatorStatus = { coordination: null, readAt: at(14, 58) };
    let mergesAnswer: (rows: ProjectPromotionView[]) => void = () => {};
    const merges = new Promise<ProjectPromotionView[]>((resolve) => { mergesAnswer = resolve; });
    vi.mocked(api).mockImplementation(((path: string) => {
      if (path.startsWith('/sessions?')) return Promise.resolve([]);
      if (path === `/projects/${PROJECT}`) return Promise.resolve({ id: PROJECT, title: 'Wiki server' });
      if (path === `/projects/${PROJECT}/coordinator/status`) return Promise.resolve(coordinatorStatus);
      if (path === `/projects/${PROJECT}/promotions/merged`) return merges;
      return Promise.resolve({});
    }) as never);
    await mount(windowOn(null));
    const note = (): string | null => page().querySelector('.landings-window-body .landing-page-note')?.textContent ?? null;
    // A merge older than landing sessions is a landing too, and that read has not answered yet.
    expect(note()).toBeNull();
    await act(async () => mergesAnswer([]));
    await settle();
    expect(note()).toBe('No landings yet');
    // The window's own head and footer stand around it.
    expect(page().querySelector('.landing-page-title')?.textContent).toBe('Landings');
    expect(page().querySelector('.landing-page-foot-line .sr-only')?.textContent).toBe('Orbit runs these landings — nothing to type here.');
  });

  it('draws no such note beside a landing', async () => {
    await mount(windowOn(null));
    expect(page().querySelector('[data-landing-entry]')).not.toBeNull();
    expect(page().textContent).not.toContain('No landings yet');
  });

  it('keeps the footer’s words with no door at all when the project has no coordinator', async () => {
    coordinatorStatus = { coordination: null, readAt: at(14, 58) };
    await mount();
    const foot = page().querySelector('.landing-page-foot')!;
    expect(foot.querySelector('.landing-page-foot-line .sr-only')?.textContent).toBe('Orbit runs these landings — nothing to type here.');
    expect(foot.querySelector('button')).toBeNull();
  });

  /**
   * What jsdom cannot lay out, read from the stylesheet: a landing is the chat's background-job line,
   * its steps the chat's tool rows, hung under it off its mark (docs/mocks/landings-chat-tools); the
   * outline is the line's; and the footer is one plain line on the window's bottom edge
   * (docs/mocks/landings-ui-polish).
   */
  it('draws the turn, its steps and the footer with the shapes the board gives them', () => {
    const found = ['src/index.css', 'src/web/src/index.css'].map((each) => resolve(process.cwd(), each)).find(existsSync);
    if (found === undefined) throw new Error(`no index.css from ${process.cwd()}`);
    const css = readFileSync(found, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    const rule = (selector: string): string => {
      const match = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.()]/gu, '\\$&')}\\s*\\{([^{}]*)\\}`, 'u').exec(css);
      if (match === null) throw new Error(`no rule for "${selector}" in index.css`);
      return match[1];
    };
    const value = (body: string, property: string): string | undefined =>
      new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`, 'u').exec(body)?.[1].trim().replace(/\s+/gu, ' ');

    // A landing is a chat turn (docs/mocks/landings-chat-turns): the chat's own steps lines, tool rows, reply and turn foot;
    // the window adds only what makes them buttons, and draws no line, bubble, avatar or time chip of its own.
    for (const gone of ['.landings-window-row', '.landings-window-event', '.landings-window-avatar', '.landings-window-line',
      '.landing-step-time']) {
      expect(css, gone).not.toContain(gone);
    }
    expect(value(rule('.landings-window-steps-line'), 'background')).toBe('transparent');
    expect(value(rule('.landing-step-row'), 'background')).toBe('transparent');
    expect(value(rule('.landings-window-reply'), 'cursor')).toBe('pointer');
    expect(value(rule('.landings-window-entry.is-outlined .landings-window-reply'), 'box-shadow')).toBe('inset 2px 0 0 var(--brand)');
    // A press leaves no focus box round the sentence.
    expect(value(rule('.landings-window-reply:focus'), 'outline')).toBe('none');
    // What a reply opens to is inset like the reply, as the chat's text is.
    expect(value(rule('.landings-window-record'), 'margin')).toBe('6px 12px 0');

    expect(value(rule('.landings-window-day-head'), 'border-radius')).toBe('999px');
    expect(value(rule('.landings-window-now .landings-window-day-head'), 'color')).toBe('var(--brand)');

    const foot = rule('.landing-page-foot');
    expect(value(foot, 'border-top')).toBe('1px solid var(--border)');
    expect(foot).not.toMatch(/border-radius|box-shadow/u);
    expect(value(rule('.landing-page-foot-line'), 'white-space')).toBe('nowrap');
  });
});
