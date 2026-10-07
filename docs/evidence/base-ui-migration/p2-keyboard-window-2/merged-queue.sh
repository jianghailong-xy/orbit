#!/usr/bin/env bash
# Browser checks on this branch after it merged the project tip, one at a time, resumable, each starting only with at
# least 6 GB free on / (the coordinator's floor for this shared disk):
#   1. the held-frames probe, one project per run (held-frames-merged-<project>, 49 cases each);
#   2. the choices original entry in eight projects (prod-runs.sh merged choices-entry).
# Usage: merged-queue.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
gate() {
  while [ "$(df --output=avail -B1M / | tail -1 | tr -d ' ')" -lt 6144 ]; do
    echo "$(date -u +%FT%TZ) $1 waits for 6 GB free on /"; sleep 60
  done
}
echo "start $(date -u +%FT%TZ) at $(git rev-parse --short HEAD), $(df -h --output=avail / | tail -1) free"
for project in chromium-light-desktop chromium-light-phone chromium-dark-desktop chromium-dark-phone \
               webkit-light-desktop webkit-light-phone webkit-dark-desktop webkit-dark-phone; do
  name=held-frames-merged-$project
  [ -e "$here/$name" ] || rm -rf "/var/tmp/kw2-246921c8/runs/$name"
  gate "$name"
  python3 "$here/run-chunks.py" docs/evidence/base-ui-migration/p2-keyboard-window-2/held-frames-2.config.mjs held-frames-merged \
    --project "$project" "$project="
done
bash "$here/prod-runs.sh" merged choices-entry
echo "end $(date -u +%FT%TZ)"
