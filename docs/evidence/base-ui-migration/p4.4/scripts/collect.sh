#!/usr/bin/env bash
# collect.sh RUN: copy what README.md cites from the runs on /mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1 into p4.4/
# (P4.3a's collect.sh, for P4.4):
#  - the formal round RUN (formal.sh): every step's log (terminal colour codes removed; argv, tree, HEAD, uncommitted
#    paths, load, disk and exit code at the top and bottom of each), the Playwright reports whose results are read here
#    with attachment bodies removed (p0-drift-3/tools/report-summary.py), the standard P0 runs' expectations, the
#    comparisons (analyze.sh) and the beyond-level shots' classes (classify.py), the P4.4 traces of both trees;
#  - the cited screenshots: the beyond-level P4.4 pairs in full, but those of edge rasterization and loading-dot frames,
#    which go on one cropped sheet (p4.3a/scripts/pairs.py); the P0 matrix's beyond pairs in full; the standard P0
#    runs' failing shots (expected, actual, diff);
#  - the audits, owner check, record checks, closure and route closure (checks/, from audit.sh), the cascade-tie check,
#    the OrbitKit swift runs, the new unit test's red run;
#  - the last development round's comparison summaries (process/), and the scripts as run.
# Raw runs stay on /mnt/data until judged.
set -eu
RUN=${1:?run name}
V=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
E=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987/docs/evidence/base-ui-migration/p4.4
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare traces shots process scripts; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done
mkdir -p "$E/checks"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }

R=$V/$RUN
C=$V/compare-$RUN
for f in "$R"/*.txt; do log "$f" "$E/runs/$(basename "$f")"; done
for n in p44-ref p44-del p0-strict; do $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
  cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
for n in overlays controls; do $SUMMARY "$R/$n-report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for f in "$R"/choices-*-report.json; do n=$(basename "$f" -report.json); $SUMMARY "$f" "$E/runs/$n.report.summary.json" > /dev/null; done
python3 -I "$T/scripts/classify.py" "$C" > /dev/null
cp "$C"/*-summary.json "$C"/*-beyond-clusters.txt "$C"/p44-trace-semantics.json "$C"/p44-compare.json "$C"/p0-compare.json \
   "$C"/p44-beyond-classes.json "$E/compare/"
python3 -I "$E/../p4.1/extract-traces.py" "$R/p44-ref-out/report.json" "$E/traces/p44-ref.json"
python3 -I "$E/../p4.1/extract-traces.py" "$R/p44-del-out/report.json" "$E/traces/p44-del.json"

# Screenshots: the beyond-level P4.4 pairs in full, but edge rasterization and loading-dot frames on one cropped sheet;
# the P0 matrix's beyond pairs in full.
python3 -I - "$V" "$RUN" "$E/shots" <<'PY'
import json, os, shutil, subprocess, sys
v, run, out = sys.argv[1:4]
classes = json.load(open(f'{v}/compare-{run}/p44-beyond-classes.json'))
sheet = []
for summary, name, before, after in (('p44', 'p44-beyond', 'p44-ref', 'p44-del'), ('p0', 'p0-beyond', 'p0-ref', 'p0-del')):
    for item in json.load(open(f'{v}/compare-{run}/{summary}-summary.json'))['beyond']:
        if summary == 'p44' and classes[item['shot']]['class'] in ('edge rasterization', 'loading dots frame'):
            sheet.append(item['shot'])
            continue
        env, shot = item['shot'].split('/')
        os.makedirs(f'{out}/{name}/{env}', exist_ok=True)
        shutil.copy(f'{v}/{run}/{before}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.reference.png')
        shutil.copy(f'{v}/{run}/{after}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.delivery.png')
if sheet:
    pairs = '/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987/docs/evidence/base-ui-migration/p4.3a/scripts/pairs.py'
    subprocess.run(['python3', '-I', pairs, f'{v}/{run}/p44-ref-shots', f'{v}/{run}/p44-del-shots', f'{out}/p44-edges.png', *sorted(sheet)],
                   check=True, stdout=subprocess.DEVNULL)
PY
# The standard P0's failing shots, the delivery's only and of two environments (Chromium light desktop and phone): they
# are main's drift, and the base's actual shots are the same bytes but one (below). The rest stay on /mnt/data.
for dir in "$R/p0-standard-out"/*-chromium-light-desktop/ "$R/p0-standard-out"/*-chromium-light-phone/; do
  ls "$dir"*-diff.png > /dev/null 2>&1 || continue
  mkdir -p "$E/shots/p0-standard/$(basename "$dir")"
  cp "$dir"*-expected.png "$dir"*-actual.png "$dir"*-diff.png "$E/shots/p0-standard/$(basename "$dir")/"
done
# Base drift: the standard P0's failures on the base and on the delivery, the diff of the two lists, and the actual
# shots of the failing cases compared byte for byte (and by pixels where they differ).
{ python3 -I "$T/scripts/failures.py" "$R/p0-standard-base-out/report.json" "$R/p0-standard-out/report.json"
  echo; echo "== diff of the two lists (base < > delivery)"
  diff <(python3 -I "$T/scripts/failures.py" "$R/p0-standard-base-out/report.json" | sed 1d) \
       <(python3 -I "$T/scripts/failures.py" "$R/p0-standard-out/report.json" | sed 1d) && echo "no difference"
  echo; echo "== the P0 matrix's failures (reference, strict, delivery)"
  python3 -I "$T/scripts/failures.py" "$R/p0-ref-out/report.json" "$R/p0-strict-out/report.json" "$R/p0-del-out/report.json" | grep -E '^(==|   )'
  echo; echo "== actual shots of the standard P0's failing cases, base vs delivery"
  python3 -I - "$R" <<'PY'
import glob, hashlib, os, sys
import numpy as np
from PIL import Image
R = sys.argv[1]
def actuals(root):
    return {os.path.relpath(p, root): p for p in glob.glob(f'{root}/*/*-actual.png')}
