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
adb_bin="$ANDROID_HOME/platform-tools/adb"
# Every adb call closes the lock's fd 9: an adb server it forks would otherwise inherit the lock and hold it for good.
adb() { "$adb_bin" "$@" 9>&-; }
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
emulator_pid=''
night=''
handwriting=''
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 600 9
cleanup() {
  local result=$?
  # The emulator is shared: give it back in the night mode and stylus setting it had.
  if [[ -n "$night" ]]; then adb -s "$serial" shell cmd uimode night "$night" > /dev/null || true; fi
  if [[ "$handwriting" == null ]]; then adb -s "$serial" shell settings delete secure stylus_handwriting_enabled > /dev/null || true
  elif [[ -n "$handwriting" ]]; then adb -s "$serial" shell settings put secure stylus_handwriting_enabled "$handwriting" > /dev/null || true; fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
}
trap cleanup EXIT
printf 'scope=A03 auth and secure persistence, A03c login page; fixture accounts only\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
if [[ -z "$serial" ]]; then
  if [[ "$api" == 36 ]]; then
    serial=emulator-5554
  else
    serial=emulator-5556
    if adb devices | grep -q "^$serial[[:space:]]"; then
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
timeout 300 "$adb_bin" -s "$serial" wait-for-device 9>&-
deadline=$((SECONDS + 300))
until [[ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
  (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
  sleep 2
done
[[ "$(adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" == "$api" ]]
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint \
      ro.build.version.security_patch ro.kernel.qemu ro.com.google.gmsversion; do
    printf '%s=%s\n' "$property" "$(adb -s "$serial" shell getprop "$property" | tr -d '\r')"
  done
  adb -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$apk" > "$output/signature.txt"
adb -s "$serial" install -r "$apk" > "$output/install-app.txt"
adb -s "$serial" install -r "$tests" > "$output/install-tests.txt"
adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
adb -s "$serial" shell wm dismiss-keyguard

run_test() {
  local name="$1" class="$2" count="$3"
  shift 3
  adb -s "$serial" shell am force-stop "$package"
  local start
  start="$(adb -s "$serial" shell date +%s | tr -d '\r').000"
  adb -s "$serial" shell am instrument -w -r -e class "$class" "$@" "$runner" > "$output/$name.txt" 2>&1
  local pid
  # Instrumentation exits its process before this call returns; pidof would miss every log.
  pid="$(python3 - "$output/$name.txt" <<'PY'
import pathlib, re, sys
pids = set(re.findall(r'a03_pid=(\d+)', pathlib.Path(sys.argv[1]).read_text()))
assert len(pids) == 1, 'Missing or ambiguous instrumentation PID'
print(pids.pop())
PY
)"
  adb -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/$name-logcat.txt"
  [[ -s "$output/$name-logcat.txt" ]] || { echo 'Missing process logcat' >&2; exit 1; }
  grep -F "OK ($count test" "$output/$name.txt" >/dev/null
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/$name.txt"; then
    exit 1
  fi
}
run_test secure-store io.orbitd.android.auth.CredentialStoreDeviceTest 5
for phase in seed rotate logout verify-cleared; do
  run_test "persistence-$phase" io.orbitd.android.auth.PersistenceDeviceTest 1 -e a03_phase "$phase"
done
run_test login-ui io.orbitd.android.auth.AuthFlowDeviceTest 1
# A03c: the login page with the system light, then dark; the dark process also reads what the light one remembered.
night="$(adb -s "$serial" shell cmd uimode night | tr -d '\r' | sed -n 's/^Night mode: //p')"
# API 34+ Gboard opens its stylus tutorial over a focused field and covers the screenshots: off for these runs, as A11's.
if (( api >= 34 )); then
  handwriting="$(adb -s "$serial" shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
  adb -s "$serial" shell settings put secure stylus_handwriting_enabled 0
fi
[[ "$night" =~ ^(yes|no|auto|custom)$ ]] || { echo "Unreadable night mode: $night" >&2; exit 1; }
for phase in light dark; do
  adb -s "$serial" shell cmd uimode night "$([[ "$phase" == dark ]] && echo yes || echo no)" > /dev/null
  run_test "login-page-$phase" io.orbitd.android.auth.LoginPageDeviceTest 1 -e a03c_phase "$phase"
done
adb -s "$serial" shell cmd uimode night "$night" > /dev/null
adb -s "$serial" pull "/sdcard/Android/data/$package/files/a03-auth" "$output/screenshots" > "$output/pull.txt" 2>&1
adb -s "$serial" pull "/sdcard/Android/data/$package/files/a03c-login" "$output/login-screenshots" >> "$output/pull.txt" 2>&1
python3 - "$output" <<'PY'
import pathlib
import re
import sys
root = pathlib.Path(sys.argv[1])
pids = []
for phase in ('seed', 'rotate', 'logout', 'verify-cleared'):
    text = (root / f'persistence-{phase}.txt').read_text()
    assert f'a03_phase={phase}' in text
    pids.append(re.search(r'a03_pid=(\d+)', text).group(1))
assert len(set(pids)) == 4, 'Persistence phases must run in different processes'
assert len(list(root.glob('*-logcat.txt'))) == 8, 'Every test process needs captured logs'
shots = sorted(p.name for p in (root / 'login-screenshots').glob('*.png'))
assert len(shots) == 12, f'Expected six login screenshots per phase: {shots}'
for log in root.glob('*.txt'):
    content = log.read_bytes()
    for secret in (b'a03-device-access', b'a03-device-refresh', b'a03-device-password',
                   b'a03c-device-access', b'a03c-device-refresh', b'a03c-device-password', b'a03c-wrong-password'):
        assert secret not in content, f'Fixture credential in {log.name}'
(root / 'checks.txt').write_text('11 device tests passed; 4 distinct persistence processes; light and dark login page: 12 screenshots; '
                                 'fixture credentials absent from captured output/logcat\n')
PY
printf 'PASS: A03 API%s; evidence: %s\n' "$api" "$output"
