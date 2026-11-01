// The board's scenes: today's options against looks A and B, light and dark, in a document column and on a phone; and
// the wide-diagram rule (a left-to-right diagram wider than its column is drawn top to bottom). Writes shots/<scene>.png.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, browser, page, draw } from './lib.mjs';
import { orbitLook, TITLES_LEFT } from './looks.mjs';

const diagrams = JSON.parse(readFileSync(join(KIT, 'capture', 'diagrams.json'), 'utf8'));
const out = join(KIT, 'shots');
mkdirSync(out, { recursive: true });
const looks = {
  today: { options: (dark) => ({ theme: dark ? 'dark' : 'neutral', flowchart: { useMaxWidth: false } }) },
  A: { options: (dark) => orbitLook({ dark, minNodeWidth: 0 }), post: TITLES_LEFT },
  B: { options: (dark) => orbitLook({ dark, palette: 'brand', minNodeWidth: 0 }), post: TITLES_LEFT },
};
const TEXT = {
  flow: ['2 turn 怎么投递', '一轮 turn 先落库，再由 Gateway 唤醒 runner 投递；runner 不在线时等它重连后领取。'],
  pipeline: ['2 文档怎么生成', 'plan 确认后排入 docs_build 作业，wiki-worker 领取后逐节写作并核对句子。'],
  architecture: ['1 总览', '客户端经 HTTPS 访问 apiserver；runner 与 gateway 保持长连接，并定时发心跳。'],
};
const meta = {};
const b = await browser();
async function shot(name, { width, theme, diagram, look, turn = false, context = false }) {
  const p = await page(b, { width, theme });
  const L = looks[look];
  const opts = { options: L.options(theme === 'dark'), post: L.post ?? null };
  const [heading, text] = context ? TEXT[diagram] : ['', ''];
  let r = await draw(p, { source: diagrams[diagram], ...opts, heading, text });
  let turned = false;
  // The rule: wider than the figure's inside (the column less the figure's 12 px padding each side) → top to bottom.
  if (turn && r.w > width - 24 && diagrams[diagram].startsWith('flowchart LR')) {
    r = await draw(p, { source: diagrams[diagram].replace(/^flowchart LR/u, 'flowchart TB'), ...opts, heading, text });
    turned = true;
  }
  const target = context ? '#col' : '#fig';
  await p.locator(target).screenshot({ path: join(out, `${name}.png`) });
  // Boxes the board's marks point at, in CSS px from the shot's top left; the shot's own CSS width for scaling.
  const boxes = await p.evaluate((target) => {
    const root = document.querySelector(target).getBoundingClientRect();
    const svg = document.querySelector('#fig > svg');
    const rel = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.left - root.left, b.top - root.top, b.width, b.height].map(Math.round); };
    const byText = (sel, text) => [...svg.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
    return {
      shotWidth: Math.round(root.width), fig: rel(document.getElementById('fig')), svg: rel(svg),
      node1: rel(svg.querySelector('g.node')), title: rel(svg.querySelector('g.cluster-label')),
      cluster: rel(svg.querySelector('g.cluster')), yes: rel(byText('g.edgeLabel', '是')),
      wrapped: rel(byText('g.node', 'long-poll')), decision: rel(byText('g.node', '在线')),
    };
  }, target);
  meta[name] = { w: r.w, h: r.h, turned, boxes };
  await p.close();
}
for (const look of ['today', 'A', 'B']) for (const theme of ['light', 'dark']) {
  await shot(`flow-${look}-${theme}`, { width: 400, theme, diagram: 'flow', look });
}
for (const look of ['today', 'A']) {
  await shot(`phone-pipeline-${look}`, { width: 345, theme: 'light', diagram: 'pipeline', look, context: true });
}
await shot('phone-pipeline-A-turned', { width: 345, theme: 'light', diagram: 'pipeline', look: 'A', turn: true, context: true });
await shot('phone-architecture-today', { width: 345, theme: 'light', diagram: 'architecture', look: 'today', context: true });
await shot('phone-architecture-A-turned', { width: 345, theme: 'light', diagram: 'architecture', look: 'A', turn: true, context: true });
await shot('web-architecture-today', { width: 784, theme: 'light', diagram: 'architecture', look: 'today', context: true });
await shot('web-architecture-A', { width: 784, theme: 'light', diagram: 'architecture', look: 'A', context: true });
await shot('web-architecture-A-turned', { width: 784, theme: 'light', diagram: 'architecture', look: 'A', turn: true, context: true });
await shot('web-architecture-A-dark-turned', { width: 784, theme: 'dark', diagram: 'architecture', look: 'A', turn: true, context: true });
await b.close();
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(JSON.stringify(meta));
