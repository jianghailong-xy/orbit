import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectIntegrationInFlight,
  ProjectIntegrationJob,
  ProjectIntegrationView,
  ProjectLandTask,
} from '@orbit/shared';
import {
  JOB_PHASES,
  JOB_WORDS,
  PANORAMA_BUCKETS,
  ProjectPanoramaHeader,
  ProjectPanoramaCard,
  integrationLanes,
  jobPhases,
  jobWords,
  landingCard,
  landingClock,
  landingClockTime,
  landingJobLines,
  landingHead,
  landingJobsCount,
  landingJobsTitle,
  landingLimit,
  landingLine,
  landingRoundClause,
  type ProjectPanorama,
} from './ProjectPanoramaHeader';

// react-query never dispatches a fetch during a static (effect-free) render, so these tests seed
// the cache instead of letting a request run — the same arrangement ProjectsPage.test.tsx uses.
// The stub is the backstop that would make an accidental live call visible as a failure rather
// than a hang, and the source-level endpoint check below is what fixes the two URLs.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const source = readFileSync(fileURLToPath(new URL('./ProjectPanoramaHeader.tsx', import.meta.url)), 'utf8');

// The short public id spelling the project page carries — this component never encodes anything,
// it just puts what it is handed in the path.
const PROJECT = '3CuIHiSJZBQ7nLVUwc7ekz';

// Both keys spelled out rather than imported from the component: a key the component changes
// unilaterally has to break these tests, which it cannot do if both sides read one constant.
const panoramaKey = ['project', PROJECT, 'panorama'];

function newClient() {
  // refetchOnMount/retryOnMount:false keep a seeded entry (success OR error) from being treated as
  // needing a fresh fetch on this mount — these assertions are about what is already in cache.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

function render(qc: QueryClient, projectStatus?: 'OPEN' | 'DONE' | 'CANCELLED') {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectPanoramaHeader projectId={PROJECT} projectStatus={projectStatus} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The deployment's own numbers, from the report this card was specified against. */
const panorama = (over: Partial<ProjectPanorama['buckets']> = {}, shape: Partial<ProjectPanorama['shape']> = {}): ProjectPanorama => ({
  buckets: {
    running: 0,
    ready: 4,
    blocked: 30,
    awaitingVerification: 0,
    done: 5,
    failed: 0,
    cancelled: 0,
    ...over,
  },
  shape: { taskCount: 39, edgeCount: 41, ratio: 41 / 39, maxDepth: 12, form: 'chain', ...shape },
});

/** Every `<svg data-glyph=…>` in the markup, in document order, with its own inner geometry. */
function glyphs(html: string): string[] {
  return [...html.matchAll(/<svg[^>]*data-glyph="[^"]*"[\s\S]*?<\/svg>/g)].map((m) => m[0]);
}

/** The value of one attribute on the meter's element. */
function meterAttr(html: string, attr: string): string | undefined {
  const meter = html.match(/<div[^>]*role="img"[^>]*>/)?.[0];
  return meter?.match(new RegExp(`${attr}="([^"]*)"`))?.[1];
}

describe('ProjectPanoramaHeader', () => {

  it('reports Ready and Blocked as two separate readable buckets, never one OPEN count', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    const html = render(qc);

    // Every bucket's own label, as text...
    for (const label of [
      'Running',
      'Ready',
      // What the lane is CALLED, since contract §7.2 V6: the number counts tasks waiting on a
      // prerequisite, which is not the same claim as "blocked" — nobody has to do anything about
      // most of them.
      'Waiting',
      'Awaiting verification',
      'Done',
      'Failed',
      'Cancelled',
    ]) expect(html).toContain(label);
    // ...and every number, as visible text in its cell rather than only inside the meter's label.
    const cells = [...html.matchAll(/font-size:28px[^"]*">(\d+)<\/div>/g)].map((m) => m[1]);
    expect(cells).toEqual(['0', '4', '30', '0', '5', '0', '0']);

    // The whole point of the card: 4 and 30 are two numbers, and the 34 that today's `OPEN` tally
    // would report in their place appears nowhere.
    expect(html).not.toContain('OPEN');
    expect(cells).not.toContain('34');
    // Each number says what it counts, so "4" is not a bare figure the reader has to interpret.
    expect(html).toContain('can start now');
    expect(html).toContain('waiting on dependencies');
    expect(html).toContain('13% complete'); // 5 of 39 tasks
  });

  it('does not raise the banner when something is running, however much is ready', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama({ running: 2 }));
    const html = render(qc);

    expect(html).not.toContain('Dispatch needs attention');
    expect(html).not.toContain('Check providers');
    // ...and the Ready cell drops its amber with it: nothing on this card is asking for attention.
    expect(html).not.toContain('var(--warning-bg)');
    expect(render(newClient())).not.toContain('Dispatch needs attention');
  });

  it('separates every exhaustive bucket by shape, not by colour alone', () => {
    const qc = newClient();
    // Something is running so the dispatch banner does not add its own triangle to this assertion
    // about the four bucket marks.
    qc.setQueryData(panoramaKey, panorama({ running: 2 }));
    const html = render(qc);

    const marks = glyphs(html);
    expect(marks).toHaveLength(7);
    // Pairwise distinct as whole marks — a repeated shape in a different colour would collapse here.
    expect(new Set(marks).size).toBe(7);
    // ...and distinct in the shape channel specifically, which is what survives CVD and greyscale.
    const shapes = marks.map((mark) => mark.match(/data-glyph="([^"]*)"/)![1]);
    expect(shapes).toEqual(['disc', 'triangle', 'square', 'hourglass', 'check', 'cross', 'slash']);
    // The geometry backs each name: a filled disc, a right-pointing triangle, a HOLLOW square
    // (stroked, not filled — the one pair that could otherwise read alike at 12px), and a check.
    expect(marks[0]).toContain('<circle');
    expect(marks[1]).toContain('<polygon');
    expect(marks[2]).toMatch(/<rect[^>]*fill="none"/);
    for (const mark of marks.slice(3)) expect(mark).toContain('<path');

    // Colour is a SECOND channel and the tokens are the measured ones: Done wears --success (not
    // --success-solid, ΔE 2.4 from amber under protanopia) and Blocked wears a neutral.
    expect(PANORAMA_BUCKETS.map((bucket) => bucket.color)).toEqual([
      'var(--brand)',
      'var(--warning-solid)',
      'var(--text-3)',
      'var(--brand)',
      'var(--success)',
      'var(--error)',
      'var(--text-4)',
    ]);
    expect(new Set(PANORAMA_BUCKETS.map((bucket) => bucket.glyph)).size).toBe(7);
    // Each bucket's accessible name is its own word, so the four cells never rely on the swatch.
    expect(new Set(PANORAMA_BUCKETS.map((bucket) => bucket.label)).size).toBe(7);
  });

  it('gives the meter a role and an aria-label carrying all four numbers', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    const html = render(qc);

    expect(meterAttr(html, 'role')).toBe('img');
    expect(meterAttr(html, 'aria-label')).toBe(
      'Task status: 0 running, 4 ready, 30 waiting, 0 awaiting verification, 5 done, 0 failed, 0 cancelled',
    );

    // The segments are in proportion, and the empty bucket has no sliver: a hairline of colour for
    // zero is exactly the value this card exists to make visible.
    const flex = [...html.matchAll(/flex:(\d+(?:\.\d+)?)[^"]*;background:var\(--(brand|warning-solid|text-3|success)\)/g)];
    expect(flex.map((m) => [m[2], m[1]])).toEqual([
      ['text-3', '4'],
      ['text-3', '30'],
      ['success', '5'],
    ]);
    // ...and the bar is still rounded at its two outer ends only.
    expect(html).toContain('border-radius:4px 2px 2px 4px');
    expect(html).toContain('border-radius:2px 4px 4px 2px');
  });

  it('renders an empty project as an empty track rather than a broken bar', () => {
    const qc = newClient();
    qc.setQueryData(
      panoramaKey,
      panorama({ running: 0, ready: 0, blocked: 0, done: 0 }, { taskCount: 0, edgeCount: 0, ratio: 0, maxDepth: 0 }),
    );
    const html = render(qc);

    expect(meterAttr(html, 'aria-label')).toBe(
      'Task status: 0 running, 0 ready, 0 waiting, 0 awaiting verification, 0 done, 0 failed, 0 cancelled',
    );
    expect(html).toContain('var(--fill-muted)');
    expect(html).toContain('no tasks yet'); // not "NaN% of 0"
    expect(html).not.toContain('NaN');
  });

  it('explains the legitimate all-settled-but-still-open wrapping-up state', () => {
    const qc = newClient();
    qc.setQueryData(
      panoramaKey,
      panorama(
        { running: 0, ready: 0, blocked: 0, done: 9, cancelled: 0 },
        { taskCount: 9, edgeCount: 10 },
      ),
    );

    const open = render(qc, 'OPEN');
    expect(open).toContain('Ready to wrap up');
    expect(open).toContain('All 9 tasks are settled');
    expect(open).toContain('project stays open');
    expect(render(qc, 'DONE')).not.toContain('Ready to wrap up');
  });

  it.each(['integrating', 'onIntegrationLine'] as const)('does not offer wrap-up with work still in %s', (lane) => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama({
      running: 0, ready: 0, blocked: 0, done: 1,
      integrating: 0, onIntegrationLine: 0, onUpstream: 0, [lane]: 1,
    }));
    expect(render(qc, 'OPEN')).not.toContain('Ready to wrap up');
  });

  it('does not offer wrap-up while a promotion job is in flight', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama({ ready: 0, blocked: 0, done: 1 }));
    qc.setQueryData(integrationKey, integration());
    expect(render(qc, 'OPEN')).not.toContain('Ready to wrap up');
  });

  it('describes pending receipts without claiming checks are running, and counts only actual landing waits', () => {
    const lanes = integrationLanes(panorama({
      blocked: 17, waitingForLanding: 1, integrating: 1,
    }).buckets, 'PROJECT_BRANCH');
    expect(lanes.find((lane) => lane.key === 'blocked')?.footnote)
      .toBe('1 waiting for a prerequisite to land');
    expect(lanes.find((lane) => lane.key === 'integrating')).toMatchObject({
      label: 'Pending landing', value: 1, footnote: 'no landing receipt yet', glyph: 'hourglass',
    });
  });

  it('renders the loading and error states, and neither throws', () => {
    // Loading: nothing seeded, so the query is pending with its fetch not yet dispatched.
    const loading = render(newClient());
    expect(loading).toContain('Work overview');
    expect(loading).toContain('<span role="status" aria-label="Loading"');
    expect(loading).not.toContain('could not be loaded');
  });

  it('shows the panorama failure with a Retry, and says so instead of showing zeroes', async () => {
    const qc = newClient();
    await qc.prefetchQuery({ queryKey: panoramaKey, queryFn: () => Promise.reject(new Error('network down')) });
    const html = render(qc);

    expect(html).toContain('Project panorama could not be loaded');
    expect(html).toContain('network down');
    expect(html).toContain('Retry');
    // A failed read must not be drawn as a project with no work in it: no meter, no buckets.
    expect(meterAttr(html, 'aria-label')).toBeUndefined();
    expect(html).not.toContain('Running');
  });
});

