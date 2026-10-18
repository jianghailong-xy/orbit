#!/usr/bin/env bash
# A05d device journey on emulator-5554 (API 36): a workspace's list draws a project's sessions as one row, the row opens the
# project's sessions page and Back returns, and the drawer's project row opens that page as its root (ProjectSessionsDeviceTest),
# over the test's own controlled HTTP fixture — not a deployment. It runs twice in one hold of the device lock, light then dark
# (`cmd uimode night`), and puts the night mode back. Screenshots and the requests made land in EVIDENCE_DIR/a05d/{light,dark}.
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
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
# The adb server starts before the lock is taken, and every adb call closes the lock's fd: a daemon forked while the
# lock is held would keep it after this script exits.
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-900}" 9
adb() { "$adb_bin" -s "$serial" "$@" 9>&-; }
old_handwriting=''
old_night=''
cleanup() {
  local result=$?
  if [[ -n "$old_handwriting" ]]; then
    if [[ "$old_handwriting" == null ]]; then
      adb shell settings delete secure stylus_handwriting_enabled >/dev/null || true
    else
      adb shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true
    fi
  fi
  if [[ -n "$old_night" ]]; then
    adb shell cmd uimode night "$old_night" >/dev/null || true
    printf 'night=%s expected=%s\n' "$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" "$old_night" > "$output/restored-settings.txt" || true
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A05d project rows and the project sessions page, light and dark; controlled HTTP fixture; not a deployment\nstarted_utc=%s\n' \
  "$(date -u +%FT%TZ)" > "$output/result.txt"
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted" >&2; exit 1; }
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$property" "$(adb shell getprop "$property" | tr -d '\r')"
  done
  adb shell wm size
  adb shell wm density
  adb shell settings get system font_scale
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
adb install -r "$apk" > "$output/install-app.txt"
adb install -r "$tests" > "$output/install-tests.txt"
# API 34+ opens "Try out your stylus" over a focused field, which would cover the screenshots.
old_handwriting="$(adb shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
adb shell settings put secure stylus_handwriting_enabled 0
old_night="$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
failed=0
for theme in light dark; do
  adb shell cmd uimode night "$([[ $theme == dark ]] && echo yes || echo no)"
  # Other sessions share this debug install and can leave it signed in: each pass signs in from a clean install.
  adb shell pm clear "$package" > "$output/pm-clear-$theme.txt"
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell am force-stop "$package"
  start="$(adb shell date +%s | tr -d '\r').000"
  adb shell am instrument -w -r -e class io.orbitd.android.directory.ProjectSessionsDeviceTest -e a05d_theme "$theme" "$runner" \
    > "$output/instrumentation-$theme.txt" 2>&1 || true
  pid="$(sed -n 's/.*a05d_pid=\([0-9]*\).*/\1/p' "$output/instrumentation-$theme.txt" | head -1)"
  if [[ -n "$pid" ]]; then adb logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/logcat-$theme.txt" || true; fi
  adb shell run-as "$package" tar -cf files/a05d.tar -C files a05d > "$output/capture-create-$theme.txt" 2>&1
  adb exec-out run-as "$package" cat files/a05d.tar > "$output/captures-$theme.tar"
  tar --no-same-owner -xf "$output/captures-$theme.tar" -C "$output"
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation-$theme.txt" || \
     ! grep -F 'OK (1 test)' "$output/instrumentation-$theme.txt" >/dev/null; then failed=1; fi
done
chmod -R a+rX "$output/a05d"
exit "$failed"
