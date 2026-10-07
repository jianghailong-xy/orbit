#!/usr/bin/env bash
# After final.sh: the P3.2 pilot on the delivery again, on port 4321 like its start-tip reference (pilot-tip)
# and the pre-commit run: share links carry the port, and pilot-final ran on 4173. Then the test that timed out
# in pilot-final under load (webkit-dark-desktop, "dependencies, inputs and comments") three more times.
set -u
R=/var/tmp/p4.1-293463/runs
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681
until grep -q '^== done' /root/.orbit/runs/3402ff96-4293-56f4-8940-d723dd9fa681/bgj_5fe95ef2a8e0.output 2>/dev/null; do sleep 10; done
run() { local name=$1; shift
  rm -rf $R/$name-shots $R/$name-out
  { echo "head: $(git -C $DEL rev-parse HEAD)"; echo "uncommitted:"; git -C $DEL status --short; echo "load: $(cat /proc/loadavg)"; echo "argv: $*"; } > $R/$name.log
  echo "== $name $(date -u +%T)"
  ( cd $DEL/src/web && nice -n -10 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P32_SNAPSHOTS=$R/$name-shots P32_OUTPUT=$R/$name-out P32_PORT=4321 "$@" ) >> $R/$name.log 2>&1
  echo "exit=$?" >> $R/$name.log; echo "load: $(cat /proc/loadavg)" >> $R/$name.log
  grep -E "✘|^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" $R/$name.log
}
run pilot-final2 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
run pilot-rerun npx playwright test pilot.browser.mjs --config ui-migration/pilot.config.mjs --update-snapshots=all --project webkit-dark-desktop -g "dependencies, inputs and comments" --repeat-each=3
echo "== done $(date -u +%T)"
