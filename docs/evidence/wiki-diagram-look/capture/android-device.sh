#!/bin/bash
# device.sh OUT: WikiDiagramDeviceTest (light and dark) on emulator-5554 through the project's increments script. Builds the debug
# app and test APKs from the session tree first (scoped, memory-gated, build dirs on /mnt/data); waits for memory WITHOUT the device
# lock, then takes /var/lib/orbit/android/ui.lock; starts orbit-android-emulator.service only if it is down (and stops it again), and
# runs the script under a private lock so its own flock does not wait on this hold. Adapted from /mnt/data/tmp/34nGWNO9/bin/device.sh.
set -uo pipefail
TREE=/root/.orbit/worktrees/01a1983d-edb5-76c6-ab76-80ba6672bf4f
KIT=/mnt/data/tmp/wiki-diagram-look/android
OUT=$1
ADB=/opt/android-sdk/platform-tools/adb
memory_ok() {
  avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); swap=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
  [ "$avail" -ge "$1" ] && [ "$swap" -ge 4000 ]
}
wait_for_memory() {
  local good=0
  while [ "$good" -lt 3 ]; do
    if memory_ok "$1"; then good=$((good + 1)); else good=0; echo "$(date -u +%T) waiting for memory: avail=${avail}M swapfree=${swap}M"; fi
    [ "$good" -lt 3 ] && sleep 30
  done
}
echo "== $(date -u +%FT%TZ) building APKs at $(git -C "$TREE" rev-parse HEAD)"; git -C "$TREE" status --short
"$KIT/run.sh" apks :app:assembleDebug :app:assembleDebugAndroidTest || { echo "== APK build failed"; exit 3; }
APKS="$KIT/apks/$(date +%Y%m%dT%H%M%S)"; mkdir -p "$APKS"
cp "$KIT/build/app/outputs/apk/debug/app-debug.apk" "$KIT/build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk" "$APKS/"
sha256sum "$APKS"/*.apk
"$ADB" start-server
while true; do
  wait_for_memory 2500
  exec 9>/var/lib/orbit/android/ui.lock
  echo "== $(date -u +%T) waiting for ui.lock"
  flock -w 7200 9 || { echo "== no ui.lock in 2 h"; exit 4; }
  echo "== $(date -u +%T) holding ui.lock"
  started=0
  if ! systemctl is-active --quiet orbit-android-emulator.service; then
    if ! memory_ok 5000; then echo "== emulator down and memory short (avail=${avail}M): releasing the lock"; exec 9>&-; sleep 60; continue; fi
    systemctl start orbit-android-emulator.service; started=1
    for i in $(seq 1 60); do [ "$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null 9>&- | tr -d '\r')" = 1 ] && break; sleep 5; done
    echo "== emulator started by this run, boot_completed=$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 9>&- | tr -d '\r')"
  fi
  break
done
touch "$KIT/private.lock"
ANDROID_DEVICE_LOCK="$KIT/private.lock" INCREMENTS_CLASSES=WikiDiagramDeviceTest \
  bash "$TREE/src/android/scripts/increments-device-test.sh" "$APKS/app-debug.apk" "$APKS/app-debug-androidTest.apk" "$OUT" emulator-5554 9>&-
code=$?
if [ "$started" = 1 ]; then sleep 15; "$ADB" -s emulator-5554 shell sync 9>&- || true; systemctl stop orbit-android-emulator.service; echo "== emulator stopped again"; fi
echo "== device run exit $code at $(date -u +%FT%TZ)"
exit $code
