#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): the iPhone pictures, taken by installing the real app on
# a booted simulator, launching it at the stub and photographing the screen.
#
# The XCUITest pass drives the phone on CI (see run.sh). This script is the fallback for a host
# where the UI-test runner cannot take automation mode: the same probe app, the same stub, the same
# launch arguments, photographed with `simctl io … screenshot`. Nothing is pressed here.
#
# Usage: ios-shot.sh <session> <out.png> [extra launch args…]
set -uo pipefail
cd "$(dirname "$0")"
SESSION="$1"; OUT="$2"; shift 2
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=".dd-ios/Build/Products/Debug-iphonesimulator/RunStartProbe.app"
BUNDLE=io.orbitd.crossingsprobe

UDID=$(xcrun simctl list devices booted -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
for rt,ds in d.items():
    for x in ds:
        if "iPhone" in x["name"]: print(x["udid"]); raise SystemExit')
echo "==> simulator $UDID"

if [ ! -d "$APP" ]; then
  xcodebuild build -project RunStartProbe.xcodeproj -scheme RunStartProbe \
    -destination "id=$UDID" -derivedDataPath .dd-ios CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
    > build-ios-app.log 2>&1 || { echo "build failed:"; tail -20 build-ios-app.log; exit 1; }
fi

python3 -u stub.py 8767 "$OUT.log" > "$OUT.log.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8767/api/sessions && break; sleep 1; done

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE" -orbit.instance http://127.0.0.1:8767 -probe.fresh \
  -probe.session "$SESSION" "$@" > /dev/null
sleep 12
xcrun simctl io "$UDID" screenshot "$OUT"
echo "wrote $OUT ($(stat -f%z "$OUT" 2>/dev/null) bytes)"
