#!/usr/bin/env bash
set -euo pipefail
if (( $# != 2 )); then echo 'Usage: push-cold-device-test.sh EVIDENCE_DIR SERIAL (APKs already installed)' >&2; exit 2; fi
output="$(realpath -m "$1")"
serial="$2"
adb="${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb"
package=io.orbitd.android.debug
runner="$package.test/io.orbitd.android.push.PushTestRunner"
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
exec 9>/var/lib/orbit/android/ui.lock
flock -n 9 || { echo 'Device busy; continue offline work.' >&2; exit 75; }
fixture_pid=''
permission=''
owns_reverse=false
device_ready=false
cleanup() {
  local result=$?
  local cleanup_result=0
  if [[ "$device_ready" == true ]]; then "$adb" -s "$serial" shell am force-stop "$package" > "$output/force-stop-final.txt" 2>&1 || cleanup_result=1; fi
  if [[ "$owns_reverse" == true ]]; then "$adb" -s "$serial" reverse --remove tcp:18770 > "$output/remove-reverse.txt" 2>&1 || cleanup_result=1; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ "$permission" == true ]]; then "$adb" -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS > "$output/restore-permission.txt" 2>&1 || cleanup_result=1;
  elif [[ "$permission" == false ]]; then "$adb" -s "$serial" shell pm revoke "$package" android.permission.POST_NOTIFICATIONS > "$output/restore-permission.txt" 2>&1 || cleanup_result=1; fi
  "$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-after.txt" 2>&1 || cleanup_result=1
  printf '%s\n' "$cleanup_result" > "$output/cleanup-exit-code.txt"
  if (( result == 0 && cleanup_result != 0 )); then result=1; fi
  printf '%s\n' "$result" > "$output/exit-code.txt"
  exit "$result"
}
trap cleanup EXIT
"$adb" -s "$serial" reverse --list > "$output/reverse-before.txt"
if awk '$2 == "tcp:18770" { found=1 } END { exit !found }' "$output/reverse-before.txt"; then
  echo 'Reverse port 18770 is already owned; use a separate device run.' >&2; exit 75
fi
device_ready=true
"$adb" -s "$serial" shell getprop > "$output/device.txt"
"$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-before.txt"
"$adb" -s "$serial" shell run-as "$package" rm -rf files/a10-push
"$adb" -s "$serial" shell pm path "$package" > "$output/installed-apk-path.txt"
installed_apk="$(sed -n 's/^package://p' "$output/installed-apk-path.txt" | head -1 | tr -d '\r')"
"$adb" -s "$serial" shell sha256sum "$installed_apk" > "$output/installed-apk.sha256"
"$adb" -s "$serial" shell pm path "$package.test" > "$output/installed-test-apk-path.txt"
installed_tests="$(sed -n 's/^package://p' "$output/installed-test-apk-path.txt" | head -1 | tr -d '\r')"
"$adb" -s "$serial" shell sha256sum "$installed_tests" > "$output/installed-test-apk.sha256"
sha256sum "$0" "$(dirname "$0")/push-cold-fixture.py" "$(dirname "$0")/cards-fixture.py" \
  "$(dirname "$0")/../../shared/src/interaction-cards.fixture.json" > "$output/fixture-sources.sha256"
api="$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
if (( api >= 33 )); then
  if rg -q 'android.permission.POST_NOTIFICATIONS: granted=true' "$output/package-before.txt"; then permission=true; else permission=false; fi
  "$adb" -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS
fi
python3 "$(dirname "$0")/push-cold-fixture.py" --port 18770 > "$output/fixture.log" 2>&1 &
fixture_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18770/__stats > /dev/null; then break; fi
  sleep 0.2
done
kill -0 "$fixture_pid"
"$adb" -s "$serial" reverse tcp:18770 tcp:18770
owns_reverse=true
run_case() {
  local method="$1"
  "$adb" -s "$serial" shell am instrument -w -r -e class "io.orbitd.android.push.ColdPushDeviceTest#$method" "$runner" > "$output/$method.txt" 2>&1
  "$adb" -s "$serial" exec-out run-as "$package" tar -C files/a10-push -cf - . > "$output/$method-evidence.tar"
  curl --fail --silent http://127.0.0.1:18770/__stats > "$output/$method-stats.json"
  rg -q 'OK \(1 test\)' "$output/$method.txt"
  ! rg -q 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/$method.txt"
}
run_case prepare
"$adb" -s "$serial" shell am force-stop "$package" > "$output/cold-force-stop.txt"
run_case restoreAndApprove
if (( api >= 33 )); then
  "$adb" -s "$serial" shell pm revoke "$package" android.permission.POST_NOTIFICATIONS
  run_case runtimePermissionDeniedStillAllowsApproval
fi
echo 'Controlled cold process/authentication/approval checks passed; no FCM receipt claim.'
