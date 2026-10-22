#!/usr/bin/env python3
"""Two accounts through the whole managed-runner flow on the lab's real k3s, in one run (task T08).

docs/managed-runner-lab.md, "End-to-end acceptance (T08)". One command runs every phase in order and
stops at the first check that fails; each step's result and wall-clock time are written to OUT:

  facts        versions, topology and resource limits of the host, k3s, Ceph, Ceph-CSI and the image
  setup        the gate (every request the manager sends k3s goes through it), the lab CA the image
               trusts, the namespace's objects of earlier tasks, and the real self-managed runner's build
  off-unset    a fresh database with the switch unset and no profile: sign-ins, the managed API, a real
               self-managed runner's sessions and tasks, and nothing managed anywhere for a while
  off-false    the same with ORBIT_MANAGED_RUNNERS_ENABLED=false and still no profile
  on-provision the switch on: two accounts (ann, bob) signing in concurrently over two replicas while the
               cluster has no admission guard (provisioning fails), then the guard and the owners' retry
  capacity     a third account (cy) on a budget of two runners: it waits, with nothing created
  sessions     each account's first session with an attachment, a file committed in its Git worktree by
               the engine's own tool call, a busy runner (a long turn, a background job) that may not sleep,
               data on the volume, and one account against the other
  sleep        idle sleep of both; cy admitted once a runner sleeps, then asleep
  wake         a message wakes ann, a scheduled task wakes bob; data, identity and the engine's session
  rebuild      ann's Pod deleted by an operator, bob's runner killed: the next Pod on the same volume
  controller   both apiservers SIGKILLed while bob starts and ann's turn runs, then started again
  image        the profile's image pin rolled back to the previous build, then forward again: running Pods keep
               theirs, each next generation runs the pin
  backup       ann's RBD image exported out of the VM to the host while held asleep, checked there
               without any cluster, restored into a new image and a new PVC and checked in a Pod;
               the original untouched and woken again
  off-again    the switch unset, then false, with every runner asleep: demands wake nothing, nothing is
               deleted; then on, and the waiting work wakes them
  final        consistency, single Pod per volume over the whole timeline, what the gate saw, Ceph,
               and the window closed (recorder, webhook, replicas, server, gate, self-managed runner)

  acceptance-lab.py run --out DIR [--from PHASE] [--to PHASE] [--quiet-seconds S]
  acceptance-lab.py record-loop SECONDS        the recorder unit's loop (started by the run)
  acceptance-lab.py secret-scan PATH...        no credential of the run in these files
  acceptance-lab.py report OUT                 the steps' times and checks, and the intervals the README quotes

LAB_TEST_SERVER_DIR must name test-server-t08 (or test-server-t08-dev for trials): earlier tasks'
databases stay untouched. Every record is JSON and never holds a credential: owners' tokens and
passwords, runner credentials, the fake model key and the manager's token stay in files of mode 0600
under the server directory, in the lab's Secrets and in the test server's provider store. Sessions run on
fake-model.py as a DeepSeek-preset key, which is not a model: the real DeepSeek sessions are pending.
"""

import argparse
import base64
import concurrent.futures
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_wake', LAB / 'wake-lab.py')
wl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wl)
ml, sw = wl.ml, wl.sw

REPO, SERVER, STATE, NAMESPACE, ENV, LAB_DIR = sw.REPO, sw.SERVER, sw.STATE, sw.NAMESPACE, sw.ENV, sw.LAB_DIR
OWN_SERVER_DIRS = ('test-server-t08', 'test-server-t08-dev')
# wake-lab.py's commands with this task's directory and names.
wl.OWN_SERVER_DIRS = wl.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.EMAIL = ml.EMAIL = 't08-{}@lab.invalid'
wl.NAME_RE = re.compile(r't08-([a-z0-9]+)@lab\.invalid')
wl.PROBE_ROOT = '/var/lib/orbit/home/t08-probe'
# 150 committed rows, not T06's 500: two volumes on this VM's one HDD fsync each row three times over.
PROBE_ROWS = 150
assert wl.PROBE.count('for n in range(500):') == 1
wl.PROBE = wl.PROBE.replace('for n in range(500):', f'for n in range({PROBE_ROWS}):')

PROJECT_LINE = 'refs/heads/project/34ZteKCnYMpKY46f63Leb'
# T06b's lab image: deploy/managed-runner/image and src/runner-go unchanged since its source ebf54ab8d.
IMAGE = 'docker.io/library/orbit-managed-runner-lab@sha256:cdb090148c194e536fe86c22f1507b45f74f2aa6929df26f7360747604102312'
IMAGE_SOURCE = 'ebf54ab8d'
# The build before it, T02a's (source 292b2eb43, without T06b's startup heartbeat): the image a rollback goes back to.
PREVIOUS_IMAGE = 'docker.io/library/orbit-managed-runner-lab@sha256:54441a07125b7cd5ec11def5705608ebcd0f3f7243c98918556dd29d03aef98d'
PREVIOUS_IMAGE_SOURCE = '292b2eb43'
T02A = LAB_DIR / 'test-server-t02a'
USERS = ('ann', 'bob')
THIRD = 'cy'
RECORDER_UNIT = 'orbit-mr-lab-t08-recorder'
SELFHOST = Path('/mnt/data/tmp/t08sh')  # short: a session's bg.sock path must stay under 100 bytes
SELFHOST_UNIT = 'orbit-mr-lab-t08-selfhost'
SELFHOST_NAME = 't08-selfhost'
BACKUPS = LAB_DIR / 'backups'
GUEST_BACKUP = '/var/tmp/t08-backup'
GUEST_RESTORE = '/var/tmp/t08-restore'
CSI_SECRET = {'name': ENV['LAB_CSI_SECRET'], 'namespace': ENV['LAB_CSI_NAMESPACE']}
API_UNITS = ('orbit-mr-lab-api', ml.REPLICA_UNIT)
CONTEXT = SERVER / 't08-context.json'
PRIMARY_API = sw.API  # manager-lab.py's http(port=…) swaps this module-wide: never from threads (call_at instead)
FAKE_KEY = 'sk-lab-fake-model-not-a-key'
now = sw.now


class Failed(Exception):
    pass


# ---- plumbing ----------------------------------------------------------------------------------------

def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t08 (or test-server-t08-dev), not {SERVER}')


class ThreadStdout(io.TextIOBase):
    """sys.stdout per thread: a capture in one thread does not take another thread's output."""

    def __init__(self, default):
        self.default, self.local = default, threading.local()

    def target(self):
        return getattr(self.local, 'buffer', None) or self.default

    def write(self, text):
        return self.target().write(text)

    def flush(self):
        self.target().flush()


def capture(fn, **kw):
    """One of the lab scripts' commands, its printed JSON returned; its SystemExit is a failure."""
    if not isinstance(sys.stdout, ThreadStdout):
        sys.stdout = ThreadStdout(sys.stdout)
    buffer = io.StringIO()
    sys.stdout.local.buffer = buffer
    try:
        fn(argparse.Namespace(**kw))
    except SystemExit as error:
        raise Failed(f'{fn.__name__}: {error} {buffer.getvalue()[-600:]}') from None
    finally:
        sys.stdout.local.buffer = None
    text = buffer.getvalue().strip()
    if text[:1] not in ('{', '['):
        return text
    # Some commands print more than one document (wake-lab.py's prepare prints manager-lab.py's, then its own).
    documents, decoder, index = [], json.JSONDecoder(), 0
    while index < len(text):
        document, index = decoder.raw_decode(text, index)
        documents.append(document)
        while index < len(text) and text[index].isspace():
            index += 1
    return documents[0] if len(documents) == 1 else documents


def run(command, check=True, env=None, cwd=None, input=None, timeout=None):
    result = subprocess.run(command, capture_output=True, text=True, env=env, cwd=cwd, input=input, timeout=timeout)
    if check and result.returncode:
        raise Failed(f'{command[0]} {" ".join(command[1:3])} exited {result.returncode}: {(result.stderr or result.stdout).strip()[-800:]}')
    return result


def call_at(port, method, path, body=None, token=None, timeout=60):
    """single-writer.py's call() against the apiserver on PORT, without touching its module-wide address."""
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api{path}', data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def git(*args):
    return run(['git', '-C', str(REPO), *args]).stdout.strip()


def k(*args, namespace=NAMESPACE, check=True, input=None):
    """kubectl on the lab's context only, in the given namespace (None: cluster-scoped)."""
    command = [str(LAB_DIR / 'bin/kubectl'), '--kubeconfig', str(LAB_DIR / 'kubeconfig.json'), '--context', ENV['LAB_NAME']]
    if namespace:
        command += ['--namespace', namespace]
    env = {key: value for key, value in os.environ.items() if key != 'KUBECONFIG'}
    return run([*command, *args], check=check, env=env, input=input)


def kjson(*args, namespace=NAMESPACE):
    return json.loads(k(*args, '-o', 'json', namespace=namespace).stdout)


def kget(kind, name, namespace=NAMESPACE):
    result = k('get', kind, name, '-o', 'json', namespace=namespace, check=False)
    return json.loads(result.stdout) if result.returncode == 0 else None


def guest(script, input=None, check=True):
    result = sw.ssh(script, input=input, check=False)
    if check and result.returncode:
        raise Failed(f'guest command exited {result.returncode}: {result.stderr.strip()[-800:]}')
    return result


SSH = ['ssh', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-p', ENV['LAB_SSH_PORT'], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
       '-o', 'ConnectTimeout=10', '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR', 'ubuntu@127.0.0.1']


def guest_to_file(script, path):
    """A guest command's binary output into a host file."""
    with open(path, 'wb') as output:
        result = subprocess.run([*SSH, script], stdout=output, stderr=subprocess.PIPE)
    if result.returncode:
        raise Failed(f'guest copy exited {result.returncode}: {result.stderr.decode(errors="replace")[-500:]}')


