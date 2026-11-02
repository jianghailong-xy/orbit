# Wiki document diagrams on Android: evidence

Task 34noHce7sfUfPBKdZKNLe, *Draw wiki document diagrams in the Android app*. The code is commit 429778ce3 on
`orbit/task-draw-wiki-document-diagrams-in-the-dd878b`. The APKs below were built from it with a clean tree.

## What the app does

A section's `diagram` block (contract `docs.diagram`) is drawn by `WikiDiagram`
(`src/android/app/src/main/kotlin/io/orbitd/android/wiki/WikiDiagram.kt`), the way the web's `WikiDiagram.tsx` draws it.

- **Mermaid 12.2.0**, the version `package-lock.json` pins for src/web, ships as `assets/mermaid/mermaid.min.js` with its
  MIT `LICENSE`. The file is `dist/mermaid.min.js` byte for byte from the registry tarball whose sha512 is the lockfile's
  integrity. Nothing is fetched.
- **The web's options**: `startOnLoad: false`, `securityLevel: 'strict'`, `theme: dark ? 'dark' : 'neutral'` (dark is the
  app's own theme), `fontFamily` the page font (`sans-serif`), `flowchart: { useMaxWidth: false }`, then
  `mermaid.render(id, text)`.
- **Size**: the WebView spans the column and is as high as the drawn SVG, which the page reports through its one
  `@JavascriptInterface` method, `size(width, height)`. While Mermaid draws, the figure is 120 dp high, like the web's
  busy figure. The page centres a narrow drawing and scrolls a wide one sideways (`overflow-x: auto`), like the web's
  figure.
- **Fallback**: when Mermaid throws, the page does not load or its renderer is gone, the block shows its source as
  monospaced code, like a code block.
- **Locked down**: JavaScript on, `blockNetworkLoads`, no file or content access. Requests are answered from the one asset
  alone (a WebViewAssetLoader path handler); every other request gets an empty 403, except the page's own `data:` URL.
  The page never navigates (`shouldOverrideUrlLoading` returns true), and the size callback is its only bridge.
- **TalkBack** names the figure "Diagram" (the web's `WIKI_DOC_DIAGRAM`), role Image, and the WebView's own tree is
  hidden. `WikiDocCopy.diagramOnWeb` is gone.

## Screenshots

`emulator-5554`: API 36, 1080×2400 at 420 dpi (411 dp wide), Android System WebView 133.0.6943.137. The real app signs
in to an in-process fixture server (`WikiDiagramDeviceTest`, run by `src/android/scripts/increments-device-test.sh`),
opens the document from the wiki home, and draws it in the account's light or dark theme.

| | light | dark |
|---|---|---|
| A section's diagram that fits the column: drawn and centred | [01](light/01-section-diagram.png) | [01](dark/01-section-diagram.png) |
| The server spec's own written-out flowchart, 1111 dp wide | [02](light/02-wide-diagram.png) | [02](dark/02-wide-diagram.png) |
| The same after a sideways drag (520 dp of 755) | [03](light/03-wide-diagram-scrolled.png) | [03](dark/03-wide-diagram-scrolled.png) |

`device/checks-light.txt` and `device/checks-dark.txt` hold each journey's 23 checks, read back from the page itself:
the SVG Mermaid drew and its labels, the WebView sized to it, the centring, the theme (first node `rgb(238, 238, 238)`
light, `rgb(31, 32, 32)` dark), the font, the one script the page loaded (the app's asset), the sideways scroll, a drag
down over a diagram scrolling the document, and the fixture server never asked for a script (`device/requests-*.txt`).
`device/instrumentation.txt` ends `OK (2 tests)`.

## Unit tests

`:app:testDebugUnitTest` at 429778ce3 with a clean tree (Gradle kit `/mnt/data/ok-pds/g.sh`): BUILD SUCCESSFUL, 264
classes, 2086 tests, 0 failed, 0 ignored. [unit-tests.txt](unit-tests.txt) lists every class.

`WikiDiagramTest` (9 tests) covers what can be tested without a WebView's JavaScript:
- the page the view loads: Mermaid from the app's assets and nothing else, with the settings `WikiDiagram.tsx` uses;
- that no source can break out of its script;
- the bundled Mermaid against the lockfile;
- the lockdown: the settings, the one bridge, the asset loader and its 403s, no navigation, the `data:` page, and a page
  or renderer failure;
- the figure's size, the theme, the fallback and the drag rule.

The wiki contract test `WikiDocsContractTest` (13 tests) stays green.

CI's Android job also runs these two, at the same commit:
- `:app:lintDebug` reports no errors (44 warnings, 2 hints), and none of them is in the new code or about
  `androidx.webkit`.
- `:app:testReleaseUnitTest --tests io.orbitd.android.wiki.WikiDiagramTest` passes 9 of 9.

## What the device showed that Robolectric could not

Robolectric runs no WebView JavaScript and its WebView measures nothing, so these came from the emulator:

1. **The page's own `data:` URL goes through `shouldInterceptRequest`.** Refusing everything but the asset showed
   Chromium's "Webpage not available". `data:` now passes, and a main-frame load error falls back to the source as code
   rather than an error page.
2. **A WebView wider than the screen drew nothing.** A 2916 px-wide WebView inside a Compose sideways scroller stayed
   blank: its page was visible, its visible rect was right, and neither `invalidate()` nor `offscreenPreRaster` helped.
   The WebView now stays the column's width and its page scrolls the diagram, as the web's figure does.
3. **The navigation drawer took sideways drags.** Compose hands a View each move before the gestures around it see it,
   but Chromium never asks its parent not to intercept. `ModalNavigationDrawer` claimed the drag after the touch slop, and
   the diagram scrolled 5 to 22 dp of 755. The WebView now asks not to be intercepted when a drag is sideways over a
   diagram wider than itself (`WikiDiagramPage.ownsDrag`), and it scrolls about 520 dp. Other drags, and sideways ones
   over a diagram that fits, still go to the list and the drawer.

Also seen: Mermaid 12 draws every box at least 152 px wide, so a flowchart with two boxes side by side is 360 dp wide.
That is 5 dp more than the 355 dp inside a figure on a 411 dp phone with the web's 12 dp padding, so such a diagram
scrolls by 5 dp, as it does on the web's phone layout.

## Run them again

- Unit tests: `OK_PDS_WT=<worktree> OK_PDS_BUILD=<build dir> /mnt/data/ok-pds/g.sh <label> :app:testDebugUnitTest`
- Device: build `:app:assembleDebug :app:assembleDebugAndroidTest`, then hold the device lock and run
  `INCREMENTS_CLASSES=WikiDiagramDeviceTest src/android/scripts/increments-device-test.sh <app apk> <test apk> <new dir> emulator-5554`.
