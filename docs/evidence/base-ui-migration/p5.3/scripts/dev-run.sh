#!/usr/bin/env bash
# dev-run.sh TREE PROJECT [GREP]: one environment of the P5.3 spec on a tree (ref = v1/dev-ref, del = the task worktree),
# with the worktree's current spec, fixtures and config copied into ref; output under v1/dev/<tree>-<project>.
# For iterating on the spec, not for the record. (P5.2's dev-run.sh, for P5.3.)
set -u
T=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ
V=$T/v1
WT=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833
tree=$1; project=$2; grep=${3:-}
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
if [ "$tree" = ref ]; then dir=$V/dev-ref; else dir=$WT; fi
if [ "$tree" = ref ]; then
  for f in p53.browser.mjs p53-fixtures.mjs p53.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$dir/src/web/ui-migration/$f"; done
fi
out=$V/dev/$tree-$project
rm -rf "$out"; mkdir -p "$out"
cd "$dir/src/web"
args=(--config ui-migration/p53.config.mjs --project "$project" --update-snapshots=all)
[ -n "$grep" ] && args+=(--grep "$grep")
port=4373; [ "$tree" = ref ] && port=4374
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P53_PORT=$port P53_SNAPSHOTS="$out/shots" P53_OUTPUT="$out/out" npx playwright test "${args[@]}" > "$out/log.txt" 2>&1
echo "exit=$?"
grep -E "✓|✘|passed|failed|flaky|Error:|expect\(|Timeout|Unhandled|›.*ms\)" "$out/log.txt" | head -60
