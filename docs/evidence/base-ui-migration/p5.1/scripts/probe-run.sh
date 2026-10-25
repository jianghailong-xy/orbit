#!/usr/bin/env bash
# probe-run.sh TREE PROJECT GREP OUT: run the development probe spec (probe/p51-zz-probe.browser.mjs, never committed)
# on a tree (del | devref), writing what it measures to OUT.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
tree=$1; project=$2; grep=$3; out=$4
dir=$WT; [ "$tree" = del ] || dir=$V/$tree
cp /mnt/data/tmp/34Za39L1H6V82d2sobzPY/probe/p51-zz-probe.browser.mjs "$dir/src/web/ui-migration/p51-zz-probe.browser.mjs"
[ "$tree" = del ] || cp "$WT/src/web/ui-migration/p51-fixtures.mjs" "$dir/src/web/ui-migration/p51-fixtures.mjs"
cd "$dir/src/web"
export TMPDIR=$V/tmp
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 4G unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env PROBE_OUT="$out" P51_SNAPSHOTS=$V/probe-shots P51_OUTPUT=$V/probe-out npx playwright test --config ui-migration/p51.config.mjs --grep "$grep" --project "$project" 2>&1 | grep -E "passed|failed|Error" | head -5
rm -f "$dir/src/web/ui-migration/p51-zz-probe.browser.mjs"