a, b = actuals(f'{R}/p0-standard-base-out'), actuals(f'{R}/p0-standard-out')
same = 0
for key in sorted(set(a) | set(b)):
    if key not in a or key not in b:
        print(f'only in {"delivery" if key in b else "base"}: {key}'); continue
    if hashlib.sha256(open(a[key], 'rb').read()).digest() == hashlib.sha256(open(b[key], 'rb').read()).digest():
        same += 1; continue
    d = np.abs(np.asarray(Image.open(a[key]).convert('RGB')).astype(int) - np.asarray(Image.open(b[key]).convert('RGB')).astype(int)).max(axis=2)
    print(f'differs: {key}: {int((d > 0).sum())} pixels, max {int(d.max())} levels, {int((d > 2).sum())} over 2')
print(f'{same} of {len(set(a) & set(b))} byte-identical')
PY
} > "$E/checks/p0-standard-failures.txt" 2>&1

# The P4.4 cases rerun on both trees (p44-rerun.sh): each environment's pair compared as the main pair is.
for ref in "$R"/p44-rerun-ref-*-out; do
  [ -d "$ref" ] || continue
  env=${ref#$R/p44-rerun-ref-}; env=${env%-out}
  python3 -I "$E/../p3.2/compare_runs.py" "$R/p44-rerun-ref-$env-shots" "$R/p44-rerun-del-$env-shots" "$ref/report.json" \
    "$R/p44-rerun-del-$env-out/report.json" "$E/compare/p44-rerun-$env-compare.json" > /dev/null
  python3 -I "$E/../p4.1/summarize.py" "$E/compare/p44-rerun-$env-compare.json" > "$E/compare/p44-rerun-$env-summary.json"
  python3 -I "$E/trace-semantics.py" "$ref/report.json" "$R/p44-rerun-del-$env-out/report.json" > "$E/compare/p44-rerun-$env-trace-semantics.json" || true
  for tree in ref del; do $SUMMARY "$R/p44-rerun-$tree-$env-out/report.json" "$E/runs/p44-rerun-$tree-$env.report.summary.json" > /dev/null; done
done

# Audits and records, the cascade-tie check, swift, the new unit test's red run.
cp "$V/checks"/* "$E/checks/"
cp "$V/inventory-closure.json" "$E/inventory-closure.json"
cp "$V/route-closure.json" "$E/route-closure.json"
cp "$T/ties-final.txt" "$E/checks/ties.txt"
for f in "$V"/swift/*.txt; do case "$(basename "$f")" in c0b614ba4-*|f61a0c864*) ;; *) log "$f" "$E/checks/swift-$(basename "$f")";; esac; done
cp "$T/redgreen/floating-red.txt" "$E/checks/floating-test-red.txt"

# The last development round (chromium and WebKit, light, desktop and phone): what was left before the formal round.
for p in chromium-light-desktop chromium-light-phone webkit-light-desktop webkit-light-phone; do
  [ -d "$V/dev/compare-$p" ] || continue
  mkdir -p "$E/process/dev-$p"
  cp "$V/dev/compare-$p/summary.json" "$V/dev/compare-$p/beyond-clusters.txt" "$V/dev/compare-$p/trace-semantics.json" "$E/process/dev-$p/"
done

# After the final round main moved (P0 drift batch 7 among it): the temporary merge of the delivery with origin/main
# (merge-tree-check.sh, never pushed), its standard P0 and the P4.4 suite.
M=$V/$RUN-merged
if [ -d "$M" ]; then
  for f in "$M"/*.txt; do log "$f" "$E/runs/merged-$(basename "$f")"; done
  $SUMMARY "$M/p0-standard-merged-out/report.json" "$E/runs/merged-p0-standard.report.summary.json" > /dev/null
  cp "$M/p0-standard-merged-out/expected-screenshots/sources.json" "$E/runs/merged-p0-standard.expected-sources.json"
  $SUMMARY "$M/p44-merged-out/report.json" "$E/runs/merged-p44.report.summary.json" > /dev/null
fi

# Scripts as run.
cp "$T/scripts/make-trees.sh" "$T/scripts/formal.sh" "$T/scripts/analyze.sh" "$T/scripts/audit.sh" "$T/scripts/collect.sh" \
   "$T/scripts/classify.py" "$T/scripts/swift-check.sh" "$T/scripts/regen-record.sh" "$T/scripts/dev-run.sh" "$T/scripts/dev-all.sh" \
   "$T/scripts/dev-compare.sh" "$T/scripts/probe-run.sh" "$T/scripts/failures.py" "$T/scripts/p44-rerun.sh" \
   "$T/scripts/final-checks.sh" "$T/scripts/sync-del.sh" "$T/scripts/crop.py" "$T/scripts/merge-tree-check.sh" \
   "$T/scripts/supplement.sh" "$E/scripts/"
du -sb "$E"; du -sh "$E"
