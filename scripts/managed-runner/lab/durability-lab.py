#!/usr/bin/env python3
"""A managed runner's Git work and its engine's last turn through the power cut of its node, before and after the fix
(task T02c).

docs/managed-runner-lab.md, "Git work and engine sessions through a power cut (T02c)". One command runs every phase in
order and stops at the first check that fails; each step's result and wall-clock time are written to OUT. It is
takeover-lab.py (T02) for one account at a time, whose helpers it uses (and through them acceptance-lab.py's, T08),
through the test server's own manager, admission guard and fencing gate:

  facts    versions, both nodes, Ceph, both runner images in both VMs' containerd, the model
  stuck    T07's leftover Pod: whose it is (the database of T07's test server, read beforehand), the runbook's checks, and
           its stop-report finalizer off with the runbook's own patch
  timing   what Git's fsyncs and a syncfs cost on a volume of the runner class on the second node (git-commit-timing.py)
  setup    the gate, the lab CA and webhook token, the administrator signed up with the switch unset
  on       the profile pinned to the project line's image (before the fix), the apiserver with the switch on, the guard
  before   ann on that image, her runner on the second node: sessions s1 and s2 with a commit each by the engine. In the last
           seconds: an engine commit in a turn still running (s3, new), a runner commit and a runner merge (s2), an engine
           commit in a turn that then ends (s1, the last turn); the second node's power cut. What the cut left: a copy of
           the volume's snapshot, read before anything mounts the volume again. The runbook's failover; the session resumed;
           the second node back; ann asleep
  switch   the profile pinned to this branch's image, the apiserver restarted
  after    bob through the same, on that image
  final    consistency, one Pod per claim over the timeline, Ceph; both asleep, the window closed
  damaged  the volume the cut damaged before the fix, woken on this branch's final image: what the runner's start says of
           it, and the session refused with its reason instead of run in the broken repository
  again    a later change of the runner through the after run again (task D10), on its own after the others: the
           versions, what the last teardown stopped started again with this checkout's image pinned, the after run with
           a new account (LAB_T02C_AFTER_OWNER), what the runner says of its volume's syncs, the mid-turn commit kept,
           the final checks and the teardown

  durability-lab.py run --out DIR [--from PHASE | --from-step PHASE/STEP] [--to PHASE]
  durability-lab.py record-loop SECONDS        the recorder unit's loop (started by the run)
  durability-lab.py secret-scan PATH...        no credential of the run in these files
  durability-lab.py report OUT                 the steps' times and checks, and what the README quotes

LAB_TEST_SERVER_DIR must name test-server-t02c (or test-server-t02c-dev for trials). LAB_T02C_BEFORE_IMAGE and
LAB_T02C_AFTER_IMAGE name the two image archives (kit/build-image.sh). Two-node mode must be up (start.sh --nodes 2).
Every record is JSON and never holds a credential. Sessions run on fake-model.py as a DeepSeek-preset key, which is not a
model. Both VMs are one physical machine and one failure domain: nothing here is evidence of availability across machines.
"""

import argparse
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import traceback

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_cross_node', LAB / 'cross-node-lab.py')
cn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cn)
tl, al, wl, ml, sw = cn.tl, cn.al, cn.wl, cn.ml, cn.sw

SERVER, NAMESPACE, ENV, LAB_DIR, STATE, REPO = sw.SERVER, sw.NAMESPACE, sw.ENV, sw.LAB_DIR, sw.STATE, sw.REPO
OWN_SERVER_DIRS = ('test-server-t02c', 'test-server-t02c-dev')
# The helpers with this task's directory, accounts, probe and operator.
al.OWN_SERVER_DIRS = al.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.OWN_SERVER_DIRS = wl.OWN_SERVER_DIRS + OWN_SERVER_DIRS
wl.EMAIL = ml.EMAIL = 't02c-{}@lab.invalid'
wl.NAME_RE = re.compile(r't02c-([a-z0-9]+)@lab\.invalid')
wl.PROBE_ROOT = '/var/lib/orbit/home/t02c-probe'
al.CONTEXT = SERVER / 't02c-context.json'
tl.OPERATOR = 'T02c lab operator (task 34ieaGY94CxelffWA9q66)'
NODES = tl.NODES
RECORDER_UNIT = 'orbit-mr-lab-t02c-recorder'
EVIDENCE = 'docs/evidence/managed-runner-power-cut-durability/2026-10-19'
IMAGES = {'before': Path(os.environ.get('LAB_T02C_BEFORE_IMAGE', '/mnt/data/tmp/t02-cross-node/image/lab.oci.tar')),
          'after': Path(os.environ.get('LAB_T02C_AFTER_IMAGE', '/mnt/data/tmp/t02c/image/lab.oci.tar')),
          'final': Path(os.environ.get('LAB_T02C_FINAL_IMAGE', '/mnt/data/tmp/t02c/image-final/lab.oci.tar'))}
RUNS = {'before': os.environ.get('LAB_T02C_BEFORE_OWNER', 'ann'), 'after': os.environ.get('LAB_T02C_AFTER_OWNER', 'bob')}  # a run done again takes a new account
T07_POD = 'mr-01a14db1-e2b6-7199-8613-d95d4616d6a7'
T07_RECORD = Path(os.environ.get('LAB_T02C_T07_RECORD', '/mnt/data/tmp/t02c/t07-db/t07-ownership.txt'))
TIMING_KIT = REPO / EVIDENCE / 'kit/git-commit-timing.py'
HOLD_SECONDS = 60
Failed, Step, capture, k, kget, kjson, mapping, until, identity, now = (al.Failed, al.Step, al.capture, al.k, al.kget, al.kjson, al.mapping,
                                                                       al.until, al.identity, al.now)


def memory(label):
    result = subprocess.run([sys.executable, '-I', str(LAB / 'two-node.py'), 'memory', f't02c {label}'], capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'error': (result.stderr or result.stdout).strip()[-300:]}


tl.memory = memory  # takeover-lab.py's facts and rejoin sample memory under this task's label


def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t02c (or test-server-t02c-dev), not {SERVER}')


def marker(name, what):
    return f'T02C-{name.upper()}-{what}'


def stamp():
    return time.strftime('%H%M%S', time.gmtime())


def owner_of(run):
    """The account of a run, with the module globals takeover-lab.py's and single-writer.py's commands read set to it."""
    name = RUNS[run]
    tl.OWNER = name
    sw.OWNER, sw.CREDENTIALS = name, STATE / 'credentials' / name
    return name


# ---- what a volume holds: read in the runner's container, or in a copy of a snapshot ----------------------------------

