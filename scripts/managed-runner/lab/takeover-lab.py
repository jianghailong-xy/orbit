#!/usr/bin/env python3
"""One account's runner across the lab's two nodes, in one run (task T02, the cross-node part of criterion 2).

docs/managed-runner-lab.md, "Cross-node migration and takeover (T02)", and the runbook's failover,
docs/managed-runner-kubernetes-operations.md, "Failover". One command runs every phase in order and stops at the
first check that fails; each step's result and wall-clock time are written to OUT. It is acceptance-lab.py (T08)
for one account on two nodes, whose helpers it uses, through the test server's own manager, admission guard and
fencing gate:

  facts      versions, both nodes, the link, Ceph, Ceph-CSI and the image (imported into both VMs' containerd)
  setup      the gate, the lab CA and webhook token, the administrator signed up with the switch unset
  on         the profile, the apiserver with the switch on, the admission guard
  account    ann signs in with the second node cordoned: her runner on the first node, READY on a fake-model key;
             a first session with an attachment and a file the engine commits; probe data on the volume
  migrate    the owner's sleep (drained, unmounted, detached), the first node cordoned and the second not, a message:
             the next generation on the second node with the same runner, claim and RBD image, the data as written
  duplicate  while the runner runs on the second node: Pods on the same claim pinned to the first node, refused by
             the admission guard as other identities and shapes; what RWO alone does across nodes (a plain claim);
             the RBD image's own features, locks and watchers, and a second Ceph client reading it
  takeover   the second node powered off hard (stop.sh --node 2 --hard) with the runner writing on it: for a while
             nothing takes over (no Pod made, the generation kept); then the runbook's failover: a fencing receipt,
             the out-of-service taint, the stale Pod's finalizer off; the next generation on the first node, the data
             checked (every acknowledged row, integrity_check after WAL recovery)
  rejoin     the second node boots again under the out-of-service taint: the old Pod is gone, nothing of the image is
             mapped or mounted there, its RBD client is not back, the old generation's credential is refused; the
             writer goes on from the first node; then the taint is removed and the node rejoins
  final      consistency, one Pod per volume over the whole timeline, Ceph; ann asleep, the window closed

  takeover-lab.py run --out DIR [--from PHASE | --from-step PHASE/STEP] [--to PHASE] [--observe SECONDS]
  takeover-lab.py record-loop SECONDS        the recorder unit's loop (started by the run)
  takeover-lab.py secret-scan PATH...        no credential of the run in these files
  takeover-lab.py report OUT                 the steps' times and checks, and the intervals the README quotes

LAB_TEST_SERVER_DIR must name test-server-t02 (or test-server-t02-dev for trials): earlier tasks' databases stay
untouched. Two-node mode must be up (start.sh --nodes 2). Every record is JSON and never holds a credential: owners'
tokens and passwords, runner credentials, the fake model key and the manager's token stay in files of mode 0600 under
the server directory, in the lab's Secrets and in the test server's provider store. Sessions run on fake-model.py as a
DeepSeek-preset key, which is not a model. Both VMs are one physical machine and one failure domain: nothing here is
evidence of availability across machines.
"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tarfile
import time
import traceback
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_acceptance', LAB / 'acceptance-lab.py')
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
wl, ml, sw = al.wl, al.ml, al.sw
spec = importlib.util.spec_from_file_location('lab_render', LAB / 'render.py')
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

SERVER, NAMESPACE, ENV, LAB_DIR, STATE = sw.SERVER, sw.NAMESPACE, sw.ENV, sw.LAB_DIR, sw.STATE
OWN_SERVER_DIRS = ('test-server-t02', 'test-server-t02-dev')
# acceptance-lab.py's helpers with this task's directory, accounts and probe.
al.OWN_SERVER_DIRS = al.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.OWN_SERVER_DIRS = wl.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.EMAIL = ml.EMAIL = 't02-{}@lab.invalid'
wl.NAME_RE = re.compile(r't02-([a-z0-9]+)@lab\.invalid')
wl.PROBE_ROOT = '/var/lib/orbit/home/t02-probe'
al.CONTEXT = SERVER / 't02-context.json'
OWNER = 'ann'
# single-writer.py's payload, storage view and credentials act on this owner's mapping.
sw.OWNER = OWNER
sw.CREDENTIALS = STATE / 'credentials' / OWNER
RECORDER_UNIT = 'orbit-mr-lab-t02-recorder'
NODES = {1: ENV['LAB_NAME'], 2: ENV['LAB2_NAME']}
SSH_PORTS = {1: ENV['LAB_SSH_PORT'], 2: ENV['LAB2_SSH_PORT']}
UNITS = {1: ENV['LAB_UNIT'], 2: ENV['LAB2_UNIT']}
LINK_IPS = {1: ENV['LAB_LINK_IP'], 2: ENV['LAB2_LINK_IP']}
QMP = {1: LAB_DIR / 'run/qmp.sock', 2: LAB_DIR / 'run/node2-qmp.sock'}
IMAGE_ARCHIVE = Path(os.environ.get('LAB_T02_IMAGE_ARCHIVE', '/mnt/data/tmp/t02-cross-node/image/lab.oci.tar'))
OUT_OF_SERVICE = 'node.kubernetes.io/out-of-service'
STOP_REPORT = 'orbit.dev/managed-runner-stop-report'
WRITER_RUN = 't02-writer'
OPERATOR = 'T02 lab operator (task 34ZtjTqbRV2J7OFLVheO3)'
Failed, Step, capture, k, kget, kjson, mapping, until, identity, now = (al.Failed, al.Step, al.capture, al.k, al.kget, al.kjson, al.mapping,
                                                                       al.until, al.identity, al.now)


def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t02 (or test-server-t02-dev), not {SERVER}')


# ---- the two VMs ---------------------------------------------------------------------------------------------

def ssh_node(node, script, input=None, check=True, timeout=120):
    """A command in VM NODE (1 or 2) over its forwarded SSH port; anything secret goes through input, never argv."""
    command = ['ssh', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-p', SSH_PORTS[node], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=5', '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR', 'ubuntu@127.0.0.1', script]
    result = subprocess.run(command, input=input, capture_output=True, text=True, timeout=timeout,
                            stdin=None if input is not None else subprocess.DEVNULL)
    if check and result.returncode:
        raise Failed(f'VM {node}: guest command exited {result.returncode}: {result.stderr.strip()[-600:]}')
    return result


def unit_active(node):
    return ml.active(f'{UNITS[node]}.service') == 'active'


def cordon(node, action):
    """kubectl cordon|uncordon of a node: the manager names no node, so this is how a generation is placed."""
    k(action, NODES[node], namespace=None)
    return {'node': NODES[node], 'action': action, 'at': now(), 'unschedulable': bool(kget('node', NODES[node], namespace=None)['spec'].get('unschedulable'))}


def node_view(node):
    found = kget('node', NODES[node], namespace=None)
    if not found:
        return None
    ready = next((c for c in found['status'].get('conditions', []) if c['type'] == 'Ready'), {})
    return {'name': NODES[node], 'uid': found['metadata']['uid'], 'ready': ready.get('status'), 'reason': ready.get('reason'),
            'readySince': ready.get('lastTransitionTime'), 'unschedulable': bool(found['spec'].get('unschedulable')),
            'taints': [f"{t['key']}{'=' + t['value'] if t.get('value') else ''}:{t['effect']}" for t in found['spec'].get('taints', [])]}


GUEST_RBD = r'''set -u
echo "boot $(cat /proc/sys/kernel/random/boot_id) up $(cut -d' ' -f1 /proc/uptime)"
for d in /sys/bus/rbd/devices/*; do [ -e "$d" ] || continue
  echo "rbd rbd$(basename "$d") $(cat "$d/pool")/$(cat "$d/name") client$(cat "$d/client_id" 2>/dev/null) $(cat "$d/client_addr" 2>/dev/null)"; done
findmnt -rn -o SOURCE,TARGET,FSTYPE | awk '$1 ~ /^\/dev\/rbd/ {print "mount " $0}'
true
'''


def guest_rbd(node):
    """What VM NODE's kernel maps (/sys/bus/rbd) and mounts from RBD, with its boot ID; None when the VM does not answer."""
    if not unit_active(node):
        return None
    try:
        result = ssh_node(node, GUEST_RBD, check=False, timeout=30)
    except subprocess.TimeoutExpired:
        return {'error': 'timeout'}
    if result.returncode:
        return {'error': result.stderr.strip()[-200:] or f'exit {result.returncode}'}
    lines = result.stdout.splitlines()
    boot = next((line.split() for line in lines if line.startswith('boot ')), [])
    devices = [dict(zip(('device', 'image', 'client', 'address'), line.split()[1:5])) for line in lines if line.startswith('rbd ')]
    mounts = [dict(zip(('source', 'target', 'fstype'), line.split()[1:4])) for line in lines if line.startswith('mount ')]
    return {'bootId': boot[1] if len(boot) > 1 else None, 'uptimeSeconds': float(boot[3]) if len(boot) > 3 else None,
            'devices': devices, 'mounts': mounts}


def rbd_image(ident):
    return f"{ident['pool']}/{ident['rbdImage']}"


def ceph_json(command):
    text = sw.ceph(command)[0]
    try:
        return json.loads(text)
    except ValueError:
        return {'unparsed': text[-400:]}


def watchers(image):
    status = ceph_json(f'rbd status --format json {shlex.quote(image)}')
    return status.get('watchers') if isinstance(status, dict) and 'watchers' in status else status


def attachments(pv_name):
    items = kjson('get', 'volumeattachments', namespace=None)['items']
    return [{'name': va['metadata']['name'], 'node': va['spec']['nodeName'], 'attached': (va.get('status') or {}).get('attached'),
             'deleting': bool(va['metadata'].get('deletionTimestamp')),
             'detachError': ((va.get('status') or {}).get('detachError') or {}).get('message')}
            for va in items if va['spec']['source'].get('persistentVolumeName') == pv_name]


def pods_on_claim(claim):
    pods = kjson('get', 'pods')['items']
    return [{'name': p['metadata']['name'], 'uid': p['metadata']['uid'], 'node': p['spec'].get('nodeName'), 'phase': p['status'].get('phase'),
             'deleting': bool(p['metadata'].get('deletionTimestamp'))}
            for p in pods if any((v.get('persistentVolumeClaim') or {}).get('claimName') == claim for v in p['spec'].get('volumes', []))]


def pod_view(name):
    pod = kget('pod', name)
    if not pod:
        return None
    conditions = {c['type']: {k: c.get(k) for k in ('status', 'reason', 'lastTransitionTime')} for c in pod['status'].get('conditions', [])}
    statuses = (pod['status'].get('initContainerStatuses') or []) + (pod['status'].get('containerStatuses') or [])
    return {'name': name, 'uid': pod['metadata']['uid'], 'node': pod['spec'].get('nodeName'), 'phase': pod['status'].get('phase'),
            'generation': (pod['metadata'].get('annotations') or {}).get('orbit.dev/generation'),
            'deletionTimestamp': pod['metadata'].get('deletionTimestamp'), 'finalizers': pod['metadata'].get('finalizers'),
            'ready': (conditions.get('Ready') or {}).get('status'), 'disruptionTarget': conditions.get('DisruptionTarget'),
            'containers': [{'name': s['name'], 'state': next(iter((s.get('state') or {'?': {}}).keys())),
                            'exitCode': ((s.get('state') or {}).get('terminated') or {}).get('exitCode'),
                            'reason': ((s.get('state') or {}).get('terminated') or (s.get('state') or {}).get('waiting') or {}).get('reason')}
                           for s in statuses]}


