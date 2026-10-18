#!/bin/bash
# D7: a real out-of-memory kill of a READY runner (its memory limit lowered below what it uses), and the restart.
set -euo pipefail
D="python3 -I $(dirname "$0")/drill.py"
# 24m was not enough (17:43Z: the kernel reclaimed page cache and the runner went on); 8m is.
$D oom a "${1:-8m}"
# The status reads READY until the manager's next pass sees the stop: wait for the next generation.
$D until-generation a "after the out-of-memory kill, nobody pressing Retry" "${2:-4}"
