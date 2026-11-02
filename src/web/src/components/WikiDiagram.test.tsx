// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom lays nothing out, so Mermaid could not measure a label: its two calls are stand-ins.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

import { WIKI_DIAGRAM_COLORS, WikiDiagram, wikiDiagramFinish, wikiDiagramTurned } from './WikiDiagram';

/**
 * A section's diagram (contract `docs.diagram`): the flowchart the server wrote out again, drawn strict in the diagram
 * look (docs/mocks/wiki-diagram-look) in the page's theme, at its own size — top to bottom when it is a left-to-right one
 * too wide for the figure — and shown as code when it does not draw.
 */

const SOURCE = 'flowchart LR\n  n1["Turn stored"]\n  n2["Delivered"]\n  n1 --> n2';
const TURNED = 'flowchart TB\n  n1["Turn stored"]\n  n2["Delivered"]\n  n1 --> n2';

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

/** Mermaid's answer for a source: an SVG as wide as `widths` says for its first line. */
function drawsAt(widths: Record<string, number>): void {
  mermaid.render.mockImplementation(async (_id: string, source: string) => {
    const width = widths[source.split('\n')[0]];
    return { svg: `<svg data-drawn="${source.split('\n')[0]}" viewBox="0 0 ${width} 100" width="${width}"></svg>` };
  });
}

/** The figure's inside, as the browser would measure it: jsdom lays nothing out. */
let room = 0;
let resized: (() => void) | null = null;

