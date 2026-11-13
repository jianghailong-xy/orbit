#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged): the macOS sidebar crash driver.
#
#   ./run.sh <label>            # label names the run, e.g. "control-prefix" or "fixed"
#
# Serves stub.py (a fake server whose data keeps changing), builds the REAL macOS app from the
# shared sources, launches it against the stub, and clicks across every sidebar row 200 times.
#
# MODE=probe (default) runs the driver inside the app: this Mac refuses XCUITest automation mode
# without the owner's authentication (`automationmodetool status`), so the driver posts AppKit mouse
# events into the app's own window. MODE=ui runs the same clicks through XCUITest instead — usable
# on a host whose automation mode is enabled (CI, or after the owner enables it).
#
# The run records the DiagnosticReports list before and after and samples the app's PID, so a
# crash is visible both as the missing DRIVER_DONE line and as a new Orbit .ips.
set -uo pipefail
cd "$(dirname "$0")"

LABEL="${1:-run}"
MODE="${MODE:-probe}"
OUT="${OUT:-$PWD/runs/$LABEL}"
PORT="${PORT:-8765}"
CONFIG="${CONFIG:-Release}"
CLICKS="${CLICKS:-200}"
RUN_LIMIT="${RUN_LIMIT:-240}"
DERIVED=".dd-$LABEL"
RESULT="$OUT/$LABEL.xcresult"

rm -rf "$OUT"
mkdir -p "$OUT"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  exit 1
fi
python3 -u stub.py "$PORT" "$OUT/requests.log" "${CHURN:-0.18}" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  kill "$STUB_PID" 2>/dev/null
}
trap cleanup EXIT
for _ in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/users/me" && break
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/users/me" || { echo "stub never answered"; cat "$OUT/stub.out"; exit 1; }
echo "==> stub ready on 127.0.0.1:$PORT (pid $STUB_PID)"

# Sign-in goes through the app's own login path; a stored token would skip it. Drop what a previous
# probe left so each run really signs in. (Absent is fine — `security` reports item-not-found.)
security delete-generic-password -s com.orbit.client -a 127.0.0.1 >/dev/null 2>&1 || true
security delete-generic-password -s com.orbit.client -a 127.0.0.1.refresh >/dev/null 2>&1 || true

# The baseline the acceptance check compares against: every Orbit crash report already on disk.
REPORTS="$HOME/Library/Logs/DiagnosticReports"
ls -1 "$REPORTS" 2>/dev/null | grep -i '^orbit' | sort > "$OUT/reports-before.txt" || true
RUN_START=$(date '+%Y-%m-%dT%H:%M:%S')
echo "$RUN_START" > "$OUT/run-start.txt"
# xcodebuild adds its own Sparkle pin to the local OrbitKit package's resolution file; that edit
# is build metadata, not this tree, so put it back before saying which tree this run built.
git -C ../../../.. checkout -- src/macos/OrbitKit/Package.resolved 2>/dev/null || true
# Which tree this run built: the branch tip and whether the app's own sources were modified (the
# control must be the pre-fix tree; the fixed run must carry the fix on the same harness).
{
  echo "head=$(git -C ../../../.. rev-parse HEAD)"
  echo "branch=$(git -C ../../../.. rev-parse --abbrev-ref HEAD)"
  echo "app_sources_dirty=$(git -C ../../../.. status --porcelain -- src/macos | wc -l | tr -d ' ')"
} > "$OUT/tree.txt"
echo "==> tree: $(tr '\n' ' ' < "$OUT/tree.txt")"
echo "==> run start $RUN_START; $(wc -l < "$OUT/reports-before.txt" | tr -d ' ') existing Orbit report(s)"

xcodegen generate >/dev/null || { echo "xcodegen failed"; exit 1; }

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
SIGN=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="")
ARCH=(ARCHS=arm64 ONLY_ACTIVE_ARCH=YES)

if [ "$MODE" = "ui" ]; then
  xcodebuild test \
    -project SidebarCrashProbe.xcodeproj -scheme Orbit -configuration "$CONFIG" \
    -destination "platform=macOS" -derivedDataPath "$DERIVED" -resultBundlePath "$RESULT" \
    "${SIGN[@]}" "${ARCH[@]}" > "$OUT/xcodebuild.log" 2>&1
  STATUS=$?
  grep -E "CLICK |SKIP |NOTE |DRIVER_DONE|error:|Test Case|Executed|\*\* TEST" "$OUT/xcodebuild.log" \
    > "$OUT/driver-lines.txt" || true
  cp "$OUT/xcodebuild.log" "$OUT/driver.log" 2>/dev/null || true
