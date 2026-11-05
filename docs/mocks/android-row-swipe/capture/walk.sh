#!/usr/bin/env bash
# Row swipe walks on emulator-5554 under the device lock: walk.sh APP_APK TEST_APK OUT_DIR "run run..." where a run is theme:navigation,
# e.g. dark:gesture light:gesture dark:threebutton. Starts the emulator only if it is down, and stops it again; puts back night mode, navigation mode, display size.
set -uo pipefail
apk=$(realpath "$1"); tests=$(realpath "$2"); out=$(realpath -m "$3"); runs=${4:-dark:gesture}; class=${CLASS:-io.orbitd.android.directory.RowSwipeDeviceTest}
mkdir -p "$out"
adb=/opt/android-sdk/platform-tools/adb; serial=emulator-5554; package=io.orbitd.android.debug
"$adb" start-server
exec 9>/var/lib/orbit/android/ui.lock
flock -x -w 3000 9 || { echo 'device lock timeout'; exit 75; }
a() { "$adb" -s "$serial" "$@" 9>&-; }
started=0
if [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ]; then
  /mnt/data/android-landing-board/kit/when-calm.sh 9>&-
  systemctl reset-failed orbit-android-emulator 9>&- 2>/dev/null
  orbit-android-emulator start 9>&- >/dev/null 2>&1; started=1
  for i in $(seq 1 90); do [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 4; done
fi
[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] || { echo "$serial did not boot"; exit 3; }
night=$(a shell cmd uimode night | awk '{print $NF}' | tr -d '\r')
handwriting=$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')
wm=$(a shell wm size | tr -d '\r'); override=$(printf '%s\n' "$wm" | sed -n 's/^Override size: //p')
dens=$(a shell wm density | tr -d '\r'); dens_override=$(printf '%s\n' "$dens" | sed -n 's/^Override density: //p')
nav_before=$(a shell cmd overlay list | tr -d '\r' | sed -n 's/^\[x\] \(com.android.internal.systemui.navbar.[a-z]*\)$/\1/p' | head -1)
{ echo "started=$(date -u +%FT%TZ) load=$(cut -d' ' -f1-3 /proc/loadavg)"; echo "before night=$night nav=$nav_before $wm"; a shell getprop ro.build.fingerprint; a shell getprop ro.build.version.sdk; a shell wm density; } >> "$out/result.txt"
demo() { a shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
cleanup() {
  rc=$?; trap - EXIT
  a shell am force-stop "$package" >/dev/null 2>&1
  demo exit >/dev/null 2>&1; a shell settings put global sysui_demo_allowed 0 >/dev/null 2>&1
  a shell cmd uimode night "$night" >/dev/null 2>&1
  [ -n "$nav_before" ] && a shell cmd overlay enable-exclusive --category "$nav_before" >/dev/null 2>&1
  if [ "$handwriting" = null ] || [ -z "$handwriting" ]; then a shell settings delete secure stylus_handwriting_enabled >/dev/null 2>&1
  else a shell settings put secure stylus_handwriting_enabled "$handwriting" >/dev/null 2>&1; fi
  [ -n "$override" ] && a shell wm size "$override" >/dev/null 2>&1
  [ -n "$dens_override" ] && a shell wm density "$dens_override" >/dev/null 2>&1
  a uninstall "$package" >/dev/null 2>&1; a uninstall "$package.test" >/dev/null 2>&1
  printf 'restored night=%s nav=%s rc=%s\n' "$(a shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" "$nav_before" "$rc" >> "$out/result.txt"
  if [ "$started" = 1 ] || [ -n "${STOP_EMULATOR:-}" ]; then sleep 15; a shell sync >/dev/null 2>&1; orbit-android-emulator stop 9>&- >/dev/null 2>&1; systemctl reset-failed orbit-android-emulator 9>&- 2>/dev/null; echo "stopped the emulator it started" >> "$out/result.txt"; fi
  exit "$rc"
}
trap cleanup EXIT
[ -n "$override" ] && { a shell wm size reset; sleep 15; }
[ -n "$dens_override" ] && { a shell wm density reset; sleep 10; }
echo "display: $(a shell wm size | tr -d '\r' | tr '\n' ' ') $(a shell wm density | tr -d '\r' | tr '\n' ' ')" >> "$out/result.txt"
a uninstall "$package" > "$out/uninstall.txt" 2>&1; a uninstall "$package.test" >> "$out/uninstall.txt" 2>&1
a install -r "$apk" > "$out/install.txt" || exit 3; a install -r "$tests" >> "$out/install.txt" || exit 3
sha256sum "$apk" "$tests" > "$out/apks.sha256"
a shell settings put secure stylus_handwriting_enabled 0
a shell settings put global sysui_demo_allowed 1; sleep 3
demo enter; sleep 1; demo clock -e hhmm 1142; demo notifications -e visible false; demo battery -e level 93 -e plugged false; demo network -e wifi show -e level 4 -e fully true; demo network -e mobile hide; sleep 2
failed=0
for run in $runs; do
  theme=${run%%:*}; nav=${run##*:}; dir="$out/$theme-$nav"; mkdir -p "$dir"
  a shell cmd overlay enable-exclusive --category "com.android.internal.systemui.navbar.$nav" >> "$dir/overlay.txt" 2>&1; sleep 6
  a shell cmd uimode night "$([ "$theme" = dark ] && echo yes || echo no)" >/dev/null; sleep 2
  a shell input keyevent KEYCODE_WAKEUP; a shell wm dismiss-keyguard; a shell pm clear "$package" > "$dir/clear.txt"
  { a shell settings get secure navigation_mode; a shell wm size; a shell dumpsys window displays | command grep -a -i -E 'systemGestures|mandatorySystemGestures|InsetsSource.*(gesture|Gestures)' | cut -c1-200 | head -8; } > "$dir/device.txt" 2>&1
  a logcat -c
  timeout "${TIMEOUT:-900}" "$adb" -s "$serial" shell am instrument -w -r -e class "$class" -e row_swipe_theme "$theme" "$package.test/androidx.test.runner.AndroidJUnitRunner" > "$dir/instrumentation.txt" 2>&1 9>&-
  a logcat -d -v threadtime -s AndroidRuntime:E ActivityManager:I OrbitPerf:D > "$dir/logcat.txt" 2>&1
  a shell run-as "$package" tar -cf files/row-swipe.tar -C files row-swipe > /dev/null 2>&1
  a exec-out run-as "$package" cat files/row-swipe.tar > "$dir/captures.tar" 2>/dev/null
  tar --no-same-owner -xf "$dir/captures.tar" -C "$dir" 2>/dev/null
  res=$(command grep -a -E '^OK \(|^FAILURES|^Tests run|INSTRUMENTATION_FAILED|Process crashed' "$dir/instrumentation.txt" | head -3 | tr '\n' ' ')
  echo "$run: $res" | tee -a "$out/result.txt"
  command grep -a -E '^OK \(' "$dir/instrumentation.txt" >/dev/null || failed=1
done
exit "$failed"
