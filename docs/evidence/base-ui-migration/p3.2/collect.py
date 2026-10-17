#!/usr/bin/env python3
"""Copy a finished run's direct evidence into this directory: usage collect.py <name> <run output dir> [<screenshot dir>]

Writes <name>/report.json (the Playwright JSON report), every JSON attachment the run recorded
(traces, computed styles and timings) under <name>/attachments/, the run's screenshot set (if given)
under <name>/screenshots/, and <name>/manifest.json with each copied file's SHA-256. Refuses an
existing <name>. Images are copied byte for byte; nothing is resized or edited."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
name, run, *shots = sys.argv[1:]
target = here / name
if target.exists():
    raise SystemExit(f'{target} exists; retained evidence is never overwritten.')
run = Path(run)
copied = {}


def copy(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied[str(destination.relative_to(target))] = hashlib.sha256(destination.read_bytes()).hexdigest()


copy(run / 'report.json', target / 'report.json')
for attachment in sorted(run.rglob('*.json')):
    if attachment.name == 'report.json' and attachment.parent == run:
        continue
    copy(attachment, target / 'attachments' / attachment.relative_to(run))
if shots:
    for image in sorted(Path(shots[0]).rglob('*.png')):
        copy(image, target / 'screenshots' / image.relative_to(shots[0]))
(target / 'manifest.json').write_text(json.dumps({'run': str(run), 'screenshots': shots[0] if shots else None, 'files': copied}, indent=1) + '\n')
print(json.dumps({'name': name, 'files': len(copied)}))