READ = r'''
import json, os, subprocess, sys
from pathlib import Path
want = json.loads(sys.argv[1])
ROOT = Path(os.environ.get('T02C_VOLUME_ROOT', '/var/lib/orbit')); HOME = ROOT / 'home'; ORBIT = HOME / '.orbit'
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'HOME': '/tmp', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
def size(p):
    try: return p.stat().st_size
    except OSError: return None
def head(p, n=100):
    try: return p.read_bytes()[:n].decode(errors='replace')
    except OSError as e: return 'unreadable: ' + type(e).__name__
def dirs(checkout):
    dot = checkout / '.git'
    if dot.is_dir(): return dot, dot
    if not dot.exists(): return None, None
    line = head(dot, 400).strip()
    if not line.startswith('gitdir: '): return None, None
    gd = Path(line[8:]); cd = gd
    if (gd / 'commondir').exists():
        c = head(gd / 'commondir').strip()
        cd = Path(os.path.normpath(gd / c)) if c else gd
    return gd, cd
def git(gd, checkout, *a):
    r = subprocess.run(['git', '--git-dir=' + str(gd), '--work-tree=' + str(checkout), *a], capture_output=True, text=True, env=ENV)
    return {'exit': r.returncode, 'out': r.stdout.strip()[-1200:], 'err': r.stderr.strip()[-600:]}
def empties(base, skip_git):
    found = []
    for d, ds, fs in os.walk(base):
        if skip_git and '.git' in ds: ds.remove('.git')
        for f in fs:
            p = Path(d) / f
            if not p.is_symlink() and size(p) == 0: found.append(str(p.relative_to(base)))
    return sorted(found)
def repo(checkout):
    gd, cd = dirs(checkout)
    view = {'checkout': str(checkout), 'gitDir': str(gd) if gd else None}
    if gd is None: return view
    h = head(gd / 'HEAD').strip()
    view['headFile'] = {'bytes': size(gd / 'HEAD'), 'content': h}
    if h.startswith('ref: '):
        ref = h[5:]
        view['branch'] = {'ref': ref, 'looseBytes': size(cd / ref), 'loose': head(cd / ref).strip() if (cd / ref).exists() else None}
    view['revParseHead'] = git(gd, checkout, 'rev-parse', '--verify', 'HEAD^{tree}')
    view['fsck'] = git(gd, checkout, 'fsck', '--full', '--no-progress')
    view['log'] = git(gd, checkout, 'log', '-8', '--format=%H %s')
    view['status'] = git(gd, checkout, 'status', '--porcelain')
    view['indexBytes'] = size(gd / 'index')
    view['locks'] = sorted(str(p.relative_to(cd)) for p in cd.rglob('*.lock')) if cd.is_dir() else []
    view['emptyGitFiles'] = sorted(set(empties(cd, False)) | {'worktree/' + e for e in (empties(gd, False) if gd != cd else [])})
    view['emptyCheckoutFiles'] = empties(checkout, True)
    return view
out = {'kernel': os.uname().release, 'uid': os.getuid(),
       'git': subprocess.run(['git', '--version'], capture_output=True, text=True).stdout.strip()}
for line in Path('/proc/self/mountinfo').read_text().splitlines():
    f = line.split()
    if f[4] == '/var/lib/orbit':
        src = f[f.index('-') + 2]
        out['mount'] = {'source': src, 'fstype': f[f.index('-') + 1], 'options': f[5], 'superOptions': f[f.index('-') + 3]}
        opts = Path('/proc/fs/ext4') / os.path.basename(src) / 'options'
        out['ext4Options'] = opts.read_text().split() if opts.exists() else None
checkouts = {'workspace': HOME / 'orbit-repos/default'}
for session in want.get('sessions', []):
    checkouts[session] = ORBIT / 'worktrees' / session
out['repos'] = {label: repo(path) for label, path in checkouts.items()}
out['commits'] = {}
for c in want.get('commits', []):
    gd, _ = dirs(checkouts[c['repo']])
    if gd is None:
        out['commits'][c['label']] = {'sha': c['sha'], 'repoReadable': False}; continue
    typ = git(gd, checkouts[c['repo']], 'cat-file', '-t', c['sha'])
    on = git(gd, checkouts[c['repo']], 'merge-base', '--is-ancestor', c['sha'], c['ref'])
    out['commits'][c['label']] = {'sha': c['sha'], 'ref': c['ref'], 'object': typ['out'] if typ['exit'] == 0 else 'ERROR: ' + typ['err'][-160:],
                                  'onTheBranch': on['exit'] == 0, 'branchCheck': on['err'][-160:]}
out['transcripts'] = {}
projects = HOME / '.claude' / 'projects'
for p in sorted(projects.rglob('*.jsonl')) if projects.exists() else []:
    lines = p.read_bytes().splitlines()
    out['transcripts'][str(p.relative_to(HOME))] = {'lines': len(lines), 'bytes': size(p),
        'markers': {m: sum(1 for l in lines if m.encode() in l) for m in want.get('markers', [])}}
print(json.dumps(out, sort_keys=True))
'''


def read_in_runner(name, want):
    _, pod = ml.running_pod(name)
    return json.loads(sw.pod_exec(pod['metadata']['name'], 'python3', '-c', READ, json.dumps(want)).stdout)


def reader_pod(pod_name, claim, image, want):
    """A Pod of the runner image on the first node, as the runner's user, with CLAIM at the runner's path: READ's view."""
    pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod_name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02c'}},
           'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False, 'terminationGracePeriodSeconds': 5,
                    'affinity': tl.render.node_affinity(NODES[1]),
                    'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'fsGroup': 10001, 'runAsNonRoot': True,
                                        'seccompProfile': {'type': 'RuntimeDefault'}},
                    'containers': [{'name': 'read', 'image': image, 'command': ['python3', '-c', READ, json.dumps(want)],
                                    'env': [{'name': 'HOME', 'value': '/tmp'}],
                                    'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                                    'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                                    'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/orbit'}, {'name': 'tmp', 'mountPath': '/tmp'}]}],
                    'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}, {'name': 'tmp', 'emptyDir': {'sizeLimit': '128Mi'}}]}}
    k('create', '-f', '-', input=json.dumps(pod))
    deadline = time.monotonic() + 300
    while True:
        phase = (kget('pod', pod_name) or {}).get('status', {}).get('phase')
        if phase in ('Succeeded', 'Failed'):
            break
        if time.monotonic() > deadline:
            events = k('get', 'events', '--field-selector', f'involvedObject.name={pod_name}', '-o', 'json', check=False).stdout
            raise Failed(f'the reader Pod {pod_name} did not finish within 300 s: {events[-800:]}')
        time.sleep(2)
    logs = k('logs', pod_name, '-c', 'read').stdout
    k('delete', 'pod', pod_name, '--wait=true', '--timeout=120s')
    if phase != 'Succeeded':
        raise Failed(f'the reader Pod {pod_name} ended {phase}: {logs[-800:]}')
    return json.loads(logs.strip().splitlines()[-1])


def plain_claim(name, size='2Gi'):
    claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02c'}},
             'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': ENV['LAB_STORAGE_CLASS'], 'volumeMode': 'Filesystem',
                      'resources': {'requests': {'storage': size}}}}
    k('apply', '-f', '-', input=json.dumps(claim))
    k('wait', '--for=jsonpath={.status.phase}=Bound', f'pvc/{name}', '--timeout=300s')
    pv = kget('pv', kget('pvc', name)['spec']['volumeName'], namespace=None)
    return pv, f"{pv['spec']['csi']['volumeAttributes']['pool']}/{pv['spec']['csi']['volumeAttributes']['imageName']}"


def drop_claim(name, pv, image):
    k('delete', 'pvc', name, '--wait=true', '--timeout=120s')
    k('delete', 'pv', pv['metadata']['name'], '--wait=true', '--timeout=120s', namespace=None)
    # import-diff leaves the diff's end snapshot on the copy.
    al.ceph_shell(f'rbd snap purge --no-progress {shlex.quote(image)} && rbd rm --no-progress {shlex.quote(image)}')
    return image.split('/')[1] not in al.ceph_shell(f"rbd ls {shlex.quote(image.split('/')[0])}").split()


# ---- facts ----------------------------------------------------------------------------------------------------------

