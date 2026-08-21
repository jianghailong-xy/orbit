import type { JSX } from 'react';
import { buildBatchGraph, describeShape, shouldDraw, type BatchTaskInput } from '../lib/batchGraph';

// Geometry. Fixed in user units and scaled to the card by the viewBox, so the same numbers work
// for a chain of three and a fan-out of eight without measuring anything.
const NODE_W = 138;
const NODE_H = 30;
const COL_GAP = 12;
const ROW_GAP = 26;
const PAD = 2;

/** Titles are long and SVG text does not wrap or ellipsize; the full one rides in a tooltip. */
function clip(title: string): string {
  return title.length > 20 ? `${title.slice(0, 19)}…` : title;
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
    <div className="batch-graph">
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
