# The probe that photographs revision 42 part two on the iPhone — kept as a record

Task 350fMiONAIcbO8f6avSRj (Apple apps: draw revision 42 part two as ruled on the board,
docs/mocks/landing-measured). It builds the iPhone app's `CompactShell` from the real shared sources
into a throwaway app pointed at `stub.py`, opened where `-probe.page` says (`ProbeArgs.swift`), and
`UITests/LandingMeasuredShotTests.swift` photographs each screen once the state it is meant to show is
asserted. `run.sh` runs the class twice, with the simulator in light and then dark appearance
(`xcrun simctl ui … appearance`), and keeps each pass's request log beside its pictures.

It ran from the branch `probe/landing-measured-apple`, whose `.github/workflows/client.yml` is
today's client.yml plus a `landing_measured_probe` dispatch input and two jobs
(`landing-measured-shots`, `landing-measured-publish`), dispatched with that input on: the same run
carries client.yml's `macOS (build + test)` job (`swift test` in src/macos/OrbitKit and the OrbitApp
build) and `iOS (generate + build)`. The pictures went to `probe/landing-measured-apple-results`; both
branches are deleted afterwards. Nothing here is built by this repository.

| Board | `-probe.page` | What is asserted, then photographed |
|---|---|---|
| ① 01 b | `session:C5` | the coordinator's request names no line: "Lands on the project’s branch when a task commits", Merge check and At most kept, no Tasks land on / Main branch / landing-check field; Start sends no `line` |
| ② 02 b | `sessions:P1` | a started project whose integration read names no line: no landing card, no Landings row |
| ③ 03 b, c | `project:P2` | the landing check the coordinator set 12m ago (badge, time, the Coordinator's changes sentence, "3 changes"); No check writes `{"landingCheck": "NONE"}` and reads as the owner's |
| ④ 04 b | `task:T1`, `landing:L1` | the exempt task's Landing section (Exempt, the reason, Coordinator · marked 20m ago, Remove exemption, which writes `{"landingCheckExempt": false}`); its landing's check list reads "Landing check · Skipped" with "Exempt: …" |
| ⑤ 05 b, c, d | `project:P3` | Coordinator's changes; Revert asks first and says what follows; the confirmed revert posts `…/setting-changes/c1/revert` and the row reads "Reverted by you" |
