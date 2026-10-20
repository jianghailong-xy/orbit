#!/usr/bin/env bash
set -euo pipefail
# P7c: Cursor CLI's screens on the shared emulator over controlled HTTP (MockWebServer inside the instrumentation), in the light and
# the dark appearance — the frames of the owner's board docs/mocks/cursor-engine, iOS 1–6. Holds the shared UI lock for the whole run
# (ANDROID_DEVICE_LOCK names another for a caller that already holds it), stops the app and keeps the screenshots and raw evidence.
if (( $# != 3 )); then
  echo 'Usage: cursor-device-test.sh APP_APK TEST_APK EVIDENCE_DIR' >&2
  exit 2
fi
apk=$(realpath "$1")
tests=$(realpath "$2")
output=$(realpath -m "$3")
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]]
adb=/opt/android-sdk/platform-tools/adb
serial=${ANDROID_SERIAL:-emulator-5554}
# Only the shared emulator: a physical phone on the same adb server is never installed to, cleared or reconfigured.
[[ "$serial" == emulator-* ]] || { echo "Refusing non-emulator device $serial" >&2; exit 2; }
package=io.orbitd.android.debug
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -n 9 || { echo 'Device is in use; no device state changed.' >&2; exit 75; }
cleanup() {
  result=$?
  trap - EXIT
  "$adb" -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
  printf 'exit_code=%s\n' "$result" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=P7c Cursor CLI screens, controlled HTTP on the emulator; no real Cursor account, key, runner or prompt\n' > "$output/result.txt"
git rev-parse HEAD > "$output/source-sha.txt"
git status --short > "$output/source-status.txt"
"$adb" -s "$serial" shell getprop ro.build.fingerprint > "$output/device.txt"
"$adb" -s "$serial" shell getprop ro.build.version.sdk >> "$output/device.txt"
"$adb" -s "$serial" shell wm size >> "$output/device.txt"
"$adb" -s "$serial" shell wm density >> "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-test.txt"
# A signed-out, empty debug installation: no earlier session or cache is carried into the fixture.
"$adb" -s "$serial" shell pm clear "$package" > "$output/pm-clear.txt"
"$adb" -s "$serial" shell am instrument -w -r -e class io.orbitd.android.cursor.CursorDeviceTest \
  io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner > "$output/instrumentation.txt" 2>&1 || true
"$adb" -s "$serial" exec-out run-as "$package" tar -cf - -C files p7c-cursor > "$output/captures.tar" || true
tar --no-same-owner -xf "$output/captures.tar" -C "$output" || true
grep -F 'OK (2 tests)' "$output/instrumentation.txt"
if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then exit 1; fi
