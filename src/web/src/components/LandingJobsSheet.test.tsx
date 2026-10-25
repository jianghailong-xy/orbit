// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIntegrationJob, ProjectIntegrationView } from '@orbit/shared';
import { ApiError, api } from '../api';
import { encodeId } from '../lib/idCodec';
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
/** The candidate the merge card is drawn from, or null for a project with none on offer. */
let currentPromotion: Record<string, unknown> | null = null;
let promotionAnswer: () => Promise<unknown> = () => Promise.resolve(undefined);
let abandonAnswer: () => Promise<unknown> = () => Promise.resolve({ abandoned: true });
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
  currentPromotion = null;
  promotionAnswer = () => Promise.resolve(undefined);
  abandonAnswer = () => Promise.resolve({ abandoned: true });
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
    if (path === `/projects/${PROJECT}/promotions/current`) return Promise.resolve(currentPromotion);
    if (path.startsWith(`/projects/${PROJECT}/integration/jobs/`) && path.endsWith('/abandon')) {
      return abandonAnswer();
    }
    if (path.startsWith(`/projects/${PROJECT}/promotions/`) && path.endsWith('/integration/retry')) {
      return promotionAnswer();
    }
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
    // The row wears the merged line's head (owner decision 2026-10-11): the mark, the word, the
    // clock — here the state, because a timed-out job has no clock left that moves — and the
    // state, the wait and the freshness in one line under both.
    expect(c5.querySelector('.landing-head')?.className).toBe('landing-head is-timed-out');
    expect(c5.querySelector('.landing-head-title')?.textContent).toBe('Landing');
    expect(c5.querySelector('.landing-head-right')?.textContent).toBe('Timed out');
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
    for (const text of ['Merge to main', 'queued', '41m 8s']) expect(mergeRow.textContent).toContain(text);
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
    expect(next.querySelector('.landing-head')?.className).toBe('landing-head');
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
  it('opens it from the Work overview’s card', async () => {
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    const press = document.querySelector<HTMLButtonElement>(
      '[data-project-block="work-overview"] button.spl-press');
    expect(press?.getAttribute('type')).toBe('button');
    expect(press?.getAttribute('aria-haspopup')).toBe('dialog');
    // The head counts the jobs, the row each one is in the body, and the lead's own state is the
    // head's — the same read the list under it draws.
    expect(press?.querySelector('.landing-head-title')?.textContent).toBe('Landing 2 jobs · 1 timed out');
    // The rows are the button's SIBLINGS (a link may not live inside one), so the card, not the
    // press, is what holds them: each its job's title and state word — the lead's running one in
    // the brand, the queued one grey — and a merge's row named by its own word.
    const card = document.querySelector('[data-project-block="work-overview"] .session-project-landing');
    expect(card?.querySelector('.spl-jobs')).not.toBeNull();
    expect([...(card?.querySelectorAll('.spl-jobs li') ?? [])].map((row) => [
      row.querySelector('span:first-child')?.textContent, row.querySelector('span:nth-child(2)')?.textContent,
    ])).toEqual([[C5, 'Timed out'], ['Merge to main', 'queued']]);
    expect(dialog()).toBeNull();
    await click(press, 'the Work overview’s landing card');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(rows()).toHaveLength(2);
  });

  it('keeps the Work overview’s card a read from a server that does not list its jobs', async () => {
    integration = view(undefined, job({ timedOut: false }));
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    const card = document.querySelector('[data-project-block="work-overview"] .session-project-landing');
    expect(card).not.toBeNull();
    // Nothing to open, so nothing to press: the same card, as a read.
    expect(card?.querySelector('button.spl-press')).toBeNull();
    expect(card?.querySelector('div.spl-press')).not.toBeNull();
  });

  it('opens it from the merge card’s row while a merge job is in flight', async () => {
    integration = view([merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK', startedAt: instant(NOW - 80_000),
      heartbeatAt: instant(NOW - 5_000), timedOut: false, limitSeconds: 4200 }), job()]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const card = document.querySelector<HTMLElement>('.session-project-merge');
    expect(card?.getAttribute('data-shape')).toBe('checking');
    // The row is the merged line's anatomy (owner decision 2026-10-11): the head, the whole row
    // the press that opens the jobs, and no chevron.
    expect(card!.querySelector('.landing-head.is-running')).not.toBeNull();
    const press = card!.querySelector<HTMLButtonElement>('button.landing-head-press');
    expect(press?.textContent).toContain('Merge check');
    await click(press, 'the merge card’s landing row');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
    expect(rows().map((entry) => entry.getAttribute('data-job'))).toEqual(['job-merge', 'job-c5']);
  });

  it('keeps the merge card’s row a line to read from a server that does not list its jobs', async () => {
    integration = view(undefined, merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false }));
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(document.querySelector('.session-project-merge .landing-head')).not.toBeNull();
    expect(document.querySelector('.landing-head-press')).toBeNull();
  });

  it('turns the WHOLE merge card amber when the server judged the merge job timed out', async () => {
    const check = merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 31 * 60_000), heartbeatAt: instant(NOW - 23 * 60_000),
      timedOut: true, limitSeconds: 600, retryable: false, liveness: 'LEASE_EXPIRED' });
    const read = view([check]);
    integration = { ...read, inFlight: { ...read.inFlight!, liveness: 'LEASE_EXPIRED',
      startedAt: check.startedAt, heartbeatAt: check.heartbeatAt } };
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const card = document.querySelector<HTMLElement>('.session-project-merge');
    expect(card?.getAttribute('data-shape')).toBe('checking');
    // The same rule as the Landing card: the card's border and wash are the warning ones.
    expect(card?.classList.contains('is-timed-out')).toBe(true);
    expect(card?.querySelector('.landing-head.is-timed-out')).not.toBeNull();
  });
});

