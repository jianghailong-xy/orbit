#!/usr/bin/env bash
# Take ui.lock (adb server started outside it, adb called with the lock fd closed), make sure the shared API 36
# emulator runs, drive the capture, then put the emulator back as it was found. usage: run.sh <out-dir>
set -uo pipefail
OUT=$1
ADB=/opt/android-sdk/platform-tools/adb
LOCK=/var/lib/orbit/android/ui.lock
"$ADB" start-server >/dev/null 2>&1
exec 9>"$LOCK"
echo "$(date -u +%T) waiting for $LOCK"
flock -w 7200 9 || { echo "lock wait timed out"; exit 3; }
echo "$(date -u +%T) lock held"
# Memory gate: the emulator needs ~2.5 GB; wait for 3.5 GB available, 3 samples 20 s apart.
ok=0
for i in $(seq 1 180); do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$avail" -ge 3500 ]; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 20
done
echo "$(date -u +%T) memory available ${avail} MB"
was_active=$(systemctl is-active orbit-android-emulator 9>&-)
if [ "$was_active" != active ]; then
  systemctl start orbit-android-emulator 9>&-
fi
"$ADB" -s emulator-5554 wait-for-device 9>&-
for i in $(seq 1 120); do
  [ "$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 9>&- | tr -d '\r')" = 1 ] && break
  sleep 2
done
sleep 5
python3 -I /mnt/data/tmp/34tDf8/android/drive.py "$OUT" /mnt/data/tmp/34tDf8/android/apk/app-debug.apk 9>&-
rc=$?
"$ADB" -s emulator-5554 shell pm uninstall io.orbitd.android.debug 9>&- >/dev/null 2>&1 || true
"$ADB" -s emulator-5554 unroot 9>&- >/dev/null 2>&1 || true
if [ "$was_active" != active ]; then
  systemctl stop orbit-android-emulator 9>&-; systemctl reset-failed orbit-android-emulator 9>&- 2>/dev/null || true
fi
echo "$(date -u +%T) drive exit $rc; emulator was $was_active, now $(systemctl is-active orbit-android-emulator 9>&-)"
exit $rc
