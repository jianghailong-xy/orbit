#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): build the probe app from the real shared sources, let
# BatchReviewShotTests drive and photograph it on the newest iPhone simulator, export the pictures.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/attachments" results
xcodegen generate >/dev/null || exit 1

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
xcrun simctl list devices | grep "$IPHONE_UDID" || true
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "8:40" --batteryState discharging --batteryLevel 41 \
  --cellularMode active --cellularBars 3 --dataNetwork 5g 2>/dev/null || true

STATUS=0
xcodebuild test -project BatchReviewProbe.xcodeproj -scheme BatchReviewProbe -destination "id=$IPHONE_UDID" \
  -derivedDataPath .dd -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST|\*\* BUILD" build-ios.log | tail -80 || true
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/attachments" \
  > /dev/null 2>&1 || true
python3 - "$OUT" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        dest = os.path.join(out, name if name.endswith(ext) else name + ext)
        if not os.path.exists(dest):
            shutil.copy(os.path.join(base, a["exportedFileName"]), dest)
PY
ls -la "$OUT"
exit "$STATUS"
