#!/usr/bin/env bash
# Final round on the reference tree: the test commit (no fix) for the app-frame test, then the project tip (the
# batch's start; its web code differs from the head only by this batch's three files) for everything else.
set -u
T=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trees/base
D=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
B=$D/bin
TEST=78cae80d9 START=15b7b5609
step() { echo "== $(date -u +%FT%TZ) $*"; }
git -C "$T" checkout --quiet --detach $TEST || exit 2
[ -e "$D/runs/f2-app-frame-before-$TEST" ] || { step app-frame; $B/run-entry.sh "$T" overlays.config.mjs "f2-app-frame-before-$TEST" overlays-app-frame.browser.mjs; }
git -C "$T" checkout --quiet --detach $START || exit 2
[ -e "$D/runs/f2-toasts-$START" ] || { step toasts; $B/run-entry.sh "$T" toasts.config.mjs "f2-toasts-$START"; }
[ -e "$D/p0/f2-before-$START" ] || { step p0 originals; $B/p0-originals.sh "$T" "$D/p0/f2-before-$START"; }
[ -e "$D/p0/f2-standard-$START" ] || { step p0 standard; $B/p0-standard.sh "$T" "$D/p0/f2-standard-$START"; }
for e in p42 p41 pilot; do [ -e "$D/entries/f2-$e-before-$START" ] || { step "$e"; $B/entry-shots.sh "$T" "$e" "$D/entries/f2-$e-before-$START"; }; done
[ -e "$D/probes/f2-p42probes-$START.done" ] || { step p42 probes; $D/probes/run-p42-probes.sh "$T" "f2-$START" && touch "$D/probes/f2-p42probes-$START.done"; }
[ -e "$D/probes/f2-announce-$START.txt" ] || { step announce; PROBE_CONFIG=announce.config.mjs $B/run-probe.sh "$T" "f2-announce-$START" probe-announce-duplicate.browser.mjs; }
step queue done
