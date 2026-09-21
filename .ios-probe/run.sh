#!/usr/bin/env bash
# Build the probe app, run it against the stub, and screenshot it. Evidence only.
#
#   bash .ios-probe/run.sh [out-dir]
#
# One launch, one screenshot: three cards do not fit a phone's portrait screen, so the device is an
# iPad (taller, and the same iOS views) — and a second launch of the same app is what wedged the
# simulator twice before this. The app is asked for every card at once with `-shot all`.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
PORT=8931

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p "$OUT"

echo "== toolchain =="
xcodebuild -version
xcodegen --version
node --version

echo "== stub =="
node "$HERE/probe-server.mjs" "$PORT" > "$OUT/server.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/api/sessions/probe" >/dev/null && break
  sleep 0.5
done
curl -s "http://127.0.0.1:$PORT/api/projects/34ODoUKJGEsfbgcJDGS4q/open-items" \
  | head -c 200 && echo

echo "== generate =="
cd "$HERE" && xcodegen generate || exit 1

echo "== build =="
xcodebuild -project Probe.xcodeproj -scheme Probe -sdk iphonesimulator -configuration Debug \
  -derivedDataPath "$HERE/.dd" build > "$OUT/build.log" 2>&1
BUILT=$?
if [ $BUILT -ne 0 ]; then tail -80 "$OUT/build.log"; exit 1; fi
tail -3 "$OUT/build.log"

echo "== simulator =="
xcrun simctl list runtimes | grep -i ios || true
# An iPad first: the three cards do not fit a phone screen in portrait, and one screenshot that
# holds all of them is worth more than three that each hold one. Both families are iOS.
DEVICE=$(xcrun simctl list devices available | sed -nE 's/^    ((iPad|iPhone)[^(]*) \(.*/\1/p' \
         | sed -E 's/ +$//' | (grep '^iPad' || true; grep '^iPhone' || true) | head -1)
UDID=$(xcrun simctl list devices available | grep -m1 "$DEVICE (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
echo "device: $DEVICE ($UDID)"
[ -n "${UDID:-}" ] || { echo "no available iPhone/iPad simulator"; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

APP="$HERE/.dd/Build/Products/Debug-iphonesimulator/OrbitProbe.app"
xcrun simctl uninstall "$UDID" io.orbitd.probe 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

echo "== run =="
stamp() { date -u +%H:%M:%S; }
SIMCTL_CHILD_PROBE_PORT="$PORT" xcrun simctl launch --terminate-running-process "$UDID" \
  io.orbitd.probe -shot all > "$OUT/launch.log" 2>&1 &
PID=$!
WAITED=0
while kill -0 "$PID" 2>/dev/null && [ "$WAITED" -lt 60 ]; do sleep 1; WAITED=$((WAITED + 1)); done
if kill -0 "$PID" 2>/dev/null; then
  echo "[$(stamp)] launch still running after ${WAITED}s — shooting anyway"
  kill -9 "$PID" 2>/dev/null
else
  wait "$PID"; echo "[$(stamp)] launch exit: $? — $(cat "$OUT/launch.log")"
fi
sleep 14
xcrun simctl io "$UDID" screenshot "$OUT/probe-all.png" && echo "[$(stamp)] shot probe-all"

echo "== app diagnostics =="
xcrun simctl spawn "$UDID" log show --style compact --last 3m \
  --predicate 'process == "OrbitProbe" OR composedMessage CONTAINS "OrbitProbe"' 2>&1 | tail -20

echo "== stub log =="
tail -20 "$OUT/server.log"
ls -la "$OUT"/*.png
