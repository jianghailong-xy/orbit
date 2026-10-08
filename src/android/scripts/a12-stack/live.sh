#!/usr/bin/env bash
# A12 on the isolated real stack: one locked device run on an emulator (never a physical phone).
#   adb reverse tcp:3712 → install both APKs → pm clear → each WikiWatchLiveTest journey in order; after each one the
#   server is read back from the host (readback.mjs, as the owner and as the other account) and the journey's captures
#   and logcat are pulled → the reverse removed and the device settings restored, then the lock released.
# Usage: live.sh APP_APK TEST_APK EVIDENCE_DIR [SERIAL]
#   The stack must be built and freshly seeded first (setup.sh build; setup.sh reset) — cycle.sh does both.
#   Resumable: run it again with the same APKs and EVIDENCE_DIR after an interruption and it skips the journeys that
#   already have a result in journeys.txt. A journey cut off midway runs again; if it decides or stops something its
#   precondition then fails, and only a new cycle (a fresh seed, a new evidence directory) can run it again.
#   SERIAL defaults to emulator-5554. A12_LIVE_JOURNEYS="j1… j2…" runs only those methods; A12_LOCK_WAIT (default
#   3600) is how long to wait for the device lock; A12_STACK_DIR / A12_STACK_API_PORT as for setup.sh.
set -uo pipefail

