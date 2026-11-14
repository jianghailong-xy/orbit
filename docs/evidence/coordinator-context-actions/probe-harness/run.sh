#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Builds the probe app for the Mac and an iPhone simulator
# from the real shared sources (staged into ./Shared with ContextWindowDetailPresentation and
# CoordinatorHandoffConfirmPresentation made visible to Probe.swift — no other change), launches
# it once per screen and photographs it: the Mac by `screencapture` of the window's region (the
# popover and the dialog are windows of their own, so a region rather than a window shot), the
# iPhone by `simctl io screenshot`. Run from a copy of this directory at the repository root.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" Shared
mkdir -p "$OUT/mac" "$OUT/ios"
cp -R ../src/macos/OrbitApp/Sources/OrbitApp Shared
sed -i '' \
  -e 's/^private struct ContextWindowDetailPresentation/struct ContextWindowDetailPresentation/' \
  -e 's/^private struct CoordinatorHandoffConfirmPresentation/struct CoordinatorHandoffConfirmPresentation/' \
  -e 's/@Environment(\\.horizontalSizeClass) private var horizontalSizeClass/@Environment(\\.horizontalSizeClass) var horizontalSizeClass/' \
  Shared/Views/ComposerView.swift
grep -n "^struct ContextWindowDetailPresentation\|^struct CoordinatorHandoffConfirmPresentation" Shared/Views/ComposerView.swift
xcodegen generate >/dev/null || exit 1
STATUS=0

MAC_SHOTS="panelCoordinator panelRunning panelOrdinary confirm writing handingOver successor completed failed failedReplace"
IOS_SHOTS="$MAC_SHOTS"

echo "==> build mac"
xcodebuild build -project CCXProbe.xcodeproj -scheme CCXMacProbe -destination 'platform=macOS' \
  -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-mac.log 2>&1 \
  || { echo "mac build failed"; grep -E "error:" build-mac.log | head -40; STATUS=1; }
MAC_APP=".dd-mac/Build/Products/Debug/CCXMacProbe.app"
if [ -d "$MAC_APP" ]; then
  for shot in $MAC_SHOTS; do
    "$MAC_APP/Contents/MacOS/CCXMacProbe" -shot "$shot" -ApplePersistenceIgnoreState YES > "$OUT/mac/$shot.log" 2>&1 &
    PID=$!
    sleep 5
    # The window is put at (60, 60) and is 620×560 plus its title bar; a popover above or a sheet
    # below it stays inside this region.
    screencapture -x -R20,20,720,700 "$OUT/mac/$shot.png" || STATUS=1
    kill $PID 2>/dev/null; wait $PID 2>/dev/null
    echo "mac $shot: $(stat -f%z "$OUT/mac/$shot.png" 2>/dev/null) bytes"
  done
fi

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and x["name"].startswith("iPhone") and "Pro" in x["name"] and "Max" not in x["name"]:
            if best is None or v>best[0]: best=(v,x["udid"],x["name"])
print(best[1] if best else "")')
echo "==> iPhone $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$UDID" override --time "15:42" --batteryState charged --batteryLevel 100 2>/dev/null || true
echo "==> build ios"
xcodebuild build -project CCXProbe.xcodeproj -scheme CCXProbe -destination "id=$UDID" \
  -derivedDataPath .dd-ios CODE_SIGNING_ALLOWED=NO > build-ios.log 2>&1 \
  || { echo "ios build failed"; grep -E "error:" build-ios.log | head -40; STATUS=1; }
IOS_APP=".dd-ios/Build/Products/Debug-iphonesimulator/CCXProbe.app"
if [ -d "$IOS_APP" ]; then
  xcrun simctl install "$UDID" "$IOS_APP"
  for shot in $IOS_SHOTS; do
    xcrun simctl terminate "$UDID" io.orbitd.ccxprobe 2>/dev/null
    xcrun simctl launch "$UDID" io.orbitd.ccxprobe -shot "$shot" > /dev/null
    sleep 6
    xcrun simctl io "$UDID" screenshot "$OUT/ios/$shot.png" >/dev/null 2>&1 || STATUS=1
    echo "ios $shot: $(stat -f%z "$OUT/ios/$shot.png" 2>/dev/null) bytes"
  done
fi
cp build-*.log "$OUT/" 2>/dev/null || true
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
exit "$STATUS"
