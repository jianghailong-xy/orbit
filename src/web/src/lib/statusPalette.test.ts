/**
 * Colour-vision guard for the dependency graph's edge palette.
 *
 * Dependency edges are bare lines: no label, no icon, nothing but a stroke. That makes them the
 * one place in the app where a status colour has to carry meaning on its own, so this measures
 * the colours index.css actually ships — simulated for the two red-green deficiencies — instead
 * of trusting how the pair looks to normal vision, where it is a very obvious 31.7 apart.
 *
 * Simulation is Machado et al. (2009) at full severity, the pipeline the original report used;
 * the first test pins it to the numbers quoted there so the rest can be read at face value.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDependencyFlowElements, EDGE_COLORS } from '../components/TaskDependencyGraph';
import { normalizeTaskDependencyGraph, taskDependencyEdgeKey } from './taskDependencyGraph';

/** OKLab ΔE(×100) below which two flat colours stop being reliably tellable apart. */
const DISCRIMINABLE = 8;

type Rgb = readonly [number, number, number];
type Deficiency = 'deuteranopia' | 'protanopia';

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`expected a #rrggbb colour, got ${hex}`);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => c / 255) as unknown as Rgb;
}

/** sRGB → OKLab (Björn Ottosson's matrices). */
function oklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Machado, Oliveira & Fernandes (2009), severity 1.0, applied to linear RGB. */
const DEFICIENCY_MATRIX: Record<Deficiency, readonly Rgb[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function simulate(rgb: Rgb, deficiency: Deficiency): Rgb {
  const linear = rgb.map(srgbToLinear);
  return DEFICIENCY_MATRIX[deficiency].map((row) =>
    linearToSrgb(Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]))),
  ) as unknown as Rgb;
}

/** Perceptual distance between two colours as the named deficiency sees them. */
function deltaE(a: Rgb, b: Rgb, deficiency?: Deficiency): number {
  const [x, y] = deficiency ? [simulate(a, deficiency), simulate(b, deficiency)] : [a, b];
  const [la, aa, ba] = oklab(x);
  const [lb, ab, bb] = oklab(y);
  return Math.hypot(la - lb, aa - ab, ba - bb) * 100;
}

