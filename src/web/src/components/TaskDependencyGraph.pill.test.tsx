import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DependencyNode } from './TaskDependencyGraph';

// A node as the dependency-graph endpoint sends it: the task with the list's live overlays.
const waiting = {
  id: 'waiting',
  title: 'Waiting task',
  status: 'OPEN',
  running: true,
  queued: false,
  runReason: 'WAITING' as const,
  queuedOnHold: false,
};
const draw = (task: object) => {
  const props = { data: { task, isFocus: false } } as unknown as ComponentProps<typeof DependencyNode>;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <DependencyNode {...props} />
    </ReactFlowProvider>,
  );
};
const labelOf = (html: string) => html.match(/<button[^>]*aria-label="([^"]*)"/)?.[1];

describe('the dependency graph node pill', () => {
  it('reads "Idle" with Will resume for a parked run something will wake', () => {
    const html = draw(waiting);
    expect(html).toMatch(/data-state="IDLE".*?>Idle<\/span>/);
    expect(html).toContain('data-mark="WILL_RESUME"');
  });
  it('names a waiting run by the pill\'s state and marks in the node\'s aria-label', () => {
    expect(labelOf(draw(waiting))).toBe('Waiting task, Idle · Will resume');
  });
  it('names a held queued run by its state and mark', () => {
    const held = { ...waiting, running: false, queued: true, runReason: 'TURN', queuedOnHold: true };
    expect(labelOf(draw(held))).toBe('Waiting task, Queued · On hold');
  });
  it('keeps the earlier aria-label from an older server (no queuedOnHold)', () => {
    const { queuedOnHold: _omit, ...older } = waiting;
    expect(labelOf(draw(older))).toBe('Waiting task, Running');
    expect(labelOf(draw({ ...older, running: false, queued: true }))).toBe('Waiting task, Queued');
  });
});
