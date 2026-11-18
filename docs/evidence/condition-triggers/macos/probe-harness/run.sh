#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the Mac probe app from the tree's own shared sources and
# MainView, and let ConditionShotTests drive and photograph it. Adapted from ../../ios/probe-harness/run.sh, Mac only.
# Run it from a copy of this directory placed at the repository root (project.yml's `../src` paths are repo-relative).
# No Dock tweak: on macos-26 `killall Dock` left the Mac app with a menu bar and no window.
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

STATUS=0
SHOTS_DIR="$OUT" TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project CtMacProbe.xcodeproj -scheme CtMacProbe \
  -destination "platform=macOS" -derivedDataPath .dd-mac -resultBundlePath results/mac.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-mac.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-mac.log | tail -80 || true
cp build-mac.log "$OUT/xcodebuild-mac.log"
# The OrbitApp and OrbitKit files this project's C6 tasks added or changed, as this build compiled them into the app.
grep -E "SwiftCompile .*(ConditionViews|ScheduledMacPage|ScheduledPage|ScheduleCards|ApprovalCards|OwnerRequestViews|TasksView|ConditionDisplay|ConditionModels)\.swift" build-mac.log \
  | sed -E 's#/Users/runner/work/[^ ]*/src/#src/#g' | sort -u > "$OUT/compiled-mac.txt" || true
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/mac.xcresult --output-path "$OUT/attachments" >/dev/null 2>&1 || true
# The Mac UI-test runner may not write outside its container: name the exported pictures and notes instead.
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
