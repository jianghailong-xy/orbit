#!/usr/bin/env bash
# The final tree's production-build checks, one at a time once the submenu chunks (the process given) have ended:
#   1. the entry test that failed twice under load on 069601b67, ten times in its two projects (prod-runs.sh final
#      entry-repeat), then the same on the three components as they were before the fixes (Overlay.tsx, Select.tsx
#      and Menu.tsx from 0638f1944 in the working tree only, put back afterwards; prod-runs.sh prefix entry-repeat
#      records them as dirty);
#   2. prod-runs.sh final choices-entry overlays choices-list build pilot choices-full, then p0 last and alone.
# Usage: final-queue.sh <pid to wait for>
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
while kill -0 "$1" 2>/dev/null; do sleep 20; done
cd "$root"
echo "start $(date -u +%FT%TZ), $(df -h --output=avail / | tail -1) free"
bash "$here/prod-runs.sh" final entry-repeat
files='src/web/src/components/ui/Overlay.tsx src/web/src/components/ui/Select.tsx src/web/src/components/ui/Menu.tsx'
trap 'git checkout HEAD -- $files' EXIT
for f in $files; do git show 0638f1944:$f > $f; done  # the working tree only; the index keeps HEAD
bash "$here/prod-runs.sh" prefix entry-repeat
git checkout HEAD -- $files
trap - EXIT
echo "restored: $(git status --porcelain -- src/web | wc -l) changed paths under src/web"
bash "$here/prod-runs.sh" final choices-entry overlays choices-list build pilot choices-full
echo "before p0 $(date -u +%FT%TZ), $(df -h --output=avail / | tail -1) free"
bash "$here/prod-runs.sh" final p0
echo "end $(date -u +%FT%TZ)"
