#!/usr/bin/env python3
"""Two accounts' runners across the lab's two nodes, in one run (task T08x, the cross-node part of criterion 8).

docs/managed-runner-lab.md, "Two accounts across two nodes (T08x)". One command runs every phase in order and stops at
the first check that fails; each step's result and wall-clock time are written to OUT. It is takeover-lab.py (T02) for
two accounts, whose helpers it uses (and through them acceptance-lab.py's, T08), through the test server's own manager,
admission guard and fencing gate. The failover and the planned move follow the runbook,
docs/managed-runner-kubernetes-operations.md, and run its own commands where it gives them:

  facts      versions, both nodes, the link, Ceph, Ceph-CSI, the image in both VMs' containerd, the owner's model key file
  setup      the gate, the lab CA and webhook token, the administrator signed up with the switch unset
  on         the profile (a budget of two runners), the apiserver with the switch on, the admission guard
  accounts   ann and bob sign in with the second node cordoned: both runners on the first node, READY on a fake-model
             key; each a first session with an attachment and a file the engine commits, and probe data on its volume
  move       both owners' sleep; then, the first node cordoned and the second not, ann woken by a message and bob by a
             task run now: the next generations on the second node, the same runners, claims and images, data and sessions
  duplicate  both runners writing on the second node: Pods on each claim pinned to the first node, and Pods mixing the
             two owners' runners and claims, refused by the admission guard
  takeover   the second node powered off hard while both runners write there, their last Git work 60 s before and a
             last message to each session, ann's volume synced right before the cut and bob's not: for a while nothing
             takes over, and second Pods on the first node are refused; then the runbook's failover for both (a
             receipt each, the out-of-service taint, each stale Pod's finalizer off: bob's at once, ann's once she is
             FENCING): the next generations on the first node; the data, what the last seconds left, the sessions
  rejoin     the second node back under the taint: nothing of either old Pod runs or is mapped there, both old
             credentials are refused, the writers go on from the first node; then the taint is removed
  drain      the runbook's planned move: kubectl drain of the first node for the runners' Pods, first with no flags and
             then with one, both refused, then with the two that bare Pods with an emptyDir need: the next generations
             on the second node; a managed Pod of an earlier task left Terminating there passed with
             --skip-wait-for-delete-timeout; then the second node drained and both runners back on the first
  final      consistency, one Pod per claim and one attachment per PV over the whole timeline, Ceph; both asleep

  cross-node-lab.py run --out DIR [--from PHASE | --from-step PHASE/STEP] [--to PHASE] [--observe SECONDS]
  cross-node-lab.py record-loop SECONDS        the recorder unit's loop (started by the run)
  cross-node-lab.py secret-scan PATH...        no credential of the run in these files
  cross-node-lab.py report OUT                 the steps' times and checks, and the intervals the README quotes

LAB_TEST_SERVER_DIR must name test-server-t08x (or test-server-t08x-dev for trials): earlier tasks' databases stay
untouched. Two-node mode must be up (start.sh --nodes 2). Every record is JSON and never holds a credential: owners'
tokens and passwords, runner credentials, the fake model key and the manager's token stay in files of mode 0600 under
the server directory, in the lab's Secrets and in the test server's provider store. Sessions run on fake-model.py as a
DeepSeek-preset key, which is not a model. Both VMs are one physical machine and one failure domain: nothing here is
evidence of availability across machines.
"""

import argparse
import contextlib
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_takeover', LAB / 'takeover-lab.py')
tl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tl)
al, wl, ml, sw = tl.al, tl.wl, tl.ml, tl.sw

SERVER, NAMESPACE, ENV, LAB_DIR, STATE, REPO = sw.SERVER, sw.NAMESPACE, sw.ENV, sw.LAB_DIR, sw.STATE, sw.REPO
OWN_SERVER_DIRS = ('test-server-t08x', 'test-server-t08x-dev')
# takeover-lab.py's and acceptance-lab.py's helpers with this task's directory, accounts, probe, writer and operator.
al.OWN_SERVER_DIRS = al.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.OWN_SERVER_DIRS = wl.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.EMAIL = ml.EMAIL = 't08x-{}@lab.invalid'
wl.NAME_RE = re.compile(r't08x-([a-z0-9]+)@lab\.invalid')
wl.PROBE_ROOT = '/var/lib/orbit/home/t08x-probe'
al.CONTEXT = SERVER / 't08x-context.json'
tl.WRITER_RUN = 't08x-writer'
tl.OPERATOR = 'T08x lab operator (task 34i56D6O5QbxCsbYrf8YO)'
USERS = ('ann', 'bob')
NODES, LINK_IPS = tl.NODES, tl.LINK_IPS
RECORDER_UNIT = 'orbit-mr-lab-t08x-recorder'
OUT_OF_SERVICE, STOP_REPORT = tl.OUT_OF_SERVICE, tl.STOP_REPORT
RUNNER_PODS = 'app.kubernetes.io/name=orbit-managed-runner'  # the label of every Pod the manager makes
RUNBOOK = REPO / 'docs/managed-runner-kubernetes-operations.md'
EVIDENCE = 'docs/evidence/managed-runner-cross-node-accounts/2026-10-19'
MODEL_KEY = LAB_DIR / 'secrets/deepseek-api-key'
LAST_TURN_STAMP = '/tmp/t08x-last-turn'  # the runner container's emptyDir, not the volume
WRITER_LOG = '/tmp/t08x-writer.log'
QUIET_SECONDS = 60  # no Git work in the last minute before the power cut (T02's finding 2: Git does not fsync)
Failed, Step, capture, k, kget, kjson, mapping, until, identity, now = (al.Failed, al.Step, al.capture, al.k, al.kget, al.kjson, al.mapping,
                                                                       al.until, al.identity, al.now)


def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t08x (or test-server-t08x-dev), not {SERVER}')


@contextlib.contextmanager
def as_owner(name):
    """single-writer.py's payload, credential and storage commands act on its OWNER's mapping: NAME's, while this lasts."""
    saved = sw.OWNER, sw.CREDENTIALS
    sw.OWNER, sw.CREDENTIALS = name, STATE / 'credentials' / name
    try:
        yield
    finally:
        sw.OWNER, sw.CREDENTIALS = saved


def memory(label):
    result = subprocess.run([sys.executable, '-I', str(LAB / 'two-node.py'), 'memory', f't08x {label}'], capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'error': (result.stderr or result.stdout).strip()[-300:]}


tl.memory = memory  # takeover-lab.py's facts sample memory under this task's label


def owner_uuid(name):
    return al.owner_uuid(name)


def marker(name, what):
    return f'T08X-{name.upper()}-{what}'


# ---- the runbook's own commands ----------------------------------------------------------------------------------

def runbook_block(heading, needle, language='bash'):
    """The LANGUAGE block of the runbook's section HEADING that holds NEEDLE: the operator's commands as the runbook gives them."""
    text = RUNBOOK.read_text()
    start = text.index(f'\n## {heading}\n')
    end = text.find('\n## ', start + 1)
    for block in re.findall(rf'```{language}\n(.*?)```', text[start:end if end > 0 else None], re.S):
        if needle in block:
            return block
    raise Failed(f'the runbook\'s "{heading}" has no {language} block holding {needle!r}')


def runbook_bash(label, script, **variables):
    """A runbook command in bash, after the runbook's own convention for K: the lab's kubeconfig and context, the managed
    namespace, the lab's kubectl first on PATH. Placeholders the runbook writes as <...> come in as VARIABLES."""
    conventions = next(line for line in RUNBOOK.read_text().splitlines() if line.startswith('K="kubectl '))
    env = {key: value for key, value in os.environ.items() if key != 'KUBECONFIG'}
    env.update(PATH=f"{LAB_DIR / 'bin'}:/usr/bin:/bin", ADMIN_KUBECONFIG=str(LAB_DIR / 'kubeconfig.json'), TEST_CONTEXT=ENV['LAB_NAME'],
               MANAGED_NAMESPACE=NAMESPACE, **variables)
    started = now()
    result = subprocess.run(['bash', '-c', f'set -euo pipefail\n{conventions}\n{script}'], env=env, capture_output=True, text=True, timeout=300)
    return {'label': label, 'at': started, 'script': script, 'variables': variables, 'exit': result.returncode,
            'stdout': result.stdout.strip()[-3000:], 'stderr': result.stderr.strip()[-1500:]}


