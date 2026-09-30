#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Builds the real iOS app against the stub control plane
# and lets a UI test photograph the project list and the project page. Captures land in $OUT
# (default ./shots) through TEST_RUNNER_SHOTS_DIR, with the stub's writes.jsonl and a report.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results Generated
mkdir -p "$OUT" results

python3 ../gen.py ../.. .. || exit 1

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

xcodegen generate >/dev/null || exit 1
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The mock reads 10:40; matching it keeps the panels comparable.
xcrun simctl status_bar "$UDID" override --time "10:40" --batteryState discharging --batteryLevel 46 \
  2>/dev/null || true

# Built before the stub starts, so the waits the stub dates from its own start ("asked 2 minutes
# ago") read as the mock does rather than a build's length later.
echo "==> build-for-testing"
xcodebuild build-for-testing -project ProjectProbe.xcodeproj -scheme OrbitProbe \
  -destination "id=$UDID" -derivedDataPath .dd > "$OUT/xcodebuild-build.log" 2>&1 \
  || { echo "build failed"; grep -E "error:" "$OUT/xcodebuild-build.log" | head -40; tail -40 "$OUT/xcodebuild-build.log"; exit 1; }

STUB_OUT="$OUT" python3 ../stub.py > "$OUT/stub.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:8787/api/projects" >/dev/null && break
  sleep 0.5
done
echo "==> stub: $(curl -s http://127.0.0.1:8787/api/projects | head -c 160)…"

RUN=0
run_tests() {
  RUN=$((RUN + 1))
  local log="$OUT/xcodebuild-$RUN.log"
  echo "==> OrbitProbe $*"
  TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test-without-building -project ProjectProbe.xcodeproj -scheme OrbitProbe \
    -destination "id=$UDID" -derivedDataPath .dd \
    -resultBundlePath "results/run-$RUN.xcresult" "$@" > "$log" 2>&1
  local status=$?
  grep -E "Test Case|Executed|error:|PROBE:" "$log" | tail -120 || true
  if [ "$status" -ne 0 ]; then
    echo "==> exited $status; last 60 lines:"
    tail -60 "$log"
  fi
  return "$status"
}

run_tests

# The same walk in dark, for the two blocks this change draws.
xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true
mkdir -p "$OUT/dark"
curl -s -X POST http://127.0.0.1:8787/api/__probe/reset; echo
TEST_RUNNER_SHOTS_DIR="$OUT/dark" OUT="$OUT/dark" run_tests -only-testing:OrbitProbeUITests/ProjectPageShotTests/test2HowItRuns || true
xcrun simctl ui "$UDID" appearance light 2>/dev/null || true

kill $STUB 2>/dev/null || true
trap - EXIT
cp "$OUT/writes.jsonl" "$OUT/writes-final.jsonl" 2>/dev/null || true

echo "==> shots:"
ls -la "$OUT" "$OUT/dark" || true
ls "$OUT"/*.png || exit 1
