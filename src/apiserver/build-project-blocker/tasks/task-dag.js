"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resultingEdges = resultingEdges;
exports.findCycle = findCycle;
exports.stateChanges = stateChanges;
exports.effectiveOps = effectiveOps;
const task_dependencies_1 = require("./task-dependencies");
// Ids are uuid or base62 -- [0-9a-zA-Z-] -- so a space cannot occur inside one and the join is
// unambiguous. (An earlier version separated with a literal NUL, which worked and made the
// whole file undiffable: git reads one control byte as "this is binary".)
const key = (e) => `${e.taskId} ${e.dependsOnTaskId}`;
/**
 * The edge set `ops` would produce, applied to `current`.
 *
 * Removals are applied before additions, so a batch that re-points an edge (remove A→B, add A→B)
 * ends with it present. That order is what makes the batch describable as "the graph afterwards"
 * rather than as a sequence whose meaning depends on how the caller happened to sort it.
 */
function resultingEdges(current, ops) {
    const edges = new Map(current.map((e) => [key(e), e]));
    for (const op of ops)
        if (op.op === 'remove')
            edges.delete(key(op));
    for (const op of ops)
        if (op.op === 'add')
            edges.set(key(op), op);
    return [...edges.values()];
}
/**
 * A cycle in `edges`, as the path that closes it, or null when the graph is acyclic.
 *
 * The path, not a boolean: a batch is rejected whole, and "these 14 edges contain a cycle" leaves
 * the proposer to bisect it themselves. Following dependency edges (dependent -> prerequisite),
 * so the returned path reads in the direction the graph is written.
 *
 * Whole-graph rather than the per-edge check `addDependency` uses. Applied one at a time against
 * the graph as it stands, a batch containing removals depends on the order the ops arrive in —
 * removing an edge can make a later addition legal that was not legal before it. Checking the
 * result once is both correct and independent of order.
 */
function findCycle(edges) {
    const adjacency = new Map();
    for (const e of edges) {
        const list = adjacency.get(e.taskId);
        if (list)
            list.push(e.dependsOnTaskId);
        else
            adjacency.set(e.taskId, [e.dependsOnTaskId]);
    }
    const UNVISITED = 0;
    const ON_STACK = 1;
    const DONE = 2;
    const state = new Map();
    const path = [];
    // Iterative rather than recursive: this deployment has lists of 250+ tasks and a chain that
    // deep would be a stack frame per edge on a path nobody has a reason to keep shallow.
    const walk = (start) => {
        const stack = [{ node: start, next: 0 }];
        state.set(start, ON_STACK);
        path.push(start);
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const neighbours = adjacency.get(frame.node) ?? [];
            if (frame.next >= neighbours.length) {
                state.set(frame.node, DONE);
                path.pop();
                stack.pop();
                continue;
            }
            const next = neighbours[frame.next++];
            const seen = state.get(next) ?? UNVISITED;
            if (seen === ON_STACK)
                return [...path.slice(path.indexOf(next)), next];
            if (seen === DONE)
                continue;
            state.set(next, ON_STACK);
            path.push(next);
            stack.push({ node: next, next: 0 });
        }
        return null;
    };
    for (const node of adjacency.keys()) {
        if ((state.get(node) ?? UNVISITED) !== UNVISITED)
            continue;
        const cycle = walk(node);
        if (cycle)
            return cycle;
    }
    return null;
}
/** Prerequisites per dependent, for `edges`. */
function prerequisitesByTask(edges) {
    const out = new Map();
    for (const e of edges) {
        const list = out.get(e.taskId);
        if (list)
            list.push(e.dependsOnTaskId);
        else
            out.set(e.taskId, [e.dependsOnTaskId]);
    }
    return out;
}
/**
 * Which tasks change dependency state, given the statuses of every task involved.
 *
 * This is the part of a proposal worth approving. The edge list says what is being written; this
 * says what happens as a result — above all which tasks become READY, because the sweep will pick
 * those up within the minute and start spending real runs on them. A restructure that reads as a
 * tidy-up and silently releases 40 tasks is the outcome an approval exists to catch.
 */
function stateChanges(before, after, statusOf) {
    const prereqBefore = prerequisitesByTask(before);
    const prereqAfter = prerequisitesByTask(after);
    // Statuses only, deliberately: this answers "what do these EDGES change", not "is it runnable
    // now". §13.3 DEP's gate belongs to the second question, and folding it in here would make a
    // proposal that touches nothing at all report state changes because a check concluded elsewhere.
    const statesFor = (prereqs, taskId) => (0, task_dependencies_1.computeDependencyState)((0, task_dependencies_1.statusPrerequisites)((prereqs.get(taskId) ?? [])
        .map((id) => statusOf.get(id))
        .filter((s) => s !== undefined)));
    const out = [];
    for (const taskId of new Set([...prereqBefore.keys(), ...prereqAfter.keys()])) {
        const from = statesFor(prereqBefore, taskId);
        const to = statesFor(prereqAfter, taskId);
        if (from !== to)
            out.push({ taskId, from, to });
    }
    return out;
}
/**
 * The ops that would actually write something, given `current`.
 *
 * An add of an edge already there and a remove of one that is not are both no-ops, and saying so
 * is worth more than silently counting them: a proposal that is entirely no-ops means the agent
 * is working from a stale read of the graph, which is exactly when a human should not click
 * approve.
 */
function effectiveOps(current, ops) {
    const present = new Set(current.map(key));
    const effective = [];
    const noop = [];
    for (const op of ops) {
        const exists = present.has(key(op));
        if (op.op === 'add' ? exists : !exists)
            noop.push(op);
        else
            effective.push(op);
    }
    return { effective, noop };
}
//# sourceMappingURL=task-dag.js.map