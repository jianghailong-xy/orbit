# Wiki diagram look: capture kit

The board (`../board.html`, rendered as `../board-1.png` to `../board-6.png`) shows real Mermaid 12.2.0 renders: the
build the apps bundle, inside a page that copies the web's figure CSS (`.wk-dc-diagram`) and colour tokens.

- `diagrams.json`: the sample diagrams after the server's `parseDiagram`, written by `gen-diagrams.ts`.
- `looks.mjs`: today's options and the candidate looks A and B (`orbitLook`), plus `TITLES_LEFT`, the post-render
  step that moves group titles to the top left.
- `capture.mjs`: writes `../shots/*.png` and `../shots/meta.json`, which holds each shot's size, whether it was turned
  top to bottom, and element boxes for the numbered marks. `../shots/meta.js` is `window.SHOTS_META = <meta.json>;`.
- `render-board.mjs <board dir>`: draws the marks and writes one PNG per `section.b-part`. The PNGs were quantised to
  256 colours with PIL afterwards.
- `empty-groups.ts`, `membership.mjs`, `membership2.ts`: the grouping bug. Mermaid puts a node in the first subgraph
  that lists it; `parseDiagram` puts it where it first appears, so a diagram written links-first stores empty groups.
- `defaults.mjs`: Mermaid's effective defaults under today's options. Global look is `classic`, but the flowchart
  look is `neo`, with wrappingWidth 120, minNodeWidth 120 and fontSize 16.

Needs `playwright-core` 1.63.0 (`/var/tmp/t1-main-baseline/node_modules` on the HPC box), its chromium-1243 and
webkit-2359, and `FONTCONFIG_FILE=/var/tmp/kimi-accounts-mock/fonts.conf` (Inter and Noto Sans SC). The scripts that
import `./wiki-doc-diagram.ts` need a copy of the server's parser beside them, with its one import inlined:

```sh
sed "s#^import { WIKI_DOC_DIAGRAM_RULES } from '@orbit/shared';#const WIKI_DOC_DIAGRAM_RULES = { nodesMax: 30, edgesMax: 60, labelMaxChars: 80 };#" \
  ../../../../src/apiserver/src/wiki/wiki-doc-diagram.ts > wiki-doc-diagram.ts
```
