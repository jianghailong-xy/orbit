import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_MAX_SEGMENTS,
  CHAIN_RANKING_LIMIT,
  ProjectChainProgress,
  chainPosition,
  chainSegments,
  type ProjectBlockingLeaderboard,
  type ProjectPanorama,
} from './ProjectChainProgress';

// react-query never dispatches a fetch during a static (effect-free) render, so these tests seed
// the cache instead of letting a request run — the arrangement ProjectPanoramaHeader.test.tsx and
// ProjectsPage.test.tsx use. The stub is the backstop that would make an accidental live call
// visible as a failure rather than a hang; the source-level check below is what fixes the URLs.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const source = readFileSync(fileURLToPath(new URL('./ProjectChainProgress.tsx', import.meta.url)), 'utf8');

const PROJECT = '34BdLWSvNefueJBjdxJ7n';

// Both keys spelled out rather than imported from the component: a key the component changes
// unilaterally has to break these tests, which it cannot do if both sides read one constant. They
// are also the keys the header and leaderboard cards use, which is what makes the three share two
// requests instead of making four.
const panoramaKey = ['project', PROJECT, 'panorama'];
const rankingKey = ['project', PROJECT, 'panorama', 'blocking', CHAIN_RANKING_LIMIT];

function newClient() {
  // refetchOnMount/retryOnMount:false keep a seeded entry from being treated as needing a fresh
  // fetch on this mount — these assertions are about what is already in cache.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

function render(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProjectChainProgress projectId={PROJECT} />
    </QueryClientProvider>,
  );
}

/**
 * The deployment's largest project: 118 tasks, 117 edges, one after another.
 *
 * `maxDepth` is stated at the 118 the task specifies and is deliberately NOT what the strip counts
 * in — see the first test, which moves it without moving the reading.
 */
const panorama = (done: number, over: Partial<ProjectPanorama['shape']> = {}): ProjectPanorama => ({
  buckets: { running: 1, ready: 0, blocked: 118 - done - 1, done, cancelled: 0 },
  shape: { taskCount: 118, edgeCount: 117, ratio: 117 / 118, maxDepth: 118, form: 'chain', ...over },
});

/**
 * The blocking ranking, server-ordered by `downstreamBlocked` descending.
 *
 * On a chain that order IS the remaining order — each task holds up exactly the ones after it — so
 * the first two rows are the step in progress and the step after it.
 */
const ranking = (settled: number): ProjectBlockingLeaderboard => {
  const remaining = 118 - settled;
  return {
    remainingCount: remaining,
    items: Array.from({ length: Math.min(CHAIN_RANKING_LIMIT, Math.max(0, remaining - 1)) }, (_, i) => ({
      taskId: `task-${settled + i + 1}`,
      title: `Step ${settled + i + 1}: migrate the LFS shard`,
      status: i === 0 ? 'IN_PROGRESS' : 'OPEN',
      downstreamBlocked: remaining - 1 - i,
    })),
    truncated: null,
  };
};

/** Every `data-segment` state in the bar, in document order. */
function segments(html: string): string[] {
  return [...html.matchAll(/data-segment="([^"]*)"/g)].map((m) => m[1]);
}

/** Every block of the bar as `[state, height]`, so the shape channel can be read off the markup. */
function segmentHeights(html: string): Array<[string, string]> {
  return [...html.matchAll(/<span data-segment="([^"]*)"[^>]*height:(\d+px)/g)].map((m) => [m[1], m[2]]);
}

/** The value of one attribute on the bar's own element. */
function barAttr(html: string, attr: string): string | undefined {
  const bar = html.match(/<div[^>]*role="img"[^>]*>/)?.[0];
  return bar?.match(new RegExp(`${attr}="([^"]*)"`))?.[1];
}

