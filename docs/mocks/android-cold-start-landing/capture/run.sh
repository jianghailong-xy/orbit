#!/usr/bin/env bash
# Board frames on the shared emulator, one build's walks: run.sh today|proto APP_APK TEST_APK OUT_DIR
# Holds the device lock throughout, uninstalls whatever is there, sets night mode and a demo status bar, and restores them.
set -uo pipefail
build=$1; apk=$(realpath "$2"); tests=$(realpath "$3"); out=$(realpath -m "$4"); mkdir -p "$out"
adb=/opt/android-sdk/platform-tools/adb; serial=emulator-5554; package=io.orbitd.android.debug
"$adb" start-server
exec 9>/var/lib/orbit/android/ui.lock
flock -x -w 1800 9 || { echo 'device lock timeout' >&2; exit 75; }
a() { "$adb" -s "$serial" "$@" 9>&-; }
night=$(a shell cmd uimode night | tr -d '\r')
handwriting=$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')
font_scale=$(a shell settings get system font_scale | tr -d '\r')
wm=$(a shell wm size | tr -d '\r')
demo() { a shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
cleanup() {
  rc=$?; trap - EXIT
  a shell am force-stop "$package" >/dev/null 2>&1
  demo exit >/dev/null 2>&1; a shell settings put global sysui_demo_allowed 0 >/dev/null 2>&1
  case "$night" in *yes*) a shell cmd uimode night yes ;; *) a shell cmd uimode night no ;; esac >/dev/null 2>&1
  a shell settings put system font_scale "${font_scale:-1.0}" >/dev/null 2>&1
  if [ "$handwriting" = "null" ] || [ -z "$handwriting" ]; then a shell settings delete secure stylus_handwriting_enabled >/dev/null 2>&1
  else a shell settings put secure stylus_handwriting_enabled "$handwriting" >/dev/null 2>&1; fi
  printf 'restored %s font_scale=%s rc=%s\n' "$(a shell cmd uimode night | tr -d '\r')" "$(a shell settings get system font_scale | tr -d '\r')" "$rc" >> "$out/result.txt"
  exit "$rc"
}
trap cleanup EXIT
{ echo "build=$build started=$(date -u +%FT%TZ) load=$(cut -d' ' -f1-3 /proc/loadavg)"; echo "before $night font_scale=$font_scale $wm"; a shell getprop ro.build.fingerprint; a shell getprop ro.build.version.sdk; a shell wm size; a shell wm density; } > "$out/result.txt"
sha256sum "$apk" "$tests" > "$out/apks.sha256"
a uninstall "$package" > "$out/uninstall.txt" 2>&1; a uninstall "$package.test" >> "$out/uninstall.txt" 2>&1
a install -r "$apk" > "$out/install.txt" || exit 3; a install -r "$tests" >> "$out/install.txt" || exit 3
a shell settings put secure stylus_handwriting_enabled 0; a shell settings put system font_scale 1.0; a shell cmd uimode night yes >/dev/null
a shell settings put global sysui_demo_allowed 1
sleep 3  # SystemUI has to see the setting before it listens: a broadcast sent at once is dropped under load.
demo enter; sleep 1; demo clock -e hhmm 1115; demo notifications -e visible false; demo battery -e level 93 -e plugged false
demo network -e wifi show -e level 4 -e fully true; demo network -e mobile hide
sleep 3
walk() {
  local method=$1; a logcat -c
  a shell am instrument -w -r -e class "io.orbitd.android.landingboard.LandingBoardShotsTest#$method" -e build "$build" \
    "$package.test/androidx.test.runner.AndroidJUnitRunner" > "$out/$method.txt" 2>&1
  a logcat -d -s ActivityTaskManager:I LandingBoard:I AndroidRuntime:E lowmemorykiller:I lmkd:I ActivityManager:I > "$out/$method-logcat.txt" 2>&1
  a shell "run-as $package sh -c 'find no_backup -type f | xargs ls -l'" > "$out/$method-files.txt" 2>&1
  grep -a -E '^OK \(|FAILURES|INSTRUMENTATION_FAILED|Process crashed' "$out/$method.txt" | sed "s/^/$method: /" | tee -a "$out/result.txt"
  grep -a -E 'Displayed|Fully drawn' "$out/$method-logcat.txt" | sed "s/^/$method: /" | cut -c1-170 >> "$out/result.txt"
  grep -a -E '^OK \(' "$out/$method.txt" >/dev/null
}
for method in ${WALKS:-firstSignIn relaunch offline failed}; do walk "$method" || { echo "stopped at $method" >> "$out/result.txt"; break; }; done
# A launcher's cold start with no instrumentation attached, over what the walks left on the device. No server is up, so only the
# saved copy can draw the rows; the system's own lines say when.
if [ "$build" = proto ] && [ -z "${NO_COLD:-}" ]; then
  for i in 1 2 3 4 5 6; do
    a shell am force-stop "$package"; a logcat -c; sleep 2
    a shell am start -W -n "$package/io.orbitd.android.MainActivity" > "$out/cold-$i.txt" 2>&1
    sleep 9
    { echo "cold $i load=$(cut -d' ' -f1 /proc/loadavg)"; grep -a -E 'TotalTime|WaitTime' "$out/cold-$i.txt"; a logcat -d -s ActivityTaskManager:I | grep -a -E 'Displayed|Fully drawn' | cut -c20-; } >> "$out/cold.txt" 2>&1
    a exec-out screencap -p > "$out/cold-$i.png"
  done
fi
a exec-out run-as "$package" tar -cf - -C files landing-board > "$out/captures.tar" 2>/dev/null
tar --no-same-owner -xf "$out/captures.tar" -C "$out" 2>/dev/null
ls "$out/landing-board" 2>/dev/null | wc -l >> "$out/result.txt"
