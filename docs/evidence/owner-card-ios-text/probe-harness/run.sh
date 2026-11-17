#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the tree's own shell and
# shared sources, and let OwnerCardTextShotTests drive and photograph it. Adapted from
# docs/evidence/coordinator-delivery-line/probe-harness/run.sh, iPhone only (D3 = A: iOS first).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" results
xcodegen generate >/dev/null || exit 1

serve() {
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"; return 0
    fi
    sleep 1
  done
  echo "==> stub never answered"; cat "$1.out"; exit 1
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
echo "==> iPhone $IPHONE_UDID: $(xcrun simctl list devices | grep "$IPHONE_UDID" | sed -E 's/^ +//')"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "$(TZ=Asia/Shanghai date +%-I:%M)" \
  --batteryState charged --batteryLevel 100 2>/dev/null || true

serve "$OUT/ios/requests.log"
STATUS=0
SHOTS_DIR="$OUT/ios" TEST_RUNNER_SHOTS_DIR="$OUT/ios" xcodebuild test -project OcitProbe.xcodeproj -scheme OcitProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -80 || true
# What "Copy command" put on the simulator's pasteboard, read host-side (the UI-test runner may not).
xcrun simctl pbpaste "$IPHONE_UDID" > "$OUT/ios/pasteboard-after-tests.txt" 2>&1 || true
echo "==> pasteboard: $(cat "$OUT/ios/pasteboard-after-tests.txt")"
cp build-ios.log "$OUT/ios/xcodebuild-ios.log"
grep -E "SwiftCompile .*(WhoFixesItCard|ApprovalCards|ConsoleView|ConsoleModel|OwnerCardPhoneText)\.swift" build-ios.log \
  | sed -E 's#/Users/runner/work/[^ ]*/src/#src/#g' | sort -u > "$OUT/ios/compiled-ios.txt" || true
mkdir -p "$OUT/ios/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/ios/attachments" >/dev/null 2>&1 || true
kill "$STUB_PID" 2>/dev/null || true
grep -E '" 404 ' "$OUT/ios/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/ios/not-served.txt" || true
grep -E "POST|PATCH|DELETE|body:" "$OUT/ios/requests.log" > "$OUT/ios/writes.txt" || true
ls -la "$OUT/ios"
exit "$STATUS"
