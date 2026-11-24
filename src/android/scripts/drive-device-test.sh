#!/usr/bin/env bash
set -euo pipefail

# Drive on a real Orbit server (board docs/mocks/drive/04-android): DriveDeviceTest on the shared API 36 emulator, signed in
# through the login page. The account comes from ACCOUNT_JSON ({"email","password"}), never from the command line; SERVER is the
# address the emulator reaches (http://10.0.2.2:<port> for a server on this host). DOCS_TEST picks the journey
# (io.orbitd.android.drive.DriveDeviceTest#screens|writes|off); DOCS_NIGHT=yes draws the dark theme; DOCS_DISPLAY sets the
# display (default 1280x2856@480, the Pixel 10 Pro the client-screenshots skill uses). Captures land in EVIDENCE_DIR.
if (( $# != 5 )); then
  echo "Usage: $0 APP_APK TEST_APK SERVER ACCOUNT_JSON EVIDENCE_DIR" >&2
  exit 2
fi
apk="$(realpath "$1")"; tests="$(realpath "$2")"; server="$3"; account="$4"; output="$(realpath -m "$5")"
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
serial=emulator-5554
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
"$adb" start-server 9>&- 3>&-
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 1800 9
a() { "$adb" -s "$serial" "$@" 9>&-; }
cleanup() {
  local result=$?
  if [[ -n "${old_size:-x}" && -n "${old_night:-}" ]]; then
    a shell wm size "${old_size:-reset}" >/dev/null || true
    a shell wm density "${old_density:-reset}" >/dev/null || true
    a shell cmd uimode night "$old_night" >/dev/null || true
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=Documents on a real Orbit server (%s); test=%s\nstarted_utc=%s\n' "$server" "${DOCS_TEST:-}" "$(date -u +%FT%TZ)" > "$output/result.txt"
systemctl is-active --quiet orbit-android-emulator.service || systemctl start orbit-android-emulator.service
timeout 300 "$adb" -s "$serial" wait-for-device 9>&-
until [[ "$(a shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do sleep 2; done
{ for p in ro.product.model ro.build.version.release ro.build.version.sdk; do printf '%s=%s\n' "$p" "$(a shell getprop $p | tr -d '\r')"; done; } > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
a install -r "$apk" > "$output/install-app.txt"
a install -r "$tests" > "$output/install-tests.txt"
a shell pm grant "$package" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
a shell input keyevent KEYCODE_WAKEUP
a shell wm dismiss-keyguard
old_size="$(a shell wm size | sed -n 's/Override size: //p' | tr -d '\r')"
old_density="$(a shell wm density | sed -n 's/Override density: //p' | tr -d '\r')"
old_night="$(a shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
display="${DOCS_DISPLAY:-1280x2856@480}"
a shell wm size "${display%@*}"
a shell wm density "${display#*@}"
a shell cmd uimode night "${DOCS_NIGHT:-no}"
sleep 3
a shell am force-stop "$package"
a shell run-as "$package" rm -rf files/a07-composer files/a07-captures.tar
email="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["email"])' "$account")"
password="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["password"])' "$account")"
suffix="$([[ "${DOCS_NIGHT:-no}" == yes ]] && echo dark || echo light)"
start="$(a shell date +%s | tr -d '\r').000"
# The password goes to the device as an instrumentation argument only; the transcript below has it masked.
a shell am instrument -w -r -e docs_server "$server" -e docs_email "$email" -e docs_password "$password" -e docs_suffix "$suffix" \
  -e class "${DOCS_TEST:-io.orbitd.android.drive.DriveDeviceTest}" "$runner" 2>&1 | sed "s/$password/<password>/g" > "$output/instrumentation.txt"
pid="$(sed -n 's/.*a07_pid=\([0-9]*\).*/\1/p' "$output/instrumentation.txt" | head -1)"
[[ -n "$pid" ]] && a logcat -d -v threadtime --pid="$pid" -T "$start" | sed "s/$password/<password>/g" > "$output/logcat.txt" || true
a shell run-as "$package" tar -cf files/a07-captures.tar -C files a07-composer > /dev/null 2>&1 || true
a exec-out run-as "$package" cat files/a07-captures.tar > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output" && rm "$output/captures.tar"
chmod -R a+rX "$output"
grep -E 'OK \([0-9]+ tests?\)' "$output/instrumentation.txt" >/dev/null
if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$output/instrumentation.txt"; then exit 1; fi
