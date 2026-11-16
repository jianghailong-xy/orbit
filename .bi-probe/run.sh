#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): build BilingualProbe for the iPhone simulator, launch it on
# each case and take the simulator's own screenshot. Run from a copy placed at the repository root.
set -euo pipefail
cd "$(dirname "$0")"
cp ../src/shared/src/bilingual-pairs.fixture.json .
mkdir -p shots
xcodegen generate
UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and re.fullmatch(r"iPhone \d+ Pro", x["name"]):
            if best is None or v>best[0]: best=(v,x["udid"],x["name"])
print(best[1])')
echo "==> iPhone $UDID"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 || true
xcodebuild build -project BilingualProbe.xcodeproj -scheme BilingualProbe -destination "id=$UDID" \
  -derivedDataPath .dd CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > shots/xcodebuild.log 2>&1 || { tail -80 shots/xcodebuild.log; exit 1; }
APP=$(find .dd/Build/Products -name BilingualProbe.app -maxdepth 3 | head -1)
xcrun simctl install "$UDID" "$APP"
for c in "headings" "merged two paragraphs" "code blocks" "nested lists"; do
  slug=$(echo "$c" | tr ' ' '-')
  xcrun simctl terminate "$UDID" io.orbitd.bilingualprobe 2>/dev/null || true
  xcrun simctl launch "$UDID" io.orbitd.bilingualprobe -probe.case "$c"
  sleep 6
  xcrun simctl io "$UDID" screenshot "shots/iphone-$slug.png"
done
ls -la shots