/**
 * The way into a landing session, in the three places the board puts it (docs/mocks/landing-session/
 * v4/04, owner 2026-10-19 方案 A): said in words on the Landing card and in every row of the jobs
 * list, and as the merge row's own press while a round of merging runs. The presses main already
 * had are unchanged, and a server that names no landing session gets the sentence, not a link.
 */
const LANDING_A = '0195c0de-0000-7000-8000-00000000a001';
const LANDING_B = '0195c0de-0000-7000-8000-00000000a002';
const LANDING_MERGE = '0195c0de-0000-7000-8000-00000000a003';
const landingPath = (id: string): string => `/sessions/${encodeId(id)}`;
const NO_LANDING_PAGE = 'No landing page on this server yet';

/** The candidate the merge card is drawn from, in the state a test gives it. */
function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promotionId: '3fFMHLbE7JTsr3vHFOzIDM',
    state: 'CHECKING',
    sourceKind: 'PROJECT_BRANCH', sourceRef: `project/${PROJECT}`, sourceSha: 'a'.repeat(40),
    upstreamRef: 'main', commitsAhead: 2, filesChanged: 3, taskIds: [], tasks: [],
    checks: [], conflicts: [], upstreamShaChecked: null,
    upstream: { syncedAt: null, conflicts: false },
    landsTreeSha: null, landsAs: null, askedAt: null, recheckedAt: null, recheck: null,
    decidedAt: null, merged: null,
    ...over,
  };
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('.session-project-landing');
const cardFoot = (): HTMLElement | null => document.querySelector<HTMLElement>('.session-project-landing .spl-foot');
const landingLinks = (root: ParentNode | null = document): HTMLAnchorElement[] =>
  [...(root?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    .filter((anchor) => anchor.textContent?.startsWith('Open landing'));
const mergeCard = (): HTMLElement | null => document.querySelector<HTMLElement>('.session-project-merge');

describe('the Landing card’s way into the landing session', () => {
  it('draws one link at the foot of a card holding one job, as a sibling of its press', async () => {
    integration = view([job({ landingSessionId: LANDING_A, timedOut: false, retryable: false })]);
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);

    // The card's one job is the whole body, so its way in is the card's foot.
    expect(card()?.querySelector('.spl-jobs')).toBeNull();
    const [link] = landingLinks(card());
    expect(link?.textContent).toBe('Open landing ›');
    expect(link?.getAttribute('href')).toBe(landingPath(LANDING_A));
    // Nothing pressable inside the card's own press: the link is a SIBLING of the button.
    expect(card()?.querySelectorAll('.spl-press a')).toHaveLength(0);
    expect(cardFoot()?.contains(link!)).toBe(true);
    // The whole card is still the jobs list's press.
    expect(card()?.querySelector('button.spl-press')?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('gives each row of a several-job card its own link, and the merge row none', async () => {
    integration = view([
      job({ landingSessionId: LANDING_A, timedOut: false, retryable: false }),
      merge({ landingSessionId: LANDING_MERGE }),
      job({ jobId: 'job-2', taskId: 'task-2', taskTitle: 'T2', state: 'QUEUED', phase: null,
        landingSessionId: LANDING_B, timedOut: false, retryable: false }),
    ]);
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);

    const rows = [...(card()?.querySelectorAll('.spl-jobs li') ?? [])];
    expect(rows).toHaveLength(3);
    // Each task row carries its own; the merge row carries its word and no way in at all — the
    // merge card is that round's way in.
    expect(landingLinks(rows[0]!).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_A)]);
    expect(rows[1]!.textContent).toContain('Merge to main');
    expect(landingLinks(rows[1]!)).toEqual([]);
    expect(landingLinks(rows[2]!).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_B)]);
    // One per row, and none at the card's foot: a card of several hands each job its own. The
    // foot itself is still there — it is what opens the list ("All jobs ›").
    expect(landingLinks(cardFoot())).toEqual([]);
    expect(cardFoot()?.textContent).toContain('All jobs ›');
    expect(card()?.querySelectorAll('.spl-press a')).toHaveLength(0);
  });

  it('writes the grey sentence where a server names no landing session', async () => {
    integration = view([job({ landingSessionId: null, timedOut: false, retryable: false })]);
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    expect(landingLinks(card())).toEqual([]);
    expect(card()?.querySelector('.spl-foot .is-none')?.textContent).toBe(NO_LANDING_PAGE);
  });

  it('opens the landing from the card without opening the jobs list', async () => {
    integration = view([job({ landingSessionId: LANDING_A, timedOut: false, retryable: false })]);
    await mount(<ProjectPanoramaHeader projectId={PROJECT} projectStatus="OPEN" />);
    await click(landingLinks(card())[0], 'the card’s Open landing');
    expect(location).toBe(landingPath(LANDING_A));
    expect(dialog()).toBeNull();
  });
});

