"""Run one check, preserving its argv, source hashes, exit status and original output.

As p3.1/run-check.py. ROOT=<checkout> runs the command in another checkout of this repository (the
same-commit reference tree); the record then names that tree's HEAD and hashes that tree's sources.
Usage: python3 run-check.py <new check name> <command...>"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

here = Path(__file__).resolve().parent
root = Path(os.environ.get('ROOT') or here.parents[3]).resolve()
directory = here / 'checks'
directory.mkdir(exist_ok=True)
name, *command = sys.argv[1:]
record = directory / (name + '.json')
log = directory / (name + '.txt')
if record.exists() or log.exists():
    raise SystemExit('Use a new check name; retained evidence is never overwritten.')
sources = ['src/web/src/components/ui', 'src/web/ui-migration']
files = ['src/web/src/index.css', 'src/web/src/components/TaskDetailPanel.tsx', 'src/web/src/components/ShareModal.tsx',
         'src/web/src/components/TaskInputs.tsx', 'src/web/src/components/AccountSelect.tsx', 'src/web/package.json', 'package-lock.json']
metadata = {'command': command, 'cwd': str(root), 'env': {k: v for k, v in os.environ.items() if k.startswith('P32_')},
            'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'dirty': subprocess.check_output(['git', 'status', '--porcelain', '--', 'src/web', 'package-lock.json'], cwd=root, text=True).splitlines()}
metadata['sourceHashes'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
    for p in sorted([*(q for d in sources for q in (root / d).rglob('*') if q.is_file()), *(root / f for f in files if (root / f).exists())])}
with log.open('w') as stream:
    result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
metadata.update(exitCode=result.returncode, ended=datetime.datetime.now(datetime.timezone.utc).isoformat())
record.write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({k: v for k, v in metadata.items() if k != 'sourceHashes'}, indent=2))
print(log.read_text()[-6500:])
sys.exit(result.returncode)
