#!/usr/bin/env python3
"""Usage: collect-runs.py <evidence dir> <run label>...
Copies the record of each run under /var/tmp/p0d3/runs into <evidence dir>/attribution/runs/<label>/ (as
p0-drift-2/tools/collect-runs.py, slimmed to the project's evidence-volume rule of 2026-10-07): meta.json
(tree commit, runner commit, argv, start/end, exit, environment check, stats), summary.json (tests and failures,
summarize-report.py), snapshots.sha256 (every screenshot's SHA-256), output.txt.gz, report.summary.json (the
Playwright report without attachment bodies, report-summary.py) and profile-requests.json (the profile tests'
captures, requests, unhandled requests and page errors, profile-requests.py). The environment record is kept once
per distinct content (environments/<sha256>.json). Screenshots, raw per-test JSON and full reports stay in
/var/tmp/p0d3/runs until the evidence is decided."""
import glob, gzip, hashlib, json, os, shutil, subprocess, sys
S = '/var/tmp/p0d3/scripts'
ev, labels = sys.argv[1], sys.argv[2:]
for label in labels:
    src, dst = f'/var/tmp/p0d3/runs/{label}', f'{ev}/attribution/runs/{label}'
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
    summary = subprocess.check_output(['python3', f'{S}/summarize-report.py', f'{src}/output/report.json'], text=True)
    s = json.loads(summary); s.pop('tests', None)
    json.dump(s, open(f'{dst}/summary.json', 'w'), indent=1); open(f'{dst}/summary.json', 'a').write('\n')
    with open(f'{src}/output.txt', 'rb') as f, gzip.GzipFile(f'{dst}/output.txt.gz', 'wb', mtime=0) as g: g.write(f.read())
    subprocess.check_call(['python3', f'{S}/report-summary.py', f'{src}/output/report.json', f'{dst}/report.summary.json'], stdout=subprocess.DEVNULL)
    subprocess.check_call(['python3', f'{S}/profile-requests.py', f'{dst}/profile-requests.json',
                           *sorted(glob.glob(f'{src}/output/pages.browser.mjs-profile-*/evidence.json'))], stdout=subprocess.DEVNULL)
    print(label, meta['commit'][:9], meta['exit'], digest[:12])
