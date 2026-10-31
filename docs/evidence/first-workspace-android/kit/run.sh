#!/usr/bin/env bash
# Emulator evidence frames for task 34pLtXumbawMl6II4gUPa on the shared emulator (emulator-5554).
# Installs the debug APK and androidTest APK built with kit.gradle, holds /var/lib/orbit/android/ui.lock,
# runs FirstWorkspaceDeviceShotsTest from a signed-out installation, and copies the 5 frames out.
# Usage: run.sh APP_APK TEST_APK OUT_DIR
set -euo pipefail
(( $# == 3 )) || { echo 'Usage: run.sh APP_APK TEST_APK OUT_DIR' >&2; exit 2; }
apk=$(realpath "$1"); tests=$(realpath "$2"); out=$(realpath -m "$3")
rm -rf "$out"
mkdir -p "$out"
adb=/opt/android-sdk/platform-tools/adb
serial=${ANDROID_SERIAL:-emulator-5554}
[[ "$serial" == emulator-* ]] || { echo "Refusing non-emulator device $serial" >&2; exit 2; }
package=io.orbitd.android.debug
"$adb" start-server
exec 9>/var/lib/orbit/android/ui.lock
flock -x -w 600 9 || { echo 'Device lock timeout; no device state changed.' >&2; exit 75; }
a() { "$adb" -s "$serial" "$@" 9>&-; }
night=$(a shell cmd uimode night | tr -d '\r')
handwriting=$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')
font_scale=$(a shell settings get system font_scale | tr -d '\r')
cleanup() {
  rc=$?; trap - EXIT
  a shell am force-stop "$package" >/dev/null 2>&1 || true
  case "$night" in *yes*) a shell cmd uimode night yes ;; *) a shell cmd uimode night no ;; esac >/dev/null 2>&1 || true
  a shell settings put system font_scale "${font_scale:-1.0}" >/dev/null 2>&1 || true
  if [ "$handwriting" = "null" ] || [ -z "$handwriting" ]; then a shell settings delete secure stylus_handwriting_enabled >/dev/null 2>&1 || true
  else a shell settings put secure stylus_handwriting_enabled "$handwriting" >/dev/null 2>&1 || true; fi
  printf 'restored %s font_scale=%s stylus_handwriting_enabled=%s\nexit_code=%s\n' \
    "$(a shell cmd uimode night | tr -d '\r')" \
    "$(a shell settings get system font_scale | tr -d '\r')" \
    "$(a shell settings get secure stylus_handwriting_enabled | tr -d '\r')" "$rc" >> "$out/result.txt"
  exit "$rc"
}
trap cleanup EXIT
printf 'scope=controlled HTTP (MockWebServer in the instrumentation) on %s; no deployed server, account or runner\nbefore %s font_scale=%s stylus_handwriting_enabled=%s\n' \
  "$serial" "$night" "$font_scale" "$handwriting" > "$out/result.txt"
git rev-parse HEAD > "$out/source-sha.txt"; git status --short > "$out/source-status.txt"
{ a shell getprop ro.build.fingerprint; a shell getprop ro.build.version.sdk; a shell wm size; } > "$out/device.txt"
sha256sum "$apk" "$tests" > "$out/apks.sha256"
install() {
  if ! a install -r "$2" > "$3" 2>&1; then
    grep -F INSTALL_FAILED_UPDATE_INCOMPATIBLE "$3" >/dev/null || { cat "$3" >&2; return 1; }
    a uninstall "$1" >> "$3"
    a install "$2" >> "$3"
  fi
}
install "$package" "$apk" "$out/install-app.txt"
install "$package.test" "$tests" "$out/install-test.txt"
a shell settings put secure stylus_handwriting_enabled 0
a shell settings put system font_scale 1.0
a shell cmd uimode night no > /dev/null
a shell pm clear "$package" > "$out/pm-clear.txt"
a shell am instrument -w -r -e class io.orbitd.android.FirstWorkspaceDeviceShotsTest \
  io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner > "$out/instrumentation.txt" 2>&1 || true
a exec-out run-as "$package" tar -cf - -C files first-workspace > "$out/captures.tar" || true
tar --no-same-owner -xf "$out/captures.tar" -C "$out" || true
grep -F 'OK (1 test)' "$out/instrumentation.txt"
if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed' "$out/instrumentation.txt"; then exit 1; fi
for shot in 01-setup-card 01b-setup-card-no-key 02-drawer-set-up 03-setup-held 04-created-workspace 05-machine-page; do
  test -s "$out/first-workspace/$shot.png"
done
