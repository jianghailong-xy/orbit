#!/usr/bin/env bash
# probe-repeat.sh TREE SPEC PROJECT GREP N OUT: a development probe spec (never committed) repeated N times on a tree
# (del | devref) at the lowest CPU priority, its files written under OUT-*. Not for the record.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
tree=$1; spec=$2; project=$3; grep=$4; n=$5; out=$6
dir=$WT; [ "$tree" = del ] || dir=$V/$tree
name=$(basename "$spec")
cp "$spec" "$dir/src/web/ui-migration/$name"
[ "$tree" = del ] || cp "$WT/src/web/ui-migration/p51-fixtures.mjs" "$dir/src/web/ui-migration/p51-fixtures.mjs"
cd "$dir/src/web"
export TMPDIR=$V/tmp
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 4G nice -n 19 unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env PROBE_OUT="$out" P51_SNAPSHOTS=$V/probe-shots P51_OUTPUT=$V/probe-out npx playwright test --config ui-migration/p51.config.mjs \
  --grep "$grep" --project "$project" --repeat-each "$n" --update-snapshots=all 2>&1 | grep -E "^\s+[0-9]+ (passed|failed|flaky)|Error" | head -5
rm -f "$dir/src/web/ui-migration/$name"
