#!/usr/bin/env python3
"""Run the optional managed runner image in the lab and read its persistent state back.

The image's standalone path (deploy/managed-runner/README.md, "Standalone enrollment"): one owner
enrollment on first start, the retained identity on every rebuild. The manager's own Pod, its
admission guard and generations are not exercised here. Only the lab's kubeconfig, context and
namespace are used, and only the lab's test control plane (test-server.sh) on 127.0.0.1.

Every command prints JSON and never a credential: the owner's tokens, the enrollment token, the
runner token and any model key stay in files of mode 0600 under LAB_DIR/test-server/state, in the
lab's Secrets and in the test server's provider store.

  import TAR                       import an image archive into the guest's k3s containerd
  owner                            bootstrap (or sign in) the test owner
  enroll NAME                      one-time enrollment token into Secret NAME-enrollment
  start NAME --image REF           PVC NAME-data (kept), CA ConfigMap, Pod NAME-runner; waits for it
                                   to run and for the test server to see the runner online
  stop NAME [--grace S]            delete the Pod (SIGTERM), time its exit, keep the logs
  snapshot NAME                    hashes of the persistent state, read inside the runner container
  workspace NAME                   the default workspace on the runner (git worktrees on)
  provider NAME --closed | --fake | --key-file F
                                   a DeepSeek-preset provider: a closed endpoint (no model call),
                                   fake-model.py (canned answers, no key), or the owner's key read
                                   from F straight into the test server
  session NAME (--shell CMD | --prompt TEXT) [--provider SLUG] [--model M] [--attach FILE]
  turn NAME SESSION (--shell CMD | --prompt TEXT) [--attach FILE]
  wait NAME SESSION [--status S] [--timeout S]
  events NAME SESSION              the session's events, written beside the state
  runners NAME                     the owner's runners as the test server sees them
  project NAME --merge-check CMD   a project on the workspace, PROJECT_BRANCH line, merge check CMD
  task NAME --title T --provider SLUG --model M
                                   an OWNER_CONFIRMED task in it, run at once on the runner
  end NAME SESSION / confirm NAME TASK
                                   end the task's session; confirm the task (DONE queues LAND_TASK)
  integration NAME                 the project's integration view: jobs in flight, landings
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

LAB = Path(__file__).resolve().parent
ENV = dict(re.findall(r'^([A-Z][A-Z0-9_]*)=(\S*)', (LAB / 'lab.env').read_text(), re.M))
LAB_DIR = Path(ENV['LAB_DIR'])
SERVER = LAB_DIR / 'test-server'
STATE = SERVER / 'state'
NAMESPACE = ENV['LAB_NAMESPACE']
API = f"http://127.0.0.1:{ENV['LAB_TEST_API_PORT']}/api"
POD_SERVER_URL = f"https://10.0.2.2:{ENV['LAB_TEST_TLS_PORT']}"
STATE_ROOT = '/var/lib/orbit'
WORKSPACE_DIR = STATE_ROOT + '/home/orbit-repos/default'
KEY_FILE = LAB_DIR / 'secrets' / 'deepseek-api-key'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def parse(stamp):
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def out(value):
    print(json.dumps(value, indent=2, sort_keys=True))


# ---- Kubernetes, lab context only ----------------------------------------------------------

def kubectl(*args, input=None, check=True):
    env = {k: v for k, v in os.environ.items() if k != 'KUBECONFIG'}
    command = [str(LAB_DIR / 'bin/kubectl'), '--kubeconfig', str(LAB_DIR / 'kubeconfig.json'),
               '--context', ENV['LAB_NAME'], '--namespace', NAMESPACE, *args]
    result = subprocess.run(command, input=input, capture_output=True, text=True, env=env)
    if check and result.returncode:
        raise SystemExit(f'kubectl {args[0]} failed: {result.stderr.strip()}')
    return result


def kget(kind, name):
    result = kubectl('get', kind, name, '-o', 'json', check=False)
    return json.loads(result.stdout) if result.returncode == 0 else None


def ssh(*args, input=None):
    return subprocess.run(['ssh', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-p', ENV['LAB_SSH_PORT'],
                           '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                           '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                           'ubuntu@127.0.0.1', *args], input=input, capture_output=True, text=True)


# ---- the test server ----------------------------------------------------------------------

def private_write(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(value if isinstance(value, str) else json.dumps(value, indent=2))


def state(name):
    path = STATE / f'{name}.json'
    return json.loads(path.read_text()) if path.exists() else {}


def save_state(name, value):
    private_write(STATE / f'{name}.json', value)


def call(method, path, body=None, token=None, data=None, content_type=None):
    headers = {}
    if body is not None:
        data, content_type = json.dumps(body).encode(), 'application/json'
    if content_type:
        headers['Content-Type'] = content_type
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def owner_token():
    owner = state('owner')
    if not owner:
        raise SystemExit('run `owner` first')
    return owner['accessToken']


def api(method, path, body=None, expect=(200, 201), **kwargs):
    status, answer = call(method, path, body, token=owner_token(), **kwargs)
    if status not in expect:
        raise SystemExit(f'{method} {path}: {status} {answer}')
    return answer


def cmd_owner(_args):
    owner = state('owner')
    if owner:
        status, answer = call('POST', '/auth/login', {'email': owner['email'], 'password': owner['password']})
    else:
        owner = {'email': 'lab-owner@lab.invalid', 'password': uuid.uuid4().hex}
        status, answer = call('POST', '/auth/bootstrap', {**owner, 'name': 'Lab owner'})
    if status not in (200, 201):
        raise SystemExit(f'owner: {status} {answer}')
    owner.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    save_state('owner', owner)
    out({'owner': answer['user']})


def cmd_enroll(args):
    token = api('POST', '/runners/enrollment-tokens', {'label': f'{args.name} lab enrollment', 'ttlHours': 24})
    kubectl('delete', 'secret', f'{args.name}-enrollment', '--ignore-not-found')
    kubectl('create', 'secret', 'generic', f'{args.name}-enrollment', '--from-file=token=/dev/stdin',
            input=token['token'])
    out({'enrollmentTokenId': token['id'], 'secret': f'{args.name}-enrollment', 'expiresAt': token['expiresAt']})


def runner_row(name):
    rows = api('GET', '/runners')
    return [row for row in rows if row['name'] == name]


def cmd_runners(args):
    out([{key: row.get(key) for key in ('id', 'name', 'online', 'status', 'version', 'lastHeartbeatAt',
                                        'enrolledAt', 'maxConcurrent', 'activeSessions')}
         for row in api('GET', '/runners')])


# ---- image ----------------------------------------------------------------------------------

def cmd_import(args):
    tar = Path(args.tar).resolve()
    digest = hashlib.sha256(tar.read_bytes()).hexdigest()
    remote = f'/var/tmp/orbit-runner-image-{digest[:12]}.tar'
    copy = subprocess.run(['scp', '-q', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-P', ENV['LAB_SSH_PORT'],
                           '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                           '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                           str(tar), f'ubuntu@127.0.0.1:{remote}'], capture_output=True, text=True)
    if copy.returncode:
        raise SystemExit(f'scp failed: {copy.stderr}')
    started = time.monotonic()
    result = ssh('sudo', 'k3s', 'ctr', '-n', 'k8s.io', 'images', 'import', '--digests', remote,
                 '&&', 'sudo', 'rm', '-f', remote)
    if result.returncode:
        raise SystemExit(f'import failed: {result.stdout} {result.stderr}')
    images = ssh('sudo', 'k3s', 'crictl', 'images', '--digests', '-o', 'json')
    listed = [image for image in json.loads(images.stdout)['images']
              if any('orbit-managed-runner' in tag for tag in image.get('repoTags') or [])]
    out({'archiveSha256': digest, 'importSeconds': round(time.monotonic() - started, 1),
         'ctr': result.stdout.strip().splitlines(), 'criImages': listed})


# ---- the runner Pod -------------------------------------------------------------------------

def pod_spec(name, image, first_start, expected_id):
    env = [{'name': 'ORBIT_RUNNER_SERVER_URL', 'value': POD_SERVER_URL},
           {'name': 'ORBIT_RUNNER_NAME', 'value': name},
           {'name': 'ORBIT_RUNNER_MAX_CONCURRENT', 'value': '2'},
           # The lab CA, in addition to the image's public roots (Go reads SSL_CERT_DIR besides
           # its default bundle); the test server's certificate names 10.0.2.2.
           {'name': 'SSL_CERT_DIR', 'value': '/run/orbit-test-ca'}]
    mounts = [{'name': 'user-state', 'mountPath': STATE_ROOT}, {'name': 'temporary', 'mountPath': '/tmp'},
              {'name': 'test-ca', 'mountPath': '/run/orbit-test-ca', 'readOnly': True}]
    volumes = [{'name': 'user-state', 'persistentVolumeClaim': {'claimName': f'{name}-data'}},
               {'name': 'temporary', 'emptyDir': {'sizeLimit': '1Gi'}},
               {'name': 'test-ca', 'configMap': {'name': f'{name}-ca', 'defaultMode': 0o444}}]
    if first_start:
        env.append({'name': 'ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE', 'value': '/run/orbit-enrollment/token'})
        mounts.append({'name': 'enrollment', 'mountPath': '/run/orbit-enrollment', 'readOnly': True})
        volumes.append({'name': 'enrollment', 'secret': {'secretName': f'{name}-enrollment', 'defaultMode': 0o444}})
    else:
        env.append({'name': 'ORBIT_RUNNER_EXPECTED_ID', 'value': expected_id})
    restricted = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True}
    return {
        'apiVersion': 'v1', 'kind': 'Pod',
        'metadata': {'name': f'{name}-runner', 'namespace': NAMESPACE,
                     'labels': {'app.kubernetes.io/name': 'orbit-managed-runner', 'orbit-test-environment': 'lab',
                                'orbit-lab-runner': name}},
        'spec': {
            'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False,
            'terminationGracePeriodSeconds': 240,
            'securityContext': {'seccompProfile': {'type': 'RuntimeDefault'}},
            'initContainers': [{
                'name': 'private-volume-directories', 'image': image, 'imagePullPolicy': 'Never',
                'args': ['init-volume'],
                'securityContext': {**restricted, 'runAsUser': 0, 'runAsGroup': 0, 'runAsNonRoot': False,
                                    'capabilities': {'drop': ['ALL'], 'add': ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']}},
                'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '200m', 'memory': '128Mi'}},
                'volumeMounts': mounts[:2]}],
            'containers': [{
                'name': 'runner', 'image': image, 'imagePullPolicy': 'Never', 'args': ['run'],
                'securityContext': {**restricted, 'runAsUser': 10001, 'runAsGroup': 10001, 'runAsNonRoot': True,
                                    'capabilities': {'drop': ['ALL']}},
                'env': env,
                'resources': {'requests': {'cpu': '500m', 'memory': '768Mi'}, 'limits': {'cpu': '2', 'memory': '2Gi'}},
                'volumeMounts': mounts}],
            'volumes': volumes}}


def follow_logs(name, pod_uid):
    logs = STATE / 'logs'
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = logs / f'{name}-runner-{pod_uid}.log'
    command = [str(LAB_DIR / 'bin/kubectl'), '--kubeconfig', str(LAB_DIR / 'kubeconfig.json'), '--context',
               ENV['LAB_NAME'], '--namespace', NAMESPACE, 'logs', '-f', '--timestamps', '-c', 'runner', f'{name}-runner']
    with open(path, 'ab') as output:
        subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True, env={k: v for k, v in os.environ.items() if k != 'KUBECONFIG'})
    return path


def cmd_start(args):
    lab = state(args.name)
    first_start = not lab.get('runnerId')
    if first_start and not kget('secret', f'{args.name}-enrollment'):
        raise SystemExit('first start: run `enroll` first')
    if kget('pod', f'{args.name}-runner'):
        raise SystemExit(f'{args.name}-runner exists; `stop` it first')
    if not kget('pvc', f'{args.name}-data'):
        kubectl('create', '-f', '-', input=json.dumps({
            'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim',
            'metadata': {'name': f'{args.name}-data', 'namespace': NAMESPACE, 'labels': {'orbit-lab-runner': args.name}},
            'spec': {'storageClassName': ENV['LAB_STORAGE_CLASS'], 'accessModes': ['ReadWriteOnce'],
                     'volumeMode': 'Filesystem', 'resources': {'requests': {'storage': '5Gi'}}}}))
    kubectl('apply', '-f', '-', input=kubectl('create', 'configmap', f'{args.name}-ca',
                                               f'--from-file=lab-ca.crt={SERVER / "tls/ca.crt"}',
                                               '--dry-run=client', '-o', 'json').stdout)
    spec = pod_spec(args.name, args.image, first_start, lab.get('runnerUuid'))
    requested = now()
    kubectl('create', '-f', '-', input=json.dumps(spec))
    deadline = time.monotonic() + args.timeout
    pod = None
    while time.monotonic() < deadline:
        pod = kget('pod', f'{args.name}-runner')
        statuses = (pod or {}).get('status', {}).get('containerStatuses') or []
        if statuses and 'running' in statuses[0].get('state', {}):
            break
        if pod and pod['status'].get('phase') in ('Failed', 'Succeeded'):
            raise SystemExit(f"Pod ended: {json.dumps(pod['status'])}")
        time.sleep(2)
    else:
        raise SystemExit(f"Pod not running within {args.timeout} s: {json.dumps((pod or {}).get('status'))}")
    log = follow_logs(args.name, pod['metadata']['uid'])
    running = now()
    row = None
    since = datetime.datetime.fromisoformat(requested)
    while time.monotonic() < deadline:
        rows = runner_row(args.name)
        if len(rows) > 1:
            raise SystemExit(f'more than one runner named {args.name}: {[r["id"] for r in rows]}')
        beat = rows[0]['lastHeartbeatAt'] if rows else None
        # Registration stamps lastHeartbeatAt too: only a beat after it shows `orbit run` reporting.
        if beat and rows[0]['online'] and parse(beat) > max(since, parse(rows[0]['enrolledAt'])) + datetime.timedelta(seconds=1):
            row = rows[0]
            break
        time.sleep(3)
    else:
        raise SystemExit(f'the test server never saw {args.name} online; see {log}')
    # The volume's own answer: config.json keeps the UUID; the owner API shows its public id.
    identity = json.loads(kubectl('exec', f'{args.name}-runner', '-c', 'runner', '--',
                                  '/usr/local/bin/orbit-container', 'check').stdout)
    if first_start:
        lab['runnerId'], lab['runnerUuid'] = row['id'], identity['runnerId']
        kubectl('delete', 'secret', f'{args.name}-enrollment')
    elif row['id'] != lab['runnerId'] or identity['runnerId'] != lab['runnerUuid']:
        raise SystemExit(f"runner id changed: {lab['runnerId']}/{lab['runnerUuid']} -> {row['id']}/{identity['runnerId']}")
    pvc = kget('pvc', f'{args.name}-data')
    pv = kget('pv', pvc['spec']['volumeName']) if pvc['spec'].get('volumeName') else None
    statuses = pod['status']['containerStatuses'][0]
    start = {'requestedAt': requested, 'runningAt': running, 'onlineAt': now(), 'firstStart': first_start,
             'pod': {'name': pod['metadata']['name'], 'uid': pod['metadata']['uid'], 'node': pod['spec'].get('nodeName'),
                     'image': statuses['image'], 'imageID': statuses['imageID']},
             'pvc': {'name': pvc['metadata']['name'], 'uid': pvc['metadata']['uid'], 'volumeName': pvc['spec'].get('volumeName'),
                     'accessModes': pvc['spec']['accessModes']},
             'rbdImage': ((pv or {}).get('spec', {}).get('csi', {}).get('volumeAttributes') or {}).get('imageName'),
             'runner': {key: row.get(key) for key in ('id', 'name', 'online', 'version', 'enrolledAt', 'lastHeartbeatAt')},
             'volumeIdentity': identity,
             'runnersNamedSo': len(runner_row(args.name)), 'log': str(log)}
    lab.setdefault('starts', []).append(start)
    save_state(args.name, lab)
    out(start)


def cmd_stop(args):
    lab = state(args.name)
    pod = kget('pod', f'{args.name}-runner')
    if not pod:
        raise SystemExit(f'no Pod {args.name}-runner')
    # Watch the object rather than poll it: the kubelet removes it moments after the container ends.
    watch = subprocess.Popen(
        [str(LAB_DIR / 'bin/kubectl'), '--kubeconfig', str(LAB_DIR / 'kubeconfig.json'), '--context', ENV['LAB_NAME'],
         '--namespace', NAMESPACE, 'get', 'pod', f'{args.name}-runner', '--watch', '--output-watch-events', '-o', 'json',
         f'--request-timeout={args.grace + 180}s'],
        stdout=subprocess.PIPE, text=True, env={k: v for k, v in os.environ.items() if k != 'KUBECONFIG'})
    time.sleep(1)
    requested = now()
    kubectl('delete', 'pod', f'{args.name}-runner', '--wait=false', f'--grace-period={args.grace}')
    terminated, last, decoder, buffer = None, pod, json.JSONDecoder(), ''
    for chunk in watch.stdout:
        buffer += chunk
        while buffer.strip():
            try:
                event, end = decoder.raw_decode(buffer.lstrip())
            except ValueError:
                break
            buffer = buffer.lstrip()[end:]
            last = event['object']
            for status in last.get('status', {}).get('containerStatuses') or []:
                if status['name'] == 'runner' and 'terminated' in status.get('state', {}):
                    terminated = status['state']['terminated']
            if event['type'] == 'DELETED':
                watch.terminate()
                break
    watch.wait()
    gone = now()
    log = Path(lab['starts'][-1]['log']) if lab.get('starts') else None
    time.sleep(2)  # let the follower write the last lines
    lines = log.read_text(errors='replace').splitlines() if log and log.exists() else []
    marks = {}
    for line in lines:
        stamp, _, text = line.partition(' ')
        for key, pattern in (('stopping', 'runner stopping; draining'), ('drainDeadline', 'drain deadline reached'),
                             ('detached', 'detached for shutdown'), ('drainTimeout', 'drain timeout for'),
                             ('integrationNotDelivered', 'result not delivered and this runner is stopping')):
            if pattern in text:
                marks.setdefault(key, stamp)
    stop = {'deleteRequestedAt': requested, 'podGoneAt': gone, 'grace': args.grace,
            'runnerTerminated': terminated, 'podUid': last['metadata']['uid'], 'logMarks': marks,
            'logTail': lines[-15:], 'log': str(log) if log else None}
    lab.setdefault('stops', []).append(stop)
    save_state(args.name, lab)
    out(stop)


SNAPSHOT = r'''
import hashlib, json, os, sqlite3, subprocess
from pathlib import Path
HOME = Path('/var/lib/orbit/home'); ORBIT = HOME / '.orbit'; WS = HOME / 'orbit-repos/default'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def git(d, *a):
    r = subprocess.run(['git', '-C', str(d), *a], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else 'ERROR: ' + r.stderr.strip()
def files(root, skip=()):
    if not root.exists(): return {}
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob('*'))
            if p.is_file() and not p.is_symlink() and not any(part in skip for part in p.relative_to(root).parts)}
config = json.loads((ORBIT / 'config.json').read_text())
mount = [l.split() for l in Path('/proc/self/mountinfo').read_text().splitlines() if l.split()[4] == '/var/lib/orbit']
result = {
    'process': {'uid': os.getuid(), 'gid': os.getgid(), 'capEff': [l.split()[1] for l in Path('/proc/self/status').read_text().splitlines() if l.startswith('CapEff')][0]},
    'mount': [{'fstype': m[m.index('-') + 1], 'source': m[m.index('-') + 2]} for m in mount],
    'config': {k: config.get(k) for k in ('runnerId', 'serverUrl', 'name', 'workDir', 'maxConcurrent', 'autoInstallEngines')},
    'configSha256': sha(ORBIT / 'config.json'),
    'containerIdentity': json.loads((ORBIT / 'container-identity.json').read_text()),
    'modes': {str(p): oct(p.stat().st_mode & 0o777) for p in (HOME, ORBIT, ORBIT / 'config.json')},
    'workspace': {'head': git(WS, 'rev-parse', 'HEAD'), 'branch': git(WS, 'branch', '--show-current'),
                  'worktreeList': git(WS, 'worktree', 'list', '--porcelain').splitlines(), 'files': files(WS, skip=('.git',))},
    'worktrees': {}, 'uploads': files(ORBIT / 'uploads'), 'runs': {}, 'claude': {}, 'sqlite': {},
}
for wt in sorted((ORBIT / 'worktrees').iterdir()) if (ORBIT / 'worktrees').exists() else []:
    if wt.is_dir():
        result['worktrees'][wt.name] = {'head': git(wt, 'rev-parse', 'HEAD'), 'branch': git(wt, 'branch', '--show-current'),
                                        'status': git(wt, 'status', '--porcelain').splitlines(),
                                        'commonDir': str((wt / git(wt, 'rev-parse', '--git-common-dir')).resolve()),
                                        'files': files(wt, skip=('.git',))}
for meta in sorted((ORBIT / 'runs').glob('*/meta.json')):
    m = json.loads(meta.read_text())
    result['runs'][meta.parent.name] = {k: m.get(k) for k in ('provider', 'sessionUuid', 'runtimeSessionId', 'workDir', 'claudeConfigDir')}
for p in sorted((HOME / '.claude' / 'projects').rglob('*.jsonl')) if (HOME / '.claude' / 'projects').exists() else []:
    result['claude'][str(p.relative_to(HOME / '.claude'))] = {'sha256': sha(p), 'lines': len(p.read_bytes().splitlines())}
for p in sorted(list(HOME.rglob('*.sqlite')) + list(HOME.rglob('*.db'))):
    try:
        with sqlite3.connect(f'file:{p}?mode=ro', uri=True) as db:
            result['sqlite'][str(p.relative_to(HOME))] = db.execute('PRAGMA integrity_check').fetchone()[0]
    except sqlite3.Error as error:
        result['sqlite'][str(p.relative_to(HOME))] = 'ERROR: ' + str(error)
print(json.dumps(result, sort_keys=True))
'''


def cmd_snapshot(args):
    result = kubectl('exec', f'{args.name}-runner', '-c', 'runner', '--', 'python3', '-c', SNAPSHOT)
    snapshot = json.loads(result.stdout)
    snapshot['takenAt'] = now()
    lab = state(args.name)
    lab.setdefault('snapshots', []).append(snapshot)
    save_state(args.name, lab)
    out(snapshot)


# ---- workspace, provider, sessions -------------------------------------------------------------

def cmd_workspace(args):
    lab = state(args.name)
    if not lab.get('workspaceId'):
        answer = api('POST', '/workspaces', {'name': f'{args.name} default', 'runnerId': lab['runnerId'],
                                            'workDir': WORKSPACE_DIR, 'enableWorktree': True, 'autoInitGit': True})
        lab['workspaceId'] = answer['id']
        save_state(args.name, lab)
    out({'workspaceId': lab['workspaceId'], 'workDir': WORKSPACE_DIR})


def cmd_provider(args):
    lab = state(args.name)
    if args.closed:
        # Nothing listens at 127.0.0.1:9 inside the Pod: a turn sent here fails without leaving it.
        body = {'label': 'DeepSeek closed endpoint', 'presetSlug': 'deepseek',
                'baseUrl': 'http://127.0.0.1:9/anthropic', 'apiKey': 'sk-lab-closed-endpoint-not-a-key'}
    elif args.fake:
        # fake-model.py on the host: turns complete with canned answers, no key, no outbound call.
        body = {'label': 'FAKE model (lab, not a model)', 'presetSlug': 'deepseek',
                'baseUrl': f"http://10.0.2.2:{ENV['LAB_TEST_FAKE_MODEL_PORT']}/anthropic",
                'apiKey': 'sk-lab-fake-model-not-a-key'}
    else:
        key = Path(args.key_file).read_text().strip()
        if not key:
            raise SystemExit(f'{args.key_file} is empty')
        body = {'label': 'DeepSeek (owner key, lab)', 'presetSlug': 'deepseek',
                'baseUrl': 'https://api.deepseek.com/anthropic', 'apiKey': key}
    answer = api('POST', '/providers/mine', body)
    lab.setdefault('providers', {})[answer['slug']] = {
        'id': answer['id'], 'kind': 'closed' if args.closed else 'fake' if args.fake else 'deepseek'}
    save_state(args.name, lab)
    out({key: answer.get(key) for key in ('id', 'slug', 'label', 'presetSlug', 'runtime', 'baseUrl', 'models', 'defaultModel')})


def upload(path, session_id=None):
    data = Path(path).read_bytes()
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{Path(path).name}"\r\n'
            f'Content-Type: text/plain\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    query = f'?sessionId={session_id}' if session_id else ''
    answer = api('POST', '/attachments' + query, data=body, content_type=f'multipart/form-data; boundary={boundary}')
    return {'id': answer['id'], 'fileName': Path(path).name, 'sha256': hashlib.sha256(data).hexdigest()}


def cmd_session(args):
    lab = state(args.name)
    attachments = [upload(path) for path in args.attach]
    body = {'workspaceId': lab['workspaceId'], 'title': args.title or f'{args.name} lab session',
            'prompt': args.shell or args.prompt, 'engine': 'claude', 'provider': args.provider,
            'permissionMode': args.permission_mode}
    if args.shell:
        body['shell'] = True
    if args.model:
        body['model'] = args.model
    if attachments:
        body['attachmentIds'] = [a['id'] for a in attachments]
    answer = api('POST', '/sessions', body)
    lab.setdefault('sessions', {})[answer['id']] = {'title': body['title'], 'createdAt': now(),
                                                   'attachments': attachments, 'provider': args.provider}
    save_state(args.name, lab)
    out({key: answer.get(key) for key in ('id', 'status', 'branch', 'provider', 'engine', 'model')} | {'attachments': attachments})


def cmd_turn(args):
    lab = state(args.name)
    attachments = [upload(path, args.session) for path in args.attach]
    body = {'clientTurnId': str(uuid.uuid4()), 'content': args.shell or args.prompt,
            'kind': 'shell' if args.shell else 'message'}
    if attachments:
        body['attachmentIds'] = [a['id'] for a in attachments]
    answer = api('POST', f'/sessions/{args.session}/turns', body)
    lab['sessions'][args.session].setdefault('turns', []).append({'at': now(), 'kind': body['kind'],
                                                                   'attachments': attachments})
    save_state(args.name, lab)
    out({'turn': answer if isinstance(answer, dict) and len(json.dumps(answer)) < 2000 else 'accepted',
         'attachments': attachments})


def session_view(session_id):
    session = api('GET', f'/sessions/{session_id}')
    return {key: session.get(key) for key in ('id', 'status', 'runStatus', 'sessionState', 'runState', 'branch',
                                              'runtimeSessionId', 'engine', 'provider', 'model', 'endReason')}


def cmd_wait(args):
    deadline = time.monotonic() + args.timeout
    while True:
        view = session_view(args.session)
        if view['status'] in args.status:
            break
        if time.monotonic() > deadline:
            raise SystemExit(f'session still {view["status"]} after {args.timeout} s: {json.dumps(view)}')
        time.sleep(3)
    out(view)


def cmd_events(args):
    events, after = [], None
    while True:
        query = f'?after={after}&limit=200' if after is not None else '?after=0&limit=200'
        page = api('GET', f'/sessions/{args.session}/events/page{query}')
        events += page['events']
        if not page.get('hasMore') or not page['events']:
            break
        after = page['events'][-1]['seq']
    path = STATE / 'events' / f'{args.session}.json'
    private_write(path, json.dumps(events, indent=1))
    kinds = {}
    for event in events:
        kinds[event['type']] = kinds.get(event['type'], 0) + 1
    out({'session': session_view(args.session), 'events': len(events), 'types': kinds, 'file': str(path)})


# ---- an integration job on the runner (a task landing on a project line) -----------------------

def cmd_project(args):
    """A project on the runner's workspace whose PROJECT_BRANCH line runs MERGE_CHECK on landing."""
    lab = state(args.name)
    workspace = api('GET', f"/workspaces/{lab['workspaceId']}")
    if not workspace.get('repoUrl'):
        raise SystemExit('the workspace has no repoUrl yet: give its repository an origin and wait a heartbeat')
    project = api('POST', '/projects', {'title': f'{args.name} landing probe', 'workspaceId': lab['workspaceId'],
                                        'goal': 'Land one task through the project line on the lab runner.'})
    line = api('PATCH', f"/projects/{project['id']}/integration",
               {'line': 'PROJECT_BRANCH', 'upstreamRef': 'refs/heads/master', 'mergeCheckCommand': args.merge_check,
                'mergeCheckTimeoutSeconds': args.check_timeout})
    lab['projectId'] = project['id']
    save_state(args.name, lab)
    out({'projectId': project['id'], 'repoUrl': workspace['repoUrl'],
         'integration': {key: line.get(key) for key in ('line', 'ref', 'upstreamRef', 'mergeCheckCommand', 'repository')}})


