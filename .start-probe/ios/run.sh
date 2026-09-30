#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Build the app's real start card, change card, receipt and
# Project started card (cut out of the real files by gen.py) into a throwaway iPhone app, and let a UI
# test open, scroll, pick from the menu, press and photograph them.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results ../Generated
mkdir -p "$OUT" results

python3 ../gen.py ../.. ../Generated

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
        score = (("17" in x["name"]) * 3) + (("16" in x["name"]) * 1) + (("Pro" in x["name"]) * 2) - (("Max" in x["name"]) * 1)
        key = (ver(rt), score)
        if best is None or key > best[0]: best = (key, x["udid"], x["name"], rt)
print(*best[1:], sep="\t") if best else print("")')
UDID=$(echo "$DEV" | cut -f1)
echo "==> device: $(echo "$DEV" | cut -f2)  runtime: $(echo "$DEV" | cut -f3)"
[ -n "$UDID" ] || { echo "no iPhone simulator"; exit 1; }

xcodegen generate >/dev/null
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The mock reads 8:24; matching it keeps the panels comparable.
xcrun simctl status_bar "$UDID" override --time "8:24" --batteryState discharging --batteryLevel 49 \
  2>/dev/null || true

echo "==> building and testing"
STATUS=0
ONLY_ARGS=()
if [ -n "${ONLY:-}" ]; then
  for t in $ONLY; do ONLY_ARGS+=("-only-testing:StartProbeUITests/StartShotTests/$t"); done
fi
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project StartProbe.xcodeproj -scheme StartProbe \
  -destination "id=$UDID" -derivedDataPath .dd -resultBundlePath results/StartProbe.xcresult \
  "${ONLY_ARGS[@]}" > build.log 2>&1 || STATUS=$?
grep -E "Test Case|Executed|error:|failed|passed" build.log | tail -80 || true
if [ "$STATUS" -ne 0 ]; then
  echo "==> xcodebuild exited $STATUS; last 150 lines:"
  tail -150 build.log
fi
cp build.log "$OUT/xcodebuild.log"
cat "$OUT/report.txt" 2>/dev/null || true

xcrun xcresulttool export attachments --path results/StartProbe.xcresult --output-path "$OUT/attachments" \
  2>&1 | tail -5 || true
echo "==> shots:"
ls -la "$OUT" || true
ls "$OUT"/*.png > /dev/null 2>&1 || { echo "==> no captures"; exit 1; }
exit "$STATUS"
