#!/usr/bin/env bash
# Usage: start-base.sh
# The lean build tree of the new base bcf00ab95 (label base), the tip runner (its P0 tests), then the update-mode full
# matrix on it (run.sh base tip full-base): the full failure surface against the expectation assembled at the start.
set -euo pipefail
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
bash $B/scripts/prepare-tree.sh bcf00ab953dc5797eff77e0e272c82b277852f81 base
bash $B/scripts/make-runner.sh bcf00ab953dc5797eff77e0e272c82b277852f81 tip base
echo "$(date -u +%FT%TZ) start full-base $(free -m | sed -n 2p | awk '{print "avail", $7}')"
bash $B/scripts/run.sh base tip full-base
