"""Read-only content snapshot; matches the initial snapshot's format. Does not follow symlinks."""
import gzip
import hashlib
import json
import os
import pathlib
import sys

base = pathlib.Path('/root/orbit')
out = pathlib.Path(__file__).parent
rows = []
for rel in ['node_modules', 'src/apiserver/node_modules', 'src/web/node_modules',
            'src/shared/node_modules', 'src/shared/dist']:
    path = base / rel
    if not path.exists():
        rows.append([rel, 'absent'])
        continue
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in sorted(dirs + files):
            file = pathlib.Path(root) / name
            key = str(file.relative_to(base))
            stat = file.lstat()
            if file.is_symlink():
                rows.append([key, 'link', os.readlink(file)])
            elif file.is_file():
                with file.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                rows.append([key, 'file', stat.st_size, digest])
rows.sort()
data = json.dumps(rows, separators=(',', ':')).encode()
label = sys.argv[1]
with gzip.open(out / ('main-install-' + label + '.json.gz'), 'wb') as stream:
    stream.write(data)
summary = {'entries': len(rows), 'sha256': hashlib.sha256(data).hexdigest()}
if label != 'before':
    before = json.loads(gzip.decompress((out / 'main-install-before.json.gz').read_bytes()))
    old = {r[0]: r for r in before}
    new = {r[0]: r for r in rows}
    summary['changes'] = [p for p in sorted(old.keys() | new.keys()) if old.get(p) != new.get(p)]
    summary['unchanged'] = not summary['changes']
(out / ('main-install-' + label + '.summary.json')).write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
if summary.get('unchanged') is False:
    sys.exit(1)