def import_image(archive):
    """An image archive (kit/build-image.sh) into both VMs' containerd under its digest; what each VM has."""
    tl.IMAGE_ARCHIVE = archive
    reference, index = tl.image_reference()
    archive_sha = al.sha256_file(archive)
    nodes = {}
    for node in (1, 2):
        before = tl.ssh_node(node, f'sudo k3s ctr -n k8s.io images ls -q | grep -F {sw.IMAGE_NAME} || true').stdout.split()
        seconds = None
        if reference not in before:
            remote = f'/var/tmp/orbit-runner-lab-image-{archive_sha[:12]}.tar'
            copy = subprocess.run(['scp', '-q', '-i', str(LAB_DIR / 'ssh/id_ed25519'), '-P', tl.SSH_PORTS[node], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                                   '-o', f"UserKnownHostsFile={LAB_DIR / 'ssh/known_hosts'}", '-o', 'LogLevel=ERROR',
                                   str(archive), f'ubuntu@127.0.0.1:{remote}'], capture_output=True, text=True)
            if copy.returncode:
                raise Failed(f'scp to VM {node}: {copy.stderr.strip()}')
            started = time.monotonic()
            tl.ssh_node(node, f'sudo k3s ctr -n k8s.io images import --digests --base-name {sw.IMAGE_NAME} {remote} && sudo rm -f {remote}', timeout=600)
            seconds = round(time.monotonic() - started, 1)
            tl.ssh_node(node, 'sudo /opt/orbit-lab/provision.sh trim', check=False, timeout=120)
        inspect = json.loads(tl.ssh_node(node, f'sudo k3s crictl inspecti -o json {shlex.quote(reference)}').stdout)['status']
        nodes[NODES[node]] = {'importSeconds': seconds, 'alreadyThere': seconds is None, 'id': inspect.get('id'), 'size': inspect.get('size')}
    source = (archive.parent / 'source-sha').read_text().strip()
    return {'reference': reference, 'archive': str(archive), 'archiveSha256': archive_sha, 'source': source,
            'labManifest': index['manifests'][0]['digest'], 'nodes': nodes, 'pushed': False}


def facts_images(ctx, step):
    results = {}
    for run, archive in IMAGES.items():
        view = import_image(archive)
        ids = {n['id'] for n in view['nodes'].values()}
        step.check(f'the {run} image is in both VMs\' containerd under one digest reference and ID', len(ids) == 1 and None not in ids, view['nodes'])
        results[run] = view
    # The image before the fix runs the project line's runner; the one after runs this commit's.
    line = al.run(['git', '-C', str(REPO), 'rev-parse', 'origin/project/34ZteKCnYMpKY46f63Leb']).stdout.strip()
    before = al.git('diff', '--stat', results['before']['source'], line, '--', 'src/runner-go', 'deploy/managed-runner/image')
    after = al.git('diff', '--stat', results['after']['source'], 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image')
    step.check('the before image\'s runner and image sources are the project line\'s', before == '', before or '(no difference)')
    step.check('the after image\'s runner and image sources are this checkout\'s', after == '', after or '(no difference)')
    step.check('the two images differ', results['before']['reference'] != results['after']['reference'])
    ctx['images'] = {run: view['reference'] for run, view in results.items()}
    ctx['image'] = ctx['images']['before']
    results['projectLine'] = line
    return results


def facts_model(ctx, step):
    return cn.facts_model(ctx, step)


# ---- T07's leftover Pod ---------------------------------------------------------------------------------------------

def stuck_pod(ctx, step):
    """T07's leftover Pod: the runbook's three questions, whose it is, then its finalizer off with the runbook's patch."""
    pod = kget('pod', T07_POD)
    if pod is None:
        step.check('T07\'s Pod is already gone', True)
        return {'pod': None}
    runner = T07_POD[3:]
    statuses = (pod['status'].get('initContainerStatuses') or []) + (pod['status'].get('containerStatuses') or [])
    conditions = {c['type']: {k_: c.get(k_) for k_ in ('status', 'reason', 'lastTransitionTime')} for c in pod['status'].get('conditions', [])}
    node = tl.node_view(1 if pod['spec'].get('nodeName') == NODES[1] else 2)
    pv = (kget('pvc', f'mr-data-{runner}') or {}).get('spec', {}).get('volumeName')
    attached = tl.attachments(pv) if pv else []
    record = T07_RECORD.read_text() if T07_RECORD.exists() else ''
    view = {'name': T07_POD, 'uid': pod['metadata']['uid'], 'node': pod['spec'].get('nodeName'), 'phase': pod['status'].get('phase'),
            'deletionTimestamp': pod['metadata'].get('deletionTimestamp'), 'finalizers': pod['metadata'].get('finalizers'),
            'annotations': {k_: v for k_, v in (pod['metadata'].get('annotations') or {}).items() if k_.startswith('orbit.dev/')},
            'created': pod['metadata']['creationTimestamp'], 'containers': [{'name': s['name'], 'terminated': (s.get('state') or {}).get('terminated')} for s in statuses],
            'conditions': conditions, 'nodeView': node, 'pv': pv, 'volumeAttachments': attached,
            'apiUnits': {unit: ml.active(unit) for unit in al.API_UNITS}, 't07Database': record.splitlines()}
    step.check('T07\'s test server database names this runner and this Pod (its UID) as its own',
               runner in record and pod['metadata']['uid'] in record and 't06-root@lab.invalid' in record, record.splitlines()[-6:])
    step.check('no manager runs: the lab\'s apiserver units are stopped', all(state != 'active' for state in view['apiUnits'].values()), view['apiUnits'])
    step.check('its kubelet reported the stop: Failed, every container terminated', view['phase'] == 'Failed' and statuses
               and all((s.get('state') or {}).get('terminated') for s in statuses), [view['phase'], view['containers']])
    step.check('its node is Ready', (node or {}).get('ready') == 'True', node)
    step.check('the control plane did not mark it terminal for an unreachable node (no PodGC or taint-manager DisruptionTarget)',
               (conditions.get('DisruptionTarget') or {}).get('reason') not in ('DeletionByPodGC', 'DeletionByTaintManager'), conditions.get('DisruptionTarget'))
    step.check('its volume is attached nowhere', not attached, attached)
    patch = cn.runbook_bash('the runbook\'s finalizer patch for T07\'s Pod', cn.runbook_block('The stop-report finalizer', 'UID_='), R=runner)
    step.check('the runbook\'s patch ran', patch['exit'] == 0, patch['stderr'] or patch['stdout'])
    deadline = time.monotonic() + 120
    while kget('pod', T07_POD) is not None and time.monotonic() < deadline:
        time.sleep(2)
    gone = kget('pod', T07_POD) is None
    step.check('T07\'s Pod is gone', gone)
    return {'pod': view, 'patch': patch, 'goneAt': now() if gone else None}


# ---- what Git's fsyncs and a syncfs cost on the runner class's storage ----------------------------------------------------

def timing(ctx, step):
    """git-commit-timing.py in a Pod of the runner image on the second node, on a claim of the runner class."""
    name = f't02c-timing-{stamp()}'
    pv, image = plain_claim(name)
    pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02c'}},
           'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False, 'terminationGracePeriodSeconds': 5,
                    'affinity': tl.render.node_affinity(NODES[2]),
                    'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'fsGroup': 10001, 'runAsNonRoot': True,
                                        'seccompProfile': {'type': 'RuntimeDefault'}},
                    'containers': [{'name': 'git', 'image': ctx['images']['after'], 'command': ['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'],
                                    'env': [{'name': 'HOME', 'value': '/tmp'}],
                                    'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                                    'resources': {'requests': {'cpu': '250m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                                    'volumeMounts': [{'name': 'data', 'mountPath': '/data'}, {'name': 'tmp', 'mountPath': '/tmp'}]}],
                    'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': name}}, {'name': 'tmp', 'emptyDir': {'sizeLimit': '64Mi'}}]}}
    k('create', '-f', '-', input=json.dumps(pod))
    k('wait', '--for=condition=Ready', f'pod/{name}', '--timeout=300s')
    started = time.monotonic()
    result = k('exec', '-i', name, '--', 'python3', '-', '/data/timing', '/tmp/timing.json', '--rounds', '20', input=TIMING_KIT.read_text(), check=False)
    record = json.loads(k('exec', name, '--', 'cat', '/tmp/timing.json').stdout) if result.returncode == 0 else None
    mount = k('exec', name, '--', 'sh', '-c', 'grep " /data " /proc/self/mountinfo; cat /proc/fs/ext4/$(basename $(awk \'$5 == "/data" {print $(NF-1)}\' /proc/self/mountinfo))/options 2>/dev/null | tr "\\n" " "',
              check=False).stdout.strip()
    k('delete', 'pod', name, '--wait=true', '--timeout=120s')
    removed = drop_claim(name, pv, image)
    step.check('the timings ran to the end', result.returncode == 0 and record is not None, (result.stderr or '')[-400:])
    step.check('the scratch claim, its PV and image are gone', removed)
    return {'node': NODES[2], 'seconds': round(time.monotonic() - started, 1), 'mount': mount, 'record': record, 'printed': result.stdout.splitlines()}


