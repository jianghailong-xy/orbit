#!/usr/bin/env bash
# Usage: negative-controls.sh <commit> <outdir>
# Both negative controls of this registration at once, each through negative-control.sh in its own scratch
# worktree ($P32ACC/trees/before and $P32ACC/trees/p32, default P32ACC=/var/tmp/p32acc, prepared by
# prepare-tree.sh): negative-control-share-close.css and negative-control-more-menu.css on <commit>. Exits 0
# only when both P0 runs failed with exit 1; which tests failed, and on which screenshots, is read from each
# run's report afterwards.
set -u
T=$(cd "$(dirname "$0")" && pwd)
B=${P32ACC:-/var/tmp/p32acc}
C=$1 OUT=$2
mkdir -p "$OUT"
bash "$T/negative-control.sh" "$B/trees/before" "$C" "$T/negative-control-share-close.css" "$OUT/share-close" > "$OUT/share-close.log" 2>&1 &
p1=$!
bash "$T/negative-control.sh" "$B/trees/p32" "$C" "$T/negative-control-more-menu.css" "$OUT/more-menu" > "$OUT/more-menu.log" 2>&1 &
p2=$!
wait $p1; a=$?
wait $p2; b=$?
tail -n 2 "$OUT/share-close.log" "$OUT/more-menu.log"
echo "share-close P0 exit $a, more-menu P0 exit $b"
[ "$a" -eq 1 ] && [ "$b" -eq 1 ]
