#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md), task ⑥. Builds the real iOS app against the stub
# control plane and lets a UI test photograph the session row, the coordinator conversation's
# "Is this project done?" card and its receipt, the project page's Ready to close row and the card
# over the page, and "Why is this project not done?". Captures land in $OUT (default ./shots)
# through TEST_RUNNER_SHOTS_DIR, with the stub's writes.jsonl and a report.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results Generated
mkdir -p "$OUT" results

python3 ../gen.py ../.. .. || exit 1

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

xcodegen generate >/dev/null || exit 1
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The mock reads 1:40.
xcrun simctl status_bar "$UDID" override --time "1:40" --batteryState discharging --batteryLevel 62 \
  2>/dev/null || true

echo "==> build-for-testing"
xcodebuild build-for-testing -project DoneProbe.xcodeproj -scheme OrbitProbe \
  -destination "id=$UDID" -derivedDataPath .dd > "$OUT/xcodebuild-build.log" 2>&1 \
  || { echo "build failed"; grep -E "error:" "$OUT/xcodebuild-build.log" | head -40; tail -40 "$OUT/xcodebuild-build.log"; exit 1; }

STUB_OUT="$OUT" python3 ../stub.py > "$OUT/stub.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:8787/api/projects" >/dev/null && break
  sleep 0.5
done
echo "==> stub: $(curl -s http://127.0.0.1:8787/api/projects | head -c 160)…"

# Watchdog: after each done press the stub records, give the app six seconds; if it has stopped
# talking to the stub by then, sample its main thread while it hangs (and photograph the screen).
(
  seen=0
  for _ in $(seq 1 2400); do
    n=$(grep -c '/done"' "$OUT/writes.jsonl" 2>/dev/null || echo 0)
    if [ "$n" -gt "$seen" ]; then
      seen=$n
      sleep 6
      {
        echo "== done press #$n at $(date -u +%H:%M:%S); last stub request: $(tail -1 "$OUT/requests.log")"
        PID=$(pgrep -x OrbitProbe | head -1)
        echo "OrbitProbe pid=$PID"
        [ -n "$PID" ] && ps -o pid,stat,%cpu,rss,etime -p "$PID"
      } >> "$OUT/watchdog.txt" 2>&1
      if [ -n "$PID" ]; then
        sample "$PID" 3 -mayDie -file "$OUT/press-$n-sample.txt" >> "$OUT/watchdog.txt" 2>&1 \
          || sudo -n sample "$PID" 3 -mayDie -file "$OUT/press-$n-sample.txt" >> "$OUT/watchdog.txt" 2>&1
        xcrun simctl io "$UDID" screenshot "$OUT/press-$n-screen.png" >> "$OUT/watchdog.txt" 2>&1
        { echo "after sampling:"; ps -o pid,stat,%cpu,rss,etime -p "$PID"; \
          echo "requests since press: $(awk -v t="$(date -u -v-12S +%H:%M:%S)" '$1>=t' "$OUT/requests.log" | wc -l)"; } \
          >> "$OUT/watchdog.txt" 2>&1
      fi
    fi
    sleep 1
  done
) &
WATCHDOG=$!

echo "==> OrbitProbe UI tests"
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test-without-building -project DoneProbe.xcodeproj -scheme OrbitProbe \
  -destination "id=$UDID" -derivedDataPath .dd \
  -resultBundlePath results/run.xcresult > "$OUT/xcodebuild-test.log" 2>&1
STATUS=$?
grep -E "Test Case|Executed|error:|PROBE:" "$OUT/xcodebuild-test.log" | tail -200 || true
[ "$STATUS" -ne 0 ] && { echo "==> tests exited $STATUS; last 60 lines:"; tail -60 "$OUT/xcodebuild-test.log"; }

kill $STUB 2>/dev/null || true
kill $WATCHDOG 2>/dev/null || true
trap - EXIT
echo "==> watchdog:"; cat "$OUT/watchdog.txt" 2>/dev/null || true
for f in "$OUT"/press-*-sample.txt; do
  [ -f "$f" ] || continue
  echo "==> $f (main thread, heaviest frames):"
  sed -n '/Call graph:/,/Total number in stack/p' "$f" | head -60
done
echo "==> shots:"
ls -la "$OUT" || true
ls "$OUT"/*.png || exit 1
