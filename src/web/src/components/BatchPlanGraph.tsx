import { useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { batchPreviewGraph, type BatchTaskInput } from '../lib/batchGraph';
import { PublicLinkResolverCtx, type PublicLinkResolver } from '../lib/publicLinks';
import { ProjectDependencyGraph, startPlanGraphFits } from './ProjectDependencyGraph';

/** Nothing a proposal names has a page yet: the canvas draws every mark as words, not as a link. */
const nothingIsShared: PublicLinkResolver = () => null;

/**
 * The shape of a proposed batch, drawn by the project page's own canvas.
 *
 * Same component, same layout, same fit rule as the project page's "Task graph" and the start
 * card's plan (`StartPlanGraph`), which is the whole point: the card is a preview of the plan the
 * project will hold, so a picture drawn by a second engine is a second answer to "what does this
 * plan look like" — and the two answers drifted (different direction, different order within a
 * level, different chrome) the moment there were two.
 *
 * Reached only through `BatchGraph`'s `lazy()` boundary, so React Flow and dagre cost a
 * conversation nothing until a card actually draws one.
 *
 * A proposal is not a project: the tasks have ids the canvas cannot open and statuses nobody has
 * written, so the picture is inert — every mark is a word — and each mark carries the one reading
 * that IS true of a plan, which is what waits on what (see `batchPreviewGraph`).
 */
export default function BatchPlanGraph({
  tasks,
  fallback,
}: {
  tasks: BatchTaskInput[];
  /** What stands in the picture's place: the batch's titles, which the card lists anyway. */
  fallback: ReactNode;
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const preview = useMemo(() => batchPreviewGraph(tasks), [tasks]);
  // Nothing to draw without edges (a row of unrelated cards is a worse list than a list), and
  // nothing worth drawing when the plan does not fit this width legibly — there the titles are
  // the honest reading, with the caption above them carrying the shape.
  const drawn = preview.graph.edges.length > 0 && startPlanGraphFits(preview.graph, width);
  return (
    <div ref={box} className={drawn ? 'batch-graph' : undefined}>
      {drawn ? (
        <PublicLinkResolverCtx.Provider value={nothingIsShared}>
          <ProjectDependencyGraph data={preview.graph} direction="TB" embedded />
        </PublicLinkResolverCtx.Provider>
      ) : (
        fallback
      )}
      {/* What no card can draw: the prerequisite is a task that already exists, so it has no mark
          here. Dashed and tooltipped while this picture was hand-rolled; a line of words now, which
          is the same fact for a reader who never hovers. */}
      {drawn && preview.waitsOutside > 0 ? (
        <p className="batch-graph-foot">
          {preview.waitsOutside === 1
            ? '1 waits on a task outside this batch'
            : `${preview.waitsOutside} wait on tasks outside this batch`}
        </p>
      ) : null}
    </div>
  );
}
