// "Links first, groups after" — a common way to write a flowchart. What the server stores, and what Mermaid draws of it.
import { parseDiagram } from './wiki-doc-diagram.ts';
import { browser, page, draw } from './lib.mjs';
import { orbitLook, TITLES_LEFT } from './looks.mjs';
import { writeFileSync } from 'node:fs';

const written = `flowchart LR
  APP["客户端"] -->|"HTTPS"| API["apiserver"]
  API --> DB[("Postgres")]
  API --> GW["gateway"]
  GW -->|"长连接"| RN["runner"]
  RN --> EN["引擎 CLI"]
  subgraph S1["服务端"]
    API
    DB
    GW
  end
  subgraph S2["用户机器"]
    RN
    EN
  end`;
const stored = parseDiagram(written)!.source;
console.log(stored);
writeFileSync('diagrams-groups.json', JSON.stringify({ written, stored }, null, 2));
const b = await browser();
const p = await page(b, { width: 784 });
for (const [name, source] of [['written', written], ['stored', stored]]) {
  const r = await draw(p, { source, options: orbitLook({ dark: false, minNodeWidth: 0 }), post: TITLES_LEFT });
  await p.locator('#fig').screenshot({ path: `shots/groups-${name}.png` });
  console.log(name, r.w, 'x', r.h);
}
await b.close();
