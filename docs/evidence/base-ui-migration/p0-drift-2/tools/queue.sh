#!/usr/bin/env bash
# Usage: queue.sh <jobs file> <parallel>   each line: <app-label> <runner> <run-label> [playwright args]
JOBS=$1 P=${2:-4}
grep -v '^\s*$' "$JOBS" | xargs -P "$P" -L 1 nice -n -5 /var/tmp/p0d2/scripts/run.sh 2>&1 | while read -r line; do echo "$(date -u +%T) $line"; done
echo "queue done"
