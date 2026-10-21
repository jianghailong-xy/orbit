# TEMPORARY evidence probe — never merged

A runner's Default removed from Orbit, on the iPhone app's Codex page (task 34jpFWOnhGsjNrBGIKi9V,
project 34jjcdca6uuW0qHCjTdKg, criterion 5). The probe drives:

- Remove on Default's long-press menu and on its swipe, with the web's confirmation;
- the removed state with two accounts left and with one;
- Use again, online and with the runner offline;
- the runner page's Codex row;
- an added account's question while Default is removed: Automatic, or the last account;
- Default alone, which offers no Remove.

It builds the app's own CompactShell and Settings sheet from the real shared sources into a throwaway
app pointed at `stub.py`. Adapted from the Kimi accounts probe (docs/evidence/kimi-accounts-ios). All
data is made up.

- `stub.py` is the fixture API: one machine, HPC, with Codex's Default, Work and Personal. It holds
  the control plane's own record: DELETE …/codex/default removes Default (refused with the server's
  sentence when Default is alone), and POST …/default/restore brings it back. While Default is removed,
  the runner is served as `usedRunnerEngines` serves it. `POST /__set` picks the accounts, the record
  and whether the machine is online.
- `UITests/RdrShotTests.swift` says what is pressed and what has to be on screen. A missing word, or a
  press that never reaches the stub, fails the test.
- `project.yml`, `ProbeArgs.swift`, `ios/RdrProbe.swift`, `Info.plist` and `run.sh` build and run it.

To run it again, copy this directory to `.rdr-probe/` at the repository root (its `../src` paths are
relative to there). Then run `bash .rdr-probe/run.sh` on a Mac with Xcode and XcodeGen; CI does that from
`client.yml`'s probe job on a `probe/…` branch (see ../README.md).
