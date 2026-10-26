#!/usr/bin/env bash
# A15c device journeys for the A15 ledger rows that had only JVM tests (package io.orbitd.android.increments): each class signs
# the app in to its own controlled HTTP fixture (an in-process MockWebServer, not a deployment) and reads what the real Activity
# draws for the row's server state. Runs every class (or the ones named in INCREMENTS_CLASSES, space-separated) in one hold of the
# device lock, each from a clean install state. Per class, EVIDENCE_DIR/<class>/ keeps the instrumentation output, the app's
# logcat, and files/a15c/<class>/<test>/ (checks.log with a PASS/FAIL line per check, requests.txt, bodies.txt, screenshots).
# EVIDENCE_DIR/summary.tsv has one line per class.
set -euo pipefail

if (( $# < 3 || $# > 4 )); then
  echo "Usage: $0 APP_APK TEST_APK EVIDENCE_DIR [SERIAL]" >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="${4:-${ANDROID_DEVICE_SERIAL:-emulator-5554}}"
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
adb_bin="$ANDROID_HOME/platform-tools/adb"
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
classes="${INCREMENTS_CLASSES:-CardIncrementsDeviceTest ReaderIncrementsDeviceTest ComposerIncrementsDeviceTest ProjectIncrementsDeviceTest WikiIncrementsDeviceTest LinkIncrementsDeviceTest ManagementIncrementsDeviceTest}"
# The adb server starts before the lock is taken, and every adb call closes the lock's fd: a daemon forked while the
# lock is held would keep it after this script exits.
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-900}" 9
adb() { "$adb_bin" -s "$serial" "$@" 9>&-; }
old_handwriting=''
cleanup() {
  local result=$?
  adb shell am force-stop "$package" >/dev/null 2>&1 || true
  if [[ -n "$old_handwriting" ]]; then
    if [[ "$old_handwriting" == null ]]; then
      adb shell settings delete secure stylus_handwriting_enabled >/dev/null || true
    else
      adb shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true
    fi
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A15c device journeys over controlled HTTP fixtures (MockWebServer in each test); not a deployment\nclasses=%s\nstarted_utc=%s\n' \
  "$classes" "$(date -u +%FT%TZ)" > "$output/result.txt"
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted" >&2; exit 1; }
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$property" "$(adb shell getprop "$property" | tr -d '\r')"
  done
  adb shell wm size
  adb shell wm density
  adb shell settings get system font_scale
  adb shell cmd uimode night
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
# A dedicated fixture install: another task's build on this shared emulator may be signed differently, and -r refuses it.
adb uninstall "$package" > "$output/uninstall-app.txt" 2>&1 || true
adb uninstall "$package.test" > "$output/uninstall-tests.txt" 2>&1 || true
adb install -r "$apk" > "$output/install-app.txt"
adb install -r "$tests" > "$output/install-tests.txt"
# API 34+ opens "Try out your stylus" over a focused field, which would cover the screenshots.
old_handwriting="$(adb shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
adb shell settings put secure stylus_handwriting_enabled 0
printf 'class\tresult\ttests\tstarted_utc\tfinished_utc\n' > "$output/summary.tsv"
failed=0
for class in $classes; do
  dir="$output/$class"
  mkdir -p "$dir"
  # Each class starts signed out from a clean data directory.
  adb shell pm clear "$package" > "$dir/pm-clear.txt"
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell am force-stop "$package"
  begun="$(date -u +%FT%TZ)"
  start="$(adb shell date +%s | tr -d '\r').000"
  timeout "${INCREMENTS_CLASS_TIMEOUT:-1500}" "$adb_bin" -s "$serial" shell am instrument -w -r \
    -e class "io.orbitd.android.increments.$class" "$runner" > "$dir/instrumentation.txt" 2>&1 9>&- || true
  pid="$(sed -n 's/.*a15c_pid=\([0-9]*\).*/\1/p' "$dir/instrumentation.txt" | head -1)"
  if [[ -n "$pid" ]]; then adb logcat -d -v threadtime --pid="$pid" -T "$start" > "$dir/logcat.txt" || true; fi
  if adb shell run-as "$package" ls files/a15c > /dev/null 2>&1; then
    adb shell run-as "$package" tar -cf files/a15c.tar -C files a15c > "$dir/capture-create.txt" 2>&1 || true
    adb exec-out run-as "$package" cat files/a15c.tar > "$dir/captures.tar" || true
    tar --no-same-owner -xf "$dir/captures.tar" -C "$dir" || true
    rm -f "$dir/captures.tar"
  fi
  count="$(sed -n 's/^OK (\([0-9]*\) tests\{0,1\})$/\1/p' "$dir/instrumentation.txt" | tr -d '\r' | head -1)"
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$dir/instrumentation.txt" > /dev/null || [[ -z "$count" ]]; then
    result=FAIL; failed=1
    count="$(grep -c '^INSTRUMENTATION_STATUS_CODE: 1$' "$dir/instrumentation.txt" || true)"
  else
    result=PASS
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$class" "$result" "$count" "$begun" "$(date -u +%FT%TZ)" >> "$output/summary.tsv"
done
chmod -R a+rX "$output"
cat "$output/summary.tsv"
exit "$failed"
