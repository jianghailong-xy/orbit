#!/usr/bin/env bash
# The final tree's remaining runs, one at a time, resumable (finished chunks and recorded steps are skipped, so after
# an interruption the same command carries on). Each starts only with at least 6 GB free on / (the coordinator's floor
# for this shared disk), waiting until then. Playwright keeps every test's trace scratch (about 1 MB a test) until the
# run ends, so the runs are cut small: 200 submenu samples, or one project of the choices matrix, at a time.
#   1. the Orbit submenu burst/paced samples again (aed0a7bab changed only the submenu trigger): sequence groups a, b
#      and c of the earlier chunks, each target on its own (after2-sub-<group>-<field|sample|session>);
#   2. the entry test that failed twice under load on 069601b67, ten times in its two projects (prod-runs.sh final
#      entry-repeat), then the same on the three components as they were before the fixes (Overlay.tsx, Select.tsx
#      and Menu.tsx from 0638f1944 in the working tree only, put back afterwards; prod-runs.sh prefix entry-repeat
#      records them as dirty). A run killed in between cannot put them back itself, so the queue puts them back first;
#   3. prod-runs.sh final choices-entry overlays choices-list build pilot, the choices matrix project by project, then
#      p0 last and alone.
# Usage: final-queue.sh
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
echo "start $(date -u +%FT%TZ), $(df -h --output=avail / | tail -1) free"
config=docs/evidence/base-ui-migration/p2-keyboard-window-2/keyboard-window-2.config.mjs
for group in 'a=(sub-right|sub-right-enter|sub-right-down-enter|sub-right-up-enter|sub-right-left)' \
             'b=(sub-right-escape|sub-right-space|sub-right-home-enter|sub-right-end-enter|sub-right-c-enter)' \
             'c=(sub-right-tab|sub-right-shift-tab|sub-enter|sub-enter-enter|sub-enter-down-enter)'; do
  for target in field=orbit-submenu sample=orbit-submenu-sample session=orbit-session; do
    name=after2-sub-${group%%=*}-${target%%=*}
    # An interrupted chunk is run again from the start; its partial raw results are dropped rather than kept.
    [ -e "$here/$name" ] || rm -rf "/var/tmp/kw2-246921c8/runs/$name"
    gate "$name"
    python3 "$here/run-chunks.py" $config after2 "sub-${group%%=*}-${target%%=*}= ${target#*=} ${group#*=} (burst|paced) sample"
  done
done
bash "$here/prod-runs.sh" final entry-repeat
if [ ! -e "$here/checks/prod-prefix-entry-repeat.json" ]; then
  gate prefix-entry-repeat
  trap 'git checkout HEAD -- $files' EXIT
  for f in $files; do git show 0638f1944:$f > $f; done  # the working tree only; the index keeps HEAD
  bash "$here/prod-runs.sh" prefix entry-repeat
  git checkout HEAD -- $files
  trap - EXIT
  echo "restored: $(git status --porcelain -- src/web | wc -l) changed paths under src/web"
fi
bash "$here/prod-runs.sh" final choices-entry overlays choices-list build pilot
for project in chromium-light-desktop chromium-light-phone chromium-dark-desktop chromium-dark-phone \
               webkit-light-desktop webkit-light-phone webkit-dark-desktop webkit-dark-phone; do
  bash "$here/prod-runs.sh" final "choices-full:$project"
done
echo "before p0 $(date -u +%FT%TZ), $(df -h --output=avail / | tail -1) free"
bash "$here/prod-runs.sh" final p0
echo "end $(date -u +%FT%TZ)"
