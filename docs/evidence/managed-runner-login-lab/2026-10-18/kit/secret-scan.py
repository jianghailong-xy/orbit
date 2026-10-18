#!/usr/bin/env python3
"""Look for every credential the T05 lab handled in the evidence directory. Prints names and counts, never a value.

Usage: secret-scan.py EVIDENCE_DIR SERVER_DIR...
"""
import base64
import gzip
import json
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
servers = [Path(p) for p in sys.argv[2:]]
secrets = {}


def add(name, value):
    if isinstance(value, str) and len(value) >= 8:
        secrets[name] = value


for server in servers:
    tag = server.name
    for state in sorted((server / 'state').glob('*.json')):
        found = json.loads(state.read_text())
        for key in ('password', 'accessToken', 'refreshToken'):
            add(f'{tag}/{state.stem}.{key}', found.get(key))
        add(f'{tag}/{state.stem}.ownRunner.token', (found.get('ownRunner') or {}).get('token'))
    for name in ('pg-password', 'jwt-secret', 'provider-secret-key', 'admission-webhook-token'):
        path = server / 'secrets' / name
        if path.exists():
            add(f'{tag}/secrets/{name}', path.read_text().strip())
    kubeconfig = server / 'manager-kubeconfig.json'
    if kubeconfig.exists():
        for user in json.loads(kubeconfig.read_text()).get('users', []):
            add(f'{tag}/manager-kubeconfig.token', user['user'].get('token'))
admin = Path('/mnt/data/managed-runner-lab/kubeconfig.json')
for user in json.loads(admin.read_text()).get('users', []):
    data = user['user'].get('client-key-data')
    if data:
        add('lab-admin.client-key-data', data)
        add('lab-admin.client-key', base64.b64decode(data).decode(errors='replace').strip().splitlines()[1])

files = [p for p in evidence.rglob('*') if p.is_file()]
hits = {}
for path in files:
    raw = path.read_bytes()
    text = (gzip.decompress(raw) if path.suffix == '.gz' else raw).decode(errors='replace')
    for name, value in secrets.items():
        if value in text:
            hits.setdefault(name, []).append(str(path.relative_to(evidence)))
print(json.dumps({'filesScanned': len(files), 'credentialsLookedFor': len(secrets), 'kinds': sorted({n.split('/')[-1].split('.')[-1] for n in secrets}),
                  'found': hits}, indent=1))
sys.exit(1 if hits else 0)
