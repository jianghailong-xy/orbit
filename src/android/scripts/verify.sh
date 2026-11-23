#!/usr/bin/env bash
# Clean local/CI verification, including evidence that both modules ran tests.
# --part runs one share of the whole (Android CI runs the three shares as parallel jobs);
# the default, all, runs every share in one build.
set -euo pipefail

usage() {
  echo "Usage: $0 [--part all|unit-debug|unit-release|lint-apk] [evidence-directory]" >&2
  exit 2
}
part=all
if [[ ${1:-} == --part ]]; then
  [[ $# -ge 2 ]] || usage
  part=$2
  shift 2
fi
[[ $# -le 1 ]] || usage
# Each share: the Gradle tasks it runs, the test tasks whose JUnit results it must show,
# and whether it builds the lint reports and the debug APK.
case "$part" in
  all)
    tasks=(test lintDebug assembleDebug)
    test_results=(core:test app:testDebugUnitTest app:testReleaseUnitTest)
    lint_apk=true ;;
  unit-debug)
    tasks=(:core:test :app:testDebugUnitTest)
    test_results=(core:test app:testDebugUnitTest)
    lint_apk=false ;;
  unit-release)
    tasks=(:app:testReleaseUnitTest)
    test_results=(app:testReleaseUnitTest)
    lint_apk=false ;;
  lint-apk)
    tasks=(:app:lintDebug :app:assembleDebug)
    test_results=()
    lint_apk=true ;;
  *) usage ;;
esac
android_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
evidence_dir=${1:-"$android_dir/.artifacts/verify-$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd)
existing_evidence=$(find "$evidence_dir" -mindepth 1 -maxdepth 1 -print -quit)
if [[ -n "$existing_evidence" ]]; then
  echo 'Use a new, empty evidence directory for each run' >&2
  exit 2
fi
: "${JAVA_HOME:?Set JAVA_HOME to a Java 21 installation}"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:?Set ANDROID_HOME to the Android SDK}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
gradle=(bash "$android_dir/gradlew" -p "$android_dir" --no-daemon --max-workers=2)

collect_evidence() {
  local result=$?
  trap - EXIT
  # Keep diagnostics on failures too. Presence here does not establish success;
  # the test census and required output checks below are the acceptance gates.
  for module in core app; do
    if ! mkdir -p "$evidence_dir/$module"; then
      result=1
      continue
    fi
    for output in reports test-results; do
      if [[ -d "$android_dir/$module/build/$output" ]]; then
        cp -R "$android_dir/$module/build/$output" "$evidence_dir/$module/" || result=1
      fi
    done
  done
  printf '%s\n' "$result" > "$evidence_dir/exit-code.txt"
  echo "Android verification exit=$result; evidence: $evidence_dir"
  exit "$result"
}
trap collect_evidence EXIT

git -C "$android_dir" rev-parse HEAD > "$evidence_dir/source-sha.txt"
git -C "$android_dir" status --porcelain > "$evidence_dir/worktree-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$evidence_dir/started-at.txt"
{
  "$JAVA_HOME/bin/java" -version
  "${gradle[@]}" --version
  cat "$ANDROID_HOME/platforms/android-36/source.properties"
  cat "$ANDROID_HOME/build-tools/36.0.0/source.properties"
} > "$evidence_dir/toolchain.txt" 2>&1

required_tasks=()
for result in ${test_results[@]+"${test_results[@]}"}; do required_tasks+=(":$result"); done
if $lint_apk; then required_tasks+=(:app:lintDebug :app:assembleDebug); fi
printf '%s\n' "$part" > "$evidence_dir/part.txt"

"${gradle[@]}" "${tasks[@]}" --dry-run 2>&1 | tee "$evidence_dir/task-graph.log"
for task in "${required_tasks[@]}"; do
  if ! grep -Fxq "$task SKIPPED" "$evidence_dir/task-graph.log"; then
    echo "Required task missing from Gradle task graph: $task" >&2
    exit 1
  fi
done

"${gradle[@]}" clean 2>&1 | tee "$evidence_dir/clean.log"
"${gradle[@]}" "${tasks[@]}" 2>&1 | tee "$evidence_dir/verification.log"
if [[ ${#test_results[@]} -gt 0 ]]; then
  python3 "$android_dir/scripts/check-test-results.py" "$android_dir" "${test_results[@]}" | tee "$evidence_dir/test-summary.txt"
fi
if ! $lint_apk; then
  exit 0
fi
test -s "$android_dir/app/build/reports/lint-results-debug.xml"
test -s "$android_dir/app/build/reports/lint-results-debug.html"
test -s "$android_dir/app/build/outputs/apk/debug/app-debug.apk"

mkdir -p "$evidence_dir/apk"
cp "$android_dir/app/build/outputs/apk/debug/"* "$evidence_dir/apk/"
(
  cd "$evidence_dir/apk"
  sha256sum app-debug.apk > SHA256SUMS
)
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$evidence_dir/apk/app-debug.apk" > "$evidence_dir/apk/badging.txt"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$evidence_dir/apk/app-debug.apk" > "$evidence_dir/apk/signing.txt"
