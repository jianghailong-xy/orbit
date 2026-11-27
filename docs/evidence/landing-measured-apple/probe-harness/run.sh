#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged; see README.md). Serve stub.py, build the iPhone probe app from
# the real shared sources, and let LandingMeasuredShotTests photograph the five screens of
# docs/mocks/landing-measured twice: the simulator in light appearance, then in dark. Each pass keeps
# its own stub log, so requests.log shows what that pass sent.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/light" "$OUT/dark" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/projects/P2/integration; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered; its output:"; cat "$1.out"
  exit 1
}

IPHONE_UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPhone" in x["name"]:
            k=(v,("Pro" in x["name"])*2-("Max" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"])
print(best[1] if best else "")')
echo "==> iPhone $IPHONE_UDID"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "11:42" --batteryState charged --batteryLevel 100 2>/dev/null || true
for domain in com.apple.Preferences com.apple.keyboard.preferences; do
  xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
done

STUB_PID=""
STATUS=0
for look in light dark; do
  echo "==> $look"
  xcrun simctl ui "$IPHONE_UDID" appearance "$look" || true
  serve "$OUT/$look/requests.log"
  TEST_RUNNER_SHOTS_DIR="$OUT/$look" TEST_RUNNER_SHOT_LOOK="$look" \
    xcodebuild test -project LandingMeasuredProbe.xcodeproj -scheme LandingMeasuredProbe \
    -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios -resultBundlePath "results/$look.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$look.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$look.log" | tail -80 || true
  cp "build-$look.log" "$OUT/$look/xcodebuild-$look.log"
  grep -E "BODY|NOT SERVED" "$OUT/$look/requests.log" > "$OUT/$look/writes.txt" || true
done
kill "$STUB_PID" 2>/dev/null || true
echo "status=$STATUS" > "$OUT/.done-probe"
ls -la "$OUT/light" "$OUT/dark"
exit "$STATUS"