# ---- one run: an account's runner on the second node, the last seconds, the cut, what it left, the failover ---------------

def run_ready(run):
    def step_fn(ctx, step):
        name = owner_of(run)
        if run == 'after':
            switched = ctx.get('switched')
            step.check('the profile pins the after image', switched == ctx['images']['after'], switched)
        cordoned = [tl.cordon(2, 'uncordon'), tl.cordon(1, 'cordon')]  # the runner on the second node, which loses power
        since = now()
        signed = al.account(name)
        starting = until(name, 'STARTING', reason='MODEL_UNAVAILABLE', timeout=300)
        key = capture(wl.cmd_key, name=name)
        ready = until(name, 'READY', timeout=420)
        ident = identity(name)
        ctx.setdefault('identity', {})[name] = ident
        ctx.setdefault('firstSignInAt', since)
        view = tl.placement(name)
        tl.check_placed(step, view, 2, f'{name}, generation {view["generation"]}')
        images = pod_images(name)
        step.check(f'{name}: the runner runs the {run} image', images and images['spec'] == [ctx['images'][run]], images)
        cordoned.append(tl.cordon(1, 'uncordon'))  # the first node takes the next generation after the cut
        return {'cordoned': cordoned, 'signIn': signed, 'starting': starting, 'key': key, 'ready': ready, 'identity': ident, 'placement': view,
                'images': images, 'times': al.provisioned(name)}
    return step_fn


def pod_images(name):
    pod = kget('pod', f"mr-{mapping(name)['runner_id']}")
    return pod and {'uid': pod['metadata']['uid'], 'spec': sorted({c['image'] for c in pod['spec'].get('initContainers', []) + pod['spec']['containers']})}


def new_session(name, prompt):
    created = wl.new_session(name, prompt)
    if created['status'] not in (200, 201):
        raise Failed(f'{name}: session create {created["status"]} {created["answer"]}')
    return created['answer']['id'], wl.to_uuid(created['answer']['id']), created['at']


def wrote(owner, session_uuid, word, timeout=240, after=None):
    """The engine's FAKE-WRITE result in a session: the commit and the file's hash it printed, from the run event."""
    tag = f'T08-WROTE-{word.upper()}'
    found = al.wait_text(owner, tag, timeout=timeout, after=after, event_type='tool_result', session=session_uuid)
    text = wl.sql_json(f"select payload::text as p from run_event where session_id = {wl.quote(session_uuid)} and type = 'tool_result' "
                       f"and payload::text like {wl.quote('%' + tag + '%')} order by seq desc limit 1")[0]['p']
    match = re.search(rf'{tag} ([0-9a-f]{{40}}) ([0-9a-f]{{16}})', text)
    return {'commit': match and match.group(1), 'fileSha256Prefix': match and match.group(2), 'file': f't08-{word}.txt',
            'ingestedAt': found['event']['ingested_at']}


def run_sessions(run):
    def step_fn(ctx, step):
        name = owner_of(run)
        owner = al.owner_uuid(name)
        sessions = {}
        for label in ('s1', 's2'):
            word = f'{name}{label}'
            sid, suuid, at = new_session(name, f"{marker(name, label.upper())} a session. T03-SECRET {name}{label} FAKE-WRITE {word}")
            sessions[label] = {'id': sid, 'uuid': suuid, 'createdAt': at, 'wrote': wrote(owner, suuid, word)}
            # The engine's own session id names its transcript (Claude Code: <id>.jsonl).
            sessions[label]['runtimeSessionId'] = wl.sql_json(f"select runtime_session_id from session where id = {wl.quote(suuid)}")[0]['runtime_session_id']
            step.check(f'{name} {label}: the engine committed a file in the session\'s worktree', bool(sessions[label]['wrote']['commit']), sessions[label]['wrote'])
        # Uncommitted work in s2's worktree, as an engine leaves it: the runner's commit takes it.
        _, pod = ml.running_pod(name)
        path = f"/var/lib/orbit/home/.orbit/worktrees/{sessions['s2']['uuid']}/t02c-runner-{name}.txt"
        sw.pod_exec(pod['metadata']['name'], 'sh', '-c', f'printf "T02c: committed by the runner for {name}\\n" > {shlex.quote(path)}')
        sessions['s2']['uncommitted'] = path
        with cn.as_owner(name):
            credential = capture(sw.cmd_credential, action='save')
        m = mapping(name)
        step.check(f'{name}: the saved credential is this generation\'s', credential['generation'] == m['generation'] and credential['podUid'] == m['pod_uid'],
                   {k_: credential[k_] for k_ in ('generation', 'podUid')})
        ctx.setdefault('runs', {})[run] = {'name': name, 'sessions': sessions}
        view = read_in_runner(name, {'sessions': [sessions['s1']['uuid'], sessions['s2']['uuid']]})
        for label, repo in view['repos'].items():
            step.check(f'{name} {label}: the repository reads and git fsck is clean before the last seconds', repo['revParseHead']['exit'] == 0
                       and repo['fsck']['exit'] == 0, {k_: repo[k_] for k_ in ('revParseHead', 'fsck')})
        return {'sessions': sessions, 'credential': {k_: credential[k_] for k_ in ('generation', 'podUid', 'tokenSha256Prefix')}, 'volume': view}
    return step_fn


def poll(predicate, timeout, label, every=0.2):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() > deadline:
            raise Failed(f'{label}: not within {timeout} s')
        time.sleep(every)


def fake_model_line(needle, kind):
    log = SERVER / 'logs/fake-model.jsonl'
    for line in reversed(log.read_text().splitlines() if log.exists() else []):
        if needle in line and f'"kind": "{kind}"' in line:
            return json.loads(line)
    return None


def turn_answered(session_uuid, seq):
    """The control plane's word that a turn is over: its conversation_turn ANSWERED (the runner's /turn-complete)."""
    rows = wl.sql_json(f"select status, answered_at from conversation_turn where session_id = {wl.quote(session_uuid)} and seq = {int(seq)}")
    return rows[0] if rows and rows[0]['status'] == 'ANSWERED' else None


