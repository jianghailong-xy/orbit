#!/usr/bin/env bash
# probe-run.sh TREE PROJECT: the scratch probe on a tree; prints its PROBE line.
set -u
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
tree=$1; project=$2
export TMPDIR=$V/tmp
mkdir -p "$TMPDIR"
cp "$T/probe/p44-probe.browser.mjs" "$V/$tree/src/web/ui-migration/"
for f in p44-fixtures.mjs; do cp "$WT/src/web/ui-migration/$f" "$V/$tree/src/web/ui-migration/$f"; done
out=$V/dev/probe-$tree-$project
rm -rf "$out"; mkdir -p "$out"
cd "$V/$tree/src/web"
systemd-run --scope --quiet -p MemoryMax=4G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P44_SNAPSHOTS="$out/shots" P44_OUTPUT="$out/out" npx playwright test --config ui-migration/p44.config.mjs --project "$project" --grep probe > "$out/log.txt" 2>&1
echo "exit=$?"
rm -f "$V/$tree/src/web/ui-migration/p44-probe.browser.mjs"
git -C "$V/$tree" checkout -q -- src/web/ui-migration/p44-fixtures.mjs
grep -E "passed|failed|Error" "$out/log.txt" | head -5
