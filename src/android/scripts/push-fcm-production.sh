#!/usr/bin/env bash
# A10 real FCM delivery on the shared API 36 emulator. The release package (push-fcm-build.sh; export the five
# ORBIT_ANDROID_FIREBASE_* values first) signs in to SERVER (orbitd.io by default) with the account in LOGIN_ENV
# (ORBIT_LOGIN_EMAIL, ORBIT_LOGIN_PASSWORD: pushed to the device for RealPushDeviceTest, removed right after sign-in)
# and registers Google's token there. The server then sends real pushes, triggered by this Orbit session through the
# orbit CLI, and the device is read after each step:
#   background   Orbit stopped in the background; `orbit notify`; the tray entry is opened.
#   killed       Orbit's process killed (not force-stopped); `orbit notify`; the tray entry is swiped away.
#   foreground   Orbit on screen; `orbit notify`; the entry joins the tray silently.
#   crossdevice  a scratch session parks on an approval (needs-you push); ending it here makes the approval stale,
#                and the server's sync push must take the entry away.
# Each notify and the approval alert every device of the account, phone and Mac included. The run ends signed out
# (unregistered). A loopback SERVER (http://127.0.0.1:PORT) runs push-cold-fixture.py instead: sign-in, registration
# and sign-out only, nothing is sent.
# Optional: A10_STEPS (default "background killed foreground crossdevice").
set -euo pipefail
(( $# == 2 || $# == 3 )) || { echo 'Usage: push-fcm-production.sh LOGIN_ENV EVIDENCE_DIR [SERVER]' >&2; exit 2; }
login="$(realpath "$1")"
output="$(realpath -m "$2")"
server="${3:-https://orbitd.io}"
[[ -r "$login" ]] || { echo 'LOGIN_ENV must be a readable file' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
package=io.orbitd.android
scripts="$(cd "$(dirname "$0")" && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export PYTHONDONTWRITEBYTECODE=1
adb="$ANDROID_HOME/platform-tools/adb"
orbit=/usr/local/bin/orbit
steps=" ${A10_STEPS-background killed foreground crossdevice} "
fixture_port=''
if [[ "$server" =~ ^http://127\.0\.0\.1:([0-9]+)$ ]]; then fixture_port="${BASH_REMATCH[1]}"; steps=' '; fi
build="$output/build"
bash "$scripts/push-fcm-build.sh" "$build"
sha256sum "$scripts/push-fcm-production.sh" "$scripts/push-host-ui.py" >> "$build/inputs.sha256"

# Device, under the same discipline as push-device-test.sh: the adb server starts before the lock and no child
# inherits the lock fd. Only the emulator; a physical phone on the same adb server is the coordinator's.
adbx() { "$adb" "$@" 9>&-; }
"$adb" start-server > /dev/null 2>&1 || true
serial=emulator-5554
remote=/data/local/tmp/a10-real
started_unit=false
installed=false
signed_in=false
fixture_pid=''
scratch=''
failures=0
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
printf 'lock_wait_started_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
flock -w "${A10_LOCK_WAIT:-1800}" 9 || { echo 'Device busy; retry later.' >&2; exit 75; }
printf 'scope=A10 real FCM delivery from %s to the emulator\nsteps=%s\nstarted_utc=%s\n' "$server" "$steps" \
  "$(date -u +%FT%TZ)" >> "$output/result.txt"
record() { printf '%s=%s\n' "$1" "$2" >> "$output/result.txt"; [[ "$2" == PASS ]] || failures=$((failures + 1)); }
instrument() { # NAME METHOD
  timeout 600 "$adb" -s "$serial" shell am instrument -w -r -e a10_server "$server" \
    -e class "io.orbitd.android.push.RealPushDeviceTest#$2" "$package.test/androidx.test.runner.AndroidJUnitRunner" \
    > "$output/$1.txt" 2>&1 9>&- || true
  grep -Eq 'OK \(1 test\)' "$output/$1.txt" && ! grep -Eq 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/$1.txt"
}
cleanup() {
  local result=$? failed=0
  adbx -s "$serial" shell rm -f "$remote/login.env" > /dev/null 2>&1 || true
  if [[ -n "$scratch" ]]; then "$orbit" session end "$scratch" --json > "$output/crossdevice-end-cleanup.json" 2>&1 9>&- || true; fi
  if [[ "$signed_in" == true ]]; then instrument sign-out-cleanup signOutAndUnregister || failed=1; fi
  adbx -s "$serial" logcat -d -v epoch -s OrbitPush:I A10Real:I > "$output/logcat-orbitpush.txt" 2>&1 || true
  adbx -s "$serial" logcat -d -v epoch -b events -e 'io\.orbitd\.android' > "$output/logcat-events.txt" 2>&1 || true
  if [[ "$installed" == true ]]; then
    adbx -s "$serial" uninstall "$package.test" > /dev/null 2>&1 || true
    adbx -s "$serial" uninstall "$package" > /dev/null 2>&1 || failed=1
  fi
  adbx -s "$serial" shell rm -rf "$remote" > /dev/null 2>&1 || true
  if [[ -n "$fixture_pid" ]]; then
    adbx -s "$serial" reverse --remove "tcp:$fixture_port" > /dev/null 2>&1 || failed=1
    kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true
  fi
  if [[ "$started_unit" == true ]]; then systemctl stop orbit-android-emulator.service 9>&- || failed=1
    # Its emulator aborts on the unit's SIGINT, which marks the unit failed; leave it inactive as it was found.
    systemctl reset-failed orbit-android-emulator.service 9>&- 2> /dev/null || true; fi
  (( result == 0 && failed != 0 )) && result=1
  printf 'failures=%s\ncleanup_failed=%s\nexit_code=%s\nfinished_utc=%s\n' "$failures" "$failed" "$result" "$(date -u +%FT%TZ)" \
    >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
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
  for prop in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
    printf '%s=%s\n' "$prop" "$(adbx -s "$serial" shell getprop "$prop" | tr -d '\r')"
  done
  adbx -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
} > "$output/device.txt"
if [[ -n "$fixture_port" ]]; then
  python3 "$scripts/push-cold-fixture.py" --port "$fixture_port" --bundle-id "$package" > "$output/fixture.log" 2>&1 9>&- &
  fixture_pid=$!
  for attempt in {1..50}; do curl --fail --silent "$server/__stats" > /dev/null && break; sleep 0.2; done
  adbx -s "$serial" reverse "tcp:$fixture_port" "tcp:$fixture_port" > /dev/null
fi
# The release package can only replace one signed by the same key; an earlier copy on the emulator is removed first.
if adbx -s "$serial" shell pm list packages "$package" | tr -d '\r' | grep -qx "package:$package"; then
  adbx -s "$serial" shell dumpsys package "$package" | grep -m2 -E 'versionName|versionCode' > "$output/removed-earlier-install.txt" || true
  adbx -s "$serial" uninstall "$package" >> "$output/removed-earlier-install.txt"
fi
adbx -s "$serial" uninstall "$package.test" > /dev/null 2>&1 || true
installed=true
adbx -s "$serial" install "$build/app-release.apk" > "$output/install-app.txt"
adbx -s "$serial" install -t "$build/app-release-androidTest.apk" > "$output/install-tests.txt"
adbx -s "$serial" shell input keyevent KEYCODE_WAKEUP
adbx -s "$serial" shell wm dismiss-keyguard
adbx -s "$serial" logcat -c
adbx -s "$serial" shell mkdir -p "$remote"
adbx -s "$serial" push "$login" "$remote/login.env" > /dev/null
if instrument sign-in signInAndRegister; then signed_in=true; record sign_in PASS; else record sign_in FAIL; fi
adbx -s "$serial" shell rm -f "$remote/login.env"
adbx -s "$serial" pull "$remote" "$output/screens" > /dev/null 2>&1 || true
(( failures == 0 )) || exit 1
# Finishing an instrumentation force-stops the app, and FCM delivers nothing to a stopped app: a launcher start clears it.
adbx -s "$serial" shell am start -W -n "$package/io.orbitd.android.MainActivity" > "$output/launch.txt"
sleep 8

entries() { # Orbit's active tray entries, one per line: tag<TAB>channel<TAB>group<TAB>title<TAB>text
  adbx -s "$serial" shell dumpsys notification --noredact | python3 -c '
import re, sys
for block in sys.stdin.read().split("NotificationRecord(")[1:]:
    head = block.splitlines()[0]
    if " pkg=" + sys.argv[1] + " " not in head:
        continue
    def find(pattern, text=block):
        m = re.search(pattern, text, re.M)
        return m.group(1) if m else ""
    print("\t".join([find(r"tag=(\S+)", head), find(r"channel=(\S+)", head), find(r"groupKey=(\S+)"),
                     find(r"android\.title=\w+ \((.*)\)$"), find(r"android\.text=\w+ \((.*)\)$")]))
' "$package"
}
entry() { entries | grep -F -- "$1" | head -1 || true; } # MATCH: the first entry whose line contains MATCH
await_entry() { # MATCH TIMEOUT
  local deadline=$((SECONDS + $2))
  while (( SECONDS < deadline )); do [[ -n "$(entry "$1")" ]] && return 0; sleep 1; done
  return 1
}
await_gone() { # MATCH TIMEOUT
  local deadline=$((SECONDS + $2))
  while (( SECONDS < deadline )); do [[ -z "$(entry "$1")" ]] && return 0; sleep 1; done
  return 1
}
shot() { sleep 1; adbx -s "$serial" exec-out screencap -p > "$output/$1.png"; }
shade() { adbx -s "$serial" shell cmd statusbar expand-notifications; sleep 2; shot "$1"; }
collapse() { adbx -s "$serial" shell cmd statusbar collapse > /dev/null 2>&1 || true; }
home() { adbx -s "$serial" shell input keyevent KEYCODE_HOME; sleep 3; }
last_notify=-100
notify() { # NAME MESSAGE: as this Orbit session; the server answers whether any device accepted it
  local wait=$((last_notify + 62 - SECONDS))
  if (( wait > 0 )); then sleep "$wait"; fi # at most one per session per minute
  date -u +%FT%T.%3NZ > "$output/$1-notify-utc.txt"
  "$orbit" notify --message "$2" --json > "$output/$1-notify.json" 2>&1 9>&- || true
  last_notify=$SECONDS
}
delivered() { python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); sys.exit(0 if d.get("delivered") else 1)' "$1" 2>/dev/null; }
device_now() { adbx -s "$serial" shell date +%s.%N | tr -d '\r'; }
receipts_since() { # DEVICE_EPOCH TYPE: OrbitPush receipt lines of that push type logged since then (device clock)
  adbx -s "$serial" logcat -d -v epoch -s OrbitPush:I | awk -v since="$1" -v type="type=$2" '$1 + 0 >= since + 0 && index($0, type)'
}
receipt() { # NAME: the OrbitPush receipt line of the entry recorded in NAME-entry.txt (its tag ends with the event)
  local event; event="$(cut -f1 "$output/$1-entry.txt" | sed 's/.*://')"
  adbx -s "$serial" logcat -d -v epoch -s OrbitPush:I | grep -F "eventId=$event" > "$output/$1-receipt.txt" || true
  [[ -s "$output/$1-receipt.txt" ]]
}

if [[ "$steps" == *" background "* ]]; then
  home
  notify background 'A10 Android push test 1/3: Orbit in the background. No action needed.'
  if delivered "$output/background-notify.json" && await_entry 'test 1/3' 90; then
    entry 'test 1/3' > "$output/background-entry.txt"
    shade background-1-tray
    python3 "$scripts/push-host-ui.py" tap "$serial" 'test 1/3' "$output/background-tap.xml" --timeout 20 --contains \
      > "$output/background-tap.txt" 2>&1 9>&- || true
    sleep 5
    shot background-2-opened
    if receipt background && await_gone 'test 1/3' 15; then record background PASS; else record background FAIL; fi
  else
    shade background-timeout; record background FAIL
  fi
  collapse
fi

if [[ "$steps" == *" killed "* ]]; then
  home
  adbx -s "$serial" shell am kill "$package"
  sleep 2
  adbx -s "$serial" shell pidof "$package" > "$output/killed-pid-before.txt" 2>&1 || true
  notify killed 'A10 Android push test 2/3: Orbit not running. No action needed.'
  if [[ ! -s "$output/killed-pid-before.txt" ]] && delivered "$output/killed-notify.json" && await_entry 'test 2/3' 90; then
    entry 'test 2/3' > "$output/killed-entry.txt"
    adbx -s "$serial" shell pidof "$package" > "$output/killed-pid-after.txt" 2>&1 || true
    shade killed-1-tray
    # Swiped away as a person dismisses it: from the entry's left part to the right edge.
    if python3 "$scripts/push-host-ui.py" wait "$serial" 'test 2/3' "$output/killed-shade.xml" --timeout 20 --contains \
        > "$output/killed-find.txt" 2>&1 9>&-; then
      read -r x1 y1 x2 y2 < <(sed -n 's/.*bounds=\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\].*/\1 \2 \3 \4/p' "$output/killed-find.txt")
      adbx -s "$serial" shell input swipe "$((x1 + 40))" "$(((y1 + y2) / 2))" "$x2" "$(((y1 + y2) / 2))" 200
    fi
    sleep 2
    shot killed-2-dismissed
    if receipt killed && await_gone 'test 2/3' 15; then record killed PASS; else record killed FAIL; fi
  else
    shade killed-timeout; record killed FAIL
  fi
  collapse
fi

if [[ "$steps" == *" foreground "* ]]; then
  adbx -s "$serial" shell am start -W -n "$package/io.orbitd.android.MainActivity" > /dev/null
  sleep 5
  notify foreground 'A10 Android push test 3/3: Orbit on screen. No action needed.'
  if delivered "$output/foreground-notify.json" && await_entry 'test 3/3' 90; then
    entry 'test 3/3' > "$output/foreground-entry.txt"
    shot foreground-1-app
    shade foreground-2-tray
    # A foreground entry joins the silent group, so it posts without sound or heads-up.
    if receipt foreground && grep -q 'orbit.silent' "$output/foreground-entry.txt"; then record foreground PASS; else record foreground FAIL; fi
  else
    shade foreground-timeout; record foreground FAIL
  fi
  collapse
fi

if [[ "$steps" == *" crossdevice "* ]]; then
  home
  title="A10 Android push cross-device check $(date -u +%H%M%S)"
  created="$(device_now)"
  "$orbit" session create --title "$title" --permission-mode default --json --prompt "This session only raises one permission \
request for an Android notification test. Use the Write tool to create /tmp/a10-push-check.txt containing the word ok. Do \
nothing else; if the write is refused, stop." > "$output/crossdevice-session.json" 2>&1 9>&- || true
  scratch="$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d.get("id") or d.get("sessionId") or "")' \
    "$output/crossdevice-session.json" 2>/dev/null || true)"
  if [[ -n "$scratch" ]] && await_entry "$title" 300; then
    entry "$title" > "$output/crossdevice-entry.txt"
    shade crossdevice-1-approval-tray
    collapse
    receipts_since "$created" alert > "$output/crossdevice-receipt.txt"
    # Another client answers it: ending the scratch session takes it out of "needs you", and the server's sync push
    # names it in clearSessions; the app re-reads the approval before removing the entry.
    ended="$(device_now)"
    "$orbit" session end "$scratch" --json > "$output/crossdevice-end.json" 2>&1 9>&- || true
    scratch=''
    if await_gone "$title" 120; then
      shade crossdevice-2-cleared
      receipts_since "$ended" sync > "$output/crossdevice-sync.txt"
      if [[ -s "$output/crossdevice-receipt.txt" && -s "$output/crossdevice-sync.txt" ]]; then record crossdevice PASS
      else record crossdevice FAIL; fi
    else
      shade crossdevice-timeout; record crossdevice FAIL
    fi
    collapse
  else
    shade crossdevice-no-approval; record crossdevice FAIL
  fi
fi

if instrument sign-out signOutAndUnregister; then signed_in=false; record sign_out PASS; else record sign_out FAIL; fi
(( failures == 0 ))
