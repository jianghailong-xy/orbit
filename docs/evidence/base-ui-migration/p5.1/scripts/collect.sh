#!/usr/bin/env bash
# collect.sh RUN: copy what README.md cites from the runs on /mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1 into p5.1/
# (P4.4's collect.sh, for P5.1):
#  - the formal round RUN (formal.sh): every step's log (terminal colour codes removed; argv, tree, HEAD, uncommitted
#    paths, load, disk and exit code at the top and bottom of each), the Playwright reports whose results are read here
#    with attachment bodies removed (p0-drift-3/tools/report-summary.py), the standard P0 runs' expectations, the
#    comparisons (analyze.sh) and the beyond-level shots' classes (classify.py), the P5.1 traces of both trees;
#  - the cited screenshots: per class of the beyond-level P5.1 pairs, one cropped sheet of every pair
#    (p4.3a/scripts/pairs.py) and one pair in full; an unclassified pair in full; the P0 matrix's beyond pairs in full;
#    the standard P0 runs' failing shots of two environments (expected, actual, diff);
#  - the audits, owner check, closure and route closure (checks/, from audit.sh), the cascade-tie check, the red run of
#    the two new shared behaviours, the merge menu's keyboard probe;
#  - the last development round's comparison (process/), and the scripts as run.
# The evidence directory is named outright (never derived from $0); only its run, compare, traces, shots and process
# directories are emptied first, so scripts/ and the files written by hand stay. Raw runs stay on /mnt/data until judged.
set -eu
RUN=${1:?run name}
PRE=${2:-}   # optional: an earlier formal round kept in process/PRE (its step logs and the small comparison files)
T=/mnt/data/tmp/34Za39L1H6V82d2sobzPY
V=$T/v1
E=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911/docs/evidence/base-ui-migration/p5.1
B=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911/docs/evidence/base-ui-migration
SUMMARY="python3 -I $B/p0-drift-3/tools/report-summary.py"
[ -f "$E/README.md" ] || { echo "no $E/README.md: wrong evidence directory"; exit 1; }
for d in runs compare traces shots process; do rm -rf "${E:?}/${d:?}"; mkdir -p "$E/$d"; done
mkdir -p "$E/checks" "$E/scripts"
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }

