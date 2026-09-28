#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Builds the app's real picker/composer code (copied and
# cut out of the real files by gen.py) into a throwaway iPhone app, and the real iOS app beside it, and
# lets a UI test photograph each screen. The captures land in $OUT (default ./shots).
#
# Env a test process sees is prefixed TEST_RUNNER_ by xcodebuild — TEST_RUNNER_SHOTS_DIR=$OUT is how the
# runner reads it back as SHOTS_DIR and writes the PNGs to this directory.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results Generated
mkdir -p "$OUT" results

python3 ../gen.py ../.. .. || exit 1

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

xcodegen generate >/dev/null || exit 1
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# The mock reads 10:04; matching it keeps the panels comparable.
xcrun simctl status_bar "$UDID" override --time "10:04" --batteryState discharging --batteryLevel 35 \
  2>/dev/null || true

# One scheme at a time, each tolerated: the pure-view app carries the deliverable, the real-app run is
# the strongest evidence and must not be able to take the pictures down with it. Every invocation gets
# its own result bundle — xcodebuild refuses an existing one, and the passes are re-runs of a scheme.
RUN=0
run_scheme() {
  local scheme="$1"; shift
  RUN=$((RUN + 1))
  local log="$OUT/xcodebuild-$scheme-$RUN.log"
  echo "==> $scheme $*"
  TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project PoolProbe.xcodeproj -scheme "$scheme" \
    -destination "id=$UDID" -derivedDataPath .dd \
    -resultBundlePath "results/$scheme-$RUN.xcresult" "$@" > "$log" 2>&1
  local status=$?
  grep -E "Test Case|Executed|error:|failed|passed" "$log" | tail -60 || true
  if [ "$status" -ne 0 ]; then
    echo "==> $scheme exited $status; last 80 lines:"
    tail -80 "$log"
  fi
  xcrun xcresulttool export attachments --path "results/$scheme-$RUN.xcresult" \
    --output-path "$OUT/attachments-$scheme-$RUN" 2>&1 | tail -3 || true
  return "$status"
}

run_scheme PoolProbe

# The real app talks to the stub on the host's loopback (the simulator shares it). The stub writes
# the POST body it receives into the shots directory, beside the pictures.
STUB_OUT="$OUT" python3 ../stub.py > "$OUT/stub.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:8787/api/runners" >/dev/null && break
  sleep 0.5
done
echo "==> stub: $(curl -s http://127.0.0.1:8787/api/providers/shared-pools | head -c 120)…"

run_scheme OrbitProbe \
  -skip-testing:OrbitProbeUITests/RealAppShotTests/test2PickerDark

# Dark is the simulator's own appearance, which a test cannot set: one more pass, one test.
xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true
run_scheme OrbitProbe \
  -only-testing:OrbitProbeUITests/RealAppShotTests/test2PickerDark
xcrun simctl ui "$UDID" appearance light 2>/dev/null || true

kill $STUB 2>/dev/null || true
trap - EXIT

echo "==> shots:"
ls -la "$OUT" || true
ls "$OUT"/*.png || exit 1