def placement(name):
    """Where NAME's volume is now: the runner's Pod and node, every Pod on the claim, the VolumeAttachments, what each
    running VM's kernel maps and mounts, and the image's RBD watchers."""
    ident = identity(name)
    m = mapping(name)
    pod = pod_view(f"mr-{m['runner_id']}")
    return {'at': now(), 'generation': m['generation'], 'state': m['management_state'], 'podUid': m['pod_uid'], 'nodeName': m['node_name'],
            'pod': pod, 'podsOnTheClaim': pods_on_claim(ident['pvcName']), 'volumeAttachments': attachments(ident['pvName']),
            'guests': {NODES[n]: guest_rbd(n) for n in (1, 2)}, 'watchers': watchers(rbd_image(ident)),
            'image': rbd_image(ident)}


def mapped_on(view, node):
    guest = view['guests'].get(NODES[node]) or {}
    return [d for d in guest.get('devices') or [] if d.get('image') == view['image']]


def watcher_addresses(view):
    return [w.get('address', '') for w in view['watchers']] if isinstance(view['watchers'], list) else view['watchers']


def check_placed(step, view, node, label):
    """The volume used from NODE only: the runner's Pod there, one attachment to it, mapped by its VM alone, its client the only watcher."""
    other = 2 if node == 1 else 1
    step.check(f'{label}: the runner\'s Pod runs on {NODES[node]}', (view['pod'] or {}).get('node') == NODES[node] and (view['pod'] or {}).get('phase') == 'Running',
               view['pod'] and {k: view['pod'][k] for k in ('node', 'phase', 'uid')})
    step.check(f'{label}: one Pod on the claim', len(view['podsOnTheClaim']) == 1, view['podsOnTheClaim'])
    step.check(f'{label}: one VolumeAttachment, to {NODES[node]}', [(a['node'], a['attached']) for a in view['volumeAttachments']] == [(NODES[node], True)],
               view['volumeAttachments'])
    step.check(f'{label}: the image is mapped by {NODES[node]}\'s kernel', len(mapped_on(view, node)) == 1, mapped_on(view, node))
    if view['guests'].get(NODES[other]) is not None:
        step.check(f'{label}: and not by {NODES[other]}\'s', not mapped_on(view, other), mapped_on(view, other))
    addresses = watcher_addresses(view)
    step.check(f'{label}: one RBD watcher, {NODES[node]}\'s kernel client ({LINK_IPS[node]})',
               isinstance(addresses, list) and len(addresses) == 1 and addresses[0].startswith(LINK_IPS[node] + ':'), addresses)


def check_released(step, view, label):
    step.check(f'{label}: no Pod on the claim', not view['podsOnTheClaim'], view['podsOnTheClaim'])
    step.check(f'{label}: no VolumeAttachment', not view['volumeAttachments'], view['volumeAttachments'])
    step.check(f'{label}: mapped by no running VM', not any(mapped_on(view, n) for n in (1, 2)), {n: mapped_on(view, n) for n in (1, 2)})
    step.check(f'{label}: no RBD watcher', view['watchers'] == [], view['watchers'])


def power_state(node):
    """An observation of VM NODE's power independent of Kubernetes: its systemd unit, its qemu process, its SSH port,
    its QMP socket and its end of the link."""
    unit = dict(line.split('=', 1) for line in ml.systemd('show', f'{UNITS[node]}.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
                                                          check=False).stdout.splitlines() if '=' in line)
    qemu = subprocess.run(['pgrep', '-f', f'qemu-system-x86_64 -name {NODES[node]},'], capture_output=True, text=True).stdout.split()

    def refused(address):
        try:
            with socket.create_connection(address, timeout=3):
                return False
        except OSError:
            return True

    def qmp_refused():
        path = QMP[node]
        if not path.exists():
            return True
        try:
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(3)
                s.connect(str(path))
            return False
        except OSError:
            return True
    link = subprocess.run(['ss', '-Htn', 'state', 'established', f"( sport = :{ENV['LAB_LINK_PORT']} )"], capture_output=True, text=True).stdout.split('\n')
    return {'at': now(), 'unit': f'{UNITS[node]}.service', 'activeState': unit.get('ActiveState'), 'subState': unit.get('SubState'),
            'mainPid': unit.get('MainPID'), 'qemuProcesses': qemu, 'sshRefused': refused(('127.0.0.1', int(SSH_PORTS[node]))),
            'qmpRefused': qmp_refused(), 'linkConnections': [line for line in link if line.strip()]}


def memory(label):
    result = subprocess.run([sys.executable, '-I', str(LAB / 'two-node.py'), 'memory', f't02 {label}'], capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'error': (result.stderr or result.stdout).strip()[-300:]}


def stamp():
    return time.strftime('%Y%m%dt%H%M%Sz', time.gmtime())


# ---- facts --------------------------------------------------------------------------------------------------

def image_reference():
    """The digest reference `ctr images import --digests --base-name` gives the archive: its index's digest."""
    with tarfile.open(IMAGE_ARCHIVE) as archive:
        index = archive.extractfile('index.json').read()
    return f'{sw.IMAGE_NAME}@sha256:{hashlib.sha256(index).hexdigest()}', json.loads(index)


