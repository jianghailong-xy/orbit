Orbit probe results — task-exempt Apple check on commit 8724c5395c3c7b31bd640ef29f7a36dd0ad3cc13
=====================================================================================================

Source commit : 8724c5395c3c7b31bd640ef29f7a36dd0ad3cc13
                "docs(release-notes): beta.65 did not draw a task's exemption on macOS/iOS"
Branch probed : origin/probe/task-exempt-apple-8724c53
Date          : 2026-11-22 (local; macOS 27.2, Xcode at /Applications/Xcode.app)
Simulator     : iPhone 17 Pro, 5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6

Contents
--------
.lm-probe/shots/light/   clean run (run 3), light appearance: 12 PNGs, requests.log, writes.txt,
                         xcodebuild-light.log, per-test notes
.lm-probe/shots/dark/    clean run (run 3), dark appearance: 12 PNGs, requests.log, writes.txt,
                         xcodebuild-dark.log, per-test notes
run-output.log           the clean run's stdout (run.sh); 14/14 test-case executions passed
exempt-focused.log       swift test --filter for the landing/exempt classes (OrbitKit, 69 tests)
exempt-full.log          full swift test of OrbitKit (5877 tests, 5 skipped, 14 failures)
exempt-parent-focused.log  the three failing full-suite tests re-run on the parent commit 52789f2f15
earlier-runs/            probe runs 1 and 2, where test4a failed in the dark look only:
                         run-output-run1.log, run-output-run2.log and the dark 04a screenshots.
                         Run 3, on an idle machine, passed both looks.

Harness: docs/evidence/landing-measured-apple/probe-harness, copied to .lm-probe one level below the
repository root so its ../src/... paths resolve. Nothing here is product code.

Results in one line: on 8724c53 all seven probe cases pass in both looks (run 3); the focused tests
have one failure (LandingViewsWiringTests.testTheTimelinesMarksReadTheLinesFields) that passes on the
parent commit; the full suite's other two failures also fail on the parent commit.
