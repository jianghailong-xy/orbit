#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the real
# shared sources, and let SwipeBackTests swipe back on an iPhone simulator.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
ready=0
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then ready=1; echo "==> stub ready after ${i}s"; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "==> stub never answered"; cat "$OUT/stub.out"; exit 1; fi

IPHONE_UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPhone" in x["name"]:
            k=(v,("Pro" in x["name"])*2-("Max" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"],rt)
print(best[1] if best else "")
print(best[2], best[3], file=sys.stderr)')
echo "==> iPhone $IPHONE_UDID"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true

STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project SwipeProbe.xcodeproj -scheme SwipeProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -80 || true
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/attachments" \
  > /dev/null 2>&1 || true
kill "$STUB_PID" 2>/dev/null || true
grep -E '" 404 ' "$OUT/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
ls -la "$OUT"
exit "$STATUS"
