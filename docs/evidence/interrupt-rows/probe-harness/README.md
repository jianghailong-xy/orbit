# TEMPORARY evidence probe — never merged

Task 34gvBR3txIp7SfGl486Y5: the two kinds of interrupt drawn as two different rows. Builds the iPhone
app's `CompactShell` and the Mac app's `MainView` from the real shared sources into throwaway apps
pointed at `stub.py`: one workspace and one session whose short transcript holds the owner's Stop
(`{"requestId":"req-22-1"}`) and, a turn later, the runner restarting under the turn
(`{"reason":"runner_restart"}`) — the two payloads session 34dLFOCjLz8KqyCiaECec recorded on
2026-10-13. `InterruptShotTests` photographs the console (light and dark) and notes every row whose
words begin "Interrupted". The Android job runs `InterruptRowsTest` (Robolectric, native graphics)
over the same two payloads and keeps its picture.

Copied from `docs/evidence/composer-fade/probe-harness`. To run it: this directory at `.irows-probe/`
and `client.probe.yml` at `.github/workflows/client.yml` on `probe/interrupt-rows`; the push runs it,
and the report job pushes the pictures, notes and logs to `probe/interrupt-rows-results`. The Apple
shots run on the tree before the change (`BASE_SHA`) and on the pushed commit. All data is made up
apart from the two interrupt payloads.
