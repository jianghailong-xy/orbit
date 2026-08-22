import { queryOptions, useQuery } from '@tanstack/react-query';
import { Typography } from 'antd';
import { api } from '../api';

/**
 * A chain-shaped project as one line: which step it is on, and what comes after.
 *
 * Orbit's projects come in two topologies and one picture does not serve both. Most of them are
 * chains — the largest in the deployment is 118 tasks joined by 117 edges, and Coordinator (58/60)
 * and iOS Project (39/41) are the same shape. Drawing 118 nodes and 117 edges of a straight line
 * is a picture of nothing: every node has one predecessor and one successor, so the drawing spends
 * a whole viewport restating what "a chain" already said. What a reader of a chain wants is three
 * numbers and two names — how far along, what is happening now, what is next — which is this
 * strip. The node-link view stays for `form === 'mesh'`, where the edges really are the subject;
 * this component renders NOTHING there, so the two are never both on the page.
 *
 * WHAT A STEP IS. One task, one step: `shape.taskCount` is the denominator and the number of
 * settled tasks is how far along it is. It is deliberately not `maxDepth` (a count of EDGES, one
 * short of the tasks on a chain, and shorter still where two tasks share a level) and deliberately
 * not the number of segments the bar happens to draw — a 118-step chain is drawn in 48 segments
 * and still reads `/ 118`, because a step number the reader cannot match to the task list is worse
 * than no step number.
 *
 * CANCELLED COUNTS AS SETTLED. A cancelled step is one the chain does not wait for, so it is
 * behind the frontier exactly like a finished one. Counting only DONE would park the reading at a
 * step nobody will ever complete.
 *
 * WHERE THE TWO NAMES COME FROM. The blocking ranking, which is the same read the leaderboard card
 * makes (identical key, so mounting both costs one request). On a chain that ranking IS the
 * remaining order: every unfinished task holds up exactly the tasks after it, so the head of the
 * chain blocks the most and the ranking descends along the line. `items[0]` is therefore the step
 * in progress and `items[1]` the one after it. The ranking thins out at the very end — a task that
 * blocks nothing is absent from it by design — and the last step is consequently unnamed, which is
 * why the numbers come from the panorama and never from this read: the position stays right after
 * the names run out.
 *
 * SILENT WHILE UNREAD AND ON FAILURE. Every other state renders nothing at all. The panorama read
 * this strip gates on is the same one the header card above it makes, so a failure is already
 * reported there in full — a second error strip would be one failure said twice, and a skeleton
 * would flash a chain widget onto a project that turns out to be a mesh.
 */

/** @see `ProjectPanoramaBuckets` in `src/apiserver/src/projects/project-panorama.ts`. */
export interface ProjectPanoramaBuckets {
  running: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
}

/** The project's dependency graph as three numbers and the verdict drawn from them. */
export interface ProjectPanoramaShape {
  taskCount: number;
  edgeCount: number;
  ratio: number;
  /** Length in EDGES of the longest dependency path, so a 10-task chain reports 9. */
  maxDepth: number;
  form: 'chain' | 'mesh';
}

export interface ProjectPanorama {
  buckets: ProjectPanoramaBuckets;
  shape: ProjectPanoramaShape;
}

/** One entry of the blocking ranking: an unfinished task and how much waits behind it. */
export interface ProjectBlockingItem {
  taskId: string;
  title: string;
  status: string;
  downstreamBlocked: number;
}

export interface ProjectBlockingLeaderboard {
  remainingCount: number;
  /** Highest `downstreamBlocked` first; tasks blocking nothing are absent rather than listed at 0. */
  items: ProjectBlockingItem[];
  truncated: { reason: string; maxTasks: number } | null;
}

/**
 * Both reads are keyed exactly as the header and leaderboard cards key them, so a page carrying
 * all three makes two requests rather than four. Declared here rather than imported from either
 * card because this one has to be mountable — and testable — on its own.
 */
export const projectChainPanoramaQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama'] as const,
    queryFn: () => api<ProjectPanorama>(`/projects/${encodeURIComponent(projectId)}/panorama`),
    refetchInterval: 30_000,
  });

/** The leaderboard card's own default depth, so the two cards share one cache entry. Two names is
 *  all this strip reads, and asking for a shorter ranking would buy a second request instead. */
export const CHAIN_RANKING_LIMIT = 5;

export const projectChainRankingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama', 'blocking', CHAIN_RANKING_LIMIT] as const,
    queryFn: () =>
      api<ProjectBlockingLeaderboard>(
        `/projects/${encodeURIComponent(projectId)}/panorama/blocking?limit=${CHAIN_RANKING_LIMIT}`,
      ),
    refetchInterval: 30_000,
  });

/**
 * How many blocks the bar is drawn in at most.
 *
 * Past this a segment is thinner than the gap between segments and the bar reads as a texture
 * rather than as steps. Above the cap the segments AGGREGATE — 118 steps into 48 blocks, about
 * two and a half steps each — and the aggregation touches nothing but the drawing: `Step N / M`
 * is computed from the task counts, never from the blocks.
 */
