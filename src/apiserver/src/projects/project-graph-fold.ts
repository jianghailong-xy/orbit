import { TaskStatus } from '@prisma/client';
import type {
  ProjectTaskVerificationState,
  ProjectTaskWorkState,
} from './project-task-work-state';

/**
 * Folding a project's dependency graph down to something a screen can actually hold.
 *
 * ## Why this exists
 *
 * A readable task card is about 204×76 CSS px. A 1440×900 canvas therefore holds forty to sixty
 * of them once edges and whitespace are paid for. That is the real ceiling on a node-link picture
 * and it is a property of eyes, not of renderers: dagre lays out a thousand nodes in a blink and
 * React Flow will happily mount them, and the reader still gets a wall of dashes.
 *
 * Past that ceiling there are only three moves. TRUNCATE — draw the first N and drop the rest —
 * is what this endpoint used to do (`take: 500` ordered by `created_at`), and it is the worst of
 * them: the subset is chosen by a clock, which correlates with nothing structural, and what is
 * missing is invisible to the reader. CHANGE THE ENCODING — a matrix, a rank histogram — answers
 * questions this data does not ask (in this database only 86 tasks in 24,520 have two
 * prerequisites; there is no dense mesh to unpack). FOLD — make one mark stand for many tasks —
 * is the move that fits, because the projects here are overwhelmingly made of two things a fold
 * handles exactly:
 *
 *   - long straight runs. 97% of tasks in the biggest project have in-degree ≤ 1 and out-degree
 *     ≤ 1. A run of 35 steps carries no branching information; one mark carrying "35 steps, 12
 *     done" carries all of it.
 *   - repeated motifs. The biggest project is 23,442 tasks that are ONE four-step pipeline
 *     instantiated 6,118 times: 6,118 components, median size 4, and seven distinct titles once
 *     digits are normalized away. Drawing 6,118 copies of the same picture says nothing the first
 *     copy did not, so the copies become a count and a status breakdown on four marks.
 *
 * The two folds compose: motif folding collapses the repetition ACROSS components, run folding
 * collapses the linearity WITHIN one.
 *
 * ## The rules a fold obeys here
 *
 *   - every task is represented by exactly one mark. A fold never drops tasks; that is the whole
 *     difference between it and the truncation it replaces.
 *   - a fold is visible as a fold, and says how many tasks it stands for. The client draws these
 *     dashed, the way the task graph already draws its collapsed branches.
 *   - what the reader is working on is never folded away. The frontier — the first unfinished
 *     task in topological order — and anything running or failed stay their own marks, because
 *     "where is the work" and "what broke" are the questions the picture is opened to answer.
 *   - parent/child is left alone. A subtask's `parentTaskId` rides through onto its mark (a run
 *     inside a box is a run of that box's members), so the client's existing box layout keeps
 *     working without knowing folding happened.
 */

/**
 * A task as this module needs it: identity, what it says, where it stands, whose child it is —
 * and whether a session is on it right now.
 *
 * `running` / `queued` are the LIVE reading (a RUNNING / PENDING Session), which is a different
 * fact from `status`: nothing writes `IN_PROGRESS` when a run is dispatched, so a task being
 * worked on this second is `OPEN` in its row and stays `OPEN` here. The task list and the
 * task-rooted graph have always carried these two flags alongside the status for that reason, and
 * a project graph that reads the column alone is the one view in the app that draws running work
 * as untouched.
 */
export interface FoldTask {
  id: string;
  title: string;
  status: TaskStatus;
  parentTaskId: string | null;
  running?: boolean;
  queued?: boolean;
  /** Canonical project work lane; never recomputed from graph indegree by the client. */
  workState?: ProjectTaskWorkState;
  verificationState?: ProjectTaskVerificationState | null;
}

/** The live half of a task, carried onto every mark that names one. */
export interface LiveTaskState {
  running: boolean;
  queued: boolean;
}

/** Prerequisite → dependent, the direction the arrows are drawn in. */
export interface FoldEdge {
  sourceTaskId: string;
  targetTaskId: string;
}

