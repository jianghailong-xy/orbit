// The probe's diagram blocks, each as the apiserver spells one: its own parseDiagram (wiki-doc-diagram.ts, with its one
// import of WIKI_DOC_DIAGRAM_RULES inlined) over a mermaid block a writer might send. `broken` is no flowchart Mermaid
// reads — the server would drop it; the stub sends it anyway, to show the app's fallback. Run with Node 23 or later,
// beside that copy of wiki-doc-diagram.ts: `node gen-diagrams.ts diagrams.json`.
import { parseDiagram } from './wiki-doc-diagram.ts';
import { writeFileSync } from 'node:fs';
const fits = `flowchart TD
  subgraph S[apiserver]
    A[Turn stored] --> B[(run_event row)]
  end
  B --> C([Gateway delivers])
  C --> D[["Runner & engine <1>"]]`;
const wide = `flowchart LR
  W1[Owner sends a message] --> W2[apiserver stores the turn] --> W3[Gateway wakes the runner] --> W4[Runner starts the engine] --> W5[Engine answers] --> W6[Answer stored as events]`;
writeFileSync(process.argv[2], JSON.stringify({
  fits: parseDiagram(fits)!.source,
  wide: parseDiagram(wide)!.source,
  broken: 'flowchart TD\n  n1["Lease expired"] -->',
}, null, 2) + '\n');
