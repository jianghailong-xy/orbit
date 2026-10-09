#!/usr/bin/env bash
# Copy what README.md cites from this task's runs (/mnt/data/tmp/34blYpxEcHMAf4oafuC2W) into this directory:
#  - the formal runs (formal.sh, runs/): run logs, Playwright reports with attachment bodies removed
#    (p0-drift-3/tools/report-summary.py), the standard P0 runs' expectations;
#  - the comparisons (analyze.sh, compare/), the P4.3b traces of both trees;
#  - the cited screenshots: every beyond-level pair of the P4.3b and decision-card comparisons and of the
#    P0, pilot, P4.1 and P4.2 comparisons (full or cropped, see below), the geometry captures at 639/641/1280px
#    of both trees, and the delivery's states in one environment;
#  - the probes (probes.sh: specs and outputs), the audits and closure (final-audit.sh), the start-of-task
#    audit records, the same-specificity check, the audit the 2026-10-09 record was built from;
#  - the checks the coordinator asked for on 2026-10-09 (extras.sh, extra/): first-page resources, the
#    reordered stylesheet pairs, lazily loaded styles, the session export, the two negative controls; and the
#    samples before and after settled() waited out rc-motion (settle-compare.json);
#  - the OrbitKit swift suite: red on the first final-round delivery, the fixed classes, green on the delivery (swift/);
#  - the three attempts of this round that were stopped (round-e21fad172-interrupted: the runner's OOM stop, the weekly
#    limit, the memory rule): their logs and the error contexts of the two cases that timed out (runs/interrupted/);
#  - the merge check and related tests on e21fad172 before the test-only fix 2fefd4747, and the file's repeated runs on
#    both trees and after the fix (round-e21fad172-reruns, runs/reruns/);
#  - the standard P0's base drift (failure list and crops) and the dry run against origin/main before the evidence;
#  - the scripts themselves.
# It writes into fresh subdirectories and stops if one is already there (move it aside first), so it never
# deletes anything. Raw runs stay on /mnt/data until judged.
set -eu
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
R=$V/runs
C=$V/compare
F=$V/final
X=$V/extra
E=$(cd "$(dirname "$0")/.." && pwd)
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare traces shots probes checks extra swift; do mkdir "$E/$d"; done
mkdir "$E/runs/interrupted" "$E/runs/reruns"

