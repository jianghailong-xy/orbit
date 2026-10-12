// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BatchPlanGraph from './BatchPlanGraph';
import type { BatchTaskInput } from '../lib/batchGraph';

/**
 * The canvas itself is React Flow, which jsdom cannot lay out; what this file is about is the
 * decision in FRONT of it — draw or list — so the canvas is a marker that says what it was handed.
 * `startPlanGraphFits` stays the real one: it is the arithmetic both this card and the start card
 * decide with.
 */
vi.mock('./ProjectDependencyGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ProjectDependencyGraph')>();
  return {
    ...actual,
    ProjectDependencyGraph: ({ data }: { data: { marks: Array<{ title: string; workState?: string }> } }) =>
      createElement(
        'div',
        { 'data-testid': 'plan-canvas' },
        data.marks.map((mark) => `${mark.title}:${mark.workState ?? ''}`).join(' '),
      ),
  };
});

/** A card is this wide in the conversation it sits in. */
const CARD_WIDTH = 600;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  // jsdom lays nothing out: the card's width is the test's to give, as it is the browser's.
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(CARD_WIDTH);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function show(tasks: BatchTaskInput[], fallback: ReactNode = null): Promise<void> {
  await act(async () => {
    root.render(<BatchPlanGraph tasks={tasks} fallback={fallback} />);
  });
}

const chain = (length: number): BatchTaskInput[] =>
  Array.from({ length }, (_, i) => ({
    title: `step ${i}`,
    ref: `s${i}`,
    ...(i > 0 ? { dependsOnRefs: [`s${i - 1}`] } : {}),
  }));

describe('the batch card\'s picture', () => {
  it('draws a plan that fits, as the project page reads it', async () => {
    await show([
      { title: 'root', ref: 'r' },
      { title: 'left', ref: 'l', dependsOnRefs: ['r'] },
      { title: 'right', ref: 'x', dependsOnRefs: ['r'] },
    ]);

    expect(container.querySelector('.batch-graph')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-canvas"]')?.textContent).toBe(
      'root:READY left:BLOCKED right:BLOCKED',
    );
  });

  it('lists instead when there is no shape to draw', async () => {
    await show(
      [{ title: 'a' }, { title: 'b' }],
      createElement('ul', { 'data-testid': 'titles' }),
    );

    expect(container.querySelector('[data-testid="plan-canvas"]')).toBeNull();
    expect(container.querySelector('[data-testid="titles"]')).not.toBeNull();
    expect(container.querySelector('.batch-graph')).toBeNull();
  });

  it('lists instead when the plan does not fit the card', async () => {
    // Twelve steps top to bottom is taller than a card: the titles are the honest reading there.
    await show(chain(12), createElement('ul', { 'data-testid': 'titles' }));

    expect(container.querySelector('[data-testid="plan-canvas"]')).toBeNull();
    expect(container.querySelector('[data-testid="titles"]')).not.toBeNull();
  });

  it('says in words what the picture cannot draw', async () => {
    await show([
      { title: 'root', ref: 'r' },
      { title: 'plugs in', ref: 'p', dependsOnRefs: ['r'], dependsOnTaskIds: ['existing-1'] },
    ]);

    expect(container.querySelector('.batch-graph-foot')?.textContent).toBe(
      '1 waits on a task outside this batch',
    );
  });
});
