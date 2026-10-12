#!/usr/bin/env bash
# T9 screenshots on the shared API 36 emulator: installs the app and its test APK (the latter built with
# ProviderEngineShotsTest.kt in app/src/androidTest/kotlin/io/orbitd/android/providerengine/), serves fixture.py on loopback,
# and runs the journeys once in light and once in dark, under the host's emulator lock.
#   run.sh APP_APK TEST_APK NEW_EVIDENCE_DIR [SERIAL]
set -euo pipefail
(( $# >= 3 && $# <= 4 )) || { echo "Usage: $0 APP_APK TEST_APK NEW_EVIDENCE_DIR [SERIAL]" >&2; exit 2; }
kit="$(cd "$(dirname "$0")" && pwd)"
apk="$(realpath "$1")"; tests="$(realpath "$2")"; out="$(realpath -m "$3")"; serial="${4:-emulator-5554}"
mkdir -p "$out"; [[ -z "$(ls -A "$out")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
port=18791
package=io.orbitd.android.debug
runner=io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner
# The adb server is started outside the lock: one started under it would inherit the lock's descriptor and hold it forever.
"$ADB" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 3600 9
adb() { "$ADB" -s "$serial" "$@" 9>&-; }
fixture_pid=''
old_night="$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
cleanup() {
  local rc=$?
  [[ -n "$fixture_pid" ]] && { kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; }
  adb reverse --remove "tcp:$port" >/dev/null 2>&1 || true
  adb shell cmd uimode night "${old_night:-no}" >/dev/null 2>&1 || true
  printf 'exit_code=%s\nfinished_utc=%s\n' "$rc" "$(date -u +%FT%TZ)" >> "$out/result.txt"
  exit "$rc"
}
trap cleanup EXIT
printf 'scope=T9 provider/engine screens; controlled HTTP fixture (kit/fixture.py); not a deployed account\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$out/result.txt"
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$property" "$(adb shell getprop "$property" | tr -d '\r')"
  done
  adb shell wm size; adb shell wm density; adb shell settings get system font_scale
} > "$out/device.txt"
sha256sum "$apk" "$tests" "$kit/fixture.py" "$kit/ProviderEngineShotsTest.kt" > "$out/inputs.sha256"
adb install -r "$apk" > "$out/install-app.txt"
adb install -r "$tests" > "$out/install-tests.txt"
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
python3 -I "$kit/fixture.py" --port "$port" > "$out/fixture.log" 2>&1 9>&- &
fixture_pid=$!
for _ in $(seq 1 50); do curl --fail --silent "http://127.0.0.1:$port/__stats" > /dev/null && break; sleep 0.2; done
adb reverse "tcp:$port" "tcp:$port"
for theme in light dark; do
  adb shell cmd uimode night "$([[ $theme == dark ]] && echo yes || echo no)"
  adb shell am force-stop "$package"
  adb shell run-as "$package" rm -rf "files/t9-shots/$theme"
  adb shell am instrument -w -r -e t9_server "http://127.0.0.1:$port" -e t9_theme "$theme" \
    -e class io.orbitd.android.providerengine.ProviderEngineShotsTest "$runner" > "$out/instrumentation-$theme.txt" 2>&1 || true
  adb shell run-as "$package" tar -cf "files/t9-$theme.tar" -C files "t9-shots/$theme"
  adb exec-out run-as "$package" cat "files/t9-$theme.tar" > "$out/t9-$theme.tar"
  tar --no-same-owner -xf "$out/t9-$theme.tar" -C "$out"
  rm -f "$out/t9-$theme.tar"
done
curl --fail --silent "http://127.0.0.1:$port/__stats" > "$out/server-stats.json"
for theme in light dark; do
  grep -E 'OK \([0-9]+ tests?\)' "$out/instrumentation-$theme.txt" > /dev/null || { echo "instrumentation $theme did not pass" >&2; exit 1; }
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$out/instrumentation-$theme.txt"; then exit 1; fi
done
