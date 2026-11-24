#!/usr/bin/env bash
# Contract revision 42 part one on emulator-5554 (API 36), as the owner ruled it on the board docs/mocks/landing-fix-own-session: the
# landing-fix card in the task's own session, the Landings window's Fixing state and its hand-back with the session's last words, the
# hand-off, fix and hand-back lines, Being fixed by its session and the task row (LandingFixDeviceTest), over the test's own controlled
# HTTP fixture — not a deployment. It runs twice in one hold of the device lock, light then dark (`cmd uimode night`), on the display
# LANDING_FIX_DISPLAY names (default 1280x2856@480, the Pixel 10 Pro screenshots are taken on), and puts the display and the night mode
# back. Screenshots, checks.log and the requests made land in EVIDENCE_DIR/{light,dark}.
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
old_size=''
old_density=''
cleanup() {
  local result=$?
  if [[ -n "$old_handwriting" ]]; then
    if [[ "$old_handwriting" == null ]]; then
      adb shell settings delete secure stylus_handwriting_enabled >/dev/null || true
    else
      adb shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true
    fi
  fi
  if [[ -n "$old_size" ]]; then adb shell wm size "$old_size" >/dev/null || true; fi
  if [[ -n "$old_density" ]]; then adb shell wm density "$old_density" >/dev/null || true; fi
  if [[ -n "$old_night" ]]; then
    adb shell cmd uimode night "$old_night" >/dev/null || true
    printf 'night=%s expected=%s\n' "$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" "$old_night" > "$output/restored-settings.txt" || true
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=revision 42 part one screens, light and dark; controlled HTTP fixture; not a deployment\nstarted_utc=%s\n' \
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
# Another session's debug key may have signed the installed app: replace it then (drawer-projects-device-test.sh's `install`).
install() {
  if ! adb install -r "$2" > "$3" 2>&1; then
    grep -F INSTALL_FAILED_UPDATE_INCOMPATIBLE "$3" >/dev/null || { cat "$3" >&2; return 1; }
    adb shell dumpsys package "$1" | grep -E -A2 'signatures|Signing' >> "$3" || true
    adb uninstall "$1" >> "$3"
    adb install "$2" >> "$3"
  fi
}
install "$package" "$apk" "$output/install-app.txt"
install "$package.test" "$tests" "$output/install-tests.txt"
# API 34+ opens "Try out your stylus" over a focused field, which would cover the screenshots.
old_handwriting="$(adb shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
adb shell settings put secure stylus_handwriting_enabled 0
old_night="$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
display="${LANDING_FIX_DISPLAY:-1280x2856@480}"
[[ "$display" =~ ^[0-9]+x[0-9]+@[0-9]+$ ]] || { echo "LANDING_FIX_DISPLAY must be WIDTHxHEIGHT@DPI, not $display" >&2; exit 2; }
old_size="$(adb shell wm size | sed -n 's/Override size: //p' | tr -d '\r')"; old_size="${old_size:-reset}"
old_density="$(adb shell wm density | sed -n 's/Override density: //p' | tr -d '\r')"; old_density="${old_density:-reset}"
adb shell wm size "${display%@*}"
adb shell wm density "${display#*@}"
{ adb shell wm size; adb shell wm density; } > "$output/display.txt"
failed=0
for theme in light dark; do
  adb shell cmd uimode night "$([[ $theme == dark ]] && echo yes || echo no)"
  # Other sessions share this debug install and can leave it signed in: each pass signs in from a clean install.
  adb shell pm clear "$package" > "$output/pm-clear-$theme.txt"
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell am force-stop "$package"
  start="$(adb shell date +%s | tr -d '\r').000"
  adb shell am instrument -w -r -e class io.orbitd.android.increments.LandingFixDeviceTest -e landing_fix_theme "$theme" "$runner" \
    > "$output/instrumentation-$theme.txt" 2>&1 || true
  adb logcat -d -v threadtime -T "$start" > "$output/logcat-$theme.txt" || true
  adb shell run-as "$package" tar -cf files/landing-fix.tar -C files/a15c/LandingFixDeviceTest theLandingFixAsRuled > "$output/capture-create-$theme.txt" 2>&1
  adb exec-out run-as "$package" cat files/landing-fix.tar > "$output/captures-$theme.tar"
  mkdir -p "$output/$theme"
  tar --no-same-owner -xf "$output/captures-$theme.tar" -C "$output/$theme"
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation-$theme.txt" || \
     ! grep -F 'OK (1 test)' "$output/instrumentation-$theme.txt" >/dev/null; then failed=1; fi
done
chmod -R a+rX "$output"
exit "$failed"