die() { echo "live.sh: $*" >&2; exit 2; }
(( $# == 3 || $# == 4 )) || die "usage: $0 APP_APK TEST_APK EVIDENCE_DIR [SERIAL]"
apk=$(realpath "$1"); tests=$(realpath "$2"); out=$(realpath -m "$3"); serial=${4:-emulator-5554}
here=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S=$(realpath -m "${A12_STACK_DIR:-/var/tmp/a12-stack}")
port=${A12_STACK_API_PORT:-3712}
server=http://127.0.0.1:$port
ADB=${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb
# The node helpers run from this checkout and find the stack by these two.
export A12_STACK_DIR=$S A12_STACK_API_PORT=$port
package=io.orbitd.android.debug
runner=io.orbitd.android.debug.test/androidx.test.runner.AndroidJUnitRunner
class=io.orbitd.android.wiki.WikiWatchLiveTest
all=(j1OwnerOpensTheSpaceSearchesAndOpensAnEntry j2OwnerAcceptsTheFreshProposal j3OwnerAcceptsTheStaleProposalAndIsRefused
  j4OwnerEditsAnEntry j5OwnerChangesTheReviewMode j6OwnerPausesResumesAndStopsTheWatch j7aOtherAccountOpensTheOwnersEntry
  j7bOtherAccountOpensTheOwnersSpace j7cOtherAccountOpensTheOwnersWatch j8OwnerRevertsARun)
# shellcheck disable=SC2206
journeys=(${A12_LIVE_JOURNEYS:-${all[*]}})

[[ -f "$apk" && -f "$tests" ]] || die 'APKs not found'
[[ "$serial" == emulator-* ]] || die "refusing $serial: emulators only"
apk_shas="$(sha256sum "$apk" | cut -d' ' -f1) $(sha256sum "$tests" | cut -d' ' -f1)"
mkdir -p "$out"
# A run this script (or cycle.sh) started carries .a12-live, with the APKs it was started with.
if [[ -f "$out/.a12-live" ]]; then
  recorded=$(sed -n 's/^apks=//p' "$out/.a12-live")
  [[ -z "$recorded" || "$recorded" == "$apk_shas" ]] || die "$out was started with other APKs: use a new evidence directory"
  [[ -n "$recorded" ]] || echo "apks=$apk_shas" >> "$out/.a12-live"
elif [[ -z "$(ls -A "$out")" ]]; then
  echo "apks=$apk_shas" > "$out/.a12-live"
else
  die "$out must be new, empty, or a run this script started"
fi
[[ -f "$S/seed.json" && -f "$S/accounts.json" ]] || die "no seeded stack in $S (setup.sh reset, or cycle.sh)"
curl -fsS -m 5 "$server/api/health" > /dev/null || die "the stack does not answer on $server (setup.sh start)"
# The test's arguments carry the stack's test passwords: read into memory, never written to the evidence.
mapfile -t live_args < <(node "$here/live-args.mjs" "$server")
(( ${#live_args[@]} > 0 )) || die 'could not read the seeded ids'
mapfile -t secrets < <(node -e 'const a=require(process.argv[1]);console.log(a.owner.password);console.log(a.other.password)' "$S/accounts.json")
invocation=$(( $(cat "$out/invocations" 2>/dev/null || echo 0) + 1 )); echo "$invocation" > "$out/invocations"

# Host memory pressure starves the emulator (ANRs, null screenshots): wait for PSI full avg10 < 10 first (up to 30 min).
for _ in $(seq 1 180); do
  awk '/^full/ {split($2,a,"="); exit !(a[2] < 10)}' /proc/pressure/memory && break
  sleep 10
done
{ echo "invocation=$invocation before_lock_utc=$(date -u +%FT%TZ)"; cat /proc/pressure/memory; uptime; } >> "$out/host.txt"

# The adb server is started before the lock is held, and no adb call inherits the lock's fd: a server spawned with
# fd 9 open would hold the device lock for as long as it lives.
"$ADB" start-server > /dev/null 2>&1
adb() { "$ADB" -s "$serial" "$@" 9>&-; }
exec 9> "${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w "${A12_LOCK_WAIT:-3600}" 9 || die 'device lock busy; no device action performed'
printf 'invocation=%s lock_acquired_utc=%s\n' "$invocation" "$(date -u +%FT%TZ)" >> "$out/lock.txt"

old_font=''; old_night=''; reversed=''
cleanup() {
  local result=$?
  trap - EXIT
  adb shell am force-stop "$package" > /dev/null 2>&1 || true
  [[ -n "$reversed" ]] && { adb reverse --remove "tcp:$port" > /dev/null 2>&1 || result=1; }
  if [[ -n "$old_font" ]]; then
    if [[ "$old_font" == null ]]; then adb shell settings delete system font_scale > /dev/null 2>&1
    else adb shell settings put system font_scale "$old_font" > /dev/null 2>&1; fi
    adb shell cmd uimode night "$old_night" > /dev/null 2>&1
    printf 'invocation=%s font=%s night=%s restored_font=%s restored_night=%s\n' "$invocation" "$old_font" "$old_night" \
      "$(adb shell settings get system font_scale | tr -d '\r')" "$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')" >> "$out/restored-settings.txt"
  fi
  { echo "invocation=$invocation"; adb reverse --list 2>&1; } >> "$out/reverse-after.txt"
  printf 'invocation=%s exit_code=%s finished_utc=%s\n' "$invocation" "$result" "$(date -u +%FT%TZ)" >> "$out/result.txt"
  exit "$result"
}
trap cleanup EXIT
if [[ ! -f "$out/result.txt" ]]; then
  printf 'scope=A12 Wiki/Watch on an isolated real Orbit stack (apiserver + runner of %s, loopback, own PostgreSQL); emulator only; not production, not a physical phone, not iOS\nstarted_utc=%s\n' \
    "$(cat "$S/SOURCE_SHA")" "$(date -u +%FT%TZ)" > "$out/result.txt"
else
  printf 'resumed_utc=%s (invocation %s)\n' "$(date -u +%FT%TZ)" "$invocation" >> "$out/result.txt"
fi
printf 'invocation=%s scripts_checkout_head=%s dirty_paths=%s\n' "$invocation" "$(git -C "$here" rev-parse HEAD)" \
  "$(git -C "$here" status --porcelain -- "$here/../.." | wc -l)" >> "$out/source-sha.txt"
cp "$S/SOURCE_SHA" "$out/server-source-sha.txt"
cp "$S/seed.json" "$out/seed.json"
{ echo "invocation=$invocation"; bash "$S/setup.sh" status 2>&1; } >> "$out/stack-status.txt" 9>&-
timeout 30 "$ADB" -s "$serial" wait-for-device 9>&-
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || die "$serial is not an emulator"
{
  printf 'serial=%s\n' "$serial"
  for prop in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint ro.kernel.qemu; do
    printf '%s=%s\n' "$prop" "$(adb shell getprop "$prop" | tr -d '\r')"
  done
} > "$out/device.txt"
sha256sum "$apk" "$tests" | sed -E 's#  .*/#  #' > "$out/apks.sha256"
adb reverse "tcp:$port" "tcp:$port" >> "$out/reverse.txt" 2>&1 && reversed=1
adb install -r "$apk" >> "$out/install-app.txt" 2>&1
adb install -r "$tests" >> "$out/install-tests.txt" 2>&1
# Other tasks reinstall this package between holds: what is installed now is checked against the APK built here.
installed=$(adb shell pm path "$package" | tr -d '\r' | sed -n 's/^package://p' | head -1)
printf 'invocation=%s installed=%s built=%s\n' "$invocation" "$(adb shell sha256sum "$installed" | awk '{print $1}')" \
  "$(sha256sum "$apk" | awk '{print $1}')" >> "$out/installed-sha256.txt"
adb shell am force-stop "$package"
# A dedicated signed-out installation: other tasks share this emulator and leave their own login behind.
adb shell pm clear "$package" >> "$out/clear-app.txt" 2>&1
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
old_font=$(adb shell settings get system font_scale | tr -d '\r')
old_night=$(adb shell cmd uimode night | awk '{print $NF}' | tr -d '\r')
adb shell settings put system font_scale "${A12_FONT_SCALE:-1.0}"
adb shell cmd uimode night "${A12_NIGHT:-no}" > /dev/null
printf 'font=%s\nnight=%s\n' "${A12_FONT_SCALE:-1.0}" "${A12_NIGHT:-no}" > "$out/conditions.txt"

mkdir -p "$out/server"
[[ -f "$out/server/00-before.json" ]] || node "$here/readback.mjs" before > "$out/server/00-before.json" 2> "$out/server/00-before.err" 9>&-
touch "$out/journeys.txt"
for journey in "${journeys[@]}"; do
  if command grep -qE "^(PASS|FAIL) $journey\$" "$out/journeys.txt"; then echo "skip $journey (already run)" >> "$out/skipped.txt"; continue; fi
  n=1; for each in "${all[@]}"; do [[ "$each" == "$journey" ]] && break; n=$((n + 1)); done
  nn=$(printf '%02d' "$n")
  start="$(adb shell date +%s | tr -d '\r').000"
  timeout 900 "$ADB" -s "$serial" shell am instrument -w -r -e class "$class#$journey" "${live_args[@]}" "$runner" \
    > "$out/instrumentation-$journey.txt" 2>&1 9>&-
  { echo "== $journey (invocation $invocation)"; cat "$out/instrumentation-$journey.txt"; } >> "$out/instrumentation.txt"
  if command grep -aq '^OK (1 test)' "$out/instrumentation-$journey.txt"; then echo "PASS $journey" >> "$out/journeys.txt"
  else echo "FAIL $journey" >> "$out/journeys.txt"; fi
  node "$here/readback.mjs" "$journey" > "$out/server/$nn-$journey.json" 2> "$out/server/$nn-$journey.err" 9>&-
  # The journey's captures and log, pulled at once, so an interruption keeps every journey that finished.
  for pid in $(sed -n 's/.*a12_pid=\([0-9]*\).*/\1/p' "$out/instrumentation-$journey.txt" | sort -u); do
    adb logcat -d -v threadtime --pid="$pid" -T "$start" > "$out/logcat-$journey-$pid.txt" 2>&1
  done
  adb shell run-as "$package" tar -cf files/a12-live.tar -C files a12-live >> "$out/capture-create.txt" 2>&1
  adb exec-out run-as "$package" cat files/a12-live.tar > "$out/.captures.tar" && tar --no-same-owner -xf "$out/.captures.tar" -C "$out"
  rm -f "$out/.captures.tar"
done
chmod -R a+rX "$out"
printf 'journeys=%s\npassed=%s\nfailed=%s\nscreenshots=%s\nscreenshots_missing=%s\n' "${#all[@]}" \
  "$(command grep -c '^PASS' "$out/journeys.txt")" "$(command grep -c '^FAIL' "$out/journeys.txt")" \
  "$(find "$out/a12-live" -name '*.png' 2>/dev/null | wc -l)" "$(find "$out/a12-live" -name '*-screenshot-missing.txt' 2>/dev/null | wc -l)" >> "$out/result.txt"
status=0
command grep -q '^FAIL' "$out/journeys.txt" && status=1
if command grep -aE 'Process crashed|INSTRUMENTATION_FAILED' "$out"/instrumentation-*.txt > "$out/crashes.txt"; then status=1; fi
# The stack's test passwords must not reach the device log or the evidence.
for secret in "${secrets[@]}"; do
  if command grep -rqaF -- "$secret" "$out"; then echo 'a test password reached the evidence or the device log' >> "$out/result.txt"; status=1; fi
done
exit "$status"
