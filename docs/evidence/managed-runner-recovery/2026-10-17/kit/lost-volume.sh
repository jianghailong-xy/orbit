#!/bin/bash
# D7: a sleeping runner's volume lost, the runner woken (PVC_MISSING), the volume restored by the runbook's script, and
# the owner's Retry then accepted (PVC_RESTORED).
set -euo pipefail
D="python3 -I $(dirname "$0")/drill.py"
$D sleep b
$D follow b "b asleep before its volume is lost" SLEEPING
$D lose-and-restore b
