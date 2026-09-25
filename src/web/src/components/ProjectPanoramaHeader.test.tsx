import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIntegrationView } from '@orbit/shared';
import {
  PANORAMA_BUCKETS,
  ProjectPanoramaHeader,
  landingClock,
  landingLine,
  stalledOnReady,
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
    expect(stalledOnReady(panorama({ running: 2 }).buckets)).toBe(false);
    expect(stalledOnReady(panorama().buckets)).toBe(true);
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
      ['warning-solid', '4'],
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

  it('renders the loading and error states, and neither throws', () => {
    // Loading: nothing seeded, so the query is pending with its fetch not yet dispatched.
    const loading = render(newClient());
    expect(loading).toContain('Work overview');
    expect(loading).toContain('ant-spin');
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
  // The report this card was specified against: T2, claimed at 13:58:00.
  inFlight: { taskTitle: 'T2 wiki 契約、迁移与共享类型', state: 'RUNNING', startedAt: '2026-09-25T13:58:00Z' },
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
      seeded(integration({ inFlight: { taskTitle: null, state: 'RUNNING', startedAt: 'not a date' } })),
      '2026-09-25T13:59:20Z',
    );
    expect(html).toContain('>0m 0s<');
    expect(html).not.toContain('NaN');
    // A job that names no task — a promotion, a merge check — keeps the row's word and state.
    expect(html).toContain('>Landing<');
    expect(html).toContain('>checking<');
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
      what: 'T2 wiki 契約、迁移与共享类型',
      running: true,
      state: 'checking',
      clock: '1m 20s',
    });
    expect(
      landingLine(
        integration({ inFlight: { taskTitle: 'T1', state: 'QUEUED', startedAt: '2026-09-25T13:58:40Z' } }),
        now,
      ),
    ).toEqual({ what: 'T1', running: false, state: 'queued', clock: '0m 40s' });
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
    // One row, always: the task title truncates rather than wrapping the card taller.
    expect(css).toMatch(/\.project-landing-what \{[\s\S]*?text-overflow: ellipsis;/);
  });
});

