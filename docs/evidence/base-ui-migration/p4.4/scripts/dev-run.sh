#!/usr/bin/env bash
# dev-run.sh TREE PROJECT [GREP]: one environment of the P4.4 spec on a tree (ref|del), with the worktree's current spec,
# fixtures and config copied in; output under v1/dev/<tree>-<project>. For iterating on the spec, not for the record.
set -u
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
tree=$1; project=$2; grep=${3:-}
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
for f in p44.browser.mjs p44-fixtures.mjs p44.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$V/$tree/src/web/ui-migration/$f"; done
out=$V/dev/$tree-$project
rm -rf "$out"; mkdir -p "$out"
cd "$V/$tree/src/web"
args=(--config ui-migration/p44.config.mjs --project "$project" --update-snapshots=all)
[ -n "$grep" ] && args+=(--grep "$grep")
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P44_SNAPSHOTS="$out/shots" P44_OUTPUT="$out/out" npx playwright test "${args[@]}" > "$out/log.txt" 2>&1
echo "exit=$?"
grep -E "✓|✘|passed|failed|flaky|Error:|expect\(|Timeout|Unhandled" "$out/log.txt" | head -60
