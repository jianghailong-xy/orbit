"""Archive a finished pilot run: usage collect-pilot.py <name> <run output dir> <screenshot dir>

As ../p3.2/collect.py (which writes into its own directory): <name>/report.json, every JSON attachment the run
recorded (traces, computed styles and timings), packed as P3.2 kept them into <name>/attachments.tar.gz (sorted,
fixed mtime and owner), and <name>/manifest.json with each file's SHA-256, the packed ones included. Unlike it,
the manifest lists the SHA-256 of every screenshot the run wrote, and only the screenshots that are not
byte-identical in one of the fix-pilot-*.json comparisons are copied (under <name>/screenshots/); the others are
identified by their hash. Refuses an existing <name>; nothing is edited."""
import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path

here = Path(__file__).resolve().parent
name, run, shots = sys.argv[1:]
target = here / name
if target.exists():
    raise SystemExit(f'{target} exists; retained evidence is never overwritten.')
run, shots = Path(run), Path(shots)
differing = {shot for path in here.glob('fix-pilot-*.json') if path.name != 'fix-pilot-summary.json'
             for shot, result in json.loads(path.read_text())['screenshots'].items() if not result.get('equal')}
copied, screenshots = {}, {}


def copy(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied[str(destination.relative_to(target))] = hashlib.sha256(destination.read_bytes()).hexdigest()


copy(run / 'report.json', target / 'report.json')
for attachment in sorted(run.rglob('*.json')):
    if attachment.name != 'report.json':
        copy(attachment, target / 'attachments' / attachment.relative_to(run))
with tarfile.open(target / 'attachments.tar.gz', 'w:gz', compresslevel=9) as archive:
    for path in sorted((target / 'attachments').rglob('*')):
        info = archive.gettarinfo(str(path), str(path.relative_to(target)))
        info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, '', ''
        archive.addfile(info, path.open('rb') if path.is_file() else None)
shutil.rmtree(target / 'attachments')
copied['attachments.tar.gz'] = hashlib.sha256((target / 'attachments.tar.gz').read_bytes()).hexdigest()
for shot in sorted(shots.rglob('*.png')):
    key = str(shot.relative_to(shots))
    screenshots[key] = hashlib.sha256(shot.read_bytes()).hexdigest()
    if key in differing:
        copy(shot, target / 'screenshots' / key)
(target / 'manifest.json').write_text(json.dumps({'run': str(run), 'screenshots': str(shots), 'files': copied,
                                                  'allScreenshots': screenshots}, indent=1) + '\n')
print(name, len(copied), 'files,', len(screenshots), 'screenshots,', sum(k.startswith('screenshots/') for k in copied), 'copied')
