#!/usr/bin/env bash
# final-chain.sh DELIVERY SWITCH START: the final round. The OrbitKit swift suite (its copy-parity tests read web sources this
# batch changes) runs on the delivery (final-tree, the same commit) in the swift:6.1 container beside the tree builds;
# then the formal chain, the comparisons, the probes, the 2026-10-09 extras and the final inventory audit.
# Resumable (a runner restart or a usage stop kills the job): the swift run is skipped once its log has an exit code for
# DELIVERY, the trees once make-trees.sh has recorded them (trees.txt) for these three commits, and every later script
# skips what it has finished.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
. $V/scripts/memgate.sh
delivery=$1; switch=$2; start=$3
mkdir -p $V/swift
SW=
if [ "$(cat $V/swift/head.txt 2>/dev/null)" = "$delivery" ] && grep -q '^exit=' $V/swift/swift-test.txt 2>/dev/null; then
  echo "== swift already run on $delivery"
else
  ( git -C $V/final-tree rev-parse HEAD > $V/swift/head.txt
    docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v "$V/final-tree":/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test > $V/swift/swift-test.txt 2>&1
    echo "exit=$?" >> $V/swift/swift-test.txt ) &
  SW=$!
fi
if [ "$(cat $V/trees.txt 2>/dev/null)" = "$delivery $switch $start" ]; then
  echo "== trees already made for $delivery $switch $start"
else
  bash $V/scripts/make-trees.sh "$delivery" "$switch" "$start" || exit 1
fi
[ -n "$SW" ] && wait $SW
echo "== swift test on $(cat $V/swift/head.txt): $(tail -1 $V/swift/swift-test.txt); $(grep -aE 'Executed [0-9]+ tests' $V/swift/swift-test.txt | tail -1)"
# formal.sh, probes.sh and extras.sh put each heavy command in its own scope; the comparisons and the audit run in one each.
bash $V/scripts/formal.sh && scoped bash $V/scripts/analyze.sh && bash $V/scripts/probes.sh && bash $V/scripts/extras.sh && scoped bash $V/scripts/final-audit.sh