def facts_image(ctx, step):
    """The image built from this commit (kit/build-image.sh), into both VMs' containerd, under its digest; nothing pushed."""
    reference, index = image_reference()
    archive_sha = al.sha256_file(IMAGE_ARCHIVE)
    results = {}
    for node in (1, 2):
        before = ssh_node(node, f'sudo k3s ctr -n k8s.io images ls -q | grep -F {sw.IMAGE_NAME} || true').stdout.split()
        if reference not in before:
            remote = f'/var/tmp/orbit-runner-lab-image-{archive_sha[:12]}.tar'
            copy = subprocess.run(['scp', '-q', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-P', SSH_PORTS[node], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                                   '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                                   str(IMAGE_ARCHIVE), f'ubuntu@127.0.0.1:{remote}'], capture_output=True, text=True)
            if copy.returncode:
                raise Failed(f'scp to VM {node}: {copy.stderr.strip()}')
            started = time.monotonic()
            ssh_node(node, f'sudo k3s ctr -n k8s.io images import --digests --base-name {sw.IMAGE_NAME} {remote} && sudo rm -f {remote}', timeout=600)
            seconds = round(time.monotonic() - started, 1)
            # The import fills the guest's page cache: give it back to the host.
            ssh_node(node, 'sudo /opt/orbit-lab/provision.sh trim', check=False, timeout=120)
        else:
            seconds = None
        inspect = json.loads(ssh_node(node, f'sudo k3s crictl inspecti -o json {shlex.quote(reference)}').stdout)['status']
        results[NODES[node]] = {'importSeconds': seconds, 'alreadyThere': seconds is None, 'id': inspect.get('id'),
                                'repoDigests': inspect.get('repoDigests'), 'repoTags': inspect.get('repoTags'), 'size': inspect.get('size')}
    ids = {r['id'] for r in results.values()}
    step.check('the image is in both VMs\' containerd under the same digest reference and ID', len(ids) == 1 and None not in ids, results)
    source = (IMAGE_ARCHIVE.parent / 'source-sha').read_text().strip() if (IMAGE_ARCHIVE.parent / 'source-sha').exists() else None
    diff = al.git('diff', '--stat', source, 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image') if source else 'unknown source'
    step.check('the image sources are unchanged since the image was built', diff == '', diff or '(no difference)')
    ctx['image'] = reference
    return {'reference': reference, 'archive': str(IMAGE_ARCHIVE), 'archiveSha256': archive_sha, 'source': source,
            'labManifest': index['manifests'][0]['digest'], 'tag': index['manifests'][0].get('annotations', {}).get('io.containerd.image.name'),
            'nodes': results, 'pushed': False}


def facts_git(ctx, step):
    head = al.git('rev-parse', 'HEAD')
    remote = dict(reversed(line.split('\t')) for line in al.run(['git', '-C', str(sw.REPO), 'ls-remote', 'origin', 'refs/heads/main',
                                                               al.PROJECT_LINE]).stdout.splitlines())
    dist = sw.REPO / 'src/apiserver/dist/main.js'
    step.check('the apiserver is built in this checkout', dist.exists())
    return {'head': head, 'branch': al.git('rev-parse', '--abbrev-ref', 'HEAD'), 'subject': al.git('log', '-1', '--format=%s'),
            'originMain': remote.get('refs/heads/main'), 'projectLine': remote.get(al.PROJECT_LINE),
            'projectLineIsAncestor': al.run(['git', '-C', str(sw.REPO), 'merge-base', '--is-ancestor', remote.get(al.PROJECT_LINE, 'HEAD'), 'HEAD'],
                                            check=False).returncode == 0,
            'uncommitted': al.git('status', '--porcelain').splitlines(),
            'apiserverBuiltAt': datetime.datetime.fromtimestamp(dist.stat().st_mtime, datetime.timezone.utc).isoformat(timespec='seconds')}


def facts_host(_ctx, step):
    modules = [line.split()[0] for line in Path('/proc/modules').read_text().splitlines() if line.split()[0] in ('rbd', 'nbd', 'ceph', 'libceph')]
    step.check('the host loads no rbd, nbd, ceph or libceph module', not modules, modules)
    units = {}
    for node in (1, 2):
        units[NODES[node]] = dict(line.split('=', 1) for line in ml.systemd('show', f'{UNITS[node]}.service', '-p', 'MemoryMax', '-p', 'CPUQuotaPerSecUSec',
                                                                           '-p', 'OOMScoreAdjust', '-p', 'ControlGroup', '-p', 'ActiveState').stdout.splitlines())
        step.check(f'VM {node} runs in its own unit, not in the runner\'s cgroup', units[NODES[node]].get('ControlGroup') == f'/system.slice/{UNITS[node]}.service',
                   units[NODES[node]].get('ControlGroup'))
    link = subprocess.run(['ss', '-Htn', 'state', 'established', f"( sport = :{ENV['LAB_LINK_PORT']} )"], capture_output=True, text=True).stdout.split('\n')
    meminfo = dict(re.findall(r'^(\w+):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M))
    return {'kernel': os.uname().release, 'cpus': os.cpu_count(), 'memTotalMiB': int(meminfo['MemTotal']) // 1024,
            'memAvailableMiB': int(meminfo['MemAvailable']) // 1024, 'hostModules': modules, 'units': units,
            'link': {'listen': f"127.0.0.1:{ENV['LAB_LINK_PORT']}", 'established': [line for line in link if line.strip()]},
            'memory': memory('facts')}


def facts_cluster(ctx, step):
    version = kjson('version', namespace=None)
    nodes = kjson('get', 'nodes', namespace=None)['items']
    step.check('two nodes: the first VM and the second', sorted(n['metadata']['name'] for n in nodes) == sorted(NODES.values()),
               [n['metadata']['name'] for n in nodes])
    for n in nodes:
        ready = next((c['status'] for c in n['status']['conditions'] if c['type'] == 'Ready'), None)
        step.check(f"{n['metadata']['name']} is Ready", ready == 'True', ready)
    storage_class = kjson('get', 'storageclass', ENV['LAB_STORAGE_CLASS'], namespace=None)
    driver = kjson('get', 'csidriver', ENV['LAB_CSI_DRIVER'], namespace=None)
    csi = kjson('get', 'pods', namespace=ENV['LAB_CSI_NAMESPACE'])['items']
    daemonsets = kjson('get', 'daemonsets', namespace=ENV['LAB_CSI_NAMESPACE'])['items']
    namespace = kjson('get', 'namespace', NAMESPACE, namespace=None)
    stale = [{'name': p['metadata']['name'], 'uid': p['metadata']['uid'], 'node': p['spec'].get('nodeName'), 'phase': p['status'].get('phase'),
              'deleting': bool(p['metadata'].get('deletionTimestamp')), 'finalizers': p['metadata'].get('finalizers')}
             for p in kjson('get', 'pods')['items']]
    ctx['nodeUids'] = {n['metadata']['name']: n['metadata']['uid'] for n in nodes}
    return {
        'kubernetes': {'server': version['serverVersion']['gitVersion'], 'client': version['clientVersion']['gitVersion']},
        'nodes': [{'name': n['metadata']['name'], 'uid': n['metadata']['uid'], 'nodeInfo': {k: n['status']['nodeInfo'].get(k) for k in (
                       'kernelVersion', 'osImage', 'kubeletVersion', 'containerRuntimeVersion', 'architecture')},
                   'addresses': n['status'].get('addresses'), 'allocatable': n['status']['allocatable'], 'capacity': n['status']['capacity'],
                   'labels': {k: v for k, v in (n['metadata'].get('labels') or {}).items() if k.startswith(('topology.', 'kubernetes.io/', 'node-role.'))},
                   'taints': n['spec'].get('taints', []), 'unschedulable': n['spec'].get('unschedulable', False)} for n in nodes],
        'storageClass': {k: storage_class.get(k) for k in ('provisioner', 'parameters', 'reclaimPolicy', 'volumeBindingMode', 'allowVolumeExpansion')},
        'csiDriver': driver['spec'],
        'csiPods': [{'name': p['metadata']['name'], 'node': p['spec'].get('nodeName'),
                     'images': sorted({c['image'] for c in p['spec']['containers']})} for p in csi],
        'csiDaemonSets': [{'name': d['metadata']['name'], 'tolerations': d['spec']['template']['spec'].get('tolerations')} for d in daemonsets],
        'namespace': {'name': NAMESPACE, 'uid': namespace['metadata']['uid'], 'labels': namespace['metadata'].get('labels')},
        'podsInTheNamespaceAtStart': stale,
    }


def facts_ceph(ctx, step):
    result = al.facts_ceph(ctx, step)
    result['blocklist'] = sw.ceph('ceph osd blocklist ls 2>&1')[0]
    result['monDump'] = ceph_json('ceph mon dump -f json')
    return result


# ---- setup and the switch -----------------------------------------------------------------------------------

def setup_admin(ctx, step):
    started = al.start_server('unset')
    step.check('the switch is unset while the administrator signs up', al.switch_lines() == [], al.switch_lines())
    root = al.account('root')
    step.check('root is the bootstrapped administrator', bool(ml.owner_state('root').get('admin')), root.get('admin'))
    rows = al.managed_rows()
    step.check('no managed runner row: the administrator has no mapping', not rows, len(rows))
    return {'server': started, 'root': root}


def on_prepare(ctx, step):
    prepared = capture(wl.cmd_prepare, image=ctx['image'], source=str(al.T02A))[0]  # manager-lab.py's identity; then wake-lab.py's profile
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t02'
    # T08's budget of two runners (each asks 500m and 768Mi, one Pod, one attachment, 1Gi of /tmp): one account uses one.
    profile['capacity'] = {'compute': {'cpu': '1', 'memory': '1536Mi', 'ephemeralStorage': '2Gi', 'pods': 2, 'attachments': 2},
                           'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2}
    # Asleep only when asked: an hour of idleness, so nothing drains the runner while the node is down or a check runs.
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


def on_admission(ctx, step):
    install = capture(sw.cmd_admission, action='install')
    step.check('the admission webhook is installed and refuses a Pod on an unowned managed claim',
               install['webhook'] and install['dryRunUnownedManagedClaim']['exit'] != 0 and install['dryRunUnmanagedPod']['exit'] == 0,
               {key: install[key]['answer'][:160] for key in ('dryRunUnmanagedPod', 'dryRunUnownedManagedClaim')})
    return {'install': install}


# ---- the account on the first node ---------------------------------------------------------------------------

def account_ready(ctx, step):
    cordoned = [cordon(1, 'uncordon'), cordon(2, 'cordon')]  # the first generation on the first node
    since = now()
    signed = al.account(OWNER)
    starting = until(OWNER, 'STARTING', reason='MODEL_UNAVAILABLE', timeout=300)
    key = capture(wl.cmd_key, name=OWNER)
    ready = until(OWNER, 'READY', timeout=420)
    ident = identity(OWNER)
    ctx['identity'] = {OWNER: ident}
    ctx['firstSignInAt'] = since
    view = placement(OWNER)
    check_placed(step, view, 1, 'generation 1')
    verdict = ml.verdict()
    step.check('the database and k3s agree', not verdict['problems'], verdict['problems'])
    pv = kget('pv', ident['pvName'], namespace=None)
    pvc = kget('pvc', ident['pvcName'])
    step.check('the claim is ReadWriteOnce, Filesystem, of the runner-data class; its PV ext4 on rbd.csi.ceph.com, Retain',
               pvc['spec']['accessModes'] == ['ReadWriteOnce'] and pvc['spec'].get('volumeMode') == 'Filesystem'
               and pvc['spec'].get('storageClassName') == ENV['LAB_STORAGE_CLASS'] and pv['spec']['csi']['driver'] == ENV['LAB_CSI_DRIVER']
               and pv['spec']['csi'].get('fsType') == 'ext4' and pv['spec'].get('persistentVolumeReclaimPolicy') == 'Retain',
               {'accessModes': pvc['spec']['accessModes'], 'fsType': pv['spec']['csi'].get('fsType')})
    return {'cordoned': cordoned, 'signIn': signed, 'starting': starting, 'key': key, 'ready': ready, 'identity': ident,
            'times': al.provisioned(OWNER), 'placement': view,
            'pvc': {k: pvc['metadata'].get(k) for k in ('name', 'uid', 'annotations')} | {'spec': pvc['spec'], 'phase': pvc['status'].get('phase')},
            'pv': {'name': pv['metadata']['name'], 'uid': pv['metadata']['uid'], 'accessModes': pv['spec']['accessModes'],
                   'volumeMode': pv['spec'].get('volumeMode'), 'reclaimPolicy': pv['spec'].get('persistentVolumeReclaimPolicy'),
                   'csi': {k: pv['spec']['csi'].get(k) for k in ('driver', 'fsType', 'volumeHandle', 'volumeAttributes')}},
            'rbdInfo': ceph_json(f'rbd info --format json {shlex.quote(rbd_image(ident))}')}


def account_data(ctx, step):
    result = al.first_session(ctx, OWNER)
    ctx['sessions'] = {OWNER: {'s1': result['session'], 's1Uuid': result['sessionUuid'], 'attachment': result['attachment'],
                               'wrote': result['wrote'], 'secret': result['secret']}}
    step.check('the session ran on ann\'s managed runner', result['event']['session']['assigned_runner_id'] == ctx['identity'][OWNER]['runnerId'],
               result['event']['session']['assigned_runner_id'])
    step.check('the engine committed a file in the session\'s Git worktree', bool(result['wrote']['commit']), result['wrote'])
    probe = capture(wl.cmd_probe, name=OWNER, action='write', run='p1')
    step.check(f'probe p1 written on {NODES[1]} (8 MiB random, {al.PROBE_ROWS} SQLite rows in WAL mode with synchronous=FULL, a Git commit), integrity_check ok',
               probe['data']['integrityCheck'] == 'ok' and probe['data']['rows'] >= al.PROBE_ROWS, probe['data']['rows'])
    snap = al.pod_snapshot(OWNER)
    step.check('/var/lib/orbit is an RBD device, ext4', snap['mount'] and snap['mount'][0]['source'].startswith('/dev/rbd') and snap['mount'][0]['fstype'] == 'ext4',
               snap['mount'])
    ctx.setdefault('snapshots', {})['onFirst'] = snap
    return {'session': result, 'probe': probe, 'snapshot': snap}


# ---- the normal move to the other node -------------------------------------------------------------------------

def migrate_sleep(ctx, step):
    awake = identity(OWNER)
    ctx['identity'][OWNER] = awake
    at = now()
    action = capture(ml.cmd_action, name=OWNER, action='sleep')
    step.check('the owner\'s sleep is accepted', action['status'] == 202, action['status'])
    slept = until(OWNER, 'SLEEPING', timeout=300)
    m = mapping(OWNER)
    view = placement(OWNER)
    check_released(step, view, 'asleep')
    proof = m['fencing_receipt'] or {}
    step.check('the drained generation retired on its kubelet\'s report (OBSERVED_STOP)', proof.get('kind') == 'OBSERVED_STOP'
               and (proof.get('predecessor') or {}).get('generation') == awake['generation'] and bool(proof.get('retiredAt')),
               {k: proof.get(k) for k in ('kind', 'recordedAt', 'retiredAt')})
    step.check('no compute held while asleep', not (m['reservation'] or {}).get('compute'), (m['reservation'] or {}).get('compute'))
    step.check('the claim is kept, bound to the same PV', identity(OWNER)['pvcUid'] == awake['pvcUid'] and identity(OWNER)['pvUid'] == awake['pvUid'])
    ctx['migration'] = {'sleepAt': at, 'sleptAt': slept['at']}
    return {'action': {k: action.get(k) for k in ('status', 'before')}, 'until': slept, 'proof': proof, 'placement': view,
            'sleepToAsleepSeconds': slept['seconds']}


def migrate_move(ctx, step):
    awake = ctx['identity'][OWNER]
    nodes = {'first': cordon(1, 'cordon'), 'second': cordon(2, 'uncordon')}
    snap_before = ctx['snapshots']['onFirst']
    at = now()
    turn = wl.new_turn(OWNER, ctx['sessions'][OWNER]['s1'], 'T02-ANN-MOVE a message that wakes the runner on the other node')
    step.check('the message is accepted', turn['status'] in (200, 201), turn['status'])
    found = al.answered(al.owner_uuid(OWNER), 'T02-ANN-MOVE', timeout=420, after=at)
    ready = until(OWNER, 'READY', timeout=180)
    after = identity(OWNER)
    al.same_identity(step, OWNER, awake, after, 'after the move to the other node')
    step.check('a new Pod of a later generation', after['generation'] > awake['generation'] and after['podUid'] not in (None, awake['podUid']),
               {'before': [awake['generation'], awake['podUid']], 'after': [after['generation'], after['podUid']]})
    view = placement(OWNER)
    check_placed(step, view, 2, f'generation {after["generation"]}')
    step.check('the waiting message was answered on ann\'s runner', found['event']['ingested_by_runner_id'] == after['runnerId'], found['event'])
    al.continuation_check(step, OWNER, found, ctx['sessions'][OWNER]['secret'], f'on {NODES[2]}')
    probe = capture(wl.cmd_probe, name=OWNER, action='check', run='p1')
    step.check(f'probe p1 on {NODES[2]}: the same random bytes, SQLite rows and Git commit, integrity_check ok', probe['allSame'], probe['same'])
    snap = al.pod_snapshot(OWNER, al.transcript_prefix(snap_before))
    al.compare_snapshots(step, OWNER, snap_before, snap, f'on {NODES[2]}', ctx['sessions'][OWNER]['s1Uuid'])
    step.check('/var/lib/orbit is an RBD device, ext4', snap['mount'] and snap['mount'][0]['source'].startswith('/dev/rbd') and snap['mount'][0]['fstype'] == 'ext4',
               snap['mount'])
    nodes['firstAgain'] = cordon(1, 'uncordon')  # both schedulable from here on; the runner stays where it runs
    ctx['identity'][OWNER] = after
    ctx['snapshots']['onSecond'] = snap
    times = al.provisioned(OWNER)
    return {'nodes': nodes, 'turn': turn, 'answered': found, 'answeredAfterSeconds': al.seconds_between(at, found['event']['ingested_at']),
            'ready': ready, 'messageToReadySeconds': al.seconds_between(at, ready['at']), 'times': times,
            'messageToPodCreatedSeconds': al.seconds_between(at, times['podCreatedAt']),
            'identityBefore': awake, 'identityAfter': after, 'placement': view, 'probe': probe, 'snapshot': snap}


# ---- a second Pod on the other node ----------------------------------------------------------------------------

def writer_start(ctx, step):
    started = capture(sw.cmd_payload, action='start', run_id=WRITER_RUN, minimum_rows=0)
    step.check('the probe writer runs in the runner container and has committed rows', started.get('committedRows', 0) >= 100, started.get('committedRows'))
    step.check(f'it writes on {NODES[2]}', mapping(OWNER)['node_name'] == NODES[2], mapping(OWNER)['node_name'])
    ctx['writer'] = {'run': WRITER_RUN, 'startedAt': started['at'], 'generation': started['generation'], 'podUid': started['podUid']}
    return started


def writer_rows():
    m = mapping(OWNER)
    text = sw.pod_exec(m['pod_name'], 'sh', '-c', f"cat {sw.PAYLOAD_ROOT}/{WRITER_RUN}/acknowledged.json").stdout
    return json.loads(text)['committedRows']


def contender(name, pod, node, claim, labelled=False):
    """A Pod on the runner's claim pinned to NODE (nodeName: no scheduler involved), copied from the authorized Pod or made from nothing."""
    if pod:
        base = json.loads(json.dumps(pod))
        spec = base['spec']
        # What the API server filled in for the authorized Pod; the Priority plugin refuses a stated priority.
        for key in ('nodeName', 'priority', 'preemptionPolicy'):
            spec.pop(key, None)
        metadata = {'name': name, 'namespace': NAMESPACE, 'annotations': base['metadata'].get('annotations', {})}
        if labelled:
            metadata['labels'] = base['metadata'].get('labels', {})
        spec['nodeName'] = node
        return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': metadata, 'spec': spec}
    return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE},
            'spec': {'restartPolicy': 'Never', 'nodeName': node,
                     'containers': [{'name': 'second-writer', 'image': ENV['PROBE_IMAGE'],
                                     'command': ['sh', '-c', 'echo second > /var/lib/orbit/second-pod.txt; sleep 3600'],
                                     'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/orbit'}]}],
                     'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}]}}


def attempt(label, pod, manager=False, expect=None):
    started = now()
    result = sw.kubectl('create', '-o', 'name', '-f', '-', input=json.dumps(pod), check=False, manager=manager)
    created = result.returncode == 0
    if created:  # admitted: it must not stay, but the record says it got in
        sw.kubectl('delete', 'pod', pod['metadata']['name'], '--grace-period=0', '--force', '--wait=false', check=False)
    answer = (result.stdout if created else result.stderr).strip()
    code = re.search(r'orbit-managed-runner-admission: ([A-Z_]+):', answer)
    return {'case': label, 'at': started, 'identity': f'system:serviceaccount:{NAMESPACE}:{sw.MANAGER}' if manager else 'lab cluster-admin',
            'name': pod['metadata']['name'], 'node': pod['spec'].get('nodeName'), 'admitted': created, 'code': code and code.group(1),
            'expected': expect, 'answer': answer}


def duplicate_guard(ctx, step):
    m = mapping(OWNER)
    pod = kget('pod', m['pod_name'])
    other = NODES[1]
    step.check(f'the runner runs on {NODES[2]}; the contenders go to {other}', pod['spec']['nodeName'] == NODES[2] and pod['status']['phase'] == 'Running',
               pod['spec']['nodeName'])
    claim = m['pvc_name']
    before = {'placement': placement(OWNER), 'writerRows': writer_rows()}
    attempts = [
        attempt(f'unlabelled Pod, another name, on {other}, by the cluster admin', contender('t02-second-admin', None, other, claim), expect='NOT_THE_MANAGER'),
        attempt(f'unlabelled Pod, another name, on {other}, by the manager identity', contender('t02-second-manager', None, other, claim), manager=True,
                expect='NOT_THE_FIXED_NAME'),
        attempt(f'copy of the authorized Pod (labels, annotations, image, volumes) under another name, on {other}, by the manager',
                contender('t02-second-copy', pod, other, claim, labelled=True), manager=True, expect='NOT_THE_FIXED_NAME'),
    ]
    copy = contender(pod['metadata']['name'], pod, other, claim, labelled=True)
    attempts.append(attempt(f'copy of the authorized Pod under its own fixed name, same generation, on {other}, by the manager', copy, manager=True,
                            expect='NOT_RESERVED'))
    following = json.loads(json.dumps(copy))
    following['metadata']['annotations']['orbit.dev/generation'] = str(m['generation'] + 1)
    attempts.append(attempt(f'the fixed name for the next generation, unreserved, on {other}, by the manager', following, manager=True,
                            expect='NOT_THE_RESERVED_GENERATION'))
    # A controller's Pod: the Job controller creates it under its own identity.
    job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 't02-second-job', 'namespace': NAMESPACE},
           'spec': {'backoffLimit': 0, 'template': contender('unused', None, other, claim)}}
    job['spec']['template'].pop('apiVersion')
    job['spec']['template'].pop('kind')
    job['spec']['template']['metadata'] = {'labels': {'t02': 'second-job'}}
    created = sw.kubectl('create', '-f', '-', input=json.dumps(job), check=False)
    time.sleep(12)
    events = kjson('get', 'events', '--field-selector', 'involvedObject.name=t02-second-job')['items']
    job_pods = kjson('get', 'pods', '-l', 't02=second-job')['items']
    attempts.append({'case': f"a Job's Pod on the claim on {other}, created by the Job controller", 'at': now(),
                     'identity': 'system:serviceaccount:kube-system:job-controller', 'jobCreated': created.returncode == 0,
                     'admitted': bool(job_pods), 'podsCreated': [p['metadata']['name'] for p in job_pods],
                     'events': sorted({f"{e['reason']}: {e['message']}" for e in events}), 'expected': 'NOT_THE_MANAGER'})
    sw.kubectl('delete', 'job', 't02-second-job', '--cascade=foreground', '--wait=false', check=False)
    time.sleep(3)
    after = {'placement': placement(OWNER), 'writerRows': writer_rows()}
    for a in attempts:
        if 'events' in a:
            step.check(a['case'] + ': no Pod; the Job controller\'s create refused by the guard',
                       not a['admitted'] and any('orbit-managed-runner-admission' in e and 'NOT_THE_MANAGER' in e for e in a['events']), a['events'])
        else:
            step.check(f"{a['case']}: refused by the admission guard, {a['expected']}", not a['admitted'] and a['code'] == a['expected'], a['answer'][-220:])
    step.check('the authorized Pod is the same one, still running on the second node',
               (before['placement']['pod'] or {}).get('uid') == (after['placement']['pod'] or {}).get('uid') == m['pod_uid'])
    check_placed(step, after['placement'], 2, 'after the contenders')
    step.check('no Pod on the first node references the claim', not [p for p in after['placement']['podsOnTheClaim'] if p['node'] == other],
               after['placement']['podsOnTheClaim'])
    step.check('the writer kept committing rows meanwhile', after['writerRows'] > before['writerRows'], [before['writerRows'], after['writerRows']])
    return {'before': before, 'attempts': attempts, 'after': after}


