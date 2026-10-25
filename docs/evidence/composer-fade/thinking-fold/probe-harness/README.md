# TEMPORARY evidence probe — never merged

One scripted live turn on the iPhone and Mac apps: three stretches of thinking fold to their
one-line summaries one after another while the transcript is pinned at its tail, with NO reader
touch. Adapted from the tail-open probe (docs/evidence/composer-fade/tail-open/probe-harness). It
builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared sources
into throwaway apps pointed at `stub.py`: one workspace and one session whose transcript holds six
settled rounds, then a seventh turn the test drives step by step over `POST /__step` — thinking
deltas, the durable `thinking` that folds each stretch (before its tool card, the way
src/runner-go/kimi_stream_order_session_test.go orders them), two tool calls, a reply, turn end.

`FoldShotTests.test1FoldsPinnedLight` (and a dark variant on iOS) launches into the console, waits
for the live event stream, and never touches the transcript: per fold it photographs the full
160pt streaming box, the frame right after the fold, and the settled state; the turn-end resting
state is read off the jump-to-latest disc and the last line's position. `diag.py` (applied to the
tree before the build) adds `DiagLog` to TranscriptView so the stub's `metrics.log` carries every
scroll-geometry change (offset / content height / insets / visible band), every scroll phase
transition, the pin/follow decision on every reading, every publish and every scroll the
transcript asks for — numbered and stamped with `systemUptime`, the same clock the test's picture
marks carry.

To run it: copy this directory to `.tfold-probe/` at the repo root and `client.probe.yml` to
`.github/workflows/client.yml` on a `probe/thinking-fold-tail` branch, and push; the report job
pushes everything to `probe/thinking-fold-tail-results`. Delete both branches afterwards. Nothing
here is a real runner or model; all data is made up.
