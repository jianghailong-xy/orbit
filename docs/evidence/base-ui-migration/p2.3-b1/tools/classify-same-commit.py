#!/usr/bin/env python3
"""Usage: classify-same-commit.py <baseline-collected> <fix-collected> <out.json>
For every PNG attachment of the toasts matrix that differs between the unmodified tip and the fix, where
the difference is: the clusters of differing pixels (8-connected after 6 px dilation), how many differing
pixels fall inside the notification area (full-page shots: desktop x>=880 & y<420, phone y in 40..420;
notification-region shots, i.e. images smaller than the viewport: everywhere), whether the test shows a pill,
and the count of bluish pixels (blue - red > 40) in the notification area on each side: equal counts are
blue glyphs or buttons, unequal counts mark a selection highlight present on one side only."""
import json, pathlib, subprocess, sys
import numpy as np
from PIL import Image
base, fix, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
PILL_TESTS = ('legacy-AntApp', 'mixed-pinned-and-passing', 'phone-folding', 'short-and-lifecycle')
rows = []
for f in sorted(fix.glob('*.png')):
    b = base / f.name
    if not b.exists(): continue
    A = np.asarray(Image.open(b).convert('RGBA')).astype(int); B = np.asarray(Image.open(f).convert('RGBA')).astype(int)
    if A.shape != B.shape: rows.append({'file': f.name, 'sizeMismatch': True}); continue
    d = np.abs(A - B).max(axis=2)
    if not d.any(): continue
    h, w = d.shape
    region = (w, h) not in {(1280, 900), (390, 844)}  # notification-region screenshots are smaller than the viewport
    if region: mask = np.ones_like(d, dtype=bool)
    elif w > 600: mask = np.zeros_like(d, dtype=bool); mask[0:420, 880:w] = True
    else: mask = np.zeros_like(d, dtype=bool); mask[40:420, 0:w] = True
    inside = int(((d > 0) & mask).sum()); total = int((d > 0).sum())
    blue = lambda X: int((((X[:, :, 2] - X[:, :, 0]) > 40) & mask).sum())
    cl = json.loads(subprocess.check_output(['node', '/var/tmp/p23b1/scripts/regions.cjs', str(b), str(f)], text=True))['clusters'][:4]
    rows.append({'file': f.name, 'differentPixels': total, 'maxChannelDelta': int(d.max()), 'insideNotificationArea': inside,
                 'outsideNotificationArea': total - inside, 'pillTest': any(t in f.name for t in PILL_TESTS),
                 'highlightBaseline': blue(A), 'highlightFix': blue(B), 'clusters': cl})
json.dump(rows, open(out, 'w'), indent=1)
for r in rows:
    if r.get('sizeMismatch'): print('size mismatch', r['file']); continue
    kind = ('pill' if r['pillTest'] else 'card') + (' highlight b/f %d/%d' % (r['highlightBaseline'], r['highlightFix']) if r['highlightBaseline'] or r['highlightFix'] else '')
    print(f"{r['differentPixels']:7} px max {r['maxChannelDelta']:3} in-notif {r['insideNotificationArea']:6} out {r['outsideNotificationArea']:7} [{kind}] {r['file'][:110]}")
