# Wiki document diagrams in the macOS and iOS apps — evidence

Task 34noHca21KQGtUeAq3gJN. A section's diagram block (contract `docs.diagram`) is drawn in the apps' own wiki
document page by `src/macos/OrbitApp/Sources/OrbitApp/Views/WikiDiagram.swift`: a WKWebView running the Mermaid build
`src/web/package.json` pins (`Resources/mermaid.min.js`, npm's mermaid 12.2.0 `dist/mermaid.min.js` byte for byte —
the tarball's sha512 is `package-lock.json`'s integrity; sha256 `a8a6a6f8…3c3b9f`), with the web's options.

## The pictures (probe round 2, run [41313115043](https://github.com/jianghailong-xy/orbit/actions/runs/41313115043), commit 6ba851b2c + the probe)

The iPhone app's own `CompactShell` (iPhone 17 Pro simulator, iOS 26) and the Mac app's own `MainView`, built from
the tree's sources into throwaway apps (`probe-harness/`), each opened on the Wiki with one document on its stack
against `probe-harness/stub.py`. The stub serves the shared fixture's document (`src/shared/src/wiki-docs.fixture.json`)
with one diagram block after its first section's paragraph, sources as the apiserver's own `parseDiagram` writes them
(`probe-harness/diagrams.json`). All data is made up.

| | light | dark |
|---|---|---|
| iPhone: the drawn diagram on the document page | `ios/ios-diagram-light.png` | `ios/ios-diagram-dark.png` |
| Mac: the same, in the detail column | `mac/mac-diagram-light.png` | `mac/mac-diagram-dark.png` |

Also: a flowchart wider than the column before and after a sideways swipe or wheel (`*-wide-light*.png`), and a source
Mermaid rejects shown as monospaced code (`*-broken-light*.png`). The Mac shots' lowest few points meet the window's
edge: the probe scrolls in 120 pt steps, which cannot land a 498 pt figure in its 572 pt band.

## What the UI tests checked (all 8 passed: `test-cases-round2.txt`, notes in `ios/` and `mac/`)

- The element named "Diagram" (the web figure's `aria-label`) leaves the drawing height (120 + 24 pt) for the drawn
  diagram's own: 528 pt on the iPhone (504 + 24), 498 pt on the Mac; one diagram block, one such element.
- A vertical drag (iPhone) or wheel (Mac) that starts on the diagram moves the page; a sideways one moves a wide
  diagram (the element's picture changes).
- A source Mermaid rejects shows as code (`flowchart TD n1["Lease expired"] -->`) and no element is named "Diagram".
- Beside them: the Mermaid build inside each probe app has the tree's sha256 (`ios/bundle-ios.txt`,
  `mac/bundle-mac.txt`); the real iOS project (`src/ios/project.yml`) puts it and its license in Copy Bundle Resources
  (`ios-project-resources.txt`); the compiler said nothing of `WikiDiagram.swift` (`*/diagnostics-WikiDiagram-*.txt`);
  the apps wrote nothing (`*/writes.txt`).

## Round 1 (run 41309141035, commit 903649436): the Mac caught a bug

`mac/round1-failure.txt`: the page stood still under a wheel turned over the diagram (`round1-…-notes.txt`: its top
stayed at 323 pt), while a sideways wheel scrolled the wide one — the figure's SwiftUI `ScrollView(.horizontal)` is an
NSScrollView and keeps up-and-down wheel events too. Fixed in 6ba851b2c: the web view takes a scroll only to hand it on,
up and down to the document's scroll view, sideways to the figure's. The iPhone passed all four tests in both rounds.

Not fixed here: the page's code blocks (and a diagram's source shown as code) sit in the same sideways scroll view, and
on the Mac a wheel turned over one still leaves the page still (`mac/DiagramShotTeststestBrokenShowsItsSourceAsCode-notes.txt`:
573 → 573; on the iPhone a drag moves it). That predates this task; it is filed as task 34q5GYyyb2vlFLKjpd49b.

## The gates

client.yml dispatched on the task branch: run 41308617930 on 903649436 and run 41313106412 on 6ba851b2c, both green —
macOS: OrbitKit `swift test` 4332 tests, 0 failures, and OrbitApp `swift build`; iOS: XcodeGen + xcodebuild for the
Simulator. OrbitKit on Linux (swift:6.1, as ci.yml's Swift core): 4332 tests, 0 failures, 5 skipped, at both commits.
