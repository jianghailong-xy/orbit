#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): build the iPhone and Mac probe apps from the real shared
# sources, serve stub.py once per variant, and photograph the owner exception card:
#
#   mac-a.png / iphone-a.png   (a) unreachable — WORKSPACE_DISABLED, workspace "mac-mini"
#   mac-b.png / iphone-b.png   (b) reachable — ESCALATED
#   iphone-*-bottom.png        the same phone screen scrolled to the card's end
#
# Run it from a copy of this directory placed at the repository root (project.yml's `../src` paths
# are relative to the repo). Shots, build logs, request logs and the apps' own logs land in $OUT.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT"
mkdir -p "$OUT"
STATUS=0

xcodegen generate > "$OUT/xcodegen.log" 2>&1 || { cat "$OUT/xcodegen.log"; exit 1; }

STUB_PID=""
serve() {  # $1 port, $2 variant, $3 log
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py "$1" "$3" "$2" > "$3.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null "http://127.0.0.1:$1/api/sessions"; then
      echo "==> stub ($2) ready on :$1 after ${i}s"; return 0
    fi
    sleep 1
  done
  echo "==> stub never answered on :$1"; cat "$3.out"; exit 1
}
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null' EXIT

# ── Mac ──────────────────────────────────────────────────────────────────────────────────────────
echo "==> build Mac"
MAC_APP=".dd-mac/Build/Products/Debug/WhoFixesMacProbe.app"
xcodebuild build -project WhoFixesProbe.xcodeproj -scheme WhoFixesMacProbe -destination 'platform=macOS' \
  -derivedDataPath .dd-mac CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "$OUT/build-mac.log" 2>&1 || STATUS=1
grep -E "error:|\*\* BUILD" "$OUT/build-mac.log" | tail -40 || true

if [ -d "$MAC_APP" ]; then
  for v in p p-retry; do
    serve 8765 p "$OUT/requests-mac-$v.log"
    shot="$OUT/mac-$v.png"
    retry=""; [ "$v" = p-retry ] && retry="-probe.retry"
    "$MAC_APP/Contents/MacOS/WhoFixesMacProbe" -orbit.instance http://127.0.0.1:8765 -probe.fresh $retry \
      -ApplePersistenceIgnoreState YES -probe.shot "$shot" -probe.log "$OUT/app-mac-$v.log" \
      > "$OUT/stdout-mac-$v.log" 2>&1 &
    APP_PID=$!
    # The app quits on its own once it has written the shot (~35s); kill it if it has not.
    for i in $(seq 1 90); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
    kill "$APP_PID" 2>/dev/null || true
    if [ -s "$shot" ]; then echo "==> wrote $shot ($(stat -f%z "$shot") bytes)"; else echo "==> NO $shot"; STATUS=1; fi
  done
else
  echo "==> no Mac app built"; STATUS=1
fi

# ── iPhone ───────────────────────────────────────────────────────────────────────────────────────
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

echo "==> build iPhone"
IOS_APP=".dd-ios/Build/Products/Debug-iphonesimulator/WhoFixesProbe.app"
BUNDLE=io.orbitd.whofixesprobe
xcodebuild build -project WhoFixesProbe.xcodeproj -scheme WhoFixesProbe -destination "id=$IPHONE_UDID" \
  -derivedDataPath .dd-ios CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "$OUT/build-ios.log" 2>&1 || STATUS=1
grep -E "error:|\*\* BUILD" "$OUT/build-ios.log" | tail -40 || true

if [ -d "$IOS_APP" ]; then
  for v in p p-retry; do
    serve 8766 p "$OUT/requests-ios-$v.log"
    retry=""; [ "$v" = p-retry ] && retry="-probe.retry"
    for part in top bottom; do
      name="iphone-$v"; extra="-probe.top"
      if [ "$part" = bottom ]; then name="iphone-$v-bottom"; extra="-probe.bottom"; fi
      xcrun simctl terminate "$IPHONE_UDID" "$BUNDLE" 2>/dev/null
      xcrun simctl uninstall "$IPHONE_UDID" "$BUNDLE" 2>/dev/null
      xcrun simctl install "$IPHONE_UDID" "$IOS_APP"
      xcrun simctl launch "$IPHONE_UDID" "$BUNDLE" -orbit.instance http://127.0.0.1:8766 -probe.fresh $retry \
        "$extra" > /dev/null
      # The console reads the stub, then the card reads the coordinator status and the workspace.
      sleep 25
      xcrun simctl io "$IPHONE_UDID" screenshot "$OUT/$name.png" > /dev/null 2>&1 || STATUS=1
      if [ -s "$OUT/$name.png" ]; then echo "==> wrote $name.png"; else echo "==> NO $name.png"; STATUS=1; fi
    done
  done
  xcrun simctl terminate "$IPHONE_UDID" "$BUNDLE" 2>/dev/null
else
  echo "==> no iPhone app built"; STATUS=1
fi

for f in "$OUT"/requests-*.log; do
  [ -f "$f" ] || continue
  grep -E "NOT SERVED" "$f" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "${f%.log}-not-served.txt" || true
done
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
ls -la "$OUT"
exit "$STATUS"
