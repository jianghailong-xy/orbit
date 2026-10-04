#!/usr/bin/env bash
set -euo pipefail

if (( $# < 4 || $# > 5 )); then
  echo "Usage: $0 API APP_APK TEST_APK EVIDENCE_DIR [SERIAL]" >&2
  exit 2
fi
api="$1"
[[ "$api" =~ ^(29|3[0-6])$ ]] || { echo 'Expected API29–36' >&2; exit 2; }
apk="$(realpath "$2")"
tests="$(realpath "$3")"
output="$(realpath -m "$4")"
serial="${5:-}"
[[ -f "$apk" && -f "$tests" ]] || { echo 'Both APKs are required' >&2; exit 2; }
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
adb="$ANDROID_HOME/platform-tools/adb"
package='io.orbitd.android.debug'
runner='io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner'
emulator_pid=''
exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 600 9
cleanup() {
  local result=$?
  if [[ -n "${fixture_pid:-}" ]]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  if [[ -n "${serial:-}" ]]; then "$adb" -s "$serial" reverse --remove tcp:18768 >/dev/null 2>&1 || true; fi
  if [[ -n "${old_font:-}" ]]; then
    if [[ "$old_font" == null ]]; then
      "$adb" -s "$serial" shell settings delete system font_scale >/dev/null || true
    else
      "$adb" -s "$serial" shell settings put system font_scale "$old_font" >/dev/null || true
    fi
    "$adb" -s "$serial" shell wm size "${old_size:-reset}" >/dev/null || true
    "$adb" -s "$serial" shell wm density "${old_density:-reset}" >/dev/null || true
    "$adb" -s "$serial" shell cmd uimode night "$old_night" >/dev/null || true
  fi
  if [[ -n "${old_handwriting:-}" ]]; then
    if [[ "$old_handwriting" == null ]]; then
      "$adb" -s "$serial" shell settings delete secure stylus_handwriting_enabled >/dev/null || true
    else
      "$adb" -s "$serial" shell settings put secure stylus_handwriting_enabled "$old_handwriting" >/dev/null || true
    fi
  fi
  if [[ -n "${old_font:-}" ]]; then
    actual_font="$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')"
    actual_size="$("$adb" -s "$serial" shell wm size | sed -n 's/Override size: //p' | tr -d '\r')"
    actual_density="$("$adb" -s "$serial" shell wm density | sed -n 's/Override density: //p' | tr -d '\r')"
    actual_night="$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
    printf 'font=%s expected=%s\nsize=%s expected=%s\ndensity=%s expected=%s\nnight=%s expected=%s\n' \
      "$actual_font" "$old_font" "$actual_size" "$old_size" "$actual_density" "$old_density" "$actual_night" "$old_night" > "$output/restored-settings.txt"
    [[ "$actual_font" == "$old_font" && "$actual_size" == "$old_size" && "$actual_density" == "$old_density" && "$actual_night" == "$old_night" ]] || result=1
  fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
    timeout 20 "$adb" -s "$serial" wait-for-disconnect > "$output/disconnect.txt" 2>&1 || result=1
    local deadline=$((SECONDS + 20))
    while "$adb" devices | rg -q "^$serial[[:space:]]"; do
      if (( SECONDS >= deadline )); then result=1; break; fi
      sleep 0.25
    done
  fi
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
  exit "$result"
}
trap cleanup EXIT
printf 'scope=A08 cards UI; controlled authenticated HTTP fixture; not a physical/deployed-account result\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
if [[ -z "$serial" ]]; then
  if [[ "$api" == 36 ]]; then
    serial=emulator-5554
  else
    serial=emulator-5556
    if "$adb" devices | rg -q "^$serial[[:space:]]"; then
      echo 'Port 5556 in use; pass an existing serial explicitly' >&2
      exit 1
    fi
    "$ANDROID_HOME/emulator/emulator" -avd "orbit-ui-api$api" -port 5556 \
      -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader \
      -accel on -memory 2048 -cores 2 -camera-back none -camera-front none \
      > "$output/emulator.log" 2>&1 &
    emulator_pid=$!
  fi
fi
timeout 300 "$adb" -s "$serial" wait-for-device
deadline=$((SECONDS + 300))
until [[ "$("$adb" -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do
  (( SECONDS < deadline )) || { echo 'Boot timed out' >&2; exit 1; }
  sleep 2
done
[[ "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" == "$api" ]]
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint \
      ro.build.version.security_patch ro.kernel.qemu ro.com.google.gmsversion; do
    printf '%s=%s\n' "$property" "$("$adb" -s "$serial" shell getprop "$property" | tr -d '\r')"
  done
  "$adb" -s "$serial" shell pm list packages --show-versioncode com.google.android.gms
} > "$output/device.txt"
sha256sum "$apk" "$tests" > "$output/apks.sha256"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > "$output/apk-badging.txt"
grep -F "package: name='$package'" "$output/apk-badging.txt" >/dev/null
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$apk" > "$output/signature.txt"
"$adb" -s "$serial" install -r "$apk" > "$output/install-app.txt"
"$adb" -s "$serial" install -r "$tests" > "$output/install-tests.txt"
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard


old_font=''
if [[ "$("$adb" -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]; then
  old_size="$("$adb" -s "$serial" shell wm size | sed -n 's/Override size: //p' | tr -d '\r')"
  old_density="$("$adb" -s "$serial" shell wm density | sed -n 's/Override density: //p' | tr -d '\r')"
  old_font="$("$adb" -s "$serial" shell settings get system font_scale | tr -d '\r')"
  old_night="$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')"
  "$adb" -s "$serial" shell wm size 720x1280
  "$adb" -s "$serial" shell wm density 320
  "$adb" -s "$serial" shell settings put system font_scale "${A08_FONT_SCALE:-1.0}"
  "$adb" -s "$serial" shell cmd uimode night "${A08_NIGHT:-no}"
  if (( api >= 34 )); then
    old_handwriting="$("$adb" -s "$serial" shell settings get secure stylus_handwriting_enabled | tr -d '\r')"
    "$adb" -s "$serial" shell settings put secure stylus_handwriting_enabled 0
  fi
fi
deadline=$((SECONDS + 30))
until "$adb" -s "$serial" shell wm size > "$output/window-ready.txt" 2>&1; do
  (( SECONDS < deadline )) || { echo 'Window service did not settle after display configuration' >&2; exit 1; }
  sleep 1
done
{
  printf 'requested_font_scale=%s\nrequested_night=%s\n' "${A08_FONT_SCALE:-1.0}" "${A08_NIGHT:-no}"
  printf 'input_scope=phone touchscreen keyboard; stylus handwriting not tested\noriginal_stylus_handwriting_enabled=%s\n' "${old_handwriting:-unchanged}"
  printf 'cold_link_kind=%s\n' "${A08_COLD_LINK:-session}"
  printf 'back_input=%s\n' "${A08_BACK_INPUT:-key}"
  "$adb" -s "$serial" shell settings get secure navigation_mode
  "$adb" -s "$serial" shell wm size
  "$adb" -s "$serial" shell wm density
  "$adb" -s "$serial" shell settings get system font_scale
  "$adb" -s "$serial" shell cmd uimode night
  "$adb" -s "$serial" shell ime list -s
  "$adb" -s "$serial" shell settings get secure stylus_handwriting_enabled
  "$adb" -s "$serial" shell settings get secure enabled_accessibility_services
  "$adb" -s "$serial" shell pm list packages --show-versioncode com.google.android.marvin.talkback
} > "$output/conditions.txt"
[[ "$("$adb" -s "$serial" shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" == "${A08_NIGHT:-no}" ]] || { echo 'Requested night mode did not apply; not running under mislabeled conditions' >&2; exit 1; }
cp "$(dirname "$0")/../../shared/src/interaction-cards.fixture.json" "$output/corpus.json"
cp "$(dirname "$0")/../../shared/src/interaction-cards-review.fixture.json" "$output/review-corpus.json"
python3 "$(dirname "$0")/cards-fixture.py" --port 18768 > "$output/fixture.log" 2>&1 &
fixture_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18768/__stats > /dev/null; then break; fi
  sleep 0.2
done
kill -0 "$fixture_pid"
"$adb" -s "$serial" reverse tcp:18768 tcp:18768
"$adb" -s "$serial" shell am force-stop "$package"
"$adb" -s "$serial" shell run-as "$package" rm -rf files/a08-cards files/a08-captures.tar
"$adb" -s "$serial" shell run-as "$package" mkdir -p files/a08-cards
start="$("$adb" -s "$serial" shell date +%s | tr -d '\r').000"
test_class=io.orbitd.android.cards.CardsDeviceTest
test_selection="${A08_TEST:-$test_class#rememberUsesExactRuleAndServerRecord,$test_class#questionKeepsCustomAnswerThroughActivityRecreation,$test_class#otherEndWinsWithoutClaimingThisPressSucceeded,$test_class#lostResponseDoesNotResendOrClaimSuccess,$test_class#permissionRevocationWithdrawsTheEntireCard,$test_class#evidenceAndOwnerDecisionsBindDisplayedRevisions,$test_class#ownerQuestionsKeepEvidenceAndAnswersWithTheirQuestion,$test_class#singleTaskShowsTheServerDestinationAndHonestFallbacks,$test_class#dedicatedBusinessDoorsProduceSeparateRequestsAndRecordedStates,$test_class#attachmentOnlyMessageKeepsAttachmentWithoutRawJson}"
timeout 300 "$adb" -s "$serial" shell am instrument -w -r -e class "$test_selection" "$runner" > "$output/instrumentation.txt" 2>&1
pid="$(sed -n 's/.*a08_pid=\([0-9]*\).*/\1/p' "$output/instrumentation.txt" | head -1)"
[[ -n "$pid" ]]
"$adb" -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/logcat.txt"
if [[ -z "${A08_TEST:-}" ]]; then
  for method in coldPrepareFence coldRestoreFence; do
    "$adb" -s "$serial" shell am force-stop "$package"
    timeout 120 "$adb" -s "$serial" shell am instrument -w -r -e class "$test_class#$method" "$runner" > "$output/$method.txt" 2>&1
    cold_pid="$(sed -n 's/.*a08_pid=\([0-9]*\).*/\1/p' "$output/$method.txt" | head -1)"
    [[ -n "$cold_pid" ]]
    "$adb" -s "$serial" logcat -d -v threadtime --pid="$cold_pid" -T "$start" > "$output/$method-logcat.txt"
  done
fi
curl --fail --silent http://127.0.0.1:18768/__stats > "$output/server-stats.json"
"$adb" -s "$serial" shell run-as "$package" tar -cf files/a08-captures.tar -C files a08-cards > "$output/capture-create.txt" 2>&1
"$adb" -s "$serial" exec-out run-as "$package" cat files/a08-captures.tar > "$output/captures.tar"
tar --no-same-owner -xf "$output/captures.tar" -C "$output"
chmod -R a+rX "$output/a08-cards"
if rg 'a08-fixture-(password|access|refresh)' "$output/logcat.txt"; then
  echo 'Fixture credential marker found in logcat' >&2
  exit 1
fi
rg 'OK \([0-9]+ tests?\)' "$output/instrumentation.txt" >/dev/null
if [[ -z "${A08_TEST:-}" ]]; then
  rg 'OK \(1 test\)' "$output/coldPrepareFence.txt" >/dev/null
  rg 'OK \(1 test\)' "$output/coldRestoreFence.txt" >/dev/null
fi
if rg 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/instrumentation.txt"; then exit 1; fi
