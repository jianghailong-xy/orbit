#!/usr/bin/env bash
# Build the probe app, run it against the stub, and screenshot it. Evidence only.
#
#   bash .ios-probe/run.sh [out-dir] [simulator-name]
#
# Runs on a macOS host with Xcode + xcodegen + node. The simulator reaches the stub on the host's
# own loopback as 127.0.0.1, which is why the server is started here rather than anywhere else.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
SIM_NAME="${2:-iPhone 17 Pro}"
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
# Built for the simulator SDK with no `-destination`: the product is a simulator app, and naming a
# device here only adds a way to fail on a runner whose Xcode ships different devices.
# The log is kept whatever happens: a CI round that fails with only "** BUILD FAILED **" is a round
# spent on nothing.
xcodebuild -project Probe.xcodeproj -scheme Probe -sdk iphonesimulator -configuration Debug \
  -derivedDataPath "$OUT/dd" build > "$OUT/build.log" 2>&1
BUILT=$?
if [ $BUILT -ne 0 ]; then tail -80 "$OUT/build.log"; exit 1; fi
tail -3 "$OUT/build.log"

echo "== simulator =="
xcrun simctl list runtimes | grep -i ios || true
# Ask for the newest iPhone the runtimes here actually have; the name in $SIM_NAME wins when it is
# there, and otherwise the first available one is used (reported either way, because the device
# decides the screenshot's size).
UDID=$(xcrun simctl list devices available | grep -m1 "$SIM_NAME (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
if [ -z "${UDID:-}" ]; then
  SIM_NAME=$(xcrun simctl list devices available | grep -oE "^    iPhone [^(]*" | head -1 | xargs)
  UDID=$(xcrun simctl list devices available | grep -m1 "$SIM_NAME (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
fi
echo "device: $SIM_NAME ($UDID)"
[ -n "${UDID:-}" ] || { echo "no available iPhone simulator"; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

APP="$OUT/dd/Build/Products/Debug-iphonesimulator/OrbitProbe.app"
xcrun simctl uninstall "$UDID" io.orbitd.probe 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

echo "== run =="
# `simctl launch` only forwards environment to the app through the SIMCTL_CHILD_ prefix.
SIMCTL_CHILD_PROBE_PORT="$PORT" xcrun simctl launch --console-pty "$UDID" io.orbitd.probe \
  > "$OUT/app.log" 2>&1 &
LAUNCH=$!
# The console's context load + the ruler read are two round trips against a local stub; the cards
# are on screen well inside this, and the dump below says whether they were.
sleep 12
xcrun simctl io "$UDID" screenshot "$OUT/probe.png" || true
kill $LAUNCH 2>/dev/null
sleep 1

echo "== app log =="
cat "$OUT/app.log" 2>/dev/null | tail -20
echo "== stub log =="
cat "$OUT/server.log"
ls -la "$OUT"/probe.png