def duplicate_rwo(ctx, step):
    """What ReadWriteOnce alone does across nodes, on a plain claim of the same class (no managed name, so the guard admits its Pods)."""
    name = f't02-rwo-{stamp()}'
    run_id = name
    claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02'}},
             'spec': {'storageClassName': ENV['LAB_STORAGE_CLASS'], 'accessModes': ['ReadWriteOnce'], 'volumeMode': 'Filesystem',
                      'resources': {'requests': {'storage': '1Gi'}}}}
    k('apply', '-f', '-', input=json.dumps(claim))
    k('wait', '--for=jsonpath={.status.phase}=Bound', f'pvc/{name}', '--timeout=300s')
    pv_name = kget('pvc', name)['spec']['volumeName']
    pv = kget('pv', pv_name, namespace=None)
    image = f"{pv['spec']['csi']['volumeAttributes']['pool']}/{pv['spec']['csi']['volumeAttributes']['imageName']}"
    k('apply', '-f', '-', input=json.dumps({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'ceph-rbd-payload', 'namespace': NAMESPACE},
                                            'data': {'ceph-rbd-payload.py': (LAB.parent / 'ceph-rbd-payload.py').read_text()}}))
    first, second = f'{name}-a', f'{name}-b'
    k('apply', '-f', '-', input=json.dumps(render.probe_pod(first, name, run_id, sleep=False, node=NODES[1])))
    k('wait', '--for=condition=Ready', f'pod/{first}', '--timeout=600s')
    created_second = now()
    k('apply', '-f', '-', input=json.dumps(render.probe_pod(second, name, run_id, sleep=True, node=NODES[2])))
    deadline = time.monotonic() + 90
    events = []
    while time.monotonic() < deadline:
        events = kjson('get', 'events', '--field-selector', f'involvedObject.name={second}')['items']
        if any(e['reason'] == 'FailedAttachVolume' for e in events):
            break
        time.sleep(3)
    time.sleep(10)
    second_view = pod_view(second)
    events = kjson('get', 'events', '--field-selector', f'involvedObject.name={second}')['items']
    view = {'podsOnTheClaim': pods_on_claim(name), 'volumeAttachments': attachments(pv_name), 'guests': {NODES[n]: guest_rbd(n) for n in (1, 2)},
            'watchers': watchers(image), 'image': image}
    messages = sorted({f"{e['reason']}: {e['message']}" for e in events})
    step.check('the guard admits Pods on a plain claim: both exist', sorted(p['name'] for p in view['podsOnTheClaim']) == sorted([first, second]),
               view['podsOnTheClaim'])
    # Kubernetes 1.36 says "Waiting for detach for volume ... Volume is already used by pod(s) ..."; earlier releases "Multi-Attach error ...".
    step.check(f'the second Pod, on {NODES[2]}, is not running: the attach/detach controller refuses a second node for an RWO volume',
               second_view['phase'] == 'Pending' and any(m.startswith('FailedAttachVolume') and ('already used by pod' in m or 'Multi-Attach' in m) for m in messages),
               {'phase': second_view['phase'], 'events': messages})
    step.check(f'one VolumeAttachment, to {NODES[1]}', [a['node'] for a in view['volumeAttachments']] == [NODES[1]], view['volumeAttachments'])
    step.check(f'mapped by {NODES[1]} only', bool(mapped_on(view, 1)) and not mapped_on(view, 2), {n: mapped_on(view, n) for n in (1, 2)})
    # Clean up: the Pods, then the claim, its PV and its image (Retain keeps the PV and the image otherwise).
    k('delete', 'pod', second, first, '--wait=true', '--timeout=300s')
    deadline = time.monotonic() + 300
    while attachments(pv_name) or any(d.get('image') == image for n in (1, 2) for d in ((guest_rbd(n) or {}).get('devices') or [])):
        if time.monotonic() > deadline:
            raise Failed(f'{name}: still attached or mapped 300 s after its Pods were deleted')
        time.sleep(3)
    k('delete', 'pvc', name, '--wait=true')
    k('delete', 'pv', pv_name, '--wait=true', namespace=None)
    removed = al.ceph_shell(f'rbd rm --no-progress {shlex.quote(image)} && rbd ls {shlex.quote(image.split("/")[0])}')
    step.check('the plain claim, its PV and its image are removed again', image.split('/')[1] not in removed.split())
    return {'claim': name, 'pv': pv_name, 'image': image, 'secondPodCreatedAt': created_second, 'secondPod': second_view, 'events': messages, 'view': view}


