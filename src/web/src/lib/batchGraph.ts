/**
 * Laying out the shape of a proposed batch.
 *
 * The counts on the approval card say how much a batch costs; they do not say what it *is*. A
 * chain of ten and ten independent tasks produce the same list of titles and behave completely
 * differently, and the shape is the part a person recognises at a glance — "this is a fan-out",
 * "this is a chain", "these are unrelated".
 *
 * Deliberately hand-rolled rather than reaching for a graph library. The batch preview sends at
 * most a dozen nodes (DAG_PREVIEW_TITLES), a card is not pannable, and this repo's one existing
 * xyflow/dagre view cannot even be built here — a layered walk over twelve nodes is smaller than
 * the adapter its alternative would need.
 */

export interface BatchTaskInput {
  title: string;
  ref?: string | null;
  dependsOnRefs?: string[];
  dependsOnTaskIds?: string[];
}

export interface GraphNode {
  title: string;
  /** Distance from a root, so prerequisites always sit above what waits on them. */
  layer: number;
  /** Position within the layer, left to right. */
  column: number;
  /** Waits on something that already exists outside this batch — it is a root here, not overall. */
  waitsOutside: boolean;
}

export interface GraphEdge {
  /** Index into `nodes`. */
  from: number;
  to: number;
}

export interface BatchGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Widest layer — what decides whether this reads as a chain or a fan-out. */
  width: number;
  depth: number;
}

/**
 * Layer every task one below its deepest prerequisite.
 *
 * Longest-path layering, not shortest: a task that waits on both a root and a leaf belongs under
 * the leaf, or its edges would point upward and the picture would claim an order that is not the
 * one the dispatcher will follow.
 *
 * Only refs *within* the batch make edges. `dependsOnTaskIds` points at tasks that already exist
 * and are not drawn, so a task carrying one is laid out as a root and flagged — otherwise the
 * picture would show it as startable when it is waiting on something off-screen.
 */
export function buildBatchGraph(tasks: BatchTaskInput[]): BatchGraph {
  const indexByRef = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (t.ref) indexByRef.set(t.ref, i);
  });

  // Refs may only name earlier items (the server enforces it), so one forward pass suffices and
  // the recursion a general DAG would need is not required.
  const layer = tasks.map(() => 0);
  const edges: GraphEdge[] = [];
  tasks.forEach((t, i) => {
    for (const ref of t.dependsOnRefs ?? []) {
      const from = indexByRef.get(ref);
      if (from === undefined) continue;
      edges.push({ from, to: i });
      layer[i] = Math.max(layer[i], layer[from] + 1);
    }
  });

  const nextColumn = new Map<number, number>();
  const nodes: GraphNode[] = tasks.map((t, i) => {
    const l = layer[i];
    const column = nextColumn.get(l) ?? 0;
    nextColumn.set(l, column + 1);
    return {
      title: t.title,
      layer: l,
      column,
      waitsOutside: (t.dependsOnTaskIds?.length ?? 0) > 0,
    };
  });

  return {
    nodes,
    edges,
    width: Math.max(0, ...[...nextColumn.values()]),
    depth: nextColumn.size,
  };
}

/**
 * Past these the drawing stops being worth more than the sentence.
 *
 * A card is about 520px wide, so a layer of five 138px nodes scales the labels below eight
 * points — unreadable, and a picture you cannot read is worse than the line of prose that
 * replaces it. Depth is capped for the opposite reason: a chain draws perfectly at any length and
 * says nothing "a chain of 12" does not already say, while eating the whole card.
 */
export const MAX_DRAWN_WIDTH = 4;
export const MAX_DRAWN_DEPTH = 6;

/** Whether this batch is worth drawing rather than describing. */
export function shouldDraw(g: BatchGraph): boolean {
  return g.edges.length > 0 && g.width <= MAX_DRAWN_WIDTH && g.depth <= MAX_DRAWN_DEPTH;
}

/**
 * A one-line reading of the shape, for the places a picture does not fit — and as the caption
 * above the one that does.
 *
 * Worth having on its own: at 250 tasks the card only draws a window, and a window of a graph is
 * more misleading than no graph at all. A sentence still describes the whole batch truthfully.
 */
export function describeShape(g: BatchGraph): string {
  if (g.nodes.length === 0) return '';
  if (g.edges.length === 0) {
    return g.nodes.length === 1 ? 'a single task' : `${g.nodes.length} independent tasks`;
  }
  if (g.width === 1) return `a chain of ${g.nodes.length}`;
  if (g.depth === 2) return `${g.width} in parallel after 1`;
  return `${g.depth} levels, up to ${g.width} in parallel`;
}
