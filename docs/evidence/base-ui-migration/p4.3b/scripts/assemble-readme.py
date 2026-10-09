#!/usr/bin/env python3
"""assemble-readme.py OUT: the evidence README from try/README.*.md, placeholders filled; fails on a leftover
placeholder or an internal #anchor link no heading makes (GitHub's slug: lowercase, punctuation dropped, spaces
to hyphens)."""
import re, sys
T = '/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/try/README.'
part = lambda name: open(T + name + '.md').read().strip('\n')
order = ['head', 'conclusion', 'part2', 'followmain2', 'followmain3', 'followp43a', 'part3', 'part4', 'part5', 'part6', 'part7', 'part8',
         'closing', 'repro']
fills = {
    'stylesheet': part('stylesheet-check'),
    'results': part('results'),
    'diffs': '\n\n'.join(part(n) for n in ('diffs-p43b', 'diffs-p43b-shots', 'geometry', 'diffs-others', 'p0-drift')),
}
text = '\n\n'.join(part(n) for n in order) + '\n'
for key, value in fills.items():
    marker = f'<!-- R:{key} -->'
    assert text.count(marker) == 1, (key, text.count(marker))
    text = text.replace(marker, value)
left = re.findall(r'<!-- R:[^>]*-->', text)
assert not left, left
def slug(h):
    h = h.strip().lower()
    h = re.sub(r'[^\w\- ]', '', h)
    return h.replace(' ', '-')
heads = [slug(m) for m in re.findall(r'^#{1,6} (.+)$', text, flags=re.M)]
seen, anchors = {}, set()
for h in heads:
    n = seen.get(h, 0)
    anchors.add(h if n == 0 else f'{h}-{n}')
    seen[h] = n + 1
bad = sorted({a for a in re.findall(r'\]\(#([^)]+)\)', text) if a not in anchors})
assert not bad, bad
open(sys.argv[1], 'w').write(text)
print('ok', len(text.encode()), 'bytes,', len(heads), 'headings')