def run_last(run):
    def step_fn(ctx, step):
        """The last seconds before the cut: everything older made durable first, then the Git work under test."""
        name = owner_of(run)
        owner = al.owner_uuid(name)
        r = ctx['runs'][run]
        s1, s2 = r['sessions']['s1'], r['sessions']['s2']
        _, pod = ml.running_pod(name)
        times = {}
        # What came before the last seconds is on the disk: only these seconds are under test.
        times['settleSyncStarted'] = now()
        settled = sw.pod_exec(pod['metadata']['name'], 'sync', '-f', '/var/lib/orbit')
        times['settleSyncEnded'] = now()
        step.check('the volume was synced before the last seconds', settled.returncode == 0)
        before_last = read_in_runner(name, {'sessions': [s1['uuid'], s2['uuid']], 'markers': [marker(name, 'LAST')]})
        # s3, new: its runner makes the checkout, its engine commits, and the answer to that commit is held: the turn is in
        # flight at the cut.
        held_word = f'{name}held'
        times['s3Sent'] = now()
        s3_id, s3_uuid, _ = new_session(name, f"{marker(name, 'HOLD')} a turn still running at the cut. FAKE-WRITE {held_word} FAKE-HOLD {HOLD_SECONDS}")
        held = poll(lambda: fake_model_line(f'T08-WROTE-{held_word.upper()}', 'tool_result_reply'), 240, 's3: the engine\'s commit')
        times['s3EngineCommitSeen'] = now()
        held_commit = re.search(r'T08-WROTE-\w+ ([0-9a-f]{40})', held['toolResult'] or '')
        # s2: the runner commits the uncommitted file, then merges the branch into the workspace's checkout; s1: the last
        # turn, whose engine commits and answers. The cut follows the last of them.
        times['s2CommitAsked'] = now()
        code, answer = ml.http('POST', f"/sessions/{s2['id']}/commit", {}, token=al.token(name))
        step.check('s2: the runner was asked to commit', code in (200, 201), [code, answer])
        committed = poll(lambda: (lambda row: row if row and row['commit_status'] not in ('pending', None) else None)(
            wl.sql_json(f"select commit_status, commit_result_message from session where id = {wl.quote(s2['uuid'])}")[0]), 180, 's2: the runner\'s commit')
        times['s2CommitReported'] = now()
        if committed['commit_status'] != 'committed':  # nothing is cut for a run whose work did not happen
            raise Failed(f's2: the runner did not commit: {committed}')
        step.check('s2: the runner committed', committed['commit_status'] == 'committed', committed)
        last_word = f'{name}last'
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            times['s2MergeAsked'] = now()
            merging = pool.submit(ml.http, 'POST', f"/sessions/{s2['id']}/merge", {'waitSeconds': 120}, al.token(name), None, None, 150)
            times['s1LastSent'] = now()
            turn = wl.new_turn(name, s1['id'], f"{marker(name, 'LAST')} the last turn before the power cut. T03-SECRET {name}last FAKE-WRITE {last_word}")
            if turn['status'] not in (200, 201) or not isinstance((turn['answer'] or {}).get('seq'), int):
                raise Failed(f's1: the last turn was not accepted: {turn}')
            answered = poll(lambda: turn_answered(s1['uuid'], turn['answer']['seq']), 180, 's1: the last turn\'s answer')
            times['s1LastAnswered'] = now()
            merge_code, merge = merging.result()
            times['s2MergeReturned'] = now()
        if merge_code not in (200, 201) or (merge or {}).get('mergeStatus') != 'merged':
            raise Failed(f's2: the runner did not merge, so nothing is cut: {merge_code} {merge}')
        # The cut.
        cut = al.run([str(LAB / 'stop.sh'), '--node', '2', '--hard'])
        said = cut.stdout + cut.stderr
        killed = re.search(r'killed with SIGKILL at (\S+);', said)
        killed_at = killed.group(1).replace('Z', '+00:00') if killed else now()
        step.check('stop.sh killed the second VM\'s qemu with SIGKILL', bool(killed), said.strip()[-400:])
        power = tl.power_state(2)
        step.check('the second VM is off: its unit inactive, no qemu process, SSH and QMP refused, the link down',
                   power['activeState'] in ('inactive', 'failed') and not power['qemuProcesses'] and power['sshRefused'] and power['qmpRefused']
                   and not power['linkConnections'], power)
        step.check('s2: the runner merged', merge_code in (200, 201) and (merge or {}).get('mergeStatus') == 'merged', [merge_code, merge])
        s1_wrote = wrote(owner, s1['uuid'], last_word, timeout=30)
        receipt = (merge or {}).get('receipt') or {}
        r.update(s3={'id': s3_id, 'uuid': s3_uuid, 'commit': held_commit and held_commit.group(1)}, lastTurn={'turn': turn, 'answered': answered, 'wrote': s1_wrote},
                 merge={'status': merge_code, 'answer': merge}, commit=committed, times=times, killedAt=killed_at)
        m = mapping(name)
        ctx['takeover'] = {'generation': m['generation'], 'podUid': m['pod_uid'], 'podName': m['pod_name'], 'nodeName': m['node_name'],
                           'killedAt': killed_at}
        seconds = {label: al.seconds_between(at, killed_at) for label, at in times.items()}
        engine_commit = s1_wrote['ingestedAt'] and al.seconds_between(s1_wrote['ingestedAt'], killed_at)
        within = {'s1 engine commit (its result ingested)': engine_commit, 's1 last turn answered': seconds['s1LastAnswered'],
                  's2 runner merge returned': seconds['s2MergeReturned'], 's2 runner commit reported': seconds['s2CommitReported'],
                  's3 engine commit seen (turn still running)': seconds['s3EngineCommitSeen']}
        return {'times': times, 'secondsBeforeTheCut': seconds, 'withinTwoSecondsOfTheCut': {k_: v is not None and v <= 2 for k_, v in within.items()},
                'secondsOfEachBeforeTheCut': within, 'stopSh': said.strip().splitlines(), 'killedAt': killed_at, 'power': power,
                's3': {'id': s3_id, 'uuid': s3_uuid, 'fakeModel': held, 'commit': held_commit and held_commit.group(1)},
                's2': {'commit': committed, 'merge': {'status': merge_code, 'answer': merge}, 'targetShaAfter': receipt.get('targetShaAfter'),
                       'sourceSha': receipt.get('sourceSha')},
                's1': {'turn': turn, 'answered': answered, 'wrote': s1_wrote}, 'volumeBeforeTheLastSeconds': before_last}
    return step_fn


def expected_view(ctx, run, name):
    """What READ is asked: the three sessions' checkouts, the commits that had returned (and s3's, still running), the markers."""
    r = ctx['runs'][run]
    s = r['sessions']
    merge = ((r['merge']['answer'] or {}).get('receipt') or {})
    commits = [{'label': 's1 first engine commit', 'sha': s['s1']['wrote']['commit'], 'repo': s['s1']['uuid'], 'ref': 'HEAD'},
               {'label': 's1 last engine commit (returned: the turn ended)', 'sha': r['lastTurn']['wrote']['commit'], 'repo': s['s1']['uuid'], 'ref': 'HEAD'},
               {'label': 's2 engine commit', 'sha': s['s2']['wrote']['commit'], 'repo': s['s2']['uuid'], 'ref': 'HEAD'}]
    if merge.get('sourceSha'):
        commits.append({'label': 's2 runner commit (returned: the merge took it)', 'sha': merge['sourceSha'], 'repo': s['s2']['uuid'], 'ref': 'HEAD'})
    landed = merge.get('targetShaAfter')
    if landed:
        commits.append({'label': 'runner merge into the workspace (returned)', 'sha': landed, 'repo': 'workspace', 'ref': 'HEAD'})
    if r['s3'].get('commit'):
        commits.append({'label': 's3 engine commit (its turn still running)', 'sha': r['s3']['commit'], 'repo': r['s3']['uuid'], 'ref': 'HEAD'})
    return {'sessions': [s['s1']['uuid'], s['s2']['uuid'], r['s3']['uuid']], 'commits': [c for c in commits if c['sha']],
            'transcript': s['s1']['runtimeSessionId'],
            'markers': [marker(name, 'S1'), marker(name, 'LAST'), f'T08-WROTE-{name.upper()}LAST', f'tool result received: T08-WROTE-{name.upper()}LAST']}


