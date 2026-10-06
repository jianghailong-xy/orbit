#!/usr/bin/env bash
set -euo pipefail
if (( $# != 3 )); then
  echo 'Usage: management-device-test.sh APP_APK TEST_APK EVIDENCE_DIR' >&2
  exit 2
fi
apk=$(realpath "$1")
tests=$(realpath "$2")
output=$(realpath -m "$3")
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]]
adb=/opt/android-sdk/platform-tools/adb
serial=${ANDROID_SERIAL:-emulator-5554}
package=io.orbitd.android.debug
exec 9>/var/lib/orbit/android/ui.lock
flock -n 9 || { echo 'Device is in use; no device state changed.' >&2; exit 75; }
cleanup() {
  result=$?
  trap - EXIT
  "$adb" -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
  printf 'exit_code=%s\n' "$result" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A13 controlled HTTP product UI; not a real account or cross-platform result\n' > "$output/result.txt"
git rev-parse HEAD > "$output/source-sha.txt"
git status --short > "$output/source-status.txt"
"$adb" -s "$serial" shell getprop ro.build.fingerprint > "$output/device.txt"
"$adb" -s "$serial" shell getprop ro.build.version.sdk >> "$output/device.txt"
"$adb" -s "$serial" shell wm size >> "$output/device.txt"
"$adb" -s "$serial" shell settings get system font_scale >> "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-test.txt"
"$adb" -s "$serial" shell am force-stop "$package"
"$adb" -s "$serial" shell am instrument -w -r -e class io.orbitd.android.management.ManagementDeviceTest \
  io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner > "$output/instrumentation.txt" 2>&1
"$adb" -s "$serial" exec-out run-as "$package" tar -cf - -C files a13-management > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output"
rg -F 'OK (2 tests)' "$output/instrumentation.txt"
if rg 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then exit 1; fi
for screenshot in profile-recreated permission-revoked share-permissions shared-links notification-preferences admin-users admin-demoted runner-offline runner-recovered runner-deep-link; do
  test -s "$output/a13-management/$screenshot.png"
done