export type MarkStatusCounts = Record<TaskStatus, number>;

/** One task, drawn as itself. */
export interface TaskMark extends LiveTaskState {
  kind: 'TASK';
  id: string;
  taskId: string;
  title: string;
  status: TaskStatus;
  parentTaskId: string | null;
  workState?: ProjectTaskWorkState;
  verificationState?: ProjectTaskVerificationState | null;
}

/** A straight run of tasks, drawn as one mark. `members` is the run in order. */
export interface RunMark {
  kind: 'RUN';
  id: string;
  title: string;
  taskCount: number;
  statusCounts: MarkStatusCounts;
  parentTaskId: string | null;
  members: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    workState?: ProjectTaskWorkState;
    verificationState?: ProjectTaskVerificationState | null;
  } & LiveTaskState>;
  /** False when the run is longer than one response carries its members for. */
  expandable: boolean;
}

/** One stage of a motif, standing for that stage in every instance of it. */
export interface MotifMark {
  kind: 'MOTIF';
  id: string;
  title: string;
  instanceCount: number;
  taskCount: number;
  statusCounts: MarkStatusCounts;
  parentTaskId: null;
  /** A few real tasks behind the mark, failures and running work first. */
  samples: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    workState?: ProjectTaskWorkState;
    verificationState?: ProjectTaskVerificationState | null;
  } & LiveTaskState>;
}

export type ProjectGraphMark = TaskMark | RunMark | MotifMark;

export interface ProjectGraphFold {
  marks: ProjectGraphMark[];
  edges: Array<{ sourceMarkId: string; targetMarkId: string }>;
  /** Tasks represented by the marks. */
  taskCount: number;
  /** True when at least one mark stands for more than one task. */
  folded: boolean;
  /** True when marks had to be cut: the fold itself did not fit. */
  truncated: boolean;
}

export interface FoldOptions {
  /** At or below this many tasks nothing is folded — the whole plan already fits. */
  expandLimit: number;
  /** Components have to repeat at least this many times before repetition is worth folding. */
  motifMinInstances: number;
  /** A run shorter than this costs as much space folded as drawn. */
  runMinLength: number;
  /** The most marks a response carries. */
  maxMarks: number;
  /** The most members a run carries so the client can expand it in place. */
  maxRunMembers: number;
  /** The most sample tasks a motif mark carries. */
  maxMotifSamples: number;
}

export const DEFAULT_FOLD_OPTIONS: FoldOptions = {
  expandLimit: 60,
  motifMinInstances: 3,
  runMinLength: 3,
  maxMarks: 500,
  maxRunMembers: 200,
  maxMotifSamples: 6,
};

const ZERO_COUNTS = (): MarkStatusCounts => ({
  [TaskStatus.OPEN]: 0,
  [TaskStatus.IN_PROGRESS]: 0,
  [TaskStatus.DONE]: 0,
  [TaskStatus.CANCELLED]: 0,
  [TaskStatus.FAILED]: 0,
});

/** Finished, for folding purposes: nothing about it is still ahead of the reader. */
const isSettled = (status: TaskStatus) =>
  status === TaskStatus.DONE || status === TaskStatus.CANCELLED;

/** Work the picture must never fold away, wherever it sits. */
const demandsAttention = (status: TaskStatus) =>
  status === TaskStatus.IN_PROGRESS || status === TaskStatus.FAILED;

/**
 * The status a mark reports for a task: a live run wins over the stored lifecycle.
 *
 * A dispatched task keeps `OPEN` in its row — nothing writes `IN_PROGRESS` at dispatch — so
 * reading the column alone folds the one task somebody is watching into a run of untouched steps
 * and counts it under "open" in the bar. Everywhere else in the app the live session wins
 * (`TasksService.withRunning`, the task list's pill), and this is that same rule, applied where
 * the fold makes its decisions.
 *
 * Only `running` promotes. `queued` stays where it is: a task waiting for a runner slot has
 * nothing to look at yet, and the frontier rule below already keeps the next unfinished task of
 * every component drawn as itself.
 */
