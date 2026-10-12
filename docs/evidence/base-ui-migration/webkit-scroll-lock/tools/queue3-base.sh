#!/usr/bin/env bash
# The rest of the final round on the reference tree at the project tip (its production build is the project tip's,
# built by the reference-side pilot run); interrupted steps are moved aside and rerun as in queue3-mine.sh.
set -u
T=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trees/base
D=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
B=$D/bin
. $B/step.sh
START=15b7b5609
[ "$(git -C "$T" rev-parse --short=9 HEAD)" = $START ] || exit 2
step p42 probes; $D/probes/run-p42-probes.sh "$T" "f2-$START"
[ -e "$D/probes/out-f2-announce-$START/report.json" ] || { step announce; PROBE_CONFIG=announce.config.mjs $B/run-probe.sh "$T" "f2-announce-$START" probe-announce-duplicate.browser.mjs; }
step queue done
