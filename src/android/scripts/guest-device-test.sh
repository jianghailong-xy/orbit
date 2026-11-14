#!/usr/bin/env bash
# Session guests, the guest's side, on emulator-5554: Shared with me in the drawer and the guest view (running, waiting on the owner,
# ended, a message sent, a link the owner's read refuses, no longer shared) — GuestDeviceTest over scripts/guest-fixture.py, a
# loopback fixture, not a deployment. Screenshots, the instrumentation output and the fixture's requests land in EVIDENCE_DIR.
set -euo pipefail

if (( $# != 3 )); then
  echo "Usage: $0 APP_APK TEST_APK EVIDENCE_DIR" >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
adb_bin="$ANDROID_HOME/platform-tools/adb"
serial=emulator-5554
port=18768
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-900}" 9
adb() { "$adb_bin" -s "$serial" "$@" 9>&-; }
fixture_pid=''
old_error_dialogs=''
cleanup() {
  local result=$?
  if [[ -n "$old_error_dialogs" ]]; then
    if [[ "$old_error_dialogs" == null ]]; then adb shell settings delete global hide_error_dialogs >/dev/null || true
    else adb shell settings put global hide_error_dialogs "$old_error_dialogs" >/dev/null || true; fi
  fi
  [[ -n "$fixture_pid" ]] && { curl -s "http://127.0.0.1:$port/__stats" > "$output/requests.json" || true; kill "$fixture_pid" 2>/dev/null || true; }
  adb reverse --remove "tcp:$port" >/dev/null 2>&1 || true
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=session guests, guest side: Shared with me and the guest view; loopback fixture; not a deployment\nstarted_utc=%s\n' \
  "$(date -u +%FT%TZ)" > "$output/result.txt"
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted" >&2; exit 1; }
install() {
  if ! adb install -r "$2" > "$3" 2>&1; then
    grep -F INSTALL_FAILED_UPDATE_INCOMPATIBLE "$3" >/dev/null || { cat "$3" >&2; return 1; }
    adb uninstall "$1" >> "$3"
    adb install "$2" >> "$3"
  fi
}
install "$package" "$apk" "$output/install-app.txt"
install "$package.test" "$tests" "$output/install-tests.txt"
python3 "$(dirname "$0")/guest-fixture.py" --port "$port" > "$output/fixture.log" 2>&1 9>&- &
fixture_pid=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$port/__stats" >/dev/null 9>&- && break; sleep 0.2; done
adb reverse "tcp:$port" "tcp:$port"
adb shell pm clear "$package" > "$output/pm-clear.txt"
# A loaded host leaves the shared emulator's system apps crashing or not responding: their dialogs would cover the screenshots.
old_error_dialogs="$(adb shell settings get global hide_error_dialogs | tr -d '\r')"
adb shell settings put global hide_error_dialogs 1
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null || true
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb shell am instrument -w -r -e guest_server "http://127.0.0.1:$port" -e class io.orbitd.android.reader.GuestDeviceTest "$runner" \
  > "$output/instrumentation.txt" 2>&1 || true
adb shell run-as "$package" tar -cf files/guest.tar -C files guest > "$output/capture-create.txt" 2>&1 || true
adb exec-out run-as "$package" cat files/guest.tar > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output"
if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation.txt" || \
   ! grep -F 'OK (1 test)' "$output/instrumentation.txt" >/dev/null; then exit 1; fi
