#!/usr/bin/env bash
# collect.sh RUN: copy what thumbnail-accessible-name/README.md cites from the runs on /mnt/data/tmp/34dTUqxH5MjymjtUhs5C5
# into the evidence directory (P5.3's collect.sh, for this follow-up):
#  - the round's logs (terminal colour codes removed; argv, tree, HEAD, load, disk and exit at the top and bottom of
#    each) and the Playwright reports with attachment bodies removed (p0-drift-3/tools/report-summary.py);
#  - the comparisons (analyze.sh) and both trees' traces of the P5.3 attachments case;
#  - the second run of P0 and P5.2 on each tree (noise.sh, analyze-noise.py) and the choices reds on four trees
#    (choices-origin.sh);
#  - the name probe (names-both.sh) and the unit tests before and after the fix (red-green.sh);
#  - the merge check and the OrbitKit run (summaries), the inventory check;
#  - two of the byte-identical screenshots (the thumbnail staged, and hovered), once, with their hashes in both trees;
#  - the scripts as run.
# Raw runs stay on /mnt/data until judged.
set -eu
T=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5
V=$T/v1
RUN=${1:-f1}
R=$V/$RUN
C=$V/compare-$RUN
E=/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff/docs/evidence/base-ui-migration/thumbnail-accessible-name
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare traces names unit shots scripts; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done
mkdir -p "$E/checks"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for n in p0-ref p0-strict p0-del p52-ref p52-del p53att-ref p53att-del p0-standard p0-standard-base overlays choices \
         p0-ref2 p0-del2 p52-ref2 p52-del2; do log "$R/$n.txt" "$E/runs/$n.txt"; done
for n in p0-strict p52-ref p52-del p53att-ref p53att-del p0-standard p0-standard-base overlays choices p52-ref2 p52-del2; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"; done
log "$V/formal-$RUN.log" "$E/runs/formal-$RUN.log"
log "$V/noise-$RUN.log" "$E/runs/noise-$RUN.log"
# The choices cases red on the phones, on the delivery, the reference and either side of P5.3's switch (choices-origin.sh).
mkdir -p "$E/runs/choices-origin"
for n in del ref pre at; do log "$R/choices-origin/$n.txt" "$E/runs/choices-origin/$n.txt"
  $SUMMARY "$R/choices-origin/$n-out/report.json" "$E/runs/choices-origin/$n.report.summary.json" > /dev/null; done
cp "$C/p0-summary.json" "$C/p52-summary.json" "$C/p53att-summary.json" "$C/p52-trace-semantics.json" "$C/p53att-trace-semantics.json" \
   "$C/p0-standard-compare.txt" "$C/analyze.txt" "$C/p0-noise.json" "$C/p0-noise.txt" "$C/p52-noise.json" "$C/p52-noise.txt" "$E/compare/"
for p in ref2-del2 ref-ref2 del-del2; do cp "$C/p52-trace-semantics-$p.json" "$E/compare/"; done
python3 -I "$E/../p4.1/extract-traces.py" "$R/p53att-ref-out/report.json" "$E/traces/p53att-ref.json" > /dev/null
python3 -I "$E/../p4.1/extract-traces.py" "$R/p53att-del-out/report.json" "$E/traces/p53att-del.json" > /dev/null
cp "$R/names/names-ref.json" "$R/names/names-del.json" "$R/names/names-ref.head" "$R/names/names-del.head" "$E/names/"
log "$V/unit/before.txt" "$E/unit/before.txt"; log "$V/unit/after.txt" "$E/unit/after.txt"
# Two screenshots of the thumbnail that are byte-identical in both trees, kept once; their hashes in both trees.
for s in p53-attach-chip p53-attach-hover; do cp "$R/p53att-del-shots/chromium-light-desktop/$s.png" "$E/shots/$s.chromium-light-desktop.png"; done
( cd "$R" && sha256sum p53att-ref-shots/chromium-light-desktop/p53-attach-chip.png p53att-del-shots/chromium-light-desktop/p53-attach-chip.png \
    p53att-ref-shots/chromium-light-desktop/p53-attach-hover.png p53att-del-shots/chromium-light-desktop/p53-attach-hover.png ) > "$E/shots/sha256.txt"
{ echo "# npm run build -w @orbit/web && npm run test -w @orbit/web on the task worktree (NVMe), after round $RUN, at the head below."
  echo "# Build output and the Vitest summary; the full log stays at $V/merge-check-$RUN.log until judged."; echo
  sed 's/\x1b\[[0-9;]*m//g' "$V/merge-check-$RUN.log" | grep -E "^head:|^mem:|^> |vite v|built in|error TS|modules transformed|Test Files|Tests |Duration|FAIL|^exit="; } > "$E/checks/merge-check.txt"
{ echo "# docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v <v1/del>:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test -j 4 --scratch-path /repo/.swift-build"
  echo "# on the delivery checkout v1/del, after round $RUN. The head, and the suite's summary lines:"; echo
  grep -E "^head:" "$V/swift-$RUN.log"; grep -E "Executed [0-9]+ tests" "$V/swift-$RUN.log" | tail -2; grep -cE "error:|failed \(" "$V/swift-$RUN.log" | sed 's/^/error or failed lines: /'; grep -E "^exit=" "$V/swift-$RUN.log"; } > "$E/checks/swift.txt"
cp "$V/checks/start-check-owners.json" "$E/checks/"
for f in make-trees.sh formal.sh chain.sh names-both.sh names.mjs red-green.sh analyze.sh noise.sh analyze-noise.py choices-origin.sh collect.sh; do
  cp "$T/scripts/$f" "$E/scripts/"; done
echo "collected: $(du -sh "$E" | cut -f1)"
