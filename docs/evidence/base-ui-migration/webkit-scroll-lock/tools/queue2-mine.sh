#!/usr/bin/env bash
# Final round on the session worktree at its head (the fix on the project tip, origin/main merged in), one suite at
# a time (one build/dev server per tree). Resumable: a step whose output exists is skipped; failures don't stop it.
set -u
W=/root/.orbit/worktrees/3a1c46ee-9958-51c0-b844-89a44ffe9d25
D=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
B=$D/bin
C=$(git -C "$W" rev-parse --short=9 HEAD)
step() { echo "== $(date -u +%FT%TZ) $*"; }
[ -e "$D/runs/f2-app-frame-after-$C" ] || { step app-frame; $B/run-entry.sh "$W" overlays.config.mjs "f2-app-frame-after-$C" overlays-app-frame.browser.mjs; }
[ -e "$D/runs/f2-toasts-$C" ] || { step toasts; $B/run-entry.sh "$W" toasts.config.mjs "f2-toasts-$C"; }
[ -e "$D/p0/f2-after-$C" ] || { step p0 originals; $B/p0-originals.sh "$W" "$D/p0/f2-after-$C"; }
[ -e "$D/p0/f2-standard-$C" ] || { step p0 standard; $B/p0-standard.sh "$W" "$D/p0/f2-standard-$C"; }
for e in p42 p41 pilot; do [ -e "$D/entries/f2-$e-after-$C" ] || { step "$e"; $B/entry-shots.sh "$W" "$e" "$D/entries/f2-$e-after-$C"; }; done
[ -e "$D/probes/f2-p42probes-$C.done" ] || { step p42 probes; $D/probes/run-p42-probes.sh "$W" "f2-$C" && touch "$D/probes/f2-p42probes-$C.done"; }
[ -e "$D/probes/f2-announce-$C.txt" ] || { step announce; PROBE_CONFIG=announce.config.mjs $B/run-probe.sh "$W" "f2-announce-$C" probe-announce-duplicate.browser.mjs; }
[ -e "$D/runs/f2-overlays-$C" ] || { step overlays; $B/run-entry.sh "$W" overlays.config.mjs "f2-overlays-$C"; }
[ -e "$D/runs/f2-choices-$C" ] || { step choices; $B/run-entry.sh "$W" choices.config.mjs "f2-choices-$C"; }
step queue done
