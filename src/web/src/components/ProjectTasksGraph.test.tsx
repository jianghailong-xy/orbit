// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  layoutProjectDependencyGraph,
  type ProjectDependencyGraphResponse,
} from '../lib/projectDependencyGraph';

// The rest of the web suite renders with `react-dom/server`, which never resolves a `lazy()`
// import — and what this section is FOR is what appears once one does, so this file mounts into a
// real DOM. jsdom is a dev dependency of @orbit/web for exactly this, selected per file by the
// docblock above; every other test file keeps running in node.

/**
 * The graph module is replaced by a stub that records the moment it is imported.
 *
 * This is the assertion that the `lazy()` boundary is real: the flag is flipped by the module
 * FACTORY, which vitest runs only when something actually imports the module — so an eager import
 * would set it even for the oversized project that must never pay for the chunk. Stubbing it also
 * keeps React Flow itself out of jsdom, which has no ResizeObserver for it to measure with.
 */
const graphModule = vi.hoisted(() => ({ imported: false }));
vi.mock('./ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  graphModule.imported = true;
  return {
    ProjectDependencyGraph: ({ projectId }: { projectId: string }) =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }, projectId),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The module registry is reset per test so `graphModule.imported` measures THIS test's imports
  // rather than accumulating across the file — otherwise the "never imported when oversized"
  // claim would only hold for whichever test happened to run first.
  vi.resetModules();
  graphModule.imported = false;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The component under test, re-imported per test so the reset registry above means something. */
async function loadSection() {
  return (await import('./ProjectTasksGraph')).ProjectTasksGraph;
}

async function mount(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  // A lazy import resolves on a macrotask, so a microtask flush would leave every assertion below
  // looking at the Suspense fallback.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const testid = (name: string) => container.querySelector(`[data-testid="${name}"]`);

describe('ProjectTasksGraph', () => {
  it('draws the graph on its own, with nothing for the reader to select first', async () => {
    const Section = await loadSection();
    await mount(<Section projectId="p1" taskCount={12} />);

    expect(graphModule.imported).toBe(true);
    expect(testid('project-dependency-graph')).not.toBeNull();
    expect(testid('project-graph-too-large')).toBeNull();
    // Named: an unlabelled canvas under the panorama header does not say what it is a picture of.
    expect(container.textContent).toContain('Task graph');
  });

  it('says so instead of drawing when the project has more nodes than the threshold', async () => {
    const { PROJECT_GRAPH_MAX_NODES } = await import('./ProjectTasksGraph');
    const Section = await loadSection();
    // 118 is the real shape this guards against: the LFS project, which is a 118-task chain.
    await mount(<Section projectId="p1" taskCount={118} />);

    expect(testid('project-graph-too-large')).not.toBeNull();
    expect(container.textContent).toContain('118');
    expect(container.textContent).toContain(String(PROJECT_GRAPH_MAX_NODES));
    expect(testid('project-dependency-graph')).toBeNull();
    // The threshold sits on the eager side of the boundary, so an oversized project does not pay
    // for the chunk in order to be told it cannot use it.
    expect(graphModule.imported).toBe(false);
  });
});

/**
 * The structural decision the Graph view is built on, asserted on the layout that implements it:
 * dependency edges are edges, parent/child is a box. Pure and DOM-free, so it is here rather than
 * in a second file — this is the same feature, and the rule is what makes the picture readable.
 */
describe('layoutProjectDependencyGraph', () => {
  const task = (id: string, parentTaskId: string | null = null, status = 'OPEN') => ({
    id,
    title: `Task ${id}`,
    status,
    parentTaskId,
  });

  const graph: ProjectDependencyGraphResponse = {
    nodes: [
      task('parent'),
      task('child-a', 'parent'),
      task('child-b', 'parent'),
      task('loner'),
      task('after'),
    ],
    edges: [
      { sourceTaskId: 'child-a', targetTaskId: 'child-b' },
      { sourceTaskId: 'parent', targetTaskId: 'after' },
    ],
    truncated: false,
    limits: { maxNodes: 500 },
  };

  it('draws a parent as a box holding its subtasks, never as a node', () => {
    const layout = layoutProjectDependencyGraph(graph);

    expect(layout.groups.map((g) => g.task.id)).toEqual(['parent']);
    expect(layout.groups[0].members.map((m) => m.id).sort()).toEqual(['child-a', 'child-b']);
    // The parent is the frame, so it is not also placed as a node inside it.
    expect(layout.placements.map((p) => p.task.id)).not.toContain('parent');
    expect(layout.placements.find((p) => p.task.id === 'child-a')?.groupId).toBe('parent');
    expect(layout.placements.find((p) => p.task.id === 'loner')?.groupId).toBeNull();
  });

  it('carries dependency edges only — no edge is ever a parent/child link', () => {
    const layout = layoutProjectDependencyGraph(graph);

    expect(layout.edges).toEqual(graph.edges);
    // If membership were drawn there would be a parent→child edge in here; there is not.
    expect(
      layout.edges.some((e) => e.sourceTaskId === 'parent' && e.targetTaskId.startsWith('child')),
    ).toBe(false);
  });

  it('keeps subtasks inside their box and boxes big enough to hold them', () => {
    const layout = layoutProjectDependencyGraph(graph);
    const box = layout.groups[0];

    for (const member of ['child-a', 'child-b']) {
      const at = layout.placements.find((p) => p.task.id === member)!;
      // Member coordinates are relative to the box, which is what React Flow's `extent: 'parent'`
      // expects — and they clear the header the box's own title sits in.
      expect(at.x).toBeGreaterThan(0);
      expect(at.y).toBeGreaterThan(0);
      expect(at.x).toBeLessThan(box.width);
      expect(at.y).toBeLessThan(box.height);
    }
  });

  it('drops an edge naming a task the graph does not carry rather than drawing it to nothing', () => {
    const layout = layoutProjectDependencyGraph({
      ...graph,
      edges: [...graph.edges, { sourceTaskId: 'loner', targetTaskId: 'not-in-this-project' }],
    });

    expect(layout.edges).toEqual(graph.edges);
  });
});