describe("a section's diagram", () => {
  beforeEach(() => {
    room = 0;
    resized = null;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => room);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws the flowchart strict, in the diagram look’s light colours, at its own size', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-drawn="yes"><text>Turn stored</text></svg>' });
    await show(SOURCE);
    const figure = container.querySelector('figure.wk-dc-diagram');
    expect([figure?.getAttribute('role'), figure?.getAttribute('aria-label'), figure?.getAttribute('aria-busy')]).toEqual(['img', 'Diagram', 'false']);
    expect(figure?.querySelector('svg[data-drawn="yes"]')?.textContent).toBe('Turn stored');
    const light = WIKI_DIAGRAM_COLORS.light;
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      startOnLoad: false, securityLevel: 'strict', look: 'classic', theme: 'base',
      themeVariables: expect.objectContaining({ darkMode: false, fontSize: '13px', mainBkg: light.fill, nodeBorder: light.border, lineColor: light.line, clusterBkg: light.group }),
      flowchart: { useMaxWidth: false, curve: 'basis', nodeSpacing: 28, rankSpacing: 34, padding: 10, wrappingWidth: 200, minNodeWidth: 0, diagramPadding: 4 },
      themeCSS: expect.stringContaining(`.edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; font-size: 12px; color: ${light.label}; }`),
    }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^wk-diagram-[A-Za-z0-9_-]+$/u), SOURCE);
  });

  it('follows the page into its dark theme and back', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
    document.documentElement.setAttribute('data-theme', 'dark');
    await show(SOURCE);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: 'base', themeVariables: expect.objectContaining({ darkMode: true, mainBkg: WIKI_DIAGRAM_COLORS.dark.fill, textColor: WIKI_DIAGRAM_COLORS.dark.text }),
    }));
    await act(async () => document.documentElement.setAttribute('data-theme', 'light'));
    await settle();
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: false }) }));
    expect(mermaid.render.mock.calls.filter(([, source]) => source === SOURCE)).toHaveLength(2);
  });

  it('draws a left-to-right flowchart top to bottom while it is wider than the figure, and as written once it fits', async () => {
    drawsAt({ 'flowchart LR': 640, 'flowchart TB': 180 });
    room = 320;
    await show(SOURCE);
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/-tb$/u), TURNED);
    const drawing = () => container.querySelector('figure.wk-dc-diagram svg')?.getAttribute('data-drawn');
    expect(drawing()).toBe('flowchart TB');
    // The window widens: the figure has room for it as written, which needs no drawing again.
    room = 700;
    await act(async () => resized?.());
    expect(drawing()).toBe('flowchart LR');
    room = 600;
    await act(async () => resized?.());
    expect(drawing()).toBe('flowchart TB');
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it('keeps a diagram as written when turning it is no narrower, when the figure is unmeasured, and when it runs top to bottom', async () => {
    drawsAt({ 'flowchart LR': 640, 'flowchart TB': 700 });
    room = 320;
    await show(SOURCE);
    expect(container.querySelector('figure svg')?.getAttribute('data-drawn')).toBe('flowchart LR');
    act(() => root.unmount());
    root = createRoot(container);
    drawsAt({ 'flowchart LR': 640, 'flowchart TB': 180 });
    room = 0;
    await show(SOURCE);
    expect(container.querySelector('figure svg')?.getAttribute('data-drawn')).toBe('flowchart LR');
    mermaid.render.mockClear();
    await show(TURNED);
    expect(mermaid.render.mock.calls.map(([, source]) => source)).toEqual([TURNED]);
    expect(wikiDiagramTurned(TURNED)).toBeNull();
    expect(wikiDiagramTurned('flowchart LR\n  n1["a"]\n  subgraph s1["g"]\n    direction LR\n  end')).toBe('flowchart TB\n  n1["a"]\n  subgraph s1["g"]\n    direction LR\n  end');
  });

  it('stands a group’s title at its top left, and cuts each layer’s links out under its own labels and titles', () => {
    const template = document.createElement('template');
    template.innerHTML = [
      '<svg id="wk-diagram-x" viewBox="0 0 400 300"><g class="root">',
      '<g class="clusters"><g class="cluster"><rect x="12" y="40" width="208" height="200"></rect>',
      '<g class="cluster-label" transform="translate(90.5, 40)"><foreignObject width="50" height="18"></foreignObject></g></g></g>',
      '<g class="edges edgePaths"><path d="M0,0L10,10"></path></g>',
      '<g class="edgeLabels"><g class="edgeLabel" transform="translate(65, 640)"><g class="label" transform="translate(-6, -9)">',
      '<foreignObject width="12" height="18"></foreignObject></g></g>',
      '<g class="edgeLabel"><g class="label" transform="translate(0, 0)"><foreignObject width="0" height="0"></foreignObject></g></g></g>',
      '<g class="nodes"></g></g></svg>',
    ].join('');
    const svg = template.content.firstElementChild!;
    wikiDiagramFinish(svg);
    expect(svg.querySelector('.cluster-label')?.getAttribute('transform')).toBe('translate(22, 44)');
    const mask = svg.querySelector('g.root > mask');
    expect(mask?.id).toBe('wk-diagram-x-links-0');
    expect([...mask!.querySelectorAll('rect')].map((rect) => ['x', 'y', 'width', 'height', 'fill'].map((name) => rect.getAttribute(name)).join(' ')))
      .toEqual(['-100000 -100000 200000 200000 white', '56 630 18 20 black', '19 43 56 20 black']);
    expect(svg.querySelector('.edgePaths')?.getAttribute('mask')).toBe('url(#wk-diagram-x-links-0)');
    // A diagram whose links have no label is left as it was.
    template.innerHTML = '<svg id="y"><g class="root"><g class="edges edgePaths"></g><g class="edgeLabels"></g></g></svg>';
    wikiDiagramFinish(template.content.firstElementChild!);
    expect(template.content.querySelector('mask')).toBeNull();
    expect(template.content.querySelector('.edgePaths')?.hasAttribute('mask')).toBe(false);
  });

  it('shows its source as code when it does not draw', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'));
    await show(SOURCE);
    expect(container.querySelector('figure')).toBeNull();
    expect(container.querySelector('pre.wk-dc-code code')?.textContent).toBe(SOURCE);
  });
});
