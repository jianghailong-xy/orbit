# TEMPORARY evidence probe — never merged

Task 34tKCNy9aN3Itk5SgIoIl: why the iPhone app sometimes sends nothing for 10-12 s after a Wiki Review challenge's
Keep (task 34tDf8rxHzhwoGyK6r0kj saw it twice in nine answers, runs 42335927712 and 42344410162). Built from that
task's kit (`ios-keep-stall-kit.tar.gz`, adapted from `docs/evidence/wiki-diagram-apple/probe-harness`): the same
throwaway iPhone app from the tree's `CompactShell` and shared sources, the same `stub.py` and `data/`, the same
`capture.py`, and the same press as ReviewShotTests' test3 / `press()`.

What is new:
- `ios/StallWatch.swift`: a watchdog thread inside the app. It pings the main queue every 20 ms; while the main
  queue is more than 250 ms late it writes the main thread's stack every 100 ms (suspend, frame-pointer walk into a
  preallocated buffer, resume, then dladdr). A window the test opens just before each tap writes the main thread's
  stack every 100 ms and every thread's every 2 s for 22 s. HB lines every second; HELD lines when the watchdog itself
  did not run. Output: `shots/ios/stallwatch-<trial>.log` (demangled after the pass).
- `UITests/KeepStallTests.swift`: twenty trials per lane, each launching afresh against a reset stub. Half ask
  `capture.py` for its host capture (simctl video + screenshots) around the press, half do not; half open and cancel
  the Retire… dialog first. Lane b flips lane a's capture plan, so each of the four modes is pressed ten times.
  `trials.log` gets one line per trial: tap() timing, the decide's answer and the app's next request, the gap.
- `sentinel.py`: on the host, any decide the app does not follow with a request within 2 s gets a spindump of the
  app (sudo), `ps` of the app every 250 ms until its next request, and a `top`.
- `run.sh` also streams the simulator's log (the app at info level; backboardd, SpringBoard, runningboardd,
  testmanagerd and the test runner at default level) and the host's load average, and runs `analyze.py`.
- `capture.py` takes `CAPTURE_SAMPLE=0`, leaving the sampling to the sentinel in every mode.
