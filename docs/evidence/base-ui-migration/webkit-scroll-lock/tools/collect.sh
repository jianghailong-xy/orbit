#!/usr/bin/env bash
# Copy what README.md cites from the raw runs in /mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj into
# docs/evidence/base-ui-migration/webkit-scroll-lock (run from the session worktree). Logs lose their terminal
# colour codes; Playwright reports lose their attachment bodies (p0-drift-3/tools/report-summary.py); the app-frame
# runs keep their measurements as scroll-records.json (tools/scroll-records.py). Raw runs stay on /mnt/data until the
# evidence is judged.
set -eu
D=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
E=docs/evidence/base-ui-migration/webkit-scroll-lock
SUM="python3 -I docs/evidence/base-ui-migration/p0-drift-3/tools/report-summary.py"
REF=15b7b5609 TEST=78cae80d9 FIX=d49a8749b
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
mkdir -p "$E/runs" "$E/compare" "$E/process/round1" "$E/process/round2" "$E/tools" "$E/probes" "$E/shots"
# The app-frame test before and after the fix.
for side in before:f2-app-frame-before-$TEST after:f2-app-frame-after-$FIX; do
  n=${side%%:*} r=$D/runs/${side#*:}
  log "$r/command-output.txt" "$E/runs/app-frame-$n.txt"; { cat "$r/head.txt"; cat "$r/exit.txt"; } >> "$E/runs/app-frame-$n.txt"
  $SUM "$r/results/report.json" "$E/runs/app-frame-$n.report.summary.json" > /dev/null
  python3 -I "$D/bin/scroll-records.py" "$r/results/report.json" "$E/runs/app-frame-$n.scroll-records.json" > /dev/null
done
# Entries with their own results directory: the final runs and the toasts A/B rounds.
for side in toasts-reference:f2-toasts-$REF toasts:f2-toasts-$FIX overlays:f2-overlays-$FIX choices:f2-choices-$FIX \
    toasts-ab1-reference:ab-toasts-$REF toasts-ab1:ab-toasts-$FIX toasts-ab2-reference:ab2-toasts-pixels-$REF toasts-ab2:ab2-toasts-pixels-$FIX \
    toasts-ab3-reference:ab3-toasts-exit-$REF toasts-ab3:ab3-toasts-exit-$FIX toasts-ab4-reference:ab4-toasts-exit-$REF toasts-ab4:ab4-toasts-exit-$FIX; do
  n=${side%%:*} r=$D/runs/${side#*:}
  log "$r/command-output.txt" "$E/runs/$n.txt"; { cat "$r/head.txt"; cat "$r/exit.txt"; } >> "$E/runs/$n.txt"
  $SUM "$r/results/report.json" "$E/runs/$n.report.summary.json" > /dev/null
done
# P0 standard on both trees, P0 originals and the same-commit entries (logs; their screenshots are compared in compare/),
# the screen-reader copy diagnostic on both trees.
for side in reference:$REF fix:$FIX; do
  n=${side%%:*} c=${side#*:}
  s=$([ $n = fix ] && echo "" || echo "-reference")
  log "$D/p0/f2-standard-$c/command-output.txt" "$E/runs/p0-standard$s.txt"; cat "$D/p0/f2-standard-$c/summary.txt" >> "$E/runs/p0-standard$s.txt"
  $SUM "$D/p0/f2-standard-$c/report.json" "$E/runs/p0-standard$s.report.summary.json" > /dev/null
  cp "$D/p0/f2-standard-$c/sources.json" "$E/runs/p0-standard$s.expected-sources.json"
  o=$([ $n = fix ] && echo "f2-after-$c" || echo "f2-before-$c")
  log "$D/p0/$o/output.txt" "$E/runs/p0-originals$s.txt"; cat "$D/p0/$o/summary.txt" >> "$E/runs/p0-originals$s.txt"
  for e in p42 p41 pilot; do
    x=$([ $n = fix ] && echo "f2-$e-after-$c" || echo "f2-$e-before-$c")
    log "$D/entries/$x/output.txt" "$E/runs/$e$s.txt"; cat "$D/entries/$x/summary.txt" >> "$E/runs/$e$s.txt"
  done
  log "$D/probes/f2-announce-$c.txt" "$E/runs/announce$s.txt"
  $SUM "$D/probes/out-f2-announce-$c/report.json" "$E/runs/announce$s.report.summary.json" > /dev/null
done
# Second head runs (the P4.2 pool dialogs, the pilot share dialog) and the merge check, ownership check, main dry run.
log "$D/entries/f2-p42-pools-again-$FIX/output.txt" "$E/runs/p42-pools-again.txt"; cat "$D/entries/f2-p42-pools-again-$FIX/summary.txt" >> "$E/runs/p42-pools-again.txt"
log "$D/entries/f2-pilot-share-again-$FIX/output.txt" "$E/runs/pilot-share-again.txt"; cat "$D/entries/f2-pilot-share-again-$FIX/summary.txt" >> "$E/runs/pilot-share-again.txt"
log "$D/merge/merge-check-$FIX.txt" "$E/runs/merge-check.txt"
cp "$D/check-owners-$FIX.json" "$E/runs/check-owners.json"
cp "$D/main-dryrun.txt" "$E/runs/main-dryrun.txt"
for f in "$D"/compare/*.json; do cp "$f" "$E/compare/"; done
# Cited screenshots.
cp -r "$D/evidence-shots-final/p0" "$D/evidence-shots-final/p42" "$E/shots/"
# Probes: scripts and their outputs (the first, flawed range probe is left out).
for f in "$D"/probes/*.browser.mjs "$D"/probes/*.config.mjs "$D"/probes/dump-*.js "$D"/probes/run-p42-probes.sh; do cp "$f" "$E/probes/"; done
for f in reset-wld layouts steps-wld reduce reduce2 variants anchor structure pcontent corner range2-wld content container recard direct filled; do cp "$D/probes/$f.jsonl" "$E/probes/"; done
cp "$D/probes/p42-probes.jsonl" "$D/probes/exit-position.summary.json" "$E/probes/"
log "$D/probes/exit-position.txt" "$E/probes/exit-position.txt"
# Tools.
for f in run-entry.sh p0-originals.sh p0-standard.sh entry-shots.sh run-probe.sh run-dev-probe.sh step.sh queue2-mine.sh queue2-base.sh queue3-mine.sh queue3-base.sh \
    compare.cjs scroll-records.py show-scroll.py p0-shots.py classify.py exit-samples.py exit-transfer.py main-dryrun.sh collect.sh; do cp "$D/bin/$f" "$E/tools/"; done
# Process records: round 1 (870e33a1f, dd22fa1a4/42efe9cc5) and round 2 (origin/main e6238f318, a4c06a8b6/f5b731070).
log "$D/runs/try1-before-fix/command-output.txt" "$E/process/round1/app-frame-fixed-spacers.txt"
log "$D/runs/app-frame-before-dd22fa1a4/command-output.txt" "$E/process/round1/app-frame-before.txt"
log "$D/runs/app-frame-after-42efe9cc5/command-output.txt" "$E/process/round1/app-frame-after.txt"
cp "$D/p0/before-870e33a1f/summary.txt" "$E/process/round1/p0-originals-before.summary.txt"
cp "$D/p0/after-42efe9cc5/summary.txt" "$E/process/round1/p0-originals-after.summary.txt"
log "$D/p0/standard-42efe9cc5/command-output.txt" "$E/process/round1/p0-standard.txt"
for f in "$D"/compare-round1/*.json; do cp "$f" "$E/process/round1/"; done
log "$D/runs/final-app-frame-before-a4c06a8b6/command-output.txt" "$E/process/round2/app-frame-before.txt"
log "$D/runs/final-app-frame-after-f5b731070/command-output.txt" "$E/process/round2/app-frame-after.txt"
log "$D/merge-check-f5b731070.txt" "$E/process/round2/merge-check-main-break.txt"
du -sh "$E"
