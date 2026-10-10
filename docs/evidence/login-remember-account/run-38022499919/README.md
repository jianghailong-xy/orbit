# Probe run 38022499919

The run behind `docs/mocks/login-remember-account/sim/`:
https://github.com/jianghailong-xy/orbit/actions/runs/38022499919, on probe commit `ba62e3100` (the app
code at `a410403f7` with `client.yml` swapped for `../probe-harness/client.probe.yml`).

- `RESULTS.txt`, `outcomes.txt`, `*-gate-outcomes.txt`: every job green — the macOS gate (OrbitKit
  `swift test` on macOS and OrbitApp `swift build`), the iOS gate (the Orbit app built for the
  simulator), and the capture.
- `summary-build-ios.txt`, `summary-build-mac.txt`: 7 iPhone UI tests and 1 Mac UI test, 0 failures.
- `ios/requests.log`, `mac/requests.log`: everything the page asked the stub, stamped to the
  millisecond and marked at each picture (`=== shot …`). The sign-in attempts are logged without the
  password, only whether it was the right one. `not-served.txt` is empty on both: the page asked for
  nothing the stub doesn't serve.
- `ios/*-notes.txt`, `mac/*-notes.txt`: what each test read off the screen (element frames, the card's
  label, the keyboard, the good sign-ins counted for the card).
