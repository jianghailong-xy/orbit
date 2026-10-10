#!/usr/bin/env bash
# Usage: lane.sh <tree>...
# Update-mode full matrices (run.sh, runner tip) on each tree in order, each in the 6G cgroup (cg.sh). Resumable: run.sh
# keeps a run that already finished and redoes one an engine recycle cut short; a tree not built yet is built first.
# Batch 8: each build and run waits (up to 10 minutes) for MemAvailable >= 2000 MB first, as the shared host's memory rule asks.
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
gate() { for _ in $(seq 60); do [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -ge 2000 ] && return; sleep 10; done; echo "$(date -u +%FT%TZ) memory gate timed out, going on"; }
for c in "$@"; do
  if [ ! -f "$B/trees/$c/.built" ]; then gate; $B/scripts/cg.sh nice -n 10 bash $B/scripts/prepare-tree.sh "$c" "$c" || { echo "BUILD FAILED $c"; continue; }; fi
  gate
  echo "$(date -u +%FT%TZ) start full-$c $(free -m | sed -n 2p | awk '{print "avail", $7}')"
  $B/scripts/cg.sh nice -n 5 bash $B/scripts/run.sh "$c" tip "full-$c"
done
