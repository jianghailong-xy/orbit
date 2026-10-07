# Files and directories that Markdown documents reference individually.
# Usage: python3 -I links.py <ls-tree listing> <out.json>
# A reference is a Markdown link target, or a backticked token, that resolves (relative to the document's
# directory, the evidence root or the repository root) to a file or directory of the listed tree.
import json, os, posixpath, re, subprocess, sys
from urllib.parse import unquote

P = 'docs/evidence/base-ui-migration/'
listing, out = sys.argv[1], sys.argv[2]
files = {}
for line in open(listing):
    meta, path = line.rstrip('\n').split('\t', 1)
    files[path] = int(meta.split()[3])
dirs = set()
for p in files:
    d = posixpath.dirname(p)
    while d and d not in dirs:
        dirs.add(d); d = posixpath.dirname(d)

LINK = re.compile(r'\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
TICK = re.compile(r'`([^`\s]+)`')


def resolve(doc, target):
    target = unquote(target.split('#', 1)[0].split('?', 1)[0])
    if not target or re.match(r'^[a-z][a-z0-9+.-]*:', target):
        return None
    bases = [posixpath.dirname(doc), P.rstrip('/'), '']
    for base in bases:
        p = posixpath.normpath(posixpath.join(base, target)) if not target.startswith('/') else posixpath.normpath(target.lstrip('/'))
        if p in files:
            return ('file', p)
        if p in dirs:
            return ('dir', p)
    return None


# every Markdown file of the repository, so links from outside the evidence directory are covered too
repo_md = subprocess.run(['git', 'ls-files', '*.md'], capture_output=True, text=True, check=True).stdout.split('\n')
refs = []
for doc in [d for d in repo_md if d]:
    try:
        text = open(doc, encoding='utf-8', errors='replace').read()
    except FileNotFoundError:
        continue
    for kind, rx in (('link', LINK), ('tick', TICK)):
        for m in rx.finditer(text):
            r = resolve(doc, m.group(1))
            if r and r[1].startswith(P.rstrip('/')):
                refs.append({'doc': doc, 'via': kind, 'type': r[0], 'target': r[1]})
json.dump(refs, open(out, 'w'), indent=1)
fl = {r['target'] for r in refs if r['type'] == 'file'}
print('references', len(refs), 'distinct files', len(fl), 'bytes', sum(files[f] for f in fl),
      'distinct dirs', len({r['target'] for r in refs if r['type'] == 'dir'}))
