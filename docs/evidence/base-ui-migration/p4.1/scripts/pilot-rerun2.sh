#!/usr/bin/env bash
# The pilot test that timed out in pilot-final2 under load (webkit-dark-desktop, "fields, pickers and the panel
# header"), three times on the delivery, at higher priority, in its own network namespace, on port 4321.
set -u
R=/var/tmp/p4.1-293463/runs
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681
name=pilot-rerun2
rm -rf $R/$name-shots $R/$name-out
{ echo "head: $(git -C $DEL rev-parse HEAD)"; echo "uncommitted:"; git -C $DEL status --short; echo "load: $(cat /proc/loadavg)"; } > $R/$name.log
( cd $DEL/src/web && nice -n -10 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P32_SNAPSHOTS=$R/$name-shots P32_OUTPUT=$R/$name-out P32_PORT=4321 \
  npx playwright test pilot.browser.mjs --config ui-migration/pilot.config.mjs --update-snapshots=all --project webkit-dark-desktop \
  -g "fields, pickers and the panel header" --repeat-each=3 ) >> $R/$name.log 2>&1
echo "exit=$?" >> $R/$name.log; echo "load: $(cat /proc/loadavg)" >> $R/$name.log
grep -E "✓|✘|^\s+[0-9]+ (passed|failed|flaky)|^exit=" $R/$name.log
