#!/usr/bin/env bash
set -euo pipefail

if (( $# < 4 || $# > 5 )); then
  echo "Usage: $0 API APP_APK TEST_APK EVIDENCE_DIR [SERIAL]" >&2
  exit 2
fi
api="$1"
[[ "$api" =~ ^(29|3[0-6])$ ]] || { echo 'Expected API29–36' >&2; exit 2; }
apk="$(realpath "$2")"
tests="$(realpath "$3")"
output="$(realpath -m "$4")"
serial="${5:-}"
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
emulator_pid=''
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 600 9
cleanup() {
  local result=$?
  if [[ -n "${old_font:-}" ]]; then
    "$adb" -s "$serial" shell settings put system font_scale "$old_font" >/dev/null || true
    "$adb" -s "$serial" shell wm size "${old_size:-reset}" >/dev/null || true
    "$adb" -s "$serial" shell wm density "${old_density:-reset}" >/dev/null || true
    "$adb" -s "$serial" shell cmd uimode night "$old_night" >/dev/null || true
  fi
  if [[ -n "${old_handwriting:-}" ]]; then
    if [[ "$old_handwriting" == null ]]; then
      "$adb" -s "$serial" shell settings delete secure stylus_handwriting_enabled >/dev/null || true
    else
      "$adb" -s "$serial" shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true
    fi
  fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
}
trap cleanup EXIT
printf 'scope=A05 directory UI; controlled authenticated HTTP fixture; not a physical/deployed-account result\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
if [[ -z "$serial" ]]; then
  if [[ "$api" == 36 ]]; then
    serial=emulator-5554
  else
    serial=emulator-5556
    if "$adb" devices | grep -q "^$serial[[:space:]]"; then
      echo 'Port 5556 in use; pass an existing serial explicitly' >&2
      exit 1
    fi
    "$ANDROID_HOME/emulator/emulator" -avd "orbit-ui-api$api" -port 5556 \
      -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader \
      -accel on -memory 2048 -cores 2 -camera-back none -camera-front none \
      > "$output/emulator.log" 2>&1 &
    emulator_pid=$!
  fi
fi
timeout 300 "$adb" -s "$serial" wait-for-device
deadline=$((SECONDS + 300))
until [[ "$("$adb" -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
  (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
  sleep 2
done
[[ "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" == "$api" ]]
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint \
      ro.build.version.security_patch ro.kernel.qemu ro.com.google.gmsversion; do
    printf '%s=%s\n' "$property" "$("$adb" -s "$serial" shell getprop "$property" | tr -d '\r')"
  done
  "$adb" -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$apk" > "$output/signature.txt"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-tests.txt"
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard


old_font=''
if [[ "$("$adb" -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]; then
  old_size="$("$adb" -s "$serial" shell wm size | sed -n 's/Override size: //p' | tr -d '\r')"
  old_density="$("$adb" -s "$serial" shell wm density | sed -n 's/Override density: //p' | tr -d '\r')"
  old_font="$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')"
  old_night="$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
  "$adb" -s "$serial" shell wm size 720x1280
  "$adb" -s "$serial" shell wm density 320
  "$adb" -s "$serial" shell settings put system font_scale "${A05_FONT_SCALE:-1.0}"
  "$adb" -s "$serial" shell cmd uimode night "${A05_NIGHT:-no}"
  if (( api >= 34 )); then
    old_handwriting="$("$adb" -s "$serial" shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
    "$adb" -s "$serial" shell settings put secure stylus_handwriting_enabled 0
  fi
fi
{
  printf 'input_scope=phone touchscreen keyboard; stylus handwriting not tested\noriginal_stylus_handwriting_enabled=%s\n' "${old_handwriting:-unchanged}"
  "$adb" -s "$serial" shell wm size
  "$adb" -s "$serial" shell wm density
  "$adb" -s "$serial" shell settings get system font_scale
  "$adb" -s "$serial" shell cmd uimode night
  "$adb" -s "$serial" shell ime list -s
  "$adb" -s "$serial" shell settings get secure stylus_handwriting_enabled
  "$adb" -s "$serial" shell settings get secure enabled_accessibility_services
  "$adb" -s "$serial" shell pm list packages --show-versioncode com.google.android.marvin.talkback
} > "$output/conditions.txt"
"$adb" -s "$serial" shell am force-stop "$package"
start="$("$adb" -s "$serial" shell date +%s | tr -d '\r').000"
"$adb" -s "$serial" shell am instrument -w -r -e class io.orbitd.android.directory.DirectoryDeviceTest,io.orbitd.android.directory.LinkDeviceTest "$runner" > "$output/instrumentation.txt" 2>&1
"$adb" -s "$serial" exec-out run-as "$package" tar -c -C files a05-directory a05-links > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output"
mv "$output/a05-directory" "$output/screenshots"
mv "$output/a05-links" "$output/links"
chmod -R a+rX "$output/screenshots" "$output/links"
pid="$(sed -n 's/.*a05_pid=\([0-9]*\).*/\1/p' "$output/instrumentation.txt" | head -1)"
[[ -n "$pid" ]]
"$adb" -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/logcat.txt"
[[ -s "$output/logcat.txt" ]]
if rg 'a05-fixture-(password|access|refresh)' "$output/logcat.txt"; then
  echo 'Fixture credential marker found in logcat' >&2
  exit 1
fi
rg -F 'OK (2 tests)' "$output/instrumentation.txt" >/dev/null
for capture in login-ime folder directory-ime completed directory permission landscape; do
  [[ -s "$output/screenshots/$capture.png" ]]
done
[[ -s "$output/links/warm-wiki.png" && -s "$output/links/result.txt" ]]
if rg 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then
  exit 1
fi