def runbook_sql(label, query):
    """A runbook query as written, through psql in the test server's PostgreSQL container: its rows."""
    result = subprocess.run(['docker', 'exec', '-i', sw.PG, 'psql', '-U', 'orbit', '-d', 'orbit', '--csv', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
                            input=query, capture_output=True, text=True, timeout=60)
    return {'label': label, 'at': now(), 'query': query, 'exit': result.returncode,
            'rows': list(csv.DictReader(io.StringIO(result.stdout))) if result.returncode == 0 else [], 'stderr': result.stderr.strip()[-600:]}


def find_runner_block():
    """The runbook's "Find an account's runner" commands with R given: its first line names the runner, its last runs
    on the Ceph admin host (here rbd_status, through VM 1's cephadm shell)."""
    block = runbook_block("Find an account's runner", 'R=<runner uuid>')
    return '\n'.join(line for line in block.splitlines() if not line.startswith(('R=', 'rbd ')))


# ---- what the volume holds of the last seconds ---------------------------------------------------------------------

TRANSCRIPTS = r'''
import hashlib, json, sys
from pathlib import Path
home = Path('/var/lib/orbit/home')
asked = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
found = {}
for p in sorted((home / '.claude' / 'projects').rglob('*.jsonl')):
    data = p.read_bytes()
    lines = data.splitlines(keepends=True)
    key = str(p.relative_to(home))
    found[key] = {'bytes': len(data), 'lines': len(lines), 'sha256': hashlib.sha256(data).hexdigest(), 'endsWithNewline': data.endswith(b'\n'),
                  'prefixes': {str(n): hashlib.sha256(b''.join(lines[:n])).hexdigest() for n in asked.get(key, [])}}
print(json.dumps(found, sort_keys=True))
'''

FILES_SINCE = r'''
import hashlib, json, os, sys
from pathlib import Path
root, since = Path('/var/lib/orbit/home'), os.stat(sys.argv[1]).st_mtime
found = {}
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x != 'storage-verification']  # the payload writer: judged by its acknowledged rows
    for f in files:
        p = Path(d) / f
        try:
            st = p.lstat()
            if p.is_symlink() or st.st_mtime < since:
                continue
            data = p.read_bytes()
        except OSError:
            continue
        found[str(p.relative_to(root))] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mtime': round(st.st_mtime, 3)}
print(json.dumps({'since': since, 'files': found}, sort_keys=True))
'''

FILES_NOW = r'''
import hashlib, json, sys
from pathlib import Path
root = Path('/var/lib/orbit/home')
found = {}
for name in json.loads(sys.argv[1]):
    try:
        data = (root / name).read_bytes()
        found[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    except OSError as error:
        found[name] = {'error': type(error).__name__}
print(json.dumps(found, sort_keys=True))
'''


def in_runner(name, *command):
    _, pod = ml.running_pod(name)
    return json.loads(sw.pod_exec(pod['metadata']['name'], *command).stdout)


def transcripts(name, asked=None):
    """The engine's transcripts on NAME's volume: bytes, lines, SHA-256, and the hash of the first lines ASKED for each."""
    return in_runner(name, 'python3', '-c', TRANSCRIPTS, json.dumps(asked or {}))


def lost_since(before, after):
    """What a power cut left of files written since a moment: each as it was before the cut against what is there now."""
    verdict = {}
    for path, was in before.items():
        found = after.get(path) or {}
        if 'error' in found:
            verdict[path] = {'was': was['bytes'], 'now': None, 'result': 'missing'}
        elif found['sha256'] == was['sha256']:
            verdict[path] = {'was': was['bytes'], 'now': found['bytes'], 'result': 'kept'}
        else:
            verdict[path] = {'was': was['bytes'], 'now': found['bytes'], 'result': 'shorter' if found['bytes'] < was['bytes'] else 'changed'}
    return verdict


# ---- the writer, the probes, the placement of two accounts ----------------------------------------------------------------

RANDOM_FILE = '''import os, sys
with open(sys.argv[1], "wb") as stream:
    stream.write(os.urandom(32 * 1024 * 1024)); stream.flush(); os.fsync(stream.fileno())'''


def writer_rows(name):
    m = mapping(name)
    text = sw.pod_exec(m['pod_name'], 'sh', '-c', f'cat {sw.PAYLOAD_ROOT}/{tl.WRITER_RUN}/acknowledged.json 2>/dev/null || echo "{{}}"').stdout
    return json.loads(text).get('committedRows', 0)


def probe_check(name, run):
    """wake-lab.py's probe check on NAME's volume, every field compared and reported, nothing raised."""
    m, pod = ml.running_pod(name)
    result = json.loads(sw.pod_exec(pod['metadata']['name'], 'python3', '-c', wl.PROBE, 'check', f'{wl.PROBE_ROOT}/{run}').stdout)
    written = ml.owner_state(name)['probes'][run]
    return {'run': run, 'writtenAt': written['at'], 'writtenByGeneration': written['generation'], 'writtenByPod': written['pod'],
            'checkedByGeneration': m['generation'], 'written': written['data'], 'data': result,
            'same': {key: written['data'][key] == result[key] for key in ('randomSha256', 'rows', 'rowsSha256', 'gitHead')}}


def rbd_mount(step, name, snap, label):
    step.check(f'{name}: /var/lib/orbit is an RBD device, ext4 {label}', snap['mount'] and snap['mount'][0]['source'].startswith('/dev/rbd')
               and snap['mount'][0]['fstype'] == 'ext4', snap['mount'])


def moved(step, name, before, after, node, label):
    """The same runner, claim, PV, handle, image and workspace on a new Pod of a later generation, used from NODE only."""
    al.same_identity(step, name, before, after, label)
    step.check(f'{name}: a new Pod of a later generation {label}', after['generation'] > before['generation'] and after['podUid'] not in (None, before['podUid']),
               {'before': [before['generation'], before['podUid']], 'after': [after['generation'], after['podUid']]})
    view = tl.placement(name)
    tl.check_placed(step, view, node, f'{name}, generation {after["generation"]}')
    return view


def data_kept(step, ctx, name, snap_before, label):
    """Probe p1, and what the sessions left on the volume (uploads, worktrees, transcripts, SQLite), as before."""
    probe = capture(wl.cmd_probe, name=name, action='check', run='p1')
    step.check(f'{name}: probe p1 the same (random bytes, SQLite rows, Git commit), integrity_check ok {label}', probe['allSame'], probe['same'])
    snap = al.pod_snapshot(name, al.transcript_prefix(snap_before))
    al.compare_snapshots(step, name, snap_before, snap, label, ctx['sessions'][name]['s1Uuid'])
    rbd_mount(step, name, snap, label)
    return probe, snap


def resumed(step, ctx, name, what, label):
    """A message to NAME's first session, answered by NAME's runner, its request carrying the earlier conversation."""
    turn = wl.new_turn(name, ctx['sessions'][name]['s1'], f'{marker(name, what)} a message to the first session {label}')
    found = al.answered(owner_uuid(name), marker(name, what), timeout=300, after=turn['at'])
    step.check(f'{name}: the message was answered by {name}\'s runner {label}', found['event']['ingested_by_runner_id'] == mapping(name)['runner_id'],
               found['event'])
    al.continuation_check(step, name, found, ctx['sessions'][name]['secret'], label)
    return {'turn': turn, 'answered': found, 'answeredAfterSeconds': al.seconds_between(turn['at'], found['event']['ingested_at'])}


# ---- facts, setup and the switch --------------------------------------------------------------------------------

def facts_model(ctx, step):
    """The owner's DeepSeek key file. Without it every session runs on fake-model.py, and the real model session is pending."""
    exists = MODEL_KEY.exists()
    ctx['modelKeyFile'] = exists
    return {'file': str(MODEL_KEY), 'exists': exists,
            'sessionsRunOn': 'the owner\'s DeepSeek key' if exists else 'fake-model.py as a DeepSeek-preset key (not a model); the real session is pending'}


def on_prepare(ctx, step):
    prepared = capture(wl.cmd_prepare, image=ctx['image'], source=str(al.T02A))[0]  # manager-lab.py's identity; then wake-lab.py's profile
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t08x'
    # T08's budget of two runners (each asks 500m and 768Mi, one Pod, one attachment, 1Gi of /tmp): both accounts run at once.
    profile['capacity'] = {'compute': {'cpu': '1', 'memory': '1536Mi', 'ephemeralStorage': '2Gi', 'pods': 2, 'attachments': 2},
                           'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2}
    # Asleep only when asked: an hour of idleness, so nothing drains a runner while a node is down or a check runs.
    profile['lifecycle'].update(idleSeconds=3600, startupDeadlineSeconds=900, maxAttempts=5)
    sw.private_write(sw.PROFILE, profile)
    identity_view = prepared.get('identity') or {}
    step.check('the manager\'s identity is the least-privilege ServiceAccount',
               identity_view.get('username') == f'system:serviceaccount:{NAMESPACE}:{sw.MANAGER}', identity_view.get('username'))
    step.check('the manager cannot read or change nodes', (identity_view.get('canI') or {}).get('get nodes') == 'no', identity_view.get('canI'))
    ctx['profile'] = profile
    return {'profile': profile, 'manager': {k: identity_view.get(k) for k in ('username', 'canI', 'rules')}}


def on_start(ctx, step):
    al.stop_api_units()
    lines = al.server('start', '--managed')
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    return {'testServer': lines[-7:], 'switch': al.switch_lines(), 'recorder': record('start')}


# ---- both accounts on the first node --------------------------------------------------------------------------------

def accounts_ready(ctx, step):
    cordoned = [tl.cordon(1, 'uncordon'), tl.cordon(2, 'cordon')]  # the first generations on the first node
    since = now()
    signed = {name: al.account(name) for name in USERS}
    starting = {name: until(name, 'STARTING', reason='MODEL_UNAVAILABLE', timeout=300) for name in USERS}
    keys = {name: capture(wl.cmd_key, name=name) for name in USERS}
    ready = {name: until(name, 'READY', timeout=420) for name in USERS}
    ctx['identity'] = {name: identity(name) for name in USERS}
    ctx['firstSignInAt'] = since
    views, volumes = {}, {}
    for name in USERS:
        views[name] = tl.placement(name)
        tl.check_placed(step, views[name], 1, f'{name}, generation {views[name]["generation"]}')
        ident = ctx['identity'][name]
        pv, pvc = kget('pv', ident['pvName'], namespace=None), kget('pvc', ident['pvcName'])
        step.check(f'{name}: the claim is ReadWriteOnce, Filesystem, of the runner-data class; its PV ext4 on rbd.csi.ceph.com, Retain',
                   pvc['spec']['accessModes'] == ['ReadWriteOnce'] and pvc['spec'].get('volumeMode') == 'Filesystem'
                   and pvc['spec'].get('storageClassName') == ENV['LAB_STORAGE_CLASS'] and pv['spec']['csi']['driver'] == ENV['LAB_CSI_DRIVER']
                   and pv['spec']['csi'].get('fsType') == 'ext4' and pv['spec'].get('persistentVolumeReclaimPolicy') == 'Retain',
                   {'accessModes': pvc['spec']['accessModes'], 'fsType': pv['spec']['csi'].get('fsType')})
        volumes[name] = {'pvc': {k: pvc['metadata'].get(k) for k in ('name', 'uid')}, 'pv': {k: pv['metadata'].get(k) for k in ('name', 'uid')},
                         'volumeHandle': pv['spec']['csi']['volumeHandle'], 'rbdInfo': tl.ceph_json(f"rbd info --format json {tl.rbd_image(ident)}")}
    step.check('two runners, two claims and two RBD images', len({ctx['identity'][n]['runnerId'] for n in USERS}) == 2
               and len({ctx['identity'][n]['pvcUid'] for n in USERS}) == 2 and len({ctx['identity'][n]['rbdImage'] for n in USERS}) == 2,
               {n: ctx['identity'][n]['rbdImage'] for n in USERS})
    verdict = ml.verdict()
    step.check('the database and k3s agree', not verdict['problems'], verdict['problems'])
    return {'cordoned': cordoned, 'signIn': signed, 'starting': starting, 'keys': keys, 'ready': ready, 'identity': ctx['identity'],
            'times': {name: al.provisioned(name) for name in USERS}, 'placement': views, 'volumes': volumes}


def accounts_data(ctx, step):
    sessions, probes = {}, {}
    for name in USERS:
        result = al.first_session(ctx, name)
        sessions[name] = result
        ctx.setdefault('sessions', {})[name] = {'s1': result['session'], 's1Uuid': result['sessionUuid'], 'attachment': result['attachment'],
                                                'wrote': result['wrote'], 'secret': result['secret']}
        step.check(f'{name}: the session ran on {name}\'s managed runner', result['event']['session']['assigned_runner_id'] == ctx['identity'][name]['runnerId'],
                   result['event']['session']['assigned_runner_id'])
        step.check(f'{name}: the engine committed a file in the session\'s Git worktree', bool(result['wrote']['commit']), result['wrote'])
    # One after the other: side by side they contend for the same disk.
    for name in USERS:
        probes[name] = capture(wl.cmd_probe, name=name, action='write', run='p1')
        step.check(f'{name}: probe p1 written on {NODES[1]} (8 MiB random, {al.PROBE_ROWS} SQLite rows in WAL mode with synchronous=FULL, a Git commit), '
                   'integrity_check ok', probes[name]['data']['integrityCheck'] == 'ok' and probes[name]['data']['rows'] >= al.PROBE_ROWS, probes[name]['data']['rows'])
    snaps = {name: al.pod_snapshot(name) for name in USERS}
    for name in USERS:
        rbd_mount(step, name, snaps[name], f'on {NODES[1]}')
    ctx['snapshots'] = {'first': snaps}
    return {'sessions': sessions, 'probes': probes, 'snapshots': snaps}


# ---- the normal move to the other node ------------------------------------------------------------------------------------

def move_sleep(ctx, step):
    awake = {name: identity(name) for name in USERS}
    ctx['identity'].update(awake)
    actions = {name: capture(ml.cmd_action, name=name, action='sleep') for name in USERS}
    slept = {name: until(name, 'SLEEPING', timeout=300) for name in USERS}
    views = {}
    for name in USERS:
        step.check(f'{name}: the owner\'s sleep is accepted', actions[name]['status'] == 202, actions[name]['status'])
        m = mapping(name)
        views[name] = tl.placement(name)
        tl.check_released(step, views[name], f'{name} asleep')
        proof = m['fencing_receipt'] or {}
        step.check(f'{name}: the drained generation retired on its kubelet\'s report (OBSERVED_STOP)', proof.get('kind') == 'OBSERVED_STOP'
                   and (proof.get('predecessor') or {}).get('generation') == awake[name]['generation'] and bool(proof.get('retiredAt')),
                   {k: proof.get(k) for k in ('kind', 'recordedAt', 'retiredAt')})
        step.check(f'{name}: no compute held while asleep', not (m['reservation'] or {}).get('compute'), (m['reservation'] or {}).get('compute'))
        step.check(f'{name}: the claim is kept, bound to the same PV', identity(name)['pvcUid'] == awake[name]['pvcUid']
                   and identity(name)['pvUid'] == awake[name]['pvUid'])
    return {'actions': {n: {k: a.get(k) for k in ('status', 'before')} for n, a in actions.items()}, 'until': slept, 'placement': views,
            'sleepToAsleepSeconds': {n: s['seconds'] for n, s in slept.items()}}


def move_wake(ctx, step):
    """The first node cordoned and the second not: ann woken by a message to her session, bob by a task run now."""
    awake = {name: ctx['identity'][name] for name in USERS}
    nodes = {'first': tl.cordon(1, 'cordon'), 'second': tl.cordon(2, 'uncordon')}
    at = now()
    demands = {'ann': wl.new_turn('ann', ctx['sessions']['ann']['s1'], f"{marker('ann', 'MOVE')} a message that wakes the runner on the other node"),
               'bob': al.new_task_on('bob', f"{marker('bob', 'MOVE')} a task run now that wakes the runner on the other node", run_now=True)}
    step.check('the message and the task run are accepted', demands['ann']['status'] in (200, 201) and demands['bob']['status'] in (200, 201)
               and (demands['bob'].get('execute') or {}).get('status') in (200, 201), {n: d['status'] for n, d in demands.items()})
    found = {name: al.answered(owner_uuid(name), marker(name, 'MOVE'), timeout=420, after=at) for name in USERS}
    ready = {name: until(name, 'READY', timeout=180) for name in USERS}
    results = {'nodes': nodes, 'demands': demands, 'answered': found, 'ready': ready}
    snaps, probes, views = {}, {}, {}
    for name in USERS:
        after = identity(name)
        views[name] = moved(step, name, awake[name], after, 2, f'after the move to {NODES[2]}')
        step.check(f'{name}: the waking work was answered on {name}\'s runner', found[name]['event']['ingested_by_runner_id'] == after['runnerId']
                   and found[name]['session']['assigned_runner_id'] == after['runnerId'], found[name]['event'])
        ctx['identity'][name] = after
    step.check('bob: the run was the task\'s', bool(found['bob']['session']['task_id']), found['bob']['session'])
    al.continuation_check(step, 'ann', found['ann'], ctx['sessions']['ann']['secret'], f'on {NODES[2]}')
    results['bobFirstSession'] = resumed(step, ctx, 'bob', 'MOVED', f'on {NODES[2]}')
    for name in USERS:
        probes[name], snaps[name] = data_kept(step, ctx, name, ctx['snapshots']['first'][name], f'on {NODES[2]}')
    nodes['firstAgain'] = tl.cordon(1, 'uncordon')  # both schedulable from here on; the runners stay where they run
    ctx['snapshots']['moved'] = snaps
    results.update(probes=probes, snapshots=snaps, placement=views, times={name: al.provisioned(name) for name in USERS},
                   seconds={name: {'demandToAnswered': al.seconds_between(at, found[name]['event']['ingested_at']),
                                   'demandToReady': al.seconds_between(at, ready[name]['at']),
                                   'demandToPodCreated': al.seconds_between(at, al.provisioned(name)['podCreatedAt'])} for name in USERS})
    return results


# ---- second Pods on the other node -------------------------------------------------------------------------------------

def duplicate_writers(ctx, step):
    """single-writer.py's payload writer in both runner containers, started together. Two volumes on the one HDD fsync
    more slowly than one, so this waits longer for the first 100 rows than single-writer.py's own start does."""
    started = {}
    for name in USERS:
        m, pod = ml.running_pod(name)
        p = pod['metadata']['name']
        sw.pod_exec(p, 'sh', '-c', f'cat > {sw.PAYLOAD_IN_POD}', input=sw.payload_source())
        sw.pod_exec(p, 'sh', '-c', f'mkdir -p {sw.PAYLOAD_ROOT} && nohup python3 {sw.PAYLOAD_IN_POD} writer --run-id {tl.WRITER_RUN} '
                    f'< /dev/null > {WRITER_LOG} 2>&1 &')
        started[name] = {'at': now(), 'pod': p, 'podUid': m['pod_uid'], 'generation': m['generation'], 'node': m['node_name']}
    deadline = time.monotonic() + 300
    while True:
        rows = {name: writer_rows(name) for name in USERS}
        if all(count >= 100 for count in rows.values()):
            break
        if time.monotonic() > deadline:
            raise Failed(f'the writers committed {rows} rows in 300 s')
        time.sleep(3)
    for name in USERS:
        started[name]['hundredRowsAt'] = now()
        sw.pod_exec(started[name]['pod'], 'python3', '-c', RANDOM_FILE, f'{sw.PAYLOAD_ROOT}/{tl.WRITER_RUN}/random.bin')
        started[name]['committedRows'] = writer_rows(name)
        step.check(f'{name}: the probe writer commits rows in the runner container on {NODES[2]}', started[name]['committedRows'] >= 100
                   and started[name]['node'] == NODES[2], [started[name]['committedRows'], started[name]['node']])
    ctx['writers'] = started
    return started


def contenders(name, other):
    """The second Pods T02 tried, for NAME's claim, pinned to OTHER, with what the guard must answer."""
    m = mapping(name)
    pod = kget('pod', m['pod_name'])
    claim = m['pvc_name']
    copy = tl.contender(pod['metadata']['name'], pod, other, claim, labelled=True)
    following = json.loads(json.dumps(copy))
    following['metadata']['annotations']['orbit.dev/generation'] = str(m['generation'] + 1)
    return pod, [
        (f'{name}: unlabelled Pod, another name, on {other}, by the cluster admin', tl.contender(f't08x-{name}-second-admin', None, other, claim), False,
         'NOT_THE_MANAGER'),
        (f'{name}: unlabelled Pod, another name, on {other}, by the manager identity', tl.contender(f't08x-{name}-second-manager', None, other, claim), True,
         'NOT_THE_FIXED_NAME'),
        (f'{name}: copy of the runner\'s Pod under another name, on {other}, by the manager',
         tl.contender(f't08x-{name}-second-copy', pod, other, claim, labelled=True), True, 'NOT_THE_FIXED_NAME'),
        (f'{name}: copy of the runner\'s Pod under its fixed name, same generation, on {other}, by the manager', copy, True, 'NOT_RESERVED'),
        (f'{name}: the fixed name for the next generation, unreserved, on {other}, by the manager', following, True, 'NOT_THE_RESERVED_GENERATION'),
    ]


def judge(step, attempts):
    for a in attempts:
        step.check(f"{a['case']}: refused by the admission guard, {a['expected']}", not a['admitted'] and a['code'] == a['expected'], a['answer'][-220:])


def duplicate_guard(ctx, step):
    other = NODES[1]
    results = {}
    for name in USERS:
        m = mapping(name)
        step.check(f'{name}: the runner runs on {NODES[2]}; the contenders go to {other}', m['node_name'] == NODES[2], m['node_name'])
        before = {'placement': tl.placement(name), 'writerRows': writer_rows(name)}
        pod, shapes = contenders(name, other)
        attempts = [tl.attempt(label, body, manager=manager, expect=expect) for label, body, manager, expect in shapes]
        # A controller's Pod: the Job controller creates it under its own identity.
        job_name = f't08x-{name}-second-job'
        job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': job_name, 'namespace': NAMESPACE},
               'spec': {'backoffLimit': 0, 'template': tl.contender('unused', None, other, m['pvc_name'])}}
        job['spec']['template'].pop('apiVersion')
        job['spec']['template'].pop('kind')
        job['spec']['template']['metadata'] = {'labels': {'t08x': job_name}}
        created = sw.kubectl('create', '-f', '-', input=json.dumps(job), check=False)
        time.sleep(12)
        events = kjson('get', 'events', '--field-selector', f'involvedObject.name={job_name}')['items']
        job_pods = kjson('get', 'pods', '-l', f't08x={job_name}')['items']
        sw.kubectl('delete', 'job', job_name, '--cascade=foreground', '--wait=false', check=False)
        job_result = {'case': f"{name}: a Job's Pod on the claim on {other}, created by the Job controller", 'jobCreated': created.returncode == 0,
                      'admitted': bool(job_pods), 'podsCreated': [p['metadata']['name'] for p in job_pods],
                      'events': sorted({f"{e['reason']}: {e['message']}" for e in events})}
        time.sleep(3)
        after = {'placement': tl.placement(name), 'writerRows': writer_rows(name)}
        judge(step, attempts)
        step.check(job_result['case'] + ': no Pod; the Job controller\'s create refused by the guard', not job_result['admitted']
                   and any('orbit-managed-runner-admission' in e and 'NOT_THE_MANAGER' in e for e in job_result['events']), job_result['events'])
        step.check(f'{name}: the authorized Pod is the same one, still running on {NODES[2]}',
                   (before['placement']['pod'] or {}).get('uid') == (after['placement']['pod'] or {}).get('uid') == m['pod_uid'])
        tl.check_placed(step, after['placement'], 2, f'{name}, after the contenders')
        step.check(f'{name}: no Pod on {other} references the claim', not [p for p in after['placement']['podsOnTheClaim'] if p['node'] == other],
                   after['placement']['podsOnTheClaim'])
        step.check(f'{name}: the writer kept committing rows meanwhile', after['writerRows'] > before['writerRows'], [before['writerRows'], after['writerRows']])
        results[name] = {'before': before, 'attempts': attempts, 'job': job_result, 'after': after}
    results['mixed'] = mixed_owners(step, other)
    return results


def mixed_owners(step, other):
    """Pods mixing the two owners' runners and claims, on the other node: the guard resolves a claim's owner from the database."""
    ann, bob = mapping('ann'), mapping('bob')
    ann_pod, bob_pod = kget('pod', ann['pod_name']), kget('pod', bob['pod_name'])
    swapped = tl.contender(bob_pod['metadata']['name'], bob_pod, other, bob['pvc_name'], labelled=True)
    for volume in swapped['spec']['volumes']:
        if volume.get('persistentVolumeClaim'):
            volume['persistentVolumeClaim']['claimName'] = ann['pvc_name']
    renamed = tl.contender(ann_pod['metadata']['name'], ann_pod, other, ann['pvc_name'], labelled=True)
    renamed['metadata']['annotations'].update({'orbit.dev/owner-id': bob['owner_id'], 'orbit.dev/runner-id': bob['runner_id']})
    both = tl.contender('t08x-both-claims', None, other, ann['pvc_name'])
    both['spec']['volumes'].append({'name': 'other', 'persistentVolumeClaim': {'claimName': bob['pvc_name']}})
    both['spec']['containers'][0]['volumeMounts'].append({'name': 'other', 'mountPath': '/var/lib/other'})
    attempts = [
        tl.attempt(f'bob\'s runner Pod under his fixed name with ann\'s claim in place of his, on {other}, by the manager', swapped, manager=True,
                   expect='NOT_THE_FIXED_NAME'),
        tl.attempt(f'ann\'s fixed name and claim naming bob as owner and runner, on {other}, by the manager', renamed, manager=True, expect='NOT_THE_OWNER'),
        tl.attempt(f'one Pod on both claims, on {other}, by the manager', both, manager=True, expect='MULTIPLE_MANAGED_CLAIMS'),
    ]
    judge(step, attempts)
    for name in USERS:
        step.check(f'{name}: still one Pod on the claim, on {NODES[2]}', [p['node'] for p in tl.placement(name)['podsOnTheClaim']] == [NODES[2]])
    return attempts


# ---- the second node fails --------------------------------------------------------------------------------------------

def takeover_prepare(ctx, step):
    """Each runner on the second node: probe p2 written there, its credential saved, its volume's state read."""
    ctx['takeover'] = {}
    results = {}
    for name in USERS:
        view = tl.placement(name)
        tl.check_placed(step, view, 2, f'{name} before the failure')
        probe = capture(wl.cmd_probe, name=name, action='write', run='p2')
        step.check(f'{name}: probe p2 written on {NODES[2]}, integrity_check ok', probe['data']['integrityCheck'] == 'ok', probe['data']['rows'])
        with as_owner(name):
            credential = capture(sw.cmd_credential, action='save')
        m = mapping(name)
        step.check(f'{name}: the saved credential is this generation\'s', credential['generation'] == m['generation'] and credential['podUid'] == m['pod_uid'],
                   {k: credential[k] for k in ('generation', 'podUid')})
        snap = al.pod_snapshot(name, al.transcript_prefix(ctx['snapshots']['moved'][name]))
        ctx['takeover'][name] = {'runnerId': m['runner_id'], 'generation': m['generation'], 'podUid': m['pod_uid'], 'podName': m['pod_name'],
                                 'nodeName': m['node_name'], 'probeP2At': probe['at']}
        ctx.setdefault('snapshots', {}).setdefault('beforeCut', {})[name] = snap
        results[name] = {'placement': view, 'probe': probe, 'snapshot': snap,
                         'credential': {k: credential[k] for k in ('generation', 'podUid', 'tokenSha256Prefix')}}
    # The snapshots' git status and fsck were the last Git work on the volumes before the cut.
    ctx['takeover']['lastGitAt'] = now()
    results.update(nodes={NODES[n]: tl.node_view(n) for n in (1, 2)}, lastGitAt=ctx['takeover']['lastGitAt'], memory=memory('before the failure'))
    return results


def takeover_last(ctx, step):
    """No Git work for a minute; then a last message to each session, whose answer is the last thing each engine writes."""
    taken = ctx['takeover']
    wait = QUIET_SECONDS - al.seconds_between(taken['lastGitAt'], now())
    if wait > 0:
        time.sleep(wait)
    results = {}
    for name in USERS:
        _, pod = ml.running_pod(name)
        sw.pod_exec(pod['metadata']['name'], 'touch', LAST_TURN_STAMP)
        results[name] = {'stampAt': now(), 'transcriptsBefore': transcripts(name)}
    at = now()
    for name in USERS:
        results[name]['turn'] = wl.new_turn(name, ctx['sessions'][name]['s1'],
                                            f"{marker(name, 'LAST')} the last message before the power cut. T03-SECRET {name}last")
    for name in USERS:
        found = al.answered(owner_uuid(name), marker(name, 'LAST'), timeout=180, after=at)
        step.check(f'{name}: the last message was answered by {name}\'s runner on {NODES[2]}', found['event']['ingested_by_runner_id'] == taken[name]['runnerId']
                   and mapping(name)['node_name'] == NODES[2], found['event'])
        results[name]['answered'] = found
        taken[name]['lastTurn'] = {'stampAt': results[name]['stampAt'], 'sentAt': results[name]['turn']['at'], 'answeredAt': found['event']['ingested_at'],
                                   'transcriptsBefore': results[name]['transcriptsBefore']}
    results['secondsSinceLastGit'] = al.seconds_between(taken['lastGitAt'], now())
    step.check(f'no Git work on either volume for {QUIET_SECONDS} s', results['secondsSinceLastGit'] >= QUIET_SECONDS, results['secondsSinceLastGit'])
    return results


def takeover_cut(ctx, step):
    """The second VM's power cut (stop.sh --node 2 --hard) while both writers commit rows there; ann's volume synced (syncfs)
    right before it, bob's not."""
    taken = ctx['takeover']
    for name in USERS:
        m = mapping(name)
        step.check(f'{name}: READY on {NODES[2]} with its writer running', m['management_state'] == 'READY' and m['node_name'] == NODES[2],
                   {k: m[k] for k in ('management_state', 'node_name')})
    pre = {name: tl.payload_snapshot(mapping(name)['pod_name']) for name in USERS}  # a read beside each writer
    last = {name: writer_rows(name) for name in USERS}
    right_before = {}
    for name in USERS:
        right_before[name] = {'at': now(), 'transcripts': transcripts(name), 'written': in_runner(name, 'python3', '-c', FILES_SINCE, LAST_TURN_STAMP)}
    gate_before = ml.gate_connections()
    _, ann_pod = ml.running_pod('ann')
    sync_at = now()
    synced = sw.pod_exec(ann_pod['metadata']['name'], 'sync', '-f', '/var/lib/orbit')
    sync_done = now()
    result = al.run([str(LAB / 'stop.sh'), '--node', '2', '--hard'])
    said = result.stdout + result.stderr
    killed = re.search(r'killed with SIGKILL at (\S+);', said)
    step.check('stop.sh killed the second VM\'s qemu with SIGKILL', bool(killed), said.strip()[-400:])
    step.check('ann\'s volume was synced (sync -f /var/lib/orbit in her runner container) just before', synced.returncode == 0, synced.stderr.strip()[-200:])
    power = tl.power_state(2)
    step.check('the second VM is off: its unit inactive, no qemu process, SSH and QMP refused, the link down',
               power['activeState'] in ('inactive', 'failed') and not power['qemuProcesses'] and power['sshRefused'] and power['qmpRefused']
               and not power['linkConnections'], power)
    killed_at = killed.group(1) if killed else now()
    taken['killedAt'] = killed_at
    taken['gateBefore'] = gate_before
    taken['annSync'] = {'startedAt': sync_at, 'endedAt': sync_done, 'secondsBeforeTheCut': al.seconds_between(sync_done, killed_at.replace('Z', '+00:00'))}
    for name in USERS:
        taken[name].update(beforeCut={k: pre[name][k] for k in ('acknowledgedRows', 'acknowledgedSHA256', 'committedRows', 'rowSHA256', 'ordinarySHA256',
                                                               'gitCommit', 'randomSHA256')},
                           lastAcknowledgedRead=last[name], rightBefore=right_before[name])
    seconds = {name: {'lastGitToCut': al.seconds_between(taken['lastGitAt'], killed_at.replace('Z', '+00:00')),
                      'lastAnswerToCut': al.seconds_between(taken[name]['lastTurn']['answeredAt'], killed_at.replace('Z', '+00:00'))} for name in USERS}
    for name in USERS:
        step.check(f'{name}: no Git work in the {QUIET_SECONDS} s before the cut', seconds[name]['lastGitToCut'] >= QUIET_SECONDS, seconds[name])
    return {'stopSh': said.strip().splitlines(), 'killedAt': killed_at, 'power': power, 'writersBeforeCut': pre, 'lastAcknowledgedRowsRead': last,
            'rightBefore': right_before, 'annSync': taken['annSync'], 'seconds': seconds}


def watchers_of(images):
    """Each image's RBD watchers, in one cephadm shell."""
    answers = sw.ceph(*[f'rbd status --format json {image}' for image in images])
    found = {}
    for image, text in zip(images, answers):
        try:
            found[image] = json.loads(text).get('watchers')
        except ValueError:
            found[image] = text[-200:]
    return found


def loss_round(idents, watch):
    """One sample of both accounts while the node is gone: mapping, runner row, owner's status, Pods and attachments."""
    node = tl.node_view(2)
    seen = watchers_of([tl.rbd_image(idents[name]) for name in USERS]) if watch else {}
    owners = {}
    for name in USERS:
        m = mapping(name)
        runner = wl.sql_json(f"select status, {sw.runner_last_beat()} as last_heartbeat_at from runner where id = {wl.quote(m['runner_id'])}")[0]
        status = ml.status_of(name)
        owners[name] = {'mapping': {'state': m['management_state'], 'desired': m['desired_state'], 'generation': m['generation'], 'podUid': m['pod_uid'],
                                    'reason': (m['last_error'] or {}).get('code'), 'attempt': m['attempt'], 'proof': (m['fencing_receipt'] or {}).get('kind')},
                        'runner': runner, 'ownerStatus': {k: status.get(k) for k in ('managementState', 'usable', 'heartbeatStatus', 'reason')},
                        'pod': tl.pod_view(f"mr-{m['runner_id']}"), 'podsOnTheClaim': tl.pods_on_claim(idents[name]['pvcName']),
                        'volumeAttachments': tl.attachments(idents[name]['pvName']),
                        'watchers': seen.get(tl.rbd_image(idents[name])) if watch else None}
    return {'at': now(), 'node': node, 'owners': owners, 'gateConnections': ml.gate_connections()}


def outage_contenders(ctx):
    """While the second node is down and nothing is fenced: second Pods on each claim, pinned to the first node. The stale
    Pod objects still hold the fixed names, and the volumes are still attached to the dead node."""
    started = now()
    results = {}
    for name in USERS:
        m = mapping(name)
        pod = kget('pod', m['pod_name'])
        claim = m['pvc_name']
        copy = tl.contender(pod['metadata']['name'], pod, NODES[1], claim, labelled=True)
        following = json.loads(json.dumps(copy))
        following['metadata']['annotations']['orbit.dev/generation'] = str(m['generation'] + 1)
        attempts = [
            tl.attempt(f'{name}: unlabelled Pod on the claim, on {NODES[1]}, by the cluster admin', tl.contender(f't08x-{name}-outage-admin', None, NODES[1], claim),
                       expect='NOT_THE_MANAGER'),
            tl.attempt(f'{name}: copy of the stale Pod under another name, on {NODES[1]}, by the manager',
                       tl.contender(f't08x-{name}-outage-copy', pod, NODES[1], claim, labelled=True), manager=True, expect='NOT_THE_FIXED_NAME'),
            tl.attempt(f'{name}: copy of the stale Pod under its fixed name, same generation, on {NODES[1]}, by the manager', copy, manager=True,
                       expect='NOT_RESERVED'),
            tl.attempt(f'{name}: the fixed name for the next generation, with no receipt, on {NODES[1]}, by the manager', following, manager=True,
                       expect='NOT_THE_RESERVED_GENERATION'),
        ]
        results[name] = {'attempts': attempts, 'podsOnTheClaimAfter': tl.pods_on_claim(claim)}
    return {'startedAt': started, 'endedAt': now(), 'owners': results}


def takeover_heartbeat_loss(ctx, step):
    """No proof yet: the node is gone, both runners silent. For OBSERVE seconds nothing may take over, under demand too;
    second Pods on the other node are refused meanwhile."""
    taken = ctx['takeover']
    idents = {name: identity(name) for name in USERS}
    timeline = Path(ctx['out']) / 'records' / 'takeover-heartbeat-loss-timeline.jsonl'
    killed = taken['killedAt'].replace('Z', '+00:00')
    window = ctx['observeSeconds']
    samples, demand, retry, contended = [], {}, {}, None
    last_watch = None
    while True:
        elapsed = al.seconds_between(killed, now())
        if elapsed >= window:
            break
        try:
            watch = last_watch is None or time.monotonic() - last_watch >= 30
            sample = loss_round(idents, watch)
            if watch:
                last_watch = time.monotonic()
        except (Exception, SystemExit) as error:  # recorded and sampled again
            sample = {'at': now(), 'error': str(error)[-300:]}
        sample['secondsSinceCut'] = elapsed
        samples.append(sample)
        with timeline.open('a') as stream:
            stream.write(json.dumps(sample, sort_keys=True) + '\n')
        if not demand and elapsed >= 150:
            # Demand while the node is gone: each message waits, and may not make the manager start anything.
            for name in USERS:
                demand[name] = wl.new_turn(name, ctx['sessions'][name]['s1'], f"{marker(name, 'DURING-LOSS')} a message while the runner's node is down")
                retry[name] = capture(ml.cmd_action, name=name, action='retry')
        if contended is None and elapsed >= 210:
            contended = outage_contenders(ctx)
        time.sleep(2)
    good = [s for s in samples if 'error' not in s]
    step.check('samples were taken through the whole window', len(good) >= window // 15, len(good))
    nodes = sorted({(s['node'] or {}).get('ready') for s in good})
    step.check(f'{NODES[2]} went Unknown', 'Unknown' in nodes, nodes)
    measures = {}
    for name in USERS:
        mine = [s['owners'][name] for s in good]
        states = sorted({o['mapping']['state'] for o in mine})
        generations = sorted({o['mapping']['generation'] for o in mine})
        pods = sorted({p['uid'] for o in mine for p in o['podsOnTheClaim']})
        step.check(f'{name}: the mapping kept its generation and its recorded Pod: nothing was replaced', generations == [taken[name]['generation']]
                   and {o['mapping']['podUid'] for o in mine} == {taken[name]['podUid']}, {'generations': generations})
        step.check(f'{name}: READY throughout, as the coordinator\'s decision of 2026-10-19 keeps it (no FENCING before the taint)', states == ['READY'], states)
        step.check(f'{name}: only the old Pod object ever referenced the claim', pods == [taken[name]['podUid']], pods)
        step.check(f'{name}: the VolumeAttachment stayed on {NODES[2]}', all([a['node'] for a in o['volumeAttachments']] == [NODES[2]] for o in mine))
        step.check(f'{name}: the owner\'s status said the runner is not usable', any(o['ownerStatus'].get('usable') is False for o in mine))
        step.check(f'{name}: the message sent meanwhile was accepted', demand.get(name, {}).get('status') in (200, 201), demand.get(name, {}).get('status'))
        step.check(f'{name}: the owner\'s retry did not start anything', name in retry and retry[name]['status'] != 202,
                   retry.get(name) and {k: retry[name].get(k) for k in ('status', 'answer')})
        pending = wl.sql_json(f"select status from conversation_turn where session_id = {wl.quote(ctx['sessions'][name]['s1Uuid'])} order by created_at desc limit 1")
        step.check(f'{name}: the message is still waiting at the end of the window', pending and pending[0]['status'] == 'PENDING', pending)
        first = lambda predicate: next((s['secondsSinceCut'] for s in good if predicate(s['owners'][name])), None)
        measures[name] = {'statesSeen': states, 'firstUnusableSeconds': first(lambda o: o['ownerStatus'].get('usable') is False),
                          'firstEvictedSeconds': first(lambda o: (o['pod'] or {}).get('deletionTimestamp')),
                          'watcherGoneSeconds': first(lambda o: o['watchers'] == [])}
        taken[name]['demand'] = demand.get(name)
    step.check('the contenders were tried while the node was down', contended is not None)
    for name in USERS:
        judge(step, contended['owners'][name]['attempts'])
        step.check(f'{name}: still only the stale Pod on the claim after the contenders', [p['uid'] for p in contended['owners'][name]['podsOnTheClaimAfter']]
                   == [taken[name]['podUid']], contended['owners'][name]['podsOnTheClaimAfter'])
    # The manager's own requests, outside the contenders' few seconds (whose requests as the manager pass the gate too).
    gate = {'beforeContenders': al.gate_summary(taken['killedAt'].replace('Z', '+00:00'), contended['startedAt']),
            'contenders': al.gate_summary(contended['startedAt'], contended['endedAt']),
            'afterContenders': al.gate_summary(contended['endedAt'])}
    for label in ('beforeContenders', 'afterContenders'):
        kinds = gate[label]['byKind']
        step.check(f'the gate saw no Pod create, Secret create or admission probe from the manager ({label})',
                   not kinds.get('Pod create') and not kinds.get('Secret create') and not kinds.get('admission probe'), kinds)
    first_unknown = next((s['secondsSinceCut'] for s in good if (s['node'] or {}).get('ready') == 'Unknown'), None)
    return {'windowSeconds': window, 'samples': len(samples), 'errors': [s for s in samples if 'error' in s][:5], 'firstUnknownSeconds': first_unknown,
            'owners': measures, 'first': good[0] if good else None, 'last': good[-1] if good else None, 'gate': gate, 'demand': demand,
            'retry': {n: {k: r.get(k) for k in ('status', 'answer', 'before')} for n, r in retry.items()}, 'contenders': contended,
            'timeline': str(timeline), 'memory': memory('second node down')}


def watch_both(predicate, seconds, label):
    """Both mappings, their runner Pod objects, the Pods on their claims and their attachments every second, until predicate."""
    idents = {name: identity(name) for name in USERS}
    deadline, seen, last = time.monotonic() + seconds, [], None
    while True:
        sample, maps = {'at': now()}, {}
        for name in USERS:
            m = maps[name] = mapping(name)
            pod = tl.pod_view(f"mr-{m['runner_id']}")
            sample[name] = {'state': m['management_state'], 'generation': m['generation'], 'reason': (m['last_error'] or {}).get('code'), 'podUid': m['pod_uid'],
                            'proof': (m['fencing_receipt'] or {}).get('kind'), 'proofRetired': bool((m['fencing_receipt'] or {}).get('retiredAt')),
                            'pod': pod and {k: pod[k] for k in ('uid', 'node', 'phase', 'deletionTimestamp', 'finalizers', 'disruptionTarget')},
                            'podsOnTheClaim': [(p['uid'][:8], p['node'], p['phase']) for p in tl.pods_on_claim(idents[name]['pvcName'])],
                            'volumeAttachments': [(a['node'], a['attached'], a['deleting']) for a in tl.attachments(idents[name]['pvName'])]}
        compare = {k: v for k, v in sample.items() if k != 'at'}
        if compare != last:
            seen.append(sample)
            last = compare
        if predicate(sample, maps):
            return seen, sample, maps
        if time.monotonic() > deadline:
            raise Failed(f'{label}: not reached within {seconds} s: {seen[-3:]}')
        time.sleep(1)


def takeover_fence(ctx, step):
    """The runbook's failover for the two runners the failed node held: identify them, verify the power-off, a receipt
    each, the out-of-service taint, then each stale Pod's finalizer off: bob's at once, ann's once she is FENCING."""
    taken = ctx['takeover']
    power = tl.power_state(2)
    step.check('the power-off is verified again before anything is released', power['activeState'] in ('inactive', 'failed') and not power['qemuProcesses']
               and power['sshRefused'] and power['qmpRefused'], power)
    # 1. Identify the predecessors: the runbook's query, then its commands for each runner.
    query = runbook_sql('the runbook\'s query of every account\'s runner', runbook_block("Find an account's runner", 'from managed_runner m', 'sql'))
    on_node = sorted((row for row in query['rows'] if row.get('node_name') == NODES[2]), key=lambda row: row['email'])
    step.check(f'the runbook\'s query names both runners on {NODES[2]}, READY, with the generation and Pod each mapping recorded', query['exit'] == 0
               and [(r['runner_id'], r['management_state'], int(r['generation']), r['pod_uid']) for r in on_node]
               == [(taken[n]['runnerId'], 'READY', taken[n]['generation'], taken[n]['podUid']) for n in USERS], query['rows'] or query['stderr'])
    found = {}
    for name in USERS:
        found[name] = runbook_bash(f'{name}: the runbook\'s commands to find the runner', find_runner_block(), R=taken[name]['runnerId'])
        found[name]['rbdStatus'] = tl.watchers(tl.rbd_image(identity(name)))
        step.check(f'{name}: they show the stale Pod on {NODES[2]} and the volume still attached there, with no RBD client left', found[name]['exit'] == 0
                   and NODES[2] in found[name]['stdout'] and found[name]['rbdStatus'] == [], {k: found[name][k] for k in ('exit', 'stdout', 'stderr', 'rbdStatus')})
    # 2 and 3. The node is fenced (powered off and kept off); a receipt for each predecessor, as the mapping names it.
    node_uid = ctx['nodeUids'][NODES[2]]
    receipts, configmaps = {}, {}
    folder = SERVER / 'receipts'
    folder.mkdir(mode=0o700, exist_ok=True)
    for name in USERS:
        m, ident = mapping(name), identity(name)
        receipt = tl.fencing_receipt(m, ident, node_uid, taken['killedAt'], power, now())
        receipt['action']['reference'] = f'T08x lab, {EVIDENCE}'
        path = folder / f"mr-fence-{m['runner_id']}.json"
        path.write_text(json.dumps(receipt, indent=2))
        receipts[name] = receipt
        configmaps[name] = runbook_bash(f'{name}: the receipt as ConfigMap mr-fence-<runner uuid>, key receipt.json',
                                        '$K create configmap "mr-fence-$R" --from-file=receipt.json="$RECEIPT"', R=m['runner_id'], RECEIPT=str(path))
        step.check(f'{name}: the receipt ConfigMap is written', configmaps[name]['exit'] == 0, configmaps[name]['stderr'] or configmaps[name]['stdout'])
    receipt_at = now()
    # 4. Kubernetes releases the volumes: the taint, then the finalizers.
    taint = runbook_bash(f'the out-of-service taint on {NODES[2]}', '$K taint node "$NODE" node.kubernetes.io/out-of-service=nodeshutdown:NoExecute',
                         NODE=NODES[2])
    taint_at = now()
    step.check(f'{NODES[2]} is tainted out of service', taint['exit'] == 0, taint['stderr'] or taint['stdout'])
    finalizer = runbook_block('The stop-report finalizer', 'UID_=')
    released = {'bob': runbook_bash('bob: the runbook\'s finalizer patch, at once', finalizer, R=taken['bob']['runnerId'])}
    released['bob']['at'] = now()
    step.check('bob: the finalizer is off, right after the taint', released['bob']['exit'] == 0, released['bob']['stderr'] or released['bob']['stdout'])
    seen_fence, fenced, _ = watch_both(lambda s, ms: s['ann']['state'] == 'FENCING' and (s['ann']['pod'] or {}).get('phase') in ('Failed', 'Succeeded'), 240,
                                       'ann FENCING after the out-of-service taint')
    step.check('ann: the stale Pod was made Failed by the control plane, not by its kubelet (DisruptionTarget)',
               ((fenced['ann']['pod'] or {}).get('disruptionTarget') or {}).get('reason') in ('DeletionByPodGC', 'DeletionByTaintManager'),
               (fenced['ann']['pod'] or {}).get('disruptionTarget'))
    step.check('ann: FENCING, the stop unproven', fenced['ann']['reason'] == 'PREDECESSOR_STOP_UNPROVEN', fenced['ann']['reason'])
    step.check('ann: the stale Pod is held by the stop-report finalizer', STOP_REPORT in ((fenced['ann']['pod'] or {}).get('finalizers') or []),
               (fenced['ann']['pod'] or {}).get('finalizers'))
    with as_owner('ann'):
        replay = capture(sw.cmd_credential, action='replay')
    old = [r for r in replay['results'] if r['credential'] == f"generation {taken['ann']['generation']}"]
    step.check('ann: the predecessor\'s credential is refused 401 once she is FENCING, at every door', old and all(r['status'] == 401 for r in old),
               sorted({(r['route'], r['status']) for r in old}))
    released['ann'] = runbook_bash('ann: the runbook\'s finalizer patch, once FENCING', finalizer, R=taken['ann']['runnerId'])
    released['ann']['at'] = now()
    step.check('ann: the finalizer is off', released['ann']['exit'] == 0, released['ann']['stderr'] or released['ann']['stdout'])
    seen_next, ready, maps = watch_both(lambda s, ms: all(s[n]['state'] == 'READY' and s[n]['generation'] > taken[n]['generation'] for n in USERS), 600,
                                        'READY on the next generations')
    gate = al.gate_summary(receipt_at)
    results = {'power': power, 'query': query, 'found': found, 'receipts': receipts, 'configMaps': configmaps, 'receiptAt': receipt_at, 'taint': taint,
               'taintAt': taint_at, 'finalizer': released, 'untilAnnFencing': seen_fence, 'replayWhileFenced': replay, 'untilReady': seen_next, 'gate': gate}
    samples = seen_fence + seen_next
    for name in USERS:
        m = maps[name]
        after = identity(name)
        proof = m['fencing_receipt'] or {}
        al.same_identity(step, name, ctx['identity'][name], after, 'after the takeover')
        step.check(f'{name}: the receipt was accepted: the predecessor retired on FENCING_RECEIPT, from its ConfigMap',
                   proof.get('kind') == 'FENCING_RECEIPT' and (proof.get('source') or {}).get('configMap') == f"mr-fence-{m['runner_id']}" and bool(proof.get('retiredAt'))
                   and (proof.get('predecessor') or {}).get('generation') == taken[name]['generation']
                   and (proof.get('predecessor') or {}).get('podUid') == taken[name]['podUid'], {k: proof.get(k) for k in ('kind', 'source', 'recordedAt', 'retiredAt')})
        step.check(f'{name}: the next generation, a new Pod', after['generation'] == taken[name]['generation'] + 1 and after['podUid'] not in (None, taken[name]['podUid']),
                   [after['generation'], after['podUid']])
        view = tl.placement(name)
        tl.check_placed(step, view, 1, f'{name}, generation {after["generation"]}')
        step.check(f'{name}: never two Pods on the claim while it moved', all(len(s[name]['podsOnTheClaim']) <= 1 for s in samples))
        step.check(f'{name}: never two VolumeAttachments while it moved', all(len(s[name]['volumeAttachments']) <= 1 for s in samples))
        made = sorted({uid for s in samples for uid, _node, _phase in s[name]['podsOnTheClaim']} - {taken[name]['podUid'][:8]})
        step.check(f'{name}: one Pod was made on the claim since the receipts: the next generation\'s', made == [after['podUid'][:8]], made)
        # A receipt is read only while FENCING, so FENCING_RECEIPT is the proof that the mapping passed through it; the
        # sampler, once a second, may miss a FENCING shorter than that (bob's, whose Pod object went at once).
        states = [s[name]['state'] for s in samples]
        fencing_at = next((s['at'] for s in samples if s[name]['state'] == 'FENCING'), None)
        ready_at = next(s['at'] for s in samples if s[name]['state'] == 'READY' and s[name]['generation'] > taken[name]['generation'])
        taken[name].update(fencingAt=fencing_at, finalizerOffAt=released[name]['at'], readyAt=ready_at, receipt=receipts[name])
        ctx['identity'][name] = after
        results[name] = {'identity': after, 'proof': proof, 'placement': view, 'times': al.provisioned(name),
                         'statesInOrder': [s for i, s in enumerate(states) if i == 0 or s != states[i - 1]], 'fencingSeenAt': fencing_at,
                         'seconds': {'cutToReceipt': al.seconds_between(taken['killedAt'].replace('Z', '+00:00'), receipt_at),
                                     'taintToFencingSeen': fencing_at and al.seconds_between(taint_at, fencing_at),
                                     'finalizerOffToReady': al.seconds_between(released[name]['at'], ready_at),
                                     'cutToReady': al.seconds_between(taken['killedAt'].replace('Z', '+00:00'), ready_at)}}
    step.check('since the receipts the gate saw two Pod creates: one next generation each', gate['byKind'].get('Pod create') == 2, gate['byKind'])
    taken.update(receiptAt=receipt_at, taintAt=taint_at)
    results['nodes'] = {NODES[n]: tl.node_view(n) for n in (1, 2)}
    return results


def takeover_data(ctx, step):
    """Each account's data on the first node: what its writer acknowledged, the probes, the session, and what the last
    seconds before the cut left: ann's volume synced, bob's not."""
    taken = ctx['takeover']
    results = {}
    for name in USERS:
        t = taken[name]
        m = mapping(name)
        before = t['beforeCut']
        recovered = tl.payload_snapshot(m['pod_name'], minimum_rows=before['acknowledgedRows'], recover=True)
        step.check(f'{name}: SQLite integrity_check ok after WAL recovery, still in WAL mode', recovered['sqliteIntegrity'] == ['ok']
                   and recovered['sqliteJournalMode'] == 'wal', [recovered['sqliteIntegrity'], recovered['sqliteJournalMode']])
        step.check(f'{name}: every row acknowledged before the cut is there (the last read and the one on disk)',
                   recovered['committedRows'] >= t['lastAcknowledgedRead'] and recovered['committedRows'] >= recovered['acknowledgedRows'],
                   {'committed': recovered['committedRows'], 'lastRead': t['lastAcknowledgedRead'], 'acknowledgedOnDisk': recovered['acknowledgedRows']})
        step.check(f'{name}: the rows read before the cut hash the same', recovered['prefixSHA256'] == before['acknowledgedSHA256'],
                   {'rows': before['acknowledgedRows'], 'before': before['acknowledgedSHA256'][:16], 'after': recovered['prefixSHA256'][:16]})
        step.check(f'{name}: the writer\'s ordinary file, Git commit and random file as before', recovered['ordinarySHA256'] == before['ordinarySHA256']
                   and recovered['gitCommit'] == before['gitCommit'] and recovered['randomSHA256'] == before['randomSHA256'] and 'error' not in recovered['gitFsck'],
                   {'gitFsck': recovered['gitFsck'][:80]})
        probes = {run: probe_check(name, run) for run in ('p1', 'p2')}
        for run in ('p1', 'p2'):
            step.check(f'{name}: probe {run} the same (random bytes, SQLite rows, Git commit), integrity_check ok, git fsck clean',
                       all(probes[run]['same'].values()) and probes[run]['data']['integrityCheck'] == 'ok' and probes[run]['data']['gitFsckExit'] == 0,
                       probes[run]['same'])
        # The message sent while the node was down, answered by the next generation: what its engine resumed from.
        found = al.answered(owner_uuid(name), marker(name, 'DURING-LOSS'), timeout=300, after=t['demand']['at'])
        step.check(f'{name}: the message sent while the node was down was answered by {name}\'s runner after the takeover',
                   found['event']['ingested_by_runner_id'] == m['runner_id'] and al.seconds_between(t['finalizerOffAt'], found['event']['ingested_at']) > 0, found['event'])
        al.continuation_check(step, name, found, ctx['sessions'][name]['secret'], 'after the takeover')
        text = [r for r in found['modelRequests'] if r.get('kind') == 'text']
        context_secrets = (text[-1].get('secrets') if text else None) or []
        # The transcripts: every line written before the last turn, and (synced or not) the last turn's.
        right = t['rightBefore']
        at_stamp = t['lastTurn']['transcriptsBefore']
        asked = {path: sorted({view['lines'] for view in (at_stamp.get(path), right['transcripts'].get(path)) if view})
                 for path in set(at_stamp) | set(right['transcripts'])}
        now_transcripts = transcripts(name, asked)
        kept_before_turn = all(now_transcripts.get(path, {}).get('prefixes', {}).get(str(view['lines'])) == view['sha256'] for path, view in at_stamp.items())
        kept_last_turn = {path: now_transcripts.get(path, {}).get('prefixes', {}).get(str(view['lines'])) == view['sha256'] for path, view in right['transcripts'].items()}
        written = right['written']['files']
        left = lost_since(written, in_runner(name, 'python3', '-c', FILES_NOW, json.dumps(sorted(written))))
        step.check(f'{name}: the transcripts hold every line written before the last message', kept_before_turn,
                   {p: [v['lines'], now_transcripts.get(p, {}).get('lines')] for p, v in at_stamp.items()})
        step.check(f'{name}: the session went on: its next request carried the first session\'s conversation', ctx['sessions'][name]['secret'] in context_secrets,
                   context_secrets)
        if name == 'ann':
            step.check('ann (synced right before the cut): the last turn is in her transcripts and in the conversation her engine resumed',
                       all(kept_last_turn.values()) and f'{name}last' in context_secrets, {'transcripts': kept_last_turn, 'secrets': context_secrets})
        snap_before = ctx['snapshots']['beforeCut'][name]
        snap = al.pod_snapshot(name, al.transcript_prefix(snap_before))
        al.compare_snapshots(step, name, snap_before, snap, 'after the takeover', ctx['sessions'][name]['s1Uuid'])
        rbd_mount(step, name, snap, 'after the takeover')
        step.check(f'{name}: the volume names the new generation and its Pod', (snap['managedInstance'] or {}).get('generation') == m['generation']
                   and (snap['managedInstance'] or {}).get('podUid') == m['pod_uid'], snap['managedInstance'])
        ctx['snapshots'].setdefault('afterTakeover', {})[name] = snap
        results[name] = {'writer': recovered, 'probes': probes, 'answered': found,
                         'answeredAfterSentSeconds': al.seconds_between(t['demand']['at'], found['event']['ingested_at']),
                         'lastTurn': {'synced': name == 'ann', 'answeredAt': t['lastTurn']['answeredAt'],
                                      'secondsBeforeTheCut': al.seconds_between(t['lastTurn']['answeredAt'], taken['killedAt'].replace('Z', '+00:00')),
                                      'inTheResumedConversation': f'{name}last' in context_secrets, 'transcriptsKept': kept_last_turn,
                                      'filesWrittenSinceItsStart': left},
                         'resumedConversationSecrets': context_secrets, 'transcriptsAtTheStamp': at_stamp, 'transcriptsRightBefore': right['transcripts'],
                         'transcriptsNow': now_transcripts, 'snapshot': snap}
    return results


# ---- the old node comes back ---------------------------------------------------------------------------------------------

def rejoin_start(ctx, step):
    """The second VM boots again with the out-of-service taint still on its node: it may run and map nothing of either runner."""
    taken = ctx['takeover']
    log = Path(ctx['out']) / 'logs' / 'rejoin-start.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    started_at = now()
    with log.open('w') as output:
        result = subprocess.run([str(LAB / 'start.sh'), '--nodes', '2', '--no-wait'], stdout=output, stderr=subprocess.STDOUT)
    step.check('start.sh --nodes 2 booted the second VM', result.returncode == 0, result.returncode)
    deadline = time.monotonic() + 420
    while (tl.node_view(2) or {}).get('ready') != 'True':
        if time.monotonic() > deadline:
            raise Failed(f'{NODES[2]} not Ready within 420 s of its boot')
        time.sleep(3)
    ready_at = now()
    time.sleep(45)  # the kubelet's first passes: orphaned Pods and volumes it finds after the boot
    node = tl.node_view(2)
    step.check(f'{NODES[2]} is Ready again and still tainted out of service', node['ready'] == 'True' and any(t.startswith(OUT_OF_SERVICE) for t in node['taints']), node)
    results = {'startShAt': started_at, 'readyAt': ready_at, 'bootToReadySeconds': al.seconds_between(started_at, ready_at), 'node': node}
    for name in USERS:
        old_uid = taken[name]['podUid']
        vm2 = tl.vm2_view(old_uid)
        view = tl.placement(name)
        step.check(f'{name}: the old Pod object is gone', (kget('pod', taken[name]['podName']) or {}).get('metadata', {}).get('uid') != old_uid)
        step.check(f'{name}: no sandbox or container of the old Pod runs on {NODES[2]}', not [s for s in vm2['sandboxesOfTheOldPod'] if s['state'] == 'SANDBOX_READY']
                   and not [c for c in vm2['containersOfTheOldPod'] if c['state'] == 'CONTAINER_RUNNING'], vm2)
        guest = view['guests'].get(NODES[2]) or {}
        step.check(f'{name}: {NODES[2]} booted anew and maps and mounts no RBD image at all', guest.get('bootId') and not tl.mapped_on(view, 2)
                   and not guest.get('devices') and not guest.get('mounts'), guest)
        tl.check_placed(step, view, 1, f'{name}, with the old node back')
        results[name] = {'vm2': vm2, 'placement': view}
    results.update(startLog=log.read_text().splitlines()[-20:], memory=memory('second node back, tainted'))
    return results


def rejoin_credentials(ctx, step):
    taken = ctx['takeover']
    results = {}
    for name in USERS:
        with as_owner(name):
            saved = capture(sw.cmd_credential, action='save')  # the current generation's, beside the old one
            replay = capture(sw.cmd_credential, action='replay')
        current = mapping(name)['generation']
        old = [r for r in replay['results'] if r['credential'] == f"generation {taken[name]['generation']}"]
        naming_old = [r for r in replay['results'] if r['credential'] == f'generation {current}' and r['offer'].startswith(f"generation {taken[name]['generation']}")]
        own = [r for r in replay['results'] if r['credential'] == f'generation {current}' and r['offer'] == 'its own generation and Pod']
        step.check(f"{name}: the old generation's credential ({taken[name]['generation']}) is refused 401 at /runner/me, heartbeat and claim",
                   len(old) >= 3 and all(r['status'] == 401 for r in old), sorted({(r['offer'], r['route'], r['status']) for r in old}))
        step.check(f'{name}: the current credential naming the old generation and its Pod is refused 403 MANAGED_RUNNER_INSTANCE_SUPERSEDED',
                   naming_old and all(r['status'] == 403 and r['code'] == 'MANAGED_RUNNER_INSTANCE_SUPERSEDED' for r in naming_old),
                   sorted({(r['route'], r['status'], r['code']) for r in naming_old}))
        step.check(f'{name}: the current credential as its own instance is accepted (a read only)', own and all(r['status'] == 200 for r in own), [r['status'] for r in own])
        results[name] = {'saved': {k: saved.get(k) for k in ('generation', 'podUid', 'tokenSha256Prefix')}, 'replay': replay}
    return results


def rejoin_writers(ctx, step):
    """Each writer goes on from the first node while the old node is back: one writer, one client per volume."""
    results = {}
    for name in USERS:
        with as_owner(name):
            resumed_writer = capture(sw.cmd_payload, action='start', run_id=tl.WRITER_RUN, minimum_rows=0)
        results[name] = {'resumed': resumed_writer, 'rows': [writer_rows(name)]}
    time.sleep(30)
    for name in USERS:
        results[name]['rows'].append(writer_rows(name))
        results[name]['placement'] = tl.placement(name)
        step.check(f'{name}: the writer resumed on the existing data and keeps committing rows', results[name]['resumed'].get('resumedExistingData')
                   and results[name]['rows'][1] > results[name]['rows'][0], results[name]['rows'])
        tl.check_placed(step, results[name]['placement'], 1, f'{name}, while the writer goes on')
    results['blocklist'] = sw.ceph('ceph osd blocklist ls 2>&1')[0]
    return results


def rejoin_release(ctx, step):
    """The rejoin rule: both stale Pods and attachments are gone and the node maps nothing, so the taint comes off."""
    plugin_before = tl.node_plugin_ready(2)
    untaint = runbook_bash(f'the out-of-service taint off {NODES[2]}', '$K taint node "$NODE" node.kubernetes.io/out-of-service-', NODE=NODES[2])
    step.check('the taint is removed', untaint['exit'] == 0, untaint['stderr'] or untaint['stdout'])
    released_at = now()
    deadline = time.monotonic() + 300
    while not tl.node_plugin_ready(2):
        if time.monotonic() > deadline:
            raise Failed(f'no ready Ceph-CSI node plugin on {NODES[2]} within 300 s of the taint\'s removal')
        time.sleep(3)
    plugin_at = now()
    status = subprocess.run(['bash', str(LAB / 'status.sh')], capture_output=True, text=True)
    node = tl.node_view(2)
    step.check(f'{NODES[2]} is Ready, schedulable and untainted', node['ready'] == 'True' and not node['unschedulable'] and not node['taints'], node)
    time.sleep(20)
    results = {'untaint': untaint, 'releasedAt': released_at, 'nodePluginReadyBefore': plugin_before, 'nodePluginReadyAt': plugin_at,
               'status': {'exit': status.returncode, 'lines': status.stdout.strip().splitlines()[-14:]}, 'node': node}
    for name in USERS:
        view = tl.placement(name)
        step.check(f'{name}: the runner did not move: the same Pod on {NODES[1]}', mapping(name)['pod_uid'] == ctx['identity'][name]['podUid'], mapping(name)['pod_uid'])
        tl.check_placed(step, view, 1, f'{name}, with the old node rejoined')
        with as_owner(name):
            quiesced = capture(sw.cmd_payload, action='quiesce', run_id=tl.WRITER_RUN, minimum_rows=0)
        step.check(f'{name}: the writer quiesced, integrity_check ok', quiesced['snapshot']['sqliteIntegrity'] == ['ok'], quiesced['snapshot']['sqliteIntegrity'])
        ctx.setdefault('writersQuiesced', {})[name] = {k: quiesced['snapshot'][k] for k in ('committedRows', 'rowSHA256', 'acknowledgedRows')}
        results[name] = {'placement': view, 'writerQuiesced': quiesced['snapshot']}
    results['memory'] = memory('second node rejoined')
    return results


# ---- the runbook's planned move ------------------------------------------------------------------------------------------

def drain_runners(ctx, step, source, target, refusals):
    """kubectl drain of node SOURCE for the managed runners' Pods only (the lab's CSI controller is pinned to the first node,
    and the namespace holds earlier tasks' Pods): the next generations on node TARGET. With REFUSALS, first with no flags,
    as the runbook named it, then with one flag, then with the two its bare Pods need; a refused drain cordons the node and
    evicts nothing."""
    before = {name: identity(name) for name in USERS}
    snaps = {name: al.pod_snapshot(name) for name in USERS}
    results = {}
    if refusals:
        # kubectl's drain stops at the first filter that refuses a Pod: local storage (the runner's /tmp) comes before "no controller".
        plain = k('drain', NODES[source], f'--pod-selector={RUNNER_PODS}', '--timeout=60s', namespace=None, check=False)
        said = plain.stdout + plain.stderr
        step.check('kubectl drain without flags refuses the runners\' Pods: they have local storage (an emptyDir)',
                   plain.returncode != 0 and 'Pods with local storage (use --delete-emptydir-data to override)' in said, said.strip()[-600:])
        step.check(f'and it cordoned {NODES[source]}', tl.node_view(source)['unschedulable'])
        emptydir = k('drain', NODES[source], f'--pod-selector={RUNNER_PODS}', '--delete-emptydir-data', '--timeout=60s', namespace=None, check=False)
        said_emptydir = emptydir.stdout + emptydir.stderr
        step.check('with --delete-emptydir-data alone it still refuses them: bare Pods declare no controller',
                   emptydir.returncode != 0 and 'Pods that declare no controller (use --force to override)' in said_emptydir, said_emptydir.strip()[-600:])
        step.check('nothing was evicted by the refused drains', all(mapping(n)['pod_uid'] == before[n]['podUid'] and mapping(n)['management_state'] == 'READY'
                                                                    for n in USERS))
        results.update(plain={'exit': plain.returncode, 'output': said.strip().splitlines()},
                       emptyDirOnly={'exit': emptydir.returncode, 'output': said_emptydir.strip().splitlines()})
    else:
        results['uncordonTarget'] = tl.cordon(target, 'uncordon')
    at = now()
    drained = k('drain', NODES[source], f'--pod-selector={RUNNER_PODS}', '--ignore-daemonsets', '--delete-emptydir-data', '--force', '--timeout=300s',
                namespace=None, check=False)
    drained_at = now()
    output = drained.stdout + drained.stderr
    evicted = {name: f"pod/mr-{before[name]['runnerId']} evicted" in output for name in USERS}
    waited = sorted(set(re.findall(r'waiting for pod "([^"]+)"', output)))
    step.check('kubectl drain with --force and --delete-emptydir-data evicted both runners\' Pods', all(evicted.values()), evicted)
    # A drain waits until every Pod it evicted is gone: a managed Pod goes once a manager has recorded its stop.
    step.check('the drain finished, or waited at its timeout only for Pods of no runner here', drained.returncode == 0
               or (waited and not [w for w in waited if any(before[n]['runnerId'] in w for n in USERS)]), {'exit': drained.returncode, 'waitedFor': waited})
    ready = {name: until(name, 'READY', gen_above=before[name]['generation'], timeout=420) for name in USERS}
    results.update(drainStartedAt=at, drainEndedAt=drained_at, drain={'exit': drained.returncode, 'output': output.strip().splitlines(), 'waitedFor': waited},
                   ready=ready)
    label = f'after the drain of {NODES[source]}'
    for name in USERS:
        m = mapping(name)
        after = identity(name)
        proof = m['fencing_receipt'] or {}
        view = moved(step, name, before[name], after, target, label)
        step.check(f'{name}: the evicted generation retired on its kubelet\'s report (OBSERVED_STOP)', proof.get('kind') == 'OBSERVED_STOP'
                   and (proof.get('predecessor') or {}).get('generation') == before[name]['generation'], {k: proof.get(k) for k in ('kind', 'recordedAt', 'retiredAt')})
        talk = resumed(step, ctx, name, f'DRAINED{target}', f'on {NODES[target]} {label}')
        probe, snap = data_kept(step, ctx, name, snaps[name], label)
        p2 = probe_check(name, 'p2')
        step.check(f'{name}: probe p2 the same {label}', all(p2['same'].values()) and p2['data']['integrityCheck'] == 'ok', p2['same'])
        writer = tl.payload_snapshot(m['pod_name'])
        quiet = ctx['writersQuiesced'][name]
        step.check(f'{name}: the quiesced writer\'s rows as they were, integrity_check ok', writer['committedRows'] == quiet['committedRows']
                   and writer['rowSHA256'] == quiet['rowSHA256'] and writer['sqliteIntegrity'] == ['ok'], [writer['committedRows'], quiet['committedRows']])
        ctx['identity'][name] = after
        times = al.provisioned(name)
        results[name] = {'identityBefore': before[name], 'identityAfter': after, 'proof': proof, 'placement': view, 'talk': talk, 'probe': probe,
                         'probeP2': p2, 'writer': writer, 'snapshotBefore': snaps[name], 'snapshot': snap, 'times': times,
                         'drainToPodCreatedSeconds': al.seconds_between(at, times['podCreatedAt']),
                         'drainToReadySeconds': al.seconds_between(at, times['readyAt'])}
    results['uncordon'] = tl.cordon(source, 'uncordon')
    results['gate'] = al.gate_summary(at, drained_at)
    return results


def drain_stuck(ctx, step):
    """What held the first node's drain: a managed runner Pod of an earlier task's server, Terminating behind the stop-report
    finalizer that only its own manager, not running, takes off. kubectl drain's --skip-wait-for-delete-timeout passes it."""
    ours = {mapping(name)['runner_id'] for name in USERS}
    stuck = [p for p in kjson('get', 'pods', '-l', RUNNER_PODS)['items'] if p['spec'].get('nodeName') == NODES[1] and p['metadata'].get('deletionTimestamp')]
    view = [{'name': p['metadata']['name'], 'uid': p['metadata']['uid'], 'phase': p['status'].get('phase'), 'created': p['metadata']['creationTimestamp'],
             'deletionTimestamp': p['metadata']['deletionTimestamp'], 'finalizers': p['metadata'].get('finalizers'),
             'generation': (p['metadata'].get('annotations') or {}).get('orbit.dev/generation')} for p in stuck]
    step.check(f'Terminating managed Pods on {NODES[1]}: none of them a runner of these accounts', view and not [p for p in view if p['name'][3:] in ours], view)
    at = now()
    result = k('drain', NODES[1], f'--pod-selector={RUNNER_PODS}', '--ignore-daemonsets', '--delete-emptydir-data', '--force',
               '--skip-wait-for-delete-timeout=60', '--timeout=120s', namespace=None, check=False)
    output = result.stdout + result.stderr
    step.check('with --skip-wait-for-delete-timeout=60 the drain finishes', result.returncode == 0, output.strip()[-600:])
    left = [kget('pod', p['name']) for p in view]
    step.check('the Terminating Pods are still there as they were: the drain passed them', all(p and p['metadata']['uid'] == v['uid'] for p, v in zip(left, view)))
    uncordon = tl.cordon(1, 'uncordon')
    return {'stuck': view, 'drainAt': at, 'drain': {'exit': result.returncode, 'output': output.strip().splitlines()}, 'uncordon': uncordon}


# ---- final -----------------------------------------------------------------------------------------------------------------

def final_checks(ctx, step):
    view = ml.verdict()
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    timeline = [json.loads(line) for line in (SERVER / 'timeline.jsonl').read_text().splitlines() if line.startswith('{')]
    most = {}
    for name in USERS:
        claim, pv = ctx['identity'][name]['pvcName'], ctx['identity'][name]['pvName']
        most[name] = {'pods': max((len((line.get('podsByClaim') or {}).get(claim, [])) for line in timeline), default=0),
                      'attachments': max((len((line.get('attachmentsByPv') or {}).get(pv, [])) for line in timeline), default=0)}
        step.check(f'{name}: never more than one Pod on the claim in the whole timeline', most[name]['pods'] <= 1, most[name]['pods'])
        step.check(f'{name}: never more than one VolumeAttachment of its PV in the whole timeline', most[name]['attachments'] <= 1, most[name]['attachments'])
    deadline, health = time.monotonic() + 720, None
    while time.monotonic() < deadline:
        health = tl.ceph_json('ceph -s -f json')
        if health.get('health', {}).get('status') == 'HEALTH_OK':
            break
        time.sleep(20)
    detail = sw.ceph('ceph health detail')[0]
    step.check('Ceph is HEALTH_OK at the end', health.get('health', {}).get('status') == 'HEALTH_OK', detail[-400:])
    asleep, ends = {}, {}
    for name in USERS:
        asleep[name] = al.ensure_asleep(name)
        ends[name] = tl.placement(name)
        tl.check_released(step, ends[name], f'{name} asleep at the end')
        step.check(f'{name}: the claim is the one made at the first provisioning', identity(name)['pvcUid'] == ctx['identity'][name]['pvcUid'])
    return {'verdict': view, 'most': most, 'timelineLines': len(timeline),
            'ceph': {'health': health.get('health'), 'osdmap': health.get('osdmap'), 'pgmap': {k: (health.get('pgmap') or {}).get(k) for k in ('pgs_by_state', 'num_pgs')},
                     'detail': detail}, 'asleep': asleep, 'placement': ends, 'gate': al.gate_summary(ctx['firstSignInAt']),
            'pool': wl.sql_json('select * from managed_runner_capacity'), 'nodes': {NODES[n]: tl.node_view(n) for n in (1, 2)}}


def teardown(ctx, step):
    results = {'recorder': record('stop'), 'admission': capture(sw.cmd_admission, action='remove')}
    results['server'] = al.server('stop')
    results['gate'] = capture(ml.cmd_gate, action='stop', since=None)
    step.check('the webhook is removed', sw.webhook_view() is None)
    return results


# ---- the recorder ------------------------------------------------------------------------------------------------------------

def cmd_record_loop(args):
    deadline, last = time.monotonic() + args.seconds, None
    while time.monotonic() < deadline:
        try:
            line = tl.record_line()
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
            al.run(['systemd-run', f'--unit={RECORDER_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=256M',
                    '-p', f'Environment=LAB_TEST_SERVER_DIR={SERVER}', '-p', f'StandardOutput=append:{log}', '-p', f'StandardError=append:{log}',
                    sys.executable, '-I', str(Path(__file__)), 'record-loop', '21600'])
    else:
        ml.systemd('stop', RECORDER_UNIT, check=False)
    return {'at': now(), 'unit': ml.active(RECORDER_UNIT), 'log': str(log), 'lines': len(log.read_text().splitlines()) if log.exists() else 0}


# ---- the run ---------------------------------------------------------------------------------------------------------------------

def phases():
    return [
        ('facts', [('git', tl.facts_git), ('host', tl.facts_host), ('cluster', tl.facts_cluster), ('ceph', tl.facts_ceph), ('image', tl.facts_image),
                   ('model', facts_model)]),
        ('setup', [('server-dir', al.setup_server_dir), ('admin', tl.setup_admin)]),
        ('on', [('prepare', on_prepare), ('start', on_start), ('admission', tl.on_admission)]),
        ('accounts', [('ready', accounts_ready), ('data', accounts_data)]),
        ('move', [('sleep', move_sleep), ('wake', move_wake)]),
        ('duplicate', [('writers', duplicate_writers), ('guard', duplicate_guard)]),
        ('takeover', [('prepare', takeover_prepare), ('last', takeover_last), ('cut', takeover_cut), ('heartbeat-loss', takeover_heartbeat_loss),
                      ('fence', takeover_fence), ('data', takeover_data)]),
        ('rejoin', [('start', rejoin_start), ('credentials', rejoin_credentials), ('writers', rejoin_writers), ('release', rejoin_release)]),
        ('drain', [('move', lambda c, s: drain_runners(c, s, 1, 2, refusals=True)), ('stuck', drain_stuck),
                   ('back', lambda c, s: drain_runners(c, s, 2, 1, refusals=False))]),
        ('final', [('checks', final_checks), ('teardown', teardown)]),
    ]


def cmd_run(args):
    require_own_server_dir()
    out = Path(args.out)
    (out / 'records').mkdir(parents=True, exist_ok=True)
    plan = phases()
    names = [name for name, _ in plan]
    first = names.index(args.from_phase) if args.from_phase else 0
    resume = None
    if args.from_step:  # PHASE/STEP: a run that stopped there goes on from that step, its context kept
        phase, _, resume = args.from_step.partition('/')
        first = names.index(phase)
        if resume not in [label for label, _ in plan[first][1]]:
            raise SystemExit(f'no step {args.from_step}')
    last = names.index(args.to_phase) if args.to_phase else len(names) - 1
    ctx = al.load_context()
    ctx.update(out=str(out), observeSeconds=args.observe)
    number = len(list((out / 'records').glob('[0-9]*.json')))
    run_started = time.monotonic()
    for phase, steps in plan[first:last + 1]:
        for label, function in steps:
            if resume:
                if label != resume:
                    continue
                resume = None
            number += 1
            step = Step()
            started_at, started = now(), time.monotonic()
            error = None
            try:
                if sw.API != al.PRIMARY_API:
                    raise Failed(f'the client points at {sw.API}, not the primary apiserver {al.PRIMARY_API}')
                result = function(ctx, step)
            except (Exception, SystemExit) as failure:  # recorded, then the run stops
                result, error = None, f'{type(failure).__name__}: {failure}'
                traceback.print_exc()
            seconds = round(time.monotonic() - started, 1)
            ok = error is None and all(c['ok'] for c in step.checks)
            (out / 'records' / f'{number:03d}-{phase}-{label}.json').write_text(json.dumps(
                {'phase': phase, 'step': label, 'startedAt': started_at, 'endedAt': now(), 'seconds': seconds, 'ok': ok, 'error': error,
                 'checks': step.checks, 'result': result}, indent=1, sort_keys=True, default=str))
            line = {'n': number, 'phase': phase, 'step': label, 'startedAt': started_at, 'seconds': seconds, 'ok': ok, 'error': error,
                    'checks': len(step.checks), 'failed': [c['check'] for c in step.checks if not c['ok']]}
            with open(out / 'steps.jsonl', 'a') as steps_log:
                steps_log.write(json.dumps(line) + '\n')
            print(json.dumps(line), flush=True)
            al.save_context(ctx)
            if not ok:
                raise SystemExit(f'{phase}/{label} failed: {error or line["failed"]}')
    print(json.dumps({'done': True, 'phases': names[first:last + 1], 'seconds': round(time.monotonic() - run_started, 1)}), flush=True)


def cmd_report(args):
    """The run's steps (time, checks) and the intervals the README quotes, from its records only."""
    out = Path(args.out)
    steps = [json.loads(line) for line in (out / 'steps.jsonl').read_text().splitlines()]
    records = {}
    for path in sorted((out / 'records').glob('[0-9]*.json')):
        record_ = json.loads(path.read_text())
        records[f"{record_['phase']}/{record_['step']}"] = record_
    get = lambda key: (records.get(key) or {}).get('result') or {}
    measures = {}
    for name, function in {
        'provision': lambda: {n: get('accounts/ready')['ready'][n]['seconds'] for n in USERS},
        'moveSleepToAsleep': lambda: get('move/sleep')['sleepToAsleepSeconds'],
        'moveWake': lambda: get('move/wake')['seconds'],
        'quietBeforeTheCut': lambda: get('takeover/cut')['seconds'] | {'annSync': get('takeover/cut')['annSync']},
        'nodeUnknownAfterCut': lambda: get('takeover/heartbeat-loss')['firstUnknownSeconds'],
        'heartbeatLoss': lambda: get('takeover/heartbeat-loss')['owners'],
        'failover': lambda: {n: get('takeover/fence')[n]['seconds'] for n in USERS},
        'failoverStates': lambda: {n: get('takeover/fence')[n]['statesInOrder'] for n in USERS},
        'lossMessageAnsweredAfter': lambda: {n: get('takeover/data')[n]['answeredAfterSentSeconds'] for n in USERS},
        'lastTurn': lambda: {n: {k: v for k, v in get('takeover/data')[n]['lastTurn'].items() if k != 'filesWrittenSinceItsStart'} for n in USERS},
        'lastTurnFiles': lambda: {n: get('takeover/data')[n]['lastTurn']['filesWrittenSinceItsStart'] for n in USERS},
        'oldNodeBootToReady': lambda: get('rejoin/start')['bootToReadySeconds'],
        'drain': lambda: {step: {'seconds': al.seconds_between(get(f'drain/{step}')['drainStartedAt'], get(f'drain/{step}')['drainEndedAt']),
                                 'exit': get(f'drain/{step}')['drain']['exit'],
                                 **{n: {'podCreated': al.seconds_between(get(f'drain/{step}')['drainStartedAt'], get(f'drain/{step}')[n]['times']['podCreatedAt']),
                                        'ready': al.seconds_between(get(f'drain/{step}')['drainStartedAt'], get(f'drain/{step}')[n]['times']['readyAt'])}
                                    for n in USERS}} for step in ('move', 'back')},
        'final': lambda: {k: get('final/checks')[k] for k in ('most', 'timelineLines')},
    }.items():
        try:
            measures[name] = function()
        except (KeyError, TypeError, IndexError, ValueError) as error:
            measures[name] = f'unavailable: {type(error).__name__} {error}'
    print(json.dumps({'steps': len(steps), 'checks': sum(line['checks'] for line in steps), 'failedSteps': [f"{l['phase']}/{l['step']}" for l in steps if not l['ok']],
                      'from': steps[0]['startedAt'], 'to': max(r['endedAt'] for r in records.values()) if records else None,
                      'phaseSeconds': {phase: round(sum(l['seconds'] for l in steps if l['phase'] == phase), 1) for phase in dict.fromkeys(l['phase'] for l in steps)},
                      'measures': measures}, indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('run')
    start.add_argument('--out', required=True)
    start.add_argument('--from', dest='from_phase')
    start.add_argument('--from-step', dest='from_step', help='PHASE/STEP: go on from that step of a run that stopped there')
    start.add_argument('--to', dest='to_phase')
    start.add_argument('--observe', type=int, default=420, help='seconds after the cut with no fencing (default 420)')
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    sub.add_parser('secret-scan').add_argument('paths', nargs='+')
    sub.add_parser('report').add_argument('out')
    args = parser.parse_args()
    {'run': cmd_run, 'record-loop': cmd_record_loop, 'secret-scan': tl.cmd_secret_scan, 'report': cmd_report}[args.command](args)


if __name__ == '__main__':
    main()
