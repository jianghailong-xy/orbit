# C3 — Android merge recovery review, repair loop states (probe branch only, not merged)

Task 34hJZMKsulMrCDCAtPOIU, project 34hIv3wbdtsxpc5RzDlOk. Board: docs/mocks/merge-recovery-repair-loop-ios.html
(frames ①–⑥, and the repair row's six states).

Drawn by `src/android/app/src/test/kotlin/io/orbitd/android/reader/MergeRecoveryShotsTest.kt` (Robolectric, native graphics,
w393dp-h852dp-xxhdpi) over the production `MergeRecoveryReview` at 5687903a4, light then dark (`OrbitTheme(darkTheme = …)`).

| File | Board | State | Primary step |
|---|---|---|---|
| 1-running-{light,dark}.png | ① | Repair session running | Open repair session + "Orbit checks again when the repair stops." |
| 2-checking-{light,dark}.png | ② | Repair session finished · Checking its result… (snapshot dimmed) | Checking… (disabled) |
| 3-ready-{light,dark}.png | ③ | Repair session finished · Checked just now — ready to merge | Sync main and merge · Prepare PR candidate |
| 4-conflict-left-{light,dark}.png | ④ | Repair session finished · Checked just now — 1 conflict left (carried repair, TARGET_SYNC footnote) | Continue repair · Prepare PR candidate |
| 5-needs-reply-{light,dark}.png | ⑤ | Repair session needs your reply · “Keep the target's version?” · 2m ago; "Still unresolved" | Reply in repair session |
| 6-already-landed-{light,dark}.png | ⑥ | Already on origin/main (real data: bba5d7b3, 99cd5459), no repair row | Done (confirm-landed) |
| 7-failed-{light,dark}.png | row 6 | Repair session failed · The model provider rejected the request (conflicts) | Resolve in repair session · Prepare PR candidate |
| 8-unfinished-failed-{light,dark}.png | row 6 + ⑤ | Repair session failed, repair left unfinished ("Still unresolved") | Resolve in repair session |

The session title "解决 main 分支合并恢复" is the board's demo data (a session's title is the owner's data, not product copy).
