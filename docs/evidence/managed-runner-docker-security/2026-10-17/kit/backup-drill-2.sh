#!/bin/bash
# D5: the backup and restore drill, run 2 with the final volume-backup.sh, on account b's managed volume, by the runbook (scripts/managed-runner/volume-backup.sh).
set -euo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D seed a "a seeded (backup run 2)"
$D seed b "b seeded, before its backup (run 2)"
$D sleep b
$D follow b "b asleep for its backup (run 2)" SLEEPING
$D pool "b asleep (backup run 2)"
$D backup b
$D restore-check b
$D disable b true
$D lose-and-restore b
$D disable b false
$D wake b
$D follow b "b woken on its restored volume (run 2)" READY
$D verify b "b after the restore (run 2)"
$D pool "b woken on its restored volume (run 2)"
$D inventory 2b-after-restore-run-2
