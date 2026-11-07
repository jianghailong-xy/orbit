#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone and Mac probe apps from the tree's own shell
# and shared sources, and let WikiChatShotTests drive and photograph them. Each platform gets its own stub log, so
# requests.log shows what that app sent. Adapted from docs/evidence/wiki-diagram-apple/probe-harness/run.sh.
# PASSES=ios|ipad|mac|"ios ipad mac" (default all three).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
PASSES="${PASSES:-ios ipad mac}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/ipad" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then
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
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir, $5 simulator to boot again (optional)
  echo "==> $1"
  local try
  for try in 1 2; do
    # C17: ONLY_TESTING names the tests to run (space-separated Target/Class/method), every test when empty.
    local only=()
    for one in ${ONLY_TESTING:-}; do only+=("-only-testing:$one"); done
    if SHOTS_DIR="$4" TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project C11Probe.xcodeproj -scheme "$2" \
      -destination "$3" -derivedDataPath ".dd-$2" -resultBundlePath "results/$1.xcresult" "${only[@]}" \
      CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1; then
      break
    fi
    # Round 6: xcodebuild did not see a simulator simctl listed and had booted. Once more, after booting it again.
    if [ "$try" = 1 ] && grep -q "Unable to find a device matching" "build-$1.log"; then
      echo "==> $1: xcodebuild did not find the simulator; booting it again, retrying in 30 s"
      if [ -n "${5:-}" ]; then
        xcrun simctl boot "$5" 2>/dev/null || true
        xcrun simctl bootstatus "$5" -b >/dev/null 2>&1 || true
      fi
      sleep 30
      rm -rf "results/$1.xcresult"
      continue
    fi
    STATUS=1
    break
  done
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  # The files this task added or changed, as this build compiled them into the probe app, and what the compiler said.
  grep -E "SwiftCompile .*(WikiChat[A-Za-z]*|WikiDocView|WikiDocScreens|WikiActivityView|ToolCards|ConsoleModel)\.swift" "build-$1.log" \
    | sed -E 's#/Users/runner/work/[^ ]*/src/#src/#g' | sort -u > "$4/compiled-$1.txt" || true
  grep -E "(WikiChat[A-Za-z]*|WikiDocView|WikiDocScreens|WikiActivityView)\.swift:[0-9]+:[0-9]+: (warning|error)" "build-$1.log" \
    | sort -u > "$4/diagnostics-$1.txt" || true
  echo "$(wc -l < "$4/diagnostics-$1.txt") diagnostics on the wiki chat's files" >> "$4/diagnostics-$1.txt"
  # A runner whose test process could not write the pictures still keeps them as attachments.
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" \
    > /dev/null 2>&1 || true
  # The Mac UI-test runner may not write outside its container: name the exported pictures and notes instead.
  python3 - "$4" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        if ext in (".png", ".txt") and not os.path.exists(os.path.join(out, name if ext == ".txt" else name + ext)):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name if ext == ".txt" else name + ext))
PY
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
IPAD_UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPad Pro 13" in x["name"]:
            if best is None or v>best[0]: best=(v,x["udid"])
print(best[1] if best else "")')

for pass in $PASSES; do
  case "$pass" in
    ios)
      echo "==> iPhone $IPHONE_UDID: $(xcrun simctl list devices | grep "$IPHONE_UDID" | sed -E 's/^ +//')"
      xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
      xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
      xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
      for domain in com.apple.Preferences com.apple.keyboard.preferences; do
        xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
      done
      serve "$OUT/ios/requests.log"
      run_pass ios C11Probe "id=$IPHONE_UDID" "$OUT/ios" "$IPHONE_UDID"
      ;;
    ipad)
      [ -n "$IPAD_UDID" ] || { echo "==> no iPad Pro 13-inch simulator"; continue; }
      echo "==> iPad $IPAD_UDID: $(xcrun simctl list devices | grep "$IPAD_UDID" | sed -E 's/^ +//')"
      xcrun simctl boot "$IPAD_UDID" 2>/dev/null || true
      xcrun simctl bootstatus "$IPAD_UDID" -b >/dev/null 2>&1 || true
      xcrun simctl status_bar "$IPAD_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
      serve "$OUT/ipad/requests.log"
      run_pass ipad C11Probe "id=$IPAD_UDID" "$OUT/ipad" "$IPAD_UDID"
      ;;
    mac)
      serve "$OUT/mac/requests.log"
      run_pass mac C11MacProbe "platform=macOS" "$OUT/mac"
      ;;
  esac
done
kill "$STUB_PID" 2>/dev/null || true

for p in ios ipad mac; do
  [ -f "$OUT/$p/requests.log" ] || continue
  grep -E '" 404 ' "$OUT/$p/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" || true
  grep -E "POST|PATCH|DELETE|body:" "$OUT/$p/requests.log" > "$OUT/$p/writes.txt" || true
done
ls -la "$OUT" "$OUT/ios" "$OUT/ipad" "$OUT/mac"
exit "$STATUS"
