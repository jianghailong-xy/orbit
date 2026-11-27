#!/usr/bin/env bash
# TEMPORARY evidence probe: Mac pictures at a given window width, rendered by the probe app itself (ProbeArgs.capture),
# so a window wider than the screen (a CI runner's is 1024 × 768) is photographed whole. Each launch selects Nightly
# dependency audit (its inspector), presses the chat's button in code and writes one PNG. Needs a logged-in screen to
# draw a window at all. OUT defaults to shots/mac-widths.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots/mac-widths}"
mkdir -p "$OUT"
APP=$(find .dd-SchedChatMacProbe .dd-mac-direct -name 'SchedChatMacProbe.app' -type d 2>/dev/null | head -1)
if [ -z "$APP" ]; then
  xcodegen generate >/dev/null || exit 1
  xcodebuild build -project SchedChatProbe.xcodeproj -scheme SchedChatMacProbe -destination platform=macOS \
    -derivedDataPath .dd-mac-direct CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; exit 1; }
  APP=$(find .dd-mac-direct -name 'SchedChatMacProbe.app' -type d | head -1)
fi
python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null; pkill -x SchedChatMacProbe 2>/dev/null' EXIT
sleep 2
STATUS=0
for width in 1010 1460; do
  png="$OUT/mac-width-$width-chat-open.png"
  rm -f "$png"
  "$APP/Contents/MacOS/SchedChatMacProbe" -orbit.instance http://127.0.0.1:8765 -ApplePersistenceIgnoreState YES \
    -probe.fresh YES -probe.inspect sch2 -probe.chat YES -probe.capture "$png" -probe.windowWidth "$width" \
    > "$OUT/app-$width.log" 2>&1 &
  app=$!
  for _ in $(seq 1 60); do [ -s "$png" ] && break; sleep 1; done
  kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
  if [ -s "$png" ]; then
    for f in "$png" "${png%.png}-window.png"; do
      [ -s "$f" ] && echo "$width: $(basename "$f") $(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read(24);print('%dx%d px'%struct.unpack('>II',d[16:24]))" "$f")"
    done
  else
    echo "$width: no picture"; STATUS=1
  fi
done
exit $STATUS
