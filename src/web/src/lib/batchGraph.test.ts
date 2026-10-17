import { describe, expect, it } from 'vitest';
import { batchPreviewGraph, buildBatchGraph, describeShape, type BatchTaskInput } from './batchGraph';

const chain = (n: number): BatchTaskInput[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `step ${i}`,
    ref: `s${i}`,
    ...(i > 0 ? { dependsOnRefs: [`s${i - 1}`] } : {}),
  }));

const fanOut = (n: number): BatchTaskInput[] => [
  { title: 'root', ref: 'r' },
  ...Array.from({ length: n }, (_, i) => ({ title: `leaf ${i}`, ref: `l${i}`, dependsOnRefs: ['r'] })),
];

describe('buildBatchGraph', () => {
  it('puts every prerequisite above what waits on it', () => {
    const g = buildBatchGraph(chain(4));

    expect(g.nodes.map((n) => n.layer)).toEqual([0, 1, 2, 3]);
    expect(g.depth).toBe(4);
    expect(g.width).toBe(1);
  });

  it('spreads a fan-out across one layer', () => {
    const g = buildBatchGraph(fanOut(3));

    expect(g.nodes.map((n) => n.layer)).toEqual([0, 1, 1, 1]);
    expect(g.width).toBe(3);
    expect(g.depth).toBe(2);
  });

  it('places a join below its deepest prerequisite, not its shallowest', () => {
    // Shortest-path layering would put `join` at layer 1, drawing an edge from layer 2 upward and
    // claiming an order the dispatcher will not follow.
    const g = buildBatchGraph([
      { title: 'a', ref: 'a' },
      { title: 'b', ref: 'b', dependsOnRefs: ['a'] },
      { title: 'join', ref: 'j', dependsOnRefs: ['a', 'b'] },
    ]);

    expect(g.nodes[2].layer).toBe(2);
    expect(g.edges).toEqual([
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 2 },
    ]);
  });

  it('lays out unrelated tasks side by side with no edges', () => {
    const g = buildBatchGraph([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

    expect(g.edges).toEqual([]);
    expect(g.width).toBe(3);
    expect(g.depth).toBe(1);
  });

  it('flags a task waiting on something outside the batch', () => {
    // It draws as a root because its prerequisite is not on screen; without the flag the picture
    // would say it can start, which is the opposite of true.
    const g = buildBatchGraph([{ title: 'a', dependsOnTaskIds: ['existing-1'] }]);

    expect(g.nodes[0].layer).toBe(0);
    expect(g.nodes[0].waitsOutside).toBe(true);
  });

  it('ignores a ref naming something outside the window', () => {
    // The card draws at most twelve of a fifty-task batch, so refs pointing past the window are
    // ordinary. They must not produce an edge to a node that is not there.
    const g = buildBatchGraph([{ title: 'a', ref: 'a', dependsOnRefs: ['not-shown'] }]);

    expect(g.edges).toEqual([]);
    expect(g.nodes[0].layer).toBe(0);
  });

  it('handles an empty batch', () => {
    expect(buildBatchGraph([])).toEqual({ nodes: [], edges: [], width: 0, depth: 0 });
  });
});

describe('describeShape', () => {
  it('names the shapes a person actually recognises', () => {
    expect(describeShape(buildBatchGraph(chain(10)))).toBe('a chain of 10');
    expect(describeShape(buildBatchGraph(fanOut(4)))).toBe('4 in parallel after 1');
    expect(describeShape(buildBatchGraph([{ title: 'a' }, { title: 'b' }]))).toBe(
      '2 independent tasks',
    );
    expect(describeShape(buildBatchGraph([{ title: 'a' }]))).toBe('a single task');
  });

  it('describes a deeper mixed graph by its levels and its widest point', () => {
    const g = buildBatchGraph([
      { title: 'a', ref: 'a' },
      { title: 'b', ref: 'b', dependsOnRefs: ['a'] },
      { title: 'c', ref: 'c', dependsOnRefs: ['a'] },
      { title: 'd', ref: 'd', dependsOnRefs: ['b'] },
    ]);

    expect(describeShape(g)).toBe('3 levels, up to 2 in parallel');
  });

  it('says "after 1" only when one task releases the rest', () => {
    // Three tasks that release a fourth: "3 in parallel after 1" would read backwards.
    const g = buildBatchGraph([
      { title: 'a', ref: 'a' },
      { title: 'b', ref: 'b' },
      { title: 'c', ref: 'c' },
      { title: 'd', ref: 'd', dependsOnRefs: ['a', 'b'] },
    ]);

    expect(describeShape(g)).toBe('2 levels, up to 3 in parallel');
  });

  it('says nothing about an empty batch', () => {
    expect(describeShape(buildBatchGraph([]))).toBe('');
  });
});

describe('batchPreviewGraph', () => {
  it('feeds the project page\'s canvas one mark per task and one edge per prerequisite', () => {
    const { graph } = batchPreviewGraph([
      { title: 'root', ref: 'r' },
      { title: 'left', ref: 'l', dependsOnRefs: ['r'] },
      { title: 'right', ref: 'x', dependsOnRefs: ['r'] },
    ]);

    expect(graph.marks.map((m) => m.id)).toEqual(['r', 'l', 'x']);
    expect(graph.marks.map((m) => m.title)).toEqual(['root', 'left', 'right']);
    expect(graph.edges).toEqual([
      { sourceMarkId: 'r', targetMarkId: 'l' },
      { sourceMarkId: 'r', targetMarkId: 'x' },
    ]);
    expect(graph.taskCount).toBe(3);
    expect(graph.folded).toBe(false);
    expect(graph.truncated).toBe(false);
  });

  it('reads a plan the way the project page will: what nothing holds back is ready to run', () => {
    const { graph } = batchPreviewGraph([
      { title: 'root', ref: 'r' },
      { title: 'mid', ref: 'm', dependsOnRefs: ['r'] },
      { title: 'join', ref: 'j', dependsOnRefs: ['r', 'm'] },
    ]);

    expect(graph.marks.map((m) => m.workState)).toEqual(['READY', 'BLOCKED', 'BLOCKED']);
    // Nothing has been written yet, so no mark claims a status beyond the one creating it gives.
    expect(graph.marks.every((m) => m.status === 'OPEN' && m.parentTaskId === null)).toBe(true);
  });

  it('counts what it cannot draw: work waiting on a task that already exists', () => {
    const { graph, waitsOutside } = batchPreviewGraph([
      { title: 'a', ref: 'a' },
      { title: 'plugs in', ref: 'p', dependsOnTaskIds: ['existing-1'] },
      { title: 'after it', ref: 'q', dependsOnRefs: ['p'] },
    ]);

    // No edge is invented to a mark that is not on the canvas — `existing-1` has none — and the
    // task waiting on it is not called ready.
    expect(graph.edges).toEqual([{ sourceMarkId: 'p', targetMarkId: 'q' }]);
    expect(graph.marks.map((m) => m.workState)).toEqual(['READY', 'BLOCKED', 'BLOCKED']);
    expect(waitsOutside).toBe(1);
  });

  it('names a task the batch gave no ref by its place in the window', () => {
    // Nothing can name a ref-less task (a `dependsOnRefs` entry naming nothing is refused), so these
    // are the roots of two loose chains — and they still need ids of their own to be drawn.
    const { graph } = batchPreviewGraph([{ title: 'first' }, { title: 'second' }]);

    expect(graph.marks.map((m) => m.id)).toEqual(['#1', '#2']);
    expect(graph.marks.every((m) => m.workState === 'READY')).toBe(true);
  });

  it('has nothing to draw for an empty batch', () => {
    const { graph, waitsOutside } = batchPreviewGraph([]);
    expect(graph.marks).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(waitsOutside).toBe(0);
  });
});
