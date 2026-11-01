# TEMPORARY evidence probe — never merged

Task 34noHca21KQGtUeAq3gJN: a wiki document's diagram block is drawn in the macOS and iOS apps (`WikiDiagram.swift`,
a WKWebView running the Mermaid build the web pins). Adapted from the criteria reply line's probe
(`docs/evidence/criteria-reply-session-line/probe-harness`). It builds the iPhone app's own `CompactShell` and the Mac
app's own `MainView` from the tree's shell and shared sources into throwaway apps pointed at `stub.py`. Each launch
opens the Wiki section with one document on its stack, as `AppModel.openWikiEntry` opens an entry
(`-probe.slug <slug>`).

`stub.py` serves the space and endpoints the web's own `WikiDocPage.test.tsx` serves, and the shared fixture's
document (`src/shared/src/wiki-docs.fixture.json`, `docs.doc.read`) under three slugs, each with one diagram block
spliced into its first section after its paragraph, the block's shape in the web test's diagram case:

- `diagram-fits`: a flowchart narrower than an iPhone's column (216 × 474 as WebKit draws it);
- `diagram-wide`: one wider than any column (1128 × 112), which must scroll sideways;
- `diagram-broken`: a source Mermaid rejects, which must show as code.

The first two sources are what the apiserver's own `parseDiagram` wrote out (`gen-diagrams.ts`, `diagrams.json`):
node ids n1…, subgraph ids s1…, every label quoted, `&` `<` `>` as `#amp;` `#lt;` `#gt;`. `DiagramShotTests` waits for
the element named "Diagram" to take the drawn size, checks it, scrolls the page and the diagram, and photographs them
in light and dark. All data is made up.
