#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the real
# shared sources, and let LandingLivenessShotTests photograph the Work overview's Landing card head
# once per §7.2 V6 reading: LIVE, SILENT, LEGACY, Timed out, and a server without the new fields.
#
# Run from a copy of this directory placed at the repository root (project.yml's `../src` paths are
# relative to the repo), as the source-refused probe's harness is staged by client.yml.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/sessions; then
    echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"
    break
  fi
  sleep 1
done

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
xcrun simctl status_bar "$IPHONE_UDID" override --time "15:12" --batteryState charged --batteryLevel 100 2>/dev/null || true

TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project LandingLivenessProbe.xcodeproj \
  -scheme LandingLivenessProbe -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios \
  -resultBundlePath results/ios.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  > build-ios.log 2>&1
STATUS=$?
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -60 || true
cp build-ios.log "$OUT/xcodebuild-ios.log" 2>/dev/null || true
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/attachments" \
  > /dev/null 2>&1 || true
python3 - "$OUT" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        if a["exportedFileName"].endswith(".png") and not os.path.exists(os.path.join(out, name + ".png")):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
grep -E "^[0-9:]+ NOT SERVED" "$OUT/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn \
  > "$OUT/not-served.txt" || true
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
ls -la "$OUT"
exit "$STATUS"
