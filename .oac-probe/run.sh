#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged; see README.md). Serve stub.py, build the iPhone probe app from the
# real shell and shared sources, and let CardShotTests drive and photograph it: the one grey Answered card,
# the queued card, the words the coordinator was told inside View details, and the cases that keep the line.
# Run from a copy of this directory at the repository root (project.yml's `../src` paths are relative to it).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

# A zone where it is about 13:00 now, so the fixture's 11:20–11:53 is earlier today wherever the runner is:
# the hours east of UTC, the matching fixed-offset zone (Etc/GMT's sign is inverted), and its clock.
read -r PROBE_UTC_OFFSET PROBE_TZ PROBE_CLOCK < <(python3 -c '
from datetime import datetime, timedelta, timezone
u = datetime.now(timezone.utc)
h = 13 - u.hour
h = h - 24 if h > 14 else h + 24 if h < -12 else h
print(h, "Etc/GMT%+d" % -h, (u + timedelta(hours=h)).strftime("%H:%M"))')
export PROBE_UTC_OFFSET
echo "==> probe zone $PROBE_TZ (UTC$PROBE_UTC_OFFSET), $PROBE_CLOCK there"

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do
  curl -fs -o /dev/null http://127.0.0.1:8765/api/agents && { echo "==> stub ready after ${i}s"; break; }
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
echo "==> iPhone $IPHONE_UDID: $(xcrun simctl list devices | grep "$IPHONE_UDID" | head -1)"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "$PROBE_CLOCK" --batteryState charged --batteryLevel 100 2>/dev/null || true

STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT" TEST_RUNNER_PROBE_TZ="$PROBE_TZ" xcodebuild test -project OacProbe.xcodeproj -scheme OacProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd-ios -resultBundlePath results/ios.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-ios.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-ios.log | tail -80 || true
cp build-ios.log "$OUT/xcodebuild-ios.log"
# A runner whose test process could not write the pictures still keeps them as attachments.
mkdir -p "$OUT/attachments"
xcrun xcresulttool export attachments --path results/ios.xcresult --output-path "$OUT/attachments" > /dev/null 2>&1 || true
python3 - "$OUT" "$OUT/attachments" <<'PY' || true
import json, os, shutil, sys
out, base = sys.argv[1], sys.argv[2]
manifest = os.path.join(base, "manifest.json")
if not os.path.exists(manifest):
    raise SystemExit(0)
for test in json.load(open(manifest)):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        if a["exportedFileName"].endswith(".png") and not os.path.exists(os.path.join(out, name + ".png")):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name + ".png"))
PY
kill "$STUB_PID" 2>/dev/null || true
# Every write the app made (the stub refuses them all, so none changed anything) and every read it asked
# for that the stub does not serve.
grep -E "body:" "$OUT/requests.log" > "$OUT/writes.txt" || true
grep -E '" 404 ' "$OUT/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
ls -la "$OUT"
exit "$STATUS"
