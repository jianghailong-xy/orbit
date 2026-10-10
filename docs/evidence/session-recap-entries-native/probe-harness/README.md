# TEMPORARY evidence probe — never merged

The server's recap (0418) where a session is entered from besides the session list, on the iPhone and
on the Mac: the chat page's top, and a project's entries — the project's row in the workspace list and
its sessions page (iPhone), its page's coordinator card (both). It is the session-recap probe
(`docs/evidence/session-recap-native/probe-harness`) re-pointed: the same two throwaway apps built out
of the real shared sources (`src/macos/OrbitKit` as a package, `src/macos/OrbitApp/Sources/OrbitApp`,
`src/ios/Sources` minus its `@main`), the same `--recaps-off` stub flag as the whole difference
between the two passes, and the same `RECAPS_OFF` test variable deciding which claims a pass makes.

| File | What it is |
|---|---|
| `project.yml` | XcodeGen: `RecapEntriesProbe` (iPhone) and `RecapEntriesMacProbe` (Mac), each with a UI-test bundle |
| `ProbeArgs.swift` | where a launch lands, `-probe.page chat\|list\|sessions\|project`, after reading `me` (the switch) |
| `ios/RecapEntriesProbe.swift`, `mac/RecapEntriesMacProbe.swift` | the shells: `CompactShell` and `MainView` (+ the Mac app's own window picture, `-probe.shot`) |
| `UITests/RecapEntriesShotTests.swift` | the claims and the pictures; a wrong claim fails the test after its picture is kept |
| `UITests/ProbeCase.swift` | the session-recap probe's helpers, also reading a Mac text view's value |
| `stub.py` | P1 "Recap everywhere": coordinator S1 and member S2 recapped, member S3 a reply only, S4 in no project; S1's conversation; `--recaps-off` |
| `run.sh` | the CI entry point: Mac on/off, then iPhone on/off, one stub per pass, artifacts collected |
| `../ci/client.probe.yml` | the probe branch's `client.yml`: the macOS and iOS compile gates, the shots job, the results push |

The coordinator status read is served as the apiserver serves it (no words of the conversation): the
coordinator card's line comes from the coordinator's own row in the session list the app already
holds, which is what the card pictures show.

To run it: on a throwaway branch `probe/session-recap-entries` off the commit under test, copy
`../ci/client.probe.yml` to `.github/workflows/client.yml` and push. The `report` job pushes the
pictures, notes, trees and request logs to `probe/session-recap-entries-results`.