def file_to_guest(path, script):
    with open(path, 'rb') as source:
        result = subprocess.run([*SSH, script], stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise Failed(f'guest copy exited {result.returncode}: {result.stderr.decode(errors="replace")[-500:]}')


def ceph_shell(command, mount=None):
    """The pinned Ceph image's CLIs in a cephadm shell inside the guest, a guest directory mounted at /work."""
    flag = f'--mount {shlex.quote(mount)}:/work ' if mount else ''
    result = guest(f"sudo cephadm --image {shlex.quote(ENV['CEPH_IMAGE'])} shell {flag}-- bash -c {shlex.quote(command)}")
    return result.stdout


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def load_context():
    return json.loads(CONTEXT.read_text()) if CONTEXT.exists() else {}


def save_context(ctx):
    sw.private_write(CONTEXT, ctx)


def seconds_between(a, b):
    parse = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return round((parse(b) - parse(a)).total_seconds(), 1)


class Step:
    """One step's checks: each is recorded with its value; any false check fails the step."""

    def __init__(self):
        self.checks = []

    def check(self, label, ok, value=None):
        self.checks.append({'check': label, 'ok': bool(ok), **({'value': value} if value is not None else {})})
        return ok


# ---- the test server and its switch ------------------------------------------------------------------

def server(*args):
    result = run(['bash', str(LAB / 'test-server.sh'), *args], env={**os.environ, 'LAB_TEST_SERVER_DIR': str(SERVER)}, check=False)
    if result.returncode:
        raise Failed(f'test-server.sh {" ".join(args)}: {(result.stderr or result.stdout).strip()[-800:]}')
    return (result.stdout + result.stderr).strip().splitlines()


def stop_api_units():
    for unit in API_UNITS:
        ml.systemd('stop', unit, check=False)
    deadline = time.monotonic() + 60
    while any(ml.active(unit) == 'active' for unit in API_UNITS):
        if time.monotonic() > deadline:
            raise Failed('the apiserver units did not stop within 60 s')
        time.sleep(1)


def switch_lines():
    path = SERVER / 'secrets/api.env'
    return [line for line in path.read_text().splitlines() if line.startswith('ORBIT_MANAGED_RUNNERS_')] if path.exists() else []


def api_environment_names():
    """The names (never the values) of the apiserver process's environment: what it could know of any cluster."""
    pid = ml.systemd('show', '-p', 'MainPID', '--value', 'orbit-mr-lab-api', check=False).stdout.strip()
    if not pid or pid == '0':
        return None
    names = sorted(entry.split('=', 1)[0] for entry in Path(f'/proc/{pid}/environ').read_bytes().decode(errors='replace').split('\0') if entry)
    return names


def start_server(mode):
    """mode: 'unset', 'false' (no profile) or 'on'; the apiserver units restarted, PostgreSQL, TLS front and fake model kept."""
    stop_api_units()
    flag = {'unset': [], 'false': ['--managed-false-no-profile'], 'on': ['--managed']}[mode]
    started = time.monotonic()
    lines = server('start', *flag)
    replica = capture(ml.cmd_replica, action='start') if mode == 'on' else capture(ml.cmd_replica, action='status')
    names = api_environment_names() or []
    return {'mode': mode, 'seconds': round(time.monotonic() - started, 1), 'testServer': lines[-7:], 'switch': switch_lines() or ['(unset)'],
            'replica': {k: replica.get(k) for k in ('unit', 'port', 'managedSwitch')},
            'apiEnvironmentNames': names,
            'clusterSettingsInTheEnvironment': [n for n in names if n.startswith('ORBIT_MANAGED_RUNNERS_') or 'KUBE' in n or 'CEPH' in n],
            'kubeconfigInTheServerHome': (SERVER / 'home/.kube').exists()}


# ---- facts ----------------------------------------------------------------------------------------------

def facts_git(_ctx, step):
    head = git('rev-parse', 'HEAD')
    remote = dict(reversed(line.split('\t')) for line in run(['git', '-C', str(REPO), 'ls-remote', 'origin', 'refs/heads/main', PROJECT_LINE]).stdout.splitlines())
    image_diff = git('diff', '--stat', IMAGE_SOURCE, 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image')
    dist = REPO / 'src/apiserver/dist/main.js'
    step.check('the runner image sources are unchanged since the image was built', image_diff == '', image_diff or '(no difference)')
    step.check('the apiserver is built in this checkout', dist.exists())
    return {'head': head, 'branch': git('rev-parse', '--abbrev-ref', 'HEAD'), 'subject': git('log', '-1', '--format=%s'),
            'originMain': remote.get('refs/heads/main'), 'projectLine': remote.get(PROJECT_LINE),
            'projectLineIsAncestor': run(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', remote.get(PROJECT_LINE, 'HEAD'), 'HEAD'],
                                         check=False).returncode == 0,
            'uncommitted': git('status', '--porcelain').splitlines(), 'imageSource': IMAGE_SOURCE,
            'apiserverBuiltAt': datetime.datetime.fromtimestamp(dist.stat().st_mtime, datetime.timezone.utc).isoformat(timespec='seconds')}


def facts_host(_ctx, step):
    os_release = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', Path('/etc/os-release').read_text(), re.M))
    meminfo = dict(re.findall(r'^(\w+):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M))
    unit = dict(line.split('=', 1) for line in ml.systemd('show', 'orbit-mr-lab.service', '-p', 'MemoryMax', '-p', 'CPUQuotaPerSecUSec',
                                                         '-p', 'OOMScoreAdjust', '-p', 'ControlGroup', '-p', 'MainPID').stdout.splitlines())
    argv = Path(f"/proc/{unit['MainPID']}/cmdline").read_bytes().split(b'\0') if unit.get('MainPID', '0') != '0' else []
    flag = lambda name: next((argv[i + 1].decode() for i, a in enumerate(argv[:-1]) if a == name.encode()), None)
    modules = [line.split()[0] for line in Path('/proc/modules').read_text().splitlines() if line.split()[0] in ('rbd', 'nbd', 'ceph', 'libceph')]
    step.check('the host loads no rbd, nbd, ceph or libceph module', not modules, modules)
    step.check('the VM runs in its own unit, not in the runner\'s cgroup', unit.get('ControlGroup') == '/system.slice/orbit-mr-lab.service', unit.get('ControlGroup'))
    return {'kernel': os.uname().release, 'os': os_release.get('PRETTY_NAME'), 'cpus': os.cpu_count(),
            'memTotalMiB': int(meminfo['MemTotal']) // 1024, 'memAvailableMiB': int(meminfo['MemAvailable']) // 1024,
            'swapTotalMiB': int(meminfo['SwapTotal']) // 1024, 'labUnit': unit,
            'vm': {'memoryMiB': flag('-m'), 'smp': flag('-smp'), 'machine': flag('-machine')}, 'hostModules': modules}


def facts_cluster(_ctx, step):
    version = kjson('version', namespace=None)
    nodes = kjson('get', 'nodes', namespace=None)['items']
    step.check('one node: one failure domain', len(nodes) == 1, [n['metadata']['name'] for n in nodes])
    node = nodes[0]
    storage_class = kjson('get', 'storageclass', ENV['LAB_STORAGE_CLASS'], namespace=None)
    driver = kjson('get', 'csidriver', ENV['LAB_CSI_DRIVER'], namespace=None)
    csi = kjson('get', 'pods', namespace=ENV['LAB_CSI_NAMESPACE'])['items']
    namespace = kjson('get', 'namespace', NAMESPACE, namespace=None)
    webhooks = kjson('get', 'validatingwebhookconfigurations', namespace=None)['items']
    labels = node['metadata'].get('labels') or {}
    return {
        'kubernetes': {'server': version['serverVersion']['gitVersion'], 'client': version['clientVersion']['gitVersion']},
        'node': {'name': node['metadata']['name'], 'uid': node['metadata']['uid'], 'nodeInfo': node['status']['nodeInfo'],
                 'capacity': node['status']['capacity'], 'allocatable': node['status']['allocatable'],
                 'topologyLabels': {k: v for k, v in labels.items() if k.startswith(('topology.', 'kubernetes.io/', 'node.kubernetes.io/'))},
                 'addresses': node['status'].get('addresses')},
        'storageClass': {k: storage_class.get(k) for k in ('provisioner', 'parameters', 'reclaimPolicy', 'volumeBindingMode', 'allowVolumeExpansion')},
        'csiDriver': driver['spec'],
        'csiPods': [{'name': p['metadata']['name'], 'containers': [{'name': c['name'], 'image': c['image']} for c in p['spec']['containers']],
                     'imageIDs': sorted({s.get('imageID') for s in p['status'].get('containerStatuses') or []})} for p in csi],
        'namespace': {'name': NAMESPACE, 'uid': namespace['metadata']['uid']},
        'validatingWebhooks': [w['metadata']['name'] for w in webhooks],
    }


def facts_ceph(_ctx, step):
    answers = sw.ceph('ceph versions -f json', 'ceph -s -f json', 'ceph osd tree -f json', 'ceph osd pool ls detail -f json', 'ceph df -f json',
                      'ceph osd crush rule dump -f json')
    parsed = []
    for text in answers:
        try:
            parsed.append(json.loads(text))
        except ValueError:
            parsed.append(text)
    versions, status, tree, pools, df, rules = parsed
    pool = next(p for p in pools if p['pool_name'] == ENV['LAB_POOL'])
    step.check('Ceph is HEALTH_OK', status['health']['status'] == 'HEALTH_OK', status['health']['status'])
    return {'versions': versions['overall'], 'fsid': status['fsid'], 'health': status['health']['status'],
            'monmap': {'mons': status['monmap']['num_mons']}, 'osdmap': status['osdmap'],
            'osdTree': [{k: n.get(k) for k in ('id', 'name', 'type', 'status', 'crush_weight', 'device_class')} for n in tree['nodes']],
            'pool': {k: pool.get(k) for k in ('pool_name', 'pool_id', 'size', 'min_size', 'pg_num', 'crush_rule', 'application_metadata')},
            'crushRules': [{'name': r['rule_name'], 'steps': r['steps']} for r in rules],
            'df': {'total': df['stats'], 'pools': [{'name': p['name'], 'stored': p['stats']['stored'], 'maxAvail': p['stats']['max_avail']}
                                                   for p in df['pools']]}}


def facts_image(_ctx, step):
    inspect = json.loads(guest(f'sudo k3s crictl inspecti -o json {shlex.quote(IMAGE)}').stdout)
    status = inspect['status']
    step.check('the pinned image is in the guest', bool(status.get('id')))
    return {'reference': IMAGE, 'id': status.get('id'), 'repoDigests': status.get('repoDigests'), 'repoTags': status.get('repoTags'),
            'size': status.get('size'), 'source': IMAGE_SOURCE, 'pushed': False}


# ---- setup ----------------------------------------------------------------------------------------------

def setup_server_dir(ctx, step):
    require_own_server_dir()
    # The lab's units and its PostgreSQL container are shared by name, each writing into the directory that started
    # it (the gate's log, the fake model's log, the recorder's timeline, the database): all of them start again here.
    stopped = {unit: ml.active(unit) for unit in (RECORDER_UNIT, SELFHOST_UNIT, ml.REPLICA_UNIT, ml.GATE_UNIT)}
    for unit in stopped:
        ml.systemd('stop', unit, check=False)
    server('stop')
    run(['docker', 'rm', sw.PG], check=False)
    (SERVER / 'secrets').mkdir(mode=0o700, parents=True, exist_ok=True)
    copied = []
    # The lab image trusts T02a's CA and k3s presents T02a's webhook token: both before the first start.
    if not (SERVER / 'tls/server.pem').exists():
        shutil.copytree(T02A / 'tls', SERVER / 'tls', dirs_exist_ok=True)
        copied.append('tls')
    if not sw.WEBHOOK_TOKEN.exists():
        shutil.copy2(T02A / 'secrets/admission-webhook-token', sw.WEBHOOK_TOKEN)
        os.chmod(sw.WEBHOOK_TOKEN, 0o600)
        copied.append('secrets/admission-webhook-token')
    gate = capture(ml.cmd_gate, action='start', since=None)
    step.check('the gate runs', gate['unit'] == 'active', gate['unit'])
    webhook = sw.webhook_view()
    if webhook:
        capture(sw.cmd_admission, action='remove')
    step.check('no admission webhook yet (a provisioning must fail without it)', sw.webhook_view() is None)
    ctx['gateConnectionsAtStart'] = ml.gate_connections()
    return {'serverDir': str(SERVER), 'unitsStoppedFirst': stopped, 'copiedFromT02a': copied,
            'gate': {k: gate.get(k) for k in ('unit', 'listen', 'connections')}, 'webhookRemovedFirst': bool(webhook)}


def setup_selfhost_build(ctx, step):
    (SELFHOST / 'bin').mkdir(parents=True, exist_ok=True)
    os.chmod(SELFHOST, 0o700)
    # A fresh self-managed runner for this run: no registration, home or work of an earlier one.
    for name in ('home', 'orbit-home', 'work'):
        shutil.rmtree(SELFHOST / name, ignore_errors=True)
    (SELFHOST / 'runner.log').unlink(missing_ok=True)
    head = git('rev-parse', 'HEAD')
    started = time.monotonic()
    run(['systemd-run', '--scope', '--quiet', '-p', 'MemoryMax=3G', '--', 'env', 'GOFLAGS=-buildvcs=false', 'CGO_ENABLED=0', 'go', 'build', '-trimpath',
         '-ldflags', f'-X main.version=t08-selfhost-{head[:12]}', '-o', str(SELFHOST / 'bin/orbit'), '.'], cwd=str(REPO / 'src/runner-go'), timeout=900)
    build_seconds = round(time.monotonic() - started, 1)
    claude = Path(os.path.realpath('/root/.local/bin/claude'))
    shutil.copy2(claude, SELFHOST / 'bin/claude')
    version = run([str(SELFHOST / 'bin/claude'), '--version'], check=False, env={'PATH': '/usr/bin:/bin', 'HOME': str(SELFHOST)}).stdout.strip()
    step.check('the runner binary was built', (SELFHOST / 'bin/orbit').exists())
    return {'runner': {'source': head, 'buildSeconds': build_seconds, 'sha256': sha256_file(SELFHOST / 'bin/orbit')},
            'claude': {'from': str(claude), 'version': version}}


def setup_foreign(ctx, step):
    saved = capture(ml.cmd_foreign, action='save')
    ctx['foreignCount'] = len(saved['saved'])
    return {'foreignObjects': len(saved['saved']), 'kinds': sorted({o['kind'] for o in saved['saved']})}


# ---- accounts ----------------------------------------------------------------------------------------

def account(name, no_signin=False):
    return capture(wl.cmd_account, name=name, no_signin=no_signin)


def token(name):
    return ml.owner_state(name)['accessToken']


def managed_rows():
    return wl.sql_json(f'select {wl.MAPPING_COLUMNS} from managed_runner order by id')


def managed_writes(name):
    writes = {}
    for action in ('ensure', 'retry', 'wake', 'sleep', 'delete'):
        code, answer = ml.http('POST', f'/managed-runner/{action}', {'idempotencyKey': str(uuid.uuid4()), 'revision': 1}, token=token(name))
        writes[action] = {'status': code, 'code': answer.get('code') if isinstance(answer, dict) else None}
    return writes


def off_accounts(ctx, step, label):
    require_own_server_dir()
    results = {}
    if label == 'unset':
        results['root'] = account('root')
        for name in USERS:
            results[name] = account(name)
    else:
        for name in ('root', *USERS):
            results[name] = account(name)
    for name in ('root', *USERS):
        code, status = ml.http('GET', '/managed-runner', token=token(name))
        writes = managed_writes(name)
        results[f'{name}.status'] = {'http': code, 'enabled': (status or {}).get('enabled'), 'managementState': (status or {}).get('managementState'),
                                     'display': ml.display_of(status) if code == 200 else None}
        results[f'{name}.writes'] = writes
        step.check(f'{name}: the managed status reads disabled', code == 200 and status.get('enabled') is False, status.get('enabled'))
        step.check(f'{name}: every managed write is 404 MANAGED_RUNNER_DISABLED',
                   all(w['status'] == 404 and w['code'] == 'MANAGED_RUNNER_DISABLED' for w in writes.values()), writes)
    capabilities = ml.http('GET', '/auth/capabilities', token=token('ann'))
    results['capabilities'] = {'http': capabilities[0], 'managedRunners': (capabilities[1] or {}).get('managedRunners')
                               if isinstance(capabilities[1], dict) else None}
    rows = managed_rows()
    step.check('no managed runner row was written', not rows, len(rows))
    runners = wl.sql_json('select name, status from runner order by enrolled_at nulls last, id')
    step.check('no runner but the self-managed one', all(r['name'] == SELFHOST_NAME for r in runners), runners)
    return results


# ---- the real self-managed runner ----------------------------------------------------------------------

def selfhost_setup(ctx, step):
    root = ml.owner_state('root')
    home, orbit_home, work = SELFHOST / 'home', SELFHOST / 'orbit-home', SELFHOST / 'work'
    for path in (home, orbit_home, work):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    status, enrollment = ml.http('POST', '/runners/enrollment-tokens', {'label': 't08 self-managed runner'}, token=root['accessToken'])
    if status not in (200, 201):
        raise Failed(f'enrollment-tokens: {status} {enrollment}')
    status, registered = ml.http('POST', '/runner/register', {'enrollmentToken': enrollment['token'], 'name': SELFHOST_NAME,
                                                              'hostname': 't08-selfhost.lab.invalid', 'version': '0.1.0', 'maxConcurrent': 2})
    if status not in (200, 201):
        raise Failed(f'runner/register: {status} {registered}')
    sw.private_write(orbit_home / 'config.json', {'serverUrl': f"http://127.0.0.1:{ENV['LAB_TEST_API_PORT']}", 'runnerId': registered['runnerId'],
                                                  'runnerToken': registered['runnerToken'], 'name': SELFHOST_NAME, 'labels': [],
                                                  'maxConcurrent': 2, 'workDir': str(work)})
    runner = next(r for r in ml.http('GET', '/runners', token=root['accessToken'])[1] if r['name'] == SELFHOST_NAME)
    status, workspace = ml.http('POST', '/workspaces', {'name': 't08 self-managed', 'runnerId': runner['id'], 'workDir': str(work / 'repo'),
                                                        'autoInitGit': True}, token=root['accessToken'])
    if status not in (200, 201):
        raise Failed(f'workspaces: {status} {workspace}')
    # A key the host reaches: fake-model.py on loopback (the Pods' key names 10.0.2.2).
    status, key = ml.http('POST', '/providers/mine', {'label': 'FAKE model on loopback (lab, not a model)', 'presetSlug': 'deepseek',
                                                       'baseUrl': f"http://127.0.0.1:{ENV['LAB_TEST_FAKE_MODEL_PORT']}/anthropic",
                                                       'apiKey': FAKE_KEY}, token=root['accessToken'])
    if status not in (200, 201):
        raise Failed(f'providers/mine: {status} {key}')
    environment = {'HOME': str(home), 'ORBIT_HOME': str(orbit_home), 'PATH': f"{SELFHOST / 'bin'}:/usr/bin:/bin", 'LANG': 'C.UTF-8',
                   'ORBIT_NO_SELFUPDATE': '1', 'ORBIT_NO_ENGINE_UPDATE': '1', 'DISABLE_AUTOUPDATER': '1',
                   'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    properties = ['-p', 'MemoryMax=1536M', '-p', 'OOMScoreAdjust=900', '-p', f'WorkingDirectory={SELFHOST}',
                  '-p', f"StandardOutput=append:{SELFHOST / 'runner.log'}", '-p', f"StandardError=append:{SELFHOST / 'runner.log'}"]
    for name, value in environment.items():
        properties += ['-p', f'Environment={name}={value}']
    if ml.active(SELFHOST_UNIT) != 'active':
        run(['systemd-run', f'--unit={SELFHOST_UNIT}', '--collect', '--quiet', *properties, str(SELFHOST / 'bin/orbit'), 'run'])
    ctx['selfhost'] = {'runnerId': registered['runnerId'], 'runnerPublicId': runner['id'], 'workspaceId': workspace['id'], 'provider': key['slug']}
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        row = wl.sql_json(f"select status, last_heartbeat_at, capabilities_reported_at from runner where id = {wl.quote(registered['runnerId'])}")[0]
        if row['capabilities_reported_at']:
            break
        time.sleep(2)
    engines = wl.sql_json(f"select engines from runner where id = {wl.quote(registered['runnerId'])}")[0]['engines'] or []
    step.check('the self-managed runner reported its engines', bool(row['capabilities_reported_at']), row)
    step.check('Claude Code is installed on it', any(e.get('engine') == 'claude' and e.get('installed') for e in engines),
               [{k: e.get(k) for k in ('engine', 'installed', 'version', 'auth')} for e in engines])
    return {'unit': ml.active(SELFHOST_UNIT), 'runner': {k: runner.get(k) for k in ('id', 'name', 'status')}, 'row': row,
            'engines': [{k: e.get(k) for k in ('engine', 'installed', 'version', 'auth')} for e in engines],
            'workspace': {k: workspace.get(k) for k in ('id', 'name', 'runnerId', 'workDir')}, 'provider': key['slug']}


def wait_text(owner_id, needle, timeout=300, after=None, model_marker=None, event_type=None, session=None):
    """Until a run event of one of the owner's sessions carries the needle; the event, its session and the model's requests
    (fake-model.py's log lines that carry model_marker, or the needle)."""
    deadline = time.monotonic() + timeout
    since = ''
    if after:
        if not re.fullmatch(r'[0-9T:.+-]+', after):
            raise Failed(f'not a timestamp: {after!r}')
        since += f" and e.ingested_at > timestamptz '{after}'"
    if session:
        since += f" and e.session_id = {wl.quote(session)}"
    if event_type:
        since += f" and e.type = {wl.quote(event_type)}"
    while True:
        rows = wl.sql_json(f"select e.session_id, e.seq, e.type, e.created_at, e.ingested_at, e.ingested_by_runner_id from run_event e "
                           f"join session s on s.id = e.session_id where s.owner_id = {wl.quote(owner_id)} and e.payload::text like "
                           f"{wl.quote('%' + needle + '%')}{since} order by e.ingested_at limit 1")
        if rows:
            break
        if time.monotonic() > deadline:
            raise Failed(f'no run event carrying {needle} within {timeout} s')
        time.sleep(1)
    event = rows[0]
    session = wl.sql_json(f"select id, status, assigned_runner_id, task_id, provider, engine, runtime_session_id, created_at "
                          f"from session where id = {wl.quote(event['session_id'])}")[0]
    log = SERVER / 'logs/fake-model.jsonl'
    requests = [json.loads(line) for line in log.read_text().splitlines() if (model_marker or needle) in line] if log.exists() else []
    return {'event': event, 'session': session, 'modelRequests': [{k: r.get(k) for k in ('n', 'at', 'messages', 'kind', 'tool', 'secrets')}
                                                                  for r in requests]}


def answered(owner_id, marker, timeout=300, after=None):
    return wait_text(owner_id, f'Answering: {marker}', timeout, after, model_marker=marker)


def owner_uuid(name):
    return wl.to_uuid(ml.owner_state(name)['user']['id'])


def selfhost_sessions(ctx, step, label):
    own = ctx['selfhost']
    marker = f'T08-SELF-{label.upper()}'
    results = {}
    at = now()
    code, session = ml.http('POST', '/sessions', {'workspaceId': own['workspaceId'], 'title': f't08 self-managed {label}',
                                                  'prompt': f'{marker}-S a session on the self-managed runner', 'provider': own['provider'],
                                                  'permissionMode': 'default'}, token=token('root'))
    step.check('a session on the self-managed workspace is accepted', code in (200, 201), code)
    task_body = lambda suffix, extra: {'title': f'T08 self-managed task {label} {suffix}', 'description': f'{marker}-{suffix} a task on the self-managed runner',
                                       'assigneeId': own['workspaceId'], 'completionCriterion': 'OWNER_CONFIRMED',
                                       'ownerConfirmationReason': 'OWNER_TRADE_OFF', 'provider': own['provider'], **extra}
    code_now, task_now = ml.http('POST', '/tasks', task_body('NOW', {}), token=token('root'))
    run_now = ml.http('POST', f"/tasks/{task_now['id']}/execute", {}, token=token('root')) if code_now in (200, 201) else (code_now, None)
    run_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 20))
    code_at, task_at = ml.http('POST', '/tasks', task_body('AT', {'runAt': run_at}), token=token('root'))
    step.check('a task run now and a task with a run time are accepted', code_now in (200, 201) and run_now[0] in (200, 201) and code_at in (200, 201),
               [code_now, run_now[0], code_at])
    owner = owner_uuid('root')
    for suffix, timeout in (('S', 180), ('NOW', 180), ('AT', 240)):
        found = answered(owner, f'{marker}-{suffix}', timeout=timeout, after=at)
        results[suffix] = found
        step.check(f'{marker}-{suffix} answered on the self-managed runner',
                   found['session']['assigned_runner_id'] == own['runnerId'] and found['event']['ingested_by_runner_id'] == own['runnerId'],
                   found['session']['assigned_runner_id'])
    results['taskRunAt'] = run_at
    results['sessionCreatedAt'] = at
    return results


def off_quiet(ctx, step, label, seconds, demands=()):
    """For SECONDS: no managed row or pool change, no object in the namespace changed, no connection to the gate."""
    connections, before = ml.gate_connections(), ml.namespace_snapshot()
    rows_before = managed_rows()
    pool_before = wl.sql_json('select * from managed_runner_capacity')
    started = now()
    made = [demand() for demand in demands]
    time.sleep(seconds)
    after = ml.namespace_snapshot()
    rows_after = managed_rows()
    log = (SERVER / 'logs/apiserver.log').read_text(errors='replace').splitlines()
    result = {'label': label, 'from': started, 'to': now(), 'waitedSeconds': seconds, 'switch': switch_lines() or ['(unset)'], 'demands': made,
              'mappingRows': len(rows_after), 'mappingsUnchanged': rows_before == rows_after,
              'poolUnchanged': pool_before == wl.sql_json('select * from managed_runner_capacity'),
              'gateConnectionsDuring': ml.gate_connections() - connections, 'apiserverSocketsToTheApi': ml.api_sockets(),
              'namespaceObjects': len(after), 'namespaceUnchanged': before == after, 'changed': sorted(set(before) ^ set(after)),
              'managedLogLinesSinceStart': [line[-220:] for line in log if 'anaged' in line][-8:]}
    step.check('no managed row changed', result['mappingsUnchanged'])
    step.check('the capacity pool did not change', result['poolUnchanged'])
    step.check('no connection reached the gate (the manager\'s only way to k3s)', result['gateConnectionsDuring'] == 0, result['gateConnectionsDuring'])
    step.check('no apiserver socket to the k3s API', not result['apiserverSocketsToTheApi'])
    step.check('no object in the namespace changed', result['namespaceUnchanged'], result['changed'])
    return result


# ---- managed: provisioning --------------------------------------------------------------------------------

def mapping(name):
    return ml.mapping_of(name)


def until(name, state, reason=None, gen_above=-1, timeout=300, reasons=None, pod_not=None):
    """Until NAME's mapping is in STATE (with the reason, or one of the reasons; past a generation; on another Pod than
    pod_not); each change, and the seconds it took."""
    started, deadline, seen = time.monotonic(), time.monotonic() + timeout, []
    while True:
        try:
            m = mapping(name)
            line = {k: m[k] for k in ('management_state', 'generation', 'attempt', 'revision')}
            line['reason'] = (m['last_error'] or {}).get('code')
            line['pod'] = (m['pod_uid'] or '')[:8] or None
            line['drain'] = ('accepted' if m['stop_acknowledged_at'] else 'asked') if m['stop_requested_at'] else None
        except SystemExit as error:
            line = {'error': str(error)}
        if not seen or seen[-1]['line'] != line:
            seen.append({'at': now(), 'line': line})
        if line.get('management_state') == state and line.get('generation', -1) > gen_above \
                and (reason is None or line['reason'] == reason) and (reasons is None or line['reason'] in reasons) \
                and (pod_not is None or (line.get('pod') and line['pod'] != pod_not[:8])):
            return {'reached': state, 'seconds': round(time.monotonic() - started, 1), 'at': now(), 'changes': seen}
        if time.monotonic() > deadline:
            raise Failed(f'{name} not {state}/{reason or reasons} within {timeout} s: {seen[-3:]}')
        time.sleep(0.5)


def identity(name):
    m = mapping(name)
    pv = kget('pv', kget('pvc', m['pvc_name'])['spec']['volumeName'], namespace=None)
    return {'runnerId': m['runner_id'], 'pvcName': m['pvc_name'], 'pvcUid': m['pvc_uid'], 'pvUid': m['pv_uid'], 'volumeHandle': m['volume_handle'],
            'pvName': pv['metadata']['name'], 'rbdImage': pv['spec']['csi']['volumeAttributes'].get('imageName'),
            'pool': pv['spec']['csi']['volumeAttributes'].get('pool'), 'clusterID': pv['spec']['csi']['volumeAttributes'].get('clusterID'),
            'workspaceId': m['default_workspace_id'], 'generation': m['generation'], 'podUid': m['pod_uid']}


def same_identity(step, name, before, after, label):
    keys = ('runnerId', 'pvcName', 'pvcUid', 'pvUid', 'volumeHandle', 'rbdImage', 'workspaceId')
    changed = {key: [before[key], after[key]] for key in keys if before[key] != after[key]}
    step.check(f'{name}: the same runner, PVC, PV, volume handle, RBD image and workspace {label}', not changed, changed or after['rbdImage'])


def gate_summary(since, until=None):
    return capture(wl.cmd_gate_summary, since=since, until=until)


def on_prepare(ctx, step):
    prepared = capture(wl.cmd_prepare, image=IMAGE, source=str(T02A))[0]  # manager-lab.py's: the identity; then wake-lab.py's profile
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t08'
    # TWO runners at a time (each asks 500m and 768Mi, one Pod, one attachment, 1Gi of /tmp): a third account waits.
    profile['capacity'] = {'compute': {'cpu': '1', 'memory': '1536Mi', 'ephemeralStorage': '2Gi', 'pods': 2, 'attachments': 2},
                           'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2}
    # Idle after 90 s, so a scale to zero takes minutes, not a week; a start has 15 minutes.
    profile['lifecycle'].update(idleSeconds=90, startupDeadlineSeconds=900, maxAttempts=5)
    sw.private_write(sw.PROFILE, profile)
    identity_view = prepared.get('identity') or {}
    step.check('the manager\'s identity is the least-privilege ServiceAccount',
               identity_view.get('username') == f'system:serviceaccount:{NAMESPACE}:{sw.MANAGER}', identity_view.get('username'))
    ctx['profile'] = profile
    return {'profile': profile, 'manager': {k: identity_view.get(k) for k in ('username', 'canI', 'rules')}}


def on_start(ctx, step):
    started = start_server('on')
    step.check('the switch is on with the lab profile', switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true',
                                                                          f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'], switch_lines())
    step.check('the replica runs', started['replica']['unit'] == 'active')
    recorder = record('start')
    return {'server': started, 'recorder': recorder}


def provision_concurrent(ctx, step):
    step.check('no admission webhook (the guard is missing)', sw.webhook_view() is None)
    since = now()
    found = {name: ml.owner_state(name) for name in USERS}

    def sign_in(i):
        name = USERS[i % 2]
        port = ml.REPLICA_PORT if (i // 2) % 2 else int(ENV['LAB_TEST_API_PORT'])
        started = time.monotonic()
        status, answer = call_at(port, 'POST', '/auth/login', {'email': found[name]['email'], 'password': found[name]['password']})
        return {'owner': name, 'port': port, 'status': status, 'ms': round((time.monotonic() - started) * 1000, 1),
                'accessToken': answer.get('accessToken') if isinstance(answer, dict) else None,
                'refreshToken': answer.get('refreshToken') if isinstance(answer, dict) else None}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        answers = list(pool.map(sign_in, range(16)))
    for name in USERS:
        last = [a for a in answers if a['owner'] == name and a['status'] in (200, 201)][-1]
        state = ml.owner_state(name)
        state.update(accessToken=last['accessToken'], refreshToken=last['refreshToken'])
        wl.save(name, state)
    step.check('16 concurrent sign-ins over two replicas all answered', all(a['status'] in (200, 201) for a in answers),
               sorted({a['status'] for a in answers}))
    waits = {name: until(name, 'FAILED', reason='ADMISSION_GUARD_MISSING', timeout=180) for name in USERS}
    view = ml.verdict()
    gate = gate_summary(since)
    ids = {name: identity(name) for name in USERS}
    ctx['identity'] = ids
    ctx['firstSignInAt'] = since
    for name in USERS:
        m = mapping(name)
        step.check(f'{name}: one mapping, its PVC made, no Pod', m['pvc_uid'] and not m['pod_uid'], {'pvc': m['pvc_uid'], 'pod': m['pod_uid']})
        status = ml.status_of(name)
        step.check(f'{name}: FAILED ADMISSION_GUARD_MISSING, retryable', status.get('managementState') == 'FAILED'
                   and (status.get('reason') or {}).get('code') == 'ADMISSION_GUARD_MISSING' and (status.get('reason') or {}).get('retryable'),
                   status.get('reason'))
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    counts = wl.sql_json('select (select count(*) from managed_runner) as mappings, (select count(*) from runner) as runners, '
                         '(select count(*) from workspace) as workspaces')[0]
    step.check('two mappings, two managed runners (+ the self-managed one), two managed workspaces (+ its one)',
               counts == {'mappings': 2, 'runners': 3, 'workspaces': 3}, counts)
    kinds = gate['byKind']
    step.check('the gate saw one PVC create, one Secret create and one admission probe per account, no Pod create',
               kinds.get('PVC create') == 2 and kinds.get('Secret create') == 2 and kinds.get('admission probe') == 2 and not kinds.get('Pod create'), kinds)
    return {'signIns': [{k: a[k] for k in ('owner', 'port', 'status', 'ms')} for a in answers], 'untilFailed': waits, 'verdict': view,
            'gate': gate, 'identity': ids, 'counts': counts,
            'display': {name: ml.display_of(ml.status_of(name)) for name in USERS}}


def provision_retry(ctx, step):
    install = capture(sw.cmd_admission, action='install')
    step.check('the admission webhook is installed and refuses a Pod on an unowned managed claim',
               install['webhook'] and install['dryRunUnownedManagedClaim']['exit'] != 0 and install['dryRunUnmanagedPod']['exit'] == 0,
               {k: install[k]['answer'][:160] for k in ('dryRunUnmanagedPod', 'dryRunUnownedManagedClaim')})
    since = now()
    retries = {name: capture(ml.cmd_action, name=name, action='retry') for name in USERS}
    for name in USERS:
        step.check(f'{name}: the owner\'s retry is accepted', retries[name]['status'] == 202, retries[name]['status'])
    starting = {name: until(name, 'STARTING', reason='MODEL_UNAVAILABLE', timeout=240) for name in USERS}
    keys = {name: capture(wl.cmd_key, name=name) for name in USERS}
    ready = {name: until(name, 'READY', timeout=420) for name in USERS}
    gate = gate_summary(since)
    for name in USERS:
        same_identity(step, name, ctx['identity'][name], identity(name), 'after the failure and the retry')
        ctx['identity'][name] = identity(name)
    step.check('the gate saw one Pod create per account after the retry (and no second PVC)',
               gate['byKind'].get('Pod create') == 2 and not gate['byKind'].get('PVC create'), gate['byKind'])
    timings = {name: provisioned(name) for name in USERS}
    return {'install': install, 'retries': {n: {k: r.get(k) for k in ('status', 'before')} for n, r in retries.items()}, 'starting': starting,
            'keys': keys, 'ready': ready, 'gate': gate, 'timings': timings}


def provisioned(name):
    m = mapping(name)
    runner = m['runner_id']
    pvc = kget('pvc', m['pvc_name'])
    pod = kget('pod', f'mr-{runner}')
    secret = kget('secret', f'mr-boot-{runner}')
    row = wl.sql_json(f"select status, enrolled_at, last_heartbeat_at, capabilities_reported_at, version from runner where id = {wl.quote(runner)}")[0]
    created = wl.sql_json(f"select created_at from managed_runner where id = {wl.quote(m['id'])}")[0]['created_at']
    statuses = (pod or {}).get('status', {}).get('containerStatuses') or []
    running = next((s['state']['running']['startedAt'] for s in statuses if s['name'] == 'runner' and 'running' in s.get('state', {})), None)
    return {'mappingCreatedAt': created, 'pvcCreatedAt': pvc['metadata']['creationTimestamp'],
            'secretCreatedAt': secret and secret['metadata']['creationTimestamp'], 'podCreatedAt': pod and pod['metadata']['creationTimestamp'],
            'runnerContainerStartedAt': running, 'readyAt': m['state_entered_at'] if m['management_state'] == 'READY' else None,
            'runner': row, 'generation': m['generation'], 'node': m['node_name'], 'initialProvider': m['initial_provider']}


# ---- capacity -------------------------------------------------------------------------------------------

def capacity_wait(ctx, step):
    for name in USERS:
        step.check(f'{name} is READY: both slots are taken', mapping(name)['management_state'] == 'READY')
    created = account(THIRD, no_signin=True)
    since = now()
    signed = account(THIRD)
    waited = until(THIRD, 'WAITING_CAPACITY', reason='MANAGED_RUNNER_CAPACITY_UNAVAILABLE', timeout=120)
    m = mapping(THIRD)
    status = ml.status_of(THIRD)
    objects = ml.cluster_objects()
    named = [o['metadata']['name'] for key in ('pods', 'pvcs', 'secrets') for o in objects[key] if m['runner_id'] in o['metadata']['name']]
    step.check('cy waits for capacity', (m['last_error'] or {}).get('code') == 'MANAGED_RUNNER_CAPACITY_UNAVAILABLE', m['last_error'])
    step.check('nothing is created for cy while it waits', not named and not m['pvc_uid'], named)
    pool = wl.sql_json('select cpu_millis_reserved, memory_bytes_reserved, pods_reserved, active_users_reserved from managed_runner_capacity')
    step.check('the pool holds two runners', pool and pool[0]['pods_reserved'] == 2 and pool[0]['active_users_reserved'] == 2, pool)
    key = capture(wl.cmd_key, name=THIRD)
    ctx['cyWaitingSince'] = since
    return {'created': created, 'signIn': signed, 'waited': waited, 'status': {k: status.get(k) for k in ('managementState', 'reason', 'retryAfter')},
            'display': ml.display_of(status), 'pool': pool, 'key': key}


# ---- sessions and data -------------------------------------------------------------------------------------

def upload(name, file_name, data):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
            f'Content-Type: text/plain\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    request = urllib.request.Request(sw.API + '/attachments', data=body, method='POST',
                                     headers={'Authorization': 'Bearer ' + token(name), 'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(request, timeout=60) as response:
        answer = json.loads(response.read().decode())
    return {'id': answer['id'], 'fileName': file_name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def first_session(ctx, name):
    word = f'{name}1'
    data = (f'T08 attachment of {name}\n' + os.urandom(24 * 1024).hex() + '\n').encode()
    attachment = upload(name, f't08-{name}-note.txt', data)
    marker = f'T08-{name.upper()}-S1'
    prompt = f'{marker} the first session. T03-SECRET {name}first FAKE-WRITE {word}'
    at = now()
    code, session = ml.http('POST', '/sessions', {'workspaceId': ctx['identity'][name]['workspaceId'], 'prompt': prompt,
                                                  'title': f't08 {name} first session', 'attachmentIds': [attachment['id']]}, token=token(name))
    if code not in (200, 201):
        raise Failed(f'{name}: session create {code} {session}')
    # The Bash call's own result, not the call (whose command names the marker too).
    wrote = wait_text(owner_uuid(name), f'T08-WROTE-{word.upper()}', timeout=240, event_type='tool_result', session=wl.to_uuid(session['id']))
    text = wl.sql_json(f"select payload::text as p from run_event where session_id = {wl.quote(wrote['event']['session_id'])} "
                       f"and type = 'tool_result' and payload::text like {wl.quote('%T08-WROTE-' + word.upper() + '%')} order by seq limit 1")[0]['p']
    found = re.search(rf'T08-WROTE-{word.upper()} ([0-9a-f]{{40}}) ([0-9a-f]{{16}})', text)
    return {'session': session['id'], 'sessionUuid': wl.to_uuid(session['id']), 'createdAt': at, 'attachment': attachment,
            'wrote': {'commit': found and found.group(1), 'fileSha256Prefix': found and found.group(2), 'file': f't08-{word}.txt'},
            'event': wrote, 'secret': f'{name}first'}


def sessions_first(ctx, step):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = dict(zip(USERS, pool.map(lambda n: first_session(ctx, n), USERS)))
    ctx['sessions'] = {name: {'s1': r['session'], 's1Uuid': r['sessionUuid'], 'attachment': r['attachment'], 'wrote': r['wrote'],
                              'secret': r['secret']} for name, r in results.items()}
    for name, r in results.items():
        step.check(f'{name}: the session ran on {name}\'s managed runner', r['event']['session']['assigned_runner_id'] == ctx['identity'][name]['runnerId'],
                   r['event']['session']['assigned_runner_id'])
        step.check(f'{name}: the engine committed a file in the session\'s Git worktree', bool(r['wrote']['commit']), r['wrote'])
    return results


def busy_start(ctx, step):
    at = now()
    # Four minutes of work each, longer than the 90 s idle interval and than the checks made meanwhile.
    turns = {'ann': wl.new_turn('ann', ctx['sessions']['ann']['s1'], 'T08-ANN-BUSY a long turn FAKE-SLOW 240'),
             'bob': wl.new_turn('bob', ctx['sessions']['bob']['s1'], 'T08-BOB-BUSY a background job FAKE-BG 240')}
    step.check('the work outlasts the checks made meanwhile', True, 'FAKE-SLOW 240 and FAKE-BG 240')
    for name, turn in turns.items():
        step.check(f'{name}: the turn is accepted', turn['status'] in (200, 201), turn['status'])
    ctx['busyStartedAt'] = at
    # The background job runs once the model's tool call has been made.
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        jobs = wl.sql_json(f"select running_bg_jobs from session where id = {wl.quote(ctx['sessions']['bob']['s1Uuid'])}")[0]['running_bg_jobs']
        if jobs:
            break
        time.sleep(1)
    step.check('bob: a background job runs on the runner', bool(jobs), jobs)
    return {'at': at, 'turns': turns, 'bobJobs': jobs}


SNAPSHOT = r'''
import hashlib, json, os, sqlite3, subprocess, sys
from pathlib import Path
ROOT = Path(sys.argv[1]); prefix = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
HOME = ROOT / 'home'; ORBIT = HOME / '.orbit'; WS = HOME / 'orbit-repos/default'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def git(d, *a):
    r = subprocess.run(['git', '-C', str(d), *a], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else 'ERROR: ' + r.stderr.strip()[-160:]
def files(root, skip=('.git',)):
    if not root.exists(): return {}
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob('*'))
            if p.is_file() and not p.is_symlink() and not any(x in skip for x in p.relative_to(root).parts)}
def read(p):
    try: return json.loads(p.read_text())
    except Exception: return None
config = read(ORBIT / 'config.json') or {}
mounts = [l.split() for l in Path('/proc/self/mountinfo').read_text().splitlines()]
mount = [{'source': m[m.index('-') + 2], 'fstype': m[m.index('-') + 1]} for m in mounts if m[4] == '/var/lib/orbit']
result = {'runnerId': config.get('runnerId'), 'managedInstance': read(ORBIT / 'managed-instance.json'), 'mount': mount, 'uid': os.getuid(),
          'workspace': {'head': git(WS, 'rev-parse', 'HEAD'), 'worktrees': git(WS, 'worktree', 'list', '--porcelain').splitlines(),
                        'fsckExit': subprocess.run(['git', '-C', str(WS), 'fsck', '--full'], capture_output=True).returncode},
          'worktrees': {}, 'uploads': files(ORBIT / 'uploads', skip=()), 'runs': {}, 'transcripts': {}, 'sqlite': {}, 'prefix': {}}
for wt in sorted((ORBIT / 'worktrees').iterdir()) if (ORBIT / 'worktrees').exists() else []:
    if wt.is_dir():
        result['worktrees'][wt.name] = {'head': git(wt, 'rev-parse', 'HEAD'), 'branch': git(wt, 'branch', '--show-current'),
                                        'status': git(wt, 'status', '--porcelain').splitlines(), 'files': files(wt)}
for meta in sorted((ORBIT / 'runs').glob('*/meta.json')):
    m = read(meta) or {}
    result['runs'][meta.parent.name] = {k: m.get(k) for k in ('provider', 'sessionUuid', 'runtimeSessionId', 'workDir')}
projects = HOME / '.claude' / 'projects'
for p in sorted(projects.rglob('*.jsonl')) if projects.exists() else []:
    lines = p.read_bytes().splitlines(keepends=True)
    key = str(p.relative_to(HOME))
    result['transcripts'][key] = {'sha256': sha(p), 'lines': len(lines)}
    if key in prefix:
        result['prefix'][key] = hashlib.sha256(b''.join(lines[:prefix[key]])).hexdigest()
for p in sorted(set(HOME.rglob('*.sqlite')) | set(HOME.rglob('*.db')) | set(HOME.rglob('*.sqlite3'))):
    try:
        with sqlite3.connect(f'file:{p}?mode=ro', uri=True) as db:
            result['sqlite'][str(p.relative_to(HOME))] = db.execute('PRAGMA integrity_check').fetchone()[0]
    except sqlite3.Error as error:
        result['sqlite'][str(p.relative_to(HOME))] = 'ERROR: ' + str(error)
print(json.dumps(result, sort_keys=True))
'''


def pod_snapshot(name, prefix=None):
    _, pod = ml.running_pod(name)
    view = json.loads(sw.pod_exec(pod['metadata']['name'], 'python3', '-c', SNAPSHOT, '/var/lib/orbit', json.dumps(prefix or {})).stdout)
    view['takenAt'] = now()
    view['podUid'] = pod['metadata']['uid']
    return view


def compare_snapshots(step, name, before, after, label, session_uuid):
    """What a session left on the volume, the same after a sleep, a rebuild or a restore."""
    differences = {}
    for key, digest in before['uploads'].items():
        if after['uploads'].get(key) != digest:
            differences[f'upload {key}'] = [digest, after['uploads'].get(key)]
    for wt, view in before['worktrees'].items():
        other = after['worktrees'].get(wt)
        if not other:
            differences[f'worktree {wt}'] = 'gone'
            continue
        if other['head'] != view['head']:
            differences[f'worktree {wt} head'] = [view['head'], other['head']]
        for path, digest in view['files'].items():
            if other['files'].get(path) != digest:
                differences[f'worktree {wt}/{path}'] = [digest, other['files'].get(path)]
    for path, view in before['transcripts'].items():
        if after['prefix'].get(path) != view['sha256']:
            differences[f'transcript {path}'] = 'its earlier lines changed or are gone'
    if after['runnerId'] != before['runnerId']:
        differences['runnerId'] = [before['runnerId'], after['runnerId']]
    bad = {db: result for db, result in after['sqlite'].items() if result != 'ok'}
    step.check(f'{name}: uploads, worktrees, the engine\'s transcripts and the runner ID as before {label}', not differences, differences or
               {'uploads': len(before['uploads']), 'worktrees': len(before['worktrees']), 'transcripts': len(before['transcripts'])})
    step.check(f'{name}: every SQLite database on the volume passes integrity_check {label}', not bad and after['sqlite'], bad or sorted(after['sqlite']))
    step.check(f'{name}: the session\'s worktree is there {label}', session_uuid in after['worktrees'] or any(session_uuid in w for w in after['worktrees']),
               sorted(after['worktrees']))


def transcript_prefix(before):
    return {path: view['lines'] for path, view in before['transcripts'].items()}


def probes_write(ctx, step, run_name='p1'):
    # One after the other: side by side they contend for the same disk and take three times as long.
    results = {name: capture(wl.cmd_probe, name=name, action='write', run=run_name) for name in USERS}
    for name in USERS:
        step.check(f'{name}: probe {run_name} written (8 MiB random, {PROBE_ROWS} SQLite rows committed one by one in WAL mode with synchronous=FULL, '
                   f'a Git commit), integrity_check ok', results[name]['data']['integrityCheck'] == 'ok' and results[name]['data']['rows'] >= PROBE_ROWS,
                   results[name]['data']['rows'])
    ctx.setdefault('probes', {})[run_name] = {n: r['data'] for n, r in results.items()}
    return results


def snapshots(ctx, step, label):
    views = {}
    for name in USERS:
        views[name] = pod_snapshot(name)
        step.check(f'{name}: /var/lib/orbit is an RBD device, ext4', views[name]['mount'] and views[name]['mount'][0]['source'].startswith('/dev/rbd')
                   and views[name]['mount'][0]['fstype'] == 'ext4', views[name]['mount'])
        step.check(f'{name}: the attachment is on the volume with its checksum',
                   ctx['sessions'][name]['attachment']['sha256'] in views[name]['uploads'].values(), len(views[name]['uploads']))
        wrote = ctx['sessions'][name]['wrote']
        worktree = views[name]['worktrees'].get(ctx['sessions'][name]['s1Uuid'])
        step.check(f'{name}: the engine\'s commit is the session worktree\'s HEAD and its file is there',
                   worktree and worktree['head'] == wrote['commit'] and (worktree['files'].get(wrote['file']) or '').startswith(wrote['fileSha256Prefix']),
                   worktree and {'head': worktree['head'], 'files': sorted(worktree['files'])})
    ctx.setdefault('snapshots', {})[label] = views
    return views


ISOLATION = r'''
import json, os, ssl, urllib.error, urllib.request
from pathlib import Path
mounts = [l.split() for l in Path('/proc/self/mountinfo').read_text().splitlines()]
volumes = [{'target': m[4], 'source': m[m.index('-') + 2], 'fstype': m[m.index('-') + 1]} for m in mounts if m[m.index('-') + 2].startswith('/dev/rbd')]
names = sorted(os.environ)
context = ssl.create_default_context(); context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
api = {}
for path in ('/api/v1/namespaces/orbit-mr-test/secrets', '/api/v1/namespaces/orbit-mr-test/pods', '/api/v1/persistentvolumes'):
    try:
        with urllib.request.urlopen('https://' + os.environ.get('KUBERNETES_SERVICE_HOST', '10.43.0.1') + ':443' + path, context=context, timeout=10) as r:
            api[path] = r.status
    except urllib.error.HTTPError as error:
        api[path] = error.code
    except Exception as error:
        api[path] = type(error).__name__
print(json.dumps({'rbdMounts': volumes, 'serviceAccountToken': Path('/var/run/secrets/kubernetes.io/serviceaccount').exists(),
                  'credentialLikeVariables': [n for n in names if any(w in n for w in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'KUBE'))
                                              and n not in ('KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT', 'KUBERNETES_SERVICE_PORT_HTTPS',
                                                            'KUBERNETES_PORT', 'KUBERNETES_PORT_443_TCP', 'KUBERNETES_PORT_443_TCP_ADDR',
                                                            'KUBERNETES_PORT_443_TCP_PORT', 'KUBERNETES_PORT_443_TCP_PROTO')],
                  'rbdDeviceNodes': sorted(p.name for p in Path('/dev').iterdir() if p.name.startswith('rbd')), 'kubernetesApiAnonymous': api,
                  'uid': os.getuid(), 'capEff': [l.split()[1] for l in Path('/proc/self/status').read_text().splitlines() if l.startswith('CapEff')][0]}))
'''


def isolation(ctx, step):
    cross = {f'{a}->{b}': capture(ml.cmd_cross_user, a=a, b=b) for a, b in (('ann', 'bob'), ('bob', 'ann'))}
    for label, result in cross.items():
        # The owner API names no mapping: B's retry and sleep "at A's revision" act on B's own runner (refused as stale
        # or busy, or B's own), never on A's, which aUnchanged shows. Everything naming A's runner, workspace or instance is refused.
        named = [r for r in result['answers'] if not r['case'].startswith(('B reads its managed runner', "B's retry", "B's sleep"))]
        step.check(f'{label}: every request of the other owner naming this runner, workspace or instance is refused',
                   all(r['status'] in (403, 404) for r in named), [(r['case'], r['status'], r['code']) for r in named])
        step.check(f'{label}: the other owner\'s writes left this mapping as it was', result['aUnchanged'], {'before': result['aBefore'], 'after': result['aAfter']})
        step.check(f'{label}: the admission guard refuses Pods mixing the two owners and volumes',
                   all(g['exit'] != 0 for g in result['admission']) and result['admission'], [g['answer'][:120] for g in result['admission']])
    sessions = {}
    for owner, other in (('ann', 'bob'), ('bob', 'ann')):
        theirs = ctx['sessions'][other]
        asks = {'read the session': ml.http('GET', f"/sessions/{theirs['s1']}", token=token(owner))[0],
                'read its events': ml.http('GET', f"/sessions/{theirs['s1']}/events/page?after=0&limit=5", token=token(owner))[0],
                'send it a turn': ml.http('POST', f"/sessions/{theirs['s1']}/turns", {'clientTurnId': str(uuid.uuid4()), 'content': 'T08 not yours'},
                                          token=token(owner))[0],
                'read the attachment': ml.http('GET', f"/attachments/{theirs['attachment']['id']}", token=token(owner))[0],
                'make a session in its workspace': ml.http('POST', '/sessions', {'workspaceId': ctx['identity'][other]['workspaceId'],
                                                                                 'prompt': 'T08 not yours'}, token=token(owner))[0]}
        sessions[f'{owner} on {other}\'s'] = asks
        step.check(f'{owner} cannot read or act on {other}\'s session, attachment or workspace', all(code in (403, 404) for code in asks.values()), asks)
    inside = {}
    for name in USERS:
        _, pod = ml.running_pod(name)
        inside[name] = json.loads(sw.pod_exec(pod['metadata']['name'], 'python3', '-c', ISOLATION).stdout)
        view = inside[name]
        step.check(f'{name}: one RBD filesystem in the runner, at /var/lib/orbit', [v['target'] for v in view['rbdMounts']] == ['/var/lib/orbit'], view['rbdMounts'])
        step.check(f'{name}: no service account token, no credential variable, no RBD device node',
                   not view['serviceAccountToken'] and not view['credentialLikeVariables'] and not view['rbdDeviceNodes'],
                   {k: view[k] for k in ('serviceAccountToken', 'credentialLikeVariables', 'rbdDeviceNodes')})
        step.check(f'{name}: the Kubernetes API gives the runner nothing (refused as anonymous, or unreachable)',
                   all(code in (401, 403) or isinstance(code, str) for code in view['kubernetesApiAnonymous'].values()), view['kubernetesApiAnonymous'])
    images = {name: ctx['identity'][name]['rbdImage'] for name in USERS}
    step.check('the two accounts have two different RBD images', len(set(images.values())) == 2, images)
    # A second Pod on a runner's claim, on the same (only) node, while the runner's Pod runs: refused by the guard.
    # Server-side dry runs go through admission exactly as a create does and leave nothing behind (T02a made them for real).
    second = {}
    for name in USERS:
        m, pod = ml.running_pod(name)
        attempts = {
            'an unlabelled Pod on the claim, by the cluster admin': sw.dry_run(sw.contender(f't08-second-{name}', m, None)),
            'a copy of the runner\'s Pod under another name, by the manager': sw.dry_run(sw.contender(f't08-copy-{name}', m, pod, labelled=True), manager=True),
        }
        second[name] = {'runnerPod': pod['metadata']['uid'], 'attempts': attempts}
        step.check(f'{name}: a second Pod on the same node and claim is refused by the admission guard',
                   all(a['exit'] != 0 and 'pods.managed-runner.orbit.dev' in a['answer'] for a in attempts.values()),
                   {label: a['answer'][:160] for label, a in attempts.items()})
        step.check(f'{name}: the runner\'s own Pod still runs', ml.running_pod(name)[1]['metadata']['uid'] == pod['metadata']['uid'])
    return {'crossUser': cross, 'sessions': sessions, 'inPod': inside, 'rbdImages': images, 'secondPodSameNode': second}


def busy_refuse_sleep(ctx, step):
    wait = 110 - seconds_between(ctx['busyStartedAt'], now())
    if wait > 0:
        time.sleep(wait)
    results = {}
    for name in USERS:
        row = wl.sql_json(f"select managed_workload from runner where id = {wl.quote(ctx['identity'][name]['runnerId'])}")[0]['managed_workload']
        action = capture(ml.cmd_action, name=name, action='sleep')
        m = mapping(name)
        results[name] = {'secondsSinceBusyStart': seconds_between(ctx['busyStartedAt'], now()), 'workload': row,
                         'sleep': {'status': action['status'], 'code': (action['answer'] or {}).get('code')}, 'state': m['management_state']}
        step.check(f'{name}: READY past the 90 s idle interval while busy', m['management_state'] == 'READY' and not m['stop_requested_at'],
                   m['management_state'])
        step.check(f'{name}: the owner\'s sleep is refused 409 MANAGED_RUNNER_BUSY', action['status'] == 409
                   and (action['answer'] or {}).get('code') == 'MANAGED_RUNNER_BUSY', results[name]['sleep'])
    return results


def busy_end(ctx, step):
    slow = answered(owner_uuid('ann'), 'T08-ANN-BUSY', timeout=300, after=ctx['busyStartedAt'])
    deadline, jobs = time.monotonic() + 300, []
    while time.monotonic() < deadline:
        jobs = wl.sql_json(f"select job_id, status, exit_code, reason, created_at, updated_at from background_job_wake "
                           f"where session_id = {wl.quote(ctx['sessions']['bob']['s1Uuid'])} order by created_at")
        if jobs and jobs[-1].get('exit_code') is not None:
            break
        time.sleep(2)
    step.check('ann: the long turn was answered', bool(slow))
    step.check('bob: the background job ran out and exited 0', jobs and jobs[-1].get('exit_code') == 0, jobs)
    ctx['busyEndedAt'] = now()
    return {'annSlowTurn': slow, 'bobJobs': jobs}


# ---- sleep and capacity ------------------------------------------------------------------------------------

def storage_view(name):
    sw.OWNER = name
    return capture(sw.cmd_storage)


def watchers(storage):
    """The RBD clients watching the image (rbd status), or the raw answer when it is not JSON."""
    status = storage['ceph']['rbdStatus']
    return status.get('watchers') if isinstance(status, dict) else status


def idle_sleep(ctx, step):
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        waits = dict(zip(USERS, pool.map(lambda n: until(n, 'SLEEPING', timeout=480), USERS)))
    for name in USERS:
        m = mapping(name)
        storage = storage_view(name)
        results[name] = {'until': waits[name], 'stopRequestedAt': m['stop_requested_at'], 'sleptAt': m['state_entered_at'], 'storage': storage}
        step.check(f'{name}: asleep, its Pod gone and its volume detached',
                   not storage['objects']['pod'] and not storage['objects']['volumeAttachments'] and not storage['objects']['podsUsingTheClaim'],
                   {k: storage['objects'][k] for k in ('podsUsingTheClaim', 'volumeAttachments')})
        step.check(f'{name}: the PVC is kept, bound to the same PV', storage['objects']['pvc']['uid'] == ctx['identity'][name]['pvcUid']
                   and storage['objects']['pvc']['phase'] == 'Bound', storage['objects']['pvc']['uid'])
        step.check(f'{name}: no compute held while asleep', not (m['reservation'] or {}).get('compute'), (m['reservation'] or {}).get('compute'))
        step.check(f'{name}: no RBD client holds the image while asleep', watchers(storage) == [], watchers(storage))
    return results


def capacity_admitted(ctx, step):
    ready = until(THIRD, 'READY', timeout=600)
    first_sleep = min(wl.sql_json(f"select state_entered_at from managed_runner where runner_id = {wl.quote(ctx['identity'][n]['runnerId'])}")[0]['state_entered_at']
                      for n in USERS)
    times = provisioned(THIRD)
    step.check('cy was admitted only after a runner slept', times['pvcCreatedAt'] >= first_sleep[:19], {'pvc': times['pvcCreatedAt'], 'firstSleep': first_sleep})
    ctx['identity'][THIRD] = identity(THIRD)
    sleep = capture(ml.cmd_action, name=THIRD, action='sleep')
    slept = until(THIRD, 'SLEEPING', timeout=300)
    step.check('cy: the owner\'s sleep is accepted and cy sleeps', sleep['status'] == 202, sleep['status'])
    return {'ready': ready, 'firstSleepAt': first_sleep, 'times': times, 'sleep': {'status': sleep['status']}, 'slept': slept}


# ---- wake ---------------------------------------------------------------------------------------------------

def ensure_ready(name, marker):
    if mapping(name)['management_state'] == 'READY':
        return None
    turn = wl.new_turn(name, ctx_session(name), f'{marker} a message to wake the runner')
    found = answered(owner_uuid(name), marker, timeout=360, after=turn['at'])
    until(name, 'READY', timeout=120)
    return {'turn': turn, 'answered': found}


def ctx_session(name):
    return load_context()['sessions'][name]['s1']


def refresh(names, marker):
    """A message to each runner, answered, so that its idle interval starts again now (waking it first if it slept):
    what follows has the whole interval before the runner may drain."""
    def one(name):
        turn = wl.new_turn(name, ctx_session(name), f'T08-{name.upper()}-{marker} a message before the next step')
        found = answered(owner_uuid(name), f'T08-{name.upper()}-{marker}', timeout=420, after=turn['at'])
        until(name, 'READY', timeout=120)
        return {'turn': turn, 'answeredAt': found['event']['ingested_at']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(names)) as pool:
        return dict(zip(names, pool.map(one, names)))


def ensure_asleep(name):
    m = mapping(name)
    if m['management_state'] == 'SLEEPING':
        return None
    action = capture(ml.cmd_action, name=name, action='sleep')
    return {'sleep': action['status'], 'until': until(name, 'SLEEPING', timeout=300)}


def continuation_check(step, name, found, secret, label):
    requests = [r for r in found['modelRequests'] if r.get('kind') == 'text']
    last = requests[-1] if requests else {}
    step.check(f'{name}: the engine resumed the session {label}: its request carried the earlier conversation',
               secret in (last.get('secrets') or []) and (last.get('messages') or 0) > 2, {k: last.get(k) for k in ('messages', 'secrets')})


def wake_interactive(ctx, step):
    # A sleep retires the generation that ran: asleep, the mapping already names the next one. So a wake's next
    # generation is judged against the runner as last seen awake.
    awake = ctx['identity']['ann']
    before = identity('ann')
    step.check('ann is asleep', mapping('ann')['management_state'] == 'SLEEPING')
    snap_before = ctx['snapshots']['awake']['ann']
    at = now()
    turn = wl.new_turn('ann', ctx['sessions']['ann']['s1'], 'T08-ANN-WAKE1 a message to the sleeping runner')
    found = answered(owner_uuid('ann'), 'T08-ANN-WAKE1', timeout=360, after=at)
    after = identity('ann')
    same_identity(step, 'ann', before, after, 'after the wake')
    step.check('ann: a new Pod of a later generation than the one that slept', after['generation'] > awake['generation']
               and after['podUid'] not in (None, awake['podUid']), {'slept': [awake['generation'], awake['podUid']], 'woken': [after['generation'], after['podUid']]})
    continuation_check(step, 'ann', found, ctx['sessions']['ann']['secret'], 'after the wake')
    probe = capture(wl.cmd_probe, name='ann', action='check', run='p1')
    step.check('ann: the probe data unchanged (random bytes, SQLite rows, Git commit), integrity_check ok', probe['allSame'], probe['same'])
    snap_after = pod_snapshot('ann', transcript_prefix(snap_before))
    compare_snapshots(step, 'ann', snap_before, snap_after, 'after the wake', ctx['sessions']['ann']['s1Uuid'])
    ctx['identity']['ann'] = after
    return {'turnAt': at, 'turn': turn, 'answered': found, 'answeredAfterSeconds': seconds_between(at, found['event']['ingested_at']),
            'times': provisioned('ann'), 'identityAwake': awake, 'identityBefore': before, 'identityAfter': after, 'probe': probe, 'snapshot': snap_after}


def wake_background(ctx, step):
    awake = ctx['identity']['bob']
    before = identity('bob')
    step.check('bob is asleep', mapping('bob')['management_state'] == 'SLEEPING')
    created = wl.new_task('bob', 'T08-BOB-TASK1 a task run at its time on the sleeping runner', run_at_seconds=45, title='t08 bob scheduled task')
    step.check('bob: the scheduled task is accepted', created['status'] in (200, 201), created['status'])
    found = answered(owner_uuid('bob'), 'T08-BOB-TASK1', timeout=420, after=created['at'])
    after = identity('bob')
    same_identity(step, 'bob', before, after, 'after the scheduled wake')
    step.check('bob: a new Pod of a later generation than the one that slept', after['generation'] > awake['generation']
               and after['podUid'] not in (None, awake['podUid']), {'slept': [awake['generation'], awake['podUid']], 'woken': [after['generation'], after['podUid']]})
    step.check('bob: the task\'s run went to bob\'s managed runner', found['session']['assigned_runner_id'] == after['runnerId']
               and found['session']['task_id'], found['session'])
    message = wl.new_turn('bob', ctx['sessions']['bob']['s1'], 'T08-BOB-WAKE1 a message once awake')
    resumed = answered(owner_uuid('bob'), 'T08-BOB-WAKE1', timeout=240, after=message['at'])
    continuation_check(step, 'bob', resumed, ctx['sessions']['bob']['secret'], 'after the scheduled wake')
    probe = capture(wl.cmd_probe, name='bob', action='check', run='p1')
    step.check('bob: the probe data unchanged, integrity_check ok', probe['allSame'], probe['same'])
    snap_before = ctx['snapshots']['awake']['bob']
    snap_after = pod_snapshot('bob', transcript_prefix(snap_before))
    compare_snapshots(step, 'bob', snap_before, snap_after, 'after the wake', ctx['sessions']['bob']['s1Uuid'])
    ctx['identity']['bob'] = after
    return {'task': created, 'dueAt': created['runAt'], 'answered': found, 'answeredAfterDueSeconds': seconds_between(created['runAt'], found['event']['ingested_at']),
            'message': message, 'resumed': resumed, 'times': provisioned('bob'), 'identityAwake': awake, 'identityBefore': before, 'identityAfter': after,
            'probe': probe, 'snapshot': snap_after}


# ---- rebuild ---------------------------------------------------------------------------------------------------

def rebuild(ctx, step):
    ready = refresh(USERS, 'PRE-REBUILD')
    before = {name: identity(name) for name in USERS}
    snaps = {name: pod_snapshot(name) for name in USERS}
    since = now()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        deleted = pool.submit(capture, ml.cmd_delete, name='ann', force=False)
        killed = pool.submit(capture, ml.cmd_kill_runner, name='bob')
        deleted, killed = deleted.result(), killed.result()
    step.check('ann: the operator\'s delete leaves the Pod held by the stop-report finalizer',
               'orbit.dev/managed-runner-stop-report' in (deleted.get('finalizersRightAfter') or []), deleted.get('finalizersRightAfter'))
    step.check('bob: the killed runner\'s Pod failed', (killed.get('ended') or {}).get('phase') == 'Failed', (killed.get('ended') or {}).get('phase'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        waits = dict(zip(USERS, pool.map(lambda n: until(n, 'READY', gen_above=before[n]['generation'], timeout=420), USERS)))
    results = {'ensureReady': ready, 'deleted': deleted, 'killed': {k: killed.get(k) for k in ('sentAt', 'signal', 'pod', 'generation', 'timeline', 'ended')},
               'ready': waits}
    for name in USERS:
        after = identity(name)
        same_identity(step, name, before[name], after, 'after the rebuild')
        step.check(f'{name}: a new Pod of the next generation', after['podUid'] != before[name]['podUid'] and after['generation'] > before[name]['generation'],
                   [before[name]['generation'], after['generation']])
        marker = f'T08-{name.upper()}-REBUILT'
        turn = wl.new_turn(name, ctx['sessions'][name]['s1'], f'{marker} a message after the rebuild')
        found = answered(owner_uuid(name), marker, timeout=240, after=turn['at'])
        continuation_check(step, name, found, ctx['sessions'][name]['secret'], 'after the rebuild')
        probe = capture(wl.cmd_probe, name=name, action='check', run='p1')
        step.check(f'{name}: the probe data unchanged after the rebuild, integrity_check ok', probe['allSame'], probe['same'])
        snap = pod_snapshot(name, transcript_prefix(snaps[name]))
        compare_snapshots(step, name, snaps[name], snap, 'after the rebuild', ctx['sessions'][name]['s1Uuid'])
        results[name] = {'identityBefore': before[name], 'identityAfter': after, 'turn': turn, 'answered': found, 'probe': probe,
                         'times': provisioned(name), 'snapshotBefore': snaps[name], 'snapshotAfter': snap}
        ctx['identity'][name] = after
    results['gate'] = gate_summary(since)
    step.check('the gate saw exactly two Pod creates (one next generation each)', results['gate']['byKind'].get('Pod create') == 2, results['gate']['byKind'])
    return results


# ---- the controller restarted -----------------------------------------------------------------------------------

def controller_restart(ctx, step):
    ensure = {'ann': ensure_ready('ann', 'T08-ANN-PRE-CONTROLLER')}
    ann_before = identity('ann')
    long_turn = wl.new_turn('ann', ctx['sessions']['ann']['s1'], 'T08-ANN-THROUGH a turn running through the controller restart FAKE-SLOW 200')
    bob_awake = identity('bob') if mapping('bob')['management_state'] == 'READY' else ctx['identity']['bob']
    ensure['bob'] = ensure_asleep('bob')
    bob_before = identity('bob')
    since = now()
    wake = wl.new_turn('bob', ctx['sessions']['bob']['s1'], 'T08-BOB-CONTROLLER a message while the controller restarts')
    deadline = time.monotonic() + 120
    while mapping('bob')['management_state'] == 'SLEEPING':  # the wake has begun: the controller dies in the middle of it
        if time.monotonic() > deadline:
            raise Failed('bob was not woken within 120 s')
        time.sleep(0.2)
    starting = {'at': now(), 'state': mapping('bob')['management_state']}
    at_kill = {name: {k: mapping(name)[k] for k in ('management_state', 'generation', 'pod_uid', 'resource_operation_kind', 'resource_operation_state')}
               for name in USERS}
    killed_at = now()
    for unit in API_UNITS:
        ml.systemd('kill', '--signal=SIGKILL', unit, check=False)
    deadline = time.monotonic() + 30
    while any(ml.active(unit) == 'active' for unit in API_UNITS) and time.monotonic() < deadline:
        time.sleep(0.5)
    down = {unit: ml.active(unit) for unit in API_UNITS}
    time.sleep(5)
    pods_while_down = {name: (lambda p: p and {'uid': p['metadata']['uid'], 'phase': p['status'].get('phase')})(kget('pod', f"mr-{ctx['identity'][name]['runnerId']}"))
                       for name in USERS}
    restarted = start_server('on')
    ready = until('bob', 'READY', gen_above=bob_awake['generation'], pod_not=bob_awake['podUid'], timeout=480)
    answered_bob = answered(owner_uuid('bob'), 'T08-BOB-CONTROLLER', timeout=300, after=wake['at'])
    answered_ann = answered(owner_uuid('ann'), 'T08-ANN-THROUGH', timeout=360, after=long_turn['at'])
    ann_after = identity('ann')
    bob_after = identity('bob')
    view = ml.verdict()
    gate = gate_summary(since)
    step.check('both apiservers were down', all(state != 'active' for state in down.values()), down)
    step.check('ann: the same Pod and generation through the restart', ann_after['podUid'] == ann_before['podUid']
               and ann_after['generation'] == ann_before['generation'], [ann_before['podUid'], ann_after['podUid']])
    step.check('ann: the turn that ran through the restart was answered', bool(answered_ann))
    step.check('bob: READY after the restart, the waiting message answered', bool(answered_bob))
    same_identity(step, 'bob', bob_before, bob_after, 'after the controller restart')
    step.check('the database and k3s agree after the restart', not view['problems'], view['problems'])
    step.check('no second Pod create for bob\'s one wake', (gate['byKind'].get('Pod create') or 0) <= 1, gate['byKind'])
    ctx['identity'].update(ann=ann_after, bob=bob_after)
    return {'ensure': ensure, 'longTurn': long_turn, 'wake': wake, 'starting': starting, 'atKill': at_kill, 'killedAt': killed_at,
            'unitsDown': down, 'podsWhileDown': pods_while_down, 'restarted': restarted, 'bobReady': ready, 'answered': {'bob': answered_bob, 'ann': answered_ann},
            'verdict': view, 'gate': gate, 'identity': {'annBefore': ann_before, 'annAfter': ann_after, 'bobBefore': bob_before, 'bobAfter': bob_after}}


# ---- the runner image rolled back and forward ---------------------------------------------------------------------

def pod_images(name):
    pod = kget('pod', f"mr-{ctx_identity(name)['runnerId']}")
    if not pod:
        return None
    return {'uid': pod['metadata']['uid'], 'spec': sorted({c['image'] for c in pod['spec'].get('initContainers', []) + pod['spec']['containers']}),
            'imageIDs': sorted({s.get('imageID') for s in (pod['status'].get('initContainerStatuses') or []) + (pod['status'].get('containerStatuses') or [])})}


def ctx_identity(name):
    return load_context()['identity'][name]


def image_switch(ctx, step, image, label):
    """The profile's image pin changed and the apiservers restarted: the running Pod keeps its image, the next generation runs the pin."""
    ensure = refresh(['ann'], f'PRE-{label.upper()}')
    before = identity('ann')
    running = pod_images('ann')
    profile = json.loads(sw.PROFILE.read_text())
    pinned_before = profile['runner']['image']
    profile['runner']['image'] = image
    sw.private_write(sw.PROFILE, profile)
    restarted = start_server('on')
    kept = pod_images('ann')
    step.check('the running Pod keeps its image through the restart', kept and kept['uid'] == running['uid'] and kept['spec'] == running['spec'],
               {'before': running, 'after': kept})
    slept = ensure_asleep('ann')
    marker = f'T08-ANN-{label.upper()}'
    turn = wl.new_turn('ann', ctx['sessions']['ann']['s1'], f'{marker} a message after the image {label}')
    found = answered(owner_uuid('ann'), marker, timeout=420, after=turn['at'])
    after = identity('ann')
    ctx['identity']['ann'] = after
    save_context(ctx)
    images = pod_images('ann')
    step.check(f'the next generation runs the pinned image ({label})', images and images['spec'] == [image], images)
    step.check('a new Pod of the next generation', after['generation'] > before['generation'] and images and images['uid'] != running['uid'],
               [before['generation'], after['generation']])
    same_identity(step, 'ann', before, after, f'after the image {label}')
    continuation_check(step, 'ann', found, ctx['sessions']['ann']['secret'], f'after the image {label}')
    probe = capture(wl.cmd_probe, name='ann', action='check', run='p1')
    step.check(f'ann: the probe data unchanged after the image {label}, integrity_check ok', probe['allSame'], probe['same'])
    return {'ensure': ensure, 'pinnedBefore': pinned_before, 'pinned': image, 'restarted': restarted, 'runningBefore': running,
            'runningAfterRestart': kept, 'slept': slept, 'turn': turn, 'answered': found, 'imagesAfter': images,
            'identityBefore': before, 'identityAfter': after, 'probe': probe}


# ---- backup and restore ------------------------------------------------------------------------------------------

def backup_prepare(ctx, step):
    ensure = ensure_ready('ann', 'T08-ANN-PRE-BACKUP')
    # A turn keeps the runner from its idle drain while the probe writes (about 100 s here).
    keeper = wl.new_turn('ann', ctx['sessions']['ann']['s1'], 'T08-ANN-KEEP a turn while the probe writes FAKE-SLOW 150')
    run_name = 'b' + time.strftime('%H%M%S', time.gmtime())  # the data written for this backup
    probe = capture(wl.cmd_probe, name='ann', action='write', run=run_name)
    kept = answered(owner_uuid('ann'), 'T08-ANN-KEEP', timeout=300, after=keeper['at'])
    step.check('ann stayed READY through the probe', mapping('ann')['management_state'] == 'READY')
    snap = pod_snapshot('ann')
    disabled = capture(wl.cmd_disable, name='ann', action='on')
    slept = until('ann', 'SLEEPING', timeout=300)
    storage = storage_view('ann')
    step.check('ann is disabled: held asleep for the backup', disabled['status'] == 200, disabled['status'])
    step.check('ann: no Pod and no attachment on the volume', not storage['objects']['podsUsingTheClaim'] and not storage['objects']['volumeAttachments'])
    step.check('ann: no RBD client watches the image', watchers(storage) == [], watchers(storage))
    ctx['backup'] = {'probe': probe['data'], 'probeRun': run_name, 'snapshot': snap, 'identity': identity('ann')}
    ctx.setdefault('probes', {}).setdefault(run_name, {})['ann'] = probe['data']
    return {'ensure': ensure, 'keeper': keeper, 'kept': kept, 'probe': probe, 'snapshot': snap, 'disabled': disabled, 'slept': slept,
            'storage': storage}


def backup_export(ctx, step):
    ident = ctx['backup']['identity']
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    image = f"{ident['pool']}/{ident['rbdImage']}"
    destination = BACKUPS / f't08-{stamp}'
    destination.mkdir(mode=0o700, parents=True)
    os.chmod(BACKUPS, 0o700)
    info_before = json.loads(ceph_shell(f'rbd info --format json {shlex.quote(image)}'))
    status_before = json.loads(ceph_shell(f'rbd status --format json {shlex.quote(image)}'))
    step.check('the image has no watcher: nothing maps it', not status_before.get('watchers'), status_before.get('watchers'))
    guest(f'sudo install -d -m 0700 {GUEST_BACKUP}')
    started = time.monotonic()
    exported = ceph_shell(f'set -o pipefail; rbd export --no-progress {shlex.quote(image)} - | tee >(sha256sum > /work/raw.sha256) | gzip -1 > /work/volume.img.gz '
                          f'&& sleep 1 && cat /work/raw.sha256 && sha256sum /work/volume.img.gz && stat -c %s /work/volume.img.gz', mount=GUEST_BACKUP)
    export_seconds = round(time.monotonic() - started, 1)
    sums = re.findall(r'^([0-9a-f]{64})\s+(\S+)$', exported, re.M)
    raw_sha = next(s for s, f in sums if f == '-')
    gz_sha = next(s for s, f in sums if f.endswith('volume.img.gz'))
    started = time.monotonic()
    guest_to_file(f'sudo cat {GUEST_BACKUP}/volume.img.gz', destination / 'volume.img.gz')
    copy_seconds = round(time.monotonic() - started, 1)
    host_gz = sha256_file(destination / 'volume.img.gz')
    guest(f'sudo rm -f {GUEST_BACKUP}/volume.img.gz {GUEST_BACKUP}/raw.sha256 && sudo rmdir {GUEST_BACKUP}')
    os.chmod(destination / 'volume.img.gz', 0o600)
    manifest = {'schemaVersion': 1, 'kind': 'orbit-managed-runner-rbd-export', 'createdAt': now(), 'source': {
        'owner': ml.owner_state('ann')['user']['id'], 'runnerId': ident['runnerId'], 'namespace': NAMESPACE, 'pvc': {'name': ident['pvcName'], 'uid': ident['pvcUid']},
        'pv': {'name': ident['pvName'], 'uid': ident['pvUid']}, 'volumeHandle': ident['volumeHandle'], 'clusterID': ident['clusterID'],
        'pool': ident['pool'], 'image': ident['rbdImage'], 'imageId': info_before.get('id'), 'sizeBytes': info_before.get('size'),
        'features': info_before.get('features'), 'generationAtBackup': ident['generation']},
        'quiescence': {'mappingState': mapping('ann')['management_state'], 'accountDisabled': True, 'watchers': status_before.get('watchers')},
        'file': 'volume.img.gz', 'format': 'rbd export (raw image), gzip -1', 'rawSha256': raw_sha, 'gzipSha256': gz_sha,
        'gzipBytes': (destination / 'volume.img.gz').stat().st_size}
    sw.private_write(destination / 'manifest.json', manifest)
    step.check('the archive arrived on the host intact', host_gz == gz_sha, {'guest': gz_sha[:16], 'host': host_gz[:16]})
    step.check('the backup is outside the VM, on the host\'s /mnt/data', str(destination).startswith('/mnt/data/'), str(destination))
    ctx['backup'].update(dir=str(destination), rawSha256=raw_sha, gzipSha256=gz_sha, stamp=stamp, originalImageId=info_before.get('id'))
    return {'destination': str(destination), 'manifest': manifest, 'exportSeconds': export_seconds, 'copySeconds': copy_seconds,
            'rbdInfo': info_before, 'rbdStatus': status_before}


def backup_verify_offline(ctx, step):
    """The archive alone, on the host: no cluster, no Ceph, no kernel module, no mount (debugfs reads the ext4 image)."""
    destination = Path(ctx['backup']['dir'])
    work = destination / 'verify'
    work.mkdir(mode=0o700)
    raw = work / 'volume.img'
    started = time.monotonic()
    decompress = subprocess.Popen(['gzip', '-dc', str(destination / 'volume.img.gz')], stdout=subprocess.PIPE)
    subprocess.run(['dd', f'of={raw}', 'bs=1M', 'conv=sparse', 'status=none'], stdin=decompress.stdout, check=True)
    decompress.wait()
    raw_sha = sha256_file(raw)
    step.check('the archive decompresses to the exported image (SHA-256)', raw_sha == ctx['backup']['rawSha256'], raw_sha[:16])
    fs = run(['debugfs', '-R', 'stats', str(raw)], check=False).stdout
    fields = dict(re.findall(r'^(Filesystem UUID|Filesystem state|Block count|Inode count|Filesystem created):\s+(.*)$', fs, re.M))
    tree = work / 'tree'
    tree.mkdir(mode=0o700)
    dump = run(['debugfs', '-R', f'rdump /home {tree}', str(raw)], check=False)
    # The copy's files belong to the runner's UID, not to root: git checks them only with safe.directory.
    safe = {**os.environ, 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
    view = json.loads(run([sys.executable, '-I', '-c', SNAPSHOT, str(tree), json.dumps(transcript_prefix(ctx['backup']['snapshot']))], env=safe).stdout)
    probe_root = tree / 'home/t08-probe' / ctx['backup']['probeRun']
    probe = json.loads(run([sys.executable, '-I', '-c', wl.PROBE, 'check', str(probe_root)], env=safe).stdout)
    expected = ctx['backup']['probe']
    same = {key: expected[key] == probe[key] for key in ('randomSha256', 'rows', 'rowsSha256', 'gitHead')}
    step.check('ext4 is clean in the image', fields.get('Filesystem state') == 'clean', fields.get('Filesystem state'))
    step.check('the probe written before the backup is in it: same random bytes, SQLite rows and Git commit, integrity_check ok',
               all(same.values()) and probe['integrityCheck'] == 'ok' and probe['gitFsckExit'] == 0, same)
    snap = ctx['backup']['snapshot']
    missing_uploads = {k: v for k, v in snap['uploads'].items() if view['uploads'].get(k) != v}
    step.check('every upload of the runner is in it with its checksum', not missing_uploads, missing_uploads or len(snap['uploads']))
    wrote = ctx['sessions']['ann']['wrote']
    repo = tree / 'home/orbit-repos/default'
    shown = run(['git', '-C', str(repo), 'show', f"{wrote['commit']}:{wrote['file']}"], check=False, env=safe)
    step.check('the engine\'s commit is in the workspace repository, its file with its checksum',
               shown.returncode == 0 and hashlib.sha256(shown.stdout.encode()).hexdigest().startswith(wrote['fileSha256Prefix']), shown.returncode)
    bad = {db: r for db, r in view['sqlite'].items() if r != 'ok'}
    step.check('every SQLite database in it passes integrity_check', not bad and view['sqlite'], bad or sorted(view['sqlite']))
    step.check('the workspace repository passes git fsck', view['workspace']['fsckExit'] == 0, view['workspace']['fsckExit'])
    step.check('the runner identity in it is ann\'s runner', view['runnerId'] == snap['runnerId'], view['runnerId'])
    changed = [path for path, v in snap['transcripts'].items() if view['prefix'].get(path) != v['sha256']]
    step.check('the engine\'s transcripts are in it as they were', not changed, changed or len(snap['transcripts']))
    seconds = round(time.monotonic() - started, 1)
    # The copy holds the runner's credentials: only the results stay.
    shutil.rmtree(work)
    return {'seconds': seconds, 'rawSha256': raw_sha, 'ext4': fields, 'rdumpExit': dump.returncode, 'probe': probe, 'same': same,
            'sqlite': view['sqlite'], 'uploads': len(view['uploads']), 'transcripts': len(view['transcripts']), 'workspaceFsckExit': view['workspace']['fsckExit'],
            'extractedCopyRemoved': not work.exists()}


VERIFY_POD_SCRIPT = SNAPSHOT.replace("print(json.dumps(result, sort_keys=True))", r'''
dev = [m for m in result['mount']]
rbd = {}
for m in dev:
    name = m['source'].rsplit('/', 1)[-1]
    if name.startswith('rbd'):
        base = Path('/sys/bus/rbd/devices') / name[3:]
        rbd = {k: (base / k).read_text().strip() for k in ('pool', 'name') if (base / k).exists()}
result['rbdDevice'] = rbd
import subprocess as sp
probe = sp.run([sys.executable, '-c', sys.argv[3], 'check', sys.argv[4]], capture_output=True, text=True)
result['probe'] = json.loads(probe.stdout) if probe.returncode == 0 else {'error': probe.stderr[-400:]}
print(json.dumps(result, sort_keys=True))''')


def restore_new_pvc(ctx, step):
    destination = Path(ctx['backup']['dir'])
    ident = ctx['backup']['identity']
    pool = ident['pool']
    stamp = ctx['backup']['stamp'].lower()
    claim, scratch = f't08-restore-{stamp}', f't08-restore-scratch-{stamp}'
    started = time.monotonic()
    # A new claim of the runner class: the CSI driver provisions its own image and handle. (A static PV naming an
    # imported image is refused by this Ceph-CSI's ControllerPublish, and its ControllerUnpublish then panics.)
    pvc = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': claim, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't08-restore'}},
           'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': ENV['LAB_STORAGE_CLASS'], 'volumeMode': 'Filesystem',
                    'resources': {'requests': {'storage': '2Gi'}}}}
    k('apply', '-f', '-', input=json.dumps(pvc))
    deadline = time.monotonic() + 120
    while (kget('pvc', claim) or {}).get('status', {}).get('phase') != 'Bound':
        if time.monotonic() > deadline:
            raise Failed(f'the restore claim {claim} was not Bound within 120 s')
        time.sleep(2)
    bound = kget('pvc', claim)
    pv = kget('pv', bound['spec']['volumeName'], namespace=None)
    target = pv['spec']['csi']['volumeAttributes']['imageName']
    step.check('a new claim, PV and RBD image, none of them the original', target != ident['rbdImage'] and pv['metadata']['uid'] != ident['pvUid'],
               {'image': target, 'pv': pv['metadata']['name']})
    # The backup into that image before anything mounts it: imported as a scratch image, its every extent written into the
    # new one (export-diff | import-diff, librbd only, no kernel map anywhere), the scratch removed, the new image read back.
    guest(f'sudo install -d -m 0700 {GUEST_RESTORE}')
    file_to_guest(destination / 'volume.img.gz', f'sudo sh -c "cat > {GUEST_RESTORE}/volume.img.gz"')
    written = ceph_shell(f'set -o pipefail; sha256sum /work/volume.img.gz && gzip -dc /work/volume.img.gz | tee >(sha256sum > /work/raw.sha256) | '
                         f'rbd import --no-progress --image-feature layering - {pool}/{scratch} && sleep 1 && cat /work/raw.sha256 && '
                         f'rbd export-diff --no-progress {pool}/{scratch} - | rbd import-diff --no-progress - {pool}/{target} && '
                         f'rbd rm --no-progress {pool}/{scratch} && rbd export --no-progress {pool}/{target} - | sha256sum && '
                         f'rbd info --format json {pool}/{target}', mount=GUEST_RESTORE)
    write_seconds = round(time.monotonic() - started, 1)
    guest(f'sudo rm -f {GUEST_RESTORE}/volume.img.gz {GUEST_RESTORE}/raw.sha256 && sudo rmdir {GUEST_RESTORE}')
    sums = re.findall(r'^([0-9a-f]{64})\s+(\S+)$', written, re.M)
    info = json.loads(written[written.index('{'):])
    step.check('the archive reached the guest intact', sums[0] == (ctx['backup']['gzipSha256'], '/work/volume.img.gz'), sums[:1])
    step.check('the bytes imported are the exported image (SHA-256)', sums[1][0] == ctx['backup']['rawSha256'], sums[1][0][:16])
    step.check('the new image reads back byte for byte as the backup (SHA-256 of all of it)', sums[2][0] == ctx['backup']['rawSha256'], sums[2][0][:16])
    remaining = ceph_shell(f'rbd ls {pool}').split()
    step.check('the scratch image is gone', scratch not in remaining)
    pod_name = f't08-restore-check-{stamp}'
    probe_root = f"/var/lib/orbit/home/t08-probe/{ctx['backup']['probeRun']}"
    pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod_name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't08-restore'}},
           'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False,
                    'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}},
                    'containers': [{'name': 'check', 'image': IMAGE, 'command': ['python3', '-c', VERIFY_POD_SCRIPT, '/var/lib/orbit',
                                                                                 json.dumps(transcript_prefix(ctx['backup']['snapshot'])), wl.PROBE, probe_root],
                                    'env': [{'name': 'HOME', 'value': '/tmp'}],
                                    'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                                    'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                                    'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/orbit'}, {'name': 'tmp', 'mountPath': '/tmp'}]}],
                    'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}, {'name': 'tmp', 'emptyDir': {'sizeLimit': '256Mi'}}]}}
    k('create', '-f', '-', input=json.dumps(pod))
    deadline = time.monotonic() + 300
    while True:
        phase = (kget('pod', pod_name) or {}).get('status', {}).get('phase')
        if phase in ('Succeeded', 'Failed'):
            break
        if time.monotonic() > deadline:
            events = k('get', 'events', '--field-selector', f'involvedObject.name={pod_name}', '-o', 'json', check=False).stdout
            raise Failed(f'the check Pod {pod_name} did not finish within 300 s: {events[-800:]}')
        time.sleep(2)
    logs = k('logs', pod_name, '-c', 'check').stdout
    view = json.loads(logs.strip().splitlines()[-1])
    expected = ctx['backup']['probe']
    probe = view['probe']
    same = {key: expected[key] == probe.get(key) for key in ('randomSha256', 'rows', 'rowsSha256', 'gitHead')}
    step.check('the check Pod ran to completion', phase == 'Succeeded', phase)
    step.check('the new PVC is the new image, an ext4 RBD filesystem', view['rbdDevice'].get('name') == target and view['mount'][0]['fstype'] == 'ext4',
               {'rbd': view['rbdDevice'], 'mount': view['mount']})
    step.check('the probe data in the restored PVC: same random bytes, SQLite rows and Git commit, integrity_check ok',
               all(same.values()) and probe.get('integrityCheck') == 'ok' and probe.get('gitFsckExit') == 0, same)
    compare_snapshots(step, 'ann', ctx['backup']['snapshot'], view, 'in the restored PVC', ctx['sessions']['ann']['s1Uuid'])
    step.check('the workspace repository passes git fsck in the restored PVC', view['workspace']['fsckExit'] == 0, view['workspace']['fsckExit'])
    k('delete', 'pod', pod_name, '--wait=true')
    ctx['restore'] = {'image': target, 'claim': claim, 'pv': pv['metadata']['name']}
    return {'claim': claim, 'pv': pv['metadata']['name'], 'image': target, 'scratchImage': scratch, 'writeSeconds': write_seconds, 'rbdInfo': info,
            'sha256': {'archive': sums[0][0], 'imported': sums[1][0], 'readBack': sums[2][0]},
            'pvc': {k_: bound['metadata'].get(k_) for k_ in ('uid', 'creationTimestamp')}, 'checkPod': pod_name, 'phase': phase, 'view': view, 'same': same,
            'restoreSeconds': round(time.monotonic() - started, 1)}


def restore_original_untouched(ctx, step):
    before = ctx['backup']['identity']
    after = identity('ann')
    same_identity(step, 'ann', before, after, 'after the backup and the restore')
    info = json.loads(ceph_shell(f"rbd info --format json {shlex.quote(before['pool'])}/{shlex.quote(before['rbdImage'])}"))
    enabled = capture(wl.cmd_disable, name='ann', action='off')
    signed = account('ann')
    at = now()
    turn = wl.new_turn('ann', ctx['sessions']['ann']['s1'], 'T08-ANN-RESTORED a message after the backup and the restore')
    found = answered(owner_uuid('ann'), 'T08-ANN-RESTORED', timeout=360, after=at)
    woken = identity('ann')
    same_identity(step, 'ann', before, woken, 'woken after the restore check: on the original volume')
    continuation_check(step, 'ann', found, ctx['sessions']['ann']['secret'], 'after the backup')
    probe = capture(wl.cmd_probe, name='ann', action='check', run=ctx['backup']['probeRun'])
    step.check('ann: the probe written before the backup is unchanged on the original', probe['allSame'], probe['same'])
    ctx['identity']['ann'] = woken
    return {'identity': after, 'originalRbdInfo': info, 'enabled': enabled, 'signedIn': signed.get('signIn'), 'turnAt': at, 'turn': turn, 'answered': found,
            'woken': woken, 'probe': probe}


# ---- the switch off again, every runner asleep ---------------------------------------------------------------------

def asleep_all(ctx, step):
    results = {name: ensure_asleep(name) for name in (*USERS, THIRD)}
    for name in (*USERS, THIRD):
        step.check(f'{name} is asleep', mapping(name)['management_state'] == 'SLEEPING')
    return results


def off_again(ctx, step, label, quiet):
    started = start_server(label)
    step.check(f'the switch is {label} and no profile is named', not any(l.startswith('ORBIT_MANAGED_RUNNERS_PROFILE') for l in switch_lines()), switch_lines())
    for name in ('root', *USERS, THIRD):
        account(name)
    marker = f'T08-OFF-{label.upper()}'
    demands = [
        lambda: {'owner': 'ann', **wl.new_turn('ann', ctx['sessions']['ann']['s1'], f'{marker}-ANN a message while the switch is {label}')},
        lambda: {'owner': 'bob', **new_task_on('bob', f'{marker}-BOB a task run now while the switch is {label}', run_now=True)},
        lambda: {'owner': THIRD, **new_task_on(THIRD, f'{marker}-CY a task due while the switch is {label}', run_at_seconds=20)},
    ]
    quietly = off_quiet(ctx, step, label, quiet, demands)
    writes = {name: managed_writes(name) for name in (*USERS, THIRD)}
    for name, result in writes.items():
        step.check(f'{name}: every managed write is 404 MANAGED_RUNNER_DISABLED',
                   all(w['status'] == 404 and w['code'] == 'MANAGED_RUNNER_DISABLED' for w in result.values()), result)
    pending = wl.sql_json(f"select s.status, t.status as turn from conversation_turn t join session s on s.id = t.session_id "
                          f"where t.content like {wl.quote(marker + '-ANN%')}")
    step.check('ann\'s message waits, not failed', pending and pending[0]['status'] != 'FAILED', pending)
    pvcs = {name: (kget('pvc', ctx['identity'][name]['pvcName']) or {}).get('metadata', {}).get('uid') for name in (*USERS, THIRD)}
    step.check('every PVC is kept with its UID', all(pvcs[n] == ctx['identity'][n]['pvcUid'] for n in pvcs), pvcs)
    selfhost = selfhost_sessions(ctx, step, f'again-{label}')
    ctx.setdefault('offAgainMarkers', []).append({'marker': marker, 'at': quietly['from']})
    return {'server': started, 'quiet': quietly, 'writes': writes, 'pending': pending, 'pvcs': pvcs, 'selfhost': selfhost}


def new_task_on(name, prompt, run_now=False, run_at_seconds=None):
    workspace = load_context()['identity'][name]['workspaceId']
    body = {'title': prompt[:80], 'description': prompt, 'assigneeId': workspace, 'completionCriterion': 'OWNER_CONFIRMED',
            'ownerConfirmationReason': 'OWNER_TRADE_OFF', 'acceptanceCriteria': 'T08 lab: the run is claimed by the managed runner and answered.'}
    if run_at_seconds is not None:
        body['runAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + run_at_seconds))
    code, task = ml.http('POST', '/tasks', body, token=token(name))
    result = {'at': now(), 'kind': 'task', 'status': code, 'runAt': body.get('runAt'),
              'task': {k: task.get(k) for k in ('id', 'status', 'runAt', 'code', 'message')} if isinstance(task, dict) else task}
    if run_now and code in (200, 201):
        run_code, answer = ml.http('POST', f"/tasks/{task['id']}/execute", {}, token=token(name))
        result['execute'] = {'status': run_code, 'sessionId': (answer or {}).get('sessionId') if isinstance(answer, dict) else None}
    return result


def on_again(ctx, step):
    started = start_server('on')
    results = {'server': started}
    for item in ctx.get('offAgainMarkers', []):
        marker = item['marker']
        for name, suffix in (('ann', 'ANN'), ('bob', 'BOB'), (THIRD, 'CY')):
            found = answered(owner_uuid(name), f'{marker}-{suffix}', timeout=900, after=item['at'])
            results[f'{marker}-{suffix}'] = found
            step.check(f'{marker}-{suffix} answered on {name}\'s managed runner once the switch was on',
                       found['session']['assigned_runner_id'] == ctx['identity'][name]['runnerId'], found['session']['assigned_runner_id'])
    for name in (*USERS, THIRD):
        same_identity(step, name, ctx['identity'][name], identity(name), 'after the switch was off and on')
    results['asleep'] = {name: ensure_asleep(name) for name in (*USERS, THIRD)}
    return results


# ---- final ---------------------------------------------------------------------------------------------------------------

def final_checks(ctx, step):
    view = ml.verdict()
    foreign = capture(ml.cmd_foreign, action='check')
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    step.check('three mappings, three PVCs', len(view['mappings']) == 3 and all(m['pvc'] for m in view['mappings']), len(view['mappings']))
    step.check('the earlier tasks\' objects in the namespace are unchanged', foreign['unchanged'])
    timeline = [json.loads(line) for line in (SERVER / 'timeline.jsonl').read_text().splitlines() if line.startswith('{')]
    most, generations = {}, {}
    for line in timeline:
        for claim, pods in (line.get('podsByClaim') or {}).items():
            most[claim] = max(most.get(claim, 0), len(pods))
        for owner, value in line.items():
            if isinstance(value, dict) and 'gen' in value:
                generations.setdefault(owner, set()).add(value['gen'])
    ours = {ctx['identity'][n]['pvcName'] for n in (*USERS, THIRD)}
    step.check('never more than one Pod on any of the three volumes in the whole timeline', all(most.get(c, 0) <= 1 for c in ours),
               {c: most.get(c, 0) for c in sorted(ours)})
    gate = gate_summary(ctx['firstSignInAt'])
    storage = {name: storage_view(name) for name in (*USERS, THIRD)}
    for name, value in storage.items():
        step.check(f'{name}: the PVC is the one made at its first provisioning', value['objects']['pvc']['uid'] == ctx['identity'][name]['pvcUid'])
    ceph = sw.ceph('ceph -s -f json', f"rbd ls -l {ENV['LAB_POOL']}", 'ceph df -f json')
    status = json.loads(ceph[0])
    step.check('Ceph is HEALTH_OK at the end', status['health']['status'] == 'HEALTH_OK', status['health']['status'])
    pool = wl.sql_json('select * from managed_runner_capacity')
    return {'verdict': view, 'foreign': foreign, 'mostPodsPerVolume': {c: most.get(c, 0) for c in sorted(ours)},
            'generationsSeen': {o: sorted(g) for o, g in generations.items()}, 'timelineLines': len(timeline), 'gate': gate,
            'storage': storage, 'ceph': {'health': status['health'], 'rbd': ceph[1].splitlines(), 'df': json.loads(ceph[2])['stats']}, 'pool': pool,
            'restore': {'pvc': (kget('pvc', ctx.get('restore', {}).get('claim', 'none')) or {}).get('status'),
                        'pv': (kget('pv', ctx.get('restore', {}).get('pv', 'none'), namespace=None) or {}).get('status')}}


def teardown(ctx, step):
    results = {'recorder': record('stop'), 'admission': capture(sw.cmd_admission, action='remove')}
    ml.systemd('stop', SELFHOST_UNIT, check=False)
    results['selfhost'] = ml.active(SELFHOST_UNIT)
    results['replica'] = capture(ml.cmd_replica, action='stop')
    results['server'] = server('stop')
    results['gate'] = capture(ml.cmd_gate, action='stop', since=None)
    step.check('the webhook is removed', sw.webhook_view() is None)
    return results


# ---- the recorder ---------------------------------------------------------------------------------------------------------

def record_line():
    line = wl.record_line()
    objects = ml.cluster_objects()
    line['k8s'] = wl.cluster_line(objects)
    claims = {}
    for pod in objects['pods']:
        for volume in pod['spec'].get('volumes', []):
            claim = (volume.get('persistentVolumeClaim') or {}).get('claimName')
            if claim:
                claims.setdefault(claim, []).append(f"{pod['metadata']['name'][:12]}:{pod['metadata']['uid'][:8]}:{pod['status'].get('phase')}")
    line['podsByClaim'] = claims
    line['gate'] = ml.gate_connections()
    return line


def cmd_record_loop(args):
    deadline, last = time.monotonic() + args.seconds, None
    while time.monotonic() < deadline:
        try:
            line = record_line()
        except (Exception, SystemExit) as error:  # the database or the guest is away: say so and look again
            line = {'error': str(error)[-200:]}
        compare = {k: v for k, v in line.items() if k != 'gate'}
        if compare != last:
            print(json.dumps({'at': now(), **line}, sort_keys=True), flush=True)
            last = compare
        time.sleep(1)


def record(action):
    log = SERVER / 'timeline.jsonl'
    if action == 'start':
        if ml.active(RECORDER_UNIT) != 'active':
            run(['systemd-run', f'--unit={RECORDER_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=256M',
                 '-p', f'Environment=LAB_TEST_SERVER_DIR={SERVER}', '-p', f'StandardOutput=append:{log}', '-p', f'StandardError=append:{log}',
                 sys.executable, '-I', str(Path(__file__)), 'record-loop', '21600'])
    else:
        ml.systemd('stop', RECORDER_UNIT, check=False)
    return {'at': now(), 'unit': ml.active(RECORDER_UNIT), 'log': str(log), 'lines': len(log.read_text().splitlines()) if log.exists() else 0}


# ---- the run -----------------------------------------------------------------------------------------------------------------

def phases(quiet):
    return [
        ('facts', [('git', facts_git), ('host', facts_host), ('cluster', facts_cluster), ('ceph', facts_ceph), ('image', facts_image)]),
        ('setup', [('server-dir', setup_server_dir), ('selfhost-build', setup_selfhost_build)]),
        ('off-unset', [('start', lambda c, s: start_server('unset')), ('foreign', setup_foreign), ('accounts', lambda c, s: off_accounts(c, s, 'unset')),
                       ('selfhost', selfhost_setup), ('selfhost-work', lambda c, s: selfhost_sessions(c, s, 'unset')),
                       ('quiet', lambda c, s: off_quiet(c, s, 'unset', quiet))]),
        ('off-false', [('start', lambda c, s: start_server('false')), ('accounts', lambda c, s: off_accounts(c, s, 'false')),
                       ('selfhost-work', lambda c, s: selfhost_sessions(c, s, 'false')), ('quiet', lambda c, s: off_quiet(c, s, 'false', quiet))]),
        ('on-provision', [('prepare', on_prepare), ('start', on_start), ('concurrent', provision_concurrent), ('retry', provision_retry)]),
        ('capacity', [('wait', capacity_wait)]),
        ('sessions', [('first', sessions_first), ('busy-start', busy_start), ('probes', probes_write),
                      ('snapshots', lambda c, s: snapshots(c, s, 'awake')), ('isolation', isolation), ('busy-refuse-sleep', busy_refuse_sleep),
                      ('busy-end', busy_end)]),
        ('sleep', [('idle', idle_sleep), ('capacity-admitted', capacity_admitted)]),
        ('wake', [('interactive', wake_interactive), ('background', wake_background)]),
        ('rebuild', [('pods', rebuild)]),
        ('controller', [('restart', controller_restart)]),
        ('image', [('rollback', lambda c, s: image_switch(c, s, PREVIOUS_IMAGE, 'rollback')),
                   ('forward', lambda c, s: image_switch(c, s, IMAGE, 'forward'))]),
        ('backup', [('prepare', backup_prepare), ('export', backup_export), ('verify-offline', backup_verify_offline),
                    ('restore-new-pvc', restore_new_pvc), ('original', restore_original_untouched)]),
        ('off-again', [('asleep', asleep_all), ('unset', lambda c, s: off_again(c, s, 'unset', quiet)),
                       ('false', lambda c, s: off_again(c, s, 'false', quiet)), ('on', on_again)]),
        ('final', [('checks', final_checks), ('teardown', teardown)]),
    ]


def cmd_run(args):
    require_own_server_dir()
    out = Path(args.out)
    (out / 'records').mkdir(parents=True, exist_ok=True)
    plan = phases(args.quiet_seconds)
    names = [name for name, _ in plan]
    first = names.index(args.from_phase) if args.from_phase else 0
    last = names.index(args.to_phase) if args.to_phase else len(names) - 1
    ctx = load_context()
    number = len(list((out / 'records').glob('*.json')))
    run_started = time.monotonic()
    for phase, steps in plan[first:last + 1]:
        for label, function in steps:
            number += 1
            step = Step()
            started_at, started = now(), time.monotonic()
            error = None
            try:
                if sw.API != PRIMARY_API:
                    raise Failed(f'the client points at {sw.API}, not the primary apiserver {PRIMARY_API}')
                result = function(ctx, step)
            except (Exception, SystemExit) as failure:  # recorded, then the run stops
                result, error = None, f'{type(failure).__name__}: {failure}'
                traceback.print_exc()
            seconds = round(time.monotonic() - started, 1)
            ok = error is None and all(c['ok'] for c in step.checks)
            record_file = out / 'records' / f'{number:03d}-{phase}-{label}.json'
            record_file.write_text(json.dumps({'phase': phase, 'step': label, 'startedAt': started_at, 'endedAt': now(), 'seconds': seconds,
                                               'ok': ok, 'error': error, 'checks': step.checks, 'result': result}, indent=1, sort_keys=True, default=str))
            line = {'n': number, 'phase': phase, 'step': label, 'startedAt': started_at, 'seconds': seconds, 'ok': ok, 'error': error,
                    'checks': len(step.checks), 'failed': [c['check'] for c in step.checks if not c['ok']]}
            with open(out / 'steps.jsonl', 'a') as steps_log:
                steps_log.write(json.dumps(line) + '\n')
            print(json.dumps(line), flush=True)
            save_context(ctx)
            if not ok:
                raise SystemExit(f'{phase}/{label} failed: {error or line["failed"]}')
    print(json.dumps({'done': True, 'phases': names[first:last + 1], 'seconds': round(time.monotonic() - run_started, 1)}), flush=True)


# ---- the report ---------------------------------------------------------------------------------------------------------------

def cmd_report(args):
    """A run's steps (time, checks) and the intervals the README quotes, from its records only."""
    out = Path(args.out)
    steps = [json.loads(line) for line in (out / 'steps.jsonl').read_text().splitlines()]
    records = {}
    for path in sorted((out / 'records').glob('*.json')):
        record = json.loads(path.read_text())
        records[f"{record['phase']}/{record['step']}"] = record
    get = lambda key: (records.get(key) or {}).get('result') or {}
    measures = {}

    def measure(name, function):
        try:
            measures[name] = function()
        except (KeyError, TypeError, IndexError, ValueError) as error:
            measures[name] = f'unavailable: {type(error).__name__} {error}'
    retry = get('on-provision/retry')
    measure('provision', lambda: {n: {'mappingToPvc': seconds_between(t['mappingCreatedAt'], t['pvcCreatedAt'].replace('Z', '+00:00')),
                                      'retryToPod': seconds_between(records['on-provision/retry']['startedAt'], t['podCreatedAt'].replace('Z', '+00:00')),
                                      'podToRunnerStarted': seconds_between(t['podCreatedAt'].replace('Z', '+00:00'), t['runnerContainerStartedAt'].replace('Z', '+00:00')),
                                      'runnerStartedToReady': seconds_between(t['runnerContainerStartedAt'].replace('Z', '+00:00'), t['readyAt'])}
                                  for n, t in retry['timings'].items()})
    measure('signIns', lambda: {'count': len(get('on-provision/concurrent')['signIns']),
                                'slowestMs': max(a['ms'] for a in get('on-provision/concurrent')['signIns']),
                                'failedWithin': {n: w['seconds'] for n, w in get('on-provision/concurrent')['untilFailed'].items()}})
    measure('firstSessions', lambda: {n: seconds_between(r['createdAt'], r['event']['event']['ingested_at']) for n, r in get('sessions/first').items()})
    measure('busy', lambda: {n: {'secondsSinceBusyStart': r['secondsSinceBusyStart'], 'sleep': r['sleep']}
                             for n, r in get('sessions/busy-refuse-sleep').items()})
    # Asleep, the mapping no longer holds its drain request: its time comes from the changes the wait saw.
    asked = lambda r: next(c['at'] for c in r['until']['changes'] if (c['line'].get('drain') or c['line'].get('management_state') == 'DRAINING'))
    measure('idleSleep', lambda: {n: {'drainAskedToAsleep': seconds_between(asked(r), r['sleptAt']),
                                      'busyEndToDrainAsked': seconds_between(records['sessions/busy-end']['endedAt'], asked(r)),
                                      'busyEndToAsleep': seconds_between(records['sessions/busy-end']['endedAt'], r['sleptAt'])}
                                  for n, r in get('sleep/idle').items()})
    measure('capacity', lambda: {'cyWaited': get('capacity/wait')['waited']['reached'], 'cyReadyAfter': get('sleep/capacity-admitted')['ready']['seconds'],
                                 'firstSleep': get('sleep/capacity-admitted')['firstSleepAt'], 'cyPvc': get('sleep/capacity-admitted')['times']['pvcCreatedAt']})
    measure('wakes', lambda: {'annMessage': get('wake/interactive')['answeredAfterSeconds'], 'bobTaskAfterDue': get('wake/background')['answeredAfterDueSeconds']})
    measure('rebuild', lambda: {n: get('rebuild/pods')['ready'][n]['seconds'] for n in USERS})
    controller = get('controller/restart')
    measure('controller', lambda: {'killedAt': controller['killedAt'], 'bobAtKill': controller['atKill']['bob'],
                                   'apiserversStartedIn': controller['restarted']['seconds'],
                                   'killToBobReady': seconds_between(controller['killedAt'], controller['bobReady']['at']),
                                   # The Pod bob was READY on, against the one recorded when the controller died (none: not created yet).
                                   'bobReadyOnPod': controller['bobReady']['changes'][-1]['line']['pod'],
                                   'bobPodAdopted': (controller['atKill']['bob']['pod_uid'] or '-')[:8] == controller['bobReady']['changes'][-1]['line']['pod'],
                                   'podCreatesInTheWindow': controller['gate']['byKind'].get('Pod create', 0),
                                   'annPodKept': controller['identity']['annBefore']['podUid'] == controller['identity']['annAfter']['podUid']})
    measure('image', lambda: {label: {'pinned': get(f'image/{label}')['pinned'], 'nextPod': get(f'image/{label}')['imagesAfter']}
                              for label in ('rollback', 'forward')})
    measure('backup', lambda: {'disableToAsleep': get('backup/prepare')['slept']['seconds'], 'exportSeconds': get('backup/export')['exportSeconds'],
                               'copySeconds': get('backup/export')['copySeconds'], 'gzipBytes': get('backup/export')['manifest']['gzipBytes'],
                               'imageBytes': get('backup/export')['manifest']['source']['sizeBytes'],
                               'verifyOfflineSeconds': get('backup/verify-offline')['seconds'], 'restoreSeconds': get('backup/restore-new-pvc')['restoreSeconds'],
                               'writeSeconds': get('backup/restore-new-pvc')['writeSeconds']})
    measure('offAgain', lambda: {label: get(f'off-again/{label}')['quiet']['waitedSeconds'] for label in ('unset', 'false')})
    measure('final', lambda: {k: get('final/checks')[k] for k in ('mostPodsPerVolume', 'generationsSeen', 'timelineLines')}
                              | {'gate': get('final/checks')['gate']['byKind']})
    checks = sum(line['checks'] for line in steps)
    print(json.dumps({'steps': len(steps), 'checks': checks, 'failedSteps': [f"{l['phase']}/{l['step']}" for l in steps if not l['ok']],
                      'from': steps[0]['startedAt'], 'to': records[max(records, key=lambda k: records[k]['endedAt'])]['endedAt'] if records else None,
                      'phaseSeconds': {phase: round(sum(l['seconds'] for l in steps if l['phase'] == phase), 1)
                                       for phase in dict.fromkeys(l['phase'] for l in steps)},
                      'measures': measures}, indent=1, sort_keys=False))


# ---- the secret scan ------------------------------------------------------------------------------------------------------------

def cmd_secret_scan(args):
    secrets = {}

    def add(name, value):
        if isinstance(value, str) and len(value) >= 8:
            secrets[name] = value
    for state in sorted((SERVER / 'state').glob('*.json')):
        found = json.loads(state.read_text())
        for key in ('password', 'accessToken', 'refreshToken'):
            add(f'{state.stem}.{key}', found.get(key))
    for path in sorted((SERVER / 'secrets').glob('*')):
        if path.is_file() and path.suffix != '.env':
            add(f'secrets/{path.name}', path.read_text().strip())
    kube = SERVER / 'manager-kubeconfig.json'
    if kube.exists():
        for user in json.loads(kube.read_text()).get('users', []):
            add('manager-kubeconfig.token', user['user'].get('token'))
    config = SELFHOST / 'orbit-home/config.json'
    if config.exists():
        add('selfhost.runnerToken', json.loads(config.read_text()).get('runnerToken'))
    for user in json.loads((LAB_DIR / 'kubeconfig.json').read_text()).get('users', []):
        data = user['user'].get('client-key-data')
        if data:
            add('lab-admin.client-key-data', data)
            add('lab-admin.client-key', base64.b64decode(data).decode(errors='replace').strip().splitlines()[1])
    patterns = {'jwt': re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'), 'sk-key': re.compile(r'(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}'),
                'bearer': re.compile(r'Bearer [A-Za-z0-9._-]{16,}')}
    files = [p for arg in args.paths for p in ([Path(arg)] if Path(arg).is_file() else Path(arg).rglob('*')) if p.is_file()]
    hits, found_patterns, placeholder = {}, {}, 0
    for path in files:
        raw = path.read_bytes()
        try:
            text = (gzip.decompress(raw) if path.suffix == '.gz' else raw).decode(errors='replace')
        except OSError:
            text = raw.decode(errors='replace')
        for name, value in secrets.items():
            if value in text:
                hits.setdefault(name, []).append(str(path))
        placeholder += text.count(FAKE_KEY)
        for name, pattern in patterns.items():
            matches = [m for m in pattern.findall(text) if m != FAKE_KEY]
            if matches:
                found_patterns.setdefault(name, []).append(f'{path} ({len(matches)})')
    print(json.dumps({'filesScanned': len(files), 'credentialsLookedFor': len(secrets), 'kinds': sorted({n.split('.')[-1].split('/')[-1] for n in secrets}),
                      'found': hits, 'patterns': found_patterns, 'fakeModelPlaceholderOccurrences': placeholder}, indent=1))
    if hits or found_patterns:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('run')
    start.add_argument('--out', required=True)
    start.add_argument('--from', dest='from_phase')
    start.add_argument('--to', dest='to_phase')
    start.add_argument('--quiet-seconds', type=int, default=90)
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    sub.add_parser('secret-scan').add_argument('paths', nargs='+')
    sub.add_parser('report').add_argument('out')
    args = parser.parse_args()
    {'run': cmd_run, 'record-loop': cmd_record_loop, 'secret-scan': cmd_secret_scan, 'report': cmd_report}[args.command](args)


if __name__ == '__main__':
    main()
