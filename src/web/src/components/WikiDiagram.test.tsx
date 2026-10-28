// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom lays nothing out, so Mermaid could not measure a label: its two calls are stand-ins.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

import { WikiDiagram } from './WikiDiagram';

/**
 * A section's diagram (contract `docs.diagram`): the flowchart the server wrote out again, drawn strict, in the page's
 * theme and at its own size, and shown as code when it does not draw.
 */

const SOURCE = 'flowchart LR\n  n1["Turn stored"]\n  n2["Delivered"]\n  n1 --> n2';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  document.documentElement.setAttribute('data-theme', 'light');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute('data-theme');
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function show(source: string): Promise<void> {
  await act(async () => root.render(<WikiDiagram source={source} />));
  await settle();
}

describe("a section's diagram", () => {
  it('draws the flowchart strict, in the page’s light theme, at its own size', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-drawn="yes"><text>Turn stored</text></svg>' });
    await show(SOURCE);
    const figure = container.querySelector('figure.wk-dc-diagram');
    expect([figure?.getAttribute('role'), figure?.getAttribute('aria-label'), figure?.getAttribute('aria-busy')]).toEqual(['img', 'Diagram', 'false']);
    expect(figure?.querySelector('svg[data-drawn="yes"]')?.textContent).toBe('Turn stored');
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', flowchart: { useMaxWidth: false } }),
    );
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^wk-diagram-[A-Za-z0-9_-]+$/u), SOURCE);
  });

  it('follows the page into its dark theme and back', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
    document.documentElement.setAttribute('data-theme', 'dark');
    await show(SOURCE);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
    await act(async () => document.documentElement.setAttribute('data-theme', 'light'));
    await settle();
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'neutral' }));
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it('shows its source as code when it does not draw', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'));
    await show(SOURCE);
    expect(container.querySelector('figure')).toBeNull();
    expect(container.querySelector('pre.wk-dc-code code')?.textContent).toBe(SOURCE);
  });
});
