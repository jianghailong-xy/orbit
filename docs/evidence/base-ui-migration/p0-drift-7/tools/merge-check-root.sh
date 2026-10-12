#!/usr/bin/env bash
# The project's merge check on the final tree, run in the session worktree on / (NVMe): /mnt/data is a
# rotational disk and, with the host's page cache at ~4 GB, Vitest workers there spent minutes per file in
# disk wait. Dependencies are the documented overlay (bash scripts/worktree-overlay.sh: an isolated npm ci of
# this lockfile, since the main checkout's node_modules do not satisfy it), the "依赖叠加" the project's disk
# rule allows on /. Refuses to start below 6 GB free on / (df -BM), as the rule says, and records df before and
# after. The overlay is removed afterwards by the caller, once the result is read.
set -u
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
REPO=/root/.orbit/worktrees/7b29ebf3-809f-53aa-806b-8c6b5048ea78
OUT=$B/checks/merge-check-final
free_mb() { df -BM --output=avail / | tail -1 | tr -dc '0-9'; }
mkdir -p "$OUT"
echo "root free before overlay: $(free_mb)M" > "$OUT/disk.txt"
[ "$(free_mb)" -ge 7000 ] || { echo "refusing: under 7000M free before the ~800M overlay" | tee -a "$OUT/disk.txt"; exit 3; }
(cd "$REPO" && bash scripts/worktree-overlay.sh) > "$OUT/overlay.txt" 2>&1 || { echo "overlay failed"; tail -20 "$OUT/overlay.txt"; exit 4; }
echo "root free after overlay: $(free_mb)M" >> "$OUT/disk.txt"
[ "$(free_mb)" -ge 6000 ] || { echo "refusing: under 6000M free, the rule's floor for a build" | tee -a "$OUT/disk.txt"; exit 3; }
bash $B/scripts/merge-check.sh "$REPO" "$OUT"
code=$?
echo "root free after merge check: $(free_mb)M" >> "$OUT/disk.txt"
exit $code
