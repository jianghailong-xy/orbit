#!/usr/bin/env bash
# D09 P07 capture beside a phone session the coordinator schedules (method: a01-errata-v2 §6). Run it with the
# phone's adb serial while the account owner uses the phone. It never installs, taps, clears data or changes a
# setting: it reads Orbit's log lines, samples the clock and records the screen until NEW_OUTPUT_DIR/stop exists,
# then pulls the recordings and deletes them from the phone.
#   device.txt     model, Android/API/build, Google Play services and Orbit versions, Orbit's channels, auto time
#   clock.tsv      host_before_ns, device_ns, host_after_ns every 15 s: device clock − host clock lies in
#                  [device − after, device − before]
#   orbitpush.log  logcat -v epoch -s OrbitPush: eventId, the server's sentAt and FCM's sentTime per receipt
#   events.log     logcat -v epoch -b events, Orbit's lines only (notification_enqueue/canceled/clicked,
#                  wm_on_*_called for its Activity); other apps' lines are filtered out on the phone
#   screen/        screenrecord --bugreport segments; every frame carries the device time
set -euo pipefail
(( $# == 2 )) || { echo 'Usage: push-p07-collect.sh SERIAL NEW_OUTPUT_DIR' >&2; exit 2; }
serial="$1"
output="$(realpath -m "$2")"
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new output directory' >&2; exit 2; }
adb="${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb"
package=io.orbitd.android
remote=/sdcard/Movies/orbit-p07
device() { "$adb" -s "$serial" "$@"; }
[[ "$(device get-state 2>/dev/null)" == device ]] || { echo "$serial is not connected" >&2; exit 2; }
( # A missing line here (no Orbit installed yet, another dumpsys layout) must not stop the capture.
  set +e
  for prop in ro.product.manufacturer ro.product.model ro.build.version.release ro.build.version.sdk ro.build.display.id \
      ro.build.fingerprint; do
    printf '%s=%s\n' "$prop" "$(device shell getprop "$prop" | tr -d '\r')"
  done
  printf 'auto_time=%s\n' "$(device shell settings get global auto_time | tr -d '\r')"
  device shell dumpsys package com.google.android.gms | grep -m1 versionName | sed 's/^ */gms_/'
  device shell dumpsys package "$package" | grep -m2 -E 'versionName|versionCode' | sed 's/^ */orbit_/'
  device shell dumpsys notification | grep -E "NotificationChannel\{mId='orbit\." \
    | sed -E "s/.*mId='([^']*)'.*mImportance=([0-9-]*).*/channel \1 importance=\2/"
) > "$output/device.txt" 2>&1
children=()
finish() {
  device shell pkill -INT screenrecord > /dev/null 2>&1 || true # ends the current segment cleanly
  kill "${children[@]:1:2}" 2> /dev/null || true # the two logcat readers; the loops end on the stop file
  wait 2> /dev/null || true
  device pull "$remote" "$output/screen" > /dev/null 2>&1 || true
  device shell rm -rf "$remote" > /dev/null 2>&1 || true
}
trap finish EXIT
(
  while [[ ! -e "$output/stop" ]]; do
    before="$(date +%s%N)"; at="$(device shell date +%s%N | tr -d '\r')" || at=''; after="$(date +%s%N)"
    printf '%s\t%s\t%s\n' "$before" "$at" "$after"
    sleep 15
  done > "$output/clock.tsv"
) &
children+=($!)
device logcat -v epoch -T 1 -s OrbitPush:I > "$output/orbitpush.log" 2>&1 &
children+=($!)
device logcat -v epoch -T 1 -b events -e 'io\.orbitd\.android' > "$output/events.log" 2>&1 &
children+=($!)
device shell mkdir -p "$remote"
(
  segment=0
  while [[ ! -e "$output/stop" ]]; do
    device shell screenrecord --bugreport --time-limit 170 "$remote/$(printf %03d "$segment").mp4" || true
    segment=$((segment + 1))
  done
) &
children+=($!)
echo "Recording $serial; touch $output/stop to finish."
until [[ -e "$output/stop" ]]; do sleep 2; done
