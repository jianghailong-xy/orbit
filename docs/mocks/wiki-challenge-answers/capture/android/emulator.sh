#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner: the same driver the local emulator would run, pointed at :3734.
set -uo pipefail
K=$(cd "$(dirname "$0")" && pwd)
APK=$1
adb devices
SERIAL=$(adb devices | awk 'NR>1 && /emulator-/ {print $1; exit}') SERVER=http://10.0.2.2:3734 IDS_JSON="$K/ids.json" \
  python3 -I "$K/drive.py" "$K/shots" "$APK"
rc=$?
adb logcat -d -t 2000 > "$K/shots/logcat.txt" 2>/dev/null || true
echo "drive exit $rc" | tee "$K/shots/result.txt"
exit 0
