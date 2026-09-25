#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Build ProjectsView's real project menu into a
# throwaway iPhone app, and let a UI test open it, photograph it and press Copy Link.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results

APP=../../src/macos/OrbitApp/Sources/OrbitApp
cp "$APP/Platform.swift" Sources/
python3 extract_menu.py "$APP/Views/ProjectsView.swift" ProjectPageProbe.swift.in > Sources/ProjectPageProbe.swift
echo "==> generated Sources/ProjectPageProbe.swift:"
cat Sources/ProjectPageProbe.swift
cp Sources/ProjectPageProbe.swift "$OUT/"

# An iPhone on the newest iOS runtime this image has, preferring a recent Pro (as the drawer probe did).
echo "==> runtimes available:"
xcrun simctl list runtimes | grep -i ios || true
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
        score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2)
        key = (ver(rt), score)
        if best is None or key > best[0]: best = (key, x["udid"], x["name"], rt)
print(*best[1:], sep="\t") if best else print("")')
UDID=$(echo "$DEV" | cut -f1)
echo "==> device: $(echo "$DEV" | cut -f2)  runtime: $(echo "$DEV" | cut -f3)"
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }

xcodegen generate >/dev/null
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The app's own screenshots read 9:41 with a full battery; matching them keeps the panels comparable.
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 \
  2>/dev/null || true

echo "==> building and testing"
STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project MenuProbe.xcodeproj -scheme MenuProbe \
  -destination "id=$UDID" -derivedDataPath .dd -resultBundlePath results/MenuProbe.xcresult \
  > build.log 2>&1 || STATUS=$?
grep -E "Test Case|Executed|error:|failed|passed" build.log | tail -40 || true
if [ "$STATUS" -ne 0 ]; then
  echo "==> xcodebuild exited $STATUS; last 120 lines:"
  tail -120 build.log
fi
cp build.log "$OUT/xcodebuild.log"

# The same pictures out of the result bundle, in case the runner could not write $OUT itself.
xcrun xcresulttool export attachments --path results/MenuProbe.xcresult --output-path "$OUT/attachments" \
  2>&1 | tail -5 || true
echo "==> shots:"
ls -laR "$OUT" | grep -v "^total" || true
exit "$STATUS"
