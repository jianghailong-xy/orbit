import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIntegrationJob, ProjectIntegrationView } from '@orbit/shared';
import {
  PANORAMA_BUCKETS,
  ProjectPanoramaHeader,
  ProjectPanoramaCard,
  integrationLanes,
  landingClock,
  landingClockTime,
  landingJobLines,
  landingJobsCount,
  landingJobsTitle,
  landingLimit,
  landingLine,
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
  inFlight: { taskTitle: 'T2 wiki 契約、迁移与共享类型', state: 'RUNNING', kind: 'LAND_TASK', phase: 'CHECK',
    startedAt: '2026-09-25T13:58:00Z', heartbeatAt: '2026-09-25T13:58:00Z' },
  ...over,
});

describe('the landing row', () => {
  // The clock is read off `now`, so the render has to be told what time it is: the whole point of
  // the row is the number, and "about a minute" is not what the mock says.
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

  it('draws the approved checking line: the ring spins, and the clock counts seconds', () => {
    // 80 seconds after the claim — the mock's own 1m 20s.
    const html = renderAt(seeded(), '2026-09-25T13:59:20Z');

    expect(html).toContain('class="project-landing project-landing-running"');
    expect(html).toContain('>Landing<');
    expect(html).toContain('T2 wiki 契約、迁移与共享类型');
    expect(html).toContain('>checking<');
    expect(html).toContain('>1m 20s<');
    // The ring is the Integrating cell's own mark rather than a second spinner drawing, and it
    // inherited the row's colour rather than carrying one of its own.
    expect(html).toContain('data-glyph="spinner"');
  });

  it('draws the approved queued line: grey and still, and counting from the enqueue', () => {
    const html = renderAt(
      seeded(integration({
        integratingCount: 0,
        queuedCount: 1,
        inFlight: { taskTitle: 'T2 wiki 契約、迁移与共享类型', state: 'QUEUED',
                    startedAt: '2026-09-25T13:58:40Z' },
      })),
      '2026-09-25T13:59:20Z',
    );

    expect(html).toContain('class="project-landing"');
    expect(html).not.toContain('project-landing-running');
    expect(html).toContain('>queued<');
    expect(html).toContain('>0m 40s<');
  });

  it('names the count rather than one task when several are in flight', () => {
    const html = renderAt(
      seeded(integration({ integratingCount: 2, queuedCount: 1 })),
      '2026-09-25T13:59:20Z',
    );
    expect(html).toContain('>3 jobs<');
    expect(html).not.toContain('T2 wiki');
  });

  it('draws no row at all while nothing is landing', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    qc.setQueryData(integrationKey, integration({ integratingCount: 0, queuedCount: 0, inFlight: null }));
    expect(renderAt(qc, '2026-09-25T13:59:20Z')).not.toContain('project-landing');

    // ...including when the integration read never answered: the card is the panorama's, and a row
    // it cannot draw is absent rather than blank.
    const only = newClient();
    only.setQueryData(panoramaKey, panorama());
    expect(renderAt(only, '2026-09-25T13:59:20Z')).not.toContain('project-landing');
  });

  it('counts a job the server cannot date from zero rather than printing NaN', () => {
    const html = renderAt(
      seeded(integration({ inFlight: { taskTitle: null, state: 'RUNNING', startedAt: 'not a date',
        heartbeatAt: '2026-09-25T13:59:00Z' } })),
      '2026-09-25T13:59:20Z',
    );
    expect(html).toContain('>0m 0s<');
    expect(html).not.toContain('NaN');
    // A job that names no task — a promotion, a merge check — keeps the row's word and state.
    expect(html).toContain('>Integration<');
    expect(html).toContain('>running<');
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

/** The view of a server that lists its jobs: the counts count them, and `inFlight` is the first. */
const listing = (jobs: ProjectIntegrationJob[]): ProjectIntegrationView => integration({
  integratingCount: jobs.filter((entry) => entry.state === 'RUNNING').length,
  queuedCount: jobs.filter((entry) => entry.state === 'QUEUED').length,
  inFlight: jobs[0] ? {
    taskTitle: jobs[0].taskTitle, kind: jobs[0].kind, phase: jobs[0].phase, state: jobs[0].state,
    startedAt: jobs[0].startedAt, heartbeatAt: jobs[0].heartbeatAt,
  } : null,
  inFlightJobs: jobs,
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

describe('the landing row, from a server that lists its jobs', () => {
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
    expect(html).toContain('class="project-landing project-landing-timed-out"');
    expect(html).not.toContain('project-landing-running');
    expect(html).toContain('data-glyph="exclamation"');
    expect(html).not.toContain('data-glyph="spinner"');
    for (const text of ['>Timed out<', '>2 jobs · 1 timed out<', '>110m<', '>limit 10m<']) expect(html).toContain(text);
    expect(html).toContain('No report for');
  });

  it('makes the row a button that opens the list, and keeps it a line to read from an older server', () => {
    expect(renderListed(listing([job(), merge()]))).toMatch(
      /<button type="button" class="project-landing-press" aria-haspopup="dialog"><div class="project-landing project-landing-timed-out">/,
    );
    const older = renderListed(integration());
    expect(older).toContain('class="project-landing project-landing-running"');
    expect(older).not.toContain('project-landing-press');
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
    const html = card({ landing: landingLine(integration(), Date.parse('2026-09-25T13:59:20Z')) });
    expect(html).toContain('Ready to start');
    expect(html).toContain('1 task is set to start manually.');
    expect(html).toContain('can start manually');
    expect(html).toContain('Check the lock order');
    expect(html).toContain(`/projects/${PROJECT}/tasks/manual-task`);
    expect(html).toContain('Open task');
    expect(html).toContain('Landing');
    expect(html).not.toMatch(/Dispatch needs attention|Check providers|var\(--warning-bg\)/);
    // A card handed no way to open the list draws the row to read, not to press.
    expect(html).not.toContain('project-landing-press');
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

describe('the landing row’s styles', () => {
  const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

  it('stops the spin for a reader who asked for less motion, and keeps everything else', () => {
    // The spin is decoration: `checking` and `queued` are the words, and they are text, so the
    // reduced-motion branch removes the animation and nothing else. Read out of the sheet's own
    // reduced-motion blocks rather than the one nearest the rule, since it has others.
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)]
      .map((block) => block[0]);
    expect(blocks.some((block) => block.includes('.project-landing-running .project-landing-ring')
      && block.includes('animation: none'))).toBe(true);
    expect(css).toContain('@keyframes project-landing-spin');
    // The clock's digits must not shuffle the words beside them as they change.
    expect(css).toMatch(/\.project-landing-clock \{[\s\S]*?font-variant-numeric: tabular-nums;/);
    // The task gets two lines without squeezing the phase or elapsed time off a phone.
    expect(css).toMatch(/\.project-landing-what \{[\s\S]*?-webkit-line-clamp: 2;/);
  });

  it('draws a timed-out row’s mark and words in amber, and never spins it', () => {
    expect(css).toMatch(/\.project-landing-timed-out \.project-landing-ring \{\s*color: var\(--warning-solid\);/);
    expect(css).toMatch(/\.project-landing-timed-out \.project-landing-clock \{\s*color: var\(--warning\);/);
    // The spin is a running row's only, and a timed-out row is never drawn as one.
    expect(css).not.toMatch(/\.project-landing-timed-out[^{]*\{[^}]*animation/);
  });
});
