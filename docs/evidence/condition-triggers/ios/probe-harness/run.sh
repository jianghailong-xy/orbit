#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone probe app from the tree's own shell and shared
# sources, and let ConditionShotTests drive and photograph it. Adapted from
# docs/evidence/criteria-reply-session-line/probe-harness/run.sh, iPhone only.
# Run it from a copy of this directory placed at the repository root (project.yml's `../src` paths are repo-relative).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then echo "==> stub ready after ${i}s"; break; fi
  sleep 1
done
curl -fs -o /dev/null http://127.0.0.1:8765/api/agents || { echo "==> stub never answered"; cat "$OUT/stub.out"; exit 1; }

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
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
# The status bar reads the app's clock (TZ=Asia/Shanghai), the zone the stub's times are in.
xcrun simctl status_bar "$IPHONE_UDID" override --time "$(TZ=Asia/Shanghai date +%-H:%M)" \
  --batteryState charged --batteryLevel 100 2>/dev/null || true
for domain in com.apple.Preferences com.apple.keyboard.preferences; do
  xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
done

STATUS=0
SHOTS_DIR="$OUT" TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project CtProbe.xcodeproj -scheme CtProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -80 || true
cp build-ios.log "$OUT/xcodebuild-ios.log"
# The OrbitApp and OrbitKit files this task added or changed, as this build compiled them into the probe app.
grep -E "SwiftCompile .*(ConditionViews|ScheduledPage|ScheduleCards|ApprovalCards|OwnerRequestViews|TasksView|ConditionDisplay|ConditionModels)\.swift" build-ios.log \
  | sed -E 's#/Users/runner/work/[^ ]*/src/#src/#g' | sort -u > "$OUT/compiled-ios.txt" || true
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/attachments" >/dev/null 2>&1 || true
python3 - "$OUT" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        target = os.path.join(out, name if ext == ".txt" else name + ext)
        if ext in (".png", ".txt") and not os.path.exists(target):
            shutil.copy(os.path.join(base, a["exportedFileName"]), target)
PY
kill "$STUB_PID" 2>/dev/null || true
grep -E '" 404 ' "$OUT/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
grep -E "body:" "$OUT/requests.log" > "$OUT/writes.txt" || true
ls -la "$OUT"
exit "$STATUS"
