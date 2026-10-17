#!/bin/bash
# D5: one restart of the test host d5-dind (graceful | powercut), as the coordinator asked on 2026-10-17: account a READY
# with a SQLite writer running in its container, account b put to sleep just before. The sampler (drill.py sample) runs
# beside it as its own job.
set -euo pipefail
MODE="$1"
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D events
$D writer a
$D sleep b
$D follow b "b put to sleep just before the $MODE restart" SLEEPING
$D pool "before the $MODE restart"
sleep 5
$D restart "$MODE"
