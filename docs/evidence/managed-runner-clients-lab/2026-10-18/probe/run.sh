#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve the recorded scenes with replay.py, build the iPhone and Mac
# probe apps from the tree's own shared sources, and play every scene in each (ReplayTests). Each platform gets
# its own replay log. PLATFORMS=ios|mac|"ios mac" (default both); PROBE_ONLY=<test name> runs one test.
# Adapted from the C7 managed-runner probe (/mnt/data/tmp/c7/mr-probe/run.sh on the HPC host).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
PLATFORMS="${PLATFORMS:-ios mac}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The replay must answer before anything runs, or the pass is void.
  if [ -n "${REPLAY_PID:-}" ]; then kill "$REPLAY_PID" 2>/dev/null; wait "$REPLAY_PID" 2>/dev/null; fi
  python3 -u replay.py 8765 "$1" scenes > "$1.out" 2>&1 &
  REPLAY_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/__clock; then
      echo "==> replay ready on 127.0.0.1:8765 (pid $REPLAY_PID, after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "==> replay never answered on 127.0.0.1:8765; its output:"
  cat "$1.out"
  exit 1
}

REPLAY_PID=""
STATUS=0
ONLY=()
if [ -n "${PROBE_ONLY:-}" ]; then ONLY=("-only-testing:$PROBE_ONLY"); fi
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir, $5 test bundle
  echo "==> $1"
  local only=()
  if [ -n "${PROBE_ONLY:-}" ]; then only=("-only-testing:$5/ReplayTests/$PROBE_ONLY"); fi
  SHOTS_DIR="$4" TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project T07Probe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    ${only[@]+"${only[@]}"} CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" > /dev/null 2>&1 || true
  # The Mac UI-test runner may not write outside its container: name the exported files instead.
  python3 - "$4" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        target = os.path.join(out, name if ext != ".png" else name + ext)
        if ext in (".png", ".txt", ".json") and not os.path.exists(target):
            shutil.copy(os.path.join(base, a["exportedFileName"]), target)
PY
}

for platform in $PLATFORMS; do
  case "$platform" in
    ios)
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
      xcrun simctl status_bar "$IPHONE_UDID" override --time "14:07" --batteryState charged --batteryLevel 100 2>/dev/null || true
      for domain in com.apple.Preferences com.apple.keyboard.preferences; do
        xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
      done
      serve "$OUT/ios/replay.log"
      run_pass ios T07Probe "id=$IPHONE_UDID" "$OUT/ios" T07ProbeUITests
      ;;
    mac)
      serve "$OUT/mac/replay.log"
      run_pass mac T07MacProbe "platform=macOS" "$OUT/mac" T07MacProbeUITests
      ;;
  esac
done
kill "$REPLAY_PID" 2>/dev/null || true
for p in ios mac; do
  [ -f "$OUT/$p/replay.log" ] && grep -E 'VIOLATION' "$OUT/$p/replay.log" > "$OUT/$p/violations.txt" || true
done
ls -la "$OUT/ios" "$OUT/mac"
exit "$STATUS"
