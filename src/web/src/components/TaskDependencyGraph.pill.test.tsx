import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DependencyNode } from './TaskDependencyGraph';

describe('the dependency graph node pill', () => {
  it('reads "Idle" with Will resume for a parked run something will wake', () => {
    // A node as the dependency-graph endpoint sends it: the task with the list's live overlays.
    const task = {
      id: 'waiting',
      title: 'Waiting task',
      status: 'OPEN',
      running: true,
      queued: false,
      runReason: 'WAITING' as const,
      queuedOnHold: false,
    };
    const props = { data: { task, isFocus: false } } as unknown as ComponentProps<typeof DependencyNode>;
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <DependencyNode {...props} />
      </ReactFlowProvider>,
    );

    expect(html).toContain('<span class="status-dot"></span>Idle</span>');
    expect(html).toContain('data-mark="WILL_RESUME"');
  });
});
