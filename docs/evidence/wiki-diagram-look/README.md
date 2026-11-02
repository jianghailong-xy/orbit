# Wiki diagrams in Orbit's own look

The owner's complaint (2026-11-02): wiki diagrams render too ugly. The board is `docs/mocks/wiki-diagram-look`, and the
owner picked its recommendations on all three questions:

1. Look A: white cards with a grey hairline.
2. A left-to-right diagram wider than its figure is drawn top to bottom.
3. The grouping bug is fixed, and `WIKI_DOC_DIAGRAM_RULES.version` goes from 3 to 4.

## What changed

**The look.** Web `WikiDiagram.tsx`, iOS/Mac `WikiDiagram.swift` and Android `WikiDiagram.kt` share one set of settings:
- Mermaid's `classic` look over its `base` theme, in place of the stock `neutral`/`dark` themes and Mermaid 12's default
  `neo` look, which brought the drop shadows.
- 13 px text, labels kept on one line up to 200 px, tighter spacing, rounded cards.
- In the dark theme, cards are a white veil (`rgba(255, 255, 255, 0.07)`) over whatever fill the figure has: the web's
  `#18181a`, iOS's `#0d0d0d` or Android's `#232426`.

Two steps run after Mermaid draws:
- Each group's title moves to its top left, so links coming in at the top middle no longer cross it.
- A mask cuts each link out under every edge label and group title. Labels need no background box of a colour that has
  to match the platform's figure fill.

**The wide rule.** A left-to-right flowchart wider than the figure's inside is drawn again top to bottom, and the
narrower picture is shown. Each theme's pictures are drawn once and kept, so a new width only picks between them:
- Web: a `ResizeObserver` on the figure.
- iOS/Mac: `onGeometryChange` on the column.
- Android: the WebView's width, again on `resize`.

**One text, three copies.** The apps' drawing script is one block of JavaScript between two marks
(`// wiki diagram drawing: from here` … `to here`), held equal three ways:
- `WikiDiagram.swift` holds the block.
- `WikiDiagram.kt`'s `DRAW` is the same lines: `WikiDiagramTest` compares them.
- The web's colours, options, finish and turn are the same lines again: `WikiDocsCopyParityTests` and
  `WikiDiagramTest` both check them.
- `capture/sync-draw.py` copies the Swift block into Kotlin.

**The grouping bug (server).** `parseDiagram` now follows Mermaid's rule:
- A node stands in the first subgraph that names it.
- A mention outside every subgraph places it nowhere.

Before, a diagram written links first and groups last was stored with every group empty. The rewrite is stored at write
time, so `WIKI_DOC_DIAGRAM_RULES.version` 3 → 4 (shared and contract) has every overview, concepts, flow and data section
written again. The golden fixture's four fingerprints moved with it, as at the 2 → 3 bump.

## Checks run (2026-11-02, worktree at 01d68ff4a + this change)

| Suite | Result |
| --- | --- |
| apiserver unit (`node --test`, every non-pg spec) | 5787 pass, 0 fail |
| shared vitest | 670 pass (37 files) |
| web vitest, whole suite in 4 shards (`capture/web-suite.sh`) | 6120 pass, 0 fail (462 files) |
| OrbitKit `swift test` in `swift:6.1` (Linux, as CI's Swift core) | 4338 tests, 0 failures, 5 skipped (PerfBaselineTests) |
| Android `WikiDiagramTest` (Robolectric) + `:app:compileDebugAndroidTestKotlin` | 9 pass; device tests compile |
| Android `WikiDiagramDeviceTest` on emulator-5554 (API 36), light and dark | PASS, 2 tests (`android/checks-*.txt`) |
| `swiftc -parse WikiDiagram.swift` (swift:6.1) | parses |

The SwiftUI app itself cannot be compiled on Linux. `onGeometryChange` is used unguarded elsewhere in OrbitApp
(`SettingsHomeView`), which builds for iOS 17 and macOS 14. The apps' drawing script was also run as-is, in Chromium and
WebKit (`capture/native-check.mjs`):
- It turns the wide samples at a phone's room and keeps them as written at 2000 px.
- It masks links under labels and titles.
- It moves titles.

## Pictures

- `web/`: the real web page, built from main (before) and from this change (after), served with the ui-migration
  fixtures plus the shared docs fixture's `session-runtime` document carrying three diagrams as the server stores them
  (`capture/web-capture.mjs`).
  - `desktop-light-flow.png`: the top-to-bottom flow.
  - `desktop-light-short.png`: a short left-to-right one that fits as written.
  - `desktop-dark-architecture.png`: one wider than the column, now drawn top to bottom.
  - `phone.png`: before, the left-to-right diagrams show two boxes and hide the rest behind a sideways scroll; after,
    they are drawn top to bottom.
- `android/`: the real app on the emulator, light and dark (`WikiDiagramDeviceTest`).
  - `01`: a diagram that fits.
  - `02`: the server spec's left-to-right flowchart, drawn top to bottom.
  - `03`/`04`: a top-to-bottom one still wider than the column, which scrolls sideways.

Fonts on this Linux box are Inter and Noto Sans SC (`/var/tmp/kimi-accounts-mock/fonts.conf`), not SF and PingFang.
