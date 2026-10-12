#!/usr/bin/env python3
"""Usage: collect-runs.py <evidence dir> <run label>...
Copies the record of each run under /var/tmp/p0d2/runs into <evidence dir>/attribution/runs/<label>/: meta.json
(tree commit, runner commit, argv, start/end, exit, environment check, stats), summary.json (tests and failures,
summarize-report.py), snapshots.sha256 (every screenshot's SHA-256), output.txt.gz and report.json.gz; the
environment record is kept once per distinct content (environments/<sha256>.json)."""
import gzip, hashlib, json, os, shutil, subprocess, sys
ev, labels = sys.argv[1], sys.argv[2:]
for label in labels:
    src, dst = f'/var/tmp/p0d2/runs/{label}', f'{ev}/attribution/runs/{label}'
    os.makedirs(dst, exist_ok=True)
    meta = json.load(open(f'{src}/meta.json'))
    assert 'exit' in meta, f'{label} did not finish'
    env = open(f'{src}/environment.json', 'rb').read()
    digest = hashlib.sha256(env).hexdigest()
    os.makedirs(f'{ev}/attribution/environments', exist_ok=True)
    open(f'{ev}/attribution/environments/{digest}.json', 'wb').write(env)
    meta['environmentSha256'] = digest
    json.dump(meta, open(f'{dst}/meta.json', 'w'), indent=1); open(f'{dst}/meta.json', 'a').write('\n')
    shutil.copyfile(f'{src}/snapshots.sha256', f'{dst}/snapshots.sha256')
    summary = subprocess.check_output(['python3', '/var/tmp/p0d2/scripts/summarize-report.py', f'{src}/output/report.json'], text=True)
    s = json.loads(summary); s.pop('tests', None)
    json.dump(s, open(f'{dst}/summary.json', 'w'), indent=1); open(f'{dst}/summary.json', 'a').write('\n')
    for name, path in (('output.txt.gz', f'{src}/output.txt'), ('report.json.gz', f'{src}/output/report.json')):
        with open(path, 'rb') as f, gzip.GzipFile(f'{dst}/{name}', 'wb', mtime=0) as g: g.write(f.read())
    print(label, meta['commit'][:9], meta['exit'], digest[:12])
