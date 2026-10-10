#!/usr/bin/env bash
# dev-run.sh TREE PROJECT [GREP]: one environment of the P5.1 spec on a tree (del = the task worktree, devref = the
# development reference), the worktree's current spec, fixtures and config copied into the reference; output under
# v1/dev/<tree>-<project>. For iterating on the spec, not for the record.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
tree=$1; project=$2; grep=${3:-}
dir=$WT; [ "$tree" = del ] || dir=$V/$tree
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
if [ "$tree" != del ]; then for f in p51.browser.mjs p51-fixtures.mjs p51.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$dir/src/web/ui-migration/$f"; done; fi
out=$V/dev/$tree-$project
rm -rf "$out"; mkdir -p "$out"
cd "$dir/src/web"
args=(--config ui-migration/p51.config.mjs --project "$project" --update-snapshots=all)
[ -n "$grep" ] && args+=(--grep "$grep")
echo "== $tree $project $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg) mem $(free -m | awk '/Mem:/{print $7}')M / $(df --output=avail -BM / | tail -1 | tr -d ' ')"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 6G unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P51_SNAPSHOTS="$out/shots" P51_OUTPUT="$out/out" npx playwright test "${args[@]}" > "$out/log.txt" 2>&1
code=$?
echo "exit=$code $(date -u +%T)"
grep -E "✓|✘|passed|failed|flaky|skipped|Error:|expect\(|Timeout|Unhandled|Received|Expected" "$out/log.txt" | head -80
