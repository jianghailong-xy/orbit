#!/usr/bin/env python3
"""shot-variants.py: for every screenshot beyond level in the merged tip's comparison (compare-final/*-summary.json),
the variants it took in every run of every round of the second version -- reference or start tree and delivery,
rounds 2, 3 and 5, the merged tip, and the reruns of rerun-odd-final.sh and rerun-enroll-final.sh -- as letters per
distinct SHA-256 (A = the first run's bytes; "-" = a run that does not take that shot). Printed to stdout; reads
only the runs."""
import hashlib
import json
import os

V = '/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2'
SUITES = {
    'final-p42': ['runs-def134095/f-p42-ref', 'runs-def134095/f-p42-del', 'runs-bcc89c7af/f-p42-ref', 'runs-bcc89c7af/f-p42-del',
                  'killed-run-2/f-p42-ref', 'runs/f-p42-ref', 'runs/f-p42-del', 'runs-final/g-p42-del',
                  'runs-final/rerun-p42-enroll-1', 'runs-final/rerun-p42-enroll-2', 'runs-final/rerun-p42-enroll-3'],
    'final-p0': ['runs-def134095/f-p0-ref', 'runs-def134095/f-p0-del', 'runs-bcc89c7af/f-p0-ref', 'runs-bcc89c7af/f-p0-del',
                 'runs/f-p0-ref', 'runs/f-p0-del', 'runs-final/g-p0-del', 'runs-final/rerun-p0-projects-1',
                 'runs-final/rerun-p0-projects-2', 'runs-final/rerun-p0-projects-3'],
    'final-p41': ['runs-def134095/f-p41-base', 'runs-def134095/f-p41-del', 'runs-bcc89c7af/f-p41-base', 'runs-bcc89c7af/f-p41-del',
                  'runs/f-p41-base', 'runs/f-p41-del', 'runs-final/g-p41-del'],
    'final-pilot': ['runs-def134095/pilot-base', 'runs-def134095/pilot-del', 'runs-bcc89c7af/pilot-base', 'runs-bcc89c7af/pilot-del',
                    'runs/pilot-base', 'runs/pilot-del', 'runs-final/g-pilot-del', 'runs-final/rerun-pilot-share-1',
                    'runs-final/rerun-pilot-share-2', 'runs-final/rerun-pilot-share-3'],
}
for suite, runs in SUITES.items():
    beyond = [b['shot'] for b in json.load(open(f'{V}/compare-final/{suite}-summary.json'))['beyond']]
    print(f'== {suite}: ' + ' | '.join(runs))
    for shot in beyond:
        letters, row = {}, []
        for run in runs:
            path = f'{V}/{run}-shots/{shot}'
            if not os.path.exists(path):
                row.append('-')
                continue
            digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
            row.append(letters.setdefault(digest, chr(65 + len(letters))))
        legend = ', '.join(f'{letter}={digest[:12]}' for digest, letter in letters.items())
        print(f'{shot:50} {" ".join(row)}   ({legend})')
