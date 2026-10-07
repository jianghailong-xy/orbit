// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIntegrationJob, ProjectIntegrationView } from '@orbit/shared';
import { ApiError, api } from '../api';
import { projectTaskPath } from '../lib/projectTaskRoute';
import { MOBILE_QUERY } from '../lib/useMediaQuery';
import { LandingJobsSheet } from './LandingJobsSheet';
import { ProjectMergeStrip } from './ProjectMergeStrip';
import { ProjectPanoramaHeader } from './ProjectPanoramaHeader';

// The list's reads and its one write go through `api`, answered below by path; ApiError stays real
// so a refusal arrives the way the server's does.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const PROJECT = '3CuIHiSJZBQ7nLVUwc7ekz';
const RETRY_PATH = `/projects/${encodeURIComponent(PROJECT)}/integration/jobs/${encodeURIComponent('job-c5')}/retry`;

/**
 * The screen the list was specified against (docs/mocks/landing-jobs-sheet, 21:57): C5, claimed at
 * 20:07 by a runner that never reported, and the merge into main queued behind it. Local instants:
 * the detail line reads them on the reader's own clock.
 */
const CLAIMED = new Date(2026, 8, 25, 20, 7, 4).getTime();
const NOW = new Date(2026, 8, 25, 21, 57, 30).getTime();
const C5 = 'C5 · 登录后开通默认托管 runner 与 workspace';
const instant = (ms: number) => new Date(ms).toISOString();

const job = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => ({
  jobId: 'job-c5', kind: 'LAND_TASK', state: 'RUNNING', phase: 'FETCH', taskId: 'task-c5', taskTitle: C5,
  generation: 1, startedAt: instant(CLAIMED), queuedAt: instant(CLAIMED - 60_000), heartbeatAt: null,
  runnerName: 'workstation-gpu', retriedBy: null, timedOut: true, limitSeconds: 600, retryable: true,
  ...over,
});
const merge = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => job({
  jobId: 'job-merge', kind: 'LAND_PROMOTION', state: 'QUEUED', phase: null, taskId: null, taskTitle: null,
  startedAt: instant(NOW - (41 * 60 + 8) * 1000), queuedAt: instant(NOW - (41 * 60 + 8) * 1000),
  runnerName: null, timedOut: false, limitSeconds: null, retryable: false,
  ...over,
});
/** C5 after the owner's Retry at 22:15: its second generation, queued. */
const retried = job({
  jobId: 'job-c5-2', state: 'QUEUED', phase: null, generation: 2, startedAt: instant(NOW), queuedAt: instant(NOW),
  runnerName: null, retriedBy: 'OWNER', timedOut: false, limitSeconds: null, retryable: false,
});

/** `GET /projects/:id/integration` from a server that lists its jobs; `inFlight` is the first. */
function view(jobs: ProjectIntegrationJob[] | undefined, lead: ProjectIntegrationJob | undefined = jobs?.[0]): ProjectIntegrationView {
  return {
    line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: `project/${PROJECT}`, upstreamRef: 'main',
    source: 'EXPLICIT', locked: true, startedAt: instant(CLAIMED - 3_600_000),
    mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null, mergeCheckTimeoutSeconds: 900,
    escalationSeconds: 3600, commitsAheadOfUpstream: 1, commitsAheadOfUpstreamAbsentReason: null,
    lastUpstreamSyncAt: null, lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
    integratingCount: (jobs ?? (lead ? [lead] : [])).filter((entry) => entry.state === 'RUNNING').length,
    queuedCount: (jobs ?? []).filter((entry) => entry.state === 'QUEUED').length,
    mergeCheckOnTip: 'PASSING',
    inFlight: lead ? {
      taskTitle: lead.taskTitle, kind: lead.kind, phase: lead.phase, state: lead.state,
      startedAt: lead.startedAt, heartbeatAt: lead.heartbeatAt,
    } : null,
    ...(jobs ? { inFlightJobs: jobs } : {}),
  };
}

