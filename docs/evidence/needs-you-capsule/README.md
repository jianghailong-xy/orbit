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
