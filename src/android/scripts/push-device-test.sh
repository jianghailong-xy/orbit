#!/usr/bin/env bash
# A10 controlled device checks: the real Application/Activity/notification tray/HTTP client. The test
# APK's PushTestRunner substitutes only token acquisition; messages are injected, never sent by FCM.
# Every phase records PASS/FAIL in result.txt; the exit code is nonzero if any selected phase failed.
# Optional: A10_PHASES (default "upgrade suite cold tray permission storage"), A10_TESTS (PushDeviceTest
# methods, comma separated), A10_NIGHT (yes|no) and A10_FONT_SCALE (e.g. 2.0) for an appearance pass.
# The upgrade phase needs A10_OLD_APK: a debug APK of an earlier release signed with the same key
# (482b132e8 created the DEFAULT needs-you channel).
set -euo pipefail
if (( $# < 3 || $# > 4 )); then
  echo 'Usage: push-device-test.sh APP_APK TEST_APK EVIDENCE_DIR [API29..36|SERIAL]' >&2
  exit 2
fi
apk="$(realpath "$1")"
tests="$(realpath "$2")"
output="$(realpath -m "$3")"
target="${4:-36}"
phases=" ${A10_PHASES:-upgrade suite cold tray permission storage} "
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
scripts="$(cd "$(dirname "$0")" && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
export PYTHONDONTWRITEBYTECODE=1 # The fixture imports cards-fixture.py; keep __pycache__ out of the checkout.
adb="$ANDROID_HOME/platform-tools/adb"
# Children never inherit the lock fd: a daemon started while holding it (an adb server, an emulator,
# the fixture) would keep the lock after this script exits. The server is started before the lock.
adbx() { "$adb" "$@" 9>&-; }
"$adb" start-server > /dev/null 2>&1 || true
package=io.orbitd.android.debug
runner="$package.test/io.orbitd.android.push.PushTestRunner"
port=18770
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
printf 'lock_wait_started_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
flock -w "${A10_LOCK_WAIT:-1800}" 9 || { echo 'Device busy; continue offline work and retry.' >&2; exit 75; }
printf 'scope=A10 controlled notification/navigation; injected messages and token, not FCM\nphases=%s\nstarted_utc=%s\n' \
  "$phases" "$(date -u +%FT%TZ)" >> "$output/result.txt"
serial=''
emulator_pid=''
started_unit=false
fixture_pid=''
owns_reverse=false
installed=false
old_night=''
old_font=''
failures=0
cleanup() {
  local result=$? failed=0
  if [[ "$installed" == true ]]; then
    adbx -s "$serial" shell am force-stop "$package" > /dev/null 2>&1 || failed=1
    adbx -s "$serial" shell cmd statusbar collapse > /dev/null 2>&1 || true
    adbx -s "$serial" shell rm -f /data/local/tmp/a10-window.xml > /dev/null 2>&1 || true
  fi
  if [[ -n "$old_night" ]]; then adbx -s "$serial" shell cmd uimode night "$old_night" > /dev/null 2>&1 || failed=1; fi
  if [[ -n "$old_font" ]]; then
    if [[ "$old_font" == null ]]; then adbx -s "$serial" shell settings delete system font_scale > /dev/null 2>&1 || failed=1
    else adbx -s "$serial" shell settings put system font_scale "$old_font" > /dev/null 2>&1 || failed=1; fi
  fi
  if [[ "$owns_reverse" == true ]]; then adbx -s "$serial" reverse --remove "tcp:$port" > /dev/null 2>&1 || failed=1; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$serial" ]]; then
    { adbx -s "$serial" reverse --list; adbx -s "$serial" shell cmd uimode night
      adbx -s "$serial" shell settings get system font_scale; } > "$output/restored.txt" 2>&1 || true
  fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
    timeout 20 "$adb" -s "$serial" wait-for-disconnect > /dev/null 2>&1 9>&- || failed=1
  fi
  if [[ "$started_unit" == true ]]; then systemctl stop orbit-android-emulator.service 9>&- || failed=1
    # Its emulator aborts on the unit's SIGINT, which marks the unit failed; leave it inactive as it was found.
    systemctl reset-failed orbit-android-emulator.service 9>&- 2> /dev/null || true; fi
  (( result == 0 && (failed != 0 || failures != 0) )) && result=1
  printf 'phase_failures=%s\ncleanup_failed=%s\nexit_code=%s\nfinished_utc=%s\n' "$failures" "$failed" "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT

if [[ "$target" =~ ^(29|3[0-6])$ ]]; then
  if [[ "$target" == 36 ]]; then
    serial=emulator-5554
    # The shared API 36 emulator is a systemd unit started on demand; one this run starts is stopped again.
    if ! adbx devices | grep -q "^$serial[[:space:]]"; then
      systemctl start orbit-android-emulator.service 9>&-
      started_unit=true
    fi
  else
    serial=emulator-5556
    if adbx devices | grep -q "^$serial[[:space:]]"; then echo 'Port 5556 in use; pass its serial explicitly' >&2; exit 75; fi
    "$ANDROID_HOME/emulator/emulator" -avd "orbit-ui-api$target" -port 5556 \
      -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader \
      -accel on -memory 2048 -cores 2 -camera-back none -camera-front none > "$output/emulator.log" 2>&1 9>&- &
    emulator_pid=$!
  fi
else
  serial="$target"
fi
timeout 300 "$adb" -s "$serial" wait-for-device 9>&-
deadline=$((SECONDS + 300))
until [[ "$(adbx -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
  (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
  sleep 2
done
api="$(adbx -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
# Emulators only: a physical phone on the same adb server is scheduled by the coordinator, never here.
[[ "$(adbx -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo "$serial is not an emulator" >&2; exit 2; }
export ANDROID_SERIAL="$serial"
{
  printf 'serial=%s\n' "$serial"
  for prop in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint ro.kernel.qemu; do
    printf '%s=%s\n' "$prop" "$(adbx -s "$serial" shell getprop "$prop" | tr -d '\r')"
  done
  adbx -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
} > "$output/device.txt"
adbx -s "$serial" reverse --list > "$output/reverse-before.txt"
if grep -q "tcp:$port" "$output/reverse-before.txt"; then echo "Reverse port $port is owned elsewhere" >&2; exit 75; fi
sha256sum "$apk" "$tests" "$scripts"/push-device-test.sh "$scripts"/push-cold-fixture.py "$scripts"/push-host-ui.py "$scripts"/push-channel-upgrade.py \
  "$scripts"/cards-fixture.py "$scripts"/../../shared/src/interaction-cards.fixture.json > "$output/inputs.sha256"
cmp "$scripts"/../../shared/src/interaction-cards.fixture.json "$scripts"/../app/src/androidTest/assets/push/interaction-cards.fixture.json
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" > /dev/null
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$apk" > "$output/signature.txt"
# A fresh installation: new notification channels, default permission state, no stored binding.
adbx -s "$serial" uninstall "$package.test" > /dev/null 2>&1 || true
adbx -s "$serial" uninstall "$package" > /dev/null 2>&1 || true
adbx -s "$serial" install "$apk" > "$output/install-app.txt"
adbx -s "$serial" install "$tests" > "$output/install-tests.txt"
installed=true
if [[ -n "${A10_NIGHT:-}" ]]; then
  old_night="$(adbx -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
  adbx -s "$serial" shell cmd uimode night "$A10_NIGHT"
fi
if [[ -n "${A10_FONT_SCALE:-}" ]]; then
  old_font="$(adbx -s "$serial" shell settings get system font_scale | tr -d '\r')"
  adbx -s "$serial" shell settings put system font_scale "$A10_FONT_SCALE"
fi
{ adbx -s "$serial" shell cmd uimode night; adbx -s "$serial" shell settings get system font_scale
  adbx -s "$serial" shell wm size; adbx -s "$serial" shell wm density; } > "$output/conditions.txt"
adbx -s "$serial" shell input keyevent KEYCODE_WAKEUP
adbx -s "$serial" shell wm dismiss-keyguard
start="$(adbx -s "$serial" shell date +%s | tr -d '\r').000"

passed() { # FILE: one passing JUnit selection, no failure markers
  grep -Eq 'OK \([0-9]+ tests?\)' "$1" && ! grep -Eq 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$1"
}
record() { # PHASE STATUS
  printf 'phase_%s=%s\n' "$1" "$2" >> "$output/result.txt"
  [[ "$2" != FAIL ]] || failures=$((failures + 1))
}
instrument() { # NAME CLASS[#METHOD] [EXTRA am OPTIONS...]
  local label="$1" selection="$2"; shift 2
  timeout 900 "$adb" -s "$serial" shell am instrument -w -r "$@" -e class "$selection" "$runner" > "$output/$label.txt" 2>&1 9>&- || true
  sed -n 's/.*a10_pid=\([0-9]*\).*/\1/p' "$output/$label.txt" | head -1 > "$output/$label.pid"
}
evidence() { # NAME: the app's evidence directory written so far
  adbx -s "$serial" exec-out run-as "$package" tar -C files -cf - a10-push > "$output/$1-evidence.tar" || true
}
cold=io.orbitd.android.push.ColdPushDeviceTest
fixture() {
  python3 "$scripts/push-cold-fixture.py" --port "$port" > "$output/fixture.log" 2>&1 9>&- &
  fixture_pid=$!
  for attempt in {1..50}; do curl --fail --silent "http://127.0.0.1:$port/__stats" > /dev/null && break; sleep 0.2; done
  kill -0 "$fixture_pid"
  adbx -s "$serial" reverse "tcp:$port" "tcp:$port"
  owns_reverse=true
}
tray_tap() { # Host-driven: a production process posts one entry, dies, and SystemUI starts the next one.
  instrument tray-login "$cold#trayLogin"
  passed "$output/tray-login.txt" || { echo 'tray_tap=FAIL (sign-in)' > "$output/tray.txt"; return 1; }
  # A launcher start: the production Application (no Firebase in this debug build) restores the login.
  adbx -s "$serial" shell am start -W -n "$package/io.orbitd.android.MainActivity" > "$output/tray-launch.txt"
  python3 "$scripts/push-host-ui.py" wait "$serial" 'Card fixture' "$output/tray-launch.xml" --timeout 30 --contains > "$output/tray.txt" 9>&-
  adbx -s "$serial" shell input keyevent KEYCODE_HOME
  sleep 2
  # --no-restart attaches to that running process and skips the force-stop that would cancel the entry.
  instrument tray-entry io.orbitd.android.push.ColdTrayEntryTest --no-restart
  adbx -s "$serial" shell dumpsys notification --noredact > "$output/tray-notifications-before.txt"
  if grep -Eq 'commandError=true|Unknown option' "$output/tray-entry.txt"; then
    echo 'tray_tap=NOT_RUN (this platform cannot attach an instrumentation with --no-restart)' >> "$output/tray.txt"
    return 1
  fi
  passed "$output/tray-entry.txt"
  grep -q "pkg=$package" "$output/tray-notifications-before.txt"
  local old_pid new_pid
  old_pid="$(adbx -s "$serial" shell pidof "$package" | tr -d '\r' || true)"
  adbx -s "$serial" shell am kill "$package"
  for attempt in {1..50}; do [[ -z "$(adbx -s "$serial" shell pidof "$package" | tr -d '\r' || true)" ]] && break; sleep 0.2; done
  if [[ -n "$(adbx -s "$serial" shell pidof "$package" | tr -d '\r' || true)" ]]; then
    adbx -s "$serial" shell run-as "$package" kill -9 "$old_pid"; sleep 1
  fi
  [[ -z "$(adbx -s "$serial" shell pidof "$package" | tr -d '\r' || true)" ]]
  adbx -s "$serial" shell dumpsys notification --noredact > "$output/tray-notifications-after-kill.txt"
  grep -q "pkg=$package" "$output/tray-notifications-after-kill.txt"
  adbx -s "$serial" shell cmd statusbar expand-notifications
  sleep 1
  adbx -s "$serial" exec-out screencap -p > "$output/tray-cold-shade.png"
  python3 "$scripts/push-host-ui.py" tap "$serial" 'A10 tray approval' "$output/tray-shade.xml" --timeout 20 >> "$output/tray.txt" 9>&-
  python3 "$scripts/push-host-ui.py" wait "$serial" 'Card verification' "$output/tray-session.xml" --timeout 45 >> "$output/tray.txt" 9>&-
  adbx -s "$serial" exec-out screencap -p > "$output/tray-cold-session.png"
  python3 "$scripts/push-host-ui.py" wait "$serial" 'Allow' "$output/tray-card.xml" --timeout 30 --scroll >> "$output/tray.txt" 9>&-
  new_pid="$(adbx -s "$serial" shell pidof "$package" | tr -d '\r')"
  adbx -s "$serial" shell dumpsys activity activities > "$output/tray-activities.txt"
  adbx -s "$serial" exec-out screencap -p > "$output/tray-cold-card.png"
  python3 "$scripts/push-host-ui.py" tap "$serial" 'Allow' "$output/tray-allow.xml" --timeout 10 >> "$output/tray.txt" 9>&-
  python3 "$scripts/push-host-ui.py" wait "$serial" 'Allowed · recorded by the server' "$output/tray-recorded.xml" --timeout 20 --contains >> "$output/tray.txt" 9>&-
  adbx -s "$serial" exec-out screencap -p > "$output/tray-cold-recorded.png"
  curl --fail --silent "http://127.0.0.1:$port/__stats" > "$output/tray-stats.json"
  printf 'old_pid=%s\nnew_pid=%s\n' "$old_pid" "$new_pid" >> "$output/tray.txt"
  [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]]
  python3 - "$output/tray-stats.json" <<'EOF'
import json, sys
stats = json.load(open(sys.argv[1]))
assert stats['final']['status'] == 'ALLOWED', stats['final']
assert stats['journal'][-1]['path'].endswith('/approvals/a1/decision'), stats['journal'][-1]
EOF
}

# 0. In-place upgrade from an earlier release: Android never raises an existing channel's importance,
# so the untouched DEFAULT needs-you channel must be replaced by the new HIGH one.
if [[ "$phases" == *" upgrade "* ]]; then
  [[ -f "${A10_OLD_APK:-}" ]] || { echo 'A10_OLD_APK is required for the upgrade phase' >&2; exit 2; }
  sha256sum "$A10_OLD_APK" > "$output/upgrade-old-apk.sha256"
  set +e
  (
    set -e
    adbx -s "$serial" uninstall "$package" > /dev/null 2>&1 || true
    adbx -s "$serial" install "$A10_OLD_APK" > "$output/upgrade-install-old.txt"
    uid() { adbx -s "$serial" shell pm list packages -U "$package" | tr -d '\r' | sed -n "s/^package:$package uid:\([0-9]*\)$/\1/p"; }
    old_uid="$(uid)"
    adbx -s "$serial" shell am start -W -n "$package/io.orbitd.android.MainActivity" > "$output/upgrade-launch-old.txt"
    sleep 3
    adbx -s "$serial" shell dumpsys notification > "$output/upgrade-channels-old.txt"
    adbx -s "$serial" shell am force-stop "$package"
    adbx -s "$serial" install -r "$apk" > "$output/upgrade-install-new.txt"
    printf 'uid_before=%s\nuid_after=%s\n' "$old_uid" "$(uid)" > "$output/upgrade-uid.txt"
    [[ -n "$old_uid" && "$(uid)" == "$old_uid" ]]
    adbx -s "$serial" shell am start -W -n "$package/io.orbitd.android.MainActivity" > "$output/upgrade-launch-new.txt"
    sleep 3
    adbx -s "$serial" shell dumpsys notification > "$output/upgrade-channels-new.txt"
    adbx -s "$serial" shell am force-stop "$package"
    python3 "$scripts/push-channel-upgrade.py" "$output/upgrade-channels-old.txt" "$output/upgrade-channels-new.txt" "$package" "$old_uid" \
      > "$output/upgrade.txt"
  )
  upgrade_status=$?
  set -e
  if (( upgrade_status == 0 )); then record upgrade PASS; else record upgrade FAIL; fi
  # The remaining phases start from a fresh installation again.
  adbx -s "$serial" uninstall "$package" > /dev/null 2>&1 || true
  adbx -s "$serial" install "$apk" > "$output/install-app-after-upgrade.txt"
fi

# 1. Warm-process suite with an in-process HTTP fixture (API 33+: permission granted for these journeys).
if (( api >= 33 )); then adbx -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS; fi
if [[ "$phases" == *" suite "* ]]; then
  selection=io.orbitd.android.push.PushDeviceTest
  [[ -n "${A10_TESTS:-}" ]] && selection="$(printf '%s' "$A10_TESTS" | sed 's/[^,]*/io.orbitd.android.push.PushDeviceTest#&/g')"
  instrument suite "$selection"
  evidence suite
  if passed "$output/suite.txt"; then record suite PASS; else record suite FAIL; fi
fi

# 2. Separate processes against a persistent host fixture.
if [[ "$phases" == *" cold "* || "$phases" == *" tray "* || "$phases" == *" permission "* || "$phases" == *" storage "* ]]; then fixture; fi
if [[ "$phases" == *" cold "* ]]; then
  adbx -s "$serial" shell run-as "$package" rm -rf files/a10-push
  instrument prepare "$cold#prepare"
  adbx -s "$serial" shell am force-stop "$package"
  instrument restore "$cold#restoreAndApprove"
  curl --fail --silent "http://127.0.0.1:$port/__stats" > "$output/restore-stats.json" || true
  adbx -s "$serial" shell am force-stop "$package"
  instrument signed-out "$cold#signedOutColdLinkOpensAfterLogin"
  evidence cold
  if passed "$output/prepare.txt" && passed "$output/restore.txt" && passed "$output/signed-out.txt" &&
      [[ -s "$output/prepare.pid" && "$(cat "$output/prepare.pid")" != "$(cat "$output/restore.pid")" ]]; then
    record cold PASS
  else record cold FAIL; fi
fi

# 3. A real tray tap into a process SystemUI starts. Finishing an instrumentation force-stops the target
# (cancelling its notifications) unless --no-restart is honoured; NOT_RUN records that limit.
if [[ "$phases" == *" tray "* ]]; then
  # Not as an `if` condition: bash ignores -e inside a function evaluated as a condition.
  set +e; ( set -e; tray_tap ); tray_status=$?; set -e
  if (( tray_status == 0 )); then echo 'tray_tap=PASS' >> "$output/tray.txt"; record tray PASS
  elif grep -q NOT_RUN "$output/tray.txt" 2>/dev/null; then record tray NOT_RUN
  else echo 'tray_tap=FAIL' >> "$output/tray.txt"; record tray FAIL; fi
  adbx -s "$serial" shell am force-stop "$package"
  adbx -s "$serial" shell cmd statusbar collapse || true
fi

# 4. First signed-in foreground on Android 13+: one system request, refused, business still works.
if [[ "$phases" == *" permission "* ]] && (( api >= 33 )); then
  # Fresh-installation state (no login, no push storage, new channels), as the first sign-in sees it.
  adbx -s "$serial" shell pm clear "$package" > "$output/permission-clear.txt"
  adbx -s "$serial" shell pm revoke "$package" android.permission.POST_NOTIFICATIONS
  adbx -s "$serial" shell pm clear-permission-flags "$package" android.permission.POST_NOTIFICATIONS user-set user-fixed
  instrument permission "$cold#permissionPrompt"
  evidence permission
  if passed "$output/permission.txt"; then record permission PASS; else record permission FAIL; fi
fi

# 5. Android 13+ with push storage that cannot be written (a file where its directory goes): the
# permission request must still work and the app must stay up.
if [[ "$phases" == *" storage "* ]] && (( api >= 33 )); then
  adbx -s "$serial" shell pm clear "$package" > "$output/storage-clear.txt"
  # One string: adb shell joins its arguments, so a separately quoted `sh -c` script would be re-split.
  adbx -s "$serial" shell "run-as $package sh -c 'mkdir -p no_backup && rm -rf no_backup/push && echo blocked > no_backup/push'"
  adbx -s "$serial" shell "run-as $package ls -l no_backup" > "$output/storage-blocked.txt"
  adbx -s "$serial" shell pm revoke "$package" android.permission.POST_NOTIFICATIONS
  adbx -s "$serial" shell pm clear-permission-flags "$package" android.permission.POST_NOTIFICATIONS user-set user-fixed
  instrument storage "$cold#permissionPromptSurvivesUnwritablePushStorage"
  evidence storage
  adbx -s "$serial" shell run-as "$package" rm -f no_backup/push || true
  if passed "$output/storage.txt"; then record storage PASS; else record storage FAIL; fi
fi

for label in suite prepare restore signed-out tray-login tray-entry permission storage; do
  pid="$(cat "$output/$label.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then adbx -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/$label-logcat.txt" 2>&1 || true; fi
done
adbx -s "$serial" logcat -d -v threadtime -T "$start" > "$output/device-logcat.txt" 2>&1 || true
if grep -E 'a08-fixture-(access|refresh)|a10-controlled-(access|refresh|device-token)|controlled-password' "$output"/*-logcat.txt; then
  echo 'Credential or token marker found in logcat' >&2; record logcat FAIL
fi
(( failures == 0 )) && echo 'Selected controlled notification/navigation phases passed; this is not FCM delivery evidence.'
exit $(( failures == 0 ? 0 : 1 ))