const liveStatus = (task: FoldTask): TaskStatus =>
  task.running ? TaskStatus.IN_PROGRESS : task.status;

const live = (task: FoldTask): LiveTaskState => ({
  running: !!task.running,
  queued: !!task.queued,
});

/**
 * A title with its varying part taken out, so two instances of one motif read as one thing.
 *
 * Digits are the whole of the variation in the batch projects this is for
 * (`[FineWeb][CC-MAIN-2013-20] 000_00000.parquet`), so runs of them become `*` and adjacent stars
 * collapse. Deliberately nothing cleverer: a normalization that guesses more also groups more
 * tasks that are not the same task, and the grouping is what the reader is being asked to trust.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\d+/g, '*')
    .replace(/\*(?:[\s._-]*\*)+/g, '*')
    .trim();
}

/** Union-find over the undirected graph: which tasks are reachable from which, ignoring arrows. */
function componentsOf(tasks: FoldTask[], edges: FoldEdge[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (const task of tasks) parent.set(task.id, task.id);
  for (const edge of edges) {
    const a = find(edge.sourceTaskId);
    const b = find(edge.targetTaskId);
    if (a !== b) parent.set(a, b);
  }
  return new Map(tasks.map((task) => [task.id, find(task.id)]));
}

/**
 * How deep each task sits in its component: the longest path to it from a task nothing precedes.
 *
 * Longest rather than shortest because it is what makes two instances of one motif agree on which
 * stage a task is: a task reachable both directly and the long way round belongs at the stage its
 * slowest prerequisite puts it in, in every copy.
 */
function ranksOf(
  tasks: FoldTask[],
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>,
): Map<string, number> {
  const remaining = new Map<string, number>();
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const task of tasks) {
    const degree = (incoming.get(task.id) ?? []).length;
    remaining.set(task.id, degree);
    if (degree === 0) {
      rank.set(task.id, 0);
      queue.push(task.id);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // A cycle cannot be ranked and must not silently vanish: whatever the walk never reached keeps
  // rank 0 and is laid out as a root. Dependencies here are acyclic by construction; this is the
  // branch that keeps a bug in that construction from costing the reader their tasks.
  for (const task of tasks) if (!rank.has(task.id)) rank.set(task.id, 0);
  return rank;
}

export function foldProjectGraph(
  tasks: FoldTask[],
  edges: FoldEdge[],
  options: FoldOptions = DEFAULT_FOLD_OPTIONS,
): ProjectGraphFold {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const realEdges = edges.filter(
    (edge) => byId.has(edge.sourceTaskId) && byId.has(edge.targetTaskId),
  );
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of realEdges) {
    link(outgoing, edge.sourceTaskId, edge.targetTaskId);
    link(incoming, edge.targetTaskId, edge.sourceTaskId);
  }

  if (tasks.length <= options.expandLimit) {
    return {
      marks: tasks.map(taskMark),
      edges: realEdges.map((edge) => ({
        sourceMarkId: edge.sourceTaskId,
        targetMarkId: edge.targetTaskId,
      })),
      taskCount: tasks.length,
      folded: false,
      truncated: false,
    };
  }

  const componentOf = componentsOf(tasks, realEdges);
  const rank = ranksOf(tasks, outgoing, incoming);
  // A parent with subtasks on this canvas is drawn as the BOX they sit in, which is already a
  // fold — of the tree rather than of the chain. Folding it a second time, into a run alongside
  // its own children, leaves those children with no frame to sit in and the reader with a picture
  // whose parts have lost their parents.
  const boxIds = new Set(
    tasks.map((task) => task.parentTaskId).filter((id): id is string => !!id && byId.has(id)),
  );
  const marks: ProjectGraphMark[] = [];
  /** Task id → the mark that now stands for it. Absent means the task is still its own mark. */
  const folded = new Map<string, string>();

  // ── The motif fold: one mark per repeated stage ───────────────────────────────────────────
  //
  // Grouped by normalized title alone, NOT by the shape of the component a task sits in. That is
  // a decision the real data forced: the 23,442-task batch project has 30 distinct component
  // shapes — 4,744 clean four-step pipelines, then a long tail of instances with a doubled
  // verify, a doubled fetch, or no merge at all — and folding by shape drew each variant as its
  // own near-identical row, 137 marks of them. Grouped by stage instead, the picture is the four
  // stages the batch actually has, and the variants show up where they belong: in the counts,
  // where a stage holding more tasks than there are instances is a stage some instances run twice.
  //
  // The guard against folding a PLAN this way is that a group must be spread across at least
  // `motifMinInstances` separate components. Fifty steps called "Run tests" inside one plan are
  // fifty steps of that plan and stay drawn; fifty tasks of one name across fifty unconnected
  // little graphs are a batch stage and fold.
  const byTitle = new Map<string, FoldTask[]>();
  for (const task of tasks) {
    const key = normalizeTitle(task.title);
    const group = byTitle.get(key);
    if (group) group.push(task);
    else byTitle.set(key, [task]);
  }
  let motifIndex = 0;
  const motifByTitle = new Map<string, MotifMark>();
  for (const [title, group] of byTitle) {
    if (group.length < options.motifMinInstances) continue;
    if (group.some((task) =>
      boxIds.has(task.id) || task.workState === 'AWAITING_VERIFICATION')) continue;
    const components = new Set(group.map((task) => componentOf.get(task.id)!));
    if (components.size < options.motifMinInstances) continue;
    motifIndex += 1;
    const statusCounts = ZERO_COUNTS();
    for (const task of group) statusCounts[liveStatus(task)] += 1;
    const mark: MotifMark = {
      kind: 'MOTIF',
      id: `motif:${motifIndex}`,
      title,
      instanceCount: components.size,
      taskCount: group.length,
      statusCounts,
      parentTaskId: null,
      // Failures first, then running work: a motif mark is opened to find out which instance
      // broke, and an arbitrary six of six thousand answers a question nobody asked.
      samples: [...group]
        .sort((a, b) => sampleRank(liveStatus(a)) - sampleRank(liveStatus(b)))
        .slice(0, options.maxMotifSamples)
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          status: task.status,
          workState: task.workState,
          verificationState: task.verificationState,
          ...live(task),
        })),
    };
    motifByTitle.set(title, mark);
    marks.push(mark);
    for (const task of group) folded.set(task.id, mark.id);
  }

  // ── The run fold: straight stretches of what is left ──────────────────────────────────────
  const loose = tasks.filter((task) => !folded.has(task.id));
  const frontierIds = frontiersOf(loose, componentOf, rank, outgoing, byId);
  const degreeOf = (id: string) => ({
    in: (incoming.get(id) ?? []).length,
    out: (outgoing.get(id) ?? []).length,
  });
  const foldable = (task: FoldTask) => {
    if (
      frontierIds.has(task.id)
      || demandsAttention(liveStatus(task))
      || task.workState === 'AWAITING_VERIFICATION'
      || boxIds.has(task.id)
    ) {
      return false;
    }
    const degree = degreeOf(task.id);
    return degree.in <= 1 && degree.out <= 1;
  };
  const position = new Map(loose.map((task, index) => [task.id, index]));
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Component, then BOX, then depth. The box comes before the depth on purpose: a project whose
  // parents each hold a chain of their own (Linux From Scratch is three such boxes) interleaves
  // by depth otherwise, and a run that keeps being interrupted by the neighbouring box's task at
  // the same depth is a run that never forms.
  const ordered = [...loose].sort(
    (a, b) =>
      compare(componentOf.get(a.id)!, componentOf.get(b.id)!) ||
      compare(a.parentTaskId ?? '', b.parentTaskId ?? '') ||
      (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) ||
      position.get(a.id)! - position.get(b.id)!,
  );

  let runIndex = 0;
  let run: FoldTask[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < options.runMinLength) {
      for (const task of run) marks.push(taskMark(task));
    } else {
      runIndex += 1;
      const id = `run:${runIndex}`;
      marks.push(runMark(id, run, options));
      for (const task of run) folded.set(task.id, id);
    }
    run = [];
  };
  for (const task of ordered) {
    if (!foldable(task)) {
      flush();
      marks.push(taskMark(task));
      continue;
    }
    const previous = run[run.length - 1];
    // Only a straight continuation joins a run: the task before it must be this task's whole
    // prerequisite set, and both must sit under the same parent — otherwise the mark would claim
    // a membership the task tree does not have, and a box would lose its own members.
    const continues =
      !previous ||
      ((incoming.get(task.id) ?? []).join() === previous.id &&
        previous.parentTaskId === task.parentTaskId);
    if (!continues) flush();
    run.push(task);
  }
  flush();

  const markIds = new Set(marks.map((mark) => mark.id));
  const markIdOf = (taskId: string) => folded.get(taskId) ?? taskId;
  const markEdges = new Map<string, { sourceMarkId: string; targetMarkId: string }>();
  for (const edge of realEdges) {
    const from = markIdOf(edge.sourceTaskId);
    const to = markIdOf(edge.targetTaskId);
    // A folded stretch's internal edges are inside one mark, and say nothing once it is one mark.
    if (from === to || !markIds.has(from) || !markIds.has(to)) continue;
    markEdges.set(`${from}->${to}`, { sourceMarkId: from, targetMarkId: to });
  }

  const truncated = marks.length > options.maxMarks;
  const kept = truncated ? marks.slice(0, options.maxMarks) : marks;
  const keptIds = new Set(kept.map((mark) => mark.id));
  return {
    marks: kept,
    edges: [...markEdges.values()].filter(
      (edge) => keptIds.has(edge.sourceMarkId) && keptIds.has(edge.targetMarkId),
    ),
    taskCount: tasks.length,
    folded: kept.some((mark) => mark.kind !== 'TASK'),
    truncated,
  };
}

