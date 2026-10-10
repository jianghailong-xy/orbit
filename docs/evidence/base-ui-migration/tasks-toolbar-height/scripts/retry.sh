#!/usr/bin/env bash
# retry.sh: after rerun.sh, the steps that did not get to run their tests -- Playwright's webServer did not answer within
# its 30 s (a cold vite preview start on /mnt/data's spinning disk at host load 45-77), or the run was killed from
# outside (exit 143) -- are set aside under runs-failed/ and run again, up to three attempts. Steps that ran their
# tests, passing or failing, are kept as they are.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs
mkdir -p "$T/runs-failed"
infra() { grep -qE 'Timed out waiting [0-9]+ms from config.webServer|^exit=143' "$1"; }
for attempt in 1 2 3; do
  moved=0
  for f in "$R"/geom-*/run.txt "$R"/probe-*/run.txt "$R"/flows-*/run.txt; do
    [ -f "$f" ] && infra "$f" && { d=$(dirname "$f"); mv "$d" "$T/runs-failed/$(basename "$d").$(date -u +%H%M%S)"; moved=$((moved+1)); }
  done
  for f in "$R"/resident-*-r*.txt "$R"/geom-*-final-r*.txt "$R"/p43a-*.txt "$R"/p0-standard*.txt; do
    [ -f "$f" ] && infra "$f" && { mv "$f" "$T/runs-failed/$(basename "$f" .txt).$(date -u +%H%M%S).txt"; moved=$((moved+1)); }
  done
  missing=0
  for n in 1 2 3 4; do for tree in tip pre; do [ -f "$R/geom-$tree-r$n/run.txt" ] || missing=$((missing+1)); done; done
  for n in 1 2 3 4 5; do [ -f "$R/resident-fix-r$n.txt" ] || missing=$((missing+1)); done
  for n in 1 2; do [ -f "$R/resident-base-r$n.txt" ] && [ -f "$R/geom-base-final-r$n.txt" ] || missing=$((missing+1)); done
  for n in 1 2 3 4; do [ -f "$R/geom-fix-final-r$n.txt" ] || missing=$((missing+1)); done
  for n in p43a-base p43a-fix p0-standard p0-standard-base; do [ -f "$R/$n.txt" ] || missing=$((missing+1)); done
  echo "== attempt $attempt $(date -u +%T): set aside $moved, missing $missing"
  [ $missing -eq 0 ] && break
  "$T/scripts/stats.sh" 1 4
  "$T/scripts/final.sh" stats
  "$T/scripts/final.sh" p43a
  "$T/scripts/final.sh" p0
done
# P4.3a's comparison once both of its runs are there (again if the base run is newer than the comparison).
if [ -f "$R/p43a-base-out/report.json" ] && [ -f "$R/p43a-fix-out/report.json" ]; then
  [ "$T/compare/p43a-summary.json" -nt "$R/p43a-base-out/report.json" ] && [ "$T/compare/p43a-summary.json" -nt "$R/p43a-fix-out/report.json" ] || "$T/scripts/compare.sh"
fi
echo "== retry done $(date -u +%T)"
