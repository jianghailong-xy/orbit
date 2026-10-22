#!/bin/bash
# D5: the backup and restore drill on account b's managed volume, by the runbook (scripts/managed-runner/volume-backup.sh).
set -euo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D seed a "a seeded"
$D seed b "b seeded, before its backup"
$D sleep b
$D follow b "b asleep for its backup" SLEEPING
$D pool "b asleep"
$D backup b
$D restore-check b
$D disable b true
$D lose-and-restore b
$D disable b false
$D wake b
$D follow b "b woken on its restored volume" READY
$D verify b "b after the restore"
$D pool "b woken on its restored volume"
$D inventory 2-after-restore