R=$V/$RUN
C=$V/compare-$RUN
for f in "$R"/*.txt; do log "$f" "$E/runs/$(basename "$f")"; done
for n in p51-ref p51-del p0-ref p0-strict p0-del; do $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for d in "$R"/p51-rerun-*-out; do [ -d "$d" ] || continue; n=$(basename "$d" -out); $SUMMARY "$d/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
  cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
for n in overlays controls; do $SUMMARY "$R/$n-report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for f in "$R"/choices-*-report.json; do n=$(basename "$f" -report.json); $SUMMARY "$f" "$E/runs/$n.report.summary.json" > /dev/null; done
python3 -I "$T/scripts/classify.py" "$C" > "$C/p51-classes.txt"
cp "$C"/*-summary.json "$C"/*-beyond-clusters.txt "$C"/p51-trace-semantics.json "$C"/p51-compare.json "$C"/p0-compare.json \
   "$C"/p51-beyond-classes.json "$C"/p51-classes.txt "$E/compare/"
for f in "$C"/p51-rerun-*-trace-semantics.json "$C"/p51-rerun-*-compare.json; do [ -f "$f" ] && cp "$f" "$E/compare/"; done
python3 -I "$B/p4.1/extract-traces.py" "$R/p51-ref-out/report.json" "$E/traces/p51-ref.json"
python3 -I "$B/p4.1/extract-traces.py" "$R/p51-del-out/report.json" "$E/traces/p51-del.json"
for d in "$R"/p51-rerun-*-out; do [ -d "$d" ] || continue; python3 -I "$B/p4.1/extract-traces.py" "$d/report.json" "$E/traces/$(basename "$d" -out).json"; done

# Screenshots: per class one cropped sheet of every pair and one pair in full (the first in the order below that the
# class has); an unclassified pair in full; the P0 matrix's beyond pairs in full.
python3 -I - "$V" "$RUN" "$E/shots" "$B/p4.3a/scripts/pairs.py" <<'PY'
import collections, json, os, shutil, subprocess, sys
v, run, out, pairs = sys.argv[1:5]
classes = json.load(open(f'{v}/compare-{run}/p51-beyond-classes.json'))
SHEETS = {'edge rasterization': 'p51-edges', 'Tooltip edge padding (accepted in P4.2)': 'p51-tips',
          'a popup above its trigger: vertical rounding': 'p51-above', 'a dialog shadow over the page: up to 4 levels': 'p51-shadow'}
FULL = ['chromium-light-desktop/p51-merge-conflict-tip.png', 'chromium-light-desktop/p51-usage.png', 'chromium-light-phone/p51-move-confirm.png',
        'chromium-light-desktop/p51-merge-menu-short.png', 'webkit-light-desktop/p51-account-menu.png']
def full(name, before, after, shot):
    env, png = shot.split('/')
    os.makedirs(f'{out}/{name}/{env}', exist_ok=True)
    shutil.copy(f'{v}/{run}/{before}-shots/{env}/{png}', f'{out}/{name}/{env}/{png[:-4]}.reference.png')
    shutil.copy(f'{v}/{run}/{after}-shots/{env}/{png}', f'{out}/{name}/{env}/{png[:-4]}.delivery.png')
by = collections.defaultdict(list)
for shot, row in classes.items():
    if shot.startswith('rerun '):
        continue  # a rerun pair's shots stay in its own run directory; its comparison is in compare/
    by[row['class']].append(shot)
for cls, shots in sorted(by.items()):
    if cls not in SHEETS:
        for shot in sorted(shots):
            full('p51-beyond', 'p51-ref', 'p51-del', shot)
        continue
    subprocess.run(['python3', '-I', pairs, f'{v}/{run}/p51-ref-shots', f'{v}/{run}/p51-del-shots', f'{out}/{SHEETS[cls]}.png', *sorted(shots)],
                   check=True, stdout=subprocess.DEVNULL)
    pick = next((s for s in FULL if s in shots), sorted(shots)[0])
    full('p51-beyond', 'p51-ref', 'p51-del', pick)
for item in json.load(open(f'{v}/compare-{run}/p0-summary.json'))['beyond']:
    full('p0-beyond', 'p0-ref', 'p0-del', item['shot'])
PY
# The standard P0's failing shots, the delivery's only and of two environments (Chromium light desktop and phone).
for dir in "$R/p0-standard-out"/*-chromium-light-desktop/ "$R/p0-standard-out"/*-chromium-light-phone/; do
  ls "$dir"*-diff.png > /dev/null 2>&1 || continue
  mkdir -p "$E/shots/p0-standard/$(basename "$dir")"
  cp "$dir"*-expected.png "$dir"*-actual.png "$dir"*-diff.png "$E/shots/p0-standard/$(basename "$dir")/"
done
# Base drift: the standard P0's failures on the base and on the delivery, the diff of the two lists, and the actual
# shots of the failing cases compared byte for byte (and by pixels where they differ).
F="$B/p5.1/scripts/failures.py"
{ python3 -I "$F" "$R/p0-standard-base-out/report.json" "$R/p0-standard-out/report.json"
  echo; echo "== diff of the two lists (base < > delivery)"
  diff <(python3 -I "$F" "$R/p0-standard-base-out/report.json" | sed 1d) \
       <(python3 -I "$F" "$R/p0-standard-out/report.json" | sed 1d) && echo "no difference"
  echo; echo "== the P0 matrix's failures (reference, strict, delivery)"
  python3 -I "$F" "$R/p0-ref-out/report.json" "$R/p0-strict-out/report.json" "$R/p0-del-out/report.json" | grep -E '^(==|   )'
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

# Audits, closure, route closure, the cascade-tie check, the red run, the keyboard probe.
cp "$V/checks"/* "$E/checks/"
cp "$V/inventory-closure.json" "$E/inventory-closure.json"
cp "$V/route-closure.json" "$E/route-closure.json"
cp "$T/ties-final.txt" "$E/checks/ties.txt"
log "$T/redgreen/shared-red.txt" "$E/checks/shared-red.txt"
mkdir -p "$E/checks/merge-keyboard-probe"
cp "$T/probe/p51-zz-probe.browser.mjs" "$E/checks/merge-keyboard-probe/probe.browser.mjs"
for f in "$T"/probe/merge-kbd-*.json; do cp "$f" "$E/checks/merge-keyboard-probe/"; done
mkdir -p "$E/checks/escape-probe"
cp "$T/probe/p51-zz-escape.browser.mjs" "$E/checks/escape-probe/probe.browser.mjs"
cp "$T/probe/esc2-summary.txt" "$E/checks/escape-probe/summary.txt"
for f in "$T"/probe/esc2/ref-*.json; do cp "$f" "$E/checks/escape-probe/"; done
cp "$T/probe/esc2-del-summary.txt" "$E/checks/escape-probe/summary-delivery.txt"
for f in "$T"/probe/esc2-del/del-*.json; do cp "$f" "$E/checks/escape-probe/"; done

# The last development round (all eight environments): what was left before the formal round.
mkdir -p "$E/process/dev-r3"
cp "$V/dev/compare-r3/summary.json" "$V/dev/compare-r3/beyond-clusters.txt" "$V/dev/compare-r3/trace-semantics.json" "$E/process/dev-r3/"
log "$V/dev/round3.log" "$E/process/dev-r3/round3.log"
# The Plan usage case repeated on the reference (the one-environment escape observation of the development round):
# the run's log and, per repeat, what the escape step observed.
{ log "$V/dev/probe-escape/log.txt" /dev/stdout | grep -E "passed|failed|flaky"
  python3 -I - "$V/dev/probe-escape/out/report.json" <<'PY'
import base64, json, sys
def walk(suite):
    for child in suite.get('suites', []): yield from walk(child)
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            for result in test['results']:
                for a in result.get('attachments', []):
                    if a['name'] == 'trace' and 'body' in a:
                        yield test['projectName'], json.loads(base64.b64decode(a['body']))
for i, (project, steps) in enumerate(t for s in json.load(open(sys.argv[1]))['suites'] for t in walk(s)):
    for step in steps:
        if step['step'] == 'escape':
            print(f"repeat {i} {project}: popovers {len(step.get('popovers') or [])}, dialogs {len(step.get('dialogs') or [])}, focus {json.dumps(step['focus'])}")
PY
} > "$E/process/dev-r3/reference-plan-usage-repeat.txt"

# An earlier formal round (before the last sync with main): its step logs, the P5.1 classes and clusters, the P0
# summary, and the semantic part of its step-by-step trace comparison.
if [ -n "$PRE" ]; then
  P=$E/process/$PRE
  mkdir -p "$P"
  for f in "$V/$PRE"/*.txt; do log "$f" "$P/$(basename "$f")"; done
  cp "$V/compare-$PRE/p51-classes.txt" "$V/compare-$PRE/p51-beyond-classes.json" "$V/compare-$PRE/p51-beyond-clusters.txt" \
     "$V/compare-$PRE/p0-summary.json" "$P/"
  python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); json.dump({k: d[k] for k in ('tests', 'steps', 'semantic', 'presentation')}, open(sys.argv[2], 'w'), indent=1, ensure_ascii=False)" \
    "$V/compare-$PRE/p51-trace-semantics.json" "$P/p51-trace-semantics.semantic.json"
fi

# Scripts as run that live only on /mnt/data (the rest were run from scripts/ itself).
cp "$T/scripts/classify.py" "$T/scripts/collect.sh" "$T/scripts/round3.sh" "$T/scripts/repeat-run.sh" \
   "$T/scripts/list-owners.mjs" "$T/scripts/list-css-owners.mjs" "$T/scripts/vt-focus.sh" "$T/scripts/vt-full.sh" \
   "$T/scripts/probe-repeat.sh" "$T/scripts/wait-step.sh" "$E/scripts/"
du -sb "$E"; du -sh "$E"
