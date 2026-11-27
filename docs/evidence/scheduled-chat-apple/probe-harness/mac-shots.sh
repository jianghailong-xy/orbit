#!/usr/bin/env bash
# TEMPORARY evidence probe: Mac pictures without XCUITest. Builds the Mac probe app, serves stub.py, launches the app
# three times and photographs its window: (1) a row selected, chat not open (never opens by itself, first launch);
# (2) the chat opened by the button's own action beside the inspector; (3) relaunched with nothing pressed: open is
# remembered on the device. OUT defaults to shots/mac-direct.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots/mac-direct}"
mkdir -p "$OUT"
xcodegen generate >/dev/null || exit 1
xcodebuild build -project SchedChatProbe.xcodeproj -scheme SchedChatMacProbe -destination platform=macOS \
  -derivedDataPath .dd-mac-direct CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; exit 1; }
APP=$(find .dd-mac-direct -name 'SchedChatMacProbe.app' -type d | head -1)
python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null; pkill -x SchedChatMacProbe 2>/dev/null' EXIT
sleep 2
defaults delete io.orbitd.schedchatmacprobe 2>/dev/null || true

shoot() {  # $1 name, $2… app arguments
  local name=$1; shift
  pkill -x SchedChatMacProbe 2>/dev/null; sleep 1
  "$APP/Contents/MacOS/SchedChatMacProbe" -orbit.instance http://127.0.0.1:8765 -ApplePersistenceIgnoreState YES "$@" \
    > "$OUT/$name.app.log" 2>&1 &
  sleep 14
  osascript -e 'tell application "System Events" to set frontmost of (first process whose name is "SchedChatMacProbe") to true' 2>/dev/null
  sleep 1
  local wid
  wid=$(python3 - <<'PY'
import Quartz
for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):
    if w.get("kCGWindowOwnerName") == "SchedChatMacProbe" and w.get("kCGWindowLayer") == 0 and w["kCGWindowBounds"]["Width"] > 400:
        print(w["kCGWindowNumber"]); break
PY
)
  if [ -n "$wid" ]; then screencapture -o -l "$wid" "$OUT/$name.png"; else screencapture -x "$OUT/$name.png"; fi
  echo "$name: window ${wid:-none}"
}

shoot mac-1-row-selected-chat-closed -probe.fresh YES -probe.inspect sch2
shoot mac-2-third-column-beside-inspector -probe.inspect sch2 -probe.chat YES
shoot mac-3-relaunch-remembered-open -probe.inspect sch2
grep -c 'schedules/chat' "$OUT/requests.log" | sed 's/^/GET \/schedules\/chat reads: /'
ls -la "$OUT"
