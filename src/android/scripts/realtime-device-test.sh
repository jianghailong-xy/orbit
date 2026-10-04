#!/usr/bin/env bash
set -euo pipefail
if (( $# < 3 || $# > 4 )); then
  echo 'Usage: realtime-device-test.sh API APK NEW_EVIDENCE_DIR [SERIAL]' >&2
  exit 2
fi
api="$1"
[[ "$api" =~ ^(29|3[0-6])$ ]]
apk="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="${4:-}"
[[ -f "$apk" ]]
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 600 9
emulator_pid=''
cleanup() {
  local result=$?
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  printf 'exit_code=%s\n' "$result" > "$output/exit.txt"
}
trap cleanup EXIT
if [[ -z "$serial" ]]; then
  if [[ "$api" == 36 ]]; then serial=emulator-5554
  else
    serial=emulator-5556
    if "$adb" devices | grep -q "^$serial[[:space:]]"; then
      echo 'Port 5556 occupied; pass an existing serial' >&2
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
python3 "$(dirname "$0")/realtime-device-test.py" "$serial" "$apk" "$output" --sdk "$ANDROID_HOME"
