#!/usr/bin/env bash
set -euo pipefail
if (( $# != 4 )); then
  echo 'Usage: push-device-test.sh APP_APK TEST_APK EVIDENCE_DIR SERIAL|api29..api36' >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="$4"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
package=io.orbitd.android.debug
runner="$package.test/io.orbitd.android.push.PushTestRunner"
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
exec 9>/var/lib/orbit/android/ui.lock
flock -n 9 || { echo 'Device busy; continue offline work and retry when available.' >&2; exit 75; }
permission=''
notification_mode=''
emulator_pid=''
device_ready=false
cleanup() {
  local result=$?
  if [[ "$device_ready" == true ]]; then
    "$adb" -s "$serial" shell am force-stop "$package" > "$output/force-stop.txt" 2>&1 || true
    if [[ "$permission" == false ]]; then
      "$adb" -s "$serial" shell pm revoke "$package" android.permission.POST_NOTIFICATIONS > "$output/restore-permission.txt" 2>&1 || true
    fi
    if [[ -n "$notification_mode" ]]; then
      "$adb" -s "$serial" shell cmd appops set "$package" POST_NOTIFICATION "$notification_mode" > "$output/restore-appop.txt" 2>&1 || result=1
    fi
    "$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-after.txt" 2>&1 || true
  fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
    timeout 20 "$adb" -s "$serial" wait-for-disconnect > "$output/disconnect.txt" 2>&1 || result=1
  fi
  printf '%s\n' "$result" > "$output/exit-code.txt"
  exit "$result"
}
trap cleanup EXIT
if [[ "$serial" =~ ^api(29|3[0-6])$ ]]; then
  requested_api="${BASH_REMATCH[1]}"
  if [[ "$requested_api" == 36 ]]; then serial=emulator-5554
  else
    serial=emulator-5556
    if "$adb" devices | rg -q "^$serial[[:space:]]"; then echo 'Port 5556 in use; continue offline work.' >&2; exit 75; fi
    "$ANDROID_HOME/emulator/emulator" -avd "orbit-ui-api$requested_api" -port 5556 \
      -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader \
      -accel on -memory 2048 -cores 2 -camera-back none -camera-front none > "$output/emulator.log" 2>&1 &
    emulator_pid=$!
  fi
  timeout 300 "$adb" -s "$serial" wait-for-device
  deadline=$((SECONDS + 300))
  until [[ "$("$adb" -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
    (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
    sleep 2
  done
  [[ "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" == "$requested_api" ]]
fi
"$adb" -s "$serial" get-state
device_ready=true
for prop in ro.product.model ro.build.version.sdk ro.build.version.release ro.build.fingerprint ro.kernel.qemu ro.com.google.gmsversion; do
  printf '%s=%s\n' "$prop" "$("$adb" -s "$serial" shell getprop "$prop" | tr -d '\r')"
done > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
/opt/android-sdk/build-tools/36.0.0/aapt dump badging "$apk" > "$output/apk-badging.txt"
/opt/android-sdk/build-tools/36.0.0/apksigner verify --print-certs "$apk" > "$output/signature.txt"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-tests.txt"
"$adb" -s "$serial" shell run-as "$package" rm -rf files/a10-push
"$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-before.txt"
"$adb" -s "$serial" shell cmd appops get "$package" POST_NOTIFICATION > "$output/notification-appop-before.txt"
notification_mode="$(sed -nE 's/.*POST_NOTIFICATION: (allow|ignore|deny|default|foreground).*/\1/p' "$output/notification-appop-before.txt" | head -1)"
notification_mode="${notification_mode:-default}"
api="$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
if (( api >= 33 )); then
  if rg -q 'android.permission.POST_NOTIFICATIONS: granted=true' "$output/package-before.txt"; then permission=true; else permission=false; fi
  "$adb" -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS
fi
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard
"$adb" -s "$serial" shell am instrument -w -r -e class "${A10_TEST_CLASS:-io.orbitd.android.push.PushDeviceTest}" "$runner" > "$output/instrumentation.txt" 2>&1
"$adb" -s "$serial" exec-out run-as "$package" tar -C files/a10-push -cf - . > "$output/device-evidence.tar"
rg -q "OK \(${A10_EXPECTED_TESTS:-8} tests?\)" "$output/instrumentation.txt"
! rg -q 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation.txt"
echo 'Controlled notification/UI suite passed; this is not FCM delivery evidence.'
