#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 || $# > 5 )); then
  echo "Usage: $0 API APK EVIDENCE_DIR [SERIAL] [RUN_CONDITIONS_JSON]" >&2
  exit 2
fi
api="$1"
[[ "$api" =~ ^(29|3[0-6])$ ]] || { echo 'Expected API 29–36' >&2; exit 2; }
apk="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="${4:-}"
conditions="${5:-}"
[[ -f "$apk" ]] || { echo "APK missing: $apk" >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory for each run' >&2; exit 2; }
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
aapt="$ANDROID_HOME/build-tools/36.0.0/aapt"
lock_file="${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
package='io.orbitd.android.debug'
activity='io.orbitd.android.MainActivity'
emulator_pid=''
remote_dump='/data/local/tmp/orbit-a02-window.xml'
mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -w 600 9
cleanup() {
  local status=$?
  "$adb" -s "$serial" shell rm -f "$remote_dump" >/dev/null 2>&1 || true
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  printf 'exit_code=%s\n' "$status" >> "$output/result.txt"
}
trap cleanup EXIT
printf 'scope=A02 shell functional smoke\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
if [[ -z "$serial" ]]; then
  if [[ "$api" == 36 ]]; then
    serial=emulator-5554
  else
    serial=emulator-5556
    if "$adb" devices | grep -q "^$serial[[:space:]]"; then
      echo "$serial already exists; supply its serial explicitly to reuse it" >&2
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
actual_api="$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
[[ "$actual_api" == "$api" ]] || { echo "API mismatch: expected $api, device is $actual_api" >&2; exit 1; }

{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.manufacturer ro.product.model ro.build.version.release \
      ro.build.version.sdk ro.build.version.security_patch ro.build.display.id \
      ro.build.fingerprint ro.kernel.qemu ro.com.google.gmsversion persist.sys.locale; do
    printf '%s=%s\n' "$property" "$("$adb" -s "$serial" shell getprop "$property" | tr -d '\r')"
  done
  "$adb" -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
  "$adb" -s "$serial" shell wm size
  "$adb" -s "$serial" shell wm density
  for setting in font_scale accelerometer_rotation user_rotation; do
    printf '%s=%s\n' "$setting" "$("$adb" -s "$serial" shell settings get system "$setting" | tr -d '\r')"
  done
  "$adb" -s "$serial" shell cmd uimode night
} > "$output/device.txt"
{
  "$adb" version
  "$ANDROID_HOME/emulator/emulator" -version
  "$aapt" version
  cat "$ANDROID_HOME/cmdline-tools/latest/source.properties"
  "$JAVA_HOME/bin/java" -version 2>&1
  python3 --version
  printf 'parser=Python standard-library ElementTree\n'
  if [[ -f "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/source.properties" ]]; then
    cat "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/source.properties"
  fi
} > "$output/tools.txt" 2>&1
sha256sum "$apk" > "$output/apk.sha256"
"$aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
{
  git -C "$repo" rev-parse HEAD
  git -C "$repo" status --short -- src/android .github/workflows/android.yml
} > "$output/checkout.txt"
if [[ -n "$conditions" ]]; then
  python3 -m json.tool "$conditions" > "$output/run-conditions.json"
else
  printf '%s\n' '{"scope":"A02 shell only","fixture":"none (no backend)","network":"uncontrolled; unused by shell","performance":"not measured","FCM":"not tested"}' > "$output/run-conditions.json"
fi
sha256sum "$output/run-conditions.json" > "$output/run-conditions.sha256"
device_start="$("$adb" -s "$serial" shell date '+%m-%d %H:%M:%S.000' | tr -d '\r')"
"$adb" -s "$serial" install -r "$apk" > "$output/install.txt"
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard

capture() {
  local name="$1"
  "$adb" -s "$serial" shell uiautomator dump "$remote_dump" > "$output/$name-dump.txt"
  "$adb" -s "$serial" exec-out cat "$remote_dump" > "$output/$name.xml"
  "$adb" -s "$serial" exec-out screencap -p > "$output/$name.png"
  "$adb" -s "$serial" shell dumpsys activity activities > "$output/$name-activity.txt"
  grep -E 'mResumedActivity|topResumedActivity' "$output/$name-activity.txt" | grep -F "$package/$activity" >/dev/null
}
assert_text() {
  python3 - "$1" "$2" <<'PY'
import sys
import xml.etree.ElementTree as ET
assert any(node.get("text") == sys.argv[2] for node in ET.parse(sys.argv[1]).iter("node")), sys.argv[2]
PY
}
"$adb" -s "$serial" shell am force-stop "$package"
"$adb" -s "$serial" shell am start -W -n "$package/$activity" > "$output/launch.txt"
grep -q '^Status: ok' "$output/launch.txt"
capture home
assert_text "$output/home.xml" 'Orbit Android'
coordinates="$(python3 - "$output/home.xml" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET
node = next(node for node in ET.parse(sys.argv[1]).iter("node") if node.get("text") == "Build information")
x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)"
read -r tap_x tap_y <<< "$coordinates"
"$adb" -s "$serial" shell input tap "$tap_x" "$tap_y"
capture build-information
assert_text "$output/build-information.xml" 'Build information'
assert_text "$output/build-information.xml" 'Back'
python3 - "$output/build-information.xml" > "$output/build-identity.txt" <<'PY'
import sys
import xml.etree.ElementTree as ET
for node in ET.parse(sys.argv[1]).iter("node"):
    if node.get("text"):
        print(node.get("text"))
PY
"$adb" -s "$serial" shell input keyevent KEYCODE_BACK
capture back
assert_text "$output/back.xml" 'Orbit Android'
"$adb" -s "$serial" shell input keyevent KEYCODE_HOME
"$adb" -s "$serial" shell am start -W -n "$package/$activity" > "$output/resume.txt"
capture resume
assert_text "$output/resume.xml" 'Orbit Android'
"$adb" -s "$serial" shell am force-stop "$package"
"$adb" -s "$serial" shell am start -W -n "$package/$activity" > "$output/relaunch.txt"
capture relaunch
assert_text "$output/relaunch.xml" 'Orbit Android'
"$adb" -s "$serial" logcat -d -v threadtime -T "$device_start" > "$output/logcat.txt"
"$adb" -s "$serial" logcat -b crash -d -v threadtime -T "$device_start" > "$output/crash.txt"
if grep -F "Process: $package," "$output/crash.txt"; then
  echo 'Application crash detected' >&2
  exit 1
fi
printf 'checks=install,cold launch,build information,back,background resume,force-stop relaunch,no package crash\nfinished_utc=%s\n' "$(date -u +%FT%TZ)" >> "$output/result.txt"
echo "PASS: API $api / $serial; evidence: $output"
