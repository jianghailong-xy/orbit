#!/usr/bin/env python3
"""Usage: pair-images.py <out dir>
For each attributed single commit X, one representative screenshot from the run on X^1's tree (left) and on
X's tree (right), side by side at half size with a 6px gap, plus index.json naming the runs and SHA-256s.
Visual aid only; the attribution is the pixel classification in attribution.json."""
import hashlib, json, os, sys
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
R = '/var/tmp/p0d2/runs'
pairs = [('A6 d233a6cd0', 'chromium-light-desktop/profile.png', 'full-orig-e6786d077', 'full-orig-d233a6cd0'),
         ('A6 d233a6cd0', 'webkit-light-phone/profile-validation.png', 'full-orig-e6786d077', 'full-orig-d233a6cd0'),
         ('A7 6c4e0ac0e', 'webkit-light-desktop/breakpoint-959-wiki.png', 'full-orig-4920dab40', 'full-orig-6c4e0ac0e'),
         ('A8 2f9cc095f', 'chromium-light-phone/wiki-home.png', 'full-orig-51f0cdfee', 'full-maint-2f9cc095f'),
         ('A8 2f9cc095f', 'webkit-dark-phone/wiki-contents.png', 'full-orig-51f0cdfee', 'full-maint-2f9cc095f'),
         ('A9 a884fda36', 'chromium-light-desktop/wiki-home.png', 'full-maint-b2e05492f', 'full-maint-a884fda36')]
index = []
for label, rel, before, after in pairs:
    a, b = (Image.open(f'{R}/{run}/snapshots/{rel}').convert('RGB') for run in (before, after))
    a, b = (im.resize((im.width // 2, im.height // 2), Image.LANCZOS) for im in (a, b))
    sheet = Image.new('RGB', (a.width + b.width + 6, max(a.height, b.height)), 'white')
    sheet.paste(a, (0, 0)); sheet.paste(b, (a.width + 6, 0))
    name = f"{label.split()[0]}--{rel.replace('/', '--')}"
    sheet.save(f'{out}/{name}', optimize=True)
    sha = lambda run: hashlib.sha256(open(f'{R}/{run}/snapshots/{rel}', 'rb').read()).hexdigest()
    index.append({'image': name, 'change': label, 'screenshot': rel, 'left': {'run': before, 'sha256': sha(before)}, 'right': {'run': after, 'sha256': sha(after)}})
json.dump(index, open(f'{out}/index.json', 'w'), indent=1)
print(len(index), 'pairs')
