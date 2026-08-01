import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskDependencyGraphResponse } from '../lib/taskDependencyGraph';
import { TaskDependencyList } from './TaskDependencyList';

const graph: TaskDependencyGraphResponse = {
  focusTaskId: 'middle',
  direction: 'both',
  nodes: [
    { id: 'root', title: 'Root task', status: 'DONE' },
    { id: 'middle', title: 'Middle task', status: 'OPEN' },
    { id: 'leaf', title: 'Leaf task', status: 'OPEN' },
  ],
  edges: [
    { sourceTaskId: 'root', targetTaskId: 'middle' },
    { sourceTaskId: 'middle', targetTaskId: 'leaf' },
  ],
};

describe('TaskDependencyList', () => {
  it('marks the current middle task and shows relationships in both directions', () => {
    const html = renderToStaticMarkup(
      <TaskDependencyList graph={graph} onOpenTask={() => undefined} />,
    );

    expect(html).toContain('tdg-list-row is-focus');
    expect(html).toContain('Current');
    expect(html).toContain('Depends on Root task · Required by Leaf task');
  });

  it('offers removal only for an incoming direct prerequisite', () => {
    const html = renderToStaticMarkup(
      <TaskDependencyList
        graph={graph}
        onOpenTask={() => undefined}
        onRemoveDependency={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Remove Root task as a prerequisite"');
    expect(html).not.toContain('aria-label="Remove Leaf task as a prerequisite"');
  });
});
