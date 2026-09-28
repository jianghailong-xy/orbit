#!/usr/bin/env bash
# TEMPORARY (shots branch only). Build the probe once, launch it per frame, screenshot each one.
# Run from the directory holding project.yml.
set -euo pipefail

export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
BUNDLE=io.orbitd.probe
OUT="${OUT:-$PWD/shots}"
# The commit the phone in the owner's screenshot is running (NeedsYouBannerView unchanged since
# 6448102fa, 2026-09-23): the "shipped" half is that commit's file.
BASE=24bf82b64175b7e98281241b9c0dfba80f997486
rm -rf "$OUT"
mkdir -p "$OUT"

# Both bars are the app's own file: a copy that had drifted would make this a picture of the copy.
APP=../src/macos/OrbitApp/Sources/OrbitApp
cp "$APP/Views/NeedsYouBannerView.swift" "$APP/Views/Typography.swift" "$APP/Platform.swift" Sources/
git fetch --no-tags --quiet --depth=1 origin "$BASE"
git show "$BASE:src/macos/OrbitApp/Sources/OrbitApp/Views/NeedsYouBannerView.swift" \
  | sed -e 's/NeedsYouBannerView/NeedsYouBannerViewShipped/g' -e 's/needsYouTint/needsYouTintShipped/g' \
  > Sources/NeedsYouBannerViewShipped.swift
echo "==> copied in:"
for f in NeedsYouBannerView NeedsYouBannerViewShipped Typography Platform; do
  echo "    $(shasum -a 256 "Sources/$f.swift" | cut -c1-16)  Sources/$f.swift"
done
echo "==> the two bars differ by:"
diff <(sed -e 's/NeedsYouBannerViewShipped/NeedsYouBannerView/g' -e 's/needsYouTintShipped/needsYouTint/g' \
         Sources/NeedsYouBannerViewShipped.swift) Sources/NeedsYouBannerView.swift || true

xcrun simctl list runtimes
# The newest iOS runtime first (iOS 26 draws the glass nav bar the owner's phone has; an older one
# draws a different bar), then a recent Pro within it.
DEV=$(xcrun simctl list devices available -j | python3 -c 'import json,re,sys
d=json.load(sys.stdin)["devices"]
best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)", rt)
    if not m: continue
    ver=(int(m.group(1)), int(m.group(2)))
    for x in ds:
        if "iPhone" not in x["name"] or not x.get("isAvailable", True): continue
        score=(ver, ("17 Pro" in x["name"])*3 + ("16 Pro" in x["name"])*2 + ("Pro" in x["name"]))
        if best is None or score > best[0]: best=(score, x["udid"], x["name"], rt)
print(best[1], best[2], best[3], sep="\t") if best else print("")')
UDID=$(echo "$DEV" | cut -f1)
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }
echo "==> device: $(echo "$DEV" | cut -f2) on $(echo "$DEV" | cut -f3) ($UDID)"

echo "==> generating + building"
xcodegen generate >/dev/null
if ! xcodebuild -project Probe.xcodeproj -scheme Probe -sdk iphonesimulator \
     -destination "id=$UDID" -derivedDataPath .dd build > build.log 2>&1; then
  echo "==> build failed; last 80 lines:"
  tail -80 build.log
  exit 1
fi
BIN=$(find .dd/Build/Products -name 'Probe.app' -maxdepth 3 | head -1)
[ -n "$BIN" ] || { echo "build produced no app"; exit 1; }

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The owner's screenshot reads 12:42; matching it keeps the panels comparable side by side.
xcrun simctl status_bar "$UDID" override --time "12:42" --batteryState charged --batteryLevel 100 \
  2>/dev/null || true
xcrun simctl install "$UDID" "$BIN"

shot () { # frame name
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" -shot "$1" >/dev/null
  sleep 4
  xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1
  echo "  shot: $1.png"
}

echo "==> capturing"
for f in console-shipped console-new console-shipped-dark console-new-dark list-shipped list-new; do
  shot "$f"
done
echo "==> done. shots in $OUT"
ls -1 "$OUT"
