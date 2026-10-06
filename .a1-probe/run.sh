#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py (one server per port), build the iPhone and Mac
# probe apps from the real shared sources, and let GoogleShotTests photograph the login page against each
# server and sign in through the real system sheet. Each platform gets its own stub log.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/auth/methods && curl -fs -o /dev/null http://127.0.0.1:8769/api/auth/methods; then
      echo "==> stub ready (pid $STUB_PID, after ${i}s): $(curl -fs http://127.0.0.1:8765/api/auth/methods)"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered; python: $(python3 --version 2>&1); its output:"
  cat "$1.out"
  exit 1
}

STUB_PID=""
STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir
  echo "==> $1"
  TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project A1Probe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  # A runner whose test process could not write the pictures still keeps them as attachments.
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" \
    > /dev/null 2>&1 || true
  python3 - "$4" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        if ext in (".png", ".txt") and not os.path.exists(os.path.join(out, name if name.endswith(ext) else name + ext)):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name if name.endswith(ext) else name + ext))
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
            if best is None or k>best[0]: best=(k,x["udid"],x["name"]+" "+rt)
print(best[1] if best else "")
print("iPhone:", best[2] if best else "-", file=sys.stderr)')
echo "==> iPhone $IPHONE_UDID"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true

PASSES="${PASSES:-mac ios}"
# The Mac first: a crash in the simulator leaves a "quit unexpectedly" panel on the Mac's screen.
if [[ " $PASSES " == *" mac "* ]]; then
serve "$OUT/mac/requests.log"
MAC_START=$(date "+%Y-%m-%d %H:%M:%S")
# Can this runner's Safari load the stub at all? Its request shows in requests.log with from=safari-warmup.
open -a Safari "http://127.0.0.1:8765/api/auth/methods?from=safari-warmup" > "$OUT/mac/safari-warmup.txt" 2>&1 || echo "open failed: $?" >> "$OUT/mac/safari-warmup.txt"
sleep 10
screencapture -x "$OUT/mac/safari-warmup.png" >> "$OUT/mac/safari-warmup.txt" 2>&1 || echo "screencapture failed" >> "$OUT/mac/safari-warmup.txt"
ps -axo pid,etime,comm | grep -iE "safari|authenticationservices|webkit" | grep -v grep >> "$OUT/mac/safari-warmup.txt" || true
osascript -e 'tell application "Safari" to quit' >> "$OUT/mac/safari-warmup.txt" 2>&1 || pkill -x Safari || true
sleep 3
( while true; do echo "== $(date +%T)"; ps -axo pid,etime,comm | grep -iE "safari|authenticationservices|webkit|A1MacProbe" | grep -v grep; sleep 2; done ) > "$OUT/mac/ps-sampler.txt" 2>&1 &
SAMPLER=$!
run_pass mac A1MacProbe "platform=macOS" "$OUT/mac"
kill "$SAMPLER" 2>/dev/null || true
# Why a Mac sign-in sheet ended: what AuthenticationServices and the browser logged meanwhile (not XCTest's own chatter).
sudo -n log show --style compact --info --debug --start "$MAC_START" \
  --predicate '(process == "AuthenticationServicesAgent" OR process == "Safari" OR process CONTAINS "SafariServices" OR process CONTAINS "SafariViewService" OR process CONTAINS "SafariLaunchAgent" OR process == "A1MacProbe" OR subsystem CONTAINS "AuthenticationServices" OR eventMessage CONTAINS[c] "ASWebAuthentication" OR eventMessage CONTAINS[c] "A1MacProbe" OR eventMessage CONTAINS[c] "127.0.0.1:876") AND NOT (subsystem BEGINSWITH "com.apple.dt" OR subsystem == "com.apple.accessibility" OR category == "AX")' \
  > "$OUT/mac/auth-log.txt" 2>&1 || true
gzip -9 -f "$OUT/mac/auth-log.txt" || true
defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers > "$OUT/mac/default-handlers.txt" 2>&1 || true
fi
if [[ " $PASSES " == *" ios "* ]]; then
serve "$OUT/ios/requests.log"
run_pass ios A1Probe "id=$IPHONE_UDID" "$OUT/ios"
fi
kill "$STUB_PID" 2>/dev/null || true
ls -la "$OUT/ios" "$OUT/mac"
exit "$STATUS"
