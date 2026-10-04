"""Run one check, preserving its argv, source hashes, exit status and original output."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[4]
directory = Path(__file__).resolve().parent / 'checks'
directory.mkdir(exist_ok=True)
name, *command = sys.argv[1:]
record = directory / (name + '.json')
log = directory / (name + '.txt')
if record.exists() or log.exists():
    raise SystemExit('Use a new check name; retained evidence is never overwritten.')
metadata = {'command': command, 'cwd': str(root), 'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()}
metadata['sourceHashes'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
    for directory_path in ['src/web/src/components/ui', 'src/web/ui-migration']
    for p in sorted((root / directory_path).rglob('*')) if p.is_file()}
with log.open('w') as stream:
    result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
metadata.update(exitCode=result.returncode, ended=datetime.datetime.now(datetime.timezone.utc).isoformat())
record.write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({k: v for k, v in metadata.items() if k != 'sourceHashes'}, indent=2))
print(log.read_text()[-6500:])
sys.exit(result.returncode)
