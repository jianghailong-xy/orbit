"""Index every r8 archive file by SHA-256, or (--verify <commit>) re-read each one from that commit's Git objects."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
INDEX = HERE / 'artifact-index.json'


def files():
    found = [p for p in HERE.rglob('*') if p.is_file() and p != INDEX]
    found += sorted((HERE.parent / 'checks').glob('r8-*'))
    return sorted(str(p.relative_to(ROOT)) for p in found)


if len(sys.argv) == 3 and sys.argv[1] == '--verify':
    index = json.loads(INDEX.read_text())
    bad = []
    for path, entry in index['files'].items():
        blob = subprocess.run(['git', 'cat-file', 'blob', f'{sys.argv[2]}:{path}'], cwd=ROOT, capture_output=True).stdout
        if hashlib.sha256(blob).hexdigest() != entry['sha256'] or len(blob) != entry['bytes']:
            bad.append(path)
    print(json.dumps({'commit': sys.argv[2], 'files': len(index['files']), 'mismatched': bad}, indent=1))
    sys.exit(1 if bad else 0)

entries = {}
for path in files():
    data = (ROOT / path).read_bytes()
    entries[path] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
INDEX.write_text(json.dumps({'files': entries}, indent=1) + '\n')
print(json.dumps({'files': len(entries), 'bytes': sum(e['bytes'] for e in entries.values())}))
