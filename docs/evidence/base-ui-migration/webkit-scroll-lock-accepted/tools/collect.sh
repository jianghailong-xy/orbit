#!/usr/bin/env bash
# Usage: collect.sh   (from docs/evidence/base-ui-migration/webkit-scroll-lock-accepted/tools/)
# Copies what README.md cites from the scratch runs (/mnt/data/tmp/34cfhmpygHQdZxRznyVH9) into this directory, under
# the project's evidence-volume rule: run logs, Playwright reports with attachment bodies removed
# (p0-drift-3/tools/report-summary.py) and their per-test summaries (p0-drift-2/tools/summarize-report.py),
# expectation sources, environment checks, screenshot hashes, comparisons and the cited images only (the diff images of
# the failures and the negative-control crops; the expected and actual images of the failures are byte-identical to
# files already in the repository, so their hashes are listed instead). p4.1-accepted/tools/collect.sh adapted.
# The raw runs stay in /mnt/data/tmp/34cfhmpygHQdZxRznyVH9 until they are deleted before the evidence is submitted.
set -euo pipefail
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; R=$S/runs
E=$(cd "$(dirname "$0")/.." && pwd)
EV=$(cd "$E/.." && pwd)
SUMMARY="python3 -I $EV/p0-drift-2/tools/summarize-report.py"
STRIP="python3 -I $EV/p0-drift-3/tools/report-summary.py"
P02=$EV/p0.2/environment.json
rm -rf "$E/checks/tip-start" "$E/checks/final-round-1" "$E/checks/final-round-2" "$E/originals" "$E/compare" "$E/regions" "$E/negative-control"
mkdir -p "$E/checks" "$E/originals" "$E/compare" "$E/regions" "$E/negative-control"

envcheck() { # <environment.json> <out>
  if cmp -s "$1" "$P02"; then r=identical; else r=DIFFERENT; fi
  echo "environment.json $(sha256sum < "$1" | cut -c1-64): $r to p0.2/environment.json" > "$2"
}
# A P0 regression run of netns-regression.sh: log, exit code, expectation sources, summaries, environment check,
# and for each failure the hashes of its expected/actual/diff images, keeping only the diff image.
keep_run() { # <run dir> <out dir>
  local run=$1 out=$2
  mkdir -p "$out"
  sed 's/\x1b\[[0-9;]*m//g' "$run/command-output.txt" > "$out/command-output.txt"
  cp "$run/exit.txt" "$run/sources.json" "$out/"
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
for c in pill error-card; do
  keep_run "$R/nc-$c" "$E/negative-control/$c"
  cp "$S/logs/nc-$c.patch.diff" "$E/negative-control/$c/patch.diff"
done
# The unchanged P0 command on the dry-run merge of the registration with the latest origin/main (main-dryrun.sh run).
rm -rf "$E/checks/main-merge"
keep_run "$R/main-merge" "$E/checks/main-merge"
cp "$S/checks/main-dryrun.txt" "$S/checks/statuses-tip-start.json" "$S/checks/statuses-final.json" "$E/checks/"
# audit-antd.mjs --check-owners on the registration commit and on the dry-run merge with origin/main.
cp "$S/checks/check-owners-821e2d501.json" "$S/checks/check-owners-main-merge.json" "$E/checks/"

# Same-commit originals: meta, logs, report summary, environment check, every screenshot's SHA-256 and the
# built bundle's file hashes. The nine registered screenshots of each run are in p0-drift/accepted/.
for run in before-15b7b5609 after-b2568f28d; do
  o=$E/originals/$run; mkdir -p "$o"
  cp "$R/$run/meta.json" "$R/$run/snapshots.sha256" "$R/$run/dist.sha256" "$o/"
  sed 's/\x1b\[[0-9;]*m//g' "$R/$run/output.txt" > "$o/output.txt"
  sed 's/\x1b\[[0-9;]*m//g' "$R/$run/build.txt" > "$o/build.txt"
  $STRIP "$R/$run/output/report.json" "$o/report.summary.json" > /dev/null
  envcheck "$R/$run/environment.json" "$o/environment-check.txt"
done
cp "$R/expected-pre/sources.json" "$E/originals/expected-pre.sources.json"

# Comparisons, regions and crops, and the registration check.
cp "$S/compare/exp-vs-before.json" "$S/compare/exp-vs-after.json" "$S/compare/before-vs-after.json" "$E/compare/"
cp -r "$S/regions/." "$E/regions/"
cp "$S/checks/registration-check.json" "$E/checks/registration-check.json"
# The merge check (filtered output and the record of the full one) and the scope check of the registration commit.
cp "$S/checks/merge-check.txt" "$S/checks/merge-check.json" "$S/checks/scope-check.txt" "$S/checks/tip-start-vs-originals.txt" "$E/checks/"
du -sh "$E"; du -sb "$E"
