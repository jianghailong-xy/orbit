#!/usr/bin/env bash
# Evidence probe (see README.md; its client.yml is never merged). Serve stub.py, build the iPhone, iPad and
# Mac probe apps from the real shared sources, and let FirstWorkspaceShotTests drive and photograph a
# machine's first workspace. Each platform gets its own stub log, so requests.log shows what that app sent.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/ipad" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/runners; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s); $(curl -fs http://127.0.0.1:8765/api/runners | head -c 80)"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered on 127.0.0.1:8765; python: $(python3 --version 2>&1); its output:"
  cat "$1.out"; ps aux | grep stub.py | grep -v grep || true
  lsof -nP -iTCP:8765 || true
  exit 1
}

STUB_PID=""
STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir
  echo "==> $1"
  TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project FwProbe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  # A runner whose test process could not write the pictures still keeps them as attachments.
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" \
    > /dev/null 2>&1 || true
  # The Mac UI-test runner may not write outside its container: name the exported pictures instead.
  python3 - "$4" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        if a["exportedFileName"].endswith(".png") and not os.path.exists(os.path.join(out, name + ".png")):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
}

pick() {  # $1 = iPhone or iPad: the newest runtime's device of that kind
  xcrun simctl list devices available -j | python3 -c '
import json,sys,re
kind=sys.argv[1]
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and kind in x["name"]:
            k=(v,("Pro" in x["name"])*2-("Max" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"])
print(best[1] if best else "")' "$1"
}
boot() {  # $1 = udid
  xcrun simctl boot "$1" 2>/dev/null || true
  xcrun simctl bootstatus "$1" -b >/dev/null 2>&1 || true
  xcrun simctl status_bar "$1" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
  for domain in com.apple.Preferences com.apple.keyboard.preferences; do
    xcrun simctl spawn "$1" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
  done
}
IPHONE_UDID=$(pick iPhone)
IPAD_UDID=$(pick iPad)
echo "==> iPhone $IPHONE_UDID, iPad $IPAD_UDID"
boot "$IPHONE_UDID"

# The Mac first: a crash in the simulator leaves a "quit unexpectedly" panel on the Mac's screen.
# The Dock hides itself, so it does not cover the bottom of the window being photographed.
defaults write com.apple.dock autohide -bool true && killall Dock 2>/dev/null || true
sleep 2
serve "$OUT/mac/requests.log"
run_pass mac FwMacProbe "platform=macOS" "$OUT/mac"
serve "$OUT/ios/requests.log"
run_pass ios FwProbe "id=$IPHONE_UDID" "$OUT/ios"
xcrun simctl shutdown "$IPHONE_UDID" 2>/dev/null || true
boot "$IPAD_UDID"
serve "$OUT/ipad/requests.log"
run_pass ipad FwProbe "id=$IPAD_UDID" "$OUT/ipad"
kill "$STUB_PID" 2>/dev/null || true

for p in ios ipad mac; do
  grep -E "POST|PATCH|DELETE|BODY" "$OUT/$p/requests.log" > "$OUT/$p/writes.txt" || true
  grep -E '" 404 ' "$OUT/$p/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" || true
done
ls -la "$OUT/ios" "$OUT/ipad" "$OUT/mac"
exit "$STATUS"