def judge_left(step, run, name, view, transcript_id):
    """READ's view of what the cut left: for the run after the fix, what must hold; for the one before, recorded.
    transcript_id is the engine's session id of s1, which names its transcript."""
    repos = view['repos']
    unreadable = sorted(label for label, repo in repos.items() if repo.get('gitDir') is None or repo['revParseHead']['exit'] != 0)
    fsck_bad = sorted(label for label, repo in repos.items() if repo.get('gitDir') and repo['fsck']['exit'] != 0)
    commits = view['commits']
    returned = {label: c for label, c in commits.items() if 'still running' not in label}
    lost = sorted(label for label, c in returned.items() if not c.get('onTheBranch'))
    transcript = next((t for path, t in view['transcripts'].items() if transcript_id and transcript_id in path), {'markers': {}})
    last_turn = {'message': transcript['markers'].get(marker(name, 'LAST'), 0),
                 'answer': transcript['markers'].get(f'tool result received: T08-WROTE-{name.upper()}LAST', 0)}
    summary = {'unreadable': unreadable, 'fsckErrors': fsck_bad, 'returnedCommitsMissing': lost, 'lastTurnInTheTranscript': last_turn,
               'emptyGitFiles': {label: repo.get('emptyGitFiles') for label, repo in repos.items() if repo.get('emptyGitFiles')},
               'locks': {label: repo.get('locks') for label, repo in repos.items() if repo.get('locks')},
               's3': {label: c for label, c in commits.items() if 'still running' in label}}
    if run == 'after':
        step.check(f'{name}: every repository reads: HEAD and its branch valid', not unreadable, {l: repos[l].get('revParseHead') for l in unreadable})
        step.check(f'{name}: git fsck finds no error in any of them', not fsck_bad, {l: repos[l]['fsck'] for l in fsck_bad})
        step.check(f'{name}: every commit that had returned is there, on its branch', not lost, {l: returned[l] for l in lost})
        step.check(f'{name}: the last turn, its message and its final answer, is in the engine\'s transcript', last_turn['message'] >= 1
                   and last_turn['answer'] >= 1, transcript['markers'])
    else:
        step.check(f'{name}: the cut left damage of the kind T02 and T08x found (a repository unreadable or failing fsck, a returned commit '
                   'missing, or the last turn missing from the transcript)', unreadable or fsck_bad or lost or not last_turn['answer'], summary)
    return summary


def run_left(run):
    def step_fn(ctx, step):
        """What the cut left: a snapshot of the volume's image taken while nothing maps it, copied into a new claim and read on
        the first node before the runner's next generation has mounted the volume."""
        name = owner_of(run)
        ident = identity(name)
        pool, source = ident['pool'], ident['rbdImage']
        snap = f't02c-{run}-cut'
        listed = json.loads(al.ceph_shell(f'rbd snap ls --format json {pool}/{source}') or '[]')
        if not any(s['name'] == snap for s in listed):  # a step done again reads the snapshot its first attempt took
            al.ceph_shell(f'rbd snap create --no-progress {pool}/{source}@{snap}')
        taken = json.loads(al.ceph_shell(f'rbd snap ls --format json {pool}/{source}'))
        snapped_at = next(s['timestamp'] for s in taken if s['name'] == snap)
        claim = f't02c-{run}-cut-{stamp()}'
        pv, target = plain_claim(claim)
        copied = al.ceph_shell(f'set -o pipefail; rbd export-diff --no-progress {pool}/{source}@{snap} - | rbd import-diff --no-progress - {target} && '
                               f'rbd info --format json {target}')
        want = expected_view(ctx, run, name)
        view = reader_pod(f'{claim}-read', claim, ctx['images'][run], want)
        removed = drop_claim(claim, pv, target)
        dropped = al.ceph_shell(f'rbd snap rm --no-progress {pool}/{source}@{snap} && rbd snap ls --format json {pool}/{source}')
        step.check('the copy was read from the snapshot, on the first node', view.get('mount', {}).get('fstype') == 'ext4', view.get('mount'))
        step.check('the copy, its claim, PV and image, and the snapshot are gone', removed and snap not in dropped, dropped)
        summary = judge_left(step, run, name, view, want['transcript'])
        ctx['runs'][run]['left'] = summary
        return {'snapshot': {'name': f'{pool}/{source}@{snap}', 'createdAt': snapped_at, 'listed': taken}, 'cutAt': ctx['runs'][run]['killedAt'],
                'copy': {'claim': claim, 'image': target, 'info': copied[-600:]}, 'asked': want, 'view': view, 'summary': summary}
    return step_fn


def run_fence(run):
    def step_fn(ctx, step):
        name = owner_of(run)
        with cn.as_owner(name):
            return tl.takeover_fence(ctx, step)
    return step_fn


def run_resume(run):
    def step_fn(ctx, step):
        """The next generation on the first node: what its start said of the volume, the repositories now, the session resumed."""
        name = owner_of(run)
        owner = al.owner_uuid(name)
        r = ctx['runs'][run]
        m, pod = ml.running_pod(name)
        log = k('logs', pod['metadata']['name'], '-c', 'runner', check=False).stdout.splitlines()
        check_lines = [line[-400:] for line in log if 'volume check' in line or 'volume sync' in line]
        if run == 'after':
            step.check(f'{name}: the runner looked at its repositories before anything ran Git there', any('volume check:' in line and 'checkouts in' in line
                                                                                                            for line in check_lines), check_lines)
        want = expected_view(ctx, run, name)
        live = read_in_runner(name, want)
        at = now()
        turn = wl.new_turn(name, r['sessions']['s1']['id'], f"{marker(name, 'RESUMED')} a message after the takeover")
        try:
            found = al.answered(owner, marker(name, 'RESUMED'), timeout=300, after=at)
        except Failed as error:
            if run == 'after':
                raise
            # Before the fix the session may not come back at all: that is part of what is recorded.
            return {'runnerLog': check_lines, 'live': live, 'turn': turn, 'answered': None, 'notAnswered': str(error), 'lastTurnResumed': False}
        step.check(f'{name}: the message after the takeover was answered by {name}\'s runner', found['event']['ingested_by_runner_id'] == m['runner_id'], found['event'])
        requests = [q for q in found['modelRequests'] if q.get('kind') == 'text']
        secrets = (requests[-1].get('secrets') if requests else None) or []
        step.check(f'{name}: the resumed conversation holds the first turn', f'{name}s1' in secrets, secrets)
        kept = f'{name}last' in secrets
        if run == 'after':
            step.check(f'{name}: the resumed conversation holds the last turn, answered just before the cut', kept, secrets)
            for label, repo in live['repos'].items():
                step.check(f'{name} {label}: the repository reads and git fsck is clean on the runner after its start', repo['revParseHead']['exit'] == 0
                           and repo['fsck']['exit'] == 0, {k_: repo[k_] for k_ in ('revParseHead', 'fsck', 'locks')})
        s3 = wl.sql_json(f"select status from session where id = {wl.quote(r['s3']['uuid'])}")[0]['status']
        return {'runnerLog': check_lines, 'live': live, 'turn': turn, 'answered': found, 'resumedSecrets': secrets, 'lastTurnResumed': kept,
                's3StatusNow': s3, 'answeredAfterSeconds': al.seconds_between(at, found['event']['ingested_at'])}
    return step_fn


def run_rejoin(run):
    def step_fn(ctx, step):
        name = owner_of(run)
        started = tl.rejoin_start(ctx, step)
        log = Path(ctx['out']) / 'logs' / 'rejoin-start.log'
        if log.exists():
            log.rename(log.with_name(f'rejoin-start-{run}.txt'))
        plugin_before = tl.node_plugin_ready(2)
        k('taint', 'node', NODES[2], f'{tl.OUT_OF_SERVICE}-', namespace=None)
        released_at = now()
        deadline = time.monotonic() + 300
        while not tl.node_plugin_ready(2):
            if time.monotonic() > deadline:
                raise Failed(f'no ready Ceph-CSI node plugin on {NODES[2]} within 300 s of the taint\'s removal')
            time.sleep(3)
        node = tl.node_view(2)
        step.check('the second node is Ready, schedulable and untainted', node['ready'] == 'True' and not node['unschedulable'] and not node['taints'], node)
        # The held turn is not waited out: an interrupt ends it, so the runner can sleep.
        s3 = ctx['runs'][run]['s3']
        interrupted = ml.http('POST', f"/sessions/{s3['id']}/interrupt", None, token=al.token(name))
        asleep = al.ensure_asleep(name)
        end = tl.placement(name)
        tl.check_released(step, end, f'{name} asleep')
        return {'rejoin': started, 'nodePluginReadyBefore': plugin_before, 'releasedAt': released_at, 'node': node,
                's3Interrupt': interrupted[0], 'asleep': asleep, 'placement': end}
    return step_fn


