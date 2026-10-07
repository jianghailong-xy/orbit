#!/usr/bin/env bash
# Repeat the two small P0 beyond-level shots (breakpoint-639-projects chromium-dark-desktop, task-action-focus
# chromium-light-phone) twice on each tree, each run writing its own screenshot set.
set -u
R=/var/tmp/p4.1-293463/runs
REF=/var/tmp/p4.1-293463/tip/src/web
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web
for n in 1 2; do
  for side in ref del; do
    dir=$REF; [ $side = del ] && dir=$DEL
    name=n-$side-$n
    ( cd $dir && unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P32_SNAPSHOTS=$R/$name-shots P32_OUTPUT=$R/$name-out P32_PORT=4173 \
      npx playwright test breakpoints.browser.mjs pages.browser.mjs --config ui-migration/p32-reference.config.mjs --update-snapshots=all \
      --project chromium-dark-desktop --project chromium-light-phone -g "both sides| task$" ) > $R/$name.log 2>&1
    echo "$name exit=$? $(grep -E '^\s+[0-9]+ (passed|failed|skipped)' $R/$name.log | tr -s ' ' | tr '\n' ' ')"
  done
done
