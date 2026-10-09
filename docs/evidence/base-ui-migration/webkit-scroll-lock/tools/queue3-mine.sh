#!/usr/bin/env bash
# The rest of the final round on the session worktree at its head, one suite at a time. A step counts as done only
# when its completion file exists (summary.txt / exit.txt / .done); an interrupted step is moved aside and rerun.
set -u
W=/root/.orbit/worktrees/3a1c46ee-9958-51c0-b844-89a44ffe9d25
D=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
B=$D/bin
. $B/step.sh
C=$(git -C "$W" rev-parse --short=9 HEAD)
for e in p42 p41 pilot; do done_or_clear "$D/entries/f2-$e-after-$C" summary.txt || { step "$e"; $B/entry-shots.sh "$W" "$e" "$D/entries/f2-$e-after-$C"; }; done
step p42 probes; $D/probes/run-p42-probes.sh "$W" "f2-$C"
[ -e "$D/probes/out-f2-announce-$C/report.json" ] || { step announce; PROBE_CONFIG=announce.config.mjs $B/run-probe.sh "$W" "f2-announce-$C" probe-announce-duplicate.browser.mjs; }
step queue done
