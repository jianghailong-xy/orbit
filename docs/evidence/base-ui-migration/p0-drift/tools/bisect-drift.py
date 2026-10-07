#!/usr/bin/env python3
"""Usage: bisect.py <prefix> <only-regex> <lo-rev> <hi-rev> <candidates-file> -- <playwright selection...>

Finds every change point of the selected screenshots between lo and hi along an ordered list of
candidate commits (the build-relevant first-parent commits after lo, ending with hi). Endpoints
and midpoints are run with bisect-run.sh (label <prefix>-<short>); a sub-range whose two ends
render alike (noise-aware) is not split further. Prints and saves the change points."""
import json, subprocess, sys
B = '/var/tmp/p0drift'
REPO = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1'
sep = sys.argv.index('--')
prefix, only, lo, hi, cand_file = sys.argv[1:sep]
selection = sys.argv[sep + 1:]
short = lambda r: subprocess.check_output(['git', '-C', REPO, 'rev-parse', '--short=9', r], text=True).strip()
cands = [short(l.split()[0]) for l in open(cand_file) if l.strip()]
points = [short(lo)] + cands
if points[-1] != short(hi): points.append(short(hi))
done = {}
def run(c):
    label = f'{prefix}-{c}'
    if c not in done:
        log = f'{B}/logs/run-{label}.json'
        try:
            ok = json.load(open(log))['screenshots'] > 0
        except Exception:
            ok = False
        if not ok:
            subprocess.run([f'{B}/scripts/bisect-run.sh', c, label, *selection], check=True)
        done[c] = label
    return done[c]
def diff(a, b):
    return json.loads(subprocess.check_output(['node', f'{B}/scripts/pairdiff.cjs', run(a), run(b), only], text=True))
found = []
def search(i, j):
    changed = diff(points[i], points[j])
    if not changed:
        return
    if j == i + 1:
        found.append({'from': points[i], 'at': points[j], 'screenshots': changed})
        print(f'change {points[i]} -> {points[j]}: {len(changed)} screenshots', flush=True)
        return
    m = (i + j) // 2
    search(i, m)
    search(m, j)
search(0, len(points) - 1)
json.dump({'prefix': prefix, 'only': only, 'points': points, 'runs': done, 'changes': found}, open(f'{B}/bisect-{prefix}.json', 'w'), indent=1)
print(json.dumps([(f['from'], f['at'], len(f['screenshots'])) for f in found]))
