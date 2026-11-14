# Main checkout Git on iOS and macOS — the probe that took the pictures

Task 34vZvzdK0NZaSo0JNQ2ES (project 34vZkpKmUuObg8kDVU4Lk; boards `docs/mocks/main-checkout-git/` 01–04, contract
`docs/main-checkout-git-contract.md`). `probe-harness/` is kept as a record; nothing in this repository builds it.

It ran from the push-triggered branch `probe/main-checkout-native` (deleted afterwards with its `-results` branch), where
these files sat under `.mc-probe/` and `client.probe.yml` replaced `.github/workflows/client.yml`. The probe commit is the
task branch plus the harness, so the `macos` and `ios` jobs are client.yml's own gates on the task's tree (OrbitKit
`swift test` on macOS, OrbitApp `swift build`, the iOS app's `xcodebuild`), and `shots` builds the iPhone app's own
`CompactShell` and the Mac app's own `MainView` (or the workspace settings form, `AgentFormContent`) into throwaway apps
pointed at `stub.py`. The stub serves two workspaces with dirty main checkouts and four sessions; its result lines and
changed card are taken from `src/shared/src/main-checkout-git.fixture.json`, so the words on screen are the server's.
`MainCheckoutShotTests` opens each place and photographs it: the card (and its ⋯), the bar, the review sheet (every file
chosen, 2 of 3, the Move targets), the success and refusal lines, the Shared session's bar, and board 04's two dialogs.
The iPhone is an iPhone 16 (393×852 pt).
