# TEMPORARY evidence probe — never merged

The line above the composer, before and after it was replaced by a fade (iPhone + Mac). Builds the
iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared sources into throwaway
apps pointed at `stub.py`: one workspace and one idle DeepSeek Harness session whose transcript is long
enough to scroll. `FadeShotTests` photographs the console as opened, at its tail, scrolled up (light and
dark), after the jump-to-latest disc, and the new-session page. `ProbeMetrics` posts every wide scroll
view's offset, content height and insets to the stub (`metrics.log`), marked at each picture.

To run it: copy this directory to `.cfade-probe/` at the repo root and `client.probe.yml` to
`.github/workflows/client.yml` on a `probe/composer-fade` branch, and push; the report job pushes the
pictures, notes, metrics and logs to `probe/composer-fade-results`. It runs the same tests on the tree
before the change (`BASE_SHA`) and on the pushed commit's parent. Nothing here is a real runner or
model; all data is made up. The boards built from it are in `docs/mocks/composer-fade/`.
