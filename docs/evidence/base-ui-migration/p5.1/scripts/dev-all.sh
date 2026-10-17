#!/usr/bin/env bash
# dev-all.sh TREE NAME: every environment of the P5.1 spec on a tree (del | devref) in one Playwright run; output under
# v1/dev/NAME-<tree>. For the development round, not for the record.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
tree=$1; name=$2
dir=$WT; [ "$tree" = del ] || dir=$V/$tree
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
out=$V/dev/$name-$tree
rm -rf "$out"; mkdir -p "$out"
cd "$dir/src/web"
echo "== $tree all $(date -u +%T) HEAD $(git -C "$dir" rev-parse --short HEAD) load $(cut -d' ' -f1 /proc/loadavg) mem $(free -m | awk '/Mem:/{print $7}')M / $(df --output=avail -BM / | tail -1 | tr -d ' ')"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 6G unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P51_SNAPSHOTS="$out/shots" P51_OUTPUT="$out/out" npx playwright test --config ui-migration/p51.config.mjs --update-snapshots=all > "$out/log.txt" 2>&1
echo "exit=$? $(date -u +%T)"
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|✘" "$out/log.txt" | head -40