def duplicate_rbd(ctx, step):
    """RBD itself, while the runner's kernel client on the second node maps the image: no exclusive-lock, no lock, and a
    second client (librbd from the first VM, the admin identity) opens and reads it without being refused."""
    ident = identity(OWNER)
    image = rbd_image(ident)
    info = ceph_json(f'rbd info --format json {shlex.quote(image)}')
    locks = ceph_json(f'rbd lock ls --format json {shlex.quote(image)}')
    before = watchers(image)
    started = time.monotonic()
    bench = sw.ceph(f'rbd bench --io-type read --io-size 4096 --io-total 1M --io-threads 1 --io-pattern seq {shlex.quote(image)} 2>&1; echo exit=$?')[0]
    seconds = round(time.monotonic() - started, 1)
    after = watchers(image)
    step.check('the image has the layering feature only: no exclusive-lock', info.get('features') == ['layering'], info.get('features'))
    step.check('no RBD lock is held on it', locks in ([], {}) or (isinstance(locks, dict) and not locks.get('locks')), locks)
    step.check(f'one watcher before and after: the kernel client of {NODES[2]}', [w.get('address', '')[:len(LINK_IPS[2]) + 1] for w in before] == [LINK_IPS[2] + ':']
               and [w.get('address', '')[:len(LINK_IPS[2]) + 1] for w in after] == [LINK_IPS[2] + ':'], {'before': before, 'after': after})
    step.check('a second client opened the image and read 1 MiB: Ceph refused nothing', bench.rstrip().endswith('exit=0'), bench[-300:])
    return {'image': image, 'rbdInfo': info, 'locks': locks, 'watchersBefore': before, 'secondClientRead': bench[-600:], 'secondClientSeconds': seconds,
            'watchersAfter': after}


# ---- the second node fails --------------------------------------------------------------------------------------

def payload_snapshot(pod, minimum_rows=0, recover=False):
    sw.pod_exec(pod, 'sh', '-c', f'cat > {sw.PAYLOAD_IN_POD}', input=sw.payload_source())
    flags = ['--recover'] if recover else []
    view = json.loads(sw.pod_exec(pod, 'python3', sw.PAYLOAD_IN_POD, 'snapshot', *flags, '--minimum-rows', str(minimum_rows), '--run-id', WRITER_RUN).stdout)
    view['randomSHA256'] = sw.pod_exec(pod, 'sha256sum', f'{sw.PAYLOAD_ROOT}/{WRITER_RUN}/random.bin').stdout.split()[0]
    return view


def takeover_prepare(ctx, step):
    view = placement(OWNER)
    check_placed(step, view, 2, 'before the failure')
    probe = capture(wl.cmd_probe, name=OWNER, action='write', run='p2')
    step.check(f'probe p2 written on {NODES[2]}, integrity_check ok', probe['data']['integrityCheck'] == 'ok', probe['data']['rows'])
    snap = al.pod_snapshot(OWNER, al.transcript_prefix(ctx['snapshots']['onSecond']))
    credential = capture(sw.cmd_credential, action='save')
    m = mapping(OWNER)
    step.check('the saved credential is this generation\'s', credential['generation'] == m['generation'] and credential['podUid'] == m['pod_uid'],
               {k: credential[k] for k in ('generation', 'podUid')})
    ctx['snapshots']['beforeFailure'] = snap
    ctx['takeover'] = {'generation': m['generation'], 'podUid': m['pod_uid'], 'podName': m['pod_name'], 'nodeName': m['node_name'],
                       'credentialSaved': credential['file']}
    return {'placement': view, 'probe': probe, 'snapshot': snap, 'credential': {k: credential[k] for k in ('generation', 'podUid', 'tokenSha256Prefix')},
            'nodes': {NODES[n]: node_view(n) for n in (1, 2)}, 'memory': memory('before the failure')}


def takeover_cut(ctx, step):
    """The power cut of the second VM (stop.sh --node 2 --hard: SIGKILL of its qemu) while the writer commits rows there."""
    m = mapping(OWNER)
    step.check('the runner is READY on the second node with its writer running', m['management_state'] == 'READY' and m['node_name'] == NODES[2],
               {k: m[k] for k in ('management_state', 'node_name')})
    pre = payload_snapshot(m['pod_name'])  # a read transaction beside the writer: every acknowledged row and its hash
    last = writer_rows()
    gate_before = ml.gate_connections()
    result = al.run([str(LAB / 'stop.sh'), '--node', '2', '--hard'])
    said = result.stdout + result.stderr
    killed = re.search(r'killed with SIGKILL at (\S+);', said)
    step.check('stop.sh killed the second VM\'s qemu with SIGKILL', bool(killed), said.strip()[-400:])
    power = power_state(2)
    step.check('the second VM is off: its unit inactive, no qemu process, SSH and QMP refused, the link down',
               power['activeState'] in ('inactive', 'failed') and not power['qemuProcesses'] and power['sshRefused'] and power['qmpRefused']
               and not power['linkConnections'], power)
    ctx['takeover'].update(killedAt=killed.group(1) if killed else now(), beforeCut={k: pre[k] for k in (
        'acknowledgedRows', 'acknowledgedSHA256', 'committedRows', 'rowSHA256', 'ordinarySHA256', 'gitCommit', 'randomSHA256')},
        lastAcknowledgedRead=last, gateBefore=gate_before)
    return {'stopSh': said.strip().splitlines(), 'killedAt': ctx['takeover']['killedAt'], 'power': power, 'writerBeforeCut': pre,
            'lastAcknowledgedRowsRead': last}


def loss_sample(ctx, image, pv_name, claim, watch):
    m = mapping(OWNER)
    runner = wl.sql_json(f"select status, {sw.runner_last_beat()} as last_heartbeat_at from runner where id = {wl.quote(m['runner_id'])}")[0]
    status = ml.status_of(OWNER)
    return {'at': now(), 'mapping': {'state': m['management_state'], 'desired': m['desired_state'], 'generation': m['generation'],
                                     'podUid': m['pod_uid'], 'reason': (m['last_error'] or {}).get('code'), 'attempt': m['attempt'],
                                     'proof': (m['fencing_receipt'] or {}).get('kind')},
            'runner': runner, 'ownerStatus': {k: status.get(k) for k in ('managementState', 'usable', 'heartbeatStatus', 'reason')},
            'node': node_view(2), 'pod': pod_view(f"mr-{m['runner_id']}"), 'podsOnTheClaim': pods_on_claim(claim),
            'volumeAttachments': attachments(pv_name), 'watchers': watchers(image) if watch else None, 'gateConnections': ml.gate_connections()}


