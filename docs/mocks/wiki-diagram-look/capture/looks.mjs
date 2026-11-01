// Candidate looks: Mermaid's classic look (no gradient strokes, no drop shadows) over the `base` theme, coloured from the
// web's tokens, a size smaller than the text, closer together, with a little themeCSS for what no theme variable reaches.
// `palette` picks node colours: 'neutral' (white cards on the figure's grey) or 'brand' (the brand tint).
export const PANEL = { light: '#f2f2f2', dark: '#18181a' }; // the figure's fill (--fill-inset) over --bg-base, opaque

const COLORS = {
  neutral: {
    light: { fill: '#ffffff', border: '#d5d8dd', text: '#1f2329', label: '#646a73', edge: '#9aa0a8', clusterFill: 'rgba(0,0,0,0.035)', clusterBorder: 'rgba(0,0,0,0.06)', title: '#646a73', decisionFill: '#ffffff', decisionBorder: '#d5d8dd', storeFill: '#ffffff' },
    dark: { fill: '#2b2b2e', border: '#45454a', text: '#c9ced5', label: '#a7adb6', edge: '#6e737b', clusterFill: 'rgba(255,255,255,0.035)', clusterBorder: 'rgba(255,255,255,0.06)', title: '#a7adb6', decisionFill: '#2b2b2e', decisionBorder: '#45454a', storeFill: '#2b2b2e' },
  },
  brand: {
    light: { fill: '#eaf1ff', border: '#bcd3ff', text: '#1f2329', label: '#646a73', edge: '#9aa0a8', clusterFill: 'rgba(0,0,0,0.035)', clusterBorder: 'rgba(0,0,0,0.06)', title: '#646a73', decisionFill: '#eaf1ff', decisionBorder: '#bcd3ff', storeFill: '#eaf1ff' },
    dark: { fill: '#232c40', border: '#34467a', text: '#c9ced5', label: '#a7adb6', edge: '#6e737b', clusterFill: 'rgba(255,255,255,0.035)', clusterBorder: 'rgba(255,255,255,0.06)', title: '#a7adb6', decisionFill: '#232c40', decisionBorder: '#34467a', storeFill: '#232c40' },
  },
};

export function orbitLook({ dark, palette = 'neutral', curve = 'basis', fontSize = 13, nodeSpacing = 28, rankSpacing = 34, padding = 10, wrappingWidth = 200, radius = 6, minNodeWidth = 120 }) {
  const c = COLORS[palette][dark ? 'dark' : 'light'];
  const panel = PANEL[dark ? 'dark' : 'light'];
  return {
    look: 'classic',
    theme: 'base',
    themeVariables: {
      darkMode: dark,
      fontSize: `${fontSize}px`,
      background: panel,
      primaryColor: c.fill, primaryBorderColor: c.border, primaryTextColor: c.text,
      secondaryColor: c.fill, tertiaryColor: panel,
      mainBkg: c.fill, nodeBorder: c.border, nodeTextColor: c.text, textColor: c.text,
      lineColor: c.edge, arrowheadColor: c.edge,
      clusterBkg: c.clusterFill, clusterBorder: c.clusterBorder, titleColor: c.title,
      edgeLabelBackground: panel,
    },
    flowchart: { useMaxWidth: false, curve, nodeSpacing, rankSpacing, padding, wrappingWidth, minNodeWidth, diagramPadding: 4 },
    themeCSS: `
      .node rect, .node polygon, .node path, .node circle, .node ellipse { stroke-width: 1px; }
      .node rect.basic, .node rect.label-container { rx: ${radius}px; ry: ${radius}px; }
      .cluster rect { rx: ${radius + 2}px; ry: ${radius + 2}px; }
      .cluster-label .nodeLabel, .cluster-label span { font-size: ${fontSize - 1}px; font-weight: 600; }
      .edgeLabel, .edgeLabel p, .edgeLabel span { font-size: ${fontSize - 1}px; color: ${c.label}; }
      .edgeLabel rect { opacity: 1; }
      .labelBkg { background-color: ${panel}; }
      .flowchart-link { stroke-width: 1.2px; }
      .node polygon { fill: ${c.decisionFill}; stroke: ${c.decisionBorder}; }
      .node path { fill: ${c.storeFill}; }
    `,
  };
}

/** Group titles at their group's top left, clear of the links that come in at its top middle. */
export const TITLES_LEFT = `
  for (const cluster of svg.querySelectorAll('g.cluster')) {
    const rect = cluster.querySelector(':scope > rect');
    const label = cluster.querySelector(':scope > g.cluster-label');
    if (!rect || !label) continue;
    const y = label.transform.baseVal.consolidate()?.matrix.f ?? 0;
    label.setAttribute('transform', 'translate(' + (Number(rect.getAttribute('x')) + 10) + ', ' + (y + 4) + ')');
  }`;
