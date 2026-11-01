#!/bin/bash
# android.sh <label> <rev> [gradle tasks…]: the Android unit suite (:core:test :app:testDebugUnitTest by default) on a git
# archive of <rev> holding what those suites read (task 34pVMqy3QOa4qY1jBWvZA; adapted from the web task's capture/native.sh).
# Logs and JUnit XML under runs/<label>/.
set -o pipefail
K=/mnt/data/tmp/34pVMqy3QOa4qY1jBWvZA
WT=/root/.orbit/worktrees/41be4669-3b10-52a7-ae41-50c2d4f87791
label=$1; rev=$2; shift 2
tasks=("$@"); [ ${#tasks[@]} -eq 0 ] && tasks=(:core:test :app:testDebugUnitTest)
out=$K/runs/$label; tree=$K/trees/$label
mkdir -p "$out"
exec > >(tee -a "$out/android.log.txt") 2>&1
sha=$(git -C "$WT" rev-parse "$rev")
echo "== $label = $sha at $(date -u +%FT%TZ): ${tasks[*]}"
base=(src contracts docs ':(exclude)docs/evidence')
for ext in png jpg jpeg JPEG gif webp mp4 mov; do base+=(":(exclude,glob)docs/**/*.$ext"); done
extra=()
for p in docs/evidence/antigravity-google-login docs/evidence/cursor-engine docs/evidence/ios-http-ip docs/evidence/landing-observation \
         docs/evidence/landing-session-android docs/evidence/project-main-branch-reads docs/evidence/project-main-branch-web; do
  [ -n "$(git -C "$WT" ls-tree -d "$sha" "$p")" ] && extra+=("$p")
done
if [ ! -f "$tree/.archived-$sha" ]; then
  rm -rf "${tree:?}"; mkdir -p "$tree"
  git -C "$WT" archive "$sha" -- "${base[@]}" | tar -x -C "$tree" || { echo "archive failed"; exit 2; }
  if [ ${#extra[@]} -gt 0 ]; then git -C "$WT" archive "$sha" -- "${extra[@]}" | tar -x -C "$tree" || { echo "archive failed"; exit 2; }; fi
  touch "$tree/.archived-$sha"
fi
wait_for_memory() {
  local good=0
  while [ "$good" -lt 3 ]; do
    avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    swapfree=$(awk '/SwapFree/ {print int($2/1024)}' /proc/meminfo)
    if [ "$avail" -ge "${MIN_AVAIL:-4000}" ] || { [ "$avail" -ge 3000 ] && [ "$swapfree" -ge 8000 ]; }; then good=$((good + 1)); else good=0
      echo "$(date -u +%FT%TZ) waiting for memory: MemAvailable ${avail} MB, SwapFree ${swapfree} MB, load $(cut -d' ' -f1 /proc/loadavg)"; fi
    [ "$good" -lt 3 ] && sleep 20
  done
}
source /opt/android-sdk/orbit-env.sh
g=$K/gradle/$label; mkdir -p "$g/tmp" "$K/gradle-home"
[ -d "$K/gradle-home/wrapper/dists/gradle-8.13-bin" ] || { mkdir -p "$K/gradle-home/wrapper/dists"; cp -a ~/.gradle/wrapper/dists/gradle-8.13-bin "$K/gradle-home/wrapper/dists/"; }
cat > "$g/init.gradle" <<GRADLE
allprojects { p -> p.layout.buildDirectory.set(new File("$g/build", p.path == ":" ? "root" : p.path.substring(1).replace(':', '-'))) }
GRADLE
for attempt in 1 2 3; do
  wait_for_memory
  echo "== android ($label) attempt $attempt at $(date -u +%FT%TZ), MemAvailable ${avail} MB"
  unit="a-$label-$$-$attempt"
  (cd "$tree" && GRADLE_USER_HOME=$K/gradle-home GRADLE_RO_DEP_CACHE=/root/.gradle/caches JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=$g/tmp \
    systemd-run --scope --quiet --unit="$unit" -p MemoryMax=8G -- bash -c 'echo 900 > /proc/self/oom_score_adj; exec timeout 3000 "$0" "$@"' \
    bash src/android/gradlew -p src/android --no-daemon --max-workers=2 -I "$g/init.gradle" --project-cache-dir "$g/project-cache" \
      -Pkotlin.project.persistent.dir="$g/dot-kotlin" -PorbitSourceSha="$sha" -PorbitSourceDirty=false --continue \
      "${tasks[@]}") > "$out/gradle.txt" 2>&1
  code=$?
  systemctl stop "$unit.scope" 2>/dev/null
  echo "== android exit $code at $(date -u +%FT%TZ)"
  if [ "$code" -eq 137 ] || [ "$code" -eq 143 ]; then continue; fi
  break
done
rm -rf "$out/junit"; mkdir -p "$out/junit"
for d in "$g"/build/app/test-results/* "$g"/build/core/test-results/*; do
  [ -d "$d" ] && mkdir -p "$out/junit/$(basename "$(dirname "$(dirname "$d")")")-$(basename "$d")" && cp "$d"/*.xml "$out/junit/$(basename "$(dirname "$(dirname "$d")")")-$(basename "$d")/" 2>/dev/null
done
python3 -I "$K/bin/summary.py" "$out/junit" | grep -v "^  pass" | tee "$out/summary.txt"
grep -a -E "BUILD (SUCCESSFUL|FAILED)|^e: |error:" "$out/gradle.txt" | head -20
echo "== $label done at $(date -u +%FT%TZ)"
