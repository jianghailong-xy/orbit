#!/usr/bin/env bash
# pilot-detail-rerun.sh TREE N: the pilot's "fields, pickers and the panel header" on webkit-light-phone, N separate runs,
# each writing its screenshots to try/pilot-rerun/<tree>-<i>/shots (the formal pilot-del run took pilot-detail there before
# the lazy task graph had drawn).
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W; tree=$1; n=$2
export TMPDIR=$V/tmp
for i in $(seq 1 $n); do
  O=$V/try/pilot-rerun/$tree-$i; mkdir -p $O
  ( cd $V/$tree/src/web && unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P32_SNAPSHOTS=$O/shots P32_OUTPUT=$O/out P32_PORT=4321 \
    npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all --project webkit-light-phone -g 'fields, pickers and the panel header' > $O.log 2>&1 )
  echo "$tree run $i: $(sed 's/\x1b\[[0-9;]*m//g' $O.log | grep -E '^\s+[0-9]+ (passed|failed)' | tr -s ' ' | tr '\n' ' ')"
done
