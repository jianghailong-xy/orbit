import { useEffect, useId, useLayoutEffect, useState } from 'react';
import { WIKI_DOC_DIAGRAM } from '../lib/wikiDocs';

type Theme = 'light' | 'dark';
type Mermaid = (typeof import('mermaid'))['default'];
type MermaidConfig = Parameters<Mermaid['initialize']>[0];

let loading: Promise<Mermaid> | null = null;

/** Mermaid, loaded the first time a page has a diagram to draw: its own chunk, which no other page pays for. */
function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((module) => module.default);
  return loading;
}

/** The page's theme as `<html data-theme>` has it (lib/theme.tsx), followed as it changes. */
function usePageTheme(): Theme {
  const read = (): Theme => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * A diagram's colours in the page's two themes (docs/mocks/wiki-diagram-look, look A): white cards with a grey hairline
 * on the figure's fill; in the dark, cards and their edges a white veil over whatever fill the figure has, so they stand
 * off it as much on every page. The apps carry these two lines as they are (WikiDiagram.swift, WikiDiagram.kt).
 */
export const WIKI_DIAGRAM_COLORS = {
  light: { fill: '#ffffff', border: '#d5d8dd', text: '#1f2329', label: '#646a73', line: '#9aa0a8', group: 'rgba(0, 0, 0, 0.035)', groupBorder: 'rgba(0, 0, 0, 0.06)' },
  dark: { fill: 'rgba(255, 255, 255, 0.07)', border: 'rgba(255, 255, 255, 0.18)', text: '#c9ced5', label: '#a7adb6', line: '#6e737b', group: 'rgba(255, 255, 255, 0.035)', groupBorder: 'rgba(255, 255, 255, 0.06)' },
} as const;

/**
 * Mermaid's options for a diagram: strict, its classic look (no shadows, no gradients) over its base theme in the
 * diagram's colours, a size smaller than the text and closer together, a label kept on one line up to 200 px, and a few
 * rules no theme variable reaches — rounded cards, a group's title and a link's label a size smaller again, and no box
 * behind a link's label (wikiDiagramFinish cuts the link out under it instead).
 */
export function wikiDiagramOptions(dark: boolean, fontFamily: string): MermaidConfig {
  const c = dark ? WIKI_DIAGRAM_COLORS.dark : WIKI_DIAGRAM_COLORS.light;
  return {
    startOnLoad: false, securityLevel: 'strict', look: 'classic', theme: 'base', fontFamily,
    themeVariables: { darkMode: dark, fontSize: '13px', primaryColor: c.fill, mainBkg: c.fill, primaryBorderColor: c.border, nodeBorder: c.border,
      primaryTextColor: c.text, nodeTextColor: c.text, textColor: c.text, lineColor: c.line, clusterBkg: c.group, clusterBorder: c.groupBorder, titleColor: c.label },
    flowchart: { useMaxWidth: false, curve: 'basis', nodeSpacing: 28, rankSpacing: 34, padding: 10, wrappingWidth: 200, minNodeWidth: 0, diagramPadding: 4 },
    themeCSS: '.node rect { rx: 6px; ry: 6px; } .cluster rect { rx: 8px; ry: 8px; } .cluster-label span { font-size: 12px; font-weight: 600; }'
      + ' .edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; font-size: 12px; color: ' + c.label + '; } .edgeLabel rect { fill: none; } .flowchart-link { stroke-width: 1.2px; }',
  };
}

/** An element's `translate(x, y)`, or null. */
function translation(element: Element | null | undefined): [number, number] | null {
  const at = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/u.exec(element?.getAttribute('transform') ?? '');
  return at ? [Number(at[1]), Number(at[2])] : null;
}

/** An element's children of a class. */
function childrenOf(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.classList.contains(name));
}

/**
 * What Mermaid drew, finished: each group's title at its top left, where the links that come in at its top middle do
 * not run through it; and the links cut out under each label and title, so they read on whatever is behind them with no
 * box of a colour that has to match. The cut is a mask on each layer of links, of its own layer's labels and titles.
 */