let integration: ProjectIntegrationView = view([job(), merge()]);
/** What the retry door answers: the fresh view, or a refusal. */
let retryAnswer: () => Promise<unknown> = () => Promise.resolve(view([retried, merge()]));
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let location = '';

function LocationProbe() {
  const at = useLocation();
  location = at.pathname;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReactNode): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project', PROJECT, 'integration'], integration);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
          {node}
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return client;
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('.landing-jobs-dialog');
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.landing-jobs-row')];
const row = (jobId: string): HTMLElement | null => document.querySelector<HTMLElement>(`.landing-jobs-row[data-job="${jobId}"]`);
const retryButton = (jobId: string): HTMLButtonElement | null =>
  [...(row(jobId)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent === 'Retry') ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Only the clock is fixed: the timers React, Base UI and the queries run on stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  integration = view([job(), merge()]);
  retryAnswer = () => Promise.resolve(view([retried, merge()]));
  location = '';
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(((path: string, options?: { method?: string }) => {
    if (path === RETRY_PATH && options?.method === 'POST') {
      return retryAnswer().then((answer) => {
        integration = answer as ProjectIntegrationView;
        return answer;
      });
    }
    if (path === `/projects/${PROJECT}/integration`) return Promise.resolve(integration);
    if (path === `/projects/${PROJECT}/promotions/current`) return Promise.resolve(null);
    if (path === `/projects/${PROJECT}/panorama`) return Promise.resolve({
      buckets: { running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 7, failed: 2, cancelled: 0 },
      shape: { taskCount: 17, edgeCount: 20, ratio: 20 / 17, maxDepth: 6, form: 'chain' },
    });
    // Nothing else these surfaces read decides what they draw: left unanswered.
    return new Promise(() => {});
  }) as unknown as typeof api);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the list of jobs in flight', () => {
  it('draws every job as the landing row itself, the first being the one the row outside describes', async () => {
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(rows().map((entry) => entry.getAttribute('data-job'))).toEqual(['job-c5', 'job-merge']);

    const c5 = row('job-c5')!;
    expect(c5.querySelector('.project-landing')?.className).toBe('project-landing project-landing-timed-out');
    for (const text of ['Landing', 'Timed out', C5, 'No report for', '110m', 'limit 10m']) {
      expect(c5.textContent).toContain(text);
    }
    expect(c5.querySelector('.landing-jobs-detail')?.textContent)
      .toBe('Runner workstation-gpu took it at 20:07 · stopped at fetching · no push recorded');
    // The task's row opens the task: a real link, with a chevron.
    const link = c5.querySelector<HTMLAnchorElement>('a.landing-jobs-open')!;
    expect(link.getAttribute('href')).toBe(projectTaskPath(PROJECT, 'task-c5'));
    expect(link.querySelector('.landing-jobs-chev')).not.toBeNull();
    expect(retryButton('job-c5')).not.toBeNull();

    // The merge into main lands no task: word, state and wait alone, nothing to press, no chevron.
    const mergeRow = row('job-merge')!;
    for (const text of ['Merge to main', 'queued', 'Queued for', '41m 8s']) expect(mergeRow.textContent).toContain(text);
    expect(mergeRow.querySelector('a')).toBeNull();
    expect(mergeRow.querySelector('.landing-jobs-chev')).toBeNull();
    expect(mergeRow.querySelector('button')).toBeNull();

    // The link and Retry are siblings: nothing pressable inside anything pressable.
    expect(document.querySelectorAll('.landing-jobs a button, .landing-jobs button a, .landing-jobs button button, .landing-jobs a a'))
      .toHaveLength(0);
  });

  it('opens a task’s page from its row, and gets out of the way', async () => {
    const onClose = vi.fn();
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={onClose} />);
    await click(row('job-c5')?.querySelector('a.landing-jobs-open'), 'C5’s row');
    expect(location).toBe(projectTaskPath(PROJECT, 'task-c5'));
    expect(onClose).toHaveBeenCalled();
  });

  it('posts Retry to the job’s own door, and redraws from the view it answers', async () => {
    let answer: (value: unknown) => void = () => {};
    retryAnswer = () => new Promise((resolve) => { answer = resolve; });
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);

    await click(retryButton('job-c5'), 'Retry');
    expect(api).toHaveBeenCalledWith(RETRY_PATH, { method: 'POST' });
    // Held while the request is out: a second press sends nothing.
    expect(retryButton('job-c5')?.getAttribute('aria-disabled')).toBe('true');
    await click(retryButton('job-c5'), 'Retry, again');
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === RETRY_PATH)).toHaveLength(1);

    await act(async () => answer(view([retried, merge()])));
    await settle();
    expect(rows().map((entry) => entry.getAttribute('data-job'))).toEqual(['job-c5-2', 'job-merge']);
    const next = row('job-c5-2')!;
    expect(next.querySelector('.project-landing')?.className).toBe('project-landing');
    expect(next.textContent).toContain('queued');
    expect(next.querySelector('.landing-jobs-detail')?.textContent).toBe('Generation 2 · retried by you at 21:57');
    expect(retryButton('job-c5-2')).toBeNull();
  });

  it('says a refused retry in the row it was pressed in', async () => {
    retryAnswer = () => Promise.reject(
      new ApiError('This landing is no longer running', 409, 'INTEGRATION_RETRY_NOT_APPLICABLE'),
    );
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);
    await click(retryButton('job-c5'), 'Retry');
    const alert = row('job-c5')?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Retry failed — This landing is no longer running.');
    expect(row('job-merge')?.querySelector('[role="alert"]')).toBeNull();
    // The press is offered again.
    expect(retryButton('job-c5')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('offers no Retry where the server does not take one, timed out or not', async () => {
    integration = view([job({ retryable: false }), merge()]);
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);
    expect(row('job-c5')?.textContent).toContain('Timed out');
    expect(row('job-c5')?.querySelector('.landing-jobs-detail')).not.toBeNull();
    expect(document.querySelector('.landing-jobs button')).toBeNull();
  });

  it('rises from the bottom on a narrow screen', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === MOBILE_QUERY, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);
    const sheet = document.querySelector<HTMLElement>('.landing-jobs-sheet');
    expect(sheet?.getAttribute('data-placement')).toBe('bottom');
    expect(sheet?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(dialog()).toBeNull();
  });
});

