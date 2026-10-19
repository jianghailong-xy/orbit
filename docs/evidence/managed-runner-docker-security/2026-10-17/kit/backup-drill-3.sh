#!/bin/bash
# D5: the backup and restore drill, run 3 with the final volume-backup.sh (check and restore inspect as the runner user), on account b's managed volume, by the runbook (scripts/managed-runner/volume-backup.sh).
set -euo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D seed a "a seeded (backup run 3)"
$D seed b "b seeded, before its backup (run 3)"
$D sleep b
$D follow b "b asleep for its backup (run 3)" SLEEPING
$D pool "b asleep (backup run 3)"
$D backup b
$D restore-check b
$D disable b true
$D lose-and-restore b
$D disable b false
$D wake b
$D follow b "b woken on its restored volume (run 3)" READY
$D verify b "b after the restore (run 3)"
$D pool "b woken on its restored volume (run 3)"
$D inventory 2c-after-restore-run-3
