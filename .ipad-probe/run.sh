#!/usr/bin/env bash
# TEMPORARY evidence probe (see README.md). Serve stub.py, build the iOS shells into a throwaway app
# from the tree's own shared sources, and let EdgeSwipeTests photograph the newest, largest iPad.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true' EXIT
ready=0
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then ready=1; echo "==> stub ready after ${i}s"; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "==> stub never answered"; cat "$OUT/stub.out"; exit 1; fi

echo "==> runtimes:"
xcrun simctl list runtimes | grep -i ios || true
# The newest runtime's largest iPad: the three columns need the width.
IPAD=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if not x["isAvailable"] or "iPad" not in x["name"]: continue
        score=("13-inch" in x["name"])*4+("12.9" in x["name"])*3+("Pro" in x["name"])*2
        k=(v,score)
        if best is None or k>best[0]: best=(k,x["udid"],x["name"],rt)
print("\t".join(best[1:]) if best else "")')
IPAD_UDID=$(echo "$IPAD" | cut -f1)
echo "==> iPad: $(echo "$IPAD" | cut -f2)  runtime: $(echo "$IPAD" | cut -f3)"
[ -n "$IPAD_UDID" ] || { echo "no iPad simulator"; exit 1; }
echo "$IPAD" > "$OUT/device.txt"
xcrun simctl boot "$IPAD_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPAD_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPAD_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true

STATUS=0
SHOTS_DIR="$OUT" TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project IpadProbe.xcodeproj -scheme IpadProbe \
  -destination "id=$IPAD_UDID" -derivedDataPath .dd -resultBundlePath results/ipad.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ipad.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST|\*\* BUILD" build-ipad.log | tail -80 || true
cp build-ipad.log "$OUT/xcodebuild-ipad.log"
# A test process that could not write the pictures still keeps them as attachments.
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/ipad.xcresult --output-path "$OUT/attachments" \
  > /dev/null 2>&1 || true
python3 - "$OUT" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        target = os.path.join(out, name if ext == ".txt" else name + ext)
        if ext in (".png", ".txt") and not os.path.exists(target):
            shutil.copy(os.path.join(base, a["exportedFileName"]), target)
PY
grep -E '" 404 ' "$OUT/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
ls -la "$OUT"
exit "$STATUS"
