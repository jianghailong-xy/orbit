#!/bin/bash
# native.sh <label> <rev>: the OrbitKit suite (swift:6.1, as ci.yml's Swift core) and the Android unit suite
# (:core:test :app:testDebugUnitTest) on a git archive of <rev> holding what those suites read. Logs under runs/<label>/.
set -o pipefail
K=/mnt/data/tmp/34pVMqv27RB2CakEffAzt
WT=/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f
label=$1; rev=$2
# A newer commit for this label, written while an earlier run was going (runs/<label>.rev), wins.
[ -f "$K/runs/$label.rev" ] && rev=$(cat "$K/runs/$label.rev")
out=$K/runs/$label; tree=$K/trees/$label
mkdir -p "$out"
exec > >(tee -a "$out/native.txt") 2>&1
sha=$(git -C "$WT" rev-parse "$rev")
echo "== $label = $sha at $(date -u +%FT%TZ)"
# Everything the suites read: src, contracts and docs without its evidence and its images (docs/mocks' pages and
# kits are read by copy-parity tests), then the evidence folders the tests cite, archived on top.
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
    if [ "$avail" -ge "${MIN_AVAIL:-4500}" ]; then good=$((good + 1)); else good=0
      echo "$(date -u +%FT%TZ) waiting for memory: MemAvailable ${avail} MB, load $(cut -d' ' -f1 /proc/loadavg)"; fi
    [ "$good" -lt 3 ] && sleep 20
  done
}
if [ "${SKIP_SWIFT:-0}" != 1 ]; then
  MIN_AVAIL=4000 wait_for_memory
  echo "== swift test ($label) at $(date -u +%FT%TZ), MemAvailable ${avail} MB"
  docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v "$tree":/repo -w /repo/src/macos/OrbitKit swift:6.1 \
    swift test -j 4 > "$out/swift.txt" 2>&1
  echo "== swift exit $? at $(date -u +%FT%TZ)"
  grep -a -E "Executed [0-9]+ tests" "$out/swift.txt" | tail -2
  grep -a -E "error: |: error -\[" "$out/swift.txt" | head -40
fi
if [ "${SKIP_ANDROID:-0}" != 1 ]; then
  source /opt/android-sdk/orbit-env.sh
  g=$K/gradle/$label; mkdir -p "$g/tmp" "$K/gradle-home"
  [ -d "$K/gradle-home/wrapper/dists/gradle-8.13-bin" ] || { mkdir -p "$K/gradle-home/wrapper/dists"; cp -a ~/.gradle/wrapper/dists/gradle-8.13-bin "$K/gradle-home/wrapper/dists/"; }
  cat > "$g/init.gradle" <<GRADLE
allprojects { p -> p.layout.buildDirectory.set(new File("$g/build", p.path == ":" ? "root" : p.path.substring(1).replace(':', '-'))) }
GRADLE
  for attempt in 1 2 3; do
    MIN_AVAIL=4500 wait_for_memory
    echo "== android ($label) attempt $attempt at $(date -u +%FT%TZ), MemAvailable ${avail} MB"
    (cd "$tree" && GRADLE_USER_HOME=$K/gradle-home GRADLE_RO_DEP_CACHE=/root/.gradle/caches JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=$g/tmp \
      systemd-run --scope --quiet -p MemoryMax=8G -- bash -c 'echo 900 > /proc/self/oom_score_adj; exec "$0" "$@"' \
      bash src/android/gradlew -p src/android --no-daemon --max-workers=2 -I "$g/init.gradle" --project-cache-dir "$g/project-cache" \
        -Pkotlin.project.persistent.dir="$g/dot-kotlin" -PorbitSourceSha="$sha" -PorbitSourceDirty=false --continue \
        :core:test :app:testDebugUnitTest) > "$out/android.txt" 2>&1
    code=$?
    echo "== android exit $code at $(date -u +%FT%TZ)"
    if [ "$code" -eq 137 ] || [ "$code" -eq 143 ]; then continue; fi
    break
  done
  rm -rf "$out/junit"; mkdir -p "$out/junit"
  for d in "$g"/build/app/test-results/* "$g"/build/core/test-results/*; do
    [ -d "$d" ] && mkdir -p "$out/junit/$(basename "$(dirname "$(dirname "$d")")")-$(basename "$d")" && cp "$d"/*.xml "$out/junit/$(basename "$(dirname "$(dirname "$d")")")-$(basename "$d")/" 2>/dev/null
  done
  python3 -I "$K/bin/summary.py" "$out/junit" | grep -v "^  pass" 
fi
echo "== $label done at $(date -u +%FT%TZ)"
