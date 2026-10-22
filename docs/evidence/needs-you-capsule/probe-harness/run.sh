#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the real
# shared sources, and let NeedsYouShotTests photograph the needs-you capsule (owner board 2026-10-21,
# docs/mocks/needs-you-capsule, A) on the largest iPhone the runner has — the owner's own phone is a
# Pro Max — light and dark. Copied from docs/evidence/landing-session-followup/probe-harness without
# its Mac pass: the bar is iPhone-only.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/users/me; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"
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
  TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project NeedsYouProbe.xcodeproj -scheme "$2" \
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
        if a["exportedFileName"].endswith(".png") and not os.path.exists(os.path.join(out, name + ".png")):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
}

# The newest iOS, then a Pro Max over a Pro over anything else.
IPHONE_UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPhone" in x["name"]:
            k=(v,("Pro Max" in x["name"])*2+("Pro" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"])
print(best[1] if best else "")')
echo "==> iPhone $IPHONE_UDID"
xcrun simctl list devices | grep "$IPHONE_UDID" || true
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
# The owner's screenshot's own status bar: 4:32, 48%.
xcrun simctl status_bar "$IPHONE_UDID" override --time "4:32" --batteryState discharging --batteryLevel 48 2>/dev/null || true
for domain in com.apple.Preferences com.apple.keyboard.preferences; do
  xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
done

serve "$OUT/ios/requests.log"
run_pass ios NeedsYouProbe "id=$IPHONE_UDID" "$OUT/ios"
kill "$STUB_PID" 2>/dev/null || true

grep -E "POST|PATCH|DELETE|BODY" "$OUT/ios/requests.log" > "$OUT/ios/writes.txt" || true
grep -E '" 404 ' "$OUT/ios/requests.log" | sed -E 's/^[0-9:]+ //' | sort | uniq -c | sort -rn > "$OUT/ios/not-served.txt" || true
ls -la "$OUT/ios"
exit "$STATUS"
