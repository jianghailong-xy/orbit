import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectDependencyGraphResponse } from '../lib/projectDependencyGraph';
import { ProjectDependencyGraph, startPlanGraphFits } from './ProjectDependencyGraph';

/**
 * The start card's Plan as the project page's task graph (docs/mocks/start-card-web-width, board 02,
 * approved 2026-10-09). Reached only through the card's `lazy()` boundary, like the project page's
 * own graph, so React Flow and dagre cost a conversation nothing until a start card asks for them.
 *
 * The graph is drawn when the whole plan fits the card legibly (`startPlanGraphFits`): top to bottom,
 * fitted, a picture the wheel scrolls past. Otherwise `fallback` — the plan by level — stands, and
 * the card offers the graph full screen (`StartTaskGraph`). Which of the two is on screen is told to
 * the card (`onDrawn`), whose section head and links follow it.
 */
export default function StartPlanGraph({
  projectId,
  data,
  fallback,
  onDrawn,
}: {
  projectId: string;
  data: ProjectDependencyGraphResponse;
  /** What the Plan says when the graph does not fit: the plan by level. */
  fallback: ReactNode;
  /** A stable function. Told `false` when this goes, too. */
  onDrawn: (drawn: boolean) => void;
}) {
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
  // The canvas sits inside a one-pixel border on either side.
  const fits = useMemo(() => startPlanGraphFits(data, width - 2), [data, width]);
  useEffect(() => {
    onDrawn(fits);
  }, [fits, onDrawn]);
  useEffect(() => () => onDrawn(false), [onDrawn]);
  // The wrapper is measured either way; it takes the graph's spacing only around the graph, so the
  // list lies exactly where it lay before this module loaded.
  return (
    <div ref={box} className={fits ? 'start-card-graph' : undefined}>
      {fits ? <ProjectDependencyGraph projectId={projectId} data={data} direction="TB" embedded /> : fallback}
    </div>
  );
}

/** The project page's task graph full screen, for a plan the card lists by level. */
export function StartTaskGraph({
  projectId,
  data,
  onClose,
}: {
  projectId: string;
  data: ProjectDependencyGraphResponse;
  onClose: () => void;
}) {
  return <ProjectDependencyGraph projectId={projectId} data={data} fullScreenOnly onClose={onClose} />;
}
