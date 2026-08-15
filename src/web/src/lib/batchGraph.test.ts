import { describe, expect, it } from 'vitest';
import { buildBatchGraph, describeShape, shouldDraw, type BatchTaskInput } from './batchGraph';

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
    expect(g.nodes.map((n) => n.column)).toEqual([0, 0, 1, 2]);
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

  it('says nothing about an empty batch', () => {
    expect(describeShape(buildBatchGraph([]))).toBe('');
  });
});

describe('shouldDraw', () => {
  it('draws a shape that stays legible', () => {
    expect(shouldDraw(buildBatchGraph(fanOut(3)))).toBe(true);
    expect(shouldDraw(buildBatchGraph(chain(5)))).toBe(true);
  });

  it('refuses a fan-out too wide to read', () => {
    // Six nodes across scale the labels under eight points. The sentence "6 in parallel after 1"
    // says the same thing and can actually be read.
    expect(shouldDraw(buildBatchGraph(fanOut(6)))).toBe(false);
    expect(describeShape(buildBatchGraph(fanOut(6)))).toBe('6 in parallel after 1');
  });

  it('refuses a chain too deep to be worth the card', () => {
    expect(shouldDraw(buildBatchGraph(chain(9)))).toBe(false);
    expect(describeShape(buildBatchGraph(chain(9)))).toBe('a chain of 9');
  });

  it('refuses a batch with no edges — there is no shape to draw', () => {
    expect(shouldDraw(buildBatchGraph([{ title: 'a' }, { title: 'b' }]))).toBe(false);
  });
});