def switch(ctx, step):
    """The profile pinned to this branch's image (its archive imported again: the one built from this checkout's runner);
    the apiserver restarted. ann is asleep: her next generation would run it too."""
    imported = import_image(IMAGES['after'])
    after = al.git('diff', '--stat', imported['source'], 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image')
    step.check('the after image\'s runner and image sources are this checkout\'s', after == '', after or '(no difference)')
    step.check('the after image is in both VMs\' containerd under one ID', len({n['id'] for n in imported['nodes'].values()}) == 1, imported['nodes'])
    ctx['images']['after'] = imported['reference']
    profile = json.loads(sw.PROFILE.read_text())
    pinned_before = profile['runner']['image']
    profile['runner']['image'] = ctx['images']['after']
    sw.private_write(sw.PROFILE, profile)
    restarted = al.start_server('on')
    ctx['switched'] = json.loads(sw.PROFILE.read_text())['runner']['image']
    ctx['image'] = ctx['switched']
    step.check('the profile pins the after image', ctx['switched'] == ctx['images']['after'], ctx['switched'])
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    return {'image': imported, 'pinnedBefore': pinned_before, 'pinned': ctx['switched'], 'restarted': restarted}


# ---- the damaged volume on the fixed runner -----------------------------------------------------------------------------

def damaged_start(ctx, step):
    """The test server again (the final teardown stopped it), its profile pinned to the image of this checkout's runner."""
    gate = capture(ml.cmd_gate, action='start', since=None)  # the manager's only way to k3s, which the teardown stopped
    step.check('the gate runs', gate['unit'] == 'active', gate['unit'])
    imported = import_image(IMAGES['final'])
    source = al.git('diff', '--stat', imported['source'], 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image')
    step.check('the final image\'s runner and image sources are this checkout\'s', source == '', source or '(no difference)')
    ctx['images']['final'] = imported['reference']
    profile = json.loads(sw.PROFILE.read_text())
    profile['runner']['image'] = imported['reference']
    sw.private_write(sw.PROFILE, profile)
    restarted = al.start_server('on')
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    step.check('the profile pins the final image', json.loads(sw.PROFILE.read_text())['runner']['image'] == ctx['images']['final'])
    install = capture(sw.cmd_admission, action='install')
    step.check('the admission webhook is installed', bool(install['webhook']))
    return {'gate': gate, 'image': imported, 'restarted': restarted, 'admission': {k_: install[k_]['answer'][:160] for k_ in ('dryRunUnmanagedPod', 'dryRunUnownedManagedClaim')},
            'recorder': record('start')}


def damaged_wake(ctx, step):
    """The before run's account, whose volume the cut left with unreadable repositories, woken by a message to s1: its next
    generation runs this branch's runner."""
    name = owner_of('before')
    owner = al.owner_uuid(name)
    r = ctx['runs']['before']
    s1 = r['sessions']['s1']
    ran = mapping(name)['generation']
    slept = al.ensure_asleep(name)  # its next generation runs the image the profile pins now
    word = marker(name, f'DAMAGED{stamp()}')  # each attempt its own message: one the engine never sees
    at = now()
    turn = wl.new_turn(name, s1['id'], f'{word} a message to the session the cut damaged')
    ready = until(name, 'READY', gen_above=ran, timeout=420)
    images = pod_images(name)
    step.check(f'{name}: the next generation runs the final image', images and images['spec'] == [ctx['images']['final']], images)
    refused = al.wait_text(owner, 'REPOSITORY_DAMAGED', timeout=240, after=at, session=s1['uuid'])
    _, pod = ml.running_pod(name)
    log = [line[-400:] for line in k('logs', pod['metadata']['name'], '-c', 'runner', check=False).stdout.splitlines()
           if 'volume check' in line or 'REPOSITORY_DAMAGED' in line or 'not starting' in line]
    damage = [line for line in log if 'volume check:' in line and 'cannot be read' in line]
    step.check(f'{name}: the runner\'s start found the repositories it cannot read and said so', damage, log)
    text = wl.sql_json(f"select payload::text as p from run_event where session_id = {wl.quote(r['sessions']['s1']['uuid'])} and seq = {int(refused['event']['seq'])}")[0]['p']
    step.check(f'{name}: the session was refused with the reason, naming the repository', 'REPOSITORY_DAMAGED' in text and 'orbit-repos/default' in text
               and 'cannot be read' in text, text[:600])
    status = poll(lambda: (lambda row: row if row['status'] in ('FAILED', 'AWAITING_INPUT', 'CANCELLED') else None)(
        wl.sql_json(f"select status from session where id = {wl.quote(r['sessions']['s1']['uuid'])}")[0]), 120, 'the refused session settles')
    step.check(f'{name}: the session failed with the refusal', status['status'] == 'FAILED', status)
    step.check(f'{name}: no engine saw the message: the model was never asked about it', fake_model_line(word, 'text') is None
               and fake_model_line(word, 'tool_use') is None)
    live = read_in_runner(name, {'sessions': [s1['uuid']]})
    step.check(f'{name}: no new repository over the broken one: the workspace\'s HEAD still names master and its objects are still the empty ones',
               (live['repos']['workspace'].get('headFile') or {}).get('content') == 'ref: refs/heads/master'
               and live['repos']['workspace']['revParseHead']['exit'] != 0, live['repos']['workspace'].get('headFile'))
    asleep = al.ensure_asleep(name)
    return {'sleptFirst': slept, 'turn': turn, 'ready': ready, 'images': images, 'runnerLog': log, 'refusal': text[:1500],
            'refusedEvent': refused['event'], 'sessionStatus': status, 'live': live, 'asleep': asleep}


# ---- setup, the switch, final ------------------------------------------------------------------------------------------

def setup_server_dir(ctx, step):
    al.RECORDER_UNIT = RECORDER_UNIT
    return al.setup_server_dir(ctx, step)


def on_prepare(ctx, step):
    prepared = capture(wl.cmd_prepare, image=ctx['images']['before'], source=str(al.T02A))[0]
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t02c'
    profile['capacity'] = {'compute': {'cpu': '1', 'memory': '1536Mi', 'ephemeralStorage': '2Gi', 'pods': 2, 'attachments': 2},
                           'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 2}
    profile['lifecycle'].update(idleSeconds=3600, startupDeadlineSeconds=900, maxAttempts=5)
    sw.private_write(sw.PROFILE, profile)
    identity_view = prepared.get('identity') or {}
    step.check('the manager\'s identity is the least-privilege ServiceAccount',
               identity_view.get('username') == f'system:serviceaccount:{NAMESPACE}:{sw.MANAGER}', identity_view.get('username'))
    step.check('the profile pins the before image', profile['runner']['image'] == ctx['images']['before'], profile['runner']['image'])
    ctx['profile'] = profile
    return {'profile': profile, 'manager': {k_: identity_view.get(k_) for k_ in ('username', 'canI', 'rules')}}


def on_start(ctx, step):
    al.stop_api_units()
    lines = al.server('start', '--managed')
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    return {'testServer': lines[-7:], 'switch': al.switch_lines(), 'recorder': record('start')}


def final_checks(ctx, step):
    view = ml.verdict()
    step.check('the database and k3s agree', not view['problems'], view['problems'])
    timeline = [json.loads(line) for line in (SERVER / 'timeline.jsonl').read_text().splitlines() if line.startswith('{')]
    most = {}
    for name in RUNS.values():
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
    return {'verdict': view, 'most': most, 'timelineLines': len(timeline), 'ceph': {'health': health.get('health'), 'detail': detail},
            'gate': al.gate_summary(ctx['firstSignInAt']), 'nodes': {NODES[n]: tl.node_view(n) for n in (1, 2)}}


def teardown(ctx, step):
    results = {'recorder': record('stop'), 'admission': capture(sw.cmd_admission, action='remove')}
    results['server'] = al.server('stop')
    results['gate'] = capture(ml.cmd_gate, action='stop', since=None)
    step.check('the webhook is removed', sw.webhook_view() is None)
    return results


# ---- a later runner change through the after run again (task D10) -------------------------------------------------------

def again_start(ctx, step):
    """What the last teardown stopped, started again with this checkout's image pinned (LAB_T02C_AFTER_IMAGE): the gate,
    the test server with the switch on, the admission webhook, the recorder."""
    gate = capture(ml.cmd_gate, action='start', since=None)
    step.check('the gate runs', gate['unit'] == 'active', gate['unit'])
    imported = import_image(IMAGES['after'])
    source = al.git('diff', '--stat', imported['source'], 'HEAD', '--', 'src/runner-go', 'deploy/managed-runner/image')
    step.check('the after image\'s runner and image sources are this checkout\'s', source == '', source or '(no difference)')
    step.check('the after image is in both VMs\' containerd under one ID', len({n['id'] for n in imported['nodes'].values()}) == 1, imported['nodes'])
    ctx.setdefault('images', {})['after'] = imported['reference']
    profile = json.loads(sw.PROFILE.read_text())
    profile['runner']['image'] = imported['reference']
    sw.private_write(sw.PROFILE, profile)
    restarted = al.start_server('on')
    ctx['switched'] = ctx['image'] = json.loads(sw.PROFILE.read_text())['runner']['image']
    step.check('the profile pins the after image', ctx['switched'] == imported['reference'], ctx['switched'])
    step.check('the switch is on with the lab profile', al.switch_lines() == ['ORBIT_MANAGED_RUNNERS_ENABLED=true', f'ORBIT_MANAGED_RUNNERS_PROFILE={sw.PROFILE}'],
               al.switch_lines())
    install = capture(sw.cmd_admission, action='install')
    step.check('the admission webhook is installed', bool(install['webhook']))
    return {'gate': gate, 'image': imported, 'restarted': restarted, 'recorder': record('start'),
            'admission': {k_: install[k_]['answer'][:160] for k_ in ('dryRunUnmanagedPod', 'dryRunUnownedManagedClaim')}}


def again_syncs(ctx, step):
    """What the runner on the second node says of its volume's syncs, and the mount it read that from: an RBD volume is
    an ext4 of its own (the mount's root is "/"), so T02c's syncs all stay, the one behind every tool included."""
    name = owner_of('after')
    _, pod = ml.running_pod(name)
    log = k('logs', pod['metadata']['name'], '-c', 'runner', check=False).stdout.splitlines()
    lines = [line[-300:] for line in log if 'volume syncs:' in line]
    mount = sw.pod_exec(pod['metadata']['name'], 'sh', '-c', "grep ' /var/lib/orbit ' /proc/self/mountinfo").stdout.split()
    root, source = (mount[3], mount[mount.index('-') + 2]) if '-' in mount else (None, None)
    step.check(f'{name}: the runner syncs before reports and behind every tool, its volume a filesystem of its own on RBD',
               any('before reports and behind every tool' in line and '/dev/rbd' in line and 'a filesystem of its own' in line for line in lines), lines)
    step.check(f'{name}: the volume\'s mount is the root of an RBD device\'s filesystem', root == '/' and (source or '').startswith('/dev/rbd'),
               {'root': root, 'source': source})
    return {'lines': lines, 'mountinfo': ' '.join(mount)}


def again_s3(ctx, step):
    """s3's engine commit, made in a turn still running at the cut, survived it: the sync behind its tool ran."""
    r = ctx['runs']['after']
    held = r['left']['s3']
    step.check('s3\'s mid-turn engine commit is on its branch in what the cut left', bool(held) and all(c.get('onTheBranch') for c in held.values()), held)
    return {'s3': held, 'secondsBeforeTheCut': al.seconds_between(r['times']['s3EngineCommitSeen'], r['killedAt'])}


# ---- the recorder ---------------------------------------------------------------------------------------------------------

def cmd_record_loop(args):
    deadline, last = time.monotonic() + args.seconds, None
    while time.monotonic() < deadline:
        try:
            line = tl.record_line()
        except (Exception, SystemExit) as error:  # the database or the guest is away: say so and look again
            line = {'error': str(error)[-200:]}
        compare = {k_: v for k_, v in line.items() if k_ != 'gate'}
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


# ---- the run ------------------------------------------------------------------------------------------------------------------

def one_run(run):
    return [('ready', run_ready(run)), ('sessions', run_sessions(run)), ('last', run_last(run)), ('left', run_left(run)),
            ('fence', run_fence(run)), ('resume', run_resume(run)), ('rejoin', run_rejoin(run))]


def phases():
    return [
        ('facts', [('git', tl.facts_git), ('host', tl.facts_host), ('cluster', tl.facts_cluster), ('ceph', tl.facts_ceph), ('images', facts_images),
                   ('model', facts_model)]),
        ('stuck', [('t07', stuck_pod)]),
        ('timing', [('git', timing)]),
        ('setup', [('server-dir', setup_server_dir), ('admin', tl.setup_admin)]),
        ('on', [('prepare', on_prepare), ('start', on_start), ('admission', tl.on_admission)]),
        ('before', one_run('before')),
        ('switch', [('image', switch)]),
        ('after', one_run('after')),
        ('final', [('checks', final_checks), ('teardown', teardown)]),
        ('damaged', [('start', damaged_start), ('wake', damaged_wake), ('teardown', teardown)]),
        ('again', [('host', tl.facts_host), ('cluster', tl.facts_cluster), ('ceph', tl.facts_ceph), ('start', again_start),
                   ('ready', run_ready('after')), ('syncs', again_syncs), ('sessions', run_sessions('after')), ('last', run_last('after')),
                   ('left', run_left('after')), ('s3', again_s3), ('fence', run_fence('after')), ('resume', run_resume('after')),
                   ('rejoin', run_rejoin('after')), ('checks', final_checks), ('teardown', teardown)]),
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
    ctx.update(out=str(out))
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
    """The run's steps (time, checks) and what the README quotes, from its records only."""
    out = Path(args.out)
    steps = [json.loads(line) for line in (out / 'steps.jsonl').read_text().splitlines()]
    records = {}
    for path in sorted((out / 'records').glob('[0-9]*.json')):
        found = json.loads(path.read_text())
        records[f"{found['phase']}/{found['step']}"] = found
    get = lambda key: (records.get(key) or {}).get('result') or {}
    measures = {}
    for run in RUNS:
        try:
            measures[run] = {'secondsBeforeTheCut': get(f'{run}/last')['secondsBeforeTheCut'], 'left': get(f'{run}/left')['summary'],
                             'lastTurnResumed': get(f'{run}/resume')['lastTurnResumed'], 'runnerLog': get(f'{run}/resume')['runnerLog'],
                             'failover': get(f'{run}/fence').get('seconds')}
        except (KeyError, TypeError) as error:
            measures[run] = f'unavailable: {type(error).__name__} {error}'
    print(json.dumps({'steps': len(steps), 'checks': sum(line['checks'] for line in steps), 'failedSteps': [f"{l['phase']}/{l['step']}" for l in steps if not l['ok']],
                      'from': steps[0]['startedAt'] if steps else None, 'to': max(r['endedAt'] for r in records.values()) if records else None,
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
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    sub.add_parser('secret-scan').add_argument('paths', nargs='+')
    sub.add_parser('report').add_argument('out')
    args = parser.parse_args()
    {'run': cmd_run, 'record-loop': cmd_record_loop, 'secret-scan': tl.cmd_secret_scan, 'report': cmd_report}[args.command](args)


if __name__ == '__main__':
    main()
