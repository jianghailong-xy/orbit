#!/bin/bash
# D7: a real out-of-memory kill of a READY runner (its memory limit lowered below what it uses), and the restart.
set -euo pipefail
D="python3 -I $(dirname "$0")/drill.py"
$D oom a
