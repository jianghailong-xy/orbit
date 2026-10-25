#!/usr/bin/env bash
# merge-tree-check.sh MAIN RUN: the rule for main moving after the final round, when it touches none of this batch's files
# but a layer the batch's checks depend on (here the P0 harness: P0 drift batch 7): no rebase; the delivery merged with
# MAIN as a temporary commit (git merge-tree --write-tree + commit-tree, never pushed), checked out on /mnt/data, built,
# and run with the standard P0 regression and this batch's own suite (p44.browser.mjs, all eight environments).
# Logs under v1/RUN as formal.sh writes them; resumable.
set -u
MAIN=${1:?main commit}; RUN=${2:?run name}
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
R=$V/$RUN
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
M=$V/merged
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
delivery=$(git -C "$WT" rev-parse HEAD)
tree=$(git -C "$WT" merge-tree --write-tree "$delivery" "$MAIN") || { echo "merge-tree: conflict"; exit 1; }
merged=$(git -C "$WT" commit-tree "$tree" -p "$delivery" -p "$MAIN" -m "temporary: P4.4 delivery merged with $MAIN (never pushed)")
echo "delivery $delivery + main $(git -C "$WT" rev-parse "$MAIN") = tree $tree, temporary commit $merged" | tee "$R/merge-tree.txt"
if [ -d "$M" ]; then git -C "$M" checkout -q --detach "$merged"; else git -C "$WT" worktree add -q --detach "$M" "$merged"; fi
ln -sfn "$WT/node_modules" "$M/node_modules"
mkdir -p "$M/src/web/node_modules"; cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$M/src/web/node_modules/"
(cd "$M/src/web" && npx vite build 2>&1 | tail -1)
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1; shift
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  { echo "argv: $*"; echo "tree: $M"; echo "head: $(git -C "$M" rev-parse HEAD)"; echo "uncommitted:"; git -C "$M" status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"
    echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$M/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^exit=" "$R/$name.txt"
}
step p0-standard-merged npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p "$R/p0-standard-merged-out" && cp -a "$M/src/web/.ui-migration-results/." "$R/p0-standard-merged-out/"
step p44-merged env P44_SNAPSHOTS="$R/p44-merged-shots" P44_OUTPUT="$R/p44-merged-out" npx playwright test --config ui-migration/p44.config.mjs --update-snapshots=all
echo "== done $(date -u +%T)"