// The read behind the landing row, spelled out rather than imported from the component: a key the
// component changes unilaterally has to break these tests.
const integrationKey = ['project', PROJECT, 'integration'];

/**
 * `GET /projects/:id/integration`, as the card reads it. Every field the shared declaration carries,
 * because the row is drawn from the same payload the page's own line row is — a stub with only
 * `inFlight` would keep passing while the two readers disagreed about the rest of it.
 */
const integration = (over: Partial<ProjectIntegrationView> = {}): ProjectIntegrationView => ({
  line: 'PROJECT_BRANCH',
  lineAbsentReason: null,
  ref: `project/${PROJECT}`,
  upstreamRef: 'main',
  source: 'EXPLICIT',
  locked: true,
  startedAt: '2026-09-25T13:46:00Z',
  mergeCheckCommand: 'npm test',
  mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: 900,
  escalationSeconds: 3600,
  commitsAheadOfUpstream: 1,
  commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
  integratingCount: 1,
  queuedCount: 0,
  mergeCheckOnTip: 'PASSING',
  // The report this card was specified against: T2, claimed at 13:58:00, reporting as it works —
  // the claim is the runner's first report, which is what a claimed job looks like on the wire.
  inFlight: { taskTitle: TITLE, state: 'RUNNING', kind: 'LAND_TASK', phase: 'CHECK',
    startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
  ...over,
});

/** The task this card was specified against, in the spelling the mock carries it. */
const TITLE = 'T2 wiki 契約、迁移与共享类型';

/** One job as `inFlightJobs` lists it — by default T2, claimed at 13:58 and reporting as it works. */
const cardJob = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => ({
  jobId: 'job-t2',
  kind: 'LAND_TASK',
  state: 'RUNNING',
  phase: 'CHECK',
  taskId: 'task-t2',
  taskTitle: TITLE,
  generation: 1,
  startedAt: '2026-09-25T13:58:00Z',
  queuedAt: '2026-09-25T13:57:30Z',
  heartbeatAt: '2026-09-25T13:58:00Z',
  runnerName: null,
  retriedBy: null,
  timedOut: false,
  limitSeconds: null,
  retryable: false,
  ...over,
});

describe('landingHead', () => {
  // The two slots the merge check card and the landing card draw their head with (owner decision
  // 2026-10-11, board docs/mocks/project-merge-check-row, iOS `ProjectPage.landingHead`): the live
  // clock at the right of the title, and the state, the wait and the freshness in one line under it.

  it('leads with the clock and folds the wait and the freshness into one sentence', () => {
    expect(landingHead({ state: 'checking', timedOut: false, clockLabel: 'Elapsed', clock: '2m 40s',
      wait: null, updated: 'Updated 2m ago' }))
      .toEqual({ right: '2m 40s', isClock: true, detail: 'checking · updated 2m ago' });
    expect(landingHead({ state: 'checking', timedOut: false, clockLabel: 'Elapsed', clock: '3m 50s',
      wait: '1m 20s', updated: 'Updated just now' }))
      .toEqual({ right: '3m 50s', isClock: true, detail: 'checking · waited 1m 20s · updated just now' });
    // A job with nothing to say but its state says only that.
    expect(landingHead({ state: 'queued', timedOut: false, clockLabel: 'Queued for', clock: '1m 5s',
      wait: null, updated: null }).detail).toBe('queued');
  });

  it('gives a timed-out job the state at the right and its silence in the line', () => {
    expect(landingHead({ state: 'Timed out', timedOut: true, clockLabel: 'No report for', clock: '110m',
      wait: null, updated: 'limit 10m' }))
      .toEqual({ right: 'Timed out', isClock: false, detail: 'No report for 110m · limit 10m' });
  });

  it('says an older server’s silence once, never twice', () => {
    expect(landingHead({ state: 'No report', timedOut: false, clockLabel: 'No report for', clock: '5m',
      wait: null, updated: 'No report for 5m' }))
      .toEqual({ right: '5m', isClock: true, detail: 'No report for 5m' });
    expect(landingHead({ state: 'No report', timedOut: false, clockLabel: 'No report for', clock: '0m 5s',
      wait: null, updated: 'No report yet' }).detail).toBe('No report yet');
  });

  it('reads a real line the way the card words it, so one function words both', () => {
    // An unreadable server: the clock freezes at the last read and the line leads with that fact.
    const readAt = Date.parse('2026-09-25T13:59:20Z');
    const line = landingLine(integration(), readAt + 60_000, { updatedAt: readAt, failed: true })!;
    expect(landingHead(line)).toEqual({ right: line.clock, isClock: true,
      detail: `Update unavailable · ${line.updated!.toLowerCase()}` });
  });
});

describe('the landing card', () => {
  // The clock is read off `now`, so the render has to be told what time it is: the whole point of
  // the card is the number, and "about a minute" is not what the mock says.
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  afterEach(() => vi.useRealTimers());

  function renderAt(qc: QueryClient, iso: string) {
    vi.useFakeTimers();
    at(iso);
    return render(qc);
  }

  function seeded(view: ProjectIntegrationView = integration()) {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    qc.setQueryData(integrationKey, view);
    return qc;
  }

  it('draws the approved card: the ring, the word, the branch, the three clocks and the sentence', () => {
    // 80 seconds after the claim — the mock's own 1m 20s.
    const html = renderAt(seeded(integration({ inFlightJobs: [cardJob()], landTasks: [landed('job-t2')] })),
      '2026-09-25T13:59:20Z');

    // The card of its own, in the merge card's shape: a border, a radius and the subtle wash, and
    // the brand only while the job runs.
    expect(html).toContain('class="session-project-landing is-running"');
    // The head is the merged line's (owner decision 2026-10-11, docs/mocks/project-merge-check-row):
    // the mark in its circle, the word, the live clock at the right of it, and the state, the wait
    // and the freshness in one line under both.
    expect(html).toContain('class="landing-head is-running"');
    expect(html).toContain('class="landing-head-title">Landing<');
    expect(html).toContain('class="landing-head-right">1m 20s<');
    // The heartbeat is the claim, 80 seconds back: the clock counts them, the freshness rounds
    // them to the minute the landing row rounds them to.
    expect(html).toContain('class="landing-head-detail">checking · updated 1m ago<');
    expect(html).toContain(`class="spl-what">${TITLE}<`);
    expect(html).toContain(`class="spl-ref">onto project/${PROJECT}<`);
    // The whole row is the press, so the chevron the head used to carry is gone.
    expect(html).not.toContain('spl-chev');
    expect(html).toContain('class="spl-note">Nothing to do — it lands on its own.<');
    // The ring is the Integrating cell's own mark, inherited rather than redrawn, and the card
    // carries no Retry: nothing about this job wants the reader.
    expect(html).toContain('data-glyph="spinner"');
    expect(html).not.toContain('spl-primary');
    expect(html).not.toContain('Retry');
  });

  it('draws the queued card: still, grey, and counting from the enqueue', () => {
    const html = renderAt(
      seeded(integration({
        integratingCount: 0,
        queuedCount: 1,
        inFlight: { taskTitle: TITLE, state: 'QUEUED', startedAt: '2026-09-25T13:58:40Z' },
      })),
      '2026-09-25T13:59:20Z',
    );

    expect(html).toContain('class="session-project-landing"');
    expect(html).not.toContain('is-running');
    expect(html).toContain('class="landing-head-detail">queued · updated just now<');
    expect(html).toContain('class="landing-head-right">0m 40s<');
    // Nothing spins, and the spin is not the only thing that says so: "queued" is the word.
    expect(html).not.toContain('data-glyph="exclamation"');
  });

  it('counts the jobs in the head and names each one in the body', () => {
    const html = renderAt(
      seeded(integration({
        integratingCount: 1,
        queuedCount: 2,
        inFlight: { taskTitle: TITLE, state: 'RUNNING', kind: 'LAND_TASK', phase: 'CHECK',
          startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
        inFlightJobs: [
          cardJob(),
          cardJob({ jobId: 'job-2', state: 'QUEUED', phase: null, taskId: 'task-d', taskTitle: '维护：dossier 重复发出',
            startedAt: '2026-09-25T13:58:40Z', heartbeatAt: null, runnerName: null }),
          cardJob({ jobId: 'job-3', state: 'QUEUED', phase: null, taskId: 'task-e', taskTitle: 'P10 只读核查',
            startedAt: '2026-09-25T13:58:50Z', heartbeatAt: null, runnerName: null }),
        ],
        landTasks: [landed('job-t2')],
      })),
      '2026-09-25T13:59:20Z',
    );

    expect(html).toContain('class="landing-head-title">Landing 3 jobs<');
    expect(html).toContain('class="spl-jobs"');
    expect(html).toContain(`<span>${TITLE}</span><span class="st run">checking</span>`);
    expect(html).toContain('<span>维护：dossier 重复发出</span><span class="st">queued</span>');
    expect(html).toContain('<span>P10 只读核查</span><span class="st">queued</span>');
    // The count is the head's, so no single task is also named beside it.
    expect(html).not.toContain('spl-what');
  });

  it('draws no card at all while nothing is landing', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    qc.setQueryData(integrationKey, integration({ integratingCount: 0, queuedCount: 0, inFlight: null }));
    expect(renderAt(qc, '2026-09-25T13:59:20Z')).not.toContain('session-project-landing');

    // ...including when the integration read never answered: the card is the panorama's, and a card
    // it cannot draw is absent rather than blank.
    const only = newClient();
    only.setQueryData(panoramaKey, panorama());
    expect(renderAt(only, '2026-09-25T13:59:20Z')).not.toContain('session-project-landing');
  });

  it('turns amber for a runner the server judged silent, and offers Retry where it takes one', () => {
    // The board's own 9:07 screen: a runner that took the job and said nothing for 11 minutes past
    // a ten-minute limit.
    const html = renderAt(
      seeded(integration({
        inFlight: { taskTitle: TITLE, state: 'RUNNING', kind: 'LAND_TASK', phase: 'FETCH',
          startedAt: 'not a date', heartbeatAt: null },
        inFlightJobs: [cardJob({ phase: 'FETCH', startedAt: 'not a date', heartbeatAt: null,
          timedOut: true, limitSeconds: 600, retryable: true })],
      })),
      '2026-09-25T13:59:20Z',
    );

    expect(html).toContain('class="session-project-landing is-timed-out"');
    expect(html).not.toContain('is-running');
    // A triangle where the ring was, and the words — "Timed out" — that say the same thing without
    // the colour.
    expect(html).toContain('data-glyph="exclamation"');
    expect(html).not.toContain('data-glyph="spinner"');
    expect(html).toContain('class="landing-head-title">Landing<');
    // A timed-out job has no clock left that moves: the state takes the right slot, and the line
    // measures the silence against the limit it went past.
    expect(html).toContain('class="landing-head-right is-word">Timed out<');
    expect(html).toMatch(/class="landing-head-detail">No report for \d+m · limit 10m</);
    // Where the runner stopped, and the press — the jobs list's own door.
    expect(html).toContain('class="spl-det">The runner took it at --:-- · stopped at fetching · no push recorded<');
    expect(html).toContain('class="spl-primary"');
    expect(html).toContain('>Retry<');
    // A job nobody is waiting on: the same card, with no press at all.
    const refused = renderAt(
      seeded(integration({
        inFlight: { taskTitle: TITLE, state: 'RUNNING', kind: 'LAND_TASK', phase: 'FETCH' },
        inFlightJobs: [cardJob({ timedOut: true, limitSeconds: 600, retryable: false })],
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(refused).toContain('is-timed-out');
    expect(refused).not.toContain('spl-primary');
    expect(refused).not.toContain('>Retry<');
    // "Nothing to do" is for a job that lands on its own: nobody is told that of a stopped one.
    expect(refused).not.toContain('Nothing to do');
  });

  it('says nothing under the head of a card whose only job is a merge into main', () => {
    // Board v4 04 draws no body under a merge job's head: it lands no task, so "Nothing to do —
    // it lands on its own." would be about a task that is not there.
    const check = renderAt(
      seeded(integration({
        inFlight: { taskTitle: null, state: 'RUNNING', kind: 'CHECK_PROMOTION', phase: 'CHECK',
          startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
        inFlightJobs: [cardJob({ jobId: 'job-check', kind: 'CHECK_PROMOTION', taskId: null, taskTitle: null })],
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(check).toContain('class="landing-head-title">Merge check<');
    expect(check).not.toContain('spl-what');
    expect(check).not.toContain('spl-note');
    expect(check).not.toContain('Nothing to do');

    const toMain = renderAt(
      seeded(integration({
        integratingCount: 0,
        queuedCount: 1,
        inFlight: { taskTitle: null, state: 'QUEUED', kind: 'LAND_PROMOTION', phase: null,
          startedAt: '2026-09-25T13:58:40Z' },
        inFlightJobs: [cardJob({ jobId: 'job-merge', kind: 'LAND_PROMOTION', state: 'QUEUED', phase: null,
          taskId: null, taskTitle: null, startedAt: '2026-09-25T13:58:40Z', heartbeatAt: null })],
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(toMain).toContain('class="landing-head-title">Merge to main<');
    expect(toMain).not.toContain('spl-note');
    expect(toMain).not.toContain('Nothing to do');

    // A server that does not list its jobs names the kind on `inFlight`, and that is enough.
    const older = renderAt(
      seeded(integration({
        inFlight: { taskTitle: null, state: 'RUNNING', kind: 'CHECK_PROMOTION', phase: 'CHECK',
          startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
        inFlightJobs: undefined,
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(older).toContain('class="landing-head-title">Merge check<');
    expect(older).not.toContain('spl-note');

    // That server counting two jobs behind a merge check is no lone merge job: its head names two
    // jobs, and the card keeps the sentence it says about them.
    const olderTwo = renderAt(
      seeded(integration({
        integratingCount: 1,
        queuedCount: 1,
        inFlight: { taskTitle: null, state: 'RUNNING', kind: 'CHECK_PROMOTION', phase: 'CHECK',
          startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
        inFlightJobs: undefined,
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(olderTwo).toContain('class="landing-head-title">Merge check 2 jobs<');
    expect(olderTwo).toContain('class="spl-note">Nothing to do — it lands on its own.<');
  });

  it('still says where a lone merge job’s runner stopped once it timed out', () => {
    const html = renderAt(
      seeded(integration({
        inFlight: { taskTitle: null, state: 'RUNNING', kind: 'CHECK_PROMOTION', phase: 'CHECK',
          startedAt: 'not a date', heartbeatAt: null },
        inFlightJobs: [cardJob({ jobId: 'job-check', kind: 'CHECK_PROMOTION', taskId: null, taskTitle: null,
          startedAt: 'not a date', heartbeatAt: null, timedOut: true, limitSeconds: 600 })],
      })),
      '2026-09-25T13:59:20Z',
    );
    expect(html).toContain('class="session-project-landing is-timed-out"');
    expect(html).toContain('class="spl-det">The runner took it at --:-- · stopped at checking<');
    expect(html).not.toContain('Nothing to do');
  });

  it('counts a job the server cannot date from zero rather than printing NaN', () => {
    const html = renderAt(
      seeded(integration({ inFlight: { taskTitle: null, state: 'RUNNING', startedAt: 'not a date',
        heartbeatAt: '2026-09-25T13:59:00Z' } })),
      '2026-09-25T13:59:20Z',
    );
    expect(html).toContain('class="landing-head-right">0m 0s<');
    expect(html).not.toContain('NaN');
    // A job that names no task — a promotion, a merge check — keeps the row's word and state.
    expect(html).toContain('class="landing-head-title">Integration<');
    expect(html).toMatch(/class="landing-head-detail">running · /);
  });

  it('presses through to the jobs list, and draws no press to a page with nothing to open', () => {
    // The read the header itself makes: the server lists its jobs, so the card is a press and the
    // page keeps the list behind it.
    const listed = renderAt(seeded(integration({ inFlightJobs: [cardJob()] })), '2026-09-25T13:59:20Z');
    expect(listed).toContain('class="spl-press"');
    expect(listed).toContain('aria-haspopup="dialog"');
    // The public project page hands the card in with no such read open to it: the same card, read.
    const read = renderToStaticMarkup(
      <MemoryRouter>
        <ProjectPanoramaCard panorama={panorama()} projectId={PROJECT}
          landing={landingCard(integration(), Date.parse('2026-09-25T13:59:20Z'))} />
      </MemoryRouter>,
    );
    expect(read).toContain('class="session-project-landing is-running"');
    expect(read).toContain('<div class="spl-press">');
  });
});

describe('landingClock', () => {
  it('always shows minutes AND seconds, whatever the length', () => {
    expect(landingClock(80_000)).toBe('1m 20s');
    expect(landingClock(40_000)).toBe('0m 40s');
    expect(landingClock(0)).toBe('0m 0s');
    // 59s is not "1m" and 3h is not "3h": this clock never rounds to a unit that moves slower than
    // the reader is watching it, which is the whole reason it is not `formatSpan`.
    expect(landingClock(59_400)).toBe('0m 59s');
    expect(landingClock(3_600_000)).toBe('60m 0s');
    // A clock a little behind the server (skew) counts from zero, never backwards.
    expect(landingClock(-5_000)).toBe('0m 0s');
  });
});

describe('landingLine', () => {
  it('is null when the server reports nothing in flight', () => {
    expect(landingLine(integration({ inFlight: null }), Date.parse('2026-09-25T13:59:20Z'))).toBeNull();
  });

  it('carries the running job as checking and the queued one as queued', () => {
    const now = Date.parse('2026-09-25T13:59:20Z');
    expect(landingLine(integration(), now)).toEqual({
      word: 'Landing',
      what: 'T2 wiki 契約、迁移与共享类型',
      running: true,
      timedOut: false,
      state: 'checking',
      clock: '1m 20s',
      clockLabel: 'Elapsed', updated: 'Updated 1m ago', wait: null,
    });
    expect(
      landingLine(
        integration({ inFlight: { taskTitle: 'T1', state: 'QUEUED', startedAt: '2026-09-25T13:58:40Z' } }),
        now,
      ),
    ).toEqual({ word: 'Integration', what: 'T1', running: false, timedOut: false, state: 'queued', clock: '0m 40s',
      clockLabel: 'Queued for', updated: null, wait: null });
  });

  it('writes the queue wait beside the elapsed time when the job waited for a runner', () => {
    // The real one, 2026-10-08: claimed 2m 24s after it was queued, and 4m 41s into the work.
    const now = Date.parse('2026-10-08T04:11:05Z');
    const line = landingLine(integration({ inFlight: {
      taskTitle: 'C5', state: 'RUNNING', kind: 'LAND_TASK', phase: 'FETCH',
      startedAt: '2026-10-08T04:06:24Z', heartbeatAt: '2026-10-08T04:11:00Z', waitMs: 143_600,
    } }), now, { updatedAt: now });
    expect(line).toMatchObject({ state: 'fetching', clock: '4m 41s', clockLabel: 'Elapsed', wait: '2m 23s' });
    // A queued job's whole clock IS the wait, and it is already said: `Queued for`.
    expect(landingLine(integration({ inFlight: {
      taskTitle: 'C5', state: 'QUEUED', kind: 'LAND_TASK', startedAt: '2026-10-08T04:06:24Z', waitMs: 143_600,
    } }), now)).toMatchObject({ clockLabel: 'Queued for', wait: null });
    // And a job that never waited has nothing to say about waiting.
    expect(landingLine(integration(), now, { updatedAt: now })?.wait).toBeNull();
  });

  it.each([
    ['LAND_TASK', 'FETCH', 'Landing', 'fetching'],
    ['LAND_TASK', 'MAIN_SYNC', 'Landing', 'syncing main'],
    ['LAND_TASK', 'REBASE', 'Landing', 'rebasing'],
    ['CHECK_PROMOTION', 'MERGE', 'Merge check', 'merging'],
    ['CHECK_PROMOTION', 'CHECK', 'Merge check', 'checking'],
    ['LAND_PROMOTION', 'VERIFY', 'Merge to main', 'verifying'],
    ['LAND_PROMOTION', 'PUSH', 'Merge to main', 'pushing'],
  ] as const)('describes %s at %s from its actual job facts', (kind, phase, word, state) => {
    expect(landingLine(integration({ inFlight: {
      taskTitle: null, state: 'RUNNING', kind, phase, startedAt: '2026-09-25T13:58:00Z',
      heartbeatAt: '2026-09-25T13:58:30Z',
    } }), Date.parse('2026-09-25T13:59:20Z'))).toMatchObject({ word, state, running: true });
  });

  it('keeps a merge queued even if it carries an earlier check phase', () => {
    expect(landingLine(integration({ inFlight: {
      taskTitle: null, state: 'QUEUED', kind: 'LAND_PROMOTION', phase: 'CHECK', startedAt: '2026-09-25T13:58:00Z',
    } }), Date.parse('2026-09-25T13:59:20Z'))).toMatchObject({ word: 'Merge to main', state: 'queued', running: false });
  });

  it('stops claiming live activity after a failed refresh and freezes the observed elapsed time', () => {
    const readAt = Date.parse('2026-09-25T13:59:20Z');
    const failed = { updatedAt: readAt, failed: true };
    const line = landingLine(integration(), readAt + 60_000, failed);
    expect(line).toMatchObject({ running: false, state: 'Update unavailable', clock: '1m 20s',
      clockLabel: 'Elapsed', updated: 'Updated 1m ago' });
    expect(landingLine(integration(), readAt + 120_000, failed)?.clock).toBe(line?.clock);
    expect(landingLine(integration(), readAt + 91_000, { updatedAt: readAt })?.running).toBe(false);
    // The read being fresh does not make the JOB fresh: the row follows the runner's last report.
    expect(landingLine(integration(), readAt + 120_000, { updatedAt: readAt + 120_000 }))
      .toMatchObject({ running: true, state: 'checking', updated: 'Updated 3m ago' });
  });

  it('uses the runner heartbeat so a successful API refresh cannot make an offline job look active', () => {
    const now = Date.parse('2026-09-25T14:10:00Z');
    const view = integration({ inFlight: { ...integration().inFlight!, heartbeatAt: '2026-09-25T13:59:00Z' } });
    expect(landingLine(view, now, { updatedAt: now })).toMatchObject({
      running: false, state: 'No report', clock: '1m 0s', updated: 'No report for 11m',
    });
    expect(landingLine({ ...view, inFlight: { ...view.inFlight!, heartbeatAt: '2026-09-25T14:09:50Z' } }, now,
      { updatedAt: now })).toMatchObject({ running: true, state: 'checking', updated: 'Updated just now' });
  });

  /**
   * The one thing this row must never do: call a silent runner a timed-out job. "No report" is a
   * fact about the reports; a timeout is the job's own verdict, arrives as the server's
   * `blockingReason`, and is worded by whoever prints that (see `TaskDetailPanel`'s landing block).
   */
  it('never words a silent runner as a timeout', () => {
    const now = Date.parse('2026-10-08T06:00:00Z');
    const silent = landingLine(integration({ inFlight: {
      taskTitle: 'C5', state: 'RUNNING', kind: 'LAND_TASK', phase: 'FETCH',
      startedAt: '2026-10-08T04:06:24Z', heartbeatAt: '2026-10-08T04:08:00Z',
    } }), now, { updatedAt: now })!;
    expect(silent.state).toBe('No report');
    expect(silent.updated).toBe('No report for 112m');
    expect(`${silent.state} ${silent.updated}`).not.toMatch(/timed? ?out/i);
    // A job claimed whose runner has not reported once, since the claim.
    const never = landingLine(integration({ inFlight: {
      taskTitle: 'C5', state: 'RUNNING', kind: 'LAND_TASK', phase: null,
      startedAt: '2026-10-08T04:06:24Z', heartbeatAt: null,
    } }), now, { updatedAt: now })!;
    expect(never.state).toBe('No report');
    expect(never.updated).toBe('No report yet');
  });
});

/**
 * The screen the timeout was specified against (docs/mocks/landing-jobs-sheet, 21:57): C5, claimed
 * at 20:07 by a runner that never reported, and the merge into main queued behind it for 41m 8s.
 * Local instants, because the detail line reads them on the reader's own clock; and in the past, so a
 * read seeded at the real time is never older than the clock these tests set.
 */
const CLAIMED = new Date(2026, 8, 25, 20, 7, 4).getTime();
const NOW = new Date(2026, 8, 25, 21, 57, 30).getTime();
const C5 = 'C5 · 登录后开通默认托管 runner 与 workspace';
const instant = (ms: number) => new Date(ms).toISOString();

/** One job as `inFlightJobs` lists it — by default C5, timed out and retryable. */
const job = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => ({
  jobId: 'job-c5',
  kind: 'LAND_TASK',
  state: 'RUNNING',
  phase: 'FETCH',
  taskId: 'task-c5',
  taskTitle: C5,
  generation: 1,
  startedAt: instant(CLAIMED),
  queuedAt: instant(CLAIMED - 60_000),
  heartbeatAt: null,
  runnerName: 'workstation-gpu',
  retriedBy: null,
  timedOut: true,
  limitSeconds: 600,
  retryable: true,
  ...over,
});

/** The merge into main, queued: no task, no runner, no limit. */
const merge = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => job({
  jobId: 'job-merge', kind: 'LAND_PROMOTION', state: 'QUEUED', phase: null, taskId: null, taskTitle: null,
  startedAt: instant(NOW - (41 * 60 + 8) * 1000), queuedAt: instant(NOW - (41 * 60 + 8) * 1000), runnerName: null,
  timedOut: false, limitSeconds: null, retryable: false,
  ...over,
});

/** One of the project's own landings, as `landTasks` serves it: the branch a job lands on, in the
 *  spelling the card shows and the task page's Target row prints. */
const landed = (jobId: string, targetRef = `refs/heads/project/${PROJECT}`): ProjectLandTask => ({
  taskId: 'task-c5',
  taskTitle: C5,
  integration: {
    state: 'RUNNING', since: null, handler: null, openItemId: null, jobId, checksRunningForMs: null,
    landTask: {
      jobId, state: 'RUNNING', phase: 'FETCH', generation: '1', queuedAt: instant(CLAIMED - 60_000),
      startedAt: instant(CLAIMED), heartbeatAt: null, finishedAt: null, targetRef, waitMs: 32_000,
      blockingReason: null,
    },
  },
});

/** The view of a server that lists its jobs: the counts count them, `inFlight` is the first, and
 *  every one of them is on the project branch unless the test says otherwise. */
const listing = (jobs: ProjectIntegrationJob[], landTasks?: ProjectLandTask[]): ProjectIntegrationView => integration({
  integratingCount: jobs.filter((entry) => entry.state === 'RUNNING').length,
  queuedCount: jobs.filter((entry) => entry.state === 'QUEUED').length,
  inFlight: jobs[0] ? {
    taskTitle: jobs[0].taskTitle, kind: jobs[0].kind, phase: jobs[0].phase, state: jobs[0].state,
    startedAt: jobs[0].startedAt, heartbeatAt: jobs[0].heartbeatAt,
  } : null,
  inFlightJobs: jobs,
  landTasks: landTasks ?? jobs.map((entry) => landed(entry.jobId)),
});

describe('landingLine, from a server that lists its jobs', () => {
  it('takes the server’s word that the job it describes timed out, and counts how many did', () => {
    expect(landingLine(listing([job(), merge()]), NOW, { updatedAt: NOW })).toEqual({
      word: 'Landing', what: '2 jobs · 1 timed out', running: false, timedOut: true,
      state: 'Timed out', clock: '110m', clockLabel: 'No report for', updated: 'limit 10m', wait: null,
    });
    // One job keeps the task's own title in the name slot.
    expect(landingLine(listing([job()]), NOW, { updatedAt: NOW })).toMatchObject({ what: C5, state: 'Timed out' });
  });

  it('counts the silence from the last report, and states the limit the step had', () => {
    const check = job({ phase: 'CHECK', heartbeatAt: instant(NOW - 75 * 60_000), limitSeconds: 4200 });
    expect(landingLine(listing([check]), NOW, { updatedAt: NOW }))
      .toMatchObject({ clock: '75m', clockLabel: 'No report for', updated: 'limit 70m' });
    // No limit on the job is the claim lease's ten minutes, and an instant it cannot read is no
    // silence rather than NaN.
    expect(landingLine(listing([job({ limitSeconds: null })]), NOW)).toMatchObject({ updated: 'limit 10m' });
    expect(landingLine(listing([job({ startedAt: 'not a date' })]), NOW)).toMatchObject({ clock: '0m' });
  });

  it('counts a timed-out job behind a lead that is still fine, and draws the lead as it is', () => {
    const fine = job({
      jobId: 'job-t2', taskTitle: 'T2', phase: 'CHECK', timedOut: false, retryable: false,
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 5_000),
    });
    expect(landingLine(listing([fine, job()]), NOW, { updatedAt: NOW })).toEqual({
      word: 'Landing', what: '2 jobs · 1 timed out', running: true, timedOut: false,
      state: 'checking', clock: '1m 20s', clockLabel: 'Elapsed', updated: 'Updated just now', wait: null,
    });
  });

  it('says Update unavailable when this app cannot read the server, ahead of any timeout', () => {
    for (const observation of [{ updatedAt: NOW - 5_000, failed: true }, { updatedAt: NOW - 91_000 }]) {
      expect(landingLine(listing([job(), merge()]), NOW, observation)).toMatchObject({
        what: '2 jobs · 1 timed out', running: false, timedOut: false, state: 'Update unavailable',
      });
    }
  });

  it('leaves timeouts to the server: a long-silent check it has not timed out still reads as checking', () => {
    // Eleven minutes without a report is past the lease an older server's row guesses from, and
    // well inside a check's budget.
    const check = job({
      phase: 'CHECK', timedOut: false, retryable: false, heartbeatAt: instant(NOW - 11 * 60_000), limitSeconds: 4200,
    });
    expect(landingLine(listing([check]), NOW, { updatedAt: NOW })).toMatchObject({
      running: true, timedOut: false, state: 'checking', updated: 'Updated 11m ago',
    });
    // The same job from a server that does not list its jobs: this app reads the reports for
    // itself, and reads them for what they are — a runner that has said nothing for a while is
    // "No report", never a timeout, which only the job's own verdict (the server's `blockingReason`)
    // may word, and never "Update unavailable", which is this app failing to READ the server.
    expect(landingLine({ ...listing([check]), inFlightJobs: undefined }, NOW, { updatedAt: NOW }))
      .toMatchObject({ running: false, timedOut: false, state: 'No report', updated: 'No report for 11m' });
  });
});

describe('landingJobLines', () => {
  it('is empty from a server that does not list its jobs', () => {
    expect(landingJobLines(integration(), NOW, { updatedAt: NOW })).toEqual([]);
  });

  it('draws a running job as the row draws it, with the task its row opens', () => {
    const running = job({
      jobId: 'job-t2', taskId: 'task-t2', taskTitle: 'T2', phase: 'CHECK', timedOut: false, retryable: false,
      startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 10_000),
    });
    expect(landingJobLines(listing([running]), NOW, { updatedAt: NOW })).toEqual([{
      jobId: 'job-t2', taskId: 'task-t2', detail: null, retryable: false,
      landingSessionId: null, mergeJob: false,
      line: { word: 'Landing', what: 'T2', running: true, timedOut: false, state: 'checking', clock: '1m 20s',
        clockLabel: 'Elapsed', updated: 'Updated just now', wait: null },
    }]);
    // Fresh as the runner's last report, not as this app's last read...
    expect(landingJobLines(listing([{ ...running, heartbeatAt: instant(NOW - 3 * 60_000) }]), NOW,
      { updatedAt: NOW })[0].line.updated).toBe('Updated 3m ago');
    // ...and as the read when the runner has not reported yet, as on the row.
    expect(landingJobLines(listing([{ ...running, heartbeatAt: null }]), NOW,
      { updatedAt: NOW - 2 * 60_000 })[0].line.updated).toBe('Updated 2m ago');
  });

  it('draws a promotion, which lands no task, as its word, state and wait alone', () => {
    expect(landingJobLines(listing([merge()]), NOW, { updatedAt: NOW })).toEqual([{
      jobId: 'job-merge', taskId: null, detail: null, retryable: false,
      // A round of merging, and a server that names no landing session for it.
      landingSessionId: null, mergeJob: true,
      line: { word: 'Merge to main', what: null, running: false, timedOut: false, state: 'queued', clock: '41m 8s',
        clockLabel: 'Queued for', updated: 'Updated just now', wait: null },
    }]);
  });

  it('keeps a queued job queued whatever step and report an earlier claim left on it', () => {
    // The server sends a job's phase and heartbeat as its row holds them, so a job queued again after
    // a claim carries both: neither makes it running, and its freshness is still the read's.
    const requeued = merge({ phase: 'MERGE', heartbeatAt: instant(NOW - 30 * 60_000) });
    expect(landingJobLines(listing([requeued]), NOW, { updatedAt: NOW - 60_000 })[0].line).toEqual({
      word: 'Merge to main', what: null, running: false, timedOut: false, state: 'queued', clock: '41m 8s',
      clockLabel: 'Queued for', updated: 'Updated 1m ago', wait: null,
    });
  });

  it.each([
    ['FETCH', 'fetching', 'no push recorded'],
    ['MAIN_SYNC', 'syncing main', 'no push recorded'],
    ['REBASE', 'rebasing', 'no push recorded'],
    ['MERGE', 'merging', 'no push recorded'],
    ['CHECK', 'checking', 'no push recorded'],
    ['VERIFY', 'verifying', 'may have been pushed'],
    ['PUSH', 'pushing', 'may have been pushed'],
  ] as const)('says where a job that timed out at %s stopped, and whether it may have pushed', (phase, stopped, push) => {
    expect(landingJobLines(listing([job({ phase })]), NOW, { updatedAt: NOW })).toEqual([{
      jobId: 'job-c5', taskId: 'task-c5', retryable: true,
      // A server that names no landing session for the job: the row draws the sentence instead of
      // a link, and the job's own word is not a merge's.
      landingSessionId: null, mergeJob: false,
      line: { word: 'Landing', what: C5, running: false, timedOut: true, state: 'Timed out', clock: '110m',
        clockLabel: 'No report for', updated: 'limit 10m', wait: null },
      detail: `Runner workstation-gpu took it at 20:07 · stopped at ${stopped} · ${push}`,
    }]);
  });

  it('names no runner it was not told, and no step it never heard of', () => {
    expect(landingJobLines(listing([job({ runnerName: null, phase: null })]), NOW)[0].detail)
      .toBe('The runner took it at 20:07 · stopped at running · no push recorded');
  });

  it('says which generation a retried job is, who asked for it and when', () => {
    const retried = {
      generation: 2, retriedBy: 'OWNER' as const, timedOut: false, retryable: false,
      queuedAt: new Date(2026, 8, 25, 22, 15, 3).toISOString(),
    };
    expect(landingJobLines(listing([job(retried)]), NOW)[0].detail).toBe('Generation 2 · retried by you at 22:15');
    expect(landingJobLines(listing([job({ ...retried, generation: 3, retriedBy: 'COORDINATOR' })]), NOW)[0].detail)
      .toBe('Generation 3 · retried by the coordinator at 22:15');
  });

  it('carries Retry from the server’s answer, not from the timeout', () => {
    expect(landingJobLines(listing([job({ retryable: false })]), NOW)[0])
      .toMatchObject({ retryable: false, line: { timedOut: true } });
  });

  it('says Update unavailable on every job while this app cannot read the server, timed out or not', () => {
    const lines = landingJobLines(listing([job(), merge()]), NOW, { updatedAt: NOW - 120_000, failed: true });
    for (const { line } of lines) {
      expect(line).toMatchObject({ running: false, timedOut: false, state: 'Update unavailable' });
    }
    // The queued job's clock stops where the last read left it, as the row's does.
    expect(lines[1].line.clock).toBe('39m 8s');
  });
});

/**
 * §7.2 V6 (contract :1579-1610, board docs/mocks/landing-session/v4/05): once the server derives
 * the claim's liveness and sends the step, claim and output facts, the head's two slots say them.
 * A server that sends none keeps every word it had — the block after this one is that server.
 */
describe('§7.2 V6: the head once the server derives the claim’s liveness', () => {
  const V6_NOW = Date.parse('2026-09-25T13:59:20Z');
  const V6_STEP = '2026-09-25T13:57:30Z';
  const checkFor = (kind: ProjectIntegrationInFlight['kind']) => ({
    name: (kind === 'LAND_TASK' ? 'TASK_ACCEPTANCE' : 'MERGE_CHECK') as 'TASK_ACCEPTANCE' | 'MERGE_CHECK',
    index: 1, count: 3, budgetSeconds: 3600, startedAt: V6_STEP,
  });

  /** A v2 claim as the server reports it: LIVE by default, one claim, one round. */
  const claimed = (over: Partial<ProjectIntegrationInFlight> = {}): ProjectIntegrationInFlight => ({
    taskTitle: TITLE, state: 'RUNNING', kind: 'LAND_TASK', phase: 'CHECK',
    startedAt: V6_STEP, heartbeatAt: '2026-09-25T13:59:20Z',
    jobId: 'job-t2', taskId: 'task-t2', runner: 'wikova', claim: 1, round: 1,
    check: checkFor('LAND_TASK'), stepStartedAt: V6_STEP, outputMovedAt: '2026-09-25T13:59:14Z',
    progressProtocol: 'v2', typicalMs: null, liveness: 'LIVE',
    ...over,
  });

  const listed = (over: Partial<ProjectIntegrationJob> = {}): ProjectIntegrationJob => cardJob({
    jobId: 'job-t2', taskId: 'task-t2', taskTitle: TITLE, kind: 'LAND_TASK', phase: 'CHECK',
    startedAt: V6_STEP, queuedAt: '2026-09-25T13:57:00Z', heartbeatAt: '2026-09-25T13:59:20Z',
    runnerName: 'wikova', claim: 1, round: 1, check: checkFor('LAND_TASK'),
    stepStartedAt: V6_STEP, outputMovedAt: '2026-09-25T13:59:14Z', typicalMs: null, liveness: 'LIVE',
    ...over,
  });

  /** Both halves of the read the head and the card draw from, kept in step. */
  const view6 = (lead: ProjectIntegrationInFlight, jobs: ProjectIntegrationJob[] = [listed()],
                 landTasks?: ProjectLandTask[]): ProjectIntegrationView => integration({
    inFlight: lead, inFlightJobs: jobs, integratingCount: 1, queuedCount: 0,
    ...(landTasks ? { landTasks } : {}),
  });

  // §7.2 V6: the M is the kind's own most rounds per claim, never the check's count (3 here).
  const kinds: Array<[NonNullable<ProjectIntegrationInFlight['kind']>, string, string]> = [
    ['LAND_TASK', 'Landing', 'round 1 of 3'], ['CHECK_PROMOTION', 'Merge check', 'round 1'],
    ['LAND_PROMOTION', 'Merge to main', 'round 1'],
  ];

  it.each(kinds)('draws %s’s head for each of the five readings', (kind, word, round) => {
    const check = checkFor(kind);
    const typicalMs = kind === 'LAND_TASK' ? null : 18 * 60_000;
    const taskTitle = kind === 'LAND_TASK' ? TITLE : null;
    const usually = kind === 'LAND_TASK' ? '' : 'usually ~18m · ';
    const line = (over: Partial<ProjectIntegrationInFlight>, jobs?: Partial<ProjectIntegrationJob>[],
                  observation = { updatedAt: V6_NOW }) => landingHead(landingLine(view6(
                    claimed({ kind, taskTitle, check, typicalMs, ...over }),
                    [listed({ kind, taskTitle, taskId: taskTitle ? 'task-t2' : null, check, typicalMs, ...over, ...(jobs?.[0] ?? {}) })],
                  ), V6_NOW, observation)!);

    expect(landingLine(view6(claimed({ kind, taskTitle, check, typicalMs }),
      [listed({ kind, taskTitle, check, typicalMs })]), V6_NOW)!.word).toBe(word);

    // LIVE: the step's clock against its budget, and output moving.
    expect(line({ liveness: 'LIVE' })).toEqual({
      right: '1m 50s of 60m', isClock: true,
      detail: `checking · output 6s ago · ${usually}claim 1 · ${round}`,
    });
    // QUIET: the heartbeat is fresh and the output is not — the clock still runs.
    expect(line({ liveness: 'QUIET', outputMovedAt: '2026-09-25T13:45:20Z' })).toEqual({
      right: '1m 50s of 60m', isClock: true,
      detail: `checking · no output for 14m · within its 60m budget · ${usually}claim 1 · ${round}`,
    });
    // SILENT: no word for four minutes; the clock is frozen at the runner's last word.
    expect(line({ liveness: 'SILENT', heartbeatAt: '2026-09-25T13:55:20Z', stepStartedAt: '2026-09-25T13:50:00Z' })).toEqual({
      right: '5m 20s of 60m', isClock: true,
      detail: `checking · no word from runner wikova for 4m · ${usually}claim 1 · ${round}`,
    });
    // LEGACY: reports only between steps; no freshness, and no silence inferred from 12 quiet minutes.
    const legacy = line({ liveness: 'LEGACY', heartbeatAt: '2026-09-25T13:47:20Z', stepStartedAt: '2026-09-25T13:47:20Z' });
    expect(legacy).toEqual({
      right: '12m 0s of 60m', isClock: true,
      detail: `checking · reports only between steps · ${usually}claim 1 · ${round}`,
    });
    expect(JSON.stringify(legacy)).not.toContain('Update unavailable');
    expect(JSON.stringify(legacy)).not.toContain('Updated 12m ago');
    // LEASE_EXPIRED: the server's one timeout, worded as main words it.
    expect(line({ liveness: 'LEASE_EXPIRED', heartbeatAt: '2026-09-25T13:35:20Z' },
      [{ timedOut: true, limitSeconds: 600 }])).toEqual({
      right: 'Timed out', isClock: false, detail: 'No report for 24m · limit 10m',
    });
  });

  it('takes the M from the kind, on the head and on every job’s line, never from the check', () => {
    // A task's landing is "of 3" with one check in flight, and with none (a git step).
    const one = { ...checkFor('LAND_TASK'), count: 1 };
    expect(landingHead(landingLine(view6(claimed({ round: 2, check: one }), [listed({ round: 2, check: one })]), V6_NOW)!).detail)
      .toBe('checking · output 6s ago · claim 1 · round 2 of 3');
    const rebasing = landingLine(view6(claimed({ phase: 'REBASE', check: null }), [listed({ phase: 'REBASE', check: null })]), V6_NOW)!;
    expect(landingHead(rebasing).detail).toBe('rebasing · output 6s ago · claim 1 · round 1 of 3');
    // The jobs sheet reads each job's own kind: the merge beside the landing names no M.
    const lines = landingJobLines(view6(claimed(), [
      listed({ check: one }),
      listed({ jobId: 'job-m', kind: 'LAND_PROMOTION', taskId: null, taskTitle: null, phase: 'PUSH', check: null }),
    ]), V6_NOW);
    expect(landingHead(lines[0].line).detail).toBe('checking · output 6s ago · claim 1 · round 1 of 3');
    expect(landingHead(lines[1].line).detail).toBe('pushing · output 6s ago · claim 1 · round 1');
    // A server that does not say the kind leaves the M out rather than guessing one.
    expect(landingHead(landingLine(view6(claimed({ kind: undefined }), []), V6_NOW)!).detail)
      .toBe('checking · output 6s ago · claim 1 · round 1');
  });

  it('writes "round N of 3" only for a task’s landing', () => {
    expect(landingRoundClause(2, 'LAND_TASK')).toBe('round 2 of 3');
    expect(landingRoundClause(1, 'CHECK_PROMOTION')).toBe('round 1');
    expect(landingRoundClause(1, 'LAND_PROMOTION')).toBe('round 1');
    expect(landingRoundClause(1, null)).toBe('round 1');
    expect(landingRoundClause(1, 'SOMETHING_NEW')).toBe('round 1');
  });

  it('names the takeover and the first start the claim row still carries', () => {
    const first = { ...landed('job-t2'), integration: { ...landed('job-t2').integration!, landTask: {
      ...landed('job-t2').integration!.landTask!, startedAt: '2026-09-25T13:52:00Z',
    } } };
    const head = landingHead(landingLine(view6(claimed({ claim: 2 }), [listed({ claim: 2 })], [first]), V6_NOW)!);
    expect(head.detail).toContain(`Taken over ${landingClockTime(V6_STEP)} · `
      + `first started ${landingClockTime('2026-09-25T13:52:00Z')}`);
    // No task row (a promotion) means no first start to name; the takeover itself is still said.
    const promotion = landingHead(landingLine(view6(
      claimed({ kind: 'CHECK_PROMOTION', taskTitle: null, check: checkFor('CHECK_PROMOTION'), typicalMs: 18 * 60_000, claim: 2 }),
      [listed({ kind: 'CHECK_PROMOTION', taskTitle: null, taskId: null, check: checkFor('CHECK_PROMOTION'),
        typicalMs: 18 * 60_000, claim: 2 })],
    ), V6_NOW)!);
    expect(promotion.detail).toContain(`Taken over ${landingClockTime(V6_STEP)}`);
    expect(promotion.detail).not.toContain('first started');
  });

  it('carries the same head into the card, which the sessions page and the Work overview draw', () => {
    const card = landingCard(view6(claimed()), V6_NOW, { updatedAt: V6_NOW })!;
    expect(landingHead(card)).toEqual(landingHead(landingLine(view6(claimed()), V6_NOW)!));
    expect(card).toMatchObject({
      word: 'Landing', title: 'Landing', state: 'checking', running: true, timedOut: false,
      clock: '1m 50s of 60m', liveness: { clock: '1m 50s of 60m', ticking: true },
    });
    // The jobs list's own row says the same two slots.
    expect(landingHead(landingJobLines(view6(claimed()), V6_NOW)[0].line))
      .toEqual(landingHead(landingLine(view6(claimed()), V6_NOW)!));
  });

  it('never writes a push sentence for a merge check that timed out', () => {
    const lines = landingJobLines(view6(claimed(), [listed({
      kind: 'CHECK_PROMOTION', taskId: null, taskTitle: null, phase: 'CHECK', timedOut: true, limitSeconds: 600,
      runnerName: 'wikova', heartbeatAt: '2026-09-25T13:35:20Z', liveness: 'LEASE_EXPIRED',
    })]), V6_NOW);
    expect(lines[0].detail).toBe(`Runner wikova took it at ${landingClockTime(V6_STEP)} · stopped at checking`);
    // A landing still says whether it may have pushed.
    const landing = landingJobLines(view6(claimed(), [listed({
      phase: 'PUSH', timedOut: true, limitSeconds: 600, heartbeatAt: '2026-09-25T13:35:20Z', liveness: 'LEASE_EXPIRED',
    })]), V6_NOW);
    expect(landing[0].detail).toBe(`Runner wikova took it at ${landingClockTime(V6_STEP)} · stopped at pushing · may have been pushed`);
  });

  it('does not fall back to the claim-lease silence when the server sends liveness without a job list', () => {
    const read = integration({
      inFlight: claimed({ liveness: 'LEGACY', heartbeatAt: '2026-09-25T13:47:20Z',
        stepStartedAt: '2026-09-25T13:47:20Z', check: checkFor('LAND_TASK') }),
      inFlightJobs: undefined,
    });
    const head = landingHead(landingLine(read, V6_NOW, { updatedAt: V6_NOW })!);
    expect(head.detail).toBe('checking · reports only between steps · claim 1 · round 1 of 3');
    expect(JSON.stringify(head)).not.toContain('Update unavailable');
  });

  it('is the server it was before these fields existed when they are absent', () => {
    const old = landingLine(integration(), V6_NOW)!;
    expect('liveness' in old).toBe(false);
    expect(landingHead(old)).toEqual({ right: '1m 20s', isClock: true, detail: 'checking · updated 1m ago' });
  });
});

describe('landingCard', () => {
  it('is the row plus the branch, the job rows and the sentence', () => {
    const running = job({ timedOut: false, retryable: false, heartbeatAt: instant(NOW - 10_000) });
    expect(landingCard(listing([running]), NOW, { updatedAt: NOW })).toEqual({
      word: 'Landing',
      title: 'Landing',
      state: 'fetching',
      running: true,
      timedOut: false,
      what: C5,
      jobs: [{ jobId: 'job-c5', taskId: 'task-c5', word: 'Landing', landingSessionId: null,
        mergeJob: false, title: C5, state: 'fetching', running: true,
        timedOut: false, retryable: false, detail: null }],
      target: `project/${PROJECT}`,
      clock: '110m 26s',
      clockLabel: 'Elapsed',
      wait: null,
      updated: 'Updated just now',
      detail: null,
      retryJobId: null,
      mergeJob: false,
    });
  });

  it('counts several jobs in the head and names each one in the rows', () => {
    const card = landingCard(listing([job({ timedOut: false, retryable: false }), merge()]), NOW, { updatedAt: NOW })!;
    expect(card.title).toBe('Landing 2 jobs');
    expect(card.what).toBeNull();
    expect(card.jobs.map((entry) => [entry.title, entry.state])).toEqual([[C5, 'fetching'], ['Merge to main', 'queued']]);
    // The merge job's own row is a merge's, not a task landing's: its way in is the merge card's.
    expect(card.jobs.map((entry) => entry.mergeJob)).toEqual([false, true]);
    // The head is the lead's, and a promotion lands no single task.
    expect(card.state).toBe('fetching');
    expect(card.running).toBe(true);
  });

  it('takes the timed-out detail and the Retry from the lead job’s own row', () => {
    const card = landingCard(listing([job()]), NOW, { updatedAt: NOW })!;
    expect(card.timedOut).toBe(true);
    expect(card.state).toBe('Timed out');
    expect(card.detail).toBe('Runner workstation-gpu took it at 20:07 · stopped at fetching · no push recorded');
    expect(card.retryJobId).toBe('job-c5');
    // The server's answer, not the timeout's.
    expect(landingCard(listing([job({ retryable: false })]), NOW, { updatedAt: NOW })!.retryJobId).toBeNull();
    // ...and only the LEAD's: the card describes the job in front, not the one behind it.
    const fine = job({ jobId: 'job-t2', taskTitle: 'T2', timedOut: false, retryable: false,
      heartbeatAt: instant(NOW - 5_000) });
    expect(landingCard(listing([fine, job()]), NOW, { updatedAt: NOW })).toMatchObject({
      timedOut: false, state: 'fetching', detail: null, retryJobId: null,
    });
  });

  it('names no branch it cannot find among the project’s landings', () => {
    // A merge check lands no task and is on no branch of the project's own.
    expect(landingCard(listing([job({ kind: 'CHECK_PROMOTION', taskId: null, taskTitle: null })],
      []), NOW, { updatedAt: NOW })!.target).toBeNull();
    // `refs/heads/` is not what a person reads, and a landing that names no ref draws no line.
    expect(landingCard(listing([job({ timedOut: false })], [landed('job-c5', 'main')]), NOW,
      { updatedAt: NOW })!.target).toBe('main');
    expect(landingCard(listing([job({ timedOut: false })], [landed('job-c5', '')]), NOW,
      { updatedAt: NOW })!.target).toBeNull();
  });

  it('marks a card led by a merge into main, from the lead’s own kind', () => {
    // Both merge kinds, listed or not: the flag is read off `inFlight`, so an older server that
    // lists no jobs says it too.
    for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION'] as const) {
      expect(landingCard(listing([merge({ kind })], []), NOW, { updatedAt: NOW })!.mergeJob).toBe(true);
      const older = integration({ inFlight: { taskTitle: null, state: 'QUEUED', kind, startedAt: instant(NOW - 5_000) },
        inFlightJobs: undefined, landTasks: undefined });
      expect(landingCard(older, NOW, { updatedAt: NOW })!.mergeJob).toBe(true);
      // The same server counting two jobs: the card holds more than the merge job.
      const olderTwo = integration({ integratingCount: 1, queuedCount: 1,
        inFlight: { taskTitle: null, state: 'RUNNING', kind, startedAt: instant(NOW - 5_000) },
        inFlightJobs: undefined, landTasks: undefined });
      expect(landingCard(olderTwo, NOW, { updatedAt: NOW })!.mergeJob).toBe(false);
    }
    // A task landing is none, even with a merge queued behind it, and nor is a job of no kind.
    expect(landingCard(listing([job()]), NOW, { updatedAt: NOW })!.mergeJob).toBe(false);
    expect(landingCard(listing([job({ timedOut: false }), merge()]), NOW, { updatedAt: NOW })!.mergeJob).toBe(false);
    expect(landingCard(integration({ inFlight: { taskTitle: null, state: 'RUNNING', startedAt: instant(NOW - 5_000) } }),
      NOW, { updatedAt: NOW })!.mergeJob).toBe(false);
  });

  it('is no card while nothing is landing, and what it can be from an older server', () => {
    expect(landingCard(integration({ inFlight: null, integratingCount: 0, queuedCount: 0 }), NOW)).toBeNull();
    const older = landingCard(integration({ inFlightJobs: undefined, landTasks: undefined }), NOW,
      { updatedAt: NOW })!;
    expect(older.jobs).toEqual([]);
    expect(older.target).toBeNull();
    expect(older.retryJobId).toBeNull();
    expect(older.what).toBe(TITLE);
  });
});

describe('the landing list’s words', () => {
  it('titles the list by how many jobs it holds', () => {
    expect(landingJobsTitle(1)).toBe('1 job in flight');
    expect(landingJobsTitle(2)).toBe('2 jobs in flight');
  });

  it('counts jobs, and how many timed out only when any did', () => {
    expect(landingJobsCount(2, 0)).toBe('2 jobs');
    expect(landingJobsCount(3, 1)).toBe('3 jobs · 1 timed out');
  });

  it('states a limit in whole minutes', () => {
    expect(landingLimit(600)).toBe('limit 10m');
    expect(landingLimit(4200)).toBe('limit 70m');
    expect(landingLimit(630)).toBe('limit 11m');
  });

  it('reads an instant on the reader’s own 24-hour clock', () => {
    expect(landingClockTime(new Date(2026, 8, 25, 9, 5).toISOString())).toBe('09:05');
    expect(landingClockTime(new Date(2026, 8, 25, 22, 15).toISOString())).toBe('22:15');
    expect(landingClockTime('not a date')).toBe('--:--');
  });
});

describe('the landing card, from a server that lists its jobs', () => {
  afterEach(() => vi.useRealTimers());

  /** The header at NOW, its integration read made at NOW too, so the read is fresh. */
  function renderListed(view: ProjectIntegrationView): string {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    qc.setQueryData(integrationKey, view);
    return render(qc);
  }

  it('draws a timed-out job with a still warning mark, and says so in words', () => {
    const html = renderListed(listing([job(), merge()]));
    expect(html).toContain('class="session-project-landing is-timed-out"');
    expect(html).not.toContain('is-running');
    expect(html).toContain('data-glyph="exclamation"');
    expect(html).not.toContain('data-glyph="spinner"');
    expect(html).toContain('>Timed out<');
    expect(html).toContain('>Landing 2 jobs · 1 timed out<');
    expect(html).toMatch(/class="landing-head-detail">No report for \d+m · limit 10m</);
    // Both jobs, one row each, with the lead's own state in the head: nothing on a stopped row
    // spins, and the row says it in the same word the head does.
    expect(html).toContain('class="spl-jobs"');
    expect(html).toContain(`<span>${C5}</span><span class="st">Timed out</span>`);
    // The merge job lands no single task, so its row is named by its word — never left blank.
    expect(html).toContain('<span>Merge to main</span><span class="st">queued</span>');
  });

  it('makes the card a press that opens the list, and keeps it a card to read from an older server', () => {
    expect(renderListed(listing([job(), merge()]))).toMatch(
      /<button type="button" class="spl-press" aria-haspopup="dialog">/,
    );
    // The older server's own report, claimed 80 seconds before NOW. `integration()`'s instants are
    // UTC and NOW is local, so at NOW they are fresh only where the clock is 8+ hours ahead of UTC.
    const older = renderListed(integration({ inFlight: {
      ...integration().inFlight!, startedAt: instant(NOW - 80_000), heartbeatAt: instant(NOW - 80_000),
    } }));
    expect(older).toContain('class="session-project-landing is-running"');
    // No jobs listed, so nothing opens: the card is drawn to read, and there is no "All jobs" to
    // offer either.
    expect(older).toContain('<div class="spl-press">');
    expect(older).not.toContain('All jobs');
  });
});

describe('manual ready work', () => {
  const manual = { count: 1, taskId: 'manual-task', title: 'Check the lock order' };
  function card(over: Partial<React.ComponentProps<typeof ProjectPanoramaCard>> = {}) {
    return renderToStaticMarkup(<MemoryRouter><ProjectPanoramaCard
      panorama={panorama({ ready: 1, running: 0 })} projectId={PROJECT} projectStatus="OPEN"
      started manualReady={manual} {...over}
    /></MemoryRouter>);
  }

  it('offers the named manual task without diagnosing a runner problem, including during landing', () => {
    const html = card({ landing: landingCard(integration(), Date.parse('2026-09-25T13:59:20Z')) });
    expect(html).toContain('Ready to start');
    expect(html).toContain('1 task is set to start manually.');
    expect(html).toContain('can start manually');
    expect(html).toContain('Check the lock order');
    expect(html).toContain(`/projects/${PROJECT}/tasks/manual-task`);
    expect(html).toContain('Open task');
    expect(html).toContain('Landing');
    expect(html).not.toMatch(/Dispatch needs attention|Check providers|var\(--warning-bg\)/);
    // A card handed no way to open the list draws the card to read, not to press.
    expect(html).not.toContain('aria-haspopup');
  });

  it('never infers manual dispatch from totals or a missing old-server field', () => {
    expect(card({ manualReady: null })).not.toContain('Ready to start');
    expect(card({ manualReady: null })).not.toContain('Dispatch needs attention');
    expect(card({ panorama: panorama({ ready: 0 }) })).not.toContain('Ready to start');
    expect(card({ manualReady: { ...manual, count: 8 } })).toContain('8 tasks are set to start manually.');
  });

  it('respects project start, pause, terminal state and public-page visibility', () => {
    for (const over of [{ started: false }, { paused: true }, { projectStatus: 'DONE' as const },
      { projectStatus: 'CANCELLED' as const }, { banners: false }]) {
      expect(card(over)).not.toContain('Ready to start');
    }
    expect(card({ paused: true })).toContain('project is paused');
    expect(card({ started: false })).toContain('starts when you start');
    expect(card({ panorama: panorama({ ready: 1, running: 2 }) })).toContain('Ready to start');
  });
});

describe('the landing card’s styles', () => {
  const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

  it('stops the spin for a reader who asked for less motion, and keeps everything else', () => {
    // The spin is decoration: `checking` and `queued` are the words, and they are text, so the
    // reduced-motion branch removes the animation and nothing else. Read out of the sheet's own
    // reduced-motion blocks rather than the one nearest the rule, since it has others.
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)]
      .map((block) => block[0]);
    const selector = '.landing-head.is-running .landing-head-mark';
    expect(blocks.some((block) => block.includes(selector) && block.includes('animation: none'))).toBe(true);
    expect(css).toContain('@keyframes project-landing-spin');
    // The clock's digits must not shuffle the words beside them as they change.
    expect(css).toMatch(/\.landing-head-right \{[\s\S]*?font-variant-numeric: tabular-nums;/);
    // The tasks get two lines without squeezing the head's line off a phone — the card's title and
    // the jobs list's own.
    expect(css).toMatch(/\.landing-jobs-what \{[\s\S]*?-webkit-line-clamp: 2;/);
    expect(css).toMatch(/\.session-project-landing \.spl-what \{[\s\S]*?-webkit-line-clamp: 2;/);
  });

  it('draws a timed-out row’s mark and words in amber, and never spins it', () => {
    // The spin is a running head's only, and a timed-out one is never drawn as one.
    expect(css).not.toMatch(/\.landing-head\.is-timed-out[^{]*\{[^}]*animation/);
  });

  it('draws the card in the merge card’s shape, and only a running one in brand', () => {
    expect(css).toMatch(/\.session-project-landing \{[\s\S]*?border: 1px solid var\(--border\);[\s\S]*?border-radius: 10px;[\s\S]*?background: var\(--bg-subtle\);/);
    // The brand is a RUNNING job's, as the landing row's own rule has it; a queued card wears the
    // grey the state word does.
    expect(css).toMatch(/\.landing-head\.is-running \.landing-head-mark \{[\s\S]*?background: var\(--brand-tint\);[\s\S]*?color: var\(--brand\);/);
    expect(css).toMatch(/\.landing-head\.is-running \.landing-head-right \{\s*color: var\(--brand\);/);
    // A runner the server judged silent is the merge card's blocked amber, whole.
    expect(css).toMatch(/\.session-project-landing\.is-timed-out \{\s*border-color: var\(--warning-border\);[\s\S]*?background: var\(--warning-bg\);/);
    expect(css).toMatch(/\.landing-head\.is-timed-out \.landing-head-title \{\s*color: var\(--warning\);/);
    expect(css).toMatch(/\.landing-head\.is-timed-out \.landing-head-right \{\s*color: var\(--warning\);/);
    // Retry is the merge card's primary, and the only press the card itself carries.
    expect(css).toMatch(/\.session-project-landing \.spl-primary \{[\s\S]*?background: var\(--brand\);/);
  });
});

describe('the project’s main branch, by name', () => {
  // Work landed on the project's own branch and on its main branch, so all three lanes are drawn.
  const landed = panorama({ done: 3, integrating: 1, onIntegrationLine: 1, onUpstream: 1, doneNotIntegrated: 0 });

  function header(upstreamRef: string) {
    const qc = newClient();
    qc.setQueryData(panoramaKey, landed);
    qc.setQueryData(integrationKey, integration({ upstreamRef, inFlight: null, integratingCount: 0 }));
    return render(qc);
  }

  it('says main in the lanes word for word as before for a project on main', () => {
    const lanes = integrationLanes(landed.buckets, 'PROJECT_BRANCH');
    expect(lanes.find((lane) => lane.key === 'onIntegrationLine')?.footnote).toBe('not on main yet');
    expect(lanes.find((lane) => lane.key === 'onUpstream')).toMatchObject({ label: 'On main', footnote: 'landed on main' });
    expect(integrationLanes(landed.buckets, 'PROJECT_BRANCH', 'main')).toEqual(lanes);
    const html = header('main');
    for (const words of ['On main', 'landed on main', 'not on main yet']) expect(html).toContain(words);
  });

  it('names master in the lanes, off the integration read, for a project on master', () => {
    const lanes = integrationLanes(landed.buckets, 'PROJECT_BRANCH', 'master');
    expect(lanes.find((lane) => lane.key === 'onIntegrationLine')?.footnote).toBe('not on master yet');
    expect(lanes.find((lane) => lane.key === 'onUpstream')).toMatchObject({ label: 'On master', footnote: 'landed on master' });
    const html = header('master');
    for (const words of ['On master', 'landed on master', 'not on master yet']) expect(html).toContain(words);
    expect(html).not.toContain('on main');
    // A public page carries no read that names the branch, and says main.
    const shared = renderToStaticMarkup(
      <MemoryRouter><ProjectPanoramaCard panorama={landed} integrationLine="PROJECT_BRANCH" banners={false} /></MemoryRouter>,
    );
    expect(shared).toContain('On main');
  });

  it('names the branch a merge goes into and a sync takes in, and nothing else', () => {
    expect(jobWords()).toEqual(JOB_WORDS);
    expect(jobWords('main')).toEqual({
      LAND_TASK: 'Landing', CHECK_PROMOTION: 'Merge check', LAND_PROMOTION: 'Merge to main', OBSERVE_LANDING: 'Observation',
    });
    expect(jobWords('master')).toEqual({ ...JOB_WORDS, LAND_PROMOTION: 'Merge to master' });
    expect(jobPhases()).toEqual(JOB_PHASES);
    expect(jobPhases('main').MAIN_SYNC).toBe('syncing main');
    expect(jobPhases('master')).toEqual({ ...JOB_PHASES, MAIN_SYNC: 'syncing master' });
  });

  it('says the landing row’s merge and sync of master for a project on master, and of main as before', () => {
    const merging = (upstreamRef: string) => integration({ upstreamRef, inFlight: {
      taskTitle: null, kind: 'LAND_PROMOTION', phase: null, state: 'QUEUED', startedAt: instant(NOW - 60_000), heartbeatAt: null,
    } });
    const syncing = (upstreamRef: string) => integration({ upstreamRef, inFlight: {
      taskTitle: 'T2', kind: 'LAND_TASK', phase: 'MAIN_SYNC', state: 'RUNNING', startedAt: instant(NOW - 60_000),
      heartbeatAt: instant(NOW - 5_000),
    } });
    expect(landingLine(merging('main'), NOW, { updatedAt: NOW })?.word).toBe('Merge to main');
    expect(landingLine(merging('master'), NOW, { updatedAt: NOW })?.word).toBe('Merge to master');
    expect(landingLine(syncing('main'), NOW, { updatedAt: NOW })?.state).toBe('syncing main');
    expect(landingLine(syncing('master'), NOW, { updatedAt: NOW })?.state).toBe('syncing master');
    // The list the row opens says the same, and so does a timed-out job's "stopped at".
    const onMaster = (jobs: ProjectIntegrationJob[]) => ({ ...listing(jobs), upstreamRef: 'master' });
    expect(landingJobLines(onMaster([merge()]), NOW, { updatedAt: NOW })[0].line.word).toBe('Merge to master');
    expect(landingJobLines(onMaster([job({ phase: 'MAIN_SYNC' })]), NOW, { updatedAt: NOW })[0].detail)
      .toBe('Runner workstation-gpu took it at 20:07 · stopped at syncing master · no push recorded');
    expect(landingJobLines(listing([job({ phase: 'MAIN_SYNC' })]), NOW, { updatedAt: NOW })[0].detail)
      .toBe('Runner workstation-gpu took it at 20:07 · stopped at syncing main · no push recorded');
  });
});
