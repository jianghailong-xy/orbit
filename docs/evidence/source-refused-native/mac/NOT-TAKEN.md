# Why there are no Mac pictures here

The Mac pass of `run.sh` never photographed anything on this host, and neither did `mac-shot.sh`.
Both are the host's, not the card's:

- the UI-test runner cannot take automation mode —
  `RunStartMacProbeUITests-Runner (19431) encountered an error (The test runner failed to initialize
  for UI testing. (Underlying Error: Timed out while enabling automation mode.))`, kept in
  `xcodebuild-mac.log`;
- `screencapture` has no display to read — `could not create image from display`;
- `CGWindowListCreateImage` for the app's own window comes back with the window's chrome and an
  empty content area, the same frames every run (the window server is not compositing app content
  on a host with no display).

Both grants are the owner's to give, and neither can be given from inside a session.

What DID happen on this host: the Mac app built (`BUILD SUCCEEDED`), launched against `stub.py`
with `-orbit.instance`, read `/api/sessions`, opened S1's console and polled it
(`/api/sessions/S1`, `/events`, `/background`, `/approvals`, `/turns`), and SwiftUI laid the window
out — `sample` caught it in `AppModel.loadSessions() → fetchOpenSessions() →
applySessionSnapshot() → NSHostingView`. So the app runs; only the picture is missing.

Take it one of two ways:

- CI, as the crossings probe did: push `.done-probe` + `.github/workflows/client.yml` (the
  `client.shots.yml` in the crossings harness is the shape) and let `run.sh` drive both platforms on
  `macos-26`;
- or on this Mac once a display is attached and the terminal holds Automation and Screen Recording:
  `bash mac-shot.sh S1 mac/mac-1-refused.png`, and the same for `S2`, `S3` and `-probe.project`.
