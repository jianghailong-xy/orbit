#!/usr/bin/env python3
"""What two runs of one tree differ by, against what the two trees differ by, screenshot by screenshot.

usage: analyze-noise.py RUN_DIR SET > OUT.json      (SET: p0 or p52; reads SET-ref-shots, SET-ref2-shots, SET-del-shots,
                                                     SET-del2-shots under RUN_DIR)

For every screenshot name, the sha256 of each of the four files. Then:
- pairs: for each pair of runs (ref|del across the trees in each round, ref|ref2 and del|del2 within a tree, and the two
  crossings ref|del2, ref2|del), how many names are byte-identical and which are not, each differing one with its
  differing pixels and largest channel difference, and the pair's count at antialias level (every channel within 2)
  and beyond (P3.1/P3.2's classes, as p4.1/summarize.py draws them);
- variants: for each name, the distinct images each tree drew over its two runs; `onlyRef`/`onlyDel` list the names for
  which one tree drew an image the other never did.
Only reads.
"""
import hashlib, json, os, sys
from PIL import Image, ImageChops

root, name = sys.argv[1:3]


def pixels(a, b):
    ia, ib = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    if ia.size != ib.size:
        return {'size': [ia.size, ib.size]}
    diff = ImageChops.difference(ia, ib)
    channel = max(high for _, high in diff.getextrema())
    count = sum(1 for p in diff.get_flattened_data() if any(p))
    return {'pixels': count, 'max': channel}


runs = ['ref', 'ref2', 'del', 'del2']


def shots(path):
    out = {}
    for p, _, fs in os.walk(path):
        for f in fs:
            if f.endswith('.png'):
                full = os.path.join(p, f)
                out[os.path.relpath(full, path)] = hashlib.sha256(open(full, 'rb').read()).hexdigest()[:16]
    return out


h = {run: shots(f'{root}/{name}-{run}-shots') for run in runs}
names = sorted(set().union(*h.values()))
out = {'set': name, 'names': len(names), 'perRun': {run: len(h[run]) for run in runs}, 'pairs': {}, 'variants': {}}
for a, b in [('ref', 'del'), ('ref2', 'del2'), ('ref', 'ref2'), ('del', 'del2'), ('ref', 'del2'), ('ref2', 'del')]:
    differing = [n for n in names if h[a].get(n) != h[b].get(n)]
    stats = {n: pixels(f'{root}/{name}-{a}-shots/{n}', f'{root}/{name}-{b}-shots/{n}') for n in differing}
    out['pairs'][f'{a}|{b}'] = {'identical': len(names) - len(differing), 'differing': stats,
                                'antialias': sum(1 for s in stats.values() if s.get('max', 999) <= 2),
                                'beyond': sum(1 for s in stats.values() if s.get('max', 999) > 2)}
only_ref, only_del = [], []
for n in names:
    r = sorted({h['ref'].get(n), h['ref2'].get(n)} - {None})
    d = sorted({h['del'].get(n), h['del2'].get(n)} - {None})
    if len(r) > 1 or len(d) > 1 or r != d:
        out['variants'][n] = {'ref': [h['ref'].get(n), h['ref2'].get(n)], 'del': [h['del'].get(n), h['del2'].get(n)]}
    if set(r) - set(d):
        only_ref.append(n)
    if set(d) - set(r):
        only_del.append(n)
out['onlyRef'], out['onlyDel'] = only_ref, only_del
json.dump(out, sys.stdout, indent=1, sort_keys=True)
print()
for pair, v in out['pairs'].items():
    largest = max(v['differing'].items(), key=lambda kv: (kv[1].get('max', 999), kv[1].get('pixels', 0)), default=None)
    print(f"{name} {pair}: identical {v['identical']}, antialias {v['antialias']}, beyond {v['beyond']}"
          + (f"; largest {largest[0]} {json.dumps(largest[1])}" if largest else ''), file=sys.stderr)
print(f"{name}: {len(names)} names; names with more than one image in any run: {len(out['variants'])}; "
      f"drawn only by ref {len(only_ref)}, only by del {len(only_del)}", file=sys.stderr)
