#!/usr/bin/env python3
"""Look for every credential the T06 lab handled in the evidence directory. Prints names and counts, never a value.

T05's scan (docs/evidence/managed-runner-login-lab/2026-10-18/kit/secret-scan.py) plus the self-managed runner's token
and every managed runner's bootstrap credential, read from the lab's own Secrets.

Usage: secret-scan.py EVIDENCE_DIR SERVER_DIR
"""
import base64
import gzip
import json
import subprocess
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
server = Path(sys.argv[2])
lab = Path('/mnt/data/managed-runner-lab')
secrets = {}


def add(name, value):
    if isinstance(value, str) and len(value) >= 8:
        secrets[name] = value


for state in sorted((server / 'state').glob('*.json')):
    found = json.loads(state.read_text())
    for key in ('password', 'accessToken', 'refreshToken'):
        add(f'{state.stem}.{key}', found.get(key))
    add(f'{state.stem}.selfhost.token', (found.get('selfhost') or {}).get('token'))
for name in ('pg-password', 'jwt-secret', 'provider-secret-key', 'admission-webhook-token'):
    path = server / 'secrets' / name
    if path.exists():
        add(f'secrets/{name}', path.read_text().strip())
for user in json.loads((server / 'manager-kubeconfig.json').read_text()).get('users', []):
    add('manager-kubeconfig.token', user['user'].get('token'))
for user in json.loads((lab / 'kubeconfig.json').read_text()).get('users', []):
    data = user['user'].get('client-key-data')
    if data:
        add('lab-admin.client-key-data', data)
        add('lab-admin.client-key', base64.b64decode(data).decode(errors='replace').strip().splitlines()[1])
# The managed runners' bootstrap credentials, as the manager wrote them into the lab's Secrets.
kubectl = [str(lab / 'bin/kubectl'), '--kubeconfig', str(lab / 'kubeconfig.json'), '--context', 'orbit-mr-lab', '--namespace', 'orbit-mr-test']
listed = json.loads(subprocess.run([*kubectl, 'get', 'secrets', '-o', 'json'], capture_output=True, text=True, check=True).stdout)
for item in listed['items']:
    if item['metadata']['name'].startswith('mr-boot-'):
        for key, value in (item.get('data') or {}).items():
            add(f"{item['metadata']['name']}.{key}", base64.b64decode(value).decode(errors='replace'))

files = [p for p in evidence.rglob('*') if p.is_file()]
hits = {}
for path in files:
    raw = path.read_bytes()
    text = (gzip.decompress(raw) if path.suffix == '.gz' else raw).decode(errors='replace')
    for name, value in secrets.items():
        if value in text:
            hits.setdefault(name, []).append(str(path.relative_to(evidence)))
print(json.dumps({'filesScanned': len(files), 'credentialsLookedFor': len(secrets),
                  'kinds': sorted({n.split('/')[-1].split('.')[-1] for n in secrets}), 'found': hits}, indent=1))
sys.exit(1 if hits else 0)
