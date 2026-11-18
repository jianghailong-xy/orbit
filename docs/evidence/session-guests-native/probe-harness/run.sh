#!/usr/bin/env bash
# Evidence probe (see ../README.md). Serve stub.py, build the iPhone and Mac probe apps from the real
# shared sources, then:
#   iPhone — GuestShotTests drives the app per scene and keeps a picture of each (xcresult attachments),
#            the last one pressing the real composer's Send;
#   Mac    — the app is launched per scene and writes its own window's image (`-probe.shot`).
# Run it from a copy of this directory placed at the repository root.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1
STATUS=0

serve() {  # $1 = log file
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    curl -fs -o /dev/null http://127.0.0.1:8765/api/guest-sessions && { echo "==> stub ready"; return 0; }
    sleep 1
  done
  echo "==> stub never answered"; cat "$1.out"; exit 1
}
STUB_PID=""

# --- Mac ---------------------------------------------------------------------------------------
echo "==> build mac"
xcodebuild build -project GuestProbe.xcodeproj -scheme GuestMacProbe -destination 'platform=macOS' \
  -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-mac.log 2>&1 || STATUS=1
grep -E "error:|\*\* BUILD" build-mac.log | tail -40 || true
cp build-mac.log "$OUT/mac/xcodebuild-mac.log"
APP=".dd-mac/Build/Products/Debug/GuestMacProbe.app/Contents/MacOS/GuestMacProbe"
if [ -x "$APP" ]; then
  serve "$OUT/mac/requests.log"
  for scene in running waiting ended gone sent; do
    curl -fs -X POST -o /dev/null http://127.0.0.1:8765/__reset
    extra=()
    [ "$scene" = sent ] && extra=(-probe.scene running -probe.send "Please also add a test for the logout redirect.")
    [ "$scene" != sent ] && extra=(-probe.scene "$scene")
    "$APP" -orbit.instance http://127.0.0.1:8765 -probe.fresh -ApplePersistenceIgnoreState YES \
      -shell.sidebarVisible YES "${extra[@]}" -probe.shot "$OUT/mac/mac-$scene.png" > "$OUT/mac/app-$scene.log" 2>&1 &
    PID=$!
    sleep 40
    kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    ls -la "$OUT/mac/mac-$scene.png" 2>/dev/null || { echo "no picture for $scene"; STATUS=1; }
  done
fi

# --- iPhone ------------------------------------------------------------------------------------
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
xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
serve "$OUT/ios/requests.log"
xcodebuild test -project GuestProbe.xcodeproj -scheme GuestProbe -destination "id=$IPHONE_UDID" \
  -derivedDataPath .dd-ios -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST|never showed" build-ios.log | tail -80 || true
cp build-ios.log "$OUT/ios/xcodebuild-ios.log"
mkdir -p "$OUT/ios/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/ios/attachments" >/dev/null 2>&1 || true
python3 - "$OUT/ios" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        if a["exportedFileName"].endswith(".png"):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
kill "$STUB_PID" 2>/dev/null || true
for p in ios mac; do
  grep -E "POST|BODY" "$OUT/$p/requests.log" > "$OUT/$p/writes.txt" 2>/dev/null || true
  grep -E "NOT SERVED" "$OUT/$p/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" 2>/dev/null || true
done
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
ls -la "$OUT/ios" "$OUT/mac"
exit "$STATUS"
