#!/usr/bin/env python3
"""Look for every credential T07's lab window and Docker phase handled, in the files given (the probe's scenes, the
evidence). Prints names and counts, never a value. T06b's scan (docs/evidence/managed-runner-wake-followups/
2026-10-18/kit/secret-scan.py) with T07's directories, plus patterns no credential of these runs should match: a JWT,
an `sk-` key other than fake-model's placeholder, a Bearer header.

  secret-scan.py PATH...
"""
import base64
import gzip
import json
import re
import sys
from pathlib import Path

LAB = Path('/mnt/data/managed-runner-lab')
SERVERS = [LAB / 'test-server-t07', Path('/mnt/data/tmp/t07-34ZtjU1Q/docker')]
PLACEHOLDER = 'sk-lab-fake-model-not-a-key'  # fake-model.py's stand-in key, sent to the fake endpoint only
secrets = {}


def add(name, value):
    if isinstance(value, str) and len(value) >= 8:
        secrets[name] = value


for server in SERVERS:
    for state in sorted((server / 'state').glob('*.json')):
        found = json.loads(state.read_text())
        for key in ('password', 'accessToken', 'refreshToken'):
            add(f'{server.name}/{state.stem}.{key}', found.get(key))
        add(f'{server.name}/{state.stem}.selfhost.token', (found.get('selfhost') or {}).get('token'))
    for path in sorted((server / 'secrets').glob('*')):
        if path.is_file() and path.suffix != '.env':
            add(f'{server.name}/secrets/{path.name}', path.read_text().strip())
    kube = server / 'manager-kubeconfig.json'
    if kube.exists():
        for user in json.loads(kube.read_text()).get('users', []):
            add(f'{server.name}/manager-kubeconfig.token', user['user'].get('token'))
for user in json.loads((LAB / 'kubeconfig.json').read_text()).get('users', []):
    data = user['user'].get('client-key-data')
    if data:
        add('lab-admin.client-key-data', data)
        add('lab-admin.client-key', base64.b64decode(data).decode(errors='replace').strip().splitlines()[1])

PATTERNS = {
    'jwt': re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    'sk-key': re.compile(r'sk-[A-Za-z0-9_-]{16,}'),
    'bearer': re.compile(r'Bearer [A-Za-z0-9._-]{16,}'),
}
files = [p for arg in sys.argv[1:] for p in ([Path(arg)] if Path(arg).is_file() else Path(arg).rglob('*')) if p.is_file()]
hits, patterns, placeholder = {}, {}, 0
for path in files:
    raw = path.read_bytes()
    try:
        text = (gzip.decompress(raw) if path.suffix == '.gz' else raw).decode(errors='replace')
    except OSError:
        text = raw.decode(errors='replace')
    for name, value in secrets.items():
        if value in text:
            hits.setdefault(name, []).append(str(path))
    placeholder += text.count(PLACEHOLDER)
    for name, pattern in PATTERNS.items():
        found = [m for m in pattern.findall(text) if m != PLACEHOLDER]
        if found:
            patterns.setdefault(name, []).append(f'{path} ({len(found)})')
print(json.dumps({'filesScanned': len(files), 'credentialsLookedFor': len(secrets),
                  'kinds': sorted({n.split('/')[-1].split('.')[-1] for n in secrets}), 'found': hits,
                  'patterns': patterns, 'fakeModelPlaceholderOccurrences': placeholder}, indent=1))
