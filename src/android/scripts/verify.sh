#!/usr/bin/env bash
# Clean local/CI verification, including evidence that both modules ran tests.
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [evidence-directory]" >&2
  exit 2
fi
android_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
evidence_dir=${1:-"$android_dir/.artifacts/verify-$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd)
: "${JAVA_HOME:?Set JAVA_HOME to a Java 21 installation}"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:?Set ANDROID_HOME to the Android SDK}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
gradle=(bash "$android_dir/gradlew" -p "$android_dir" --no-daemon --max-workers=2)

collect_evidence() {
  local result=$?
  trap - EXIT
  printf '%s\n' "$result" > "$evidence_dir/exit-code.txt"
  # Keep diagnostics on failures too. Presence here does not establish success;
  # the test census and required output checks below are the acceptance gates.
  for module in core app; do
    mkdir -p "$evidence_dir/$module"
    for output in reports test-results; do
      if [[ -d "$android_dir/$module/build/$output" ]]; then
        cp -R "$android_dir/$module/build/$output" "$evidence_dir/$module/"
      fi
    done
  done
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

"${gradle[@]}" test lintDebug assembleDebug --dry-run 2>&1 | tee "$evidence_dir/task-graph.log"
for task in :core:test :app:testDebugUnitTest :app:testReleaseUnitTest :app:lintDebug :app:assembleDebug; do
  if ! grep -Fxq "$task SKIPPED" "$evidence_dir/task-graph.log"; then
    echo "Required task missing from Gradle task graph: $task" >&2
    exit 1
  fi
done

"${gradle[@]}" clean 2>&1 | tee "$evidence_dir/clean.log"
"${gradle[@]}" test lintDebug assembleDebug 2>&1 | tee "$evidence_dir/verification.log"
python3 "$android_dir/scripts/check-test-results.py" "$android_dir" | tee "$evidence_dir/test-summary.txt"
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
