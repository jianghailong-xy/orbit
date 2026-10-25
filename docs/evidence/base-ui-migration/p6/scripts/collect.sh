#!/usr/bin/env bash
# collect.sh [ROUND]: copy what p6/README.md cites from the runs on /mnt/data/tmp/34Za39RS6A28G7xPqMD0p into p6/
# (P5.3's collect.sh, for P6):
#  - runs/: every step log of the formal round and its follow-ups, terminal colour codes removed (the P0 matrix pair and
#    its reruns, the standard P0 on delivery and base, the delivered fixture specs on base and twice on the delivery, the
#    batch tools' census, the merge check; OrbitKit as its test totals), and every Playwright report read here with its
#    attachment bodies removed (p0-drift-3/tools/report-summary.py); the standard P0 runs' expectations;
#  - runs/flake, runs/repeat-shots: the repeat checks (the delivery's reds; the screenshots caught mid-transition);
#    runs/ro-loop: the ResizeObserver case on four fixtures (ro-loop-variants.sh) and its step probe (ro-loop-pair.sh);
#    runs/start-original, runs/base-original: the original fixture specs on the start tree and on the base;
#  - checks/fixtures-compare: compare-fixtures.py and classify-fixture-diffs.py outputs; checks/preexisting-reds-*;
#    checks/geometry: fixture-geometry.mjs's records of both trees.
# Files over 1 MB are gzipped whole (read them with zcat).
# Raw runs stay on /mnt/data until judged.
set -eu
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=${1:-f1}
E=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e/docs/evidence/base-ui-migration/p6
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
rm -rf "${E:?}/runs" "${E:?}/checks/geometry"
mkdir -p "$E/runs/flake" "$E/runs/repeat-shots" "$E/runs/ro-loop" "$E/runs/start-original" "$E/runs/base-original" "$E/checks/fixtures-compare" "$E/checks/geometry"
for f in "$V/$R"/*.txt; do
  if [ "$(basename "$f")" = orbitkit-full.txt ]; then
    grep -E "Executed [0-9]+ tests|Test Suite 'All tests'|error:|Test Case .* failed" "$f" | tail -4 > "$E/runs/orbitkit-totals.txt"
  else
    log "$f" "$E/runs/$(basename "$f")"
  fi
done
for d in "$V/$R"/*-out; do n=$(basename "$d" -out); [ -f "$d/report.json" ] && $SUMMARY "$d/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do cp "$V/$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"; done
for d in flake repeat-shots; do
  for f in "$V/$R/$d"/*.txt; do log "$f" "$E/runs/$d/$(basename "$f")"; done
  for f in "$V/$R/$d"/*.report.json; do $SUMMARY "$f" "$E/runs/$d/$(basename "$f" .report.json).report.summary.json" > /dev/null; done
done
for f in "$T"/ro-loop-variants/*.txt; do log "$f" "$E/runs/ro-loop/variants-$(basename "$f")"; done
for f in "$T"/ro-loop-variants/*.report.json; do $SUMMARY "$f" "$E/runs/ro-loop/variants-$(basename "$f" .report.json).report.summary.json" > /dev/null; done
cp "$T"/ro-loop-2/*.json "$E/runs/ro-loop/"
cp "$T"/geometry-2/*.json "$E/checks/geometry/"
for run in start-original base-original; do
  for f in "$T/runs/$run"/*.txt; do log "$f" "$E/runs/$run/$(basename "$f")"; done
  for d in "$T/runs/$run"/*-out; do n=$(basename "$d" -out); [ -f "$d/report.json" ] && $SUMMARY "$d/report.json" "$E/runs/$run/$n.report.summary.json" > /dev/null; done
done
cp "$T"/scratch/fixtures-compare/*.json "$E/checks/fixtures-compare/"
for c in choices composer; do cp "$T/scratch/preexisting-$c.json" "$E/checks/preexisting-reds-$c.json"; done
# The project's evidence-volume rule (30 MB): files over 1 MB are kept whole, gzipped (gzip -n: no name or time inside).
find "$E/runs" "$E/checks" -type f -size +1M -exec gzip -9 -n {} +
du -sh "$E" "$E/runs" "$E/checks"
