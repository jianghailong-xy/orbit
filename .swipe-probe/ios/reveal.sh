#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Record the same slow drags on the system's swipe (Notes'
# shape and the session rows' capsules) and on the circles, and cut each recording into frames.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results

DEV=$(xcrun simctl list devices available -j \
  | python3 -c 'import json,sys,re
d=json.load(sys.stdin)["devices"]
def ver(rt):
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
best=None
for rt,ds in d.items():
    for x in ds:
        if "iPhone" not in x["name"] or not x["isAvailable"]: continue
        score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2) - (("Max" in x["name"]) * 1)
        key = (ver(rt), score)
        if best is None or key > best[0]: best = (key, x["udid"], x["name"], rt)
print(*best[1:], sep="\t") if best else print("")')
UDID=$(echo "$DEV" | cut -f1)
echo "==> device: $(echo "$DEV" | cut -f2)  runtime: $(echo "$DEV" | cut -f3)"
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }

xcodegen generate >/dev/null
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$UDID" override --time "11:42" --batteryState charged --batteryLevel 100 2>/dev/null || true
xcrun simctl ui "$UDID" appearance light 2>/dev/null || true

echo "==> building for testing"
xcodebuild build-for-testing -project SwipeProbe.xcodeproj -scheme SwipeProbe -destination "id=$UDID" \
  -derivedDataPath .dd > build.log 2>&1 || { tail -80 build.log; cp build.log "$OUT/"; exit 1; }

command -v ffmpeg >/dev/null || brew install ffmpeg >/dev/null 2>&1 || true

for t in Notes Native Circles; do
  echo "==> recording $t"
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/rec-$t.mp4" > "$OUT/rec-$t.log" 2>&1 &
  REC=$!
  sleep 3
  TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test-without-building -project SwipeProbe.xcodeproj -scheme SwipeProbe \
    -destination "id=$UDID" -derivedDataPath .dd -only-testing:"SwipeProbeUITests/RevealTests/test$t" \
    > "$OUT/test-$t.log" 2>&1 || echo "   (test$t exited non-zero)"
  grep -E "Test Case|error:" "$OUT/test-$t.log" | tail -5 || true
  sleep 1
  kill -INT "$REC" 2>/dev/null || true
  wait "$REC" 2>/dev/null || true
  ls -la "$OUT/rec-$t.mp4" || true
  if command -v ffmpeg >/dev/null; then
    mkdir -p "$OUT/frames-$t"
    # The rows' band only (200–400pt), half size, and only frames that differ from the last: the
    # launch's static home screen and every hold collapse, the motion stays frame for frame.
    ffmpeg -loglevel error -i "$OUT/rec-$t.mp4" \
      -vf "crop=iw:600:0:600,scale=iw/2:-1,mpdecimate=hi=256:lo=128:frac=0.05" -fps_mode vfr -q:v 3 \
      "$OUT/frames-$t/%04d.jpg" || true
    echo "   frames: $(ls "$OUT/frames-$t" | wc -l)"
  fi
done
ls "$OUT"/rec-*.mp4 >/dev/null 2>&1 || { echo "no recordings"; exit 1; }