else
  xcodebuild build \
    -project SidebarCrashProbe.xcodeproj -scheme Orbit -configuration "$CONFIG" \
    -destination "platform=macOS" -derivedDataPath "$DERIVED" \
    "${SIGN[@]}" "${ARCH[@]}" > "$OUT/xcodebuild.log" 2>&1
  BUILD=$?
  cp "$OUT/xcodebuild.log" "$OUT/build.log"
  if [ "$BUILD" -ne 0 ]; then
    STATUS=$BUILD
    echo "==> build failed ($BUILD); see $OUT/build.log"
  else
    APP="$PWD/$DERIVED/Build/Products/$CONFIG/Orbit.app"
    DRIVER_LOG="$OUT/driver.log"
    rm -f "$DRIVER_LOG"
    pkill -f "$APP/Contents/MacOS/Orbit" 2>/dev/null
    # An idle Mac mini's display sleeps; wake it so the window is really laid out.
    caffeinate -u -t 3 2>/dev/null || true
    # The runner's own job has no WindowServer connection (`!cgsConnection`). Bootstrap this launch
    # into the logged-in user's Aqua session, where an app gets a window server and can draw.
    JOB="io.orbit.sidebarprobe.$(echo "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null
    cat > "$OUT/sidebarprobe.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$JOB</string>
  <key>ProgramArguments</key><array>
    <string>$APP/Contents/MacOS/Orbit</string>
    <string>-orbit.instance</string><string>http://127.0.0.1:$PORT</string>
    <string>-probe.driver</string><string>-probe.out</string><string>$DRIVER_LOG</string>
    <string>-probe.clicks</string><string>$CLICKS</string>
    <string>-probe.gap</string><string>${GAP:-30}</string>
    <string>-ApplePersistenceIgnoreState</string><string>YES</string>
  </array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$OUT/app.out</string>
  <key>StandardErrorPath</key><string>$OUT/app.err</string>
</dict></plist>
PLIST
    launchctl bootstrap "gui/$(id -u)" "$OUT/sidebarprobe.plist" || true
    for _ in $(seq 1 20); do
      APP_PID=$(pgrep -f "$APP/Contents/MacOS/Orbit" | head -1)
      [ -n "$APP_PID" ] && break
      sleep 0.5
    done
    echo "==> app pid ${APP_PID:-none} (job $JOB); clicking $CLICKS times"
    : > "$OUT/pids.log"
    ENDED=""
    if [ -z "$APP_PID" ]; then
      ENDED="noapp"
    else
      for _ in $(seq 1 "$RUN_LIMIT"); do
        if ! kill -0 "$APP_PID" 2>/dev/null; then ENDED="exited"; break; fi
        if grep -q "DRIVER_DONE" "$DRIVER_LOG" 2>/dev/null; then ENDED="done"; break; fi
        printf '%s alive\n' "$(date '+%H:%M:%S')" >> "$OUT/pids.log"
        sleep 1
      done
    fi
    if [ -z "$ENDED" ]; then ENDED="timeout"; fi
    if [ "$ENDED" = "done" ]; then
      # Let the last click's update settle, then stop the app ourselves: the point is it never
      # left the foreground, which DRIVER_DONE says.
      sleep 2
      kill "$APP_PID" 2>/dev/null
      STATUS=0
      printf '%s alive-after-driver\n' "$(date '+%H:%M:%S')" >> "$OUT/pids.log"
    else
      # The job's process left on its own (a crash) — or never came up. launchd has the exit status.
      sleep 2
      EXIT_CODE=$(launchctl print "gui/$(id -u)/$JOB" 2>/dev/null | awk '/last exit code/ {gsub(";",""); print $4}' | head -1)
      echo "${EXIT_CODE:-unknown}" > "$OUT/app-exit-code.txt"
      STATUS=1
      echo "==> app $ENDED before DRIVER_DONE (last exit code ${EXIT_CODE:-unknown})"
    fi
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null
    APP_PID=""
    grep -E "didFinishLaunching|window=|signedIn=|READY|CLICK |COLLAPSED|EXPANDED|NO TABLE|DRIVER_DONE" "$DRIVER_LOG" 2>/dev/null > "$OUT/driver-lines.txt" || true
  fi
fi

# ReportCrash writes the .ips a moment after the process dies: give it the moment.
sleep "${REPORT_WAIT:-8}"

# What the run left on disk: driver lines, and any report the crash wrote.
ls -1 "$REPORTS" 2>/dev/null | grep -i '^orbit' | sort > "$OUT/reports-after.txt" || true
comm -13 "$OUT/reports-before.txt" "$OUT/reports-after.txt" > "$OUT/reports-new.txt" || true
mkdir -p "$OUT/new-reports"
while read -r r; do
  [ -n "$r" ] && cp "$REPORTS/$r" "$OUT/new-reports/" 2>/dev/null || true
done < "$OUT/reports-new.txt"
CLICKS_DONE=$(grep -c "CLICK " "$OUT/driver-lines.txt" 2>/dev/null || true)
{
  echo "label=$LABEL"
  echo "mode=$MODE"
  echo "status=$STATUS"
  echo "run_start=$RUN_START"
  echo "tree=$(tr '\n' ' ' < "$OUT/tree.txt")"
  echo "existing_reports=$(wc -l < "$OUT/reports-before.txt" | tr -d ' ')"
  echo "new_reports=$(wc -l < "$OUT/reports-new.txt" | tr -d ' ')"
  echo "driver_done=$(grep DRIVER_DONE "$OUT/driver.log" 2>/dev/null | tail -1)"
  echo "click_lines=$CLICKS_DONE"
  echo "app_exit=$(cat "$OUT/app-exit-code.txt" 2>/dev/null)"
  echo "alive_samples=$(grep -c alive "$OUT/pids.log" 2>/dev/null || echo 0)"
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
echo "==> new reports: $(tr '\n' ' ' < "$OUT/reports-new.txt")"
exit "$STATUS"