function sampleRank(status: TaskStatus): number {
  if (status === TaskStatus.FAILED) return 0;
  if (status === TaskStatus.IN_PROGRESS) return 1;
  if (status === TaskStatus.OPEN) return 2;
  return 3;
}

function taskMark(task: FoldTask): TaskMark {
  return {
    kind: 'TASK',
    id: task.id,
    taskId: task.id,
    title: task.title,
    status: task.status,
    parentTaskId: task.parentTaskId,
    workState: task.workState,
    verificationState: task.verificationState,
    ...live(task),
  };
}

function runMark(id: string, run: FoldTask[], options: FoldOptions): RunMark {
  const statusCounts = ZERO_COUNTS();
  for (const task of run) statusCounts[liveStatus(task)] += 1;
  const settled = run.every((task) => isSettled(liveStatus(task)));
  return {
    kind: 'RUN',
    id,
    title: `${run.length} steps${settled ? ' · done' : ''}`,
    taskCount: run.length,
    statusCounts,
    parentTaskId: run[0].parentTaskId,
    members: run.slice(0, options.maxRunMembers).map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      workState: task.workState,
      verificationState: task.verificationState,
      ...live(task),
    })),
    expandable: run.length <= options.maxRunMembers,
  };
}

/**
 * The tasks a fold must leave alone: the first unfinished task of each component, and whatever
 * that task releases next.
 *
 * Per component rather than one for the whole project, because a project with three parallel
 * fronts has three places the work is, and a picture that expands one of them has answered "where
 * is the work" with a third of the truth.
 */
function frontiersOf(
  loose: FoldTask[],
  componentOf: Map<string, string>,
  rank: Map<string, number>,
  outgoing: Map<string, string[]>,
  byId: Map<string, FoldTask>,
): Set<string> {
  const first = new Map<string, FoldTask>();
  for (const task of loose) {
    if (isSettled(liveStatus(task))) continue;
    const component = componentOf.get(task.id)!;
    const held = first.get(component);
    if (!held || (rank.get(task.id) ?? 0) < (rank.get(held.id) ?? 0)) first.set(component, task);
  }
  const frontier = new Set<string>();
  for (const task of first.values()) {
    frontier.add(task.id);
    for (const next of outgoing.get(task.id) ?? []) {
      if (byId.has(next)) frontier.add(next);
    }
  }
  return frontier;
}
