// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  layoutProjectDependencyGraph,
  type ProjectDependencyGraphResponse,
} from '../lib/projectDependencyGraph';

const stylesPath = [
  resolve(process.cwd(), 'src/index.css'),
  resolve(process.cwd(), 'src/web/src/index.css'),
].find(existsSync);
if (!stylesPath) throw new Error('index.css not found from the test working directory');
const styles = readFileSync(stylesPath, 'utf8');

// The rest of the web suite renders with `react-dom/server`, which never resolves a `lazy()`
// import — and what this section is FOR is what appears once one does, so this file mounts into a
// real DOM. jsdom is a dev dependency of @orbit/web for exactly this, selected per file by the
// docblock above; every other test file keeps running in node.

/**
 * The graph module is replaced by a stub that records the moment it is imported.
 *
 * This is the assertion that the `lazy()` boundary is real: the flag is flipped by the module
 * FACTORY, which vitest runs only when something actually imports the module, so a section that
 * reached the graph eagerly would set it before the render. Stubbing it also keeps React Flow
 * itself out of jsdom, which has no ResizeObserver for it to measure with.
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
  // rather than accumulating across the file.
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

// Past the 5s default: `vi.resetModules()` above means each test re-imports this component and
// everything under it (antd included) from cold before it can mount, which takes seconds on a
// loaded machine. A budget for a slow import, not for a hang — the assertions are unchanged.
describe('ProjectTasksGraph', { timeout: 20_000 }, () => {
  it('draws the graph on its own, with nothing for the reader to select first', async () => {
    const Section = await loadSection();
    await mount(<Section projectId="p1" />);

    expect(graphModule.imported).toBe(true);
    expect(testid('project-dependency-graph')).not.toBeNull();
    // Named: an unlabelled canvas under the panorama header does not say what it is a picture of.
    expect(container.textContent).toContain('Task graph');

    // jsdom has no layout engine, so assert the narrow-screen flex contract directly: the section
    // name keeps its line while the lower-priority legend is the one item allowed to shrink.
    expect(container.querySelector('.pdg-section-title')?.textContent).toBe('Task graph');
    const legend = container.querySelector<HTMLElement>('.pdg-legend');
    expect(legend?.title).toBe('Prerequisite → dependent · boxes are parent tasks');

    const titleRule =
      styles.match(/\.pdg-section-title\.ant-typography\s*\{([^}]*)\}/)?.[1] ?? '';
    const legendRule = styles.match(/\.pdg-legend\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(titleRule).toContain('flex: none');
    expect(titleRule).toContain('white-space: nowrap');
    expect(legendRule).toContain('flex: 0 1 auto');
    expect(legendRule).toContain('min-width: 0');
    expect(legendRule).toContain('overflow: hidden');
    expect(legendRule).toContain('text-overflow: ellipsis');
    expect(legendRule).toContain('white-space: nowrap');
  });
});

/**
 * The size that used to be refused.
 *
 * The section was handed the project's task total and printed "too large to draw" above 30, which
 * is how the LFS project — a 118-task chain — got a message where its plan should have been. It
 * takes no count now, so the guard against that returning is here: the real pipeline, at the real
 * size, drawing every task and every edge.
 */
describe('a project past the old 30-task threshold', () => {
  const chain = (length: number): ProjectDependencyGraphResponse => ({
    marks: Array.from({ length }, (_, i) => ({
      kind: 'TASK' as const,
      id: `t${i}`,
      taskId: `t${i}`,
      title: `Step ${i + 1}`,
      status: 'OPEN',
      parentTaskId: null,
    })),
    edges: Array.from({ length: length - 1 }, (_, i) => ({
      sourceMarkId: `t${i}`,
      targetMarkId: `t${i + 1}`,
    })),
    taskCount: length,
    folded: false,
    truncated: false,
    limits: { maxTasks: 50_000, maxMarks: 500 },
  });

  it('lays out all 118 of its tasks, none of them dropped to fit', () => {
    const layout = layoutProjectDependencyGraph(chain(118));

    expect(layout.placements).toHaveLength(118);
    expect(layout.edges).toHaveLength(117);
    // A chain laid out left to right is one rank per task, so no two tasks share an x: the whole
    // plan is placed, end to end, rather than trimmed to a size a threshold would allow.
    expect(new Set(layout.placements.map((placement) => placement.x)).size).toBe(118);
  });
});
