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
  -derivedDataPath "$HERE/.dd" build > "$OUT/build.log" 2>&1
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

APP="$HERE/.dd/Build/Products/Debug-iphonesimulator/OrbitProbe.app"
xcrun simctl uninstall "$UDID" io.orbitd.probe 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

echo "== run =="
# Plain launch, no `--console-pty`: the app's own output is not what this needs (the screenshot and
# the stub's request log are), and a pty in a redirected CI shell is one more way for the launch to
# end in nothing. SIMCTL_CHILD_ is how simctl forwards an environment variable to the app.
SIMCTL_CHILD_PROBE_PORT="$PORT" xcrun simctl launch --terminate-running-process "$UDID" io.orbitd.probe \
  > "$OUT/launch.log" 2>&1
echo "launch exit: $? — $(cat "$OUT/launch.log")"
# The console's context load + the ruler read are two round trips against a local stub; the cards
# are on screen well inside this.
sleep 15
xcrun simctl io "$UDID" screenshot "$OUT/probe.png" || true

echo "== app diagnostics =="
# If the app never drew anything, this is where the reason is: its own os_log lines, and any crash
# report the host wrote for it.
xcrun simctl spawn "$UDID" log show --style compact --last 3m \
  --predicate 'process == "OrbitProbe" OR composedMessage CONTAINS "OrbitProbe"' 2>&1 | tail -30
ls -t ~/Library/Logs/DiagnosticReports 2>/dev/null | head -5
for f in $(ls -t ~/Library/Logs/DiagnosticReports/OrbitProbe* 2>/dev/null | head -1); do
  echo "--- $f"; head -40 "$f"
done

echo "== stub log =="
cat "$OUT/server.log"
ls -la "$OUT"/probe.png
