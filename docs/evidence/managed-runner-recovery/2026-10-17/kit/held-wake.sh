#!/bin/bash
# D7: a wake while the runbook's backup holds the runner's volume (its helper container refers to it): the runner waits
# and starts by itself once the backup is done.
set -euo pipefail
D="python3 -I $(dirname "$0")/drill.py"
$D sleep b
$D follow b "b asleep before the held wake" SLEEPING
$D held-wake b
