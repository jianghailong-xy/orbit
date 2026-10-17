#!/usr/bin/env python3
"""Usage: merge-check-record.py <full merge-check log> <job id> > merge-check.json

The record of the full merge-check output that stays out of the evidence (p4.1-accepted/checks/merge-check.json's
shape): its header lines, closing line, Vitest's file and test totals, and the log's line count, bytes and SHA-256."""
import hashlib, json, re, sys

path, job = sys.argv[1:3]
raw = open(path, 'rb').read()
lines = [re.sub(r'\x1b\[[0-9;]*m', '', l) for l in raw.decode('utf-8', 'replace').splitlines()]
def totals(label):
    for l in lines:
        m = re.match(rf'^\s*{label}\s+(.*)$', l)
        if m:
            nums = dict((k, int(v)) for v, k in re.findall(r'(\d+) (passed|failed|skipped|todo)', m.group(1)))
            total = re.search(r'\((\d+)\)', m.group(1))
            return {**nums, 'total': int(total.group(1)) if total else None}
    return None
print(json.dumps({
    'command': 'npm run build -w @orbit/web && npm run test -w @orbit/web',
    'job': job,
    'header': [l for l in lines[:6] if l.startswith('# ') and not l.startswith('# finished')],
    'finished': next((l for l in lines if l.startswith('# finished')), None),
    'testFiles': totals('Test Files'),
    'tests': totals('Tests'),
    'fullOutput': {'path': path, 'lines': len(lines), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()},
    'filtered': 'merge-check.txt (filter-merge-check.py from p3.2-accepted/tools, plus the closing lines)',
}, ensure_ascii=False, indent=1))
