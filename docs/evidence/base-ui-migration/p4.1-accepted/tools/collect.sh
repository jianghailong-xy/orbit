#!/usr/bin/env bash
# Usage: collect.sh   (from docs/evidence/base-ui-migration/p4.1-accepted/tools/)
# Copies what README.md cites from the scratch runs (/var/tmp/p41acc) into this directory, under the project's
# evidence-volume rule: run logs, Playwright reports with attachment bodies removed (p0-drift-3/tools/report-summary.py)
# and their per-test summaries (p0-drift-2/tools/summarize-report.py), expectation sources, environment checks,
# screenshot hashes, comparisons and the cited images only (diff images and crops; the expected and actual
# images of the failures are byte-identical to files already in the repository, so their hashes are listed
# instead). The raw runs stay in /var/tmp/p41acc until the evidence is judged.
set -euo pipefail
S=${P41ACC:-/var/tmp/p41acc}; R=$S/runs
E=$(cd "$(dirname "$0")/.." && pwd)
EV=$(cd "$E/.." && pwd)
SUMMARY="python3 -I $EV/p0-drift-2/tools/summarize-report.py"
STRIP="python3 -I $EV/p0-drift-3/tools/report-summary.py"
P02=$EV/p0.2/environment.json
rm -rf "$E/checks/tip-start" "$E/checks/final-round-1" "$E/checks/final-round-2" "$E/originals" "$E/compare" "$E/regions" "$E/negative-control" "$E/decision"
mkdir -p "$E/checks" "$E/originals" "$E/compare" "$E/regions" "$E/negative-control" "$E/decision"

envcheck() { # <environment.json> <out>
  if cmp -s "$1" "$P02"; then r=identical; else r=DIFFERENT; fi
  echo "environment.json $(sha256sum < "$1" | cut -c1-64): $r to p0.2/environment.json" > "$2"
}
# A P0 regression run of netns-regression.sh: log, exit code, expectation sources, summaries, environment check,
# and for each failure the hashes of its expected/actual/diff images, keeping only the diff image.
keep_run() { # <run dir> <out dir>
  local run=$1 out=$2
  mkdir -p "$out"
  cp "$run/command-output.txt" "$run/exit.txt" "$run/sources.json" "$out/"
  $SUMMARY "$run/report.json" "$run/sources.json" > "$out/summary.json"
  $STRIP "$run/report.json" "$out/report.summary.json" > /dev/null
  envcheck "$run/environment.json" "$out/environment-check.txt"
  if [ -d "$run/failures" ]; then
    (cd "$run/failures" && find . -name '*.png' | LC_ALL=C sort | xargs sha256sum) > "$out/failures.sha256"
    (cd "$run/failures" && find . -name '*-diff.png' -o -name 'error-context.md') | while read -r f; do
      mkdir -p "$out/failures/$(dirname "$f")"; cp "$run/failures/$f" "$out/failures/$f"
    done
  fi
}
keep_run "$R/tip-start" "$E/checks/tip-start"
keep_run "$R/final-round-1" "$E/checks/final-round-1"
keep_run "$R/final-round-2" "$E/checks/final-round-2"
for c in pill field-error; do
  keep_run "$R/nc-$c" "$E/negative-control/$c"
  cp "$S/trees/nc-$c.patch.diff" "$E/negative-control/$c/patch.diff"
done

# Same-commit originals: meta, logs, report summary, environment check, every screenshot's SHA-256 and the
# built bundle's file hashes. The two registered screenshots of each run are in p0-drift/accepted/.
for run in before-a84bc61e7 after-3aa26fb97; do
  o=$E/originals/$run; mkdir -p "$o"
  cp "$R/$run/meta.json" "$R/$run/output.txt" "$R/$run/build.txt" "$R/$run/snapshots.sha256" "$R/$run/dist.sha256" "$o/"
  $STRIP "$R/$run/output/report.json" "$o/report.summary.json" > /dev/null
  envcheck "$R/$run/environment.json" "$o/environment-check.txt"
done
cp "$R/expected-pre/sources.json" "$E/originals/expected-pre.sources.json"

# Comparisons, regions and crops, the decision record and the registration check.
cp "$S/compare/exp-vs-before.json" "$S/compare/exp-vs-after.json" "$S/compare/before-vs-after.json" "$E/compare/"
cp -r "$S/regions/." "$E/regions/"
cp "$S/p4.1-decision.json" "$E/decision/p4.1-decision.json"
cp "$S/registration-check.json" "$E/checks/registration-check.json"
du -sh "$E"
