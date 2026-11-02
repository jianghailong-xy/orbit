#!/usr/bin/env bash
# Evidence frames for the Android Landings window drawn as a chat (docs/mocks/landings-chat-bubbles, option C) on the shared emulator.
# Installs the debug APK and an androidTest APK built with kit.gradle, waits for host memory WITHOUT the lock, then holds the shared UI
# lock for the run only: it runs LandingsChatShotsTest from a signed-out installation (light, then dark unless THEMES says otherwise) and
# copies the frames out. Controlled HTTP only (a MockWebServer in the instrumentation): no deployed server, account or runner.
# Usage: run.sh APP_APK TEST_APK OUT_DIR (missing or empty). The emulator must already be up; this never starts or stops it.
set -euo pipefail
(( $# == 3 )) || { echo 'Usage: run.sh APP_APK TEST_APK OUT_DIR' >&2; exit 2; }
apk=$(realpath "$1"); tests=$(realpath "$2"); out=$(realpath -m "$3")
mkdir -p "$out"; [[ -z "$(ls -A "$out")" ]] || { echo 'Use a new, empty output directory' >&2; exit 2; }
# The tree these frames are of: the checkout this kit sits in (read only, for its sha and status).
tree=$(cd "$(dirname "$(realpath "$0")")/../../../../.." && pwd)
adb=/opt/android-sdk/platform-tools/adb
serial=${ANDROID_SERIAL:-emulator-5554}
[[ "$serial" == emulator-* ]] || { echo "Refusing non-emulator device $serial" >&2; exit 2; }
package=io.orbitd.android.debug
# Host gate before the lock (never wait holding it): memory headroom and no memory stall, three samples 30 s apart.
good=0
while (( good < 3 )); do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  stall=$(awk '/^full/ {split($2, a, "="); print int(a[2])}' /proc/pressure/memory)
  if (( avail >= ${MIN_AVAIL:-2000} && stall < 3 )); then good=$((good + 1)); else good=0
    echo "$(date -u +%FT%TZ) waiting: MemAvailable ${avail} MB, memory full avg10 ${stall}" >&2; fi
  (( good < 3 )) && sleep 30
done
# The adb server first, outside the lock: one started under it would inherit the lock's descriptor and hold it for good.
"$adb" start-server
exec 9>/var/lib/orbit/android/ui.lock
flock -w "${ANDROID_DEVICE_LOCK_WAIT:-900}" 9 || { echo 'Device is in use; no device state changed.' >&2; exit 75; }
a() { "$adb" -s "$serial" "$@" 9>&-; }
[[ "$(a shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || { echo "$serial is not booted; no device state changed." >&2; exit 75; }
night=$(a shell cmd uimode night | tr -d '\r')
handwriting=$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')
cleanup() {
  rc=$?; trap - EXIT
  a shell am force-stop "$package" >/dev/null 2>&1 || true
  case "$night" in *yes*) a shell cmd uimode night yes ;; *) a shell cmd uimode night no ;; esac >/dev/null 2>&1 || true
  if [ "$handwriting" = "null" ] || [ -z "$handwriting" ]; then a shell settings delete secure stylus_handwriting_enabled >/dev/null 2>&1 || true
  else a shell settings put secure stylus_handwriting_enabled "$handwriting" >/dev/null 2>&1 || true; fi
  printf 'restored %s stylus_handwriting_enabled=%s\nexit_code=%s\nfinished_utc=%s\n' "$(a shell cmd uimode night | tr -d '\r')" \
    "$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')" "$rc" "$(date -u +%FT%TZ)" >> "$out/result.txt"
  exit "$rc"
}
trap cleanup EXIT
printf 'scope=controlled HTTP (MockWebServer in the instrumentation) on %s; no deployed server, account or runner\nbefore %s stylus_handwriting_enabled=%s\nstarted_utc=%s\n' \
  "$serial" "$night" "$handwriting" "$(date -u +%FT%TZ)" > "$out/result.txt"
git -C "$tree" rev-parse HEAD > "$out/source-sha.txt"; git -C "$tree" status --short > "$out/source-status.txt"
{
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint persist.sys.timezone; do
    printf '%s=%s\n' "$property" "$(a shell getprop "$property" | tr -d '\r')"
  done
  a shell wm size; a shell wm density; a shell date
} > "$out/device.txt"
sha256sum "$apk" "$tests" > "$out/apks.sha256"
# A package another build signed with another debug key cannot be updated in place: replace it, and say whose it was.
install() {
  if ! a install -r "$2" > "$3" 2>&1; then
    grep -F INSTALL_FAILED_UPDATE_INCOMPATIBLE "$3" >/dev/null || { cat "$3" >&2; return 1; }
    a shell dumpsys package "$1" | grep -E -A2 'signatures|Signing' >> "$3" || true
    a uninstall "$1" >> "$3"
    a install "$2" >> "$3"
  fi
}
install "$package" "$apk" "$out/install-app.txt"
install "$package.test" "$tests" "$out/install-test.txt"
# What is installed is what was built: compare inside this hold (others install their own builds between holds).
for pair in "$package:$apk" "$package.test:$tests"; do
  installed=$(a shell pm path "${pair%%:*}" | tr -d '\r' | sed -n 's/^package://p' | head -1)
  printf '%s %s\n' "$(a shell sha256sum "$installed" | tr -d '\r' | cut -d' ' -f1)" "${pair%%:*}" >> "$out/installed.sha256"
done
# API 34+ opens "Try out your stylus" over a focused field, which would cover a frame.
a shell settings put secure stylus_handwriting_enabled 0
failed=0
for theme in ${THEMES:-light dark}; do
  a shell pm clear "$package" >> "$out/pm-clear.txt"
  a shell cmd uimode night "$([ "$theme" = dark ] && echo yes || echo no)" > /dev/null
  a shell input keyevent KEYCODE_WAKEUP; a shell wm dismiss-keyguard || true
  a shell am instrument -w -r -e theme "$theme" -e class io.orbitd.android.reader.LandingsChatShotsTest \
    io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner > "$out/instrumentation-$theme.txt" 2>&1 || true
  a exec-out run-as "$package" tar -cf - -C files landings-chat > "$out/captures-$theme.tar" || true
  tar --no-same-owner -xf "$out/captures-$theme.tar" -C "$out" || true
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$out/instrumentation-$theme.txt" || \
     ! grep -F 'OK (1 test)' "$out/instrumentation-$theme.txt" >/dev/null; then failed=1; fi
done
exit "$failed"