export function wikiDiagramFinish(svg: Element): void {
  for (const cluster of svg.querySelectorAll('g.cluster')) {
    const box = Array.from(cluster.children).find((child) => child.tagName.toLowerCase() === 'rect');
    const title = childrenOf(cluster, 'cluster-label')[0];
    const at = translation(title);
    if (box && title && at) title.setAttribute('transform', 'translate(' + (Number(box.getAttribute('x')) + 10) + ', ' + (at[1] + 4) + ')');
  }
  svg.querySelectorAll('g.root').forEach((root, n) => {
    const holes: Array<[number, number, number, number]> = [];
    const hole = (x: number, y: number, text: Element | null): void => {
      const width = Number(text?.getAttribute('width'));
      const height = Number(text?.getAttribute('height'));
      if (width > 0 && height > 0) holes.push([x - 3, y - 1, width + 6, height + 2]);
    };
    for (const labels of childrenOf(root, 'edgeLabels')) {
      for (const label of childrenOf(labels, 'edgeLabel')) {
        const outer = translation(label);
        const inner = translation(label.firstElementChild);
        if (outer && inner) hole(outer[0] + inner[0], outer[1] + inner[1], label.querySelector('foreignObject'));
      }
    }
    for (const clusters of childrenOf(root, 'clusters')) {
      for (const cluster of childrenOf(clusters, 'cluster')) {
        const title = childrenOf(cluster, 'cluster-label')[0];
        const at = translation(title);
        if (title && at) hole(at[0], at[1], title.querySelector('foreignObject'));
      }
    }
    if (holes.length === 0) return;
    const ns = svg.namespaceURI;
    const rect = (x: number, y: number, width: number, height: number, fill: string): Element => {
      const shape = document.createElementNS(ns, 'rect');
      for (const [name, value] of [['x', x], ['y', y], ['width', width], ['height', height], ['fill', fill]] as const) shape.setAttribute(name, String(value));
      return shape;
    };
    const mask = document.createElementNS(ns, 'mask');
    const id = svg.id + '-links-' + n;
    for (const [name, value] of [['id', id], ['maskUnits', 'userSpaceOnUse'], ['x', '-100000'], ['y', '-100000'], ['width', '200000'], ['height', '200000']]) {
      mask.setAttribute(name, value);
    }
    mask.append(rect(-100000, -100000, 200000, 200000, 'white'), ...holes.map(([x, y, width, height]) => rect(x, y, width, height, 'black')));
    root.prepend(mask);
    for (const links of childrenOf(root, 'edgePaths')) links.setAttribute('mask', 'url(#' + id + ')');
  });
}

/** A left-to-right flowchart as the server spells one, turned top to bottom; null for any other. */
export function wikiDiagramTurned(source: string): string | null {
  return /^flowchart LR\n/u.test(source) ? source.replace(/^flowchart LR/u, 'flowchart TB') : null;
}

interface Picture {
  svg: string;
  /** Its width as drawn: its viewBox's. */
  width: number;
}

/** Mermaid's SVG, finished (in a template, where nothing in it loads or runs), with its width. */
function picture(svg: string): Picture {
  const template = document.createElement('template');
  template.innerHTML = svg;
  const drawing = template.content.firstElementChild;
  if (!drawing) return { svg, width: 0 };
  wikiDiagramFinish(drawing);
  const width = Number(drawing.getAttribute('viewBox')?.trim().split(/\s+/u)[2] ?? drawing.getAttribute('width'));
  return { svg: template.innerHTML, width: Number.isFinite(width) ? width : 0 };
}

/** The width inside the figure, followed as it changes; null until it has one. */
function useRoom(element: HTMLElement | null): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const inside = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      setRoom(inside > 0 ? Math.floor(inside) : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return room;
}

/**
 * A section's diagram (contract `docs.diagram`): the Mermaid flowchart the server wrote out again, drawn strict, in the
 * page's theme and the diagram look's colours, at its own size. A left-to-right one wider than the figure is drawn top
 * to bottom when that is narrower; one still wider scrolls rather than shrinking its words. Its source shows as code
 * when it does not draw.
 */
export function WikiDiagram({ source }: { source: string }) {
  const theme = usePageTheme();
  const id = `wk-diagram-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const [figure, setFigure] = useState<HTMLElement | null>(null);
  const room = useRoom(figure);
  const [drawn, setDrawn] = useState<{ written: Picture; turned: Picture | null } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const draw = await mermaid();
      draw.initialize(wikiDiagramOptions(theme === 'dark', getComputedStyle(document.body).fontFamily));
      const written = picture((await draw.render(id, source)).svg);
      const turnedSource = wikiDiagramTurned(source);
      const turned = turnedSource === null ? null : await draw.render(`${id}-tb`, turnedSource).then(({ svg }) => picture(svg), () => null);
      return { written, turned };
    })().then(
      (pictures) => live && setDrawn(pictures),
      () => live && setDrawn('failed'),
    );
    return () => {
      live = false;
    };
  }, [id, source, theme]);
  if (drawn === 'failed') {
    return (
      <pre className="wk-dc-code">
        <code>{source}</code>
      </pre>
    );
  }
  const shown = drawn === null ? null
    : drawn.turned !== null && room !== null && drawn.written.width > room && drawn.turned.width < drawn.written.width ? drawn.turned : drawn.written;
  return (
    <figure
      ref={setFigure}
      className="wk-dc-diagram"
      role="img"
      aria-label={WIKI_DOC_DIAGRAM}
      aria-busy={drawn === null}
      dangerouslySetInnerHTML={shown === null ? undefined : { __html: shown.svg }}
    />
  );
}
