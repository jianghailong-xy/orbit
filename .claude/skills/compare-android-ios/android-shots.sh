#!/usr/bin/env bash
# Android half of compare-android-ios: build the debug + test APKs from this checkout (memory-capped), boot the shared
# API 36 emulator if it is down (under ui.lock), and run one ComposerDeviceTest journey on a Pixel 10 Pro display, in
# light and then dark. Prints one "SHOTS <mode> <dir>" line per run; the PNGs are in <dir>/a07-composer/.
#
#   android-shots.sh TEST_METHOD OUT_ROOT [MODES]
#     TEST_METHOD  a method of io.orbitd.android.composer.ComposerDeviceTest, e.g. newSessionUsesWorkspaceDraftAndNavigatesAfterCreation
#     OUT_ROOT     an existing directory, normally this session's uploads directory
#     MODES        "no yes" (default: light then dark), or "no" / "yes"
#
# Run it with Orbit's bg_run (kind job, wakeOnExit true): a cold build plus two rounds takes 5-15 minutes.
set -uo pipefail
method="${1:?test method}"; root="${2:?output root}"; modes="${3:-no yes}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo/src/android" || exit 1
export ANDROID_HOME=/opt/android-sdk ANDROID_USER_HOME=/var/lib/orbit/android/user ANDROID_AVD_HOME=/var/lib/orbit/android/avd

# Build first, emulator second: Gradle beside a live emulator is what OOM-kills it on a 14 GB host. The cap makes the
# build the OOM killer's first pick rather than the emulator or another task's build.
if ! systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    ./gradlew --no-daemon -Pkotlin.compiler.execution.strategy=in-process :app:assembleDebug :app:assembleDebugAndroidTest \
    > /tmp/compare-android-build.log 2>&1; then
  echo "BUILD_FAILED (log /tmp/compare-android-build.log)"; grep -E '^e:' /tmp/compare-android-build.log | head -20
  grep -q 'Killed\|exit code 137\|143' /tmp/compare-android-build.log && echo "looks OOM-killed: wait for other builds, run again"
  exit 1
fi
cd "$repo"
"$ANDROID_HOME/platform-tools/adb" start-server 9>&- 3>&-      # before the lock, or the adb daemon inherits it
flock -w 1800 /var/lib/orbit/android/ui.lock sh -c \
  'systemctl is-active --quiet orbit-android-emulator.service || systemctl start orbit-android-emulator.service'

status=0
for mode in $modes; do
  for try in 1 2; do   # "process failed to attach" happens now and then on the emulator: one retry
    out="$root/android-$(date -u +%Y%m%dT%H%M%SZ)-${method}-night-$mode"
    A07_NIGHT=$mode A07_DISPLAY=1280x2856@480 A07_TEST="io.orbitd.android.composer.ComposerDeviceTest#$method" \
      bash src/android/scripts/composer-device-test.sh 36 src/android/app/build/outputs/apk/debug/app-debug.apk \
      src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk "$out" > "$root/.compare-android-$mode.log" 2>&1
    rc=$?
    # "failed to attach", or "Process crashed" before the journey wrote a result: another task on the shared emulator
    # (re)installed the debug app mid-run, which kills the instrumentation. Not this journey's fault: one retry.
    if grep -q 'failed to attach' "$out/instrumentation.txt" 2>/dev/null ||
       { grep -q 'shortMsg=Process crashed' "$out/instrumentation.txt" 2>/dev/null && ! ls "$out"/a07-composer/*-result.txt >/dev/null 2>&1; }; then
      echo "RETRY $mode: $(grep -o 'failed to attach\|Process crashed' "$out/instrumentation.txt" | head -1)"; continue
    fi
    # Another task on the shared emulator installed the debug app signed with its own debug key: the update is refused.
    # Uninstall both packages under ui.lock (nobody's round is using them then) and go again.
    if grep -q 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' "$root/.compare-android-$mode.log"; then
      echo "RETRY $mode: debug app signed by another key on the emulator; uninstalling it under ui.lock"
      flock -w 1800 /var/lib/orbit/android/ui.lock sh -c '"$1" -s emulator-5554 uninstall io.orbitd.android.debug.test; "$1" -s emulator-5554 uninstall io.orbitd.android.debug' sh "$ANDROID_HOME/platform-tools/adb" 9>&- 3>&-
      continue
    fi
    break
  done
  echo "SHOTS $mode $out exit=$rc"
  ls "$out/a07-composer/"*.png 2>/dev/null | sed 's/^/  /'
  for r in "$out"/a07-composer/*-result.txt; do [ -f "$r" ] && echo "  $(basename "$r"): $(head -1 "$r" | cut -c1-160)"; done
  [ "$rc" = 0 ] || status=1
done
exit $status
