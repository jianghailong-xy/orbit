#!/usr/bin/env bash
# Build the probe once, then launch it per configuration and screenshot each one.
# Run from the directory holding project.yml.
set -euo pipefail

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
BUNDLE=io.orbitd.probe
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT"
mkdir -p "$OUT"

# The bar under test is the app's own file, copied in place: a copy that had drifted would make this
# a screenshot of the copy. Same for the type ramp and the platform shims it compiles against.
APP=../src/macos/OrbitApp/Sources/OrbitApp
cp "$APP/Views/NeedsYouBannerView.swift" "$APP/Views/Typography.swift" "$APP/Platform.swift" Sources/
echo "==> copied from the app:"
for f in NeedsYouBannerView Typography Platform; do
  echo "    $(shasum -a 256 "Sources/$f.swift" | cut -c1-16)  Sources/$f.swift"
done

# An iPhone, whatever this image has — prefer a recent Pro, then any iPhone.
DEV=$(xcrun simctl list devices available -j \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)["devices"]
best=None
for rt,ds in d.items():
    for x in ds:
        if "iPhone" not in x["name"] or not x["isAvailable"]: continue
        score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2)
        if best is None or score > best[0]: best = (score, x["udid"], x["name"])
print(best[1] if best else "", best[2] if best else "", sep="\t")')
UDID=$(echo "$DEV" | cut -f1)
NAME=$(echo "$DEV" | cut -f2)
if [ -z "$UDID" ]; then
  RT=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys
r=[x["identifier"] for x in json.load(sys.stdin)["runtimes"] if x["isAvailable"] and "iOS" in x["identifier"]]
print(r[-1] if r else "")')
  [ -n "$RT" ] || { echo "no iOS runtime at all"; exit 1; }
  for DT in "iPhone 17 Pro" "iPhone 16 Pro" "iPhone 15" "iPhone SE (3rd generation)"; do
    if UDID=$(xcrun simctl create "probe-iphone" "$DT" "$RT" 2>/dev/null); then NAME="$DT (created)"; break; fi
    UDID=""
  done
  [ -n "$UDID" ] || { echo "could not create an iPhone simulator"; exit 1; }
fi
echo "==> device: $NAME ($UDID)"

echo "==> generating + building"
xcodegen generate >/dev/null
# Keep the compiler's own words: a failed round that prints nothing but "BUILD FAILED" costs a
# whole Mac runner to re-learn.
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
# The effect image's phone reads 9:41 with a full battery; matching it keeps the two panels readable
# side by side.
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 \
  2>/dev/null || true
xcrun simctl install "$UDID" "$BIN"

shot () { # name, then launch args
  local label="$1"; shift
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" "$@" >/dev/null
  sleep 3
  xcrun simctl io "$UDID" screenshot "$OUT/$label.png" >/dev/null 2>&1
  echo "  shot: $label.png   ($*)"
}

echo "==> capturing"
shot 01-list          -shot list
shot 02-list-dark     -shot list-dark
shot 03-four          -shot four
shot 04-four-dark     -shot four-dark

echo "==> done. shots in $OUT"
ls -1 "$OUT"
