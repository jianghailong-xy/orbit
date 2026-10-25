#!/usr/bin/env bash
# collect.sh: copy what README.md cites from the runs on /mnt/data/tmp/34coPBqt8gi229cVNds0E into this directory:
#  - scripts/: every script and probe the runs used (the trees, runs and analyses), and the standalone pages (exp/);
#  - repro/: the reproduction on the project tip 25fc0c840 and on the project line before P4.3a (bb007810b): P4.3a's
#    keys geometry probe 4 rounds per tree, the observation probe, the transitions probe on the tip and on the fix
#    (its first build, on the tip), the phone geometry; logs with terminal colour codes removed, and the tables;
#  - exp/: the standalone pages' outputs (WebKit and Chromium);
#  - runs/: the final checks on the rebased trees (final.sh, base 9c86b3dfe, delivery 423aa3fdb): every step's log,
#    the Playwright reports with attachment bodies removed (p0-drift-3/tools/report-summary.py), the resident spec's
#    and the probe's tables, the merge check and the OrbitKit run;
#  - compare/: P4.3a's cases, base against delivery (P4.3a's comparison tools), and shots/: the pairs that differ.
# Raw runs stay on /mnt/data until judged.
set -eu
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
# The evidence directory, named outright: an earlier version took it from this script's own location and, run from the
# copy under $T/scripts, emptied $T's own runs/, exp/, compare/ and shots/ (2026-10-10 00:52Z; the runs were redone).
E=/root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48/docs/evidence/base-ui-migration/tasks-toolbar-height
case $E in */docs/evidence/base-ui-migration/tasks-toolbar-height) ;; *) echo "refusing: $E is not the evidence directory"; exit 2;; esac
[ -f "$E/README.md" ] || { echo "refusing: no README.md in $E"; exit 2; }
B=$(cd "$E/.." && pwd)
SUMMARY="python3 -I $B/p0-drift-3/tools/report-summary.py"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for d in repro exp runs runs-failed runs3 compare compare3 shots; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done

# Scripts (this one included) and probes.
mkdir -p "$E/scripts/probe" "$E/scripts/exp"
cp "$T"/scripts/*.sh "$T"/scripts/*.py "$E/scripts/"
cp "$T"/probe/p43a-toolbar-probe.browser.mjs "$T"/probe/p43a-toolbar-flows-probe.browser.mjs "$E/scripts/probe/"
cmp "$T/probe/p43a-keys-geom-probe.browser.mjs" "$B/p4.3a/scripts/probe/p43a-keys-geom-probe.browser.mjs"
cp "$T"/exp/min2.mjs "$T"/exp/scrollbar-room.mjs "$E/scripts/exp/"

# Reproduction.
for d in geom-tip-r1 geom-tip-r2 geom-tip-r3 geom-tip-r4 geom-pre-r1 geom-pre-r2 geom-pre-r3 geom-pre-r4 geom-tip-phone geom-fix-phone \
         probe-tip-1 probe-pre-1 probe-fix-1 flows-tip-1 flows-fix-1 flows-pre-1; do
  log "$T/runs/$d/run.txt" "$E/repro/$d.txt"
done
python3 -I "$T/scripts/geom-table.py" --json "$E/repro/geom-tip-pre.json" "$T"/runs/geom-{tip,pre}-r{1,2,3,4}/run.txt > "$E/repro/geom-tip-pre.txt"
python3 -I "$T/scripts/geom-table.py" "$T/runs/geom-tip-phone/run.txt" "$T/runs/geom-fix-phone/run.txt" > "$E/repro/geom-phone.txt"
python3 -I "$T/scripts/probe-table.py" "$T/runs/probe-tip-1/run.txt" "$T/runs/probe-pre-1/run.txt" "$T/runs/probe-fix-1/run.txt" > "$E/repro/probe-table.txt"
python3 -I "$T/scripts/probe-timeline.py" "$T/runs/probe-tip-1/run.txt" webkit-dark-desktop 0 1 > "$E/repro/probe-timeline-ok-and-34.txt"
python3 -I "$T/scripts/flows-table.py" "$T/runs/flows-tip-1/run.txt" "$T/runs/flows-pre-1/run.txt" "$T/runs/flows-fix-1/run.txt" > "$E/repro/flows-table.txt"

# Standalone pages.
cp "$T"/exp/min2-*.txt "$T"/exp/scrollbar-room.txt "$E/exp/"

# The rerun's steps that did not get to their tests (retry.sh set them aside): their logs.
for f in "$T"/runs-failed/*.txt; do log "$f" "$E/runs-failed/$(basename "$f")"; done
for d in "$T"/runs-failed/*/; do log "$d/run.txt" "$E/runs-failed/$(basename "$d").txt"; done

