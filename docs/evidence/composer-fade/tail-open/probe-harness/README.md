# TEMPORARY evidence probe — never merged

A long conversation opened at its tail, on iPhone and Mac: whether the transcript lands on its tail, and
whether a reader who scrolled up stays where they are. Adapted from the composer-fade probe
(docs/evidence/composer-fade/probe-harness). It builds the iPhone app's `CompactShell` and the Mac app's
`MainView` from the real shared sources into throwaway apps pointed at `stub.py`: one workspace and one
idle DeepSeek Harness session whose transcript is long enough to scroll.

`FadeShotTests.test1Console` photographs the console as opened (`1-rest-*`, taken once the transcript's
own sticky header is up), at its tail, scrolled up, and after the jump-to-latest disc;
`test3ReaderStaysUp` scrolls up on a fresh launch and photographs it again four seconds later.
`ProbeMetrics` posts every wide scroll view's offset, content height and insets to the stub
(`metrics.log`), marked at each picture. The `diag` tree adds `diag.py`'s logging of every scroll reading
and tail decision to the same log.

To run it: copy this directory to `.cfade-probe/` at the repo root and `client.probe.yml` to
`.github/workflows/client.yml` on a `probe/transcript-tail-open` branch (set `BASE_SHA` to the commit to
compare against), and push; the report job pushes everything to `probe/transcript-tail-open-results`.
Delete both branches afterwards. Nothing here is a real runner or model; all data is made up.
