#!/usr/bin/env python3
"""T07's Docker-backend test server on the HPC host's own Docker (as D2's integration test runs it), for the
states only the Docker backend has -- a host at its cap on runner containers (CONTAINER_LIMIT) and a data
volume restored by the runbook (PVC_RESTORED) -- and a volume held by another container (VOLUME_IN_USE), each
shown live in the web and recorded for the native apps.

Everything is labelled orbit.test=t07-docker and removed by `down`. The apiserver of this checkout listens on
127.0.0.1 only; the runner containers sit on an internal network with inter-container traffic off and reach it,
and this phase's own fake-model.py, through two relays bound to that network's gateway address, which only that
bridge reaches. The restricted channel (deploy/managed-runner/docker-channel) alone holds the Docker socket. The
image is T06b's product image (deploy/managed-runner/image at ebf54ab8d; runner-go unchanged since), loaded, not
rebuilt, and never pushed. Nothing here touches a production server. Prints JSON; never a credential.

  up | down | status
  account NAME [--no-signin]    the first is the bootstrap admin; the others opened by it, then signed in
  key NAME                      a DeepSeek-preset key whose endpoint is this phase's fake-model.py
  until NAME STATE [--reason R] [--timeout S]
  hold NAME | release NAME      a 30-minute fake turn keeps NAME's runner busy | interrupt it and sleep
  volume NAME                   NAME's data volume and every container referring to it
  holder NAME on|off            another container referring to NAME's volume (VOLUME_IN_USE)
  backup NAME | remove NAME | restore NAME
                                the runbook (scripts/managed-runner/volume-backup.sh) on NAME's volume, and its removal
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

REPO = Path(os.environ.get('T07_WT', '/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40'))
D = Path(os.environ.get('LAB_TEST_SERVER_DIR', '/mnt/data/tmp/t07-34ZtjU1Q/docker'))
LABEL = 'orbit.test=t07-docker'
INSTANCE = 't07dock'
NETWORK = 'orbit-mr-t07dock'
PG = 't07-docker-pg'
PG_PORT = 15434
API_PORT = 13730
FAKE_PORT = 13742
IMAGE_ARCHIVE = Path('/mnt/data/tmp/34hpKqWRaAJbUXoikQ3U4/image/product.oci.tar')
IMAGE_TAG = 'orbit-managed-runner:t07'
UNITS = ('t07-docker-api', 't07-docker-channel', 't07-docker-fake', 't07-docker-relay-api', 't07-docker-relay-fake')


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def out(value):
    print(json.dumps(value, indent=2, sort_keys=True), flush=True)


def run(*args, check=True, capture=True, **kw):
    result = subprocess.run([str(a) for a in args], capture_output=capture, text=True, **kw)
    if check and result.returncode:
        raise SystemExit(f'{args[0]} {args[1] if len(args) > 1 else ""} failed: {(result.stderr or result.stdout).strip()[-1500:]}')
    return result


def docker(*args, check=True):
    return run('docker', *args, check=check)


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix('.tmp')
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.write(value if isinstance(value, str) else json.dumps(value, indent=2))
    os.replace(tmp, path)


def http(method, path, body=None, token=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{API_PORT}/api{path}', data=data, method=method,
                                 headers={'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode('utf-8', 'replace')


def state(name):
    p = D / 'state' / f'{name}.json'
    return json.loads(p.read_text()) if p.exists() else {}


def save(name, value):
    private_write(D / 'state' / f'{name}.json', value)


def unit(name, mem, *command, env=()):
    if run('systemctl', 'is-active', name, check=False).stdout.strip() == 'active':
        return
    props = ['-p', f'MemoryMax={mem}', '-p', 'OOMScoreAdjust=900', '-p', f'StandardOutput=append:{D}/logs/{name}.log',
             '-p', f'StandardError=append:{D}/logs/{name}.log', '-p', f'WorkingDirectory={D}']
    for e in env:
        props += ['-p', f'Environment={e}']
    run('systemd-run', f'--unit={name}', '--collect', '--quiet', *props, *command)


def gateway():
    return docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}', NETWORK).stdout.strip()


def cmd_up(_args):
    for sub in ('secrets', 'logs', 'state', 'channel-state', 'home'):
        (D / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(D, 0o700)
    for name in ('pg-password', 'jwt-secret', 'provider-secret-key', 'channel-token'):
        if not (D / 'secrets' / name).exists():
            private_write(D / 'secrets' / name, secrets.token_urlsafe(32))
    # The image: T06b's product image archive (an OCI layout), loaded under this phase's tag.
    if docker('image', 'inspect', IMAGE_TAG, check=False).returncode:
        loaded = docker('load', '-i', str(IMAGE_ARCHIVE)).stdout.strip()
        ref = loaded.split('Loaded image: ')[-1].split('Loaded image ID: ')[-1].strip().splitlines()[-1]
        docker('tag', ref, IMAGE_TAG)
    image = docker('image', 'inspect', '-f', '{{.Id}}', IMAGE_TAG).stdout.strip()
    revision = docker('image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', IMAGE_TAG).stdout.strip()
    # PostgreSQL on tmpfs, loopback only, migrated by this checkout's Prisma.
    pw = (D / 'secrets/pg-password').read_text()
    if docker('inspect', PG, check=False).returncode:
        docker('run', '-d', '--name', PG, '--label', LABEL, '--memory', '768m', '-e', 'POSTGRES_USER=orbit', '-e', 'POSTGRES_DB=orbit',
               '-e', f'POSTGRES_PASSWORD={pw}', '-e', 'PGDATA=/pgdata', '--tmpfs', '/pgdata:size=1g', '-p', f'127.0.0.1:{PG_PORT}:5432',
               'postgres:16-alpine')
    for _ in range(90):
        if docker('exec', PG, 'pg_isready', '-q', '-U', 'orbit', '-h', '127.0.0.1', check=False).returncode == 0:
            break
        time.sleep(1)
    url = f'postgresql://orbit:{pw}@127.0.0.1:{PG_PORT}/orbit'
    prisma = REPO / 'node_modules/.bin/prisma'
    run(prisma, 'migrate', 'deploy', cwd=REPO / 'src/apiserver', env={**os.environ, 'DATABASE_URL': url})
    # The runners' network: internal, no inter-container traffic.
    if docker('network', 'inspect', NETWORK, check=False).returncode:
        docker('network', 'create', '--internal', '--label', LABEL, '-o', 'com.docker.network.bridge.enable_icc=false', NETWORK)
    gw = gateway()
    # The channel: one container at most, below the profile's budget of two (CONTAINER_LIMIT).
    channel = {
        'schemaVersion': 1, 'instanceId': INSTANCE, 'listen': {'unixSocket': str(D / 'channel.sock')},
        'tokenFile': str(D / 'secrets/channel-token'), 'dockerSocket': '/var/run/docker.sock', 'stateDir': str(D / 'channel-state'),
        'image': image, 'network': NETWORK,
        'limits': {'maxCpuMillis': 2000, 'maxMemoryBytes': 2 * 2 ** 30, 'maxPids': 2048, 'maxTmpBytes': 2 ** 30,
                   'maxVolumeBytes': 10 * 2 ** 30, 'maxConcurrent': 4, 'maxContainers': 1},
        'stopGraceSeconds': 60, 'diskCheckSeconds': 30, 'extraLabels': {'orbit.test': 't07-docker'},
    }
    private_write(D / 'channel.json', channel)
    run(sys.executable, '-I', REPO / 'deploy/managed-runner/docker-channel/channel.py', 'check-config', '--config', D / 'channel.json')
    unit('t07-docker-channel', '256M', sys.executable, '-I', str(REPO / 'deploy/managed-runner/docker-channel/channel.py'), 'serve',
         '--config', str(D / 'channel.json'))
    profile = {
        'schemaVersion': 1, 'valueKind': 'actual', 'backend': 'docker', 'environmentId': 'orbit-mr-t07-docker', 'clusterKey': 't07-docker',
        'resourceProfileId': 'orbit-mr-t07-docker',
        'docker': {'instanceId': INSTANCE, 'channel': {'socketPath': str(D / 'channel.sock')}, 'tokenFile': str(D / 'secrets/channel-token')},
        'storage': {'capacity': '2Gi'},
        'runner': {'image': image, 'serverUrl': f'http://{gw}:{API_PORT}', 'maxConcurrent': 2, 'tmpSizeLimit': '256Mi',
                   'resources': {'cpu': '1', 'memory': '1Gi', 'pids': 1024}},
        'capacity': {'compute': {'cpu': '4', 'memory': '4Gi', 'ephemeralStorage': '4Gi', 'pods': 2, 'attachments': 2},
                     'storage': {'usable': '20Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2},
        'lifecycle': {'maxAttempts': 5, 'backoffBaseSeconds': 5, 'backoffMaxSeconds': 60, 'startupDeadlineSeconds': 900,
                      'requestTimeoutSeconds': 30, 'leaseSeconds': 60, 'pollIntervalSeconds': 5, 'heartbeatFreshSeconds': 120,
                      'idleSeconds': 60, 'capacityRetrySeconds': 30, 'drainSeconds': 300},
    }
    private_write(D / 'managed-runner-profile.json', profile)
    env = [f'DATABASE_URL={url}', f"JWT_SECRET={(D / 'secrets/jwt-secret').read_text()}",
           f"PROVIDER_SECRET_KEY={(D / 'secrets/provider-secret-key').read_text()}", f'PORT={API_PORT}',
           f'PUBLIC_ORIGIN=http://127.0.0.1:{API_PORT}', f'CORS_ORIGINS=http://127.0.0.1:{API_PORT}',
           'MODEL_CATALOG_URL=http://127.0.0.1:9/models.json', 'ORBIT_RECAP_ENABLED=0', f'HOME={D}/home', 'NODE_ENV=production',
           'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'ORBIT_MANAGED_RUNNERS_ENABLED=true',
           f'ORBIT_MANAGED_RUNNERS_PROFILE={D}/managed-runner-profile.json']
    private_write(D / 'secrets/api.env', '\n'.join(env) + '\n')
    if run('systemctl', 'is-active', 't07-docker-api', check=False).stdout.strip() != 'active':
        run('systemd-run', '--unit=t07-docker-api', '--collect', '--quiet', '-p', 'MemoryMax=1536M', '-p', 'OOMScoreAdjust=900',
            '-p', f'EnvironmentFile={D}/secrets/api.env', '-p', f'WorkingDirectory={D}/home',
            '-p', f'StandardOutput=append:{D}/logs/apiserver.log', '-p', f'StandardError=append:{D}/logs/apiserver.log',
            '/usr/local/bin/node', '--require', str(REPO / 'src/android/scripts/a11-stack/loopback-only.cjs'), str(REPO / 'src/apiserver/dist/main.js'))
    unit('t07-docker-fake', '128M', '/usr/bin/python3', '-I', str(REPO / 'scripts/managed-runner/lab/fake-model.py'), str(FAKE_PORT),
         str(D / 'logs/fake-model.jsonl'))
    # The containers' only ways out: the apiserver and the fake model, on the bridge's own address.
    unit('t07-docker-relay-api', '64M', '/usr/bin/socat', f'TCP-LISTEN:{API_PORT},bind={gw},reuseaddr,fork', f'TCP:127.0.0.1:{API_PORT}')
    unit('t07-docker-relay-fake', '64M', '/usr/bin/socat', f'TCP-LISTEN:{FAKE_PORT},bind={gw},reuseaddr,fork', f'TCP:127.0.0.1:{FAKE_PORT}')
    for _ in range(120):
        try:
            if http('GET', '/health')[0] == 200:
                break
        except OSError:  # not listening yet
            pass
        time.sleep(2)
    out({'at': now(), 'image': image, 'revision': revision, 'network': NETWORK, 'gateway': gw, 'units': cmd_units(),
         'listening': listening(), 'profile': str(D / 'managed-runner-profile.json')})


def listening():
    lines = run('ss', '-Hltn').stdout.splitlines()
    ports = (str(API_PORT), str(FAKE_PORT), str(PG_PORT))
    return sorted({line.split()[3] for line in lines if line.split()[3].rsplit(':', 1)[-1] in ports})


def cmd_units():
    return {u: run('systemctl', 'is-active', u, check=False).stdout.strip() for u in UNITS}


def inventory():
    return {'containers': docker('ps', '-a', '--filter', f'label={LABEL}', '--format', '{{.Names}}\t{{.Status}}').stdout.splitlines(),
            'volumes': docker('volume', 'ls', '--filter', f'label={LABEL}', '--format', '{{.Name}}').stdout.splitlines()}


def cmd_status(_args):
    out({'at': now(), 'units': cmd_units(), 'listening': listening(), 'docker': inventory()})


def cmd_down(_args):
    for u in UNITS:
        run('systemctl', 'stop', u, check=False)
    before = inventory()
    containers = docker('ps', '-aq', '--filter', f'label={LABEL}').stdout.split()
    if containers:
        docker('rm', '-f', '-v', *containers, check=False)
    volumes = docker('volume', 'ls', '-q', '--filter', f'label={LABEL}').stdout.split()
    if volumes:
        docker('volume', 'rm', *volumes, check=False)
    docker('network', 'rm', NETWORK, check=False)
    out({'at': now(), 'removed': before, 'left': inventory()})


def admin():
    return next((state(p.stem) for p in sorted((D / 'state').glob('*.json')) if state(p.stem).get('admin')), None)


def cmd_account(args):
    found = state(args.name)
    if not found:
        found = {'email': f't07-{args.name}@lab.invalid', 'password': uuid.uuid4().hex}
        boss = admin()
        if boss is None:
            code, answer = http('POST', '/auth/bootstrap', {**found, 'name': f'T07 docker {args.name}'})
            if code not in (200, 201):
                raise SystemExit(f'bootstrap: {code} {answer}')
            found.update(admin=True, accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
            save(args.name, found)
            out({'at': now(), 'owner': args.name, 'admin': True})
            return
        code, answer = http('POST', '/admin/users', {**found, 'name': f'T07 docker {args.name}'}, token=boss['accessToken'])
        if code not in (200, 201):
            raise SystemExit(f'admin/users: {code} {answer}')
        found['user'] = answer.get('user', answer)
        save(args.name, found)
        if args.no_signin:
            out({'at': now(), 'owner': args.name, 'created': True, 'signedIn': False})
            return
    code, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    if code not in (200, 201):
        raise SystemExit(f'sign-in: {code} {answer}')
    found.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    save(args.name, found)
    out({'at': now(), 'owner': args.name, 'signedIn': True})


def token(name):
    found = state(name)
    if not found.get('accessToken'):
        raise SystemExit(f'{name} has not signed in here (account {name})')
    code, _ = http('GET', '/users/me', token=found['accessToken'])
    if code == 401:
        code, answer = http('POST', '/auth/refresh', {'refreshToken': found['refreshToken']})
        if code not in (200, 201):
            raise SystemExit(f'refresh {name}: {code}')
        found.update(accessToken=answer['accessToken'], refreshToken=answer.get('refreshToken', found['refreshToken']))
        save(name, found)
    return found['accessToken']


def cmd_key(args):
    body = {'label': 'FAKE model (lab, not a model)', 'presetSlug': 'deepseek', 'baseUrl': f'http://{gateway()}:{FAKE_PORT}/anthropic',
            'apiKey': 'sk-lab-fake-model-not-a-key'}
    code, answer = http('POST', '/providers/mine', body, token=token(args.name))
    if code not in (200, 201):
        raise SystemExit(f'providers/mine: {code}')
    out({'at': now(), 'owner': args.name, **{k: answer.get(k) for k in ('slug', 'defaultModel', 'baseUrl')}})


def status_of(name):
    return http('GET', '/managed-runner', token=token(name))[1]


def cmd_until(args):
    deadline, seen = time.monotonic() + args.timeout, []
    while True:
        s = status_of(args.name)
        line = {k: s.get(k) for k in ('managementState', 'desiredState', 'revision')}
        line['reason'] = (s.get('reason') or {}).get('code')
        if not seen or seen[-1][1] != line:
            seen.append((now(), line))
        if line['managementState'] == args.state and (args.reason is None or line['reason'] == args.reason):
            break
        if time.monotonic() > deadline:
            out({'owner': args.name, 'timeout': args.timeout, 'changes': seen})
            raise SystemExit(f'{args.name} not {args.state}/{args.reason} within {args.timeout} s')
        time.sleep(1)
    out({'owner': args.name, 'reached': args.state, 'changes': seen})


def cmd_hold(args):
    s = status_of(args.name)
    code, answer = http('POST', '/sessions', {'workspaceId': s['workspaceId'], 'prompt': 'T07-HOLD FAKE-SLOW 1800 keep the runner busy',
                                              'title': 't07 hold the slot'}, token=token(args.name))
    out({'at': now(), 'owner': args.name, 'status': code, 'session': (answer or {}).get('id') if isinstance(answer, dict) else answer})


def cmd_release(args):
    t = token(args.name)
    stopped = []
    for session in http('GET', '/sessions?view=open', token=t)[1] or []:
        if session.get('status') in ('RUNNING', 'PENDING'):
            stopped.append({'id': session['id'], 'interrupt': http('POST', f"/sessions/{session['id']}/interrupt", {}, token=t)[0]})
    asked, deadline = [], time.monotonic() + 180
    while time.monotonic() < deadline:
        s = status_of(args.name)
        code, answer = http('POST', '/managed-runner/sleep', {'idempotencyKey': uuid.uuid4().hex, 'revision': s.get('revision')}, token=t)
        asked.append({'at': now(), 'state': s.get('managementState'), 'status': code})
        if code in (200, 202):
            break
        time.sleep(3)
    out({'owner': args.name, 'interrupted': stopped, 'sleep': asked})


def volume_name(name):
    s = status_of(name)
    runner = s['runnerId']
    script = "const {toUuid} = require(process.argv[1]); console.log(toUuid(process.argv[2]));"
    uid = run('node', '-e', script, REPO / 'src/shared/dist/index.js', runner).stdout.strip()
    return f'mr-data-{uid}'


def cmd_volume(args):
    vol = volume_name(args.name)
    refs = docker('ps', '-a', '--filter', f'volume={vol}', '--format', '{{.Names}}\t{{.Status}}').stdout.splitlines()
    present = docker('volume', 'inspect', vol, check=False).returncode == 0
    out({'owner': args.name, 'volume': vol, 'present': present, 'referredToBy': refs})


def cmd_holder(args):
    vol = volume_name(args.name)
    name = f't07-holder-{args.name}'
    if args.action == 'on':
        docker('run', '-d', '--name', name, '--label', LABEL, '--network', 'none', '-v', f'{vol}:/data:ro', 'alpine:3', 'sleep', '3600')
    else:
        docker('rm', '-f', name, check=False)
    out({'owner': args.name, 'holder': name, 'action': args.action, 'at': now(),
         'referredToBy': docker('ps', '-a', '--filter', f'volume={vol}', '--format', '{{.Names}}').stdout.splitlines()})


def backup_dir(name):
    return D / 'backups' / name


def runbook_cwd():
    """volume-backup.sh runs from a deployment's checkout and reads the image from data/managed-runners/channel.json."""
    root = D / 'deployment'
    (root / 'data/managed-runners').mkdir(parents=True, exist_ok=True)
    shutil.copy2(D / 'channel.json', root / 'data/managed-runners/channel.json')
    return root