# Run logs (argv, tree, HEAD, uncommitted paths, load, disk and exit code at the top and bottom of each;
# terminal colour codes removed), and reports without attachment bodies. To keep this directory under
# 30 MB, the runs that only write screenshots for a comparison (P0 matrix reference and delivery, pilot,
# P4.1 and P4.2 on both trees) keep their reports on /mnt/data: their logs carry the results and
# compare/ carries the comparison.
log() { sed 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
for n in f-p43b-ref f-p43b-del f-cards-ref f-cards-del f-p0-ref f-p0-strict f-p0-del f-p0-standard f-p0-standard-start \
         pilot-ref pilot-del c-merge u-related c-overlays c-controls c-choices f-p41-start f-p41-del f-p42-start f-p42-del; do
  log "$R/$n.txt" "$E/runs/$n.txt"
done
for n in f-p43b-ref f-p43b-del f-cards-ref f-cards-del f-p0-strict f-p0-standard f-p0-standard-start; do
  $SUMMARY "$R/$n-out/report.json" "$E/runs/$n.report.summary.json" > /dev/null
done
for n in f-p0-standard f-p0-standard-start; do
  cp "$R/$n-out/expected-screenshots/sources.json" "$E/runs/$n.expected-sources.json"
done
$SUMMARY "$R/c-overlays-report.json" "$E/runs/c-overlays.report.summary.json" > /dev/null
$SUMMARY "$R/c-controls-report.json" "$E/runs/c-controls.report.summary.json" > /dev/null
$SUMMARY "$R/c-choices-report.json" "$E/runs/c-choices.report.summary.json" > /dev/null

# Comparisons, and the P4.3b traces of both trees (the case page's and the decision-card page's).
cp "$C"/*.json "$C"/*.txt "$E/compare/"
for n in f-p43b-ref f-p43b-del f-cards-ref f-cards-del; do
  python3 -I "$E/../p4.1/extract-traces.py" "$R/$n-out/report.json" "$E/traces/$n.json"
done
cp "$V/settle-compare.json" "$E/compare/settle-compare.json"

# Screenshots. To keep this directory under 30 MB: of the beyond-level pairs, the P4.3b cases' and the decision-card
# page's first environment of each screenshot gets both full screenshots; every other pair (the other environments, and
# the P0, pilot and P4.1 pairs, which are small spots) gets one side-by-side crop of the differing area, padded, the
# reference on the left. The delivery's states: Chromium light desktop. Full screenshots stay in the runs on /mnt/data.
python3 -I - "$V" "$E/shots" <<'PY'
import json, os, shutil, sys
from PIL import Image
v, out = sys.argv[1:3]
runs = os.path.join(v, 'runs')
pairs = {'f-p43b': ('f-p43b-ref', 'f-p43b-del', 'reference', 'delivery'), 'f-cards': ('f-cards-ref', 'f-cards-del', 'reference', 'delivery'),
         'f-p0': ('f-p0-ref', 'f-p0-del', 'reference', 'delivery'), 'pilot': ('pilot-ref', 'pilot-del', 'reference', 'delivery'),
         'f-p41': ('f-p41-start', 'f-p41-del', 'start', 'delivery'), 'f-p42': ('f-p42-start', 'f-p42-del', 'start', 'delivery')}
full = crops = 0
for name, (a, b, la, lb) in pairs.items():
    summary = json.load(open(os.path.join(v, 'compare', f'{name}-summary.json')))
    seen = set()
    for item in sorted(summary['beyond'], key=lambda each: each['shot']):
        project, shot = item['shot'].split('/')
        whole = name in ('f-p43b', 'f-cards') and shot not in seen
        seen.add(shot)
        if whole:
            for run, label in ((a, la), (b, lb)):
                dst = os.path.join(out, f'{name}-beyond', project, shot.replace('.png', f'.{label}.png'))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(os.path.join(runs, f'{run}-shots', project, shot), dst)
                full += 1
            continue
        ia = Image.open(os.path.join(runs, f'{a}-shots', project, shot)).convert('RGB')
        ib = Image.open(os.path.join(runs, f'{b}-shots', project, shot)).convert('RGB')
        xs = [x for c in item['clusters'] for x in c[0]]; ys = [y for c in item['clusters'] for y in c[1]]
        pad = 48
        box = (max(0, min(xs) - pad), max(0, min(ys) - pad), min(ia.width, max(xs) + pad + 1), min(ia.height, max(ys) + pad + 1))
        ca, cb = ia.crop(box), ib.crop(box)
        pair = Image.new('RGB', (ca.width * 2 + 8, ca.height), 'white')
        pair.paste(ca, (0, 0)); pair.paste(cb, (ca.width + 8, 0))
        dst = os.path.join(out, f'{name}-beyond', project, shot.replace('.png', f'.crop-{la}-{lb}.png'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        pair.save(dst, optimize=True)
        crops += 1
# The graph at 639, 641 and 1280px on both trees (desktop environments).
for run in ('f-p43b-ref', 'f-p43b-del'):
    for project in sorted(os.listdir(os.path.join(runs, f'{run}-shots'))):
        for width in (639, 641, 1280):
            src = os.path.join(runs, f'{run}-shots', project, f'p43b-geometry-{width}.png')
            if os.path.exists(src):
                dst = os.path.join(out, 'geometry', project, f'p43b-geometry-{width}.{"reference" if run.endswith("ref") else "delivery"}.png')
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
                full += 1
# The delivery's states, Chromium light desktop (those not already among the full beyond pairs).
for run in ('f-p43b-del', 'f-cards-del'):
    project = 'chromium-light-desktop'
    folder = os.path.join(runs, f'{run}-shots', project)
    name = 'f-p43b' if run.startswith('f-p43b') else 'f-cards'
    for shot in sorted(os.listdir(folder)):
        if os.path.exists(os.path.join(out, f'{name}-beyond', project, shot.replace('.png', '.delivery.png'))):
            continue
        dst = os.path.join(out, 'delivery', project, shot)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(folder, shot), dst)
        full += 1
print('screenshots copied', full, 'crops', crops)
PY

# Probes: the specs and what they printed on each tree.
cp "$V"/probes/probe-*.browser.mjs "$V"/probes/probe.config.mjs "$V"/probes/exportCardsProbe.test.tsx "$E/probes/"
cp "$V"/probes-out/*.txt "$E/probes/"

# The 2026-10-09 checks (extras.sh).
cp "$X"/bundle-compare.json "$X"/bundle-compare.txt "$X"/order-start.json "$X"/order-delivery.json "$X"/component-order-ties.txt \
   "$X"/stylesheet-test-negatives.txt "$X"/overlays-gives-way-with-fix.txt "$X"/overlays-gives-way-without-fix.txt "$E/extra/"
cp "$X"/probes/*.txt "$E/probes/"
cp -r "$X/probes/lazy-rerun" "$E/probes/"
if [ -d "$X/pilot-detail-rerun" ]; then cp -r "$X/pilot-detail-rerun" "$E/extra/"; fi
mkdir -p "$E/extra/export"
cp "$X"/export/compare.json "$E/extra/export/"
for t in ref del; do
  mkdir -p "$E/extra/export/$t"
  cp "$X/export/$t/requested-outcome.txt" "$E/extra/export/$t/"
  cp -r "$X/export/shots/$t" "$E/extra/export/$t/shots"
done

# Audits and closure (final-audit.sh), start-of-task records, the same-specificity check, related tests, and the
# audit of 74517607b that build-record-09.py wrote 2026-10-09.json from.
cp "$F/inventory-closure.json" "$E/inventory-closure.json"
cp "$F/del-audit.json" "$F/del-audit-summary.txt" "$F/del-check-owners.txt" "$F/ref-audit.json" "$F/ref-audit-summary.txt" "$E/checks/"
cp "$V/checks/start-check-owners.json" "$V/checks/start-p43b-points.jsonl" "$V/checks/start-audit-summary.txt" "$V/checks/ties.txt" "$E/checks/"
cp -r "$V/checks/p0-standard-base-drift" "$E/checks/"
cp "$V"/checks/main-*-dry-run.txt "$E/checks/"
cp "$V/try/final9-audit-pre-record.json" "$E/checks/record-09-audit.json"
tr ' ' '\n' < "$V/related-tests.txt" | grep . > "$E/checks/related-tests.txt"

# The OrbitKit swift suite (swift:6.1, as ci.yml's Swift core): red on 222017b25, the fixed classes, green on the final round's
# delivery (final-chain.sh). The round before P4.3a landed (a8df7eac6 and main 945098b11, both green) stays on /mnt/data.
cp "$V/swift/swift-test-222017b25.txt" "$V/swift/swift-filter-fixed.txt" "$E/swift/"
cp "$V/swift/swift-test.txt" "$E/swift/swift-test-$(cut -c1-9 "$V/swift/head.txt").txt"

# The stopped attempts of this round (all in the first step, f-p43b-ref on the reference tree), and the error contexts of
# the two cases that timed out in the first one.
I=$V/round-e21fad172-interrupted
log "$I/f-p43b-ref.txt" "$E/runs/interrupted/attempt1-f-p43b-ref.txt"
log "$I/attempt2/f-p43b-ref.txt" "$E/runs/interrupted/attempt2-f-p43b-ref.txt"
log "$I/attempt3/f-p43b-ref.txt" "$E/runs/interrupted/attempt3-f-p43b-ref.txt"
cp "$I"/f-p43b-ref-out/*-own-words-refused-chromium-dark-desktop/error-context.md "$E/runs/interrupted/attempt1-coordinator-question-chromium-dark-desktop.error-context.md"
cp "$I"/f-p43b-ref-out/*-refused-loading-and-unread-chromium-dark-desktop/error-context.md "$E/runs/interrupted/attempt1-owner-start-chromium-dark-desktop.error-context.md"

# The merge check and related tests on e21fad172 (red: one race in main's WorkspaceView test, then fixed by 2fefd4747),
# and that test file's runs alone on both trees, before and after the fix.
Q=$V/round-e21fad172-reruns
log "$Q/c-merge-e21fad172.txt" "$E/runs/reruns/c-merge-e21fad172.txt"
log "$Q/u-related-e21fad172-85.txt" "$E/runs/reruns/u-related-e21fad172-85.txt"
cp -r "$Q/repeat-acceptance" "$Q/repeat-acceptance-fixed" "$E/runs/reruns/"

# The scripts these came from.
for s in final-chain.sh make-trees.sh formal.sh analyze.sh probes.sh probe.sh final-audit.sh trial-grep.sh trace-semantics.py beyond-clusters.py \
         graph-geometry.py quick-diff.py ties-from-p43a.py extras.sh make-aux.sh probe-aux.sh bundle-build.sh bundle-compare.py \
         chunk-sizes.config.mjs chunk-map.config.mjs css-order.py order-ties2.py export-shots.sh stylesheet-negatives.sh \
         overlays-gives-way.sh settle-compare.py focus-classes.py pilot-detail-rerun.sh memgate.sh resolve-p43a.py follow-p43a.sh \
         p0-drift-crops.py repeat-acceptance-card.sh results-lines.py assemble-readme.py; do
  cp "$V/scripts/$s" "$E/scripts/$s"
done
du -sh "$E"
