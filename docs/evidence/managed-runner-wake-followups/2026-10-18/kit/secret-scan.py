#!/usr/bin/env python3
"""Look for every credential the T06b lab and its checks handled in the evidence directory. Prints names
and counts, never a value.

T06's scan (docs/evidence/managed-runner-wake-lab/2026-10-18/kit/secret-scan.py) less the managed runners'
bootstrap credentials, which only the lab's Secrets hold and the VM was off when this ran (no tool here
prints one), plus the real self-managed runner's token and the Docker integration test's channel token.

Usage: secret-scan.py EVIDENCE_DIR SERVER_DIR SELFHOST_DIR [IT_WORK_DIR]
"""
import base64
import gzip
import json
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
server = Path(sys.argv[2])
selfhost = Path(sys.argv[3])
it_work = Path(sys.argv[4]) if len(sys.argv) > 4 else None
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
config = selfhost / 'orbit-home' / 'config.json'
if config.exists():
    add('selfhost.runnerToken', json.loads(config.read_text()).get('runnerToken'))
if it_work:
    for token in it_work.rglob('*token'):
        if token.is_file():
            add(f'it.{token.parent.name}.token', token.read_text().strip())

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
