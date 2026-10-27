# iOS / macOS — a project's landings in one Landings window

Task `34nGbUykKeP4geymwZYB8` (owner 2026-10-27, board `docs/mocks/landings-one-window/`, contract
`docs/project-integration-line-contract.md` §2.9 LS6 / §3.6, revision 28).

The pictures are the real iPhone and Mac apps, built from this tree's `OrbitKit` and `OrbitApp` sources on
GitHub's macOS runners and driven by XCUITest against `probe-harness/stub.py` — run
[40579956021](https://github.com/jianghailong-xy/orbit/actions/runs/40579956021), commit `7994c5c3e` of the branch
`probe/landings-one-window` (a snapshot of this tree with revision 2's changes, with `probe-harness/ci/client.yml.probe` as
`.github/workflows/client.yml`; the probe branches were deleted afterwards). The stub answers the reads the apps make for one project, `Wiki server`; every project, task
and runner name in it is example data. Its times are set relative to the moment it runs, so the clock times differ from the
board's.

| Picture | Board frame | What it shows |
|---|---|---|
| `ios/b-project-page.png` | 01 b | The project's sessions page on an iPhone: under Coordinator one **Landings** row — ✕ (a landing waits for a decision), `29m` (the longest wait), `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` over two lines — and below it the day sections with sessions only (no Merged into main row). |
| `ios/d-window.png` | 02 d | The row, pressed, pushes the project's Landings window, standing at its bottom: `Landings` / `Run by Orbit · Wiki server` and its ⋯, Today's settled rows (✓ Landed, ◌ Nothing to land, ⇢ `Merged into main · 3f1c2a9 · 2 tasks · automatically`) at their settle times, then `Now` with the waiting card — its attempt stopped on a failed check, so its head wears the Landings row's red ✕ and a red `Not landed` (revision 2) — with its doors Open Coordinator / Open Task, and the in-flight card (V6 clock, the budget bar about a fifth full at `6m 12s of 30m` with the usual-duration tick at 9 of 30 minutes, liveness), and the read-only footer. No composer. |
| `ios/e-merge-open.png` | 03 e | The Merged into main row pressed: opened in place (⌃ on its right) to the receipt — `Now on main · 2 tasks`, the tasks, `✓ Passed on the combined tree · 17m 41s`, `Landed exactly the tested tree 5e5bfca · as a merge commit` — over the round's own record (`Merge check · 1`, `Merge to main · 1`). |
| `ios/f-focused.png` | 03 f | A landing session's id (`orbit-session:` / `openFromConversation(.session)`, which every Open landing ›, coordinator card door, task page Landing section and landing label goes through) opens the window on that landing: yesterday's `Ledger migration order` scrolled to, opened (two generations, the failed check's tail inline, `Open Task ›`, `Open Source Session ›`) and outlined. |
| `ios/f-after-the-outline.png` | 03 f | The same two seconds later: the outline has gone (it lasts 1.5 s); the landing stays open. |
| `ios/g-card-menu.png` | 03 g | A long press on the in-flight card: the old landing page's ⋯ rows — Open Task, Open Source Session, Open Coordinator, then `Stop Landing` with `Before the push only · nothing pushed yet`. Behind the menu, the waiting card's red ✕ and the in-flight card's bar about a fifth full. |
| `mac/window-focused.png` | f (macOS) | The Mac's window on the same landing id: the project's Landings window in the console's detail pane, the landing opened, Today's rows under it, the footer. The picture was taken after the outline had faded. |

## The same run's gates

| Job | Result |
|---|---|
| macOS (build + test) | success — the Mac app built; `swift test` of OrbitKit: 4081 tests, 5 skipped, 0 failures |
| iOS (generate + build) | success |
| Navigation (one push mechanism per stack) | success |
| Font tokens (bare `system(size:)` audit) | success |
| Landings window probe (Mac window + iPhone) | success — 3 iPhone tests and 1 Mac test passed (`probe-harness/UITests/LandingsWindowTests.swift`) |

## Run again

Put `probe-harness/ci/client.yml.probe` in place of `.github/workflows/client.yml` on a branch of this tree and dispatch it with
`landings_window_probe: true`. The job copies `probe-harness/` to `.lw-probe/` and runs `run.sh`, which serves the stub, builds
the probe apps with XcodeGen and photographs the frames; the pictures, the accessibility trees and the stub's request logs are the
`landings-window-shots` artifact.

## Notes

- Revision 2 (review of revision 1): an attempt that stopped on a failure — `CHECK_FAILED`, `CONFLICT`, `ERROR`, read from the
  attempt's state (`LandingPageCopy.failureStates`) — wears the red ✕ head and a red `Not landed` (`ProjectLandingHead`'s `failed`);
  and `LandingPageCopy.attemptCard`'s budget fraction is the step's seconds over the budget's seconds (it divided by milliseconds,
  and the bar stayed empty in revision 1's `d-window.png`). Every picture here is from the run above, after both changes.
- The long press of frame g: in three runs of this build, the first long press on the in-flight card's task name opened no menu,
  where revision 1's run opened it on the first try; the harness now presses again on another line of the card, up to three
  times, and notes each try. In run 40579956021 the second press, on the card's budget line, opened the menu. The card redraws
  every second (its clock, and now a bar that moves), which may cancel the system's long press before its menu comes up.
- On an iPad the row opens the window as a sheet over the project page; that path was not photographed.
