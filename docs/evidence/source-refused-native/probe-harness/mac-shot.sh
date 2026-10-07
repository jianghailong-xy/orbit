#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): the Mac pictures, taken by launching the real app at the
# stub and letting it photograph its own window.
#
# The XCUITest pass drives both platforms on CI (see run.sh). On this host the UI-test runner cannot
# enable automation mode ("Timed out while enabling automation mode" — the TCC grant is the owner's
# to give) and `screencapture` cannot take the screen either ("could not create image from
# display"), so the Mac side is taken here instead: the same probe app, the same stub, the same
# launch arguments, and `-probe.shot <path>`, which makes the app draw its own content view into a
# PNG. That is the window's own pixels, from the real app; it is not a screen capture, and the
# window chrome is not in it. Nothing is pressed — every press the phone pass exercises is
# exercised there.
#
# Usage: mac-shot.sh <session> <out.png> [extra launch args…]
set -uo pipefail
cd "$(dirname "$0")"
SESSION="$1"; OUT="$2"; shift 2
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=".dd-mac/Build/Products/Debug/RunStartMacProbe.app"

if [ ! -d "$APP" ]; then
  xcodebuild build -project RunStartProbe.xcodeproj -scheme RunStartMacProbe -destination 'platform=macOS' \
    -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-mac-app.log 2>&1 \
    || { echo "build failed:"; tail -20 build-mac-app.log; exit 1; }
fi

rm -f "$OUT"
python3 -u stub.py 8766 "$OUT.log" > "$OUT.log.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8766/api/sessions && break; sleep 1; done

"$APP/Contents/MacOS/RunStartMacProbe" -orbit.instance http://127.0.0.1:8766 -probe.fresh \
  -shell.sidebarVisible NO -ApplePersistenceIgnoreState YES \
  -probe.render "$OUT" -probe.shot "$OUT.window.png" "$@" > "$OUT.app.log" 2>&1 &
APP_PID=$!
for i in $(seq 1 90); do [ -s "$OUT" ] && break; sleep 1; done
sleep 1
kill $APP_PID 2>/dev/null
echo "wrote $OUT ($(stat -f%z "$OUT" 2>/dev/null) bytes)"
