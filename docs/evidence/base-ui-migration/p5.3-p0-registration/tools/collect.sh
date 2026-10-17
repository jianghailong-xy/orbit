#!/usr/bin/env bash
# Usage: collect.sh   (from docs/evidence/base-ui-migration/p5.3-p0-registration/tools/)
# Copies what README.md cites from the scratch runs (/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl) into this directory, under
# the project's evidence-volume rule (p4.1-accepted/tools/collect.sh for P5.3): run logs, Playwright reports with the
# attachment bodies removed (p0-drift-3/tools/report-summary.py) and their per-test summaries
# (p0-drift-2/tools/summarize-report.py), expectation sources, environment checks, screenshot hashes, comparisons and
# the cited images only (diff images and crops; the expected and actual images of the failures are byte-identical to
# files already in the repository or in the runs, so their hashes are listed instead). The raw runs stay in
# /mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl until the evidence is judged.
set -euo pipefail
S=${P53REG:-/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl}; R=$S/runs
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
for c in menu chip; do
  keep_run "$R/nc-$c" "$E/negative-control/$c"
  cp "$S/trees/nc-$c.patch.diff" "$E/negative-control/$c/patch.diff"
done

# Same-commit originals: meta, logs, report summary, environment check, every screenshot's SHA-256 and the built
# bundle's file hashes. The registered screenshots of each run are in p0-drift/accepted/.
for run in before-8f94ddda9 after-b72da6eda; do
  o=$E/originals/$run; mkdir -p "$o"
  cp "$R/$run/meta.json" "$R/$run/output.txt" "$R/$run/build.txt" "$R/$run/snapshots.sha256" "$R/$run/dist.sha256" "$o/"
  $STRIP "$R/$run/output/report.json" "$o/report.summary.json" > /dev/null
  envcheck "$R/$run/environment.json" "$o/environment-check.txt"
done
cp "$R/expected-pre/sources.json" "$E/originals/expected-pre.sources.json"
cp "$S/p53-raw/p0-ref-shots.sha256" "$E/originals/p53-f1-p0-ref-shots.sha256"
cp "$S/p53-raw/p0-del-shots.sha256" "$E/originals/p53-f1-p0-del-shots.sha256"

# Comparisons, regions and crops, the decision record and the registration check.
cp "$S/compare/"*.json "$E/compare/"
cp -r "$S/regions/." "$E/regions/"
cp "$S/decision/p5.3-decision.json" "$E/decision/p5.3-decision.json"
cp "$S/registration-check.json" "$E/checks/registration-check.json"
python3 -I "$S/tools/counts-check.py" "$(cd "$EV/../../.." && pwd)" "$R/final-round-1" "$R/final-round-2" > "$E/checks/counts.txt"
cp "$S/audit-check-owners.json" "$E/checks/audit-check-owners.json"

# The merge check: the full log stays in the scratch directory; the filtered output (p3.2-accepted/tools/filter-merge-check.py:
# the whole build, every Vitest file line and the summary, without the console warnings tests print) and the log's size and
# hash come here.
python3 -I "$EV/p3.2-accepted/tools/filter-merge-check.py" "$S/merge-check.log" > "$E/checks/merge-check.txt"
python3 -I - "$S/merge-check.log" "$S/merge-check.meta" "$E/checks/merge-check.json" <<'PY'
import hashlib, json, re, sys
log, meta, out = sys.argv[1:]
text = open(log, encoding='utf-8', errors='replace').read()
clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
m = dict(l.split('=', 1) for l in open(meta).read().split('\n') if '=' in l)
summary = [l.strip() for l in clean.split('\n') if re.match(r'^\s*(Test Files|Tests|Errors|Duration)\b', l)]
json.dump({**m, 'logLines': text.count('\n'), 'logSha256': hashlib.sha256(open(log, 'rb').read()).hexdigest(),
           'vitestSummary': summary, 'builtLine': next((l.strip() for l in clean.split('\n') if 'built in' in l), None)},
          open(out, 'w'), indent=1)
PY
du -sh "$E"
