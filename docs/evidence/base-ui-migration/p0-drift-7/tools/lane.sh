#!/usr/bin/env bash
# Usage: lane.sh <tree>...
# Update-mode full matrices (run.sh, runner tip) on each tree in order, each in the 6G cgroup (cg.sh). Resumable: run.sh
# keeps a run that already finished and redoes one an engine recycle cut short; a tree not built yet is built first.
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
for c in "$@"; do
  [ -f "$B/trees/$c/.built" ] || $B/scripts/cg.sh nice -n 10 bash $B/scripts/prepare-tree.sh "$c" "$c" || { echo "BUILD FAILED $c"; continue; }
  echo "$(date -u +%FT%TZ) start full-$c $(free -m | sed -n 2p | awk '{print "avail", $7}')"
  $B/scripts/cg.sh nice -n 5 bash $B/scripts/run.sh "$c" tip "full-$c"
done
