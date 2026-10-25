#!/usr/bin/env bash
# A10 real Firebase token check on the shared API 36 emulator (Google APIs image: Google Play services, no Play
# Store). Builds the release package with the five public ORBIT_ANDROID_FIREBASE_* client values (export them first,
# for example `set -a; . android-client.env; set +a`) and a throwaway signing key, then runs FcmTokenDeviceTest with
# the default runner: Google issues the token, the app registers it with the controlled fixture, and a deleted token
# is replaced through onNewToken and registered again. Nothing is sent, so this is not an FCM delivery; sending needs
# the backend's service account. The output records that the values were supplied and reached BuildConfig, never
# the values themselves, and the fixture keeps only a SHA-256 prefix, length and shape of each token.
set -euo pipefail
(( $# == 1 )) || { echo 'Usage: push-fcm-emulator.sh EVIDENCE_DIR' >&2; exit 2; }
output="$(realpath -m "$1")"
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
package=io.orbitd.android
scripts="$(cd "$(dirname "$0")" && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export PYTHONDONTWRITEBYTECODE=1 # The fixture imports cards-fixture.py; keep __pycache__ out of the checkout.
adb="$ANDROID_HOME/platform-tools/adb"
build="$output/build"
bash "$scripts/push-fcm-build.sh" "$build"
sha256sum "$scripts/push-fcm-emulator.sh" "$scripts/push-cold-fixture.py" "$scripts/cards-fixture.py" >> "$build/inputs.sha256"

# Device, under the same discipline as push-device-test.sh: the adb server starts before the lock and no child
# inherits the lock fd. Only the emulator; a physical phone on the same adb server is the coordinator's.
adbx() { "$adb" "$@" 9>&-; }
"$adb" start-server > /dev/null 2>&1 || true
serial=emulator-5554
port=18770
started_unit=false
fixture_pid=''
owns_reverse=false
installed=false
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
printf 'lock_wait_started_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
flock -w "${A10_LOCK_WAIT:-1800}" 9 || { echo 'Device busy; continue offline work and retry.' >&2; exit 75; }
printf 'scope=A10 real Firebase token issuance and rotation on the emulator; nothing is sent, not an FCM delivery\nstarted_utc=%s\n' \
  "$(date -u +%FT%TZ)" >> "$output/result.txt"
cleanup() {
  local result=$? failed=0
  if [[ "$installed" == true ]]; then
    adbx -s "$serial" uninstall "$package.test" > /dev/null 2>&1 || failed=1
    adbx -s "$serial" uninstall "$package" > /dev/null 2>&1 || failed=1
    adbx -s "$serial" shell rm -rf /data/local/tmp/a10-fcm > /dev/null 2>&1 || true
  fi
  if [[ "$owns_reverse" == true ]]; then adbx -s "$serial" reverse --remove "tcp:$port" > /dev/null 2>&1 || failed=1; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ "$started_unit" == true ]]; then systemctl stop orbit-android-emulator.service 9>&- || failed=1
    # Its emulator aborts on the unit's SIGINT, which marks the unit failed; leave it inactive as it was found.
    systemctl reset-failed orbit-android-emulator.service 9>&- 2> /dev/null || true; fi
  (( result == 0 && failed != 0 )) && result=1
  printf 'cleanup_failed=%s\nexit_code=%s\nfinished_utc=%s\n' "$failed" "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
# The shared API 36 emulator is a systemd unit started on demand; one this run starts is stopped again.
if ! adbx devices | grep -q "^$serial[[:space:]]"; then
  systemctl start orbit-android-emulator.service 9>&-
  started_unit=true
fi
timeout 300 "$adb" -s "$serial" wait-for-device 9>&-
deadline=$((SECONDS + 300))
until [[ "$(adbx -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
  (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
  sleep 2
done
[[ "$(adbx -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo "$serial is not an emulator" >&2; exit 2; }
{
  printf 'serial=%s\nstarted_emulator_unit=%s\n' "$serial" "$started_unit"
  for prop in ro.product.model ro.product.name ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$prop" "$(adbx -s "$serial" shell getprop "$prop" | tr -d '\r')"
  done
  adbx -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
  printf 'play_store_packages=%s\n' "$(adbx -s "$serial" shell pm list packages com.android.vending | grep -c . || true)"
} > "$output/device.txt"
adbx -s "$serial" reverse --list > "$output/reverse-before.txt"
if grep -q "tcp:$port" "$output/reverse-before.txt"; then echo "Reverse port $port is owned elsewhere" >&2; exit 75; fi
# The release package can only replace one signed by the same key; an earlier copy on the emulator is removed first.
if adbx -s "$serial" shell pm list packages "$package" | tr -d '\r' | grep -qx "package:$package"; then
  adbx -s "$serial" shell dumpsys package "$package" | grep -m2 -E 'versionName|versionCode' > "$output/removed-earlier-install.txt" || true
  adbx -s "$serial" uninstall "$package" >> "$output/removed-earlier-install.txt"
fi
adbx -s "$serial" uninstall "$package.test" > /dev/null 2>&1 || true
installed=true
adbx -s "$serial" install "$build/app-release.apk" > "$output/install-app.txt"
adbx -s "$serial" install -t "$build/app-release-androidTest.apk" > "$output/install-tests.txt"
python3 "$scripts/push-cold-fixture.py" --port "$port" --bundle-id "$package" > "$output/fixture.log" 2>&1 9>&- &
fixture_pid=$!
for attempt in {1..50}; do curl --fail --silent "http://127.0.0.1:$port/__stats" > /dev/null && break; sleep 0.2; done
kill -0 "$fixture_pid"
adbx -s "$serial" reverse "tcp:$port" "tcp:$port" > /dev/null
owns_reverse=true
adbx -s "$serial" shell input keyevent KEYCODE_WAKEUP
adbx -s "$serial" shell wm dismiss-keyguard
adbx -s "$serial" logcat -c
test_class=io.orbitd.android.push.FcmTokenDeviceTest
failures=0
instrument() { # NAME METHOD
  timeout 600 "$adb" -s "$serial" shell am instrument -w -r -e a10_server "http://127.0.0.1:$port" \
    -e class "$test_class#$2" "$package.test/androidx.test.runner.AndroidJUnitRunner" > "$output/$1.txt" 2>&1 9>&- || true
  if grep -Eq 'OK \(1 test\)' "$output/$1.txt" && ! grep -Eq 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/$1.txt"; then
    echo "$1=PASS" >> "$output/result.txt"
  else
    echo "$1=FAIL" >> "$output/result.txt"; failures=$((failures + 1)); return 1
  fi
}
stats() { # [PYTHON SUBSCRIPT]: the fixture's push record, or one field of it
  curl --fail --silent "http://127.0.0.1:$port/__stats" \
    | python3 -c "import json, sys; v = json.load(sys.stdin)['push']$1; print(v if isinstance(v, str) else json.dumps(v, indent=2))"
}
if instrument fcm_token googleIssuesTheTokenAndARotatedTokenIsRegisteredAgain; then
  # Receive path of the release build: the stopped app gets one FCM-shaped data message through Firebase's own
  # receiver. Only Google Play services may send that broadcast; root stands in for it, so this checks the
  # receiver/service/notification chain and the P07 log line, not an FCM delivery.
  event="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  payload='{"kind":"agent-message","title":"A10 receive path","body":"Firebase receiver to Orbit notification (root broadcast, not FCM)."}'
  printf "am broadcast -f 0x20 -n %s/com.google.firebase.iid.FirebaseInstanceIdReceiver -a com.google.android.c2dm.intent.RECEIVE --es google.message_id a10-%s --es version 1 --es type alert --es registrationKey %s --es eventId %s --es notificationKey %s --es sentAt %s --es payload '%s'\n" \
    "$package" "$event" "$(stats "['registrationKey']")" "$event" "$event" "$(date -u +%FT%T.000Z)" "$payload" > "$build/broadcast.sh"
  # Restarting adbd (root, unroot) drops every adb reverse mapping; the woken app reads authority from the fixture.
  adbd_restart() { adbx -s "$serial" "$1" > /dev/null; timeout 60 "$adb" -s "$serial" wait-for-device 9>&-
    adbx -s "$serial" reverse "tcp:$port" "tcp:$port" > /dev/null; }
  adbd_restart root
  adbx -s "$serial" push "$build/broadcast.sh" /data/local/tmp/a10-fcm/broadcast.sh > /dev/null
  adbx -s "$serial" shell sh /data/local/tmp/a10-fcm/broadcast.sh > "$output/receive-broadcast.txt" 2>&1 || true
  received=FAIL
  for attempt in {1..60}; do
    if adbx -s "$serial" shell dumpsys notification --noredact | grep -q "orbit:$(stats "['registrationKey']"):$event"; then received=PASS; break; fi
    sleep 1
  done
  adbd_restart unroot
  adbx -s "$serial" exec-out screencap -p > "$output/receive-path-tray.png" || true
  adbx -s "$serial" shell cmd statusbar expand-notifications > /dev/null 2>&1 || true
  sleep 2
  adbx -s "$serial" exec-out screencap -p > "$output/receive-path-shade.png" || true
  adbx -s "$serial" shell cmd statusbar collapse > /dev/null 2>&1 || true
  adbx -s "$serial" logcat -d -s OrbitPush:I > "$output/logcat-orbitpush.txt" || true
  grep -q "received eventId=$event type=alert" "$output/logcat-orbitpush.txt" || received=FAIL
  echo "receive_path=$received" >> "$output/result.txt"
  [[ "$received" == PASS ]] || failures=$((failures + 1))
  instrument sign_out signOutUnregistersTheRestoredBinding || true
fi
stats "" > "$output/fixture-push.json" || true
adbx -s "$serial" pull /data/local/tmp/a10-fcm "$output/screens" > /dev/null 2>&1 || true
rm -f "$output/screens/broadcast.sh"
# The whole log of the run, with anything shaped like a token masked, and the Firebase lines on their own.
adbx -s "$serial" logcat -d -v threadtime | sed -E 's/[A-Za-z0-9_-]+:APA91b[A-Za-z0-9_-]+/<fcm-token>/g' > "$output/logcat.txt" || true
grep -E 'Firebase|FCM|GmsRpc|OrbitPush|AndroidRuntime' "$output/logcat.txt" > "$output/logcat-firebase.txt" || true
adbx -s "$serial" shell dumpsys activity activities | grep -E 'io\.orbitd|ResumedActivity' > "$output/activities.txt" || true
printf 'failures=%s\n' "$failures" >> "$output/result.txt"
(( failures == 0 ))
