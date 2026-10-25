#!/usr/bin/env bash
# dev-run.sh TREE PROJECT [GREP]: one environment of the P5.2 spec on a tree (ref = v1/dev-ref, del = the task worktree),
# with the worktree's current spec, fixtures and config copied into ref; output under v1/dev/<tree>-<project>.
# For iterating on the spec, not for the record. (P4.4's dev-run.sh, for P5.2.)
set -u
T=/mnt/data/tmp/34Za39Mm04q5p66pqUTtj
V=$T/v1
WT=/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d
tree=$1; project=$2; grep=${3:-}
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
if [ "$tree" = ref ]; then dir=$V/dev-ref; else dir=$WT; fi
if [ "$tree" = ref ]; then
  for f in p52.browser.mjs p52-fixtures.mjs p52.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$dir/src/web/ui-migration/$f"; done
fi
out=$V/dev/$tree-$project
rm -rf "$out"; mkdir -p "$out"
cd "$dir/src/web"
args=(--config ui-migration/p52.config.mjs --project "$project" --update-snapshots=all)
[ -n "$grep" ] && args+=(--grep "$grep")
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P52_SNAPSHOTS="$out/shots" P52_OUTPUT="$out/out" npx playwright test "${args[@]}" > "$out/log.txt" 2>&1
echo "exit=$?"
grep -E "✓|✘|passed|failed|flaky|Error:|expect\(|Timeout|Unhandled|›.*ms\)" "$out/log.txt" | head -60
