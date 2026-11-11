import { routeId } from './idCodec';
import type { ProjectDependencyGraphResponse } from './projectDependencyGraph';

/**
 * A turn Orbit opened in a conversation — a fact told to a coordinator, a watch or a background job
 * coming back, another session's reply — together with everything the agent did and said under it,
 * folded into one line (design: docs/mocks/coordinator-exchange-fold/, approved 2026-11-11).
 *
 * A coordinator spends most of its turns on these: in one real coordinator, 260 of 555 turns were
 * Orbit's, and the reply under a watch's turn was a median 155 characters saying nothing needed
 * doing. Drawn in full they buried what the owner asked between them. Folded, each says what
 * happened and how the agent answered it — `Evidence revision 2 submitted: B1 — 我确认了 B1…` — and
 * opens back to exactly what was drawn before.
 */
export type ExchangeCategory = 'evidence' | 'ready' | 'project' | 'watch' | 'job' | 'reply';

/** What an exchange is about, as far as a tree can place it. */
export type ExchangeTarget =
  | { kind: 'TASK'; id: string; title?: string }
  | { kind: 'SESSION'; id: string; title?: string };

export interface OrbitExchangeSummary {
  /** The seq of the turn's opening event: the exchange's place in the conversation. */
  seq: number;
  /** The last seq the turn holds, so a find can tell which exchange a hit sits in. */
  lastSeq: number;
  ts?: string;
  /** What happened, in the words the turn's own line says it in. */
  what: string;
  /** The same with the task's name taken off, for a row drawn under that task. */
  whatInTask?: string;
  /** The first line of the agent's last reply in the turn, as plain text. */
  reply: string;
  category: ExchangeCategory;
  target: ExchangeTarget | null;
}

/** Ids compared whichever way each is spelled (uuid or base62). */
export const idKey = (id: string): string => (id.includes('-') ? (routeId(id) ?? id) : id);

