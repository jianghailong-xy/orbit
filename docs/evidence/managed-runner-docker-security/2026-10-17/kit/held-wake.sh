#!/bin/bash
# D5: what a wake does while another container (a backup's helper) refers to the runner's volume.
set -euo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D sleep b
$D follow b "b asleep before the held wake" SLEEPING
$D hold b 150
$D wake b
$D watch b "woken while a helper container holds its volume" 60
$D release
$D watch b "after the helper is removed" 90
$D mapping b