describe('the landing rows that open the list', () => {
  it('opens it from the Work overview’s row', async () => {
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    const press = document.querySelector<HTMLButtonElement>('[data-project-block="work-overview"] button.project-landing-press');
    expect(press?.getAttribute('type')).toBe('button');
    expect(press?.textContent).toContain('2 jobs · 1 timed out');
    expect(dialog()).toBeNull();
    await click(press, 'the Work overview’s landing row');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(rows()).toHaveLength(2);
  });

  it('keeps the Work overview’s row a line to read from a server that does not list its jobs', async () => {
    integration = view(undefined, job({ timedOut: false }));
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    expect(document.querySelector('[data-project-block="work-overview"] .project-landing')).not.toBeNull();
    expect(document.querySelector('.project-landing-press')).toBeNull();
  });

  it('opens it from the merge card’s row while a merge job is in flight', async () => {
    integration = view([merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK', startedAt: instant(NOW - 80_000),
      heartbeatAt: instant(NOW - 5_000), timedOut: false, limitSeconds: 4200 }), job()]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const card = document.querySelector<HTMLElement>('.session-project-merge');
    expect(card?.getAttribute('data-shape')).toBe('checking');
    const press = card!.querySelector<HTMLButtonElement>('button.project-landing-press');
    expect(press?.textContent).toContain('Merge check');
    await click(press, 'the merge card’s landing row');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(rows().map((entry) => entry.getAttribute('data-job'))).toEqual(['job-merge', 'job-c5']);
  });

  it('keeps the merge card’s row a line to read from a server that does not list its jobs', async () => {
    integration = view(undefined, merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false }));
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(document.querySelector('.session-project-merge .project-landing')).not.toBeNull();
    expect(document.querySelector('.project-landing-press')).toBeNull();
  });
});
