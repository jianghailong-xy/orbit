#!/bin/bash
# dev.sh <gradle tasks…>: Gradle on the session worktree itself, build dirs on /mnt/data (no files in the tree), in a capped scope.
set -o pipefail
K=/mnt/data/tmp/34pVMqy3QOa4qY1jBWvZA
WT=/root/.orbit/worktrees/41be4669-3b10-52a7-ae41-50c2d4f87791
g=$K/gradle/dev; mkdir -p "$g/tmp" "$K/runs/dev"
source /opt/android-sdk/orbit-env.sh
[ -d "$K/gradle-home/wrapper/dists/gradle-8.13-bin" ] || { mkdir -p "$K/gradle-home/wrapper/dists"; cp -a ~/.gradle/wrapper/dists/gradle-8.13-bin "$K/gradle-home/wrapper/dists/"; }
cat > "$g/init.gradle" <<GRADLE
allprojects { p -> p.layout.buildDirectory.set(new File("$g/build", p.path == ":" ? "root" : p.path.substring(1).replace(':', '-'))) }
GRADLE
unit="a-dev-$$"
cd "$WT" && GRADLE_USER_HOME=$K/gradle-home GRADLE_RO_DEP_CACHE=/root/.gradle/caches JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=$g/tmp \
  systemd-run --scope --quiet --unit="$unit" -p MemoryMax=8G -- bash -c 'echo 900 > /proc/self/oom_score_adj; exec timeout 3000 "$0" "$@"' \
  bash src/android/gradlew -p src/android --no-daemon --max-workers=2 -I "$g/init.gradle" --project-cache-dir "$g/project-cache" \
    -Pkotlin.project.persistent.dir="$g/dot-kotlin" --continue "$@"
code=$?
systemctl stop "$unit.scope" 2>/dev/null
exit $code
