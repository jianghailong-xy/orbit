#!/bin/bash
# D5: the Docker channel down while a sleeping runner (b) is woken and a running one (a) works; then the apiserver
# (the manager) down while a runs.
set -euo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
$D sleep b
$D follow b "b asleep before the channel outage" SLEEPING
$D channel-down
$D verify a "a after the channel outage"
$D verify b "b after the channel outage"
$D apiserver-down
$D verify a "a after the apiserver outage"
$D inventory 4-after-outages
