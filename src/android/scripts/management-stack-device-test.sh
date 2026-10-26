#!/usr/bin/env bash
# A13c and A13d on A11's isolated real stack (scripts/a11-stack; no fixture): RunnerStackDeviceTest reads back runners that report
# Antigravity through the real runner API (a11-stack/seed-a13c.mjs registers them and heartbeats), and A13dStackDeviceTest makes the
# Settings writes — smart model selection, a revoked access token, the runners' order and a removed runner, Kimi's site on a sign-in
# start — and reads each back from the server with the account's own token (a11-stack/seed-a13d.mjs seeds and heartbeats). Both run
# in one hold of the device lock, signed in as the stack's owner through `adb reverse` of the stack's port. The stack must be up and
# seeded (`setup.sh reset`); export the same A11_STACK_DIR / A11_STACK_API_PORT as for setup.sh. EVIDENCE_DIR gets the server's
# answers before and after, each class's instrumentation output and logcat, and its captures (a13c-stack/, a13d-stack/).
set -euo pipefail

if (( $# < 3 || $# > 4 )); then
  echo "Usage: $0 APP_APK TEST_APK EVIDENCE_DIR [SERIAL]" >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
serial="${4:-${ANDROID_DEVICE_SERIAL:-emulator-5554}}"
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
export A11_STACK_DIR="${A11_STACK_DIR:-/var/tmp/a11-stack}"
export A11_STACK_API_PORT="${A11_STACK_API_PORT:-3711}"
port="$A11_STACK_API_PORT"
server="http://127.0.0.1:$port"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
adb_bin="$ANDROID_HOME/platform-tools/adb"
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
[[ -f "$A11_STACK_DIR/accounts.json" ]] || { echo "No seeded stack at $A11_STACK_DIR (run setup.sh reset first)" >&2; exit 2; }
curl --fail --silent "$server/api/health" > "$output/stack-health.json"
cat "$A11_STACK_DIR/SOURCE_SHA" > "$output/stack-source-sha.txt" 2>/dev/null || true
# The runners the tests read are fed by the seeders while the device runs; both stop with this script.
helpers=()
node_env() { env -i PATH="$PATH" HOME="${HOME:-/root}" A11_STACK_DIR="$A11_STACK_DIR" A11_STACK_API_PORT="$A11_STACK_API_PORT" "$@"; }
node_env node "$here/a11-stack/seed-a13d.mjs" seed > "$output/seed-a13d.txt" 2>&1
node_env node "$here/a11-stack/seed-a13d.mjs" reset >> "$output/seed-a13d.txt" 2>&1
node_env node "$here/a11-stack/seed-a13c.mjs" run > "$output/heartbeat-a13c.txt" 2>&1 & helpers+=($!)
node_env node "$here/a11-stack/seed-a13d.mjs" run > "$output/heartbeat-a13d.txt" 2>&1 & helpers+=($!)
# The adb server starts before the lock is taken, and every adb call closes the lock's fd: a daemon forked while the
# lock is held would keep it after this script exits.
"$adb_bin" start-server
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-1800}" 9
adb() { "$adb_bin" -s "$serial" "$@" 9>&-; }
cleanup() {
  local result=$?
  for pid in "${helpers[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  adb shell am force-stop "$package" >/dev/null 2>&1 || true
  adb reverse --remove "tcp:$port" >/dev/null 2>&1 || true
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A13c RunnerStackDeviceTest + A13d A13dStackDeviceTest on the A11 isolated real stack (server %s, port %s) via adb reverse; %s\nstarted_utc=%s\n' \
  "$(cat "$output/stack-source-sha.txt" 2>/dev/null)" "$port" "$serial" "$(date -u +%FT%TZ)" > "$output/result.txt"
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted" >&2; exit 1; }
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$property" "$(adb shell getprop "$property" | tr -d '\r')"
  done
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
adb uninstall "$package" > "$output/uninstall-app.txt" 2>&1 || true
adb uninstall "$package.test" > "$output/uninstall-tests.txt" 2>&1 || true
adb install -r "$apk" > "$output/install-app.txt"
adb install -r "$tests" > "$output/install-tests.txt"
adb reverse "tcp:$port" "tcp:$port" >> "$output/result.txt"
# Every runner has reported at least once before the pages are read.
sleep 25
node_env node "$here/a11-stack/seed-a13c.mjs" dump "$output/server-a13c-before.json" > /dev/null
node_env node "$here/a11-stack/seed-a13d.mjs" dump "$output/server-a13d-before.json" > /dev/null
read -r email password < <(python3 -c "import json,sys;a=json.load(open(sys.argv[1]))['owner'];print(a['email'],a['password'])" "$A11_STACK_DIR/accounts.json")
failed=0
for pass in a13c a13d; do
  case "$pass" in
    a13c) class=io.orbitd.android.management.RunnerStackDeviceTest ;;
    a13d) class=io.orbitd.android.management.A13dStackDeviceTest ;;
  esac
  adb shell pm clear "$package" > "$output/pm-clear-$pass.txt"
  adb shell am force-stop "$package"
  start="$(adb shell date +%s | tr -d '\r').000"
  timeout "${STACK_INSTRUMENT_TIMEOUT:-900}" "$adb_bin" -s "$serial" shell am instrument -w -r -e class "$class" \
    -e "${pass}Server" "$server" -e "${pass}Email" "$email" -e "${pass}Password" "$password" \
    "$runner" > "$output/instrumentation-$pass.txt" 2>&1 9>&- || true
  adb logcat -d -v threadtime -T "$start" > "$output/logcat-$pass.txt" || true
  if grep -F -q -- "$password" "$output/logcat-$pass.txt" || grep -E -q 'eyJhbGciOi' "$output/logcat-$pass.txt"; then
    echo "Stack credential or token found in logcat ($pass)" >&2; failed=1
  fi
  adb exec-out run-as "$package" tar -cf - -C files "$pass-stack" > "$output/captures-$pass.tar" || true
  tar --no-same-owner -xf "$output/captures-$pass.tar" -C "$output" || true
  rm -f "$output/captures-$pass.tar"
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation-$pass.txt" || \
     ! grep -F -q 'OK (1 test)' "$output/instrumentation-$pass.txt"; then failed=1; fi
done
node_env node "$here/a11-stack/seed-a13c.mjs" dump "$output/server-a13c-after.json" > /dev/null || true
node_env node "$here/a11-stack/seed-a13d.mjs" dump "$output/server-a13d-after.json" > /dev/null || true
chmod -R a+rX "$output"
exit "$failed"