export const CHAIN_MAX_SEGMENTS = 48;

/** Where the chain stands: how many steps are behind the frontier, and which step that makes. */
export interface ChainPosition {
  total: number;
  settled: number;
  /** 1-based, and never past `total` — on a finished chain it is `total` and `complete` is set. */
  position: number;
  complete: boolean;
}

/** Exported for tests: the arithmetic behind `Step N / M`, with nothing to render around it. */
export function chainPosition(buckets: ProjectPanoramaBuckets, shape: ProjectPanoramaShape): ChainPosition {
  const total = shape.taskCount;
  // Clamped because the two numbers come from one row of one aggregate but the render outlives it:
  // a step count above the total is the one thing this strip must never print.
  const settled = Math.min(total, buckets.done + buckets.cancelled);
  const complete = total > 0 && settled >= total;
  return { total, settled, position: complete ? total : settled + 1, complete };
}

/** The bar as blocks: how many there are, how many are behind the frontier, and which one is it. */
export interface ChainSegments {
  count: number;
  done: number;
  /** Index of the block the current step falls in, or `null` on a finished chain. */
  current: number | null;
}

/**
 * Exported for tests: `done / count` tracks `settled / total` to within one block, whatever the
 * aggregation. The one adjustment is at the top end — a chain 47.6 blocks along out of 48 rounds
 * to "all of them", and a bar with no current block on a project that still has work left would
 * report it finished. The block is taken back from `done`, so the highlight is always the step the
 * text names.
 */
export function chainSegments(position: ChainPosition, maxSegments = CHAIN_MAX_SEGMENTS): ChainSegments {
  const count = Math.max(1, Math.min(position.total, maxSegments));
  if (position.complete) return { count, done: count, current: null };
  const scaled = position.total === 0 ? 0 : Math.round((position.settled / position.total) * count);
  const done = Math.min(scaled, count - 1);
  return { count, done, current: done };
}

/** What a screen reader gets in place of the bar. Carries N and M, which the blocks cannot. */
export function chainProgressLabel(position: ChainPosition): string {
  if (position.complete) {
    return `Chain progress: all ${position.total} of ${position.total} steps complete`;
  }
  const remaining = position.total - position.settled;
  return `Chain progress: step ${position.position} of ${position.total}, ${position.settled} complete, ${remaining} remaining`;
}

/**
 * The bar. Colour says done / current / remaining, and HEIGHT says it a second time: the current
 * block stands 13px against the 9px of the rest, so the frontier is findable without reading the
 * hue. `role="img"` with every number in the label is what carries the whole bar to a reader who
 * gets no picture at all.
 */
function ChainBar({ position }: { position: ChainPosition }) {
  const segments = chainSegments(position);
  return (
    <div
      role="img"
      aria-label={chainProgressLabel(position)}
      style={{ display: 'flex', alignItems: 'center', gap: 2, height: 13 }}
    >
      {Array.from({ length: segments.count }, (_, index) => {
        const state = index < segments.done ? 'done' : index === segments.current ? 'current' : 'todo';
        return (
          <span
            key={index}
            data-segment={state}
            style={{
              flex: 1,
              height: state === 'current' ? 13 : 9,
              borderRadius: 2,
              background:
                state === 'done' ? 'var(--success)' : state === 'current' ? 'var(--brand)' : 'var(--fill-muted)',
            }}
          />
        );
      })}
    </div>
  );
}

export function ProjectChainProgress({ projectId }: { projectId: string }) {
  const panorama = useQuery({ ...projectChainPanoramaQuery(projectId), enabled: Boolean(projectId) });
  const shape = panorama.data?.shape;
  // A mesh gets the node-link view instead, and a project with no tasks has no chain to be a step
  // of — `Step 1 / 0` is not a reading, it is a bug with a number in it.
  const isChain = shape?.form === 'chain' && shape.taskCount > 0;
  const ranking = useQuery({ ...projectChainRankingQuery(projectId), enabled: Boolean(projectId) && isChain });

  if (!panorama.data || !isChain) return null;

  const position = chainPosition(panorama.data.buckets, panorama.data.shape);
  // Only while there is a frontier to name: a finished chain has no current step, and the ranking
  // of a finished project is empty anyway.
  const items = position.complete ? [] : (ranking.data?.items ?? []);
  const current = items[0];
  const next = items[1];

  return (
    <section aria-label="Chain progress" style={{ marginBottom: 24 }}>
      <ChainBar position={position} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '4px 16px',
          marginTop: 8,
          fontSize: 13,
        }}
      >
        <span>
          {position.complete ? (
            <b>All {position.total} steps complete</b>
          ) : (
            <>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                Step {position.position} / {position.total}
              </b>
              {/* The name is an annotation on the number, so it is simply absent when the ranking
                  has not answered — the position is what this strip is for and it is already
                  right. */}
              {current ? <> · {current.title}</> : null}
            </>
          )}
        </span>
        {next ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            Next → {next.title}
          </Typography.Text>
        ) : null}
      </div>
    </section>
  );
}
