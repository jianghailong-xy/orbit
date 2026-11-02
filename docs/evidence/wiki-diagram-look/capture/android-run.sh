#!/bin/bash
# run.sh <label> <gradle args...>: waits for memory (three samples 30 s apart), then runs the worktree's gradlew in a capped scope
# outside the runner's cgroup, build dirs on /mnt/data; again after an OOM kill. JUnit XML copied under runs/<label>/.
set -o pipefail
source /opt/android-sdk/orbit-env.sh
tree=/root/.orbit/worktrees/01a1983d-edb5-76c6-ab76-80ba6672bf4f
kit=/mnt/data/tmp/wiki-diagram-look/android
label=$1; shift
cd "$tree" || exit 2
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$kit/tmp"; mkdir -p "$kit/tmp"
wait_for_memory() {
  local good=0
  while [ "$good" -lt 3 ]; do
    avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    if [ "$avail" -ge "${MIN_AVAIL:-4000}" ]; then good=$((good + 1)); else good=0; echo "$(date -u +%T) waiting: MemAvailable ${avail} MB"; fi
    [ "$good" -lt 3 ] && sleep 30
  done
}
for attempt in 1 2 3; do
  wait_for_memory
  echo "== $label attempt $attempt at $(date -u +%FT%TZ); MemAvailable ${avail} MB; load $(cut -d' ' -f1-3 /proc/loadavg)"
  systemd-run --scope --quiet --unit="wdl-$label-$attempt-$$" -p MemoryMax=8G -- bash -c 'echo 900 > /proc/self/oom_score_adj; exec timeout 2400 "$0" "$@"' \
    bash src/android/gradlew -p src/android --no-daemon --max-workers=2 -I "$kit/init.gradle" --project-cache-dir "$kit/project-cache" \
    -Pkotlin.project.persistent.dir="$kit/dot-kotlin" "$@"
  code=$?
  if [ "$code" -eq 137 ] || [ "$code" -eq 143 ]; then echo "== killed (exit $code)"; continue; fi
  break
done
echo "== $label: gradle exit $code at $(date -u +%FT%TZ)"
rm -rf "$kit/runs/$label"; mkdir -p "$kit/runs/$label"
cp -r "$kit/build/app/test-results/." "$kit/runs/$label/" 2>/dev/null
exit $code
