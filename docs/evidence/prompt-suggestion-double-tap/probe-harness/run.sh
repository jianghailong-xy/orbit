#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the real shell
# and shared sources, and let DoubleTapTests drive and photograph it. requests.log is what the app sent.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/ios/requests.log" > "$OUT/ios/stub.out" 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then echo "==> stub ready after ${i}s"; break; fi
  sleep 1
done
curl -fs -o /dev/null http://127.0.0.1:8765/api/agents || { echo "==> stub never answered"; cat "$OUT/ios/stub.out"; exit 1; }

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
xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true

STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT/ios" xcodebuild test -project DTapProbe.xcodeproj -scheme DTapProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -80 || true
cp build-ios.log "$OUT/ios/xcodebuild-ios.log"
# A runner whose test process could not write the pictures still keeps them as attachments.
mkdir -p "$OUT/ios/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/ios/attachments" > /dev/null 2>&1 || true
python3 - "$OUT/ios" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        if a["exportedFileName"].endswith(".png") and not os.path.exists(os.path.join(out, name + ".png")):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
kill "$STUB_PID" 2>/dev/null || true
grep -E '" 404 ' "$OUT/ios/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "$OUT/ios/not-served.txt" || true
ls -la "$OUT/ios"
exit "$STATUS"
