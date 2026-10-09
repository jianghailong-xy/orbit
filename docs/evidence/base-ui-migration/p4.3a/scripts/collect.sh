#!/usr/bin/env bash
# Copy what README.md cites from the runs on /mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1 into this directory:
#  - round 6, the final round (formal6.sh on origin/main 76d41066d; runs6/ -> runs/): every step's log (terminal
#    colour codes removed; argv, tree, HEAD, uncommitted paths, load, disk and exit code at the top and bottom of each),
#    the Playwright reports of the runs whose results are read here with attachment bodies removed
#    (p0-drift-3/tools/report-summary.py), the standard P0 runs' expectations, the comparisons (analyze6.sh) and the
#    beyond-level shots' classes (classify6.py), the P4.3a traces of both trees, the OrbitKit swift run;
#  - round 5 (formal5.sh on origin/main 5b794d643; runs-r5/, compare-r5/): every step's log but the merge check's, the
#    comparisons' summaries and classes; its repeat runs (repeat.sh; round 6 has none) with their analysis, one copy of
#    each variant of a watched shot that varied between runs, and the reload, keys and geometry probes' logs
#    (probe-reload.sh, probe-keys.sh, probe-geom.sh), all under repeat-r5/;
#  - round 4 (formal.sh on origin/main 3369ee1e0; runs-r4/): every step's log but the merge check's, the reports of the
#    start comparisons (which rounds 5 and 6 do not rerun), the comparisons;
#  - the cited screenshots: the beyond-level pairs of round 6's P4.3a comparison in full, but those of edge
#    rasterization (classify6.py), which go on one cropped sheet (pairs.py), as do round 4's start-comparison beyond
#    pairs; the P0 matrix's beyond pairs in full;
#  - the audits, owner check, record check and closure (checks/, from audit.sh) and the keyboard fix's red/green run
#    (checks/keys-red-green.txt, from keys-red-green.sh);
#  - process records: the early P0 runs that found the cascade ties, rounds 2-3 on the old base, round 4 as run 1 left
#    it, round 4a (run 2, before the review fixes), the measurement probes.
# Raw runs stay on /mnt/data until judged.
set -eu
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
E=$(cd "$(dirname "$0")/.." && pwd)
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs runs-r5 runs-r4 compare compare-r5 compare-r4 traces shots checks process repeat-r5; do rm -rf "${E:?}/$d"; mkdir -p "$E/$d"; done
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }

# Round 6.
R=$V/runs6
for f in "$R"/*.txt; do log "$f" "$E/runs/$(basename "$f")"; done
for n in p43a-ref p43a-del p0-strict; do $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for n in p0-standard p0-standard-base; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
  cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
for n in overlays controls; do $SUMMARY "$R/$n-report.json" "$E/runs/$n.report.summary.json" > /dev/null; done
for f in "$R"/choices-*-report.json; do n=$(basename "$f" -report.json); $SUMMARY "$f" "$E/runs/$n.report.summary.json" > /dev/null; done
C=$V/compare6
python3 -I "$V/scripts/classify6.py" "$V" > /dev/null
cp "$C"/*-summary.json "$C"/*-beyond-clusters.txt "$C"/p43a-trace-semantics.json "$C"/p43a-compare.json "$C"/p0-compare.json \
   "$C"/p43a-beyond-classes.json "$E/compare/"
python3 -I "$E/../p4.1/extract-traces.py" "$R/p43a-ref-out/report.json" "$E/traces/p43a-ref.json"
python3 -I "$E/../p4.1/extract-traces.py" "$R/p43a-del-out/report.json" "$E/traces/p43a-del.json"
log "$V/swift-check-r6.txt" "$E/checks/swift-check-r6.txt"
log "$V/swift/d9e720533.txt" "$E/checks/swift-d9e720533.txt"

# Round 5: logs and the comparisons' summaries and classes.
R5=$V/runs5
for f in "$R5"/*.txt; do [ "$(basename "$f")" = merge.txt ] || log "$f" "$E/runs-r5/$(basename "$f")"; done
cp "$V/compare5"/*-summary.json "$V/compare5"/*-beyond-clusters.txt "$V/compare5"/p43a-trace-semantics.json \
   "$V/compare5"/p43a-beyond-classes.json "$E/compare-r5/"

# Round 4.
R4=$V/runs-r4
for f in "$R4"/*.txt; do [ "$(basename "$f")" = merge.txt ] || log "$f" "$E/runs-r4/$(basename "$f")"; done
for n in p41-base p41-del p42-base p42-del pilot-base pilot-del; do
  $SUMMARY "$R4/$n-out/report.json" "$E/runs-r4/$n.report.summary.json" > /dev/null
done
cp "$V/compare-r4"/*-summary.json "$V/compare-r4"/*-beyond-clusters.txt "$V/compare-r4"/*-trace-semantics.json "$E/compare-r4/"

# Round 5's repeat runs: their logs (the reports' results are in the analysis), and of each watched shot that was not
# the same in every run one copy per variant, named by its hash as in the analysis. Then the probes' logs.
for d in "$V"/repeat-r5/*-[0-9]; do log "$d/run.txt" "$E/repeat-r5/$(basename "$d").txt"; done
cp "$V/repeat-r5/analysis.json" "$E/repeat-r5/analysis.json"
python3 -I - "$V" "$E/repeat-r5/variants" <<'PY'
import hashlib, json, os, shutil, sys
v, out = sys.argv[1:3]
dirs = {'ref': [f'{v}/runs5/p43a-ref-shots'] + [f'{v}/repeat-r5/ref-{n}/shots' for n in (1, 2, 3)],
        'del': [f'{v}/runs5/p43a-del-shots'] + [f'{v}/repeat-r5/del-{n}/shots' for n in (1, 2, 3)]}
for key, trees in json.load(open(f'{v}/repeat-r5/analysis.json'))['shots'].items():
    if len({h for runs in trees.values() for h in runs.values()}) < 2: continue
    env, shot = key.split('/')
    for paths in dirs.values():
        for d in paths:
            src = f'{d}/{env}/{shot}.png'
            h = hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12]
            os.makedirs(out, exist_ok=True)
            dst = f'{out}/{env}.{shot}.{h}.png'
            if not os.path.exists(dst): shutil.copy(src, dst)
PY
for p in reload keys geom; do for t in ref del; do log "$V/probe-$p-r5/$t/run.txt" "$E/repeat-r5/probe-$p-$t.txt"; done; done
# The geometry probe, one line per run with the boxes that differ between the list's two places.
python3 -I - "$V" > "$E/repeat-r5/probe-geom.txt" <<'PY'
import json, re, sys
v = sys.argv[1]
print('tree  run  column heads (top+height)  .tasks-toolbar  .tasks-bulkbar offset/client height  .tasks-body top')
for tree in ('ref', 'del'):
    for line in open(f'{v}/probe-geom-r5/{tree}/run.txt'):
        m = re.match(r'KEYS-GEOM (\S+) (\d+) (.*)$', line.strip())
        if not m: continue
        g = json.loads(m.group(3))
        toolbar = next(x.split('@')[1] for x in g['above'] if x.startswith('div.tasks-toolbar@'))
        print(f"{tree}   {m.group(2)}    {g['heads'][0]}+{g['heads'][1]}                {toolbar}      {g['bar']['offsetHeight']}/{g['bar']['clientHeight']}                               {g['body']['box'][0]}")
PY

# Screenshots: round 6's beyond-level pairs (reference and delivery) in full, but the edge-rasterization ones, which go
# on one cropped sheet; round 4's start-comparison beyond pairs as another.
python3 -I - "$V" "$E/shots" <<'PY'
import json, os, shutil, subprocess, sys
v, out = sys.argv[1:3]
classes = json.load(open(f'{v}/compare6/p43a-beyond-classes.json'))
edges = []
for summary, name, before, after in (('p43a', 'p43a-beyond', 'p43a-ref', 'p43a-del'), ('p0', 'p0-beyond', 'p0-ref', 'p0-del')):
    for item in json.load(open(f'{v}/compare6/{summary}-summary.json'))['beyond']:
        if summary == 'p43a' and classes[item['shot']]['class'] == 'edge rasterization':
            edges.append(item['shot'])
            continue
        env, shot = item['shot'].split('/')
        os.makedirs(f'{out}/{name}/{env}', exist_ok=True)
        shutil.copy(f'{v}/runs6/{before}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.reference.png')
        shutil.copy(f'{v}/runs6/{after}-shots/{env}/{shot}', f'{out}/{name}/{env}/{shot[:-4]}.delivery.png')
subprocess.run(['python3', '-I', f'{v}/scripts/pairs.py', f'{v}/runs6/p43a-ref-shots', f'{v}/runs6/p43a-del-shots',
                f'{out}/p43a-edges.png', *sorted(edges)], check=True, stdout=subprocess.DEVNULL)
PY
python3 -I - "$V" "$E/shots/start-beyond-r4.png" <<'PY'
import json, subprocess, sys
v, out = sys.argv[1:3]
args = []
for name in ('p41', 'p42', 'pilot'):
    for item in json.load(open(f'{v}/compare-r4/{name}-summary.json'))['beyond']:
        args.append((name, item['shot']))
# pairs.py takes one reference and one delivery directory; the three specs' shots live in their own directories, so
# one sheet per spec, then stacked.
from PIL import Image
sheets = []
for name in ('p41', 'p42', 'pilot'):
    shots = [shot for n, shot in args if n == name]
    if not shots: continue
    part = f'{out[:-4]}-{name}.png'
    subprocess.run(['python3', '-I', f'{v}/scripts/pairs.py', f'{v}/runs-r4/{name}-base-shots', f'{v}/runs-r4/{name}-del-shots', part, *shots], check=True, stdout=subprocess.DEVNULL)
    sheets.append(Image.open(part))
W = max(s.width for s in sheets); H = sum(s.height + 6 for s in sheets)
sheet = Image.new('RGB', (W, H), (200, 200, 200)); y = 0
for s in sheets: sheet.paste(s, (0, y)); y += s.height + 6
sheet.save(out)
import os
for name in ('p41', 'p42', 'pilot'):
    part = f'{out[:-4]}-{name}.png'
    if os.path.exists(part): os.remove(part)
PY
for pair in p0-standard:$V/runs6/p0-standard-out p0-standard-base:$V/runs6/p0-standard-base-out; do
  for dir in "${pair#*:}"/*/; do
    ls "$dir"*-diff.png > /dev/null 2>&1 || continue
    mkdir -p "$E/shots/${pair%%:*}/$(basename "$dir")"
    cp "$dir"*-expected.png "$dir"*-actual.png "$dir"*-diff.png "$E/shots/${pair%%:*}/$(basename "$dir")/"
  done
