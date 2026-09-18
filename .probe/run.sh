#!/usr/bin/env bash
# Build the probe once, then launch it per configuration and screenshot each one.
# Run from the directory holding project.yml.
set -euo pipefail

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
BUNDLE=io.orbitd.probe
OUT="${OUT:-$PWD/shots}"
mkdir -p "$OUT"

# An iPad simulator, whatever this machine has. Landscape is where the three columns exist at all.
DEV=$(xcrun simctl list devices available -j \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)["devices"]
best=None
for rt,ds in d.items():
    for x in ds:
        if "iPad" in x["name"] and x["isAvailable"]:
            # prefer the biggest iPad we can find
            score = (("13" in x["name"]) * 3) + (("12.9" in x["name"]) * 3) + (("Pro" in x["name"]) * 2)
            if best is None or score > best[0]: best = (score, x["udid"], x["name"])
print(best[1] if best else "", best[2] if best else "", sep="\t")')
UDID=$(echo "$DEV" | cut -f1)
NAME=$(echo "$DEV" | cut -f2)
if [ -z "$UDID" ]; then
  # A CI image may ship runtimes without any iPad device. Create one from whatever iOS runtime
  # is installed; the device type name differs between Xcode versions, so try a few.
  RT=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys
r=[x["identifier"] for x in json.load(sys.stdin)["runtimes"] if x["isAvailable"] and "iOS" in x["identifier"]]
print(r[-1] if r else "")')
  [ -n "$RT" ] || { echo "no iOS runtime at all"; exit 1; }
  for DT in "iPad Pro 13-inch (M4)" "iPad Pro (12.9-inch) (6th generation)" "iPad Pro 11-inch (M4)" "iPad Air 11-inch (M2)" "iPad (10th generation)"; do
    if UDID=$(xcrun simctl create "probe-ipad" "$DT" "$RT" 2>/dev/null); then NAME="$DT (created)"; break; fi
    UDID=""
  done
  [ -n "$UDID" ] || { echo "could not create an iPad simulator"; exit 1; }
fi
echo "==> device: $NAME ($UDID)"

echo "==> generating + building"
xcodegen generate >/dev/null
xcodebuild -project Probe.xcodeproj -scheme Probe -sdk iphonesimulator \
  -destination "id=$UDID" -derivedDataPath .dd build >/dev/null
APP=$(find .dd/Build/Products -name 'Probe.app' -maxdepth 3 | head -1)
[ -n "$APP" ] || { echo "build produced no app"; exit 1; }

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# Landscape: a portrait iPad collapses the split and the whole question disappears.
xcrun simctl status_bar "$UDID" override --time "9:41" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

shot () { # name, then launch args
  local label="$1"; shift
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" "$@" >/dev/null
  sleep 3
  xcrun simctl io "$UDID" screenshot "$OUT/$label.png" >/dev/null 2>&1
  echo "  shot: $label.png   ($*)"
}

echo "==> capturing configurations"
# 1-3: today's widths, one per style — does the style alone change what the columns get?
shot 01-automatic-min320       -style automatic       -contentMin 320 -visibility all
shot 02-balanced-min320        -style balanced        -contentMin 320 -visibility all
shot 03-prominent-min320       -style prominentDetail -contentMin 320 -visibility all
# 4-6: raise the content column's *min* (a hard floor, unlike ideal) under each style.
shot 04-automatic-min400       -style automatic       -contentMin 400 -contentIdeal 440 -contentMax 520 -visibility all
shot 05-balanced-min400        -style balanced        -contentMin 400 -contentIdeal 440 -contentMax 520 -visibility all
shot 06-prominent-min400       -style prominentDetail -contentMin 400 -contentIdeal 440 -contentMax 520 -visibility all
# 7: sidebar collapsed — the state the app now starts in.
shot 07-automatic-min400-double -style automatic      -contentMin 400 -contentIdeal 440 -contentMax 520 -visibility doubleColumn
# 8: does widening the sidebar's floor actually take effect? (main asks 260, gets 222)
shot 08-balanced-sidebar320    -style balanced        -sidebarMin 320 -sidebarIdeal 320 -sidebarMax 360 \
                               -contentMin 400 -contentIdeal 440 -contentMax 520 -visibility all

echo "==> done. shots in $OUT"
ls -1 "$OUT"
