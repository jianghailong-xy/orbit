import type { JSX } from 'react';
import { buildBatchGraph, describeShape, shouldDraw, type BatchTaskInput } from '../lib/batchGraph';

// Geometry. Fixed in user units and scaled to the card by the viewBox, so the same numbers work
// for a chain of three and a fan-out of eight without measuring anything.
const NODE_W = 138;
const NODE_H = 30;
const COL_GAP = 12;
const ROW_GAP = 26;
const PAD = 2;

/** Kanji, kana, Hangul, fullwidth forms — a full em each, where Latin advances about half. */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Twenty half-ems: the width the old twenty-character budget bought when every glyph was Latin. */
const LABEL_HALF_EMS = 20;

/**
 * Titles are long and SVG text neither wraps nor ellipsizes — past the box it simply keeps going,
 * over the node beside it. The budget is the same twenty it always was, but counted in half-ems
 * rather than in characters: twenty of those is a comfortable line of Latin and half again the
 * width of the box in Chinese, which is what a title like `[A3] 让 JSON-RPC 失败带出细节` does to it.
 * The full one rides in a tooltip either way.
 */
function clip(title: string): string {
  const width = (ch: string) => (WIDE.test(ch) ? 2 : 1);
  let total = 0;
  for (const ch of title) total += width(ch);
  if (total <= LABEL_HALF_EMS) return title;
  let out = '';
  let used = 0;
  for (const ch of title) {
    // The ellipsis needs a column of its own.
    if (used + width(ch) > LABEL_HALF_EMS - 1) break;
    out += ch;
    used += width(ch);
  }
  return `${out}…`;
}

/**
 * The shape of a proposed batch, drawn.
 *
 * Prerequisites sit above what waits on them, so the picture reads in the order the dispatcher
 * will follow. Rendered only when there are edges to show: a batch of unrelated tasks has no
 * shape, and a row of disconnected boxes is a worse list than a list.
 *
 * Plain SVG scaled by its viewBox rather than a graph library — twelve nodes is the most a card
 * ever draws, nothing here pans or zooms, and the one xyflow view in this repo cannot be built.
 */
export function BatchGraph({ tasks }: { tasks: BatchTaskInput[] }): JSX.Element | null {
  const g = buildBatchGraph(tasks);
  if (!shouldDraw(g)) return null;

  const xOf = (column: number, layerSize: number) =>
    PAD + column * (NODE_W + COL_GAP) + ((g.width - layerSize) * (NODE_W + COL_GAP)) / 2;
  const yOf = (layer: number) => PAD + layer * (NODE_H + ROW_GAP);
  const sizeOfLayer = (layer: number) => g.nodes.filter((n) => n.layer === layer).length;

  const centres = g.nodes.map((n) => ({
    x: xOf(n.column, sizeOfLayer(n.layer)) + NODE_W / 2,
    y: yOf(n.layer),
  }));
  const w = PAD * 2 + g.width * NODE_W + (g.width - 1) * COL_GAP;
  const h = PAD * 2 + g.depth * NODE_H + (g.depth - 1) * ROW_GAP;

  return (
    // The drawing has a natural size. A transcript card runs several times wider than the ~520px
    // approval panel these numbers were measured for, and `width: 100%` letterboxes it there — the
    // picture ends up centred in a band of empty card, out of line with the list of titles beneath
    // it. Cap the box at the drawing's own width: 1:1 and left-aligned wherever there is room,
    // scaled down only where there is not.
    <div className="batch-graph" style={{ maxWidth: w }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img"
           aria-label={`Batch shape: ${describeShape(g)}`}>
        {g.edges.map((e, i) => {
          const from = centres[e.from];
          const to = centres[e.to];
          // A gentle S rather than a straight line: with several edges leaving one node, straight
          // segments overlap near the source and you cannot tell how many there are.
          const midY = (from.y + NODE_H + to.y) / 2;
          return (
            <path
              key={i}
              className="batch-graph-edge"
              d={`M ${from.x} ${from.y + NODE_H} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`}
            />
          );
        })}
        {g.nodes.map((n, i) => {
          const x = xOf(n.column, sizeOfLayer(n.layer));
          const y = yOf(n.layer);
          return (
            <g key={i} className={`batch-graph-node${n.waitsOutside ? ' is-outside' : ''}`}>
              <title>{n.title}{n.waitsOutside ? ' (waits on a task outside this batch)' : ''}</title>
              <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={7} />
              <text x={x + NODE_W / 2} y={y + NODE_H / 2} dominantBaseline="central" textAnchor="middle">
                {clip(n.title)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export { describeShape, buildBatchGraph };
