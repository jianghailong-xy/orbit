#!/usr/bin/env bash
set -euo pipefail

if (( $# != 4 )); then
  echo "Usage: $0 APP_APK TEST_APK EVIDENCE_DIR SERIAL" >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="$4"
scripts="$(cd "$(dirname "$0")" && pwd)"
adb="${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb"
package=io.orbitd.android.debug
runner=io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner
[[ -f "$apk" && -f "$tests" ]]
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]]
# Start the adb server before holding the lock, and never let adb inherit the lock's fd: a server spawned
# with fd 9 open would hold the device lock for as long as it lives.
"$adb" start-server >/dev/null 2>&1
adb() { command "$adb_bin" "$@" 9>&-; }
adb_bin="$adb"; adb=adb
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
# A12_LOCK_WAIT=<seconds> waits that long for another task to release the device; by default it does not wait.
flock -w "${A12_LOCK_WAIT:-0}" 9 || { echo 'Device lock busy; no device action performed' >&2; exit 75; }
printf 'lock_acquired_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/lock.txt"
fixture_pid=''
old_font=''
cleanup() {
  local result=$?
  trap - EXIT
  "$adb" -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
  "$adb" -s "$serial" reverse --remove tcp:18770 >/dev/null 2>&1 || true
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$old_font" ]]; then
    if [[ "$old_font" == null ]]; then "$adb" -s "$serial" shell settings delete system font_scale >/dev/null
    else "$adb" -s "$serial" shell settings put system font_scale "$old_font" >/dev/null; fi
    "$adb" -s "$serial" shell cmd uimode night "$old_night" >/dev/null
    [[ "$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')" == "$old_font" ]] || result=1
    [[ "$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" == "$old_night" ]] || result=1
    printf 'font=%s\nnight=%s\nrestored=true\n' "$old_font" "$old_night" > "$output/restored-settings.txt"
  fi
  "$adb" -s "$serial" reverse --list > "$output/reverse-after.txt" 2>&1 || true
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A12 Wiki/Watch controlled HTTP; emulator only; no real deployment or cross-platform result\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
git -C "$scripts" rev-parse HEAD > "$output/source-sha.txt"
git -C "$scripts" status --porcelain > "$output/source-status.txt"
timeout 30 "$adb_bin" -s "$serial" wait-for-device 9>&-
{
  printf 'serial=%s\n' "$serial"
  for prop in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint ro.kernel.qemu; do
    printf '%s=%s\n' "$prop" "$("$adb" -s "$serial" shell getprop "$prop" | tr -d '\r')"
  done
} > "$output/device.txt"
sha256sum "$apk" "$tests" "$scripts/wiki-watch-fixture.py" > "$output/artifacts.sha256"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-tests.txt"
"$adb" -s "$serial" shell am force-stop "$package"
# A dedicated signed-out installation: other tasks share this emulator and leave their own login behind.
"$adb" -s "$serial" shell pm clear "$package" > "$output/clear-app.txt"
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard
old_font="$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')"
old_night="$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
"$adb" -s "$serial" shell settings put system font_scale "${A12_FONT_SCALE:-1.0}"
"$adb" -s "$serial" shell cmd uimode night "${A12_NIGHT:-no}" >/dev/null
printf 'font=%s\nnight=%s\n' "${A12_FONT_SCALE:-1.0}" "${A12_NIGHT:-no}" > "$output/conditions.txt"
PYTHONDONTWRITEBYTECODE=1 python3 "$scripts/wiki-watch-fixture.py" --port 18770 > "$output/fixture.log" 2>&1 9>&- &
fixture_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18770/__stats > /dev/null; then break; fi
  kill -0 "$fixture_pid"
  sleep 0.1
done
"$adb" -s "$serial" reverse tcp:18770 tcp:18770
start="$("$adb" -s "$serial" shell date +%s | tr -d '\r').000"
"$adb" -s "$serial" shell am instrument -w -r -e class "${A12_TEST:-io.orbitd.android.wiki.WikiWatchDeviceTest}" "$runner" > "$output/instrumentation.txt" 2>&1
curl --fail --silent http://127.0.0.1:18770/__stats > "$output/server-stats.json"
for pid in $(sed -n 's/.*a12_pid=\([0-9]*\).*/\1/p' "$output/instrumentation.txt" | sort -u); do
  "$adb" -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/logcat-$pid.txt"
done
"$adb" -s "$serial" shell run-as "$package" tar -cf files/a12-captures.tar -C files a12-wiki-watch > "$output/capture-create.txt" 2>&1
"$adb" -s "$serial" exec-out run-as "$package" cat files/a12-captures.tar > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output"
chmod -R a+rX "$output/a12-wiki-watch"
command grep -aE 'OK \([0-9]+ tests?\)' "$output/instrumentation.txt" >/dev/null
if command grep -aE 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then exit 1; fi
if command grep -aE 'a06-fixture-(access|refresh)|a12-fixture-password' "$output"/logcat-*.txt; then exit 1; fi
