# TEMPORARY evidence probe — never merged

Task 34hJZLqBD1zEjaKfPn6YW (C1 of project 34hIv3wbdtsxpc5RzDlOk): the merge recovery's review sheet on
iPhone and Mac, in each state of the board `docs/mocks/merge-recovery-repair-loop-ios.html` — the repair
row's six states, the check after a repair, a failed repair being checked, and ④ with two files — light and dark.

It builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared sources into
throwaway apps pointed at `stub.py`: nine idle conversations S1–S9, each with a merge held for target
recovery and a repair session on it (see the stub's header for which is which; the data is the board's).
`RepairLoopShotTests` opens each conversation, presses the recovery's row on the branch bar and
photographs the sheet, asserting the words and steps each frame must (and must not) show.

It ran from the push-triggered branch `probe/merge-recovery-repair-loop-ios` (this directory as
`.mr-probe/`, `client.probe.yml` as `.github/workflows/client.yml`); the report job pushes pictures, notes
and logs to `probe/merge-recovery-repair-loop-ios-results`. All data is made up.
