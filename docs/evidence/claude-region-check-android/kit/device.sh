#!/bin/bash
# device.sh OUT: ClaudeRegionDeviceTest on emulator-5554 through the project's increments script (task 34pVMqy3QOa4qY1jBWvZA; adapted
# from the owner-answer kit /mnt/data/tmp/34nGWNO9/bin/device.sh). The APKs are the dev build's (bin/dev.sh :app:assembleDebug
# :app:assembleDebugAndroidTest), copied aside first. Waits for memory WITHOUT the device lock, then takes /var/lib/orbit/android/ui.lock;
# starts orbit-android-emulator.service only if it is down (and then stops it again), and runs the script under a private lock so its
# own flock does not wait on this hold.
set -uo pipefail
TREE=/root/.orbit/worktrees/41be4669-3b10-52a7-ae41-50c2d4f87791
KIT=/mnt/data/tmp/34pVMqy3QOa4qY1jBWvZA
OUT=$1
ADB=/opt/android-sdk/platform-tools/adb
BUILT=$KIT/gradle/dev/build/app/outputs/apk
memory_ok() {
  avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); swap=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
  [ "$avail" -ge "$1" ] && [ "$swap" -ge 8000 ]
}
wait_for_memory() {
  local good=0
  while [ "$good" -lt 3 ]; do
    if memory_ok "$1"; then good=$((good + 1)); else good=0; echo "$(date -u +%T) waiting for memory: avail=${avail}M swapfree=${swap}M"; fi
    [ "$good" -lt 3 ] && sleep 30
  done
}
APKS="$KIT/apks/$(date +%Y%m%dT%H%M%S)"; mkdir -p "$APKS"
cp "$BUILT/debug/app-debug.apk" "$BUILT/androidTest/debug/app-debug-androidTest.apk" "$APKS/" || { echo "== no APKs"; exit 3; }
echo "== $(date -u +%FT%TZ) APKs of $(git -C "$TREE" rev-parse HEAD) + working tree:"; git -C "$TREE" status --short; sha256sum "$APKS"/*.apk
"$ADB" start-server
while true; do
  # A running emulator has its memory already: the journeys need little more. A cold boot is gated below.
  if systemctl is-active --quiet orbit-android-emulator.service; then
    until [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -ge 1500 ]; do echo "$(date -u +%T) waiting for 1.5 GB"; sleep 30; done
  else wait_for_memory 2500; fi
  exec 9>/var/lib/orbit/android/ui.lock
  echo "== $(date -u +%T) waiting for ui.lock"
  flock -w 7200 9 || { echo "== no ui.lock in 2 h"; exit 4; }
  echo "== $(date -u +%T) holding ui.lock"
  started=0
  if ! systemctl is-active --quiet orbit-android-emulator.service; then
    # A cold boot peaks near 5 GB: never wait holding the lock — let it go and wait again without it.
    if ! memory_ok 5000; then echo "== emulator down and memory short (avail=${avail}M): releasing the lock"; exec 9>&-; sleep 60; continue; fi
    systemctl start orbit-android-emulator.service; started=1
    for i in $(seq 1 60); do [ "$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null 9>&- | tr -d '\r')" = 1 ] && break; sleep 5; done
    echo "== emulator started by this run, boot_completed=$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 9>&- | tr -d '\r')"
  fi
  break
done
if [ "$("$ADB" -s emulator-5554 shell dumpsys window windows 9>&- | grep -c 'Application Not Responding')" != 0 ]; then echo "== an ANR dialog is up"; fi
touch "$KIT/private.lock"
ANDROID_DEVICE_LOCK="$KIT/private.lock" INCREMENTS_CLASSES=ClaudeRegionDeviceTest \
  bash "$TREE/src/android/scripts/increments-device-test.sh" "$APKS/app-debug.apk" "$APKS/app-debug-androidTest.apk" "$OUT" emulator-5554 9>&-
code=$?
if [ "$started" = 1 ]; then sleep 15; "$ADB" -s emulator-5554 shell sync 9>&- || true; systemctl stop orbit-android-emulator.service; echo "== emulator stopped again"; fi
echo "== device run exit $code at $(date -u +%FT%TZ)"
exit $code