describe('the jobs list’s way into each job’s landing session', () => {
  it('draws a link on every row that names one, the grey sentence where none is named, and the merge row’s only way in', async () => {
    integration = view([
      job({ landingSessionId: LANDING_A }),
      job({ jobId: 'job-2', taskId: 'task-2', taskTitle: 'T2', state: 'QUEUED', phase: null,
        landingSessionId: null, timedOut: false, retryable: false }),
      merge({ landingSessionId: LANDING_MERGE }),
    ]);
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);

    expect(landingLinks(row('job-c5')).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_A)]);
    // A server that names none: the sentence in the same slot, and nothing to press.
    expect(landingLinks(row('job-2'))).toEqual([]);
    expect(row('job-2')?.querySelector('.landing-jobs-slot .is-none')?.textContent).toBe(NO_LANDING_PAGE);
    // The merge row is no press of its own — this link is the only way in it has.
    const mergeRow = row('job-merge')!;
    expect(mergeRow.querySelector('a.landing-jobs-open')).toBeNull();
    expect(landingLinks(mergeRow).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_MERGE)]);
    // The row's link and its Retry are siblings: nothing pressable inside anything pressable.
    expect(document.querySelectorAll('.landing-jobs a button, .landing-jobs button a, .landing-jobs a a'))
      .toHaveLength(0);
  });

  it('opens the landing from a row instead of the task', async () => {
    integration = view([
      job({ landingSessionId: LANDING_A }),
      merge({ landingSessionId: LANDING_MERGE }),
    ]);
    await mount(<LandingJobsSheet projectId={PROJECT} open onClose={() => {}} />);
    await click(landingLinks(row('job-c5'))[0], 'C5’s Open landing');
    expect(location).toBe(landingPath(LANDING_A));
    await click(landingLinks(row('job-merge'))[0], 'the merge row’s Open landing');
    expect(location).toBe(landingPath(LANDING_MERGE));
  });
});