done

# Audits and records.
cp "$V/checks"/* "$E/checks/"
cp "$V/inventory-closure.json" "$E/inventory-closure.json"

# Process records.
cp -r "$V/process"/. "$E/process/"

# Scripts as run.
mkdir -p "$E/scripts"
cp "$V/scripts/make-trees.sh" "$V/scripts/make-trees-r4.sh" "$V/scripts/formal.sh" "$V/scripts/formal5.sh" "$V/scripts/formal6.sh" "$V/scripts/analyze.sh" \
   "$V/scripts/analyze5.sh" "$V/scripts/analyze6.sh" \
   "$V/scripts/collect.sh" "$V/scripts/ties.py" "$V/scripts/pairs.py" "$V/scripts/audit.sh" "$V/scripts/keys-red-green.sh" \
   "$V/scripts/keys-fix.patch" "$V/scripts/repeat.sh" "$V/scripts/repeat-analyze.py" "$V/scripts/swift-check.sh" \
   "$V/scripts/probe-reload.sh" "$V/scripts/probe-keys.sh" "$V/scripts/probe-geom.sh" "$V/scripts/classify5.py" "$V/scripts/classify6.py" "$E/scripts/"
mkdir -p "$E/scripts/probe"
cp "$V/probe/probe-p43a.browser.mjs" "$V/probe/probe2.browser.mjs" "$V/probe/ref/probe.config.mjs" "$E/scripts/probe/"
cp "$V/probe/reload/p43a-reload-probe.browser.mjs" "$V/probe/keys/p43a-keys-probe.browser.mjs" "$V/probe/geom/p43a-keys-geom-probe.browser.mjs" "$E/scripts/probe/"
du -sb "$E"; du -sh "$E"