/** The first line a reply says, as plain text: what a folded row shows of how the agent answered. */
export function replyGist(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !/^(```|---|\|)/.test(l)) ?? '';
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}

const CATEGORY_WORDS: ReadonlyArray<[ExchangeCategory, string, string]> = [
  ['evidence', 'evidence', 'evidence'],
  ['ready', 'can start', 'can start'],
  ['project', 'project update', 'project updates'],
  ['watch', 'watch', 'watches'],
  ['job', 'background job', 'background jobs'],
  ['reply', 'reply', 'replies'],
];

/** What a group holds, counted by kind: `3 evidence, 1 can start, 2 watches`. */
export function exchangeKinds(exs: readonly Pick<OrbitExchangeSummary, 'category'>[]): string {
  return CATEGORY_WORDS.flatMap(([category, one, many]) => {
    const n = exs.filter((e) => e.category === category).length;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(', ');
}

export const OTHER_BRANCH_TITLE = 'Not about a task';

/**
 * What the console knows that places an exchange in the tree: which task a session runs, which
 * tasks a task waits on, and a task's title. Each answers nothing it does not know.
 */
export interface ExchangeTreeLookup {
  taskOfSession: (sessionId: string) => { id: string; title?: string } | null;
  upstreamOf: (taskId: string) => readonly string[];
  taskTitle: (taskId: string) => string | undefined;
}

export const EMPTY_TREE_LOOKUP: ExchangeTreeLookup = {
  taskOfSession: () => null,
  upstreamOf: () => [],
  taskTitle: () => undefined,
};

export interface ExchangeBranch<E> {
  /** Unique within the tree: the task's id, `session:<id>`, or `other`. */
  key: string;
  /** The task's id as the exchanges spelled it; null for a session this page cannot place under
   *  a task, and for the branch of everything else. */
  taskId: string | null;
  title: string;
  exchanges: E[];
  children: ExchangeBranch<E>[];
}

/**
 * A group's exchanges as a tree of the tasks they are about: each exchange under its task, and a
 * task under the task it waits on when that task is in the same group too (the first one to appear,
 * when it waits on several). A task whose prerequisites are not in the group is a root. Exchanges
 * about no task — a background job, a session that runs none — gather in one branch, last.
 *
 * Roots and children keep the order their first exchange arrived in. Null when the group is about
 * one thing only: a tree of one branch says nothing a list does not.
 */
export function buildExchangeTree<E extends Pick<OrbitExchangeSummary, 'target'>>(
  exchanges: readonly E[],
  lookup: ExchangeTreeLookup,
): ExchangeBranch<E>[] | null {
  const branches = new Map<string, ExchangeBranch<E>>();
  const order: string[] = [];
  const other: E[] = [];
  for (const ex of exchanges) {
    const task = taskOf(ex.target, lookup);
    // A session no task is known to run is a branch of its own: what was said about it still
    // reads together, it just cannot be placed after anything.
    const placed = task ?? (ex.target?.kind === 'SESSION' ? ex.target : null);
    if (!placed) {
      other.push(ex);
      continue;
    }
    const key = task ? idKey(task.id) : `session:${idKey(placed.id)}`;
    let branch = branches.get(key);
    if (!branch) {
      branch = {
        key,
        taskId: task ? task.id : null,
        title: task ? (task.title ?? lookup.taskTitle(task.id) ?? '') : (placed.title ?? ''),
        exchanges: [],
        children: [],
      };
      branches.set(key, branch);
      order.push(key);
    }
    if (!branch.title && placed.title) branch.title = placed.title;
    branch.exchanges.push(ex);
  }
  if (order.length + (other.length ? 1 : 0) < 2) return null;
  const roots: ExchangeBranch<E>[] = [];
  for (const key of order) {
    const branch = branches.get(key)!;
    if (!branch.title) {
      const id = branch.taskId ?? key.slice('session:'.length);
      branch.title = `${branch.taskId ? 'Task' : 'Session'} ${(routeId(id) ?? id).slice(-8)}`;
    }
    // The prerequisite that came first in the group, never the task itself or one placed under it.
    const prerequisites = branch.taskId ? lookup.upstreamOf(branch.taskId).map(idKey) : [];
    const up = order
      .filter((k) => k !== key && prerequisites.includes(k))
      .find((k) => !isBelow(branches.get(k)!, branch));
    if (up) branches.get(up)!.children.push(branch);
    else roots.push(branch);
  }
  if (other.length) roots.push({ key: 'other', taskId: null, title: OTHER_BRANCH_TITLE, exchanges: other, children: [] });
  return roots;
}

function isBelow<E>(candidate: ExchangeBranch<E>, branch: ExchangeBranch<E>): boolean {
  return branch.children.some((child) => child === candidate || isBelow(candidate, child));
}

function taskOf(target: ExchangeTarget | null, lookup: ExchangeTreeLookup): { id: string; title?: string } | null {
  if (!target) return null;
  if (target.kind === 'TASK') return { id: target.id, title: target.title };
  return lookup.taskOfSession(target.id);
}

/** Every exchange a branch holds, its own and its descendants', in conversation order. */
export function branchExchanges<E extends Pick<OrbitExchangeSummary, 'seq'>>(branch: ExchangeBranch<E>): E[] {
  const all: E[] = [];
  const walk = (b: ExchangeBranch<E>) => {
    all.push(...b.exchanges);
    b.children.forEach(walk);
  };
  walk(branch);
  return all.sort((a, b) => a.seq - b.seq);
}

/** How many tasks sit below a branch, at any depth. */
export function downstreamCount<E>(branch: ExchangeBranch<E>): number {
  return branch.children.reduce((n, child) => n + 1 + downstreamCount(child), 0);
}

/**
 * Which tasks each task waits on, read off a project's dependency graph. The graph arrives folded
 * into marks: a straight run is one mark whose members wait on each other in order, and an edge
 * between marks joins the last task of the one to the first of the other. A motif stands for many
 * instances, so it places nothing.
 */
export function upstreamFromGraph(graph: ProjectDependencyGraphResponse | null | undefined): {
  upstreamOf: (taskId: string) => readonly string[];
  taskTitle: (taskId: string) => string | undefined;
} {
  const up = new Map<string, string[]>();
  const titles = new Map<string, string>();
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const add = (task: string, prerequisite: string) => {
    const key = idKey(task);
    up.set(key, [...(up.get(key) ?? []), prerequisite]);
  };
  for (const mark of graph?.marks ?? []) {
    if (mark.kind === 'TASK') {
      titles.set(idKey(mark.taskId), mark.title);
      first.set(mark.id, mark.taskId);
      last.set(mark.id, mark.taskId);
    } else if (mark.kind === 'RUN' || mark.kind === 'SETTLED') {
      mark.members.forEach((m, i) => {
        titles.set(idKey(m.taskId), m.title);
        if (mark.kind === 'RUN' && i > 0) add(m.taskId, mark.members[i - 1].taskId);
      });
      if (mark.members.length) {
        first.set(mark.id, mark.members[0].taskId);
        last.set(mark.id, mark.members[mark.members.length - 1].taskId);
      }
    }
  }
  for (const edge of graph?.edges ?? []) {
    const from = last.get(edge.sourceMarkId);
    const to = first.get(edge.targetMarkId);
    if (from && to) add(to, from);
  }
  return {
    upstreamOf: (taskId) => up.get(idKey(taskId)) ?? [],
    taskTitle: (taskId) => titles.get(idKey(taskId)),
  };
}