describe('ProjectChainProgress', () => {
  it('reads exactly the panorama and blocking endpoints, and nothing else', () => {
    // A static render never invokes queryFn, so this asserts on the one place the URLs are decided.
    // Fails if a path changes, if a third endpoint appears, or if the ranking limit stops matching
    // the leaderboard card's default — which is what keeps the two cards on one request.
    const calls = [...source.matchAll(/\bapi(?:<[^>]*>)?\(\s*(`[^`]*`)/g)].map((m) => m[1]);
    expect(calls).toEqual([
      '`/projects/${encodeURIComponent(projectId)}/panorama`',
      '`/projects/${encodeURIComponent(projectId)}/panorama/blocking?limit=${CHAIN_RANKING_LIMIT}`',
    ]);
    expect(CHAIN_RANKING_LIMIT).toBe(5);
  });

  it('counts steps in TASKS, never in the segments it draws or in maxDepth', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama(0));
    qc.setQueryData(rankingKey, ranking(0));
    const html = render(qc);

    // The reading the task specifies: 118 tasks, nothing settled, so the chain is on step 1 of 118.
    expect(html).toContain('Step 1 / 118');

    // ...and the bar it is drawn above holds FEWER blocks than that, which is the whole point of
    // the assertion: an implementation that numbered steps by segment would read `/ 48` here.
    const drawn = segments(html);
    expect(drawn).toHaveLength(CHAIN_MAX_SEGMENTS);
    expect(drawn.length).toBeLessThan(118);
    expect(html).not.toContain(`/ ${CHAIN_MAX_SEGMENTS}`);

    // Nor is the denominator `maxDepth`: that field counts EDGES (117 on this chain, and less than
    // that wherever two tasks share a level), so moving it must not move the reading.
    const shallow = newClient();
    shallow.setQueryData(panoramaKey, panorama(0, { maxDepth: 110 }));
    shallow.setQueryData(rankingKey, ranking(0));
    expect(render(shallow)).toContain('Step 1 / 118');
  });

  it('names the step in progress and the one after it', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama(40));
    qc.setQueryData(rankingKey, ranking(40));
    const html = render(qc);

    expect(html).toContain('Step 41 / 118');
    // Both names, as visible text — the ranking's first two rows in the order the server gave them.
    expect(html).toContain('Step 41: migrate the LFS shard');
    expect(html).toContain('Next →');
    expect(html).toContain('Step 42: migrate the LFS shard');
    // ...and nothing further down the ranking, which belongs to the leaderboard card, not here.
    expect(html).not.toContain('Step 43: migrate the LFS shard');
  });

  it('fills the bar in proportion to the real steps, not to the ranking or the block count', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama(40));
    qc.setQueryData(rankingKey, ranking(40));
    const drawn = segments(render(qc));

    const done = drawn.filter((state) => state === 'done').length;
    expect(Math.abs(done / drawn.length - 40 / 118)).toBeLessThanOrEqual(0.02);

    // Exactly one block is the frontier, and it sits immediately after the finished ones.
    expect(drawn.filter((state) => state === 'current')).toHaveLength(1);
    expect(drawn.indexOf('current')).toBe(done);
  });

  it('renders nothing at all for a mesh project', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, {
      buckets: { running: 1, ready: 3, blocked: 12, done: 8, cancelled: 0 },
      shape: { taskCount: 24, edgeCount: 49, ratio: 49 / 24, maxDepth: 6, form: 'mesh' },
    } satisfies ProjectPanorama);
    qc.setQueryData(rankingKey, ranking(8));

    // The node-link view takes over there, and two views of one graph on one page is the thing
    // this component exists to avoid.
    expect(render(qc)).toBe('');
  });

  it('stops at the last step: no next, and no step number past the total', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama(117));
    // A task that blocks nothing is absent from the ranking by design, so the last step of a chain
    // is unnamed — the position still has to be right.
    qc.setQueryData(rankingKey, ranking(117));
    const html = render(qc);

    expect(html).toContain('Step 118 / 118');
    expect(html).not.toContain('Next');
    expect(html).not.toContain('119');

    // And once it lands, the strip says so rather than inventing a 119th step to sit on.
    const finished = newClient();
    finished.setQueryData(panoramaKey, panorama(118));
    finished.setQueryData(rankingKey, ranking(118));
    const done = render(finished);
    expect(done).toContain('All 118 steps complete');
    expect(done).not.toContain('Step 119');
    expect(segments(done).every((state) => state === 'done')).toBe(true);
  });

  it('carries the position on the bar itself for a reader who gets no picture', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, panorama(40));
    qc.setQueryData(rankingKey, ranking(40));
    const html = render(qc);

    expect(barAttr(html, 'role')).toBe('img');
    const label = barAttr(html, 'aria-label') ?? '';
    expect(label).toContain('41');
    expect(label).toContain('118');
    expect(label).toMatch(/step 41 of 118/);

    // Colour is not the only channel: the frontier block stands taller than the rest, so it is
    // findable without reading the hue.
    const heights = segmentHeights(html);
    const tall = heights.filter(([, height]) => height === '13px');
    expect(tall).toEqual([['current', '13px']]);
    expect(heights.filter(([state]) => state !== 'current').every(([, height]) => height === '9px')).toBe(true);
  });

  it('cancelled steps count as settled, so the chain does not park on one', () => {
    const qc = newClient();
    qc.setQueryData(panoramaKey, {
      ...panorama(40),
      buckets: { running: 1, ready: 0, blocked: 75, done: 40, cancelled: 2 },
    });
    qc.setQueryData(rankingKey, ranking(42));
    // Nothing waits on a cancelled task, so it is behind the frontier exactly like a finished one.
    expect(render(qc)).toContain('Step 43 / 118');
  });

  it('renders nothing, and throws nothing, while unread or on a failed read', () => {
    expect(render(newClient())).toBe('');

    const failed = newClient();
    // The panorama read this strip gates on is the header card's read: its failure is reported
    // there, and a second error strip for one failure would be noise.
    failed.setQueryData(panoramaKey, undefined);
    failed.getQueryCache().build(failed, { queryKey: panoramaKey }).setState({
      status: 'error',
      error: new Error('boom'),
    });
    expect(render(failed)).toBe('');

    // A failed RANKING is different: the numbers come from the panorama, so the strip still reads.
    const noNames = newClient();
    noNames.setQueryData(panoramaKey, panorama(40));
    expect(render(noNames)).toContain('Step 41 / 118');

    // An empty project has no step to be on.
    const empty = newClient();
    empty.setQueryData(panoramaKey, {
      buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0 },
      shape: { taskCount: 0, edgeCount: 0, ratio: 0, maxDepth: 0, form: 'chain' },
    } satisfies ProjectPanorama);
    expect(render(empty)).toBe('');
  });

  it('keeps a frontier block until the chain is actually finished', () => {
    // 117 of 118 rounds to "all 48 blocks done"; a bar with nothing current would report a project
    // with a task left in it as finished.
    const position = chainPosition({ running: 1, ready: 0, blocked: 0, done: 117, cancelled: 0 }, {
      taskCount: 118,
      edgeCount: 117,
      ratio: 117 / 118,
      maxDepth: 117,
      form: 'chain',
    });
    const bar = chainSegments(position);
    expect(bar).toEqual({ count: 48, done: 47, current: 47 });

    // One block per step while the chain is short enough to draw honestly.
    const short = chainPosition({ running: 1, ready: 0, blocked: 4, done: 5, cancelled: 0 }, {
      taskCount: 10,
      edgeCount: 9,
      ratio: 0.9,
      maxDepth: 9,
      form: 'chain',
    });
    expect(chainSegments(short)).toEqual({ count: 10, done: 5, current: 5 });

    const withFailedHistory = chainPosition({
      running: 1, ready: 0, blocked: 3, awaitingVerification: 0,
      done: 5, failed: 1, cancelled: 0,
    }, {
      taskCount: 10,
      edgeCount: 9,
      ratio: 0.9,
      maxDepth: 9,
      form: 'chain',
    });
    expect(withFailedHistory).toMatchObject({ settled: 6, position: 7, complete: false });
  });
});
