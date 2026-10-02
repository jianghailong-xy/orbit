#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Serve the fixture API, build the real session list
# into a throwaway app, and let UI tests photograph it on the newest simulators — the phone for the
# swipe, the Move panel and the folder rows and page, an iPad for the three-column shape.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results

echo "==> fixture API on 127.0.0.1:8765"
python3 stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
curl -fsS --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8765/api/agents
echo

echo "==> runtimes available:"
xcrun simctl list runtimes | grep -i ios || true

# The newest runtime's best device of a family: a plain iPhone/iPad is fine, a Pro is preferred for
# the phone, and the largest screen for the tablet (the three columns need the width).
pick_device() {
  xcrun simctl list devices available -j | python3 -c '
import json,sys,re
family = sys.argv[1]
d = json.load(sys.stdin)["devices"]
def ver(rt):
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
best = None
for rt, ds in d.items():
    for x in ds:
        if not x["isAvailable"] or family not in x["name"]:
            continue
        if family == "iPhone":
            score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2) - (("Max" in x["name"]) * 1)
        else:
            score = (("Pro" in x["name"]) * 2) + (("13-inch" in x["name"]) * 3) + (("12.9" in x["name"]) * 2)
        key = (ver(rt), score)
        if best is None or key > best[0]:
            best = (key, x["udid"], x["name"], rt)
print(*best[1:], sep="\t") if best else print("")' "$1"
}

IPHONE=$(pick_device iPhone)
IPAD=$(pick_device iPad)
IPHONE_UDID=$(echo "$IPHONE" | cut -f1)
IPAD_UDID=$(echo "$IPAD" | cut -f1)
echo "==> iPhone: $(echo "$IPHONE" | cut -f2)  runtime: $(echo "$IPHONE" | cut -f3)"
echo "==> iPad:   $(echo "$IPAD" | cut -f2)  runtime: $(echo "$IPAD" | cut -f3)"
[ -n "$IPHONE_UDID" ] || { echo "no iPhone simulator"; exit 1; }
[ -n "$IPAD_UDID" ] || { echo "no iPad simulator"; exit 1; }

xcodegen generate >/dev/null
for UDID in "$IPHONE_UDID" "$IPAD_UDID"; do
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
  xcrun simctl status_bar "$UDID" override --time "10:04" --batteryState charged --batteryLevel 100 \
    2>/dev/null || true
  # The first keyboard a fresh simulator shows is covered by the slide-to-type tip; mark it seen (the
  # UI tests also tap its Continue if it still comes up).
  for domain in com.apple.Preferences com.apple.keyboard.preferences; do
    xcrun simctl spawn "$UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
  done
done

STATUS=0
run_pass() {  # $1 = label, $2 = device udid, $3... = -only-testing arguments
  local label=$1 udid=$2; shift 2
  echo "==> $label"
  TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project MoveProbe.xcodeproj -scheme MoveProbe \
    -destination "id=$udid" -derivedDataPath .dd \
    -resultBundlePath "results/$label.xcresult" "$@" \
    > "build-$label.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|failed|passed" "build-$label.log" | tail -60 || true
  if [ -s "build-$label.log" ] && grep -qE "error:|Testing failed" "build-$label.log"; then
    echo "==> $label: last 120 lines"
    tail -120 "build-$label.log"
  fi
  cp "build-$label.log" "$OUT/xcodebuild-$label.log"
}

run_pass iphone "$IPHONE_UDID" \
  -only-testing:MoveProbeUITests/MoveShotTests \
  -only-testing:MoveProbeUITests/FolderShotTests
run_pass ipad "$IPAD_UDID" \
  -only-testing:MoveProbeUITests/FolderIPadShotTests

echo "==> requests the app made:"
cat "$OUT/requests.log" || true
echo "==> shots:"
ls -la "$OUT" || true
ls "$OUT"/*.png >/dev/null 2>&1 || { echo "no pictures were taken"; exit 1; }
exit "$STATUS"
