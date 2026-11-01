# TEMPORARY evidence probe — never merged

Task 34pVMqwUhJE0RGvrL0ziL (project "Claude region check"): the Claude region check in the iPhone app's own
screens, against board 03 of docs/mocks/claude-region-check and docs/claude-region-check-contract.md. Adapted from
the owner-answer probe (docs/evidence/owner-answer-sent-card-apple/probe-harness). It builds the iPhone app's own
`CompactShell` and Settings sheet from the real shell and shared sources into a throwaway app pointed at `stub.py`.

- `stub.py` is the fixture API: one machine, HPC, whose Claude connection comes out in mainland China
  (`runner.region` blocked, capability `claude-region/v1`); the held conversation "Fix the flaky login test"
  (QUEUED, the §9 refusal as its error, board 03's transcript); two ordinary conversations; and board 02 C's keys
  (DeepSeek, Personal Max, Work, Local vLLM). It lets through Check again (POST /runners/hpc/region-check) and the
  provider PATCH; every other write is a 409.
- `UITests/RegionShotTests.swift` opens each place, says what has to be on screen and what must not be, presses
  the card's three ways out and the machine page's Check Again, and photographs each. A missing word, a press that
  never reaches the stub, or a layout the board does not draw fails the test.
- `project.yml`, `ProbeArgs.swift`, `ios/RgnProbe.swift`, `Info.plist` and `run.sh` build and run it;
  `client.probe.yml` is the probe branch's `.github/workflows/client.yml`.

To run it again, copy this directory to `.rgn-probe/` at the repository root (its `../src` paths are relative to
there) and run `bash .rgn-probe/run.sh` on a Mac with Xcode and XcodeGen. All data is made up.