def cmd_backup(args):
    vol = volume_name(args.name)
    backup_dir(args.name).mkdir(parents=True, exist_ok=True)
    result = run('bash', REPO / 'scripts/managed-runner/volume-backup.sh', 'backup', vol, backup_dir(args.name), check=False, cwd=runbook_cwd())
    out({'owner': args.name, 'volume': vol, 'at': now(), 'code': result.returncode, 'out': (result.stdout + result.stderr)[-1200:]})


def cmd_remove(args):
    vol = volume_name(args.name)
    result = docker('volume', 'rm', vol, check=False)
    out({'owner': args.name, 'volume': vol, 'at': now(), 'code': result.returncode, 'out': (result.stdout + result.stderr).strip()})


def cmd_restore(args):
    vol = volume_name(args.name)
    result = run('bash', REPO / 'scripts/managed-runner/volume-backup.sh', 'restore', vol, backup_dir(args.name), check=False, cwd=runbook_cwd())
    out({'owner': args.name, 'volume': vol, 'at': now(), 'code': result.returncode, 'out': (result.stdout + result.stderr)[-1500:]})


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='cmd', required=True)
    for name in ('up', 'down', 'status'):
        sub.add_parser(name)
    p = sub.add_parser('account')
    p.add_argument('name')
    p.add_argument('--no-signin', action='store_true')
    for name in ('key', 'hold', 'release', 'volume', 'backup', 'remove', 'restore'):
        sub.add_parser(name).add_argument('name')
    p = sub.add_parser('until')
    p.add_argument('name')
    p.add_argument('state')
    p.add_argument('--reason')
    p.add_argument('--timeout', type=int, default=300)
    p = sub.add_parser('holder')
    p.add_argument('name')
    p.add_argument('action', choices=('on', 'off'))
    args = parser.parse_args()
    {'up': cmd_up, 'down': cmd_down, 'status': cmd_status, 'account': cmd_account, 'key': cmd_key, 'until': cmd_until,
     'hold': cmd_hold, 'release': cmd_release, 'volume': cmd_volume, 'holder': cmd_holder, 'backup': cmd_backup,
     'remove': cmd_remove, 'restore': cmd_restore}[args.cmd](args)


if __name__ == '__main__':
    main()