/** Composite an alpha-blended stroke over the canvas, the way the browser paints it. */
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as unknown as Rgb;

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function themeTokens(selector: string): ReadonlyMap<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  const block = css.slice(start, css.indexOf('\n}', start));
  return new Map([...block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
}

const THEMES = {
  light: themeTokens(':root'),
  dark: themeTokens(":root[data-theme='dark']"),
} as const;
type Theme = keyof typeof THEMES;

function token(name: string, theme: Theme): Rgb {
  const value = THEMES[theme].get(name);
  if (!value) throw new Error(`--${name} is not defined in the ${theme} theme`);
  return parseHex(value);
}

/** The colour an edge state resolves to, following EDGE_COLORS' `var(--x)` into index.css. */
function edgeColor(state: 'complete' | 'failed', theme: Theme): Rgb {
  const name = /^var\((--[\w-]+)\)$/.exec(EDGE_COLORS[state])?.[1];
  if (!name) throw new Error(`EDGE_COLORS.${state} is no longer a single token: ${EDGE_COLORS[state]}`);
  return token(name, theme);
}

const graph = normalizeTaskDependencyGraph({
  focusTaskId: 'focus',
  nodes: [
    { id: 'done', title: 'Completed prerequisite', status: 'DONE' },
    { id: 'broken', title: 'Failed prerequisite', status: 'FAILED' },
    { id: 'focus', title: 'Current task', status: 'OPEN' },
  ],
  edges: [
    { sourceTaskId: 'done', targetTaskId: 'focus' },
    { sourceTaskId: 'broken', targetTaskId: 'focus' },
  ],
});

function edgeStyle(sourceTaskId: string) {
  const { edges } = buildDependencyFlowElements(
    graph,
    [],
    new Map(graph.nodes.map((node, index) => [node.id, { x: 0, y: index * 100 }])),
    false,
    new Set(),
    null,
    () => undefined,
    undefined,
    null,
    () => undefined,
    () => undefined,
    null,
  );
  const edge = edges.find((it) => it.id === taskDependencyEdgeKey({ sourceTaskId, targetTaskId: 'focus' }));
  if (!edge?.style) throw new Error(`no styled edge out of ${sourceTaskId}`);
  return edge.style;
}

describe('dependency graph edge palette', () => {
  it('reproduces the deficiency measurements the palette was chosen against', () => {
    // --success-solid vs --error-solid: what `complete` edges used to be drawn with. Both modes
    // land at half the discrimination floor, while normal vision sees them 31.7 apart — which is
    // exactly why looking at the graph never surfaced this.
    expect(deltaE(token('--success-solid', 'light'), token('--error-solid', 'light'), 'deuteranopia').toFixed(1)).toBe('3.6');
    expect(deltaE(token('--success-solid', 'dark'), token('--error-solid', 'dark'), 'deuteranopia').toFixed(1)).toBe('4.0');
    expect(deltaE(token('--success-solid', 'light'), token('--error-solid', 'light')).toFixed(1)).toBe('31.7');

    // The same trap one token over: --success-solid against --warning-solid under protanopia.
    // Not a live bug — every place those two meet also carries an icon or a word — but any new
    // colour-only dot that reuses the pair inherits this.
    expect(deltaE(token('--success-solid', 'light'), token('--warning-solid', 'light'), 'protanopia').toFixed(1)).toBe('2.4');
  });

  it('keeps complete and failed edges apart under red-green colour vision', () => {
    const measured = (theme: Theme, deficiency: Deficiency) =>
      deltaE(edgeColor('complete', theme), edgeColor('failed', theme), deficiency);

    // --success in place of --success-solid roughly doubles the worst case: 8.7 / 8.2 in light,
    // 19.1 protan in dark. Dark deuteranopia reaches 7.2 and no green in the palette clears the
    // floor against --error-solid there, so that residue is left to the shape channel below.
    expect(measured('light', 'deuteranopia')).toBeGreaterThanOrEqual(DISCRIMINABLE);
    expect(measured('light', 'protanopia')).toBeGreaterThanOrEqual(DISCRIMINABLE);
    expect(measured('dark', 'protanopia')).toBeGreaterThanOrEqual(DISCRIMINABLE);
    expect(measured('dark', 'deuteranopia')).toBeGreaterThan(7);

    for (const theme of ['light', 'dark'] as const) {
      const previous = deltaE(token('--success-solid', theme), token('--error-solid', theme), 'deuteranopia');
      expect(measured(theme, 'deuteranopia')).toBeGreaterThan(previous * 1.7);
    }
  });

  it('gives failed edges a shape channel that no colour deficiency can flatten', () => {
    const complete = edgeStyle('done');
    const failed = edgeStyle('broken');

    expect(failed.strokeDasharray).toBeTruthy();
    // Not the aggregate edge's '5 4': a failed dependency must not read as a collapsed branch.
    expect(failed.strokeDasharray).not.toBe('5 4');
    expect(complete).not.toHaveProperty('strokeDasharray');
    // The dash rides along with the existing width/opacity rules rather than replacing them.
    expect(failed.strokeWidth).toBe(1.5);
    expect(complete.opacity).toBe(0.55);
    expect(failed.opacity).toBe(0.9);

    // Why the dash is load-bearing and not decoration: complete edges paint at 0.55 opacity, and
    // once that blend over --bg-sunken is accounted for, dark-mode protanopia sees the two states
    // 2.1 apart — worse than the raw tokens suggest, and far under the floor.
    const rendered = (theme: Theme, deficiency: Deficiency) =>
      deltaE(
        over(edgeColor('complete', theme), token('--bg-sunken', theme), Number(complete.opacity)),
        over(edgeColor('failed', theme), token('--bg-sunken', theme), Number(failed.opacity)),
        deficiency,
      );
    expect(rendered('dark', 'protanopia')).toBeLessThan(DISCRIMINABLE);
  });
});
