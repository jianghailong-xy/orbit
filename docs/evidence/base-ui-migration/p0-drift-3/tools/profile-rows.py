#!/usr/bin/env python3
"""Usage: profile-rows.py <compare.json>... : the 16 profile screenshots of each comparison (class, pixels, max delta)."""
import json, sys
for p in sys.argv[1:]:
    d = json.load(open(p))
    if 'rows' not in d: continue
    rows = [r for r in d['rows'] if r['file'].split('/')[1] in ('profile.png', 'profile-validation.png')]
    from collections import Counter
    c = Counter((r['file'].split('/')[1], r['class']) for r in rows)
    print(p.split('/')[-1], dict(c), [(r['file'], r['differentPixels'], r['maxChannelDelta']) for r in rows if r['class'] != 'same'])
