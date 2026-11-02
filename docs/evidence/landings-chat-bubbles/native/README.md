# iOS / macOS — the Landings window drawn as a chat

Owner 2026-11-02, board `docs/mocks/landings-chat-bubbles/` (option C, every recommended pick: the time in each bubble's foot, a
read-only bar shaped like the composer with `Open coordinator`, Orbit's avatar once per group). The window's code is
`src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectLandingsWindowView.swift`, shared by both apps; the grouping rule is OrbitKit's
`SessionProjectLandings.groups` / `groupGap`.

The pictures are the real iPhone and Mac apps, built from this tree's `OrbitKit` and `OrbitApp` sources on GitHub's macOS runners and
driven by XCUITest against `probe-harness/stub.py`: run
[41373778258](https://github.com/jianghailong-xy/orbit/actions/runs/41373778258), commit `9fbd335c7` of the branch
`probe/landings-chat-bubbles` (this tree with `probe-harness/ci/client.yml.probe` as `.github/workflows/client.yml`; the probe branches
are deleted after landing). The iPhone is the simulator's Pro Max, 1320 × 2868, the owner's size. Every name in the stub is example data,
and its times are set relative to the moment it runs. The commits after `9fbd335c7` change no Swift source, so these frames still show
the final apps.

| Picture | Board part | What it shows |
|---|---|---|
| `ios/a-window-bottom.png` | 02 d | The window as the project page's Landings row pushes it, at its bottom: the `Today` chip; T3's bubble and the merge into main a minute later, one group beside one avatar; the blue `Now` chip; then one group holding the waiting card (red ✕, `Not landed`, Open Coordinator / Open Task) and the checking card (clock, budget bar with the usual-duration tick, liveness) across the whole column; and the read-only bar in the composer's place, glass on iOS 26, floating over the window. |
| `ios/a-window-bottom-dark.png` | 02 d | The same in the dark appearance. |
| `ios/b-history.png` | 01 b | Scrolled up: the `Yesterday` and `Today` chips, and each landing's bubble with its merge into main under it, one avatar per group. Task names are whole and wrap; a merge's bubble hugs its foot; every bubble keeps the 44 pt gutter. The messages run on under the bar's glass. |
| `ios/c-bubble-open.png` | 03 e | T3's bubble pressed: its record opens under it on the quiet panel the person's own message opens what Orbit attached to: `Generation 1`'s timeline, then `Open Task ›` and `Open Source Session ›`. |
| `ios/d-bubble-menu.png` | 03 f ①② | A long press on T3's bubble: it lifts, the screen dims, and the old landing page's rows come up: Open Task, Open Source Session, Open Coordinator. |
| `ios/e-focused.png` | 03 f ③ | A landing session's id (`orbit-session:`, which every Open landing › goes through): the window opens on yesterday's T2, opened (two generations, the failed check's tail inline), outlined on its bubble. |
| `ios/e-focused-after.png` | 03 f ③ | The same two seconds later: the outline has gone, T2 stays open. |
| `mac/window-focused.png` | 03 f ③ (macOS) | The Mac's window on the same landing: the chat in the console's detail pane, the bar in the composer's place. |

## The same run's gates

| Job | Result |
|---|---|
| macOS (build + test) | success: the Mac app built, and `swift test` of OrbitKit passed |
| iOS (generate + build) | success |
| Navigation (one push mechanism per stack) | success |
| Font tokens (bare `system(size:)` audit) | success |
| Landings window probe (Mac window + iPhone) | success: 5 iPhone tests and 1 Mac test passed (`probe-harness/UITests/LandingsWindowTests.swift`) |

The stub's requests are in the run's `landings-window-shots` artifact.

## Run again

Put `probe-harness/ci/client.yml.probe` in place of `.github/workflows/client.yml` on a branch of this tree and dispatch it with
`landings_window_probe: true`. The job copies `probe-harness/` to `.lw-probe/` and runs `run.sh`, which serves the stub, builds the probe
apps with XcodeGen and photographs the frames. The publish job pushes the pictures, trees and logs to
`probe/landings-chat-bubbles-results`.

## Notes

- **The Mac window's minimum.** Run 41370339640 caught a bug in the first version of the bar: its sentence was vertically fixed, and the
  bar stands under the scroller on the Mac, so it counted toward the window's minimum, which AppKit measures at zero width. There the
  sentence stood one glyph to a line, and at 13 pt the whole split view laid out 815 pt tall in a 737 pt window, with the bar off the
  bottom edge. The sentence is capped at two lines now. `LandingViewsWiringTests` holds the cap, and the Mac test asserts that
  `Open coordinator` stands inside the window. In the run above the split view is exactly the window, 1010 × 737.
- **The lift.** A long press lifts the bubble out of the window. On iOS its tint stands on the window's own colour, because a bare tint
  showed the dimmed screen through it (run 41368357883).
- **The card's task name.** It wraps now on all three clients, as board 02 d draws it. On this Pro Max T6's name fits one line anyway;
  the wrap shows on narrower screens, as in the Android and web frames.
