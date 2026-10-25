#!/usr/bin/env bash
# Usage: drill.sh
# Batch 7's remaining comparisons: A13's exact predecessor; the drill-down inside main cbe6a6635 (its second parent's
# first-parent line starts at 33e0e2e09, whose parent db69d833b is the main commit it branched from), with the tip's
# P0 tests (220 screenshots: the tip's settings/profile scenarios wait for P4.1's .orbit-card) and with db69d833b's
# own P0 tests for settings/profile (32 screenshots); the sidebar column (x < 272) of 33e0e2e09 against cbe6a6635 for
# the 104 A12 screenshots; and P4.3a (abc0a4cfa) against P4.3b (ffae02edf) for the WebKit full-screen graph.
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
bash $B/scripts/pairs.sh a74ecb43b d976df772 d976df772 3960c19c2 db69d833b 33e0e2e09 cbe6a6635 abc0a4cfa abc0a4cfa ffae02edf
o=$B/cmp/sp-old-db69d833b__sp-old-33e0e2e09.json
[ -f "$o" ] || node $B/scripts/compare.cjs $B/runs/sp-old-db69d833b/snapshots $B/runs/sp-old-33e0e2e09/snapshots "$o" > /dev/null
python3 $B/scripts/compare-summary.py $B/cmp/summary-sp-old.json "$o"
python3 - <<'PY'
import json, subprocess
B = '/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4'
a12 = sorted(r['file'] for r in json.load(open(f'{B}/cmp/fce12bc2a__cbe6a6635.json'))['rows'] if r['class'] == 'changed')
sp = lambda f: f.split('/')[1] in ('settings.png', 'settings-saved.png', 'profile.png', 'profile-validation.png')
out = {}
for f in a12:
    a = f'{B}/runs/sp-old-33e0e2e09/snapshots/{f}' if sp(f) else f'{B}/runs/full-33e0e2e09/snapshots/{f}'
    r = subprocess.run(['python3', f'{B}/scripts/regions.py', a.rsplit('/', 2)[0], f'{B}/runs/full-cbe6a6635/snapshots', '272', f], capture_output=True, text=True).stdout
    left = int(r.split('left: ')[1].split(' px')[0]); right = int(r.split('right: ')[1].split(' px')[0])
    out[f] = {'run33e0e2e09': 'sp-old-33e0e2e09' if sp(f) else 'full-33e0e2e09', 'sidebarColumnPixels': left, 'restPixels': right, 'detail': r.strip()}
json.dump(out, open(f'{B}/cmp/sidebar-column__33e0e2e09__cbe6a6635.json', 'w'), indent=1)
print('A12 screenshots:', len(out), '| sidebar column identical:', sum(1 for v in out.values() if v['sidebarColumnPixels'] == 0),
      '| differing in the sidebar column:', [(k, v['sidebarColumnPixels']) for k, v in out.items() if v['sidebarColumnPixels']])
PY
