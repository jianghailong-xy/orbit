// Sample diagram blocks the way a section writer sends them (wiki-docs-writer.ts's Diagram rules: flowchart LR/TB,
// Chinese labels, stores, decisions, labelled and dotted links, subgraphs), spelled out again by the server's own
// parseDiagram, so the renders draw exactly what a page would get.
import { parseDiagram } from './wiki-doc-diagram.ts';
import { writeFileSync } from 'node:fs';

const blocks: Record<string, string> = {
  // A delivery flow, top to bottom, with a subgraph, a store, a decision and a dotted retry.
  flow: `flowchart TB
  A["用户发送消息"] --> B["apiserver 落库 turn"]
  B --> C[("run_event 表")]
  subgraph G["Gateway"]
    D["唤醒 runner"] --> E{"runner 在线？"}
  end
  C --> D
  E -->|"是"| F["runner 领取 inbox"]
  E -->|"否"| H["等 long-poll 重连"]
  H -.-> F
  F --> I("引擎执行一轮")
  I --> J[("事件流")]`,
  // A pipeline, left to right: wider than a phone, about as wide as the web's column.
  pipeline: `flowchart LR
  P["确认 plan"] --> Q["排入 docs_build 作业"] --> W["wiki-worker 领取"] --> M["模型逐节写作"] --> V{"句子核对通过？"}
  V -->|"是"| S["发布文档"]
  V -->|"否"| X["标记待审"]`,
  // An architecture picture: two subgraphs side by side, labelled links across them.
  architecture: `flowchart LR
  APP["客户端"]
  subgraph S1["服务端"]
    API["apiserver"] --> DB[("Postgres")]
    API --> GW["gateway"]
  end
  subgraph S2["用户机器"]
    RN["runner"] --> EN["引擎 CLI"]
    EN --> WT[("worktree")]
  end
  APP -->|"HTTPS"| API
  GW -->|"长连接"| RN
  RN -.->|"心跳"| API`,
  // The Apple probe's English one, for a like-for-like look against docs/evidence/wiki-diagram-apple.
  english: `flowchart TD
  subgraph S[apiserver]
    A[Turn stored] --> B[(run_event row)]
  end
  B --> C([Gateway delivers])
  C --> D[["Runner & engine <1>"]]`,
};

const out: Record<string, string> = {};
for (const [name, block] of Object.entries(blocks)) {
  const parsed = parseDiagram(block);
  if (!parsed) throw new Error(`${name}: parseDiagram dropped it`);
  out[name] = parsed.source;
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
