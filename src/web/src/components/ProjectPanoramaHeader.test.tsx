import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  PANORAMA_BUCKETS,
  ProjectPanoramaHeader,
  stalledOnReady,
  topRefusals,
  type DispatchHealth,
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
const healthKey = ['project', PROJECT, 'panorama', 'dispatch-health'];

function newClient() {
  // refetchOnMount/retryOnMount:false keep a seeded entry (success OR error) from being treated as
  // needing a fresh fetch on this mount — these assertions are about what is already in cache.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

function render(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectPanoramaHeader projectId={PROJECT} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The deployment's own numbers, from the report this card was specified against. */
const panorama = (over: Partial<ProjectPanorama['buckets']> = {}, shape: Partial<ProjectPanorama['shape']> = {}): ProjectPanorama => ({
  buckets: { running: 0, ready: 4, blocked: 30, done: 5, cancelled: 0, ...over },
  shape: { taskCount: 39, edgeCount: 41, ratio: 41 / 39, maxDepth: 12, form: 'chain', ...shape },
});

const health = (over: Partial<DispatchHealth> = {}): DispatchHealth => ({
  windowHours: 24,
  dispatch: { applied: 47, refused: 361 },
  // Server-ordered by count descending, which is the order the card is required to keep.
  refusals: [
    { refusalCode: 'PROVIDER_UNAVAILABLE', count: 318, lastSeenAt: '2026-08-22T09:00:00.000Z' },
    { refusalCode: 'WHO_NOT_IN_TEAM', count: 36, lastSeenAt: '2026-08-22T08:00:00.000Z' },
    { refusalCode: 'STALE_SNAPSHOT', count: 6, lastSeenAt: '2026-08-22T07:00:00.000Z' },
    { refusalCode: 'UNSPECIFIED', count: 1, lastSeenAt: '2026-08-22T06:00:00.000Z' },
  ],
  openBlockers: [],
  ...over,
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
    for (const label of ['Running', 'Ready', 'Blocked', 'Done']) expect(html).toContain(label);
    // ...and every number, as visible text in its cell rather than only inside the meter's label.
    const cells = [...html.matchAll(/font-size:29px[^"]*">(\d+)<\/div>/g)].map((m) => m[1]);
    expect(cells).toEqual(['0', '4', '30', '5']);

    // The whole point of the card: 4 and 30 are two numbers, and the 34 that today's `OPEN` tally
    // would report in their place appears nowhere.
    expect(html).not.toContain('OPEN');
    expect(cells).not.toContain('34');
    // Each number says what it counts, so "4" is not a bare figure the reader has to interpret.
    expect(html).toContain('unblocked, not dispatched');
    expect(html).toContain('waiting on prerequisites');
    expect(html).toContain('13% of 39'); // 5 of 39 tasks
  });

  it('does not raise the banner when something is running, however much is ready', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama({ running: 2 }));
    qc.setQueryData(healthKey, health()); // the refusals are in cache and must still not be shown
    const html = render(qc);

    expect(html).not.toContain('ready, 0 running');
    expect(html).not.toContain('PROVIDER_UNAVAILABLE');
    expect(html).not.toContain('Check providers');
    // ...and the Ready cell drops its amber with it: nothing on this card is asking for attention.
    expect(html).not.toContain('var(--warning-bg)');
    expect(stalledOnReady(panorama({ running: 2 }).buckets)).toBe(false);
    expect(stalledOnReady(panorama().buckets)).toBe(true);
  });

  it('separates the four buckets by shape, not by colour alone', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    const html = render(qc);

    const marks = glyphs(html);
    expect(marks).toHaveLength(4);
    // Pairwise distinct as whole marks — a repeated shape in a different colour would collapse here.
    expect(new Set(marks).size).toBe(4);
    // ...and distinct in the shape channel specifically, which is what survives CVD and greyscale.
    const shapes = marks.map((mark) => mark.match(/data-glyph="([^"]*)"/)![1]);
    expect(shapes).toEqual(['disc', 'triangle', 'square', 'check']);
    // The geometry backs each name: a filled disc, a right-pointing triangle, a HOLLOW square
    // (stroked, not filled — the one pair that could otherwise read alike at 12px), and a check.
    expect(marks[0]).toContain('<circle');
    expect(marks[1]).toContain('<polygon');
    expect(marks[2]).toMatch(/<rect[^>]*fill="none"/);
    expect(marks[3]).toContain('<path');

    // Colour is a SECOND channel and the tokens are the measured ones: Done wears --success (not
    // --success-solid, ΔE 2.4 from amber under protanopia) and Blocked wears a neutral.
    expect(PANORAMA_BUCKETS.map((bucket) => bucket.color)).toEqual([
      'var(--brand)',
      'var(--warning-solid)',
      'var(--text-3)',
      'var(--success)',
    ]);
    expect(new Set(PANORAMA_BUCKETS.map((bucket) => bucket.color)).size).toBe(4);
    // Each bucket's accessible name is its own word, so the four cells never rely on the swatch.
    expect(new Set(PANORAMA_BUCKETS.map((bucket) => bucket.label)).size).toBe(4);
  });

  it('gives the meter a role and an aria-label carrying all four numbers', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama());
    const html = render(qc);

    expect(meterAttr(html, 'role')).toBe('img');
    expect(meterAttr(html, 'aria-label')).toBe('Task status: 0 running, 4 ready, 30 blocked, 5 done');

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

    expect(meterAttr(html, 'aria-label')).toBe('Task status: 0 running, 0 ready, 0 blocked, 0 done');
    expect(html).toContain('var(--fill-muted)');
    expect(html).toContain('no tasks yet'); // not "NaN% of 0"
    expect(html).not.toContain('NaN');
  });

  it('renders the loading and error states, and neither throws', () => {
    // Loading: nothing seeded, so the query is pending with its fetch not yet dispatched.
    const loading = render(newClient());
    expect(loading).toContain('Where the work stands');
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
