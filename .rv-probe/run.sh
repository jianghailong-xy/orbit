#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged), task 34tKCNy9aN3Itk5SgIoIl, built from task 34tDf8rxHzhwoGyK6r0kj's kit:
# why the iPhone app sometimes sends nothing for 10-12 s after a challenge's Keep. Serve stub.py, build the iPhone
# probe app from the tree's own shell and shared sources (plus ios/StallWatch.swift, the app's watchdog), and let
# KeepStallTests press Keep twenty times (LANE a or b decides which half asks capture.py for its host capture).
# Beside the pass: sentinel.py (the host's view of any decide the app does not follow within 2 s: ps, top,
# spindump), the simulator's own log for the app and the system processes around it, and the host's load average.
# Afterwards the watchdog's logs are demangled and analyze.py writes analysis.txt. The Mac pass is skipped unless
# PASSES names it.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
LANE="${LANE:-a}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/wiki/review; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered on 127.0.0.1:8765; its output:"
  cat "$1.out"
  exit 1
}

STUB_PID=""
STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir, $5 the tests to run
  echo "==> $1 (lane $LANE, $5)"
  SHOTS_DIR="$4" TEST_RUNNER_SHOTS_DIR="$4" TEST_RUNNER_LANE="$LANE" xcodebuild test -project RvProbe.xcodeproj \
    -scheme "$2" -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    "-only-testing:$5" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  grep -E "SwiftCompile .*/(WikiView|WikiScreens|WikiModel|AppModel|StallWatch|RvProbe)\.swift" \
    "build-$1.log" | sed -E 's#/Users/runner/work/[^ ]*/(src|\.rv-probe)/#\1/#g' | grep -oE "(src|\.rv-probe)/[^ ]+\.swift" \
    | sort -u > "$4/compiled-$1.txt" || true
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" \
    > /dev/null 2>&1 || true
}

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
echo "==> iPhone $IPHONE_UDID: $(xcrun simctl list devices | grep "$IPHONE_UDID" | sed -E 's/^ +//')"
xcrun simctl list devices available -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
for rt,ds in d.items():
    for x in ds:
        if x["udid"]==sys.argv[1]: print(x["name"], rt.split(".")[-1], x["udid"])' "$IPHONE_UDID" > "$OUT/ios/device.txt"
{ sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize; sw_vers; } > "$OUT/ios/host.txt" 2>&1
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
for domain in com.apple.Preferences com.apple.keyboard.preferences; do
  xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
done

serve "$OUT/ios/requests.log"
( while true; do echo "$(date +%s) $(sysctl -n vm.loadavg)"; sleep 5; done ) > "$OUT/ios/loadavg.log" 2>&1 &
LOADAVG_PID=$!
xcrun simctl spawn "$IPHONE_UDID" log stream --style compact --level info --predicate 'process == "RvProbe"' \
  > "$OUT/ios/simlog-app.txt" 2>&1 &
LOG_APP_PID=$!
xcrun simctl spawn "$IPHONE_UDID" log stream --style compact --predicate \
  'process == "backboardd" OR process == "SpringBoard" OR process == "runningboardd" OR process == "testmanagerd" OR process BEGINSWITH "RvProbeUITests"' \
  > "$OUT/ios/simlog-system.txt" 2>&1 &
LOG_SYS_PID=$!
python3 -u sentinel.py "$OUT/ios" > "$OUT/ios/sentinel.out" 2>&1 &
SENTINEL_PID=$!
CAPTURE_SAMPLE=0 python3 -u capture.py "$IPHONE_UDID" "$OUT/ios" > "$OUT/ios/capture.out" 2>&1 &
CAPTURE_PID=$!
run_pass ios RvProbe "id=$IPHONE_UDID" "$OUT/ios" "RvProbeUITests/KeepStallTests"
touch "$OUT/ios/.pass-done"
# Had the app been unable to write SHOTS_DIR, StallWatch wrote into its own tmp/ instead: keep that too.
CONTAINER=$(xcrun simctl get_app_container "$IPHONE_UDID" io.orbitd.rvprobe data 2>/dev/null || true)
[ -n "$CONTAINER" ] && [ -f "$CONTAINER/tmp/stallwatch.log" ] && cp "$CONTAINER/tmp/stallwatch.log" "$OUT/ios/stallwatch-fallback.log"
for i in $(seq 1 60); do kill -0 "$CAPTURE_PID" 2>/dev/null || break; sleep 1; done
kill "$CAPTURE_PID" 2>/dev/null || true
echo "==> waiting for the sentinel's spindumps"
for i in $(seq 1 270); do kill -0 "$SENTINEL_PID" 2>/dev/null || break; sleep 1; done
kill "$SENTINEL_PID" 2>/dev/null || true
kill "$LOG_APP_PID" "$LOG_SYS_PID" "$LOADAVG_PID" 2>/dev/null || true
if [[ " ${PASSES:-ios} " == *" mac "* ]]; then
  serve "$OUT/mac/requests.log"
  run_pass mac RvMacProbe "platform=macOS" "$OUT/mac" "RvMacProbeUITests/ReviewShotTests"
else
  echo "==> mac pass skipped (PASSES=${PASSES:-ios})"
  touch "$OUT/mac/requests.log"
fi
kill "$STUB_PID" 2>/dev/null || true

# The watchdog's stacks with Swift's names readable, then the table of trials.
for f in "$OUT"/ios/stallwatch-*.log; do
  [ -f "$f" ] || continue
  xcrun swift-demangle --simplified < "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f" || rm -f "$f.tmp"
done
python3 analyze.py "$OUT/ios" --prune 2>&1 | tee "$OUT/ios/analyze.out"
for f in "$OUT"/ios/simlog-*.txt "$OUT"/ios/stallwatch-*.log "$OUT"/ios/xcodebuild-*.log; do
  [ -f "$f" ] && [ "$(stat -f %z "$f")" -gt 1000000 ] && gzip -9 "$f"
done
for p in ios mac; do
  grep -E '" 404 ' "$OUT/$p/requests.log" | sed -E 's/^[0-9:.]+ \[[0-9]+\] //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" || true
  grep -E "POST|PATCH|DELETE|body:" "$OUT/$p/requests.log" > "$OUT/$p/writes.txt" || true
done
du -sh "$OUT" "$OUT/ios" 2>/dev/null
ls -la "$OUT/ios" | head -120
exit "$STATUS"