# Final checks.
R=$T/runs
for f in "$R"/resident-*-r*.txt "$R"/geom-*-final-r*.txt "$R"/p43a-base.txt "$R"/p43a-fix.txt "$R"/p0-standard.txt "$R"/p0-standard-base.txt \
         "$R"/audit-check-owners.txt "$R"/merge.txt "$R"/swift-tasklist.txt "$R"/unit-red-base.txt "$R"/unit-green-fix.txt \
         "$R"/merge-hdd-killed.txt; do
  [ -f "$f" ] && log "$f" "$E/runs/$(basename "$f")"
done
for n in base tip; do cp "$R/audit-check-owners-$n.json" "$E/runs/"; done
for d in "$R"/resident-*-r*-out; do $SUMMARY "$d/report.json" "$E/runs/$(basename "$d" -out).report.summary.json" > /dev/null; done
python3 -I "$T/scripts/resident-table.py" --json "$E/runs/resident-table.json" "$R"/resident-*-r*-out/report.json > "$E/runs/resident-table.txt"
python3 -I "$T/scripts/geom-table.py" --json "$E/runs/geom-final.json" "$R"/geom-*-final-r*.txt > "$E/runs/geom-final.txt"
for n in p43a-base p43a-fix p0-standard p0-standard-base; do
  [ -f "$R/$n-out/report.json" ] && $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
done
for n in p0-standard p0-standard-base; do
  [ -f "$R/$n-out/expected-screenshots/sources.json" ] && cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
[ -d "$T/compare" ] && cp "$T"/compare/* "$E/compare/" 2>/dev/null || true

# The checks after the second sync (recheck3.sh: base = project tip d580e572d, delivery 1243db2bb; runs3/, compare3/).
R3=$T/runs3
for f in "$R3"/*.txt; do log "$f" "$E/runs3/$(basename "$f")"; done
cp "$R3/audit-check-owners-base.json" "$E/runs3/"
for f in "$T"/runs3-failed/*.txt; do [ -f "$f" ] && log "$f" "$E/runs3/failed-$(basename "$f")"; done
for d in "$R3"/resident-*-r*-out "$R3"/p43a-base-out "$R3"/p43a-fix-out "$R3"/p0-standard-out "$R3"/p0-standard-base-out; do
  [ -f "$d/report.json" ] && $SUMMARY "$d/report.json" "$E/runs3/$(basename "$d" -out).report.summary.json" > /dev/null
done
for n in p0-standard p0-standard-base; do
  [ -f "$R3/$n-out/expected-screenshots/sources.json" ] && cp "$R3/$n-out/expected-screenshots/sources.json" "$E/runs3/$n.expected-sources.json"
done
python3 -I "$T/scripts/resident-table.py" --json "$E/runs3/resident-table.json" "$R3"/resident-*-r*-out/report.json > "$E/runs3/resident-table.txt"
python3 -I "$T/scripts/geom-table.py" --json "$E/runs3/geom-final.json" "$R3"/geom-*-final-r*.txt > "$E/runs3/geom-final.txt"
[ -d "$T/compare3" ] && cp "$T"/compare3/* "$E/compare3/"
[ -d "$T/shots" ] && cp -r "$T"/shots/. "$E/shots/" 2>/dev/null || true
du -sh "$E"
