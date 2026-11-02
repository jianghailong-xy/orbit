// Does Mermaid put a node in the subgraph that names it, when the node was first written outside it? The original block
// (as a writer sends it) against the server's rewrite of it: which cluster box contains the node's box.
import { browser, page, draw } from './lib.mjs';
import { parseDiagram } from './wiki-doc-diagram.ts';

const original = `flowchart LR
  APP["客户端"] -->|"HTTPS"| API
  subgraph S1["服务端"]
    API["apiserver"] --> DB[("Postgres")]
  end`;
const rewritten = parseDiagram(original).source;
console.log('server rewrite:\n' + rewritten);
const b = await browser();
const p = await page(b, {});
for (const [name, source] of [['original', original], ['rewritten', rewritten]]) {
  await draw(p, { source, options: { flowchart: { useMaxWidth: false } } });
  const inside = await p.evaluate(() => {
    const svg = document.querySelector('#fig > svg');
    const cluster = svg.querySelector('g.cluster rect').getBoundingClientRect();
    const node = [...svg.querySelectorAll('g.node')].find((n) => n.textContent.includes('apiserver')).getBoundingClientRect();
    return node.left >= cluster.left && node.right <= cluster.right && node.top >= cluster.top && node.bottom <= cluster.bottom;
  });
  console.log(`${name}: apiserver inside 服务端 = ${inside}`);
}
await b.close();