def cmd_task(args):
    lab = state(args.name)
    task = api('POST', '/tasks', {'projectId': lab['projectId'], 'assigneeId': lab['workspaceId'], 'title': args.title,
                                  'description': args.title, 'completionCriterion': 'OWNER_CONFIRMED',
                                  'engine': 'claude', 'provider': args.provider, 'model': args.model})
    run = api('POST', f"/tasks/{task['id']}/execute", {'triggerId': str(uuid.uuid4())})
    lab.setdefault('tasks', {})[task['id']] = {'sessionId': run.get('sessionId'), 'createdAt': now()}
    lab.setdefault('sessions', {})[run.get('sessionId')] = {'title': args.title, 'createdAt': now(), 'taskId': task['id']}
    save_state(args.name, lab)
    out({'taskId': task['id'], 'sessionId': run.get('sessionId'), 'status': task.get('status')})


def cmd_end(args):
    api('POST', f'/sessions/{args.session}/end')
    out({'ended': args.session, 'requestedAt': now()})


def cmd_confirm(args):
    answer = api('POST', f'/tasks/{args.task}/owner-confirmation', {'decision': 'CONFIRM'})
    out({'confirmedAt': now(), 'answer': {key: answer.get(key) for key in ('status', 'taskId', 'decision')}
         if isinstance(answer, dict) else answer})


