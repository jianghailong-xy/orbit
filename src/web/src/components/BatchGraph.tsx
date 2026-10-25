import { Suspense, lazy, type JSX, type ReactNode } from 'react';
import type { BatchTaskInput } from '../lib/batchGraph';

/**
 * A proposed batch's shape, as the card draws it — the project page's own canvas, behind this
 * boundary.
 *
 * React Flow and dagre are heavy and most approval cards are not a batch at all. This module is
 * the cheap half: it imports nothing but a type, and the picture (with its own layout engine) is
 * fetched the moment a card actually has one to draw — the same arrangement `ProjectTasksGraph`
 * and the start card's plan already use.
 *
 * `fallback` is what stands in its place: the titles, which is what the card shows while the chunk
 * loads and what it keeps when there is no picture to draw (see `BatchPlanGraph`).
 */
const LazyBatchPlanGraph = lazy(() => import('./BatchPlanGraph'));

export function BatchGraph({
  tasks,
  fallback,
}: {
  tasks: BatchTaskInput[];
  fallback: ReactNode;
}): JSX.Element {
  return (
    <Suspense fallback={fallback}>
      <LazyBatchPlanGraph tasks={tasks} fallback={fallback} />
    </Suspense>
  );
}
