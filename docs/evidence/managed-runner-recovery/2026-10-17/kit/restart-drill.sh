#!/bin/bash
# D7: one restart of the test host d7-dind (graceful | powercut), as D5 ran them: account a READY with a SQLite writer
# running in its container, account b put to sleep just before. Nobody presses Retry afterwards: drill.py follows a
# until it is READY again by itself. The sampler (drill.py sample) runs beside it as its own job.
set -euo pipefail
MODE="$1"
D="python3 -I $(dirname "$0")/drill.py"
$D events
$D writer a
$D sleep b
$D follow b "b put to sleep just before the $MODE restart" SLEEPING
$D pool "before the $MODE restart"
sleep 5
$D restart "$MODE"
