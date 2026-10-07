#!/usr/bin/env bash
set -euo pipefail
# A13 management pages on the shared emulator over controlled HTTP (MockWebServer inside the instrumentation).
# Holds the shared UI lock for the whole run; restores font scale and night mode, stops the app and keeps raw evidence.
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
font_scale=$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')
night=$("$adb" -s "$serial" shell cmd uimode night | tr -d '\r')
cleanup() {
  result=$?
  trap - EXIT
  "$adb" -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
  "$adb" -s "$serial" shell settings put system font_scale "${font_scale:-1.0}" >/dev/null 2>&1 || true
  printf 'restored font_scale=%s night=%s\n' "$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')" \
    "$("$adb" -s "$serial" shell cmd uimode night | tr -d '\r')" >> "$output/result.txt"
  printf 'exit_code=%s\n' "$result" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A13 controlled HTTP product UI on the emulator; not a deployed account, real Runner, FCM or cross-platform result\n' > "$output/result.txt"
printf 'before font_scale=%s %s\n' "$font_scale" "$night" >> "$output/result.txt"
git rev-parse HEAD > "$output/source-sha.txt"
git status --short > "$output/source-status.txt"
"$adb" -s "$serial" shell getprop ro.build.fingerprint > "$output/device.txt"
"$adb" -s "$serial" shell getprop ro.build.version.sdk >> "$output/device.txt"
"$adb" -s "$serial" shell wm size >> "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-test.txt"
# A signed-out, empty debug installation: no earlier session or cache is carried into the fixture.
"$adb" -s "$serial" shell pm clear "$package" > "$output/pm-clear.txt"
"$adb" -s "$serial" shell am instrument -w -r -e class io.orbitd.android.management.ManagementDeviceTest \
  io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner > "$output/instrumentation.txt" 2>&1 || true
"$adb" -s "$serial" exec-out run-as "$package" tar -cf - -C files a13-management > "$output/captures.tar" || true
tar --no-same-owner -xf "$output/captures.tar" -C "$output" || true
grep -F 'OK (2 tests)' "$output/instrumentation.txt"
if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then exit 1; fi
for screenshot in settings-home settings-home-dark edit-profile change-password notifications shared-links permission-revoked sign-out-confirm \
  admin-users admin-user admin-demoted settings-home-font200 session-share workspace-settings runners-list runner-offline runner-online \
  runner-engine runner-deep-link providers codex-pool; do
  test -s "$output/a13-management/$screenshot.png"
done