describe('the merge card’s own way into the round', () => {
  it('opens this round’s landing session from the merge row while it is checking', async () => {
    currentPromotion = candidate({ landingSessionId: LANDING_MERGE });
    integration = view([merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false }),
    job()]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const press = mergeCard()?.querySelector<HTMLAnchorElement>('a.landing-head-press');
    expect(press?.getAttribute('href')).toBe(landingPath(LANDING_MERGE));
    expect(press?.textContent).toContain('Merge check');
    await click(press, 'the merge row');
    expect(location).toBe(landingPath(LANDING_MERGE));
    expect(dialog()).toBeNull();
  });

  it('takes the round’s session from the merge job when the candidate names none', async () => {
    currentPromotion = candidate();
    integration = view([merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false,
      landingSessionId: LANDING_MERGE }), job()]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.querySelector<HTMLAnchorElement>('a.landing-head-press')?.getAttribute('href'))
      .toBe(landingPath(LANDING_MERGE));
  });

  it('keeps main’s press — the jobs list — when the server names no session', async () => {
    currentPromotion = candidate();
    integration = view([merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false }), job()]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.querySelector('a.landing-head-press')).toBeNull();
    const press = mergeCard()?.querySelector<HTMLButtonElement>('button.landing-head-press');
    await click(press, 'the merge row');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight');
  });

  it('counts the jobs beside the merge and opens the list from its foot', async () => {
    currentPromotion = candidate({ landingSessionId: LANDING_MERGE });
    integration = {
      ...view([
        merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
          startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000), timedOut: false }),
        job(),
        job({ jobId: 'job-3', taskId: 'task-3', taskTitle: 'T3', state: 'QUEUED', phase: null,
          timedOut: false, retryable: false }),
      ]),
    };
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.querySelector('.session-project-merge-queued')?.textContent).toBe('+2 jobs queued');
    const allJobs = [...(mergeCard()?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'All jobs ›');
    await click(allJobs, 'All jobs ›');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('3 jobs in flight');
  });

  it('offers the round’s landing beside Details while the confirmed merge is queued', async () => {
    currentPromotion = candidate({ state: 'CONFIRMED', landingSessionId: LANDING_MERGE,
      execution: { state: 'QUEUED', phase: null, startedAt: instant(NOW - 60_000) } });
    integration = view([merge({ state: 'QUEUED', phase: null, landingSessionId: LANDING_MERGE })]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.getAttribute('data-shape')).toBe('merging');
    expect(mergeCard()?.textContent).toContain('Merge into main queued');
    expect(landingLinks(mergeCard()).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_MERGE)]);
    expect(mergeCard()?.textContent).toContain('Cancel');
  });

  it('says a merge is being cancelled, and stops offering Cancel', async () => {
    currentPromotion = candidate({ state: 'CONFIRMED', cancelRequested: true, landingSessionId: LANDING_MERGE,
      execution: { state: 'RUNNING', phase: 'CHECK', startedAt: instant(NOW - 200_000) } });
    integration = view([merge({ state: 'RUNNING', phase: 'CHECK', landingSessionId: LANDING_MERGE,
      heartbeatAt: instant(NOW - 5_000), timedOut: false })]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const text = mergeCard()?.textContent ?? '';
    expect(text).toContain('Cancelling the merge…');
    expect(text).toContain('Stops at the runner’s next report, within 30 s · nothing has been pushed');
    expect(text).toContain('Cancel requested');
    const cancel = [...(mergeCard()?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'Cancel requested');
    expect(cancel?.hasAttribute('disabled')).toBe(true);
    expect(landingLinks(mergeCard()).map((anchor) => anchor.getAttribute('href')))
      .toEqual([landingPath(LANDING_MERGE)]);
  });

  it('says a cancel came too late when the push boundary is passed', async () => {
    currentPromotion = candidate({ state: 'CONFIRMED', cancelRequested: true,
      pushBoundaryPassed: true, landingSessionId: LANDING_MERGE,
      execution: { state: 'RUNNING', phase: 'PUSH', startedAt: instant(NOW - 200_000) } });
    integration = view([merge({ state: 'RUNNING', phase: 'PUSH', landingSessionId: LANDING_MERGE,
      heartbeatAt: instant(NOW - 5_000), timedOut: false })]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.textContent).toContain('Too late to cancel — the push has started');
  });

  it('offers Re-run the check and Abandon on a timed-out check, and neither on a timed-out merge', async () => {
    const timedOutCheck = merge({ kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK',
      startedAt: instant(NOW - 31 * 60_000), heartbeatAt: instant(NOW - 23 * 60_000),
      timedOut: true, limitSeconds: 600, retryable: false, landingSessionId: LANDING_MERGE });
    currentPromotion = candidate({ landingSessionId: LANDING_MERGE });
    integration = view([timedOutCheck]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    const checkCard = mergeCard()!;
    expect(checkCard.classList.contains('is-timed-out')).toBe(true);
    expect(checkCard.querySelector('.session-project-merge-rerun')?.textContent).toBe('Re-run the check');
    const abandon = checkCard.querySelector<HTMLButtonElement>('.session-project-merge-abandon');
    expect(abandon?.textContent).toBe('Abandon');
    // The row still opens the round's landing, timeout or not.
    expect(checkCard.querySelector<HTMLAnchorElement>('a.landing-head-press')?.getAttribute('href'))
      .toBe(landingPath(LANDING_MERGE));

    // The re-check is the candidate's own door; the abandon is the job's (J-T10).
    await click(checkCard.querySelector('.session-project-merge-rerun'), 'Re-run the check');
    expect(api).toHaveBeenCalledWith(
      `/projects/${encodeURIComponent(PROJECT)}/promotions/${encodeURIComponent('3fFMHLbE7JTsr3vHFOzIDM')}/integration/retry`,
      { method: 'POST', body: { reason: 'Re-run the timed-out check from the merge card.' } },
    );
    await click(abandon, 'Abandon');
    expect(api).toHaveBeenCalledWith(
      `/projects/${PROJECT}/integration/jobs/job-merge/abandon`, { method: 'POST' },
    );
    await settle();
    expect(checkCard.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers only Abandon on a timed-out merge to main', async () => {
    const timedOutMerge = merge({ state: 'RUNNING', phase: 'PUSH',
      startedAt: instant(NOW - 30 * 60_000), heartbeatAt: instant(NOW - 25 * 60_000),
      timedOut: true, limitSeconds: 600, landingSessionId: LANDING_MERGE });
    currentPromotion = candidate({ state: 'CONFIRMED', landingSessionId: LANDING_MERGE,
      execution: { state: 'RUNNING', phase: 'PUSH', startedAt: instant(NOW - 30 * 60_000) } });
    integration = view([timedOutMerge]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.classList.contains('is-timed-out')).toBe(true);
    expect(mergeCard()?.querySelector('.session-project-merge-rerun')).toBeNull();
    expect(mergeCard()?.querySelector('.session-project-merge-abandon')?.textContent).toBe('Abandon');
  });

  it('adds no way into the landing when the round is blocked — that row is the Landings group’s', async () => {
    currentPromotion = candidate({ state: 'BLOCKED', landingSessionId: LANDING_MERGE });
    integration = view([merge({ state: 'QUEUED', phase: null })]);
    await mount(<ProjectMergeStrip projectId={PROJECT} onOpenCoordinator={null} />);
    expect(mergeCard()?.getAttribute('data-shape')).toBe('blocked');
    expect(landingLinks(mergeCard())).toEqual([]);
    expect(mergeCard()?.textContent).not.toContain('Open landing');
  });
});
