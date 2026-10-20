# Evidence: the needs-you bar is a glass capsule

Design board: `docs/mocks/needs-you-capsule/01-directions.{html,png}` and `02-capsule-a.{html,png}`. On
2026-10-21 the owner picked A, with the second line naming the project and no `Oldest:`
(「A，第二行写项目名，不加 Oldest，开工」).

## iPhone screenshot probe

`probe-harness/` is a copy of `docs/evidence/landing-session-followup/probe-harness` without its Mac
pass, because the bar is iPhone-only:

- It runs the real `CompactShell` against `stub.py` on the largest iPhone the runner has. A Pro Max
  is preferred, since it is as wide (440pt) as the owner's phone. The status bar is fixed at 4:32 and
  48%, as in the owner's screenshot.
- The stub's Open list holds S6, the conversation on screen, which is a long one. It also holds C1,
  the project's coordinator, with one `COORDINATOR_QUESTION` asked 2 hours ago on the project the
  owner's screenshot named, and S5, a conversation blocked on a tool approval (the capsule's `+1`).
  In `lease` mode, C1's own conversation also holds the X-E5 card.
- `NeedsYouShotTests` shoots three pages, each light and dark: a conversation (the capsule pointing
  elsewhere), the session list, and C1's own conversation (the capsule pointing at its card). Each
  launch fails unless the capsule's accessibility label says the words the stub served.
- `ci/client.probe.yml` goes onto the probe branch as `.github/workflows/client.yml`. On the same
  commit it also runs client.yml's two compile gates: `swift build` of OrbitApp for macOS, and the
  iOS simulator build. The results are pushed to `probe/needs-you-capsule-results`.

## Results

Run [39500475414](https://github.com/jianghailong-xy/orbit/actions/runs/39500475414) ran on probe commit
`c31c058e0`. That commit is the feature tree before its rebase onto main, plus the workflow swap. Every job
passed: `macOS (build OrbitApp)`, `iOS (generate + build)`, the shots (3 UI tests, 0 failures) and the
publish (`ios/RESULTS.txt`, `ios/outcomes.txt`, `ios/summary-build-ios.txt`). The simulator was an iPhone 17
Pro Max on iOS 26, 1320×2868 like the owner's screenshot.

- `ios/ios-{chat,list,owner}-{light,dark}.png` are the six frames. `ios-sheet.png` puts them side by side.
- The notes files record the capsule's frame as XCUITest read it: `(20, 116, 400, 44)` on every page. Its
  ends line up with the back button and ⋯ (20–64 and 376–420), and it is the nav bar's own 44pt. Its
  accessibility label reads `Question from coordinator, 落地会话：每次落地都有自己的会话、实时输出和 owner 门, +1`
  on the conversation and the list, and `1 waiting` (with no question) inside the coordinator's conversation.
- Where it differs from the board:
  - The capsule hangs from the nav bar's bottom edge, 10pt under the buttons, where the board drew 6pt.
  - On the 440pt phone the second line drops this project's last character (`…实时输出和 owner…`).
  - On iOS 26 the conversation's top shows the transcript blurred behind the nav bar and the capsule.
    That is the system's soft scroll-edge effect, kept since the owner's 2026-10-16 call that the
    transcript runs on behind the bar.

The owner saw these frames and said to merge into main (「可以，合进 main」).

The same probe branch also ran GitHub's `Android CI` (run 39500475500, test + lint + debug APK), and it
passed. On HPC, `test lintDebug assembleDebug` passed (3406 tests, 0 failures) and OrbitKit passed
(4035 tests, 0 failures, 5 skipped) on the feature commit.
