/**
 * The shape of a proposed batch.
 *
 * The counts on the approval card say how much a batch costs; they do not say what it *is*. A
 * chain of ten and ten independent tasks produce the same list of titles and behave completely
 * differently, and the shape is the part a person recognises at a glance — "this is a fan-out",
 * "this is a chain", "these are unrelated".
 *
 * The picture is the project page's own canvas (`ProjectDependencyGraph`, reached through
 * `BatchPlanGraph`): one component lays out a plan wherever it is drawn, so a card cannot promise
 * a shape the project page will not draw. What stays here is the rule both read — a task sits one
 * level after the deepest of what it waits on — which the card's caption quotes ("5 levels, up to
 * 2 in parallel"), and which the native clients mirror for their level lists.
 */
import type {
  ProjectDependencyGraphResponse,
  ProjectTaskWorkState,
} from './projectDependencyGraph';

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

  const nodes: GraphNode[] = tasks.map((t, i) => ({
    title: t.title,
    layer: layer[i],
    waitsOutside: (t.dependsOnTaskIds?.length ?? 0) > 0,
  }));

  // How many tasks share each layer. `width` is the widest of them — the number of things that can
  // run at once, which is what decides whether this reads as a chain or a fan-out.
  const perLayer = new Map<number, number>();
  for (const node of nodes) perLayer.set(node.layer, (perLayer.get(node.layer) ?? 0) + 1);

  return {
    nodes,
    edges,
    width: Math.max(0, ...perLayer.values()),
    depth: perLayer.size,
  };
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
  // "after 1" is a claim about the first layer: one task releasing the rest. Said of three tasks
  // that release a fourth it reads backwards, so that shape falls through to the general sentence.
  // The native card reads the same rule (`Approvals.describeBatchShape`).
  if (g.depth === 2 && g.nodes.filter((n) => n.layer === 0).length === 1) {
    return `${g.width} in parallel after 1`;
  }
  return `${g.depth} levels, up to ${g.width} in parallel`;
}

/**
 * The batch as the project page's canvas draws it: one mark per task, one edge per prerequisite
 * inside the batch.
 *
 * A proposal has no statuses — nothing exists yet — so each mark carries the one reading that is
 * true of a plan: a task nothing holds back (no prerequisite in the batch, none outside it) is
 * `READY`, and everything else waits. Work waiting on a task that already exists cannot be drawn
 * at all — that task is not on this canvas — so it is counted separately for the caller to say in
 * words, which is what the card did with a dashed box and a tooltip before.
 */
export function batchPreviewGraph(tasks: BatchTaskInput[]): {
  graph: ProjectDependencyGraphResponse;
  /** Tasks waiting on something that already exists, whose edges no card can draw. */
  waitsOutside: number;
} {
  const shape = buildBatchGraph(tasks);
  // Refs name the tasks to each other; a task without one is still drawn, under its place in the
  // window. Both spellings are unique here, which is all the canvas needs of a mark's id.
  const idOf = tasks.map((task, i) => task.ref ?? `#${i + 1}`);
  const workStateOf = (node: GraphNode): ProjectTaskWorkState =>
    node.layer === 0 && !node.waitsOutside ? 'READY' : 'BLOCKED';
  return {
    graph: {
      marks: shape.nodes.map((node, i) => ({
        kind: 'TASK',
        id: idOf[i],
        taskId: idOf[i],
        title: node.title,
        // A created task is OPEN, and that is what this card is about to make true.
        status: 'OPEN',
        parentTaskId: null,
        workState: workStateOf(node),
      })),
      edges: shape.edges.map((edge) => ({
        sourceMarkId: idOf[edge.from],
        targetMarkId: idOf[edge.to],
      })),
      taskCount: tasks.length,
      folded: false,
      truncated: false,
    },
    waitsOutside: shape.nodes.filter((node) => node.waitsOutside).length,
  };
}
