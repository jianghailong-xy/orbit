#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged; see NOTES.md): the Mac picture of the session list,
# taken by launching the real app at the stub and letting it photograph its own window.
#
# The XCUITest pass drives both platforms on CI (see run.sh). On a host where the UI-test runner
# cannot enable automation mode ("Timed out while enabling automation mode" — the TCC grant is the
# owner's to give) and `screencapture` cannot take the screen either ("could not create image from
# display"), the Mac side is taken here instead: the same probe app, the same stub, the same launch
# arguments, and `-probe.shot <out>.window.png`, which makes the app draw its own content view into
# a PNG. That is the window's own pixels, from the real app, with no screen capture and no window
# chrome. Nothing is pressed.
#
# Usage: mac-shot.sh <out.png> [--recaps-off] [extra launch args…]
set -uo pipefail
cd "$(dirname "$0")"
OUT="$1"; shift
STUB_FLAGS=()
if [ "${1:-}" = "--recaps-off" ]; then STUB_FLAGS=(--recaps-off); shift; fi
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=".dd-mac/Build/Products/Debug/RecapMacProbe.app"

if [ ! -d "$APP" ]; then
  xcodebuild build -project RecapProbe.xcodeproj -scheme RecapMacProbe -destination 'platform=macOS' \
    -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-mac-app.log 2>&1 \
    || { echo "build failed:"; tail -20 build-mac-app.log; exit 1; }
fi

rm -f "$OUT" "$OUT.window.png"
python3 -u stub.py 8766 "$OUT.log" "${STUB_FLAGS[@]+"${STUB_FLAGS[@]}"}" > "$OUT.log.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8766/api/sessions && break; sleep 1; done

"$APP/Contents/MacOS/RecapMacProbe" -orbit.instance http://127.0.0.1:8766 -probe.fresh \
  -shell.sidebarVisible NO -ApplePersistenceIgnoreState YES \
  -probe.shot "$OUT.window.png" "$@" > "$OUT.app.log" 2>&1 &
APP_PID=$!
# The app keeps writing its window's bitmap (see WindowShot); the first write is minutes in, so wait
# for one and settle rather than for a picture that lands on a fixed clock.
for i in $(seq 1 90); do [ -s "$OUT.window.png" ] && break; sleep 1; done
sleep 1
kill $APP_PID 2>/dev/null
echo "wrote $OUT.window.png ($(stat -f%z "$OUT.window.png" 2>/dev/null) bytes)"
