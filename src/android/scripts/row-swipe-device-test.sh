#!/usr/bin/env bash
# A session row's swipe on emulator-5554 (API 36), by real touches (RowSwipeDeviceTest), over the test's own controlled HTTP
# fixture — not a deployment: the walk dark and light with gesture navigation, dark with three-button navigation, then
# TalkBack's check of the row's actions. All in one hold of the device lock; night mode, the navigation mode, the display's size
# and density, the demo status bar and the stylus setting are put back as they were found. Frames, notes and the requests made
# land in EVIDENCE_DIR/<theme>-<navigation>/ and EVIDENCE_DIR/talkback/.
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
class='io.orbitd.android.directory.RowSwipeDeviceTest'
# The adb server starts before the lock is taken, and every adb call closes the lock's fd: a daemon forked while the
# lock is held would keep it after this script exits.
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-900}" 9
adb() { "$adb_bin" -s "$serial" "$@" 9>&-; }
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted" >&2; exit 1; }
old_night="$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
old_handwriting="$(adb shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
old_navigation="$(adb shell cmd overlay list | tr -d '\r' | sed -n 's/^\[x\] \(com.android.internal.systemui.navbar.[a-z]*\)$/\1/p' | head -1)"
old_size="$(adb shell wm size | tr -d '\r' | sed -n 's/^Override size: //p')"
old_density="$(adb shell wm density | tr -d '\r' | sed -n 's/^Override density: //p')"
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
cleanup() {
  local result=$?
  adb shell am force-stop "$package" >/dev/null 2>&1 || true
  demo exit || true
  adb shell settings put global sysui_demo_allowed 0 >/dev/null || true
  adb shell cmd uimode night "$old_night" >/dev/null || true
  [[ -n "$old_navigation" ]] && { adb shell cmd overlay enable-exclusive --category "$old_navigation" >/dev/null || true; }
  if [[ "$old_handwriting" == null || -z "$old_handwriting" ]]; then adb shell settings delete secure stylus_handwriting_enabled >/dev/null || true
  else adb shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true; fi
  [[ -n "$old_size" ]] && { adb shell wm size "$old_size" >/dev/null || true; }
  [[ -n "$old_density" ]] && { adb shell wm density "$old_density" >/dev/null || true; }
  printf 'night=%s navigation=%s size=%s density=%s\n' "$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" "$old_navigation" \
    "$(adb shell wm size | tr -d '\r' | tr '\n' ' ')" "$(adb shell wm density | tr -d '\r' | tr '\n' ' ')" > "$output/restored-settings.txt" || true
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=row swipe as iOS: real touches, dark and light, gesture and three-button navigation, TalkBack; controlled HTTP fixture; not a deployment\nstarted_utc=%s\n' \
  "$(date -u +%FT%TZ)" > "$output/result.txt"
# The frames are the device's own: another holder's display size or density override would change them.
[[ -n "$old_size" ]] && adb shell wm size reset
[[ -n "$old_density" ]] && adb shell wm density reset
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$property" "$(adb shell getprop "$property" | tr -d '\r')"
  done
  adb shell wm size
  adb shell wm density
  printf 'found: night=%s navigation=%s size_override=%s density_override=%s\n' "$old_night" "$old_navigation" "$old_size" "$old_density"
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
adb uninstall "$package" > /dev/null 2>&1 || true
adb uninstall "$package.test" > /dev/null 2>&1 || true
adb install -r "$apk" > "$output/install-app.txt"
adb install -r "$tests" > "$output/install-tests.txt"
# API 34+ opens "Try out your stylus" over a focused field, which would cover the frames.
adb shell settings put secure stylus_handwriting_enabled 0
# A demo status bar, so the frames do not carry the hour or the battery of the run.
adb shell settings put global sysui_demo_allowed 1; sleep 3
demo enter; sleep 1; demo clock -e hhmm 1142; demo notifications -e visible false; demo battery -e level 93 -e plugged false
demo network -e wifi show -e level 4 -e fully true; demo network -e mobile hide
failed=0
run() {
  local name=$1 method=$2 theme=$3 navigation=$4 dir="$output/$1"
  mkdir -p "$dir"
  adb shell cmd overlay enable-exclusive --category "com.android.internal.systemui.navbar.$navigation" > "$dir/overlay.txt" 2>&1; sleep 6
  adb shell cmd uimode night "$([[ $theme == dark ]] && echo yes || echo no)" >/dev/null; sleep 2
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell pm clear "$package" > "$dir/clear.txt"
  # A loaded host leaves "… isn't responding" over the app (a slow launcher after a boot); it would take the touches.
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null 2>&1 || true
  printf 'navigation_mode=%s night=%s anr_windows=%s\n' "$(adb shell settings get secure navigation_mode | tr -d '\r')" "$(adb shell cmd uimode night | tr -d '\r')" \
    "$(adb shell dumpsys window windows | grep -c 'Application Not Responding' || true)" > "$dir/device.txt"
  local start attempt
  for attempt in 1 2; do
    start="$(adb shell date +%s | tr -d '\r').000"
    adb shell am instrument -w -r -e class "$class#$method" -e row_swipe_theme "$theme" "$runner" > "$dir/instrumentation.txt" 2>&1 || true
    adb logcat -d -v threadtime -T "$start" -s AndroidRuntime:E ActivityManager:I lowmemorykiller:I lmkd:I A12Speech:I > "$dir/logcat.txt" 2>&1 || true
    # A process the guest killed before the test began (a loaded host: no trace in the app's own log) is run once more, and said so.
    grep -F 'Process crashed' "$dir/instrumentation.txt" >/dev/null && ! grep -F 'INSTRUMENTATION_STATUS: test=' "$dir/instrumentation.txt" >/dev/null \
      && [[ $attempt == 1 ]] || break
    printf '%s: the process died before the test began; run again\n' "$name" >> "$output/result.txt"
    cp "$dir/instrumentation.txt" "$dir/instrumentation-1.txt"; cp "$dir/logcat.txt" "$dir/logcat-1.txt"
    adb shell pm clear "$package" >> "$dir/clear.txt"
  done
  adb shell run-as "$package" tar -cf files/row-swipe.tar -C files row-swipe > "$dir/capture-create.txt" 2>&1 || true
  adb exec-out run-as "$package" cat files/row-swipe.tar > "$dir/captures.tar" || true
  tar --no-same-owner -xf "$dir/captures.tar" -C "$dir" 2>/dev/null || true
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$dir/instrumentation.txt" || \
     ! grep -F 'OK (1 test)' "$dir/instrumentation.txt" >/dev/null; then failed=1; echo "$name: FAILED" >> "$output/result.txt"
  else echo "$name: OK" >> "$output/result.txt"; fi
}
run dark-gesture aRowSwipesAsIosDoes dark gestural
run light-gesture aRowSwipesAsIosDoes light gestural
run dark-threebutton aRowSwipesAsIosDoes dark threebutton
run talkback talkBackOffersARowsActions dark gestural
adb uninstall "$package.test" > /dev/null 2>&1 || true
adb uninstall "$package" > /dev/null 2>&1 || true
chmod -R a+rX "$output"
exit "$failed"