def cmd_integration(args):
    lab = state(args.name)
    view = api('GET', f"/projects/{lab['projectId']}/integration")
    out({'at': now(), 'line': view.get('line'), 'ref': view.get('ref'), 'locked': view.get('locked'),
         'inFlightJobs': view.get('inFlightJobs'),
         'landTasks': [{'taskId': item.get('taskId'), 'landTask': (item.get('integration') or {}).get('landTask')}
                       for item in view.get('landTasks') or []]})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('import').add_argument('tar')
    sub.add_parser('owner')
    for name in ('enroll', 'snapshot', 'workspace', 'runners'):
        sub.add_parser(name).add_argument('name')
    start = sub.add_parser('start')
    start.add_argument('name')
    start.add_argument('--image', required=True)
    start.add_argument('--timeout', type=int, default=300)
    stop = sub.add_parser('stop')
    stop.add_argument('name')
    stop.add_argument('--grace', type=int, default=240)
    provider = sub.add_parser('provider')
    provider.add_argument('name')
    group = provider.add_mutually_exclusive_group(required=True)
    group.add_argument('--closed', action='store_true')
    group.add_argument('--fake', action='store_true')
    group.add_argument('--key-file', default=None)
    for name in ('session', 'turn'):
        command = sub.add_parser(name)
        command.add_argument('name')
        if name == 'turn':
            command.add_argument('session')
        what = command.add_mutually_exclusive_group(required=True)
        what.add_argument('--shell')
        what.add_argument('--prompt')
        command.add_argument('--attach', action='append', default=[])
        if name == 'session':
            command.add_argument('--provider', required=True)
            command.add_argument('--model')
            command.add_argument('--title')
            command.add_argument('--permission-mode', default='bypassPermissions')
    wait = sub.add_parser('wait')
    wait.add_argument('name')
    wait.add_argument('session')
    wait.add_argument('--status', action='append', default=None)
    wait.add_argument('--timeout', type=int, default=300)
    events = sub.add_parser('events')
    events.add_argument('name')
    events.add_argument('session')
    project = sub.add_parser('project')
    project.add_argument('name')
    project.add_argument('--merge-check', required=True)
    project.add_argument('--check-timeout', type=int, default=900)
    task = sub.add_parser('task')
    task.add_argument('name')
    task.add_argument('--title', required=True)
    task.add_argument('--provider', required=True)
    task.add_argument('--model', required=True)
    end = sub.add_parser('end')
    end.add_argument('name')
    end.add_argument('session')
    confirm = sub.add_parser('confirm')
    confirm.add_argument('name')
    confirm.add_argument('task')
    sub.add_parser('integration').add_argument('name')
    args = parser.parse_args()
    if args.command == 'wait' and not args.status:
        args.status = ['AWAITING_INPUT']
    {'import': cmd_import, 'owner': cmd_owner, 'enroll': cmd_enroll, 'start': cmd_start, 'stop': cmd_stop,
     'snapshot': cmd_snapshot, 'workspace': cmd_workspace, 'provider': cmd_provider, 'session': cmd_session,
     'turn': cmd_turn, 'wait': cmd_wait, 'events': cmd_events, 'runners': cmd_runners, 'project': cmd_project,
     'task': cmd_task, 'end': cmd_end, 'confirm': cmd_confirm, 'integration': cmd_integration}[args.command](args)


if __name__ == '__main__':
    main()
