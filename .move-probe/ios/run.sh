#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Serve the fixture API, build the real session list into
# a throwaway iPhone app, and let a UI test photograph its Move on the newest simulator.
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
DEV=$(xcrun simctl list devices available -j \
  | python3 -c 'import json,sys,re
d=json.load(sys.stdin)["devices"]
def ver(rt):
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
best=None
for rt,ds in d.items():
    for x in ds:
        if "iPhone" not in x["name"] or not x["isAvailable"]: continue
        score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2) - (("Max" in x["name"]) * 1)
        key = (ver(rt), score)
        if best is None or key > best[0]: best = (key, x["udid"], x["name"], rt)
print(*best[1:], sep="\t") if best else print("")')
UDID=$(echo "$DEV" | cut -f1)
echo "==> device: $(echo "$DEV" | cut -f2)  runtime: $(echo "$DEV" | cut -f3)"
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }

xcodegen generate >/dev/null
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$UDID" override --time "10:04" --batteryState charged --batteryLevel 100 \
  2>/dev/null || true

echo "==> building and testing"
STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project MoveProbe.xcodeproj -scheme MoveProbe \
  -destination "id=$UDID" -derivedDataPath .dd -resultBundlePath results/MoveProbe.xcresult \
  > build.log 2>&1 || STATUS=$?
grep -E "Test Case|Executed|error:|failed|passed" build.log | tail -40 || true
if [ "$STATUS" -ne 0 ]; then
  echo "==> xcodebuild exited $STATUS; last 120 lines:"
  tail -120 build.log
fi
cp build.log "$OUT/xcodebuild.log"
echo "==> requests the app made:"
cat "$OUT/requests.log" || true
echo "==> shots:"
ls -la "$OUT" || true
ls "$OUT"/*.png >/dev/null 2>&1 || { echo "no pictures were taken"; exit 1; }
exit "$STATUS"
