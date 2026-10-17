#!/usr/bin/env bash
# After checks.sh: the P3.2 pilot on the final delivery (the start tip's run, pilot-tip, is its reference),
# then the P4.1 CLI and photo tests twice more on each tree (run-to-run variation of their screenshots).
set -u
R=/var/tmp/p4.1-293463/runs
REF=/var/tmp/p4.1-293463/tip/src/web
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web
until grep -q '^exit=' $R/c-merge.log 2>/dev/null; do sleep 10; done
ns() { unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@"; }
run() { local name=$1 dir=$2; shift 2; echo "== $name $(date -u +%T) head $(git -C $dir rev-parse --short HEAD)"; ( cd $dir && { echo "head: $(git rev-parse HEAD)"; git status --short; } > $R/$name.log && ns "$@" >> $R/$name.log 2>&1 ); local code=$?; echo "exit=$code" >> $R/$name.log; grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" $R/$name.log; }
rm -rf $R/pilot-final-* $R/rep-*
run pilot-final $DEL env P32_SNAPSHOTS=$R/pilot-final-shots P32_OUTPUT=$R/pilot-final-out P32_PORT=4173 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
for n in 1 2; do
  for side in ref del; do
    dir=$REF; [ $side = del ] && dir=$DEL
    run rep-$side-$n $dir env P41_SNAPSHOTS=$R/rep-$side-$n-shots P41_OUTPUT=$R/rep-$side-$n-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all -g "photo|approve|deny|denied"
  done
done
echo "== done $(date -u +%T)"
