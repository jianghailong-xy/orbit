#!/usr/bin/env bash
# The checks rerun on the new base, after this branch was rebased onto origin/main (c7efa24cb), one at a time,
# resumable (finished chunks and recorded steps are skipped), each starting only with at least 6 GB free on / (the
# coordinator's floor for this shared disk). In the coordinator's order:
#   1. the shared package's build from the new base's sources, then the project's merge check (prod-runs.sh
#      rebased shared-build merge-check);
#   2. the held-frames probe, one project per run (held-frames-rebased-<project>, 49 cases each);
#   3. the choices original entry in eight projects, then P0 by its original command;
#   4. the whole choices matrix, one project per run;
#   5. pilot-repeat.sh: the pilot test behind the one screenshot difference, five times with these components and
#      five times with the three components as on the base.
# Usage: rebased-queue.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
files='src/web/src/components/ui/Overlay.tsx src/web/src/components/ui/Select.tsx src/web/src/components/ui/Menu.tsx'
git diff --quiet HEAD -- $files || { echo "putting back $files"; git checkout HEAD -- $files; }
gate() {
  while [ "$(df --output=avail -B1M / | tail -1 | tr -d ' ')" -lt 6144 ]; do
    echo "$(date -u +%FT%TZ) $1 waits for 6 GB free on /"; sleep 60
  done
}
echo "start $(date -u +%FT%TZ) at $(git rev-parse --short HEAD) on $(git merge-base HEAD origin/main | cut -c1-9), $(df -h --output=avail / | tail -1) free"
bash "$here/prod-runs.sh" rebased shared-build merge-check
projects='chromium-light-desktop chromium-light-phone chromium-dark-desktop chromium-dark-phone webkit-light-desktop webkit-light-phone webkit-dark-desktop webkit-dark-phone'
for project in $projects; do
  name=held-frames-rebased-$project
  [ -e "$here/$name" ] || rm -rf "/var/tmp/kw2-246921c8/runs/$name"
  gate "$name"
  python3 "$here/run-chunks.py" docs/evidence/base-ui-migration/p2-keyboard-window-2/held-frames-2.config.mjs held-frames-rebased \
    --project "$project" "$project="
done
bash "$here/prod-runs.sh" rebased choices-entry p0
for project in $projects; do
  bash "$here/prod-runs.sh" rebased "choices-full:$project"
done
[ -s "$here/pilot-repeat.csv" ] && [ "$(wc -l < "$here/pilot-repeat.csv")" -ge 21 ] || bash "$here/pilot-repeat.sh"
echo "end $(date -u +%FT%TZ)"