def takeover_heartbeat_loss(ctx, step):
    """No proof yet: the node is gone, its runner silent. For OBSERVE seconds nothing may take over, under demand too."""
    ident = identity(OWNER)
    image, claim = rbd_image(ident), ident['pvcName']
    out = Path(ctx['out'])
    timeline = out / 'records' / 'takeover-heartbeat-loss-timeline.jsonl'
    killed = datetime.datetime.fromisoformat(ctx['takeover']['killedAt'].replace('Z', '+00:00'))
    since = ctx['takeover']['killedAt']
    window = ctx['observeSeconds']
    started, samples, demand, retry = time.monotonic(), [], None, None
    last_watch = -15
    while True:
        elapsed = (datetime.datetime.now(datetime.timezone.utc) - killed).total_seconds()
        if elapsed >= window:
            break
        try:
            watch = time.monotonic() - started - last_watch >= 15
            sample = loss_sample(ctx, image, ident['pvName'], claim, watch)
            if watch:
                last_watch = time.monotonic() - started
        except (Exception, SystemExit) as error:  # recorded and sampled again
            sample = {'at': now(), 'error': str(error)[-300:]}
        sample['secondsSinceCut'] = round(elapsed, 1)
        samples.append(sample)
        with timeline.open('a') as stream:
            stream.write(json.dumps(sample, sort_keys=True) + '\n')
        if demand is None and elapsed >= 150:
            # Demand while the node is gone: a message waits; it may not make the manager start anything.
            demand = wl.new_turn(OWNER, ctx['sessions'][OWNER]['s1'], 'T02-ANN-DURING-LOSS a message while the runner\'s node is down')
            retry = capture(ml.cmd_action, name=OWNER, action='retry')
        time.sleep(5)
    good = [s for s in samples if 'error' not in s]
    states = sorted({s['mapping']['state'] for s in good})
    generations = sorted({s['mapping']['generation'] for s in good})
    pods = sorted({p['uid'] for s in good for p in s['podsOnTheClaim']})
    nodes = sorted({(s['node'] or {}).get('ready') for s in good})
    gate = al.gate_summary(since)
    first_unknown = next((s['secondsSinceCut'] for s in good if (s['node'] or {}).get('ready') == 'Unknown'), None)
    first_evicted = next((s['secondsSinceCut'] for s in good if (s['pod'] or {}).get('deletionTimestamp')), None)
    first_stale = next((s['secondsSinceCut'] for s in good if s['ownerStatus'].get('usable') is False), None)
    step.check('samples were taken through the whole window', len(good) >= window // 10, len(good))
    step.check('the mapping kept its generation and its recorded Pod: nothing was replaced', generations == [ctx['takeover']['generation']]
               and {s['mapping']['podUid'] for s in good} == {ctx['takeover']['podUid']}, {'generations': generations})
    step.check('no state on the way to a new instance (REQUESTED, PROVISIONING, STARTING) was entered', not set(states) & {'REQUESTED', 'PROVISIONING', 'STARTING'},
               states)
    step.check('only the old Pod object ever referenced the claim', pods == [ctx['takeover']['podUid']], pods)
    step.check('the gate saw no Pod create from the manager since the cut', not gate['byKind'].get('Pod create'), gate['byKind'])
    step.check(f'the VolumeAttachment stayed on {NODES[2]} (nothing detached it)', all([a['node'] for a in s['volumeAttachments']] == [NODES[2]] for s in good))
    step.check('the second node went Unknown', 'Unknown' in nodes, nodes)
    step.check('the owner\'s status said the runner is not usable', first_stale is not None, first_stale)
    step.check('the message sent meanwhile was accepted and waits', demand is not None and demand['status'] in (200, 201), demand and demand['status'])
    step.check('the owner\'s retry did not start anything', retry is not None and retry['status'] != 202, retry and {k: retry.get(k) for k in ('status', 'answer')})
    pending = wl.sql_json(f"select status from conversation_turn where session_id = {wl.quote(ctx['sessions'][OWNER]['s1Uuid'])} order by created_at desc limit 1")
    step.check('the message is still waiting at the end of the window', pending and pending[0]['status'] == 'PENDING', pending)
    ctx['takeover'].update(demand=demand, windowStates=states)
    return {'windowSeconds': window, 'samples': len(samples), 'errors': [s for s in samples if 'error' in s][:5], 'statesSeen': states,
            'firstUnknownSeconds': first_unknown, 'firstEvictedSeconds': first_evicted, 'firstUnusableSeconds': first_stale,
            'first': good[0] if good else None, 'last': good[-1] if good else None, 'gate': gate, 'demand': demand,
            'retry': retry and {k: retry.get(k) for k in ('status', 'answer', 'before')}, 'timeline': str(timeline), 'memory': memory('second node down')}


def fencing_receipt(m, ident, node_uid, killed_at, power, observed_at):
    """The runbook's receipt (deploy/managed-runner/fencing-receipt.example.json): NODE_POWER_OFF through the hypervisor."""
    return {
        'schemaVersion': 1, 'kind': 'orbit.managed-runner.fencing-receipt', 'method': 'NODE_POWER_OFF',
        'predecessor': {'runnerId': m['runner_id'], 'generation': m['generation'], 'podName': m['pod_name'], 'podUid': m['pod_uid'],
                        'nodeName': m['node_name'], 'nodeUid': node_uid, 'pvcUid': m['pvc_uid'], 'volumeHandle': m['volume_handle'],
                        'rbdImage': {'pool': ident['pool'], 'image': ident['rbdImage']}},
        'action': {'performedBy': OPERATOR, 'performedAt': killed_at,
                   'description': f"The qemu process of VM {m['node_name']} (systemd unit {UNITS[2]}.service) was killed with SIGKILL on the "
                                  f"hypervisor host (stop.sh --node 2 --hard): the guest's power was cut, with no shutdown inside it.",
                   'reference': 'T02 lab, docs/evidence/managed-runner-cross-node/2026-10-19'},
        'verification': {'observedBy': OPERATOR, 'observedAt': observed_at, 'result': 'POWERED_OFF',
                         'evidenceReference': f"host checks at {power['at']}: unit {power['activeState']}, no qemu process for {m['node_name']}, "
                                              f"SSH 127.0.0.1:{SSH_PORTS[2]} and the QMP socket refused, no link connection"},
        'nodePowerOff': {'mechanism': 'HYPERVISOR', 'quarantined': True,
                         'quarantineReference': f'{OUT_OF_SERVICE}=nodeshutdown:NoExecute stays on {m["node_name"]}, and its VM stays off, until the stale '
                                                'Pod object and VolumeAttachment are gone; on its return the node is checked to map and mount '
                                                'nothing of the volume before the taint is removed'},
    }


def watch_until(predicate, seconds, label):
    """Sample the mapping, the runner's Pod object, the Pods on the claim and the attachments every second until predicate(sample)."""
    ident = identity(OWNER)
    deadline, seen, last = time.monotonic() + seconds, [], None
    while True:
        m = mapping(OWNER)
        pod = pod_view(f"mr-{m['runner_id']}")
        sample = {'at': now(), 'state': m['management_state'], 'generation': m['generation'], 'reason': (m['last_error'] or {}).get('code'),
                  'podUid': m['pod_uid'], 'proof': (m['fencing_receipt'] or {}).get('kind'), 'proofRetired': bool((m['fencing_receipt'] or {}).get('retiredAt')),
                  'pod': pod and {k: pod[k] for k in ('uid', 'node', 'phase', 'deletionTimestamp', 'finalizers', 'disruptionTarget')},
                  'podsOnTheClaim': [(p['uid'][:8], p['node'], p['phase']) for p in pods_on_claim(ident['pvcName'])],
                  'volumeAttachments': [(a['node'], a['attached'], a['deleting']) for a in attachments(ident['pvName'])]}
        compare = {k: v for k, v in sample.items() if k != 'at'}
        if compare != last:
            seen.append(sample)
            last = compare
        if predicate(sample, m):
            return seen, sample, m
        if time.monotonic() > deadline:
            raise Failed(f'{label}: not reached within {seconds} s: {seen[-3:]}')
        time.sleep(1)


def takeover_fence(ctx, step):
    """The runbook's failover: verify the power-off, write the receipt, taint the node out of service, take the stale Pod's finalizer off."""
    m = mapping(OWNER)
    ident = identity(OWNER)
    taken = ctx['takeover']
    step.check('the mapping still names the predecessor on the second node', m['generation'] == taken['generation'] and m['pod_uid'] == taken['podUid']
               and m['node_name'] == NODES[2], {k: m[k] for k in ('generation', 'pod_uid', 'node_name', 'management_state')})
    power = power_state(2)
    step.check('the power-off is verified again before anything is released', power['activeState'] in ('inactive', 'failed') and not power['qemuProcesses']
               and power['sshRefused'] and power['qmpRefused'], power)
    node_uid = ctx['nodeUids'][NODES[2]]
    receipt = fencing_receipt(m, ident, node_uid, taken['killedAt'], power, now())
    name = f"mr-fence-{m['runner_id']}"
    k('create', 'configmap', name, '--from-file=receipt.json=/dev/stdin', input=json.dumps(receipt, indent=2))
    receipt_at = now()
    gate_since = receipt_at
    k('taint', 'node', NODES[2], f'{OUT_OF_SERVICE}=nodeshutdown:NoExecute', namespace=None)
    taint_at = now()
    # PodGC makes the evicted Pod Failed for the out-of-service node; the manager, finding it terminal by the control plane's word, fences.
    seen_fence, fenced, m_fenced = watch_until(lambda s, mm: s['state'] == 'FENCING' and (s['pod'] or {}).get('phase') in ('Failed', 'Succeeded'), 240,
                                               'FENCING after the out-of-service taint')
    step.check('the stale Pod was made Failed by the control plane, not by its kubelet (DisruptionTarget)',
               ((fenced['pod'] or {}).get('disruptionTarget') or {}).get('reason') in ('DeletionByPodGC', 'DeletionByTaintManager'),
               (fenced['pod'] or {}).get('disruptionTarget'))
    step.check('the manager went FENCING: the stop is unproven', fenced['reason'] == 'PREDECESSOR_STOP_UNPROVEN', fenced['reason'])
    step.check('the stale Pod is held by the stop-report finalizer', STOP_REPORT in ((fenced['pod'] or {}).get('finalizers') or []), (fenced['pod'] or {}).get('finalizers'))
    replay_fenced = capture(sw.cmd_credential, action='replay')
    old = [r for r in replay_fenced['results'] if r['credential'] == f"generation {taken['generation']}"]
    step.check('the predecessor\'s credential is refused 401 once fenced, at every door', old and all(r['status'] == 401 for r in old),
               sorted({(r['route'], r['status']) for r in old}))
    # Take the finalizer off, by UID, as the runbook says: the node is fenced and the receipt is in place.
    pod = kget('pod', m['pod_name'])
    at = (pod['metadata'].get('finalizers') or []).index(STOP_REPORT)
    patch = [{'op': 'test', 'path': '/metadata/uid', 'value': pod['metadata']['uid']},
             {'op': 'test', 'path': f'/metadata/finalizers/{at}', 'value': STOP_REPORT},
             {'op': 'remove', 'path': f'/metadata/finalizers/{at}'}]
    k('patch', 'pod', m['pod_name'], '--type=json', '-p', json.dumps(patch))
    released_at = now()
    seen_next, ready, m_ready = watch_until(lambda s, mm: s['state'] == 'READY' and s['generation'] > taken['generation'], 600,
                                            'READY on the next generation')
    after = identity(OWNER)
    view = placement(OWNER)
    proof = m_ready['fencing_receipt'] or {}
    gate = al.gate_summary(gate_since)
    al.same_identity(step, OWNER, ctx['identity'][OWNER], after, 'after the takeover')
    step.check('the receipt was accepted: the predecessor retired on FENCING_RECEIPT, from the ConfigMap',
               proof.get('kind') == 'FENCING_RECEIPT' and (proof.get('source') or {}).get('configMap') == name and bool(proof.get('retiredAt'))
               and (proof.get('predecessor') or {}).get('generation') == taken['generation'] and (proof.get('predecessor') or {}).get('podUid') == taken['podUid'],
               {k: proof.get(k) for k in ('kind', 'source', 'recordedAt', 'retiredAt')})
    step.check('the next generation, a new Pod', after['generation'] == taken['generation'] + 1 and after['podUid'] not in (None, taken['podUid']),
               [after['generation'], after['podUid']])
    check_placed(step, view, 1, f'generation {after["generation"]}')
    step.check('never two Pods on the claim while it moved', all(len(s['podsOnTheClaim']) <= 1 for s in seen_fence + seen_next))
    step.check('never two VolumeAttachments while it moved', all(len(s['volumeAttachments']) <= 1 for s in seen_fence + seen_next))
    made = sorted({uid for s in seen_fence + seen_next for uid, _node, _phase in s['podsOnTheClaim']} - {taken['podUid'][:8]})
    step.check('one Pod was made on the claim since the receipt: the next generation\'s', made == [after['podUid'][:8]], made)
    ctx['identity'][OWNER] = after
    times = al.provisioned(OWNER)
    taken.update(receiptAt=receipt_at, taintAt=taint_at, finalizerOffAt=released_at, fencedAt=fenced['at'], readyAt=ready['at'], receipt=receipt)
    return {'power': power, 'receipt': receipt, 'configMap': name, 'receiptAt': receipt_at, 'taintAt': taint_at, 'untilFencing': seen_fence,
            'replayWhileFenced': replay_fenced, 'finalizerPatch': patch, 'finalizerOffAt': released_at, 'untilReady': seen_next,
            'proof': proof, 'identity': after, 'placement': view, 'gate': gate, 'times': times, 'nodes': {NODES[n]: node_view(n) for n in (1, 2)},
            'seconds': {'cutToReceipt': al.seconds_between(taken['killedAt'], receipt_at), 'taintToFencing': al.seconds_between(taint_at, fenced['at']),
                        'finalizerOffToReady': al.seconds_between(released_at, ready['at']), 'cutToReady': al.seconds_between(taken['killedAt'], ready['at'])}}


GIT_FILES = r'''
import json, os, sys
repo = os.path.join(sys.argv[1], 'repo')
names = ['note.txt', '.git/HEAD', '.git/refs/heads/master', '.git/index', '.git/config', '.git/COMMIT_EDITMSG']
objects = [os.path.join(d, f) for d, _, fs in os.walk(os.path.join(repo, '.git/objects')) for f in fs]
size = lambda p: os.path.getsize(p) if os.path.exists(p) else None
print(json.dumps({'files': {n: size(os.path.join(repo, n)) for n in names},
                  'looseObjects': sorted([os.path.relpath(p, repo), os.path.getsize(p)] for p in objects)}))
'''


def git_files(pod, run):
    """The sizes of a probe repository's files: what a power cut left of a Git commit nobody fsynced."""
    return json.loads(sw.pod_exec(pod, 'python3', '-c', GIT_FILES, f'{wl.PROBE_ROOT}/{run}').stdout)


def probe_check(run):
    """wake-lab.py's probe check, every field compared and reported, nothing raised."""
    m, pod = ml.running_pod(OWNER)
    result = json.loads(sw.pod_exec(pod['metadata']['name'], 'python3', '-c', wl.PROBE, 'check', f'{wl.PROBE_ROOT}/{run}').stdout)
    written = ml.owner_state(OWNER)['probes'][run]
    return {'run': run, 'writtenAt': written['at'], 'writtenByGeneration': written['generation'], 'writtenByPod': written['pod'],
            'checkedByGeneration': m['generation'], 'written': written['data'], 'data': result,
            'same': {k: written['data'][k] == result[k] for k in ('randomSha256', 'rows', 'rowsSha256', 'gitHead')}}


def takeover_data(ctx, step):
    """The data after the takeover on the first node: what the writer acknowledged, the probes, the session and the volume."""
    taken = ctx['takeover']
    m = mapping(OWNER)
    before = taken['beforeCut']
    recovered = payload_snapshot(m['pod_name'], minimum_rows=before['acknowledgedRows'], recover=True)
    step.check('SQLite integrity_check ok after WAL recovery, still in WAL mode', recovered['sqliteIntegrity'] == ['ok'] and recovered['sqliteJournalMode'] == 'wal',
               [recovered['sqliteIntegrity'], recovered['sqliteJournalMode']])
    step.check('every row acknowledged before the cut is there (the last read and the one on disk)',
               recovered['committedRows'] >= taken['lastAcknowledgedRead'] and recovered['committedRows'] >= recovered['acknowledgedRows'],
               {'committed': recovered['committedRows'], 'lastRead': taken['lastAcknowledgedRead'], 'acknowledgedOnDisk': recovered['acknowledgedRows']})
    step.check('the rows read before the cut hash the same', recovered['prefixSHA256'] == before['acknowledgedSHA256'],
               {'rows': before['acknowledgedRows'], 'before': before['acknowledgedSHA256'][:16], 'after': recovered['prefixSHA256'][:16]})
    step.check('the writer\'s ordinary file, Git commit and random file as before', recovered['ordinarySHA256'] == before['ordinarySHA256']
               and recovered['gitCommit'] == before['gitCommit'] and recovered['randomSHA256'] == before['randomSHA256'] and 'error' not in recovered['gitFsck'],
               {'gitFsck': recovered['gitFsck'][:80]})
    probes = {run: probe_check(run) for run in ('p1', 'p2')}
    step.check('probe p1 (written on the first node): the same random bytes, SQLite rows and Git commit, integrity_check ok',
               all(probes['p1']['same'].values()) and probes['p1']['data']['integrityCheck'] == 'ok', probes['p1']['same'])
    # p2 was written on the second node shortly before its power was cut. What it fsynced (the random file, the SQLite rows with
    # synchronous=FULL) must be there; its Git commit was not fsynced (Git's default) and is reported as found, not judged.
    p2 = probes['p2']
    step.check('probe p2 (written on the second node before the cut): the fsynced random bytes and SQLite rows the same, integrity_check ok',
               all(p2['same'][k] for k in ('randomSha256', 'rows', 'rowsSha256')) and p2['data']['integrityCheck'] == 'ok', p2['same'])
    p2['secondsBeforeTheCut'] = al.seconds_between(p2['writtenAt'], taken['killedAt'].replace('Z', '+00:00'))
    p2['gitFiles'] = git_files(m['pod_name'], 'p2')
    found = al.answered(al.owner_uuid(OWNER), 'T02-ANN-DURING-LOSS', timeout=300, after=taken['demand']['at'])
    step.check('the message sent while the node was down was answered by ann\'s runner after the takeover',
               found['event']['ingested_by_runner_id'] == m['runner_id'] and al.seconds_between(taken['finalizerOffAt'], found['event']['ingested_at']) > 0,
               found['event'])
    al.continuation_check(step, OWNER, found, ctx['sessions'][OWNER]['secret'], 'after the takeover')
    snap_before = ctx['snapshots']['beforeFailure']
    snap = al.pod_snapshot(OWNER, al.transcript_prefix(snap_before))
    al.compare_snapshots(step, OWNER, snap_before, snap, 'after the takeover', ctx['sessions'][OWNER]['s1Uuid'])
    step.check('/var/lib/orbit is an RBD device, ext4', snap['mount'] and snap['mount'][0]['source'].startswith('/dev/rbd') and snap['mount'][0]['fstype'] == 'ext4',
               snap['mount'])
    step.check('the volume names the new generation and its Pod', (snap['managedInstance'] or {}).get('generation') == m['generation']
               and (snap['managedInstance'] or {}).get('podUid') == m['pod_uid'], snap['managedInstance'])
    ctx['snapshots']['afterTakeover'] = snap
    return {'writer': recovered, 'probes': probes, 'answered': found, 'answeredAfterLossSeconds': al.seconds_between(taken['demand']['at'], found['event']['ingested_at']),
            'snapshot': snap}


# ---- the old node comes back ---------------------------------------------------------------------------------------

VM2_PODS = r'''set -u
sudo k3s crictl pods -o json 2>/dev/null || echo '{}'
echo @@@
sudo k3s crictl ps -a -o json 2>/dev/null || echo '{}'
echo @@@
sudo ls /var/lib/kubelet/pods 2>/dev/null || true
echo @@@
sudo journalctl -u k3s-agent -b --no-pager -o cat 2>/dev/null | grep -F "@UID@" | tail -n 12 || true
'''


def vm2_view(old_uid):
    text = ssh_node(2, VM2_PODS.replace('@UID@', old_uid), check=False, timeout=60).stdout
    parts = text.split('@@@')
    load = lambda part: json.loads(part.strip() or '{}')
    try:
        sandboxes = load(parts[0]).get('items') or []
        containers = load(parts[1]).get('containers') or []
    except (ValueError, IndexError):
        sandboxes, containers = [], []
    mine = lambda labels: (labels or {}).get('io.kubernetes.pod.uid') == old_uid
    return {'sandboxesOfTheOldPod': [{'id': s['id'][:12], 'state': s['state']} for s in sandboxes if mine(s.get('labels'))],
            'containersOfTheOldPod': [{'name': c['metadata']['name'], 'state': c['state']} for c in containers if mine(c.get('labels'))],
            'runningContainers': [c['metadata']['name'] for c in containers if c['state'] == 'CONTAINER_RUNNING'],
            'oldPodDirectory': old_uid in (parts[2] if len(parts) > 2 else ''),
            'kubeletLinesAboutTheOldPod': [line[-240:] for line in (parts[3] if len(parts) > 3 else '').strip().splitlines()]}


def rejoin_start(ctx, step):
    """The second VM boots again with the out-of-service taint still on its node: it may run and map nothing of the runner."""
    taken = ctx['takeover']
    log = Path(ctx['out']) / 'logs' / 'rejoin-start.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    started_at = now()
    with log.open('w') as output:
        result = subprocess.run([str(LAB / 'start.sh'), '--nodes', '2', '--no-wait'], stdout=output, stderr=subprocess.STDOUT)
    step.check('start.sh --nodes 2 booted the second VM', result.returncode == 0, result.returncode)
    deadline = time.monotonic() + 420
    while (node_view(2) or {}).get('ready') != 'True':
        if time.monotonic() > deadline:
            raise Failed(f'{NODES[2]} not Ready within 420 s of its boot')
        time.sleep(3)
    ready_at = now()
    time.sleep(45)  # the kubelet's first passes: orphaned Pods and volumes it finds after the boot
    node = node_view(2)
    old_uid = taken['podUid']
    vm2 = vm2_view(old_uid)
    view = placement(OWNER)
    step.check('the second node is Ready again and still tainted out of service', node['ready'] == 'True'
               and any(t.startswith(OUT_OF_SERVICE) for t in node['taints']), node)
    step.check('the old Pod object is gone', kget('pod', taken['podName']) is None or (kget('pod', taken['podName']) or {}).get('metadata', {}).get('uid') != old_uid)
    step.check('no sandbox or container of the old Pod runs on the second node', not [s for s in vm2['sandboxesOfTheOldPod'] if s['state'] == 'SANDBOX_READY']
               and not [c for c in vm2['containersOfTheOldPod'] if c['state'] == 'CONTAINER_RUNNING'], vm2)
    guest = view['guests'].get(NODES[2]) or {}
    step.check('the second VM booted anew (a new boot ID) and maps and mounts nothing of the image', guest.get('bootId') and not mapped_on(view, 2)
               and not [mt for mt in guest.get('mounts') or [] if any(d['device'] in mt['source'] for d in mapped_on(view, 2))], guest)
    check_placed(step, view, 1, 'with the old node back')
    ctx['takeover'].update(rejoinedAt=ready_at)
    return {'startShAt': started_at, 'readyAt': ready_at, 'bootToReadySeconds': al.seconds_between(started_at, ready_at), 'node': node, 'vm2': vm2,
            'placement': view, 'startLog': log.read_text().splitlines()[-20:], 'memory': memory('second node back, tainted')}


def rejoin_credentials(ctx, step):
    saved = capture(sw.cmd_credential, action='save')  # the current generation's, beside the old one
    replay = capture(sw.cmd_credential, action='replay')
    taken = ctx['takeover']
    current = mapping(OWNER)['generation']
    old = [r for r in replay['results'] if r['credential'] == f"generation {taken['generation']}"]
    naming_old = [r for r in replay['results'] if r['credential'] == f'generation {current}' and r['offer'].startswith(f"generation {taken['generation']}")]
    own = [r for r in replay['results'] if r['credential'] == f'generation {current}' and r['offer'] == 'its own generation and Pod']
    step.check(f"the old generation's credential ({taken['generation']}) is refused 401 at /runner/me, heartbeat and claim",
               len(old) >= 3 and all(r['status'] == 401 for r in old), sorted({(r['offer'], r['route'], r['status']) for r in old}))
    step.check('the current credential naming the old generation and its Pod is refused 403 MANAGED_RUNNER_INSTANCE_SUPERSEDED',
               naming_old and all(r['status'] == 403 and r['code'] == 'MANAGED_RUNNER_INSTANCE_SUPERSEDED' for r in naming_old),
               sorted({(r['route'], r['status'], r['code']) for r in naming_old}))
    step.check('the current credential as its own instance is accepted (a read only)', own and all(r['status'] == 200 for r in own), [r['status'] for r in own])
    return {'saved': {k: saved.get(k) for k in ('generation', 'podUid', 'tokenSha256Prefix')}, 'replay': replay}


def rejoin_writer(ctx, step):
    """The writer goes on from the first node while the old node is back: one writer, one client."""
    resumed = capture(sw.cmd_payload, action='start', run_id=WRITER_RUN, minimum_rows=0)
    first = writer_rows()
    time.sleep(30)
    second = writer_rows()
    view = placement(OWNER)
    step.check('the writer resumed on the existing data and keeps committing rows', resumed.get('resumedExistingData') and second > first, [first, second])
    check_placed(step, view, 1, 'while the writer goes on')
    return {'resumed': resumed, 'rows': [first, second], 'placement': view, 'blocklist': sw.ceph('ceph osd blocklist ls 2>&1')[0]}


def node_plugin_ready(node):
    pods = kjson('get', 'pods', namespace=ENV['LAB_CSI_NAMESPACE'])['items']
    return any(p['spec'].get('nodeName') == NODES[node] and any(o.get('kind') == 'DaemonSet' for o in p['metadata'].get('ownerReferences', []))
               and any(c['type'] == 'Ready' and c['status'] == 'True' for c in p['status'].get('conditions', [])) for p in pods)


def rejoin_release(ctx, step):
    """The rejoin policy: the stale Pod and attachment are gone and the node maps nothing, so the taint comes off."""
    plugin_before = node_plugin_ready(2)
    k('taint', 'node', NODES[2], f'{OUT_OF_SERVICE}-', namespace=None)
    released_at = now()
    deadline = time.monotonic() + 300
    while not node_plugin_ready(2):
        if time.monotonic() > deadline:
            raise Failed(f'no ready Ceph-CSI node plugin on {NODES[2]} within 300 s of the taint\'s removal')
        time.sleep(3)
    plugin_at = now()
    status = subprocess.run(['bash', str(LAB / 'status.sh')], capture_output=True, text=True)
    node = node_view(2)
    step.check('the second node is Ready, schedulable and untainted', node['ready'] == 'True' and not node['unschedulable'] and not node['taints'], node)
    step.check('the Ceph-CSI node plugin runs on it again', node_plugin_ready(2))
    time.sleep(20)
    m = mapping(OWNER)
    view = placement(OWNER)
    step.check('the runner did not move: the same Pod on the first node', m['pod_uid'] == ctx['identity'][OWNER]['podUid'], m['pod_uid'])
    check_placed(step, view, 1, 'with the old node rejoined')
    quiesced = capture(sw.cmd_payload, action='quiesce', run_id=WRITER_RUN, minimum_rows=0)
    step.check('the writer quiesced: integrity_check ok', quiesced['snapshot']['sqliteIntegrity'] == ['ok'], quiesced['snapshot']['sqliteIntegrity'])
    return {'releasedAt': released_at, 'nodePluginReadyBefore': plugin_before, 'nodePluginReadyAt': plugin_at,
            'status': {'exit': status.returncode, 'lines': status.stdout.strip().splitlines()[-14:]}, 'node': node, 'placement': view,
            'writerQuiesced': quiesced['snapshot'], 'memory': memory('second node rejoined')}


# ---- final -----------------------------------------------------------------------------------------------------------

def final_checks(ctx, step):
    view = ml.verdict()
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    timeline = [json.loads(line) for line in (SERVER / 'timeline.jsonl').read_text().splitlines() if line.startswith('{')]
    claim = ctx['identity'][OWNER]['pvcName']
    pv = ctx['identity'][OWNER]['pvName']
    most_pods = max((len((line.get('podsByClaim') or {}).get(claim, [])) for line in timeline), default=0)
    most_attachments = max((len((line.get('attachmentsByPv') or {}).get(pv, [])) for line in timeline), default=0)
    step.check('never more than one Pod on the runner\'s claim in the whole timeline', most_pods <= 1, most_pods)
    step.check('never more than one VolumeAttachment of its PV in the whole timeline', most_attachments <= 1, most_attachments)
    deadline, health = time.monotonic() + 720, None
    while time.monotonic() < deadline:
        health = ceph_json('ceph -s -f json')
        if health.get('health', {}).get('status') == 'HEALTH_OK':
            break
        time.sleep(20)
    detail = sw.ceph('ceph health detail')[0]
    step.check('Ceph is HEALTH_OK at the end', health.get('health', {}).get('status') == 'HEALTH_OK', detail[-400:])
    asleep = al.ensure_asleep(OWNER)
    end = placement(OWNER)
    check_released(step, end, 'ann asleep at the end')
    step.check('the claim is the one made at the first provisioning', identity(OWNER)['pvcUid'] == ctx['identity'][OWNER]['pvcUid'])
    return {'verdict': view, 'mostPodsOnTheClaim': most_pods, 'mostAttachments': most_attachments, 'timelineLines': len(timeline),
            'ceph': {'health': health.get('health'), 'osdmap': health.get('osdmap'), 'pgmap': {k: (health.get('pgmap') or {}).get(k) for k in ('pgs_by_state', 'num_pgs')},
                     'detail': detail}, 'asleep': asleep, 'placement': end, 'gate': al.gate_summary(ctx['firstSignInAt']),
            'pool': wl.sql_json('select * from managed_runner_capacity'), 'nodes': {NODES[n]: node_view(n) for n in (1, 2)}}


def teardown(ctx, step):
    results = {'recorder': record('stop'), 'admission': capture(sw.cmd_admission, action='remove')}
    results['server'] = al.server('stop')
    results['gate'] = capture(ml.cmd_gate, action='stop', since=None)
    step.check('the webhook is removed', sw.webhook_view() is None)
    return results


# ---- the recorder ------------------------------------------------------------------------------------------------------

def record_line():
    line = al.record_line()
    attachments_by_pv = {}
    for va in kjson('get', 'volumeattachments', namespace=None)['items']:
        attachments_by_pv.setdefault(va['spec']['source'].get('persistentVolumeName', '?'), []).append(va['spec']['nodeName'])
    line['attachmentsByPv'] = attachments_by_pv
    line['nodes'] = {n['metadata']['name']: next((c['status'] for c in n['status']['conditions'] if c['type'] == 'Ready'), None)
                     for n in kjson('get', 'nodes', namespace=None)['items']}
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
            al.run(['systemd-run', f'--unit={RECORDER_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=256M',
                    '-p', f'Environment=LAB_TEST_SERVER_DIR={SERVER}', '-p', f'StandardOutput=append:{log}', '-p', f'StandardError=append:{log}',
                    sys.executable, '-I', str(Path(__file__)), 'record-loop', '21600'])
    else:
        ml.systemd('stop', RECORDER_UNIT, check=False)
    return {'at': now(), 'unit': ml.active(RECORDER_UNIT), 'log': str(log), 'lines': len(log.read_text().splitlines()) if log.exists() else 0}


# ---- the run ------------------------------------------------------------------------------------------------------------

def phases():
    return [
        ('facts', [('git', facts_git), ('host', facts_host), ('cluster', facts_cluster), ('ceph', facts_ceph), ('image', facts_image)]),
        ('setup', [('server-dir', al.setup_server_dir), ('admin', setup_admin)]),
        ('on', [('prepare', on_prepare), ('start', on_start), ('admission', on_admission)]),
        ('account', [('ready', account_ready), ('data', account_data)]),
        ('migrate', [('sleep', migrate_sleep), ('move', migrate_move)]),
        ('duplicate', [('writer', writer_start), ('guard', duplicate_guard), ('rwo', duplicate_rwo), ('rbd', duplicate_rbd)]),
        ('takeover', [('prepare', takeover_prepare), ('cut', takeover_cut), ('heartbeat-loss', takeover_heartbeat_loss), ('fence', takeover_fence),
                      ('data', takeover_data)]),
        ('rejoin', [('start', rejoin_start), ('credentials', rejoin_credentials), ('writer', rejoin_writer), ('release', rejoin_release)]),
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
    """The run's steps (time, checks) and the intervals the lab page quotes, from its records only."""
    out = Path(args.out)
    steps = [json.loads(line) for line in (out / 'steps.jsonl').read_text().splitlines()]
    records = {}
    for path in sorted((out / 'records').glob('[0-9]*.json')):
        record_ = json.loads(path.read_text())
        records[f"{record_['phase']}/{record_['step']}"] = record_
    get = lambda key: (records.get(key) or {}).get('result') or {}
    measures = {}
    for name, function in {
        'sleepToAsleep': lambda: get('migrate/sleep')['sleepToAsleepSeconds'],
        'moveMessageToPodCreated': lambda: get('migrate/move')['messageToPodCreatedSeconds'],
        'moveMessageToAnswered': lambda: get('migrate/move')['answeredAfterSeconds'],
        'moveMessageToReady': lambda: get('migrate/move')['messageToReadySeconds'],
        'nodeUnknownAfterCut': lambda: get('takeover/heartbeat-loss')['firstUnknownSeconds'],
        'podEvictedAfterCut': lambda: get('takeover/heartbeat-loss')['firstEvictedSeconds'],
        'unusableAfterCut': lambda: get('takeover/heartbeat-loss')['firstUnusableSeconds'],
        'failover': lambda: get('takeover/fence')['seconds'],
        'lossMessageAnsweredAfter': lambda: get('takeover/data')['answeredAfterLossSeconds'],
        'oldNodeBootToReady': lambda: get('rejoin/start')['bootToReadySeconds'],
    }.items():
        try:
            measures[name] = function()
        except (KeyError, TypeError, IndexError, ValueError) as error:
            measures[name] = f'unavailable: {type(error).__name__} {error}'
    print(json.dumps({'steps': len(steps), 'checks': sum(line['checks'] for line in steps), 'failedSteps': [f"{l['phase']}/{l['step']}" for l in steps if not l['ok']],
                      'from': steps[0]['startedAt'], 'to': max(r['endedAt'] for r in records.values()) if records else None,
                      'phaseSeconds': {phase: round(sum(l['seconds'] for l in steps if l['phase'] == phase), 1) for phase in dict.fromkeys(l['phase'] for l in steps)},
                      'measures': measures}, indent=1))


def cmd_secret_scan(args):
    """acceptance-lab.py's scan, with the runner credentials this run saved (state/credentials) among what it looks for."""
    extra = {}
    for path in sorted((STATE / 'credentials').rglob('*.json')) if (STATE / 'credentials').exists() else []:
        token = json.loads(path.read_text()).get('token')
        if isinstance(token, str) and len(token) >= 8:
            extra[f'credential {path.relative_to(STATE)}'] = token
    files = [p for arg in args.paths for p in ([Path(arg)] if Path(arg).is_file() else Path(arg).rglob('*')) if p.is_file()]
    hits = {name: [str(p) for p in files if value in p.read_bytes().decode(errors='replace')] for name, value in extra.items()}
    hits = {name: paths for name, paths in hits.items() if paths}
    print(json.dumps({'runnerCredentialsLookedFor': len(extra), 'runnerCredentialsFound': hits}, indent=1))
    try:
        al.cmd_secret_scan(args)
    finally:
        if hits:
            raise SystemExit(1)


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
    {'run': cmd_run, 'record-loop': cmd_record_loop, 'secret-scan': cmd_secret_scan, 'report': cmd_report}[args.command](args)


if __name__ == '__main__':
    main()
