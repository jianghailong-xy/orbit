#!/usr/bin/env python3
"""Two Git commits on the second node seconds before its power is cut: one with Git's defaults, one with
core.fsync=committed,index (core.fsyncMethod=fsync), set the way a system gitconfig would set it. Both are read back
on the first node after the runbook's release of the volume (out-of-service taint), with no managed runner involved:
a plain RWO claim of the runner class and Pods of the runner image as UID 10001. Then the second node comes back,
the taint goes, and the claim, its PV and its image are removed.

  LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02 python3 -I git-fsync-cut.py OUT.json

Prints and writes one JSON record. Uses takeover-lab.py's helpers, the lab's context only.
"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

LAB = Path(__file__).resolve().parents[5] / 'scripts/managed-runner/lab'
spec = importlib.util.spec_from_file_location('lab_takeover', LAB / 'takeover-lab.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
k, kget, kjson, NODES, NAMESPACE = t.k, t.kget, t.kjson, t.NODES, t.NAMESPACE

WRITE = r'''set -eu
cd /data
for mode in default fsync; do
  if [ "$mode" = fsync ]; then
    export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.fsync GIT_CONFIG_VALUE_0=committed,index GIT_CONFIG_KEY_1=core.fsyncMethod GIT_CONFIG_VALUE_1=fsync
  fi
  git init -q "$mode"
  printf 'T02 Git durability probe, %s\n' "$mode" > "$mode/note.txt"
  git -C "$mode" add note.txt
  git -C "$mode" commit -q -m "T02 probe $mode"
  echo "$mode $(git -C "$mode" rev-parse HEAD) $(git -C "$mode" config --get core.fsync || echo default)"
done
'''

READ = r'''
import json, os, subprocess
out = {}
for mode in ('default', 'fsync'):
    repo = os.path.join('/data', mode)
    size = lambda p: os.path.getsize(os.path.join(repo, p)) if os.path.exists(os.path.join(repo, p)) else None
    objects = [os.path.join(d, f) for d, _, fs in os.walk(os.path.join(repo, '.git/objects')) for f in fs]
    run = lambda *a: subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True)
    head = run('rev-parse', 'HEAD')
    fsck = run('fsck', '--full')
    out[mode] = {'exists': os.path.isdir(repo), 'head': head.stdout.strip() if head.returncode == 0 else None,
                 'headError': head.stderr.strip()[-160:] or None, 'fsckExit': fsck.returncode, 'fsck': (fsck.stdout + fsck.stderr).strip()[-300:],
                 'sizes': {p: size(p) for p in ('note.txt', '.git/HEAD', '.git/refs/heads/master', '.git/index', '.git/config')},
                 'looseObjects': sorted([os.path.relpath(p, repo), os.path.getsize(p)] for p in objects)}
print(json.dumps(out))
'''


def pod(name, claim, node):
    return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02'}},
            'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False, 'terminationGracePeriodSeconds': 5,
                     'affinity': t.render.node_affinity(NODES[node]),
                     'securityContext': {'runAsUser': 10001, 'runAsGroup': 10001, 'fsGroup': 10001, 'runAsNonRoot': True,
                                         'seccompProfile': {'type': 'RuntimeDefault'}},
                     'containers': [{'name': 'git', 'image': t.image_reference()[0], 'command': ['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'],
                                     'env': [{'name': 'HOME', 'value': '/tmp'}],
                                     'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                                     'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'memory': '256Mi'}},
                                     'volumeMounts': [{'name': 'data', 'mountPath': '/data'}, {'name': 'tmp', 'mountPath': '/tmp'}]}],
                     'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}, {'name': 'tmp', 'emptyDir': {'sizeLimit': '64Mi'}}]}}


def until(label, predicate, seconds):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > deadline:
            raise SystemExit(f'{label}: not within {seconds} s')
        time.sleep(2)
    return t.now()


def main():
    out = Path(sys.argv[1])
    record = {'startedAt': t.now()}
    name = f't02-gitfsync-{t.stamp()}'
    k('apply', '-f', '-', input=json.dumps({'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim',
                                            'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {'orbit.dev/lab': 't02'}},
                                            'spec': {'storageClassName': t.ENV['LAB_STORAGE_CLASS'], 'accessModes': ['ReadWriteOnce'],
                                                     'volumeMode': 'Filesystem', 'resources': {'requests': {'storage': '1Gi'}}}}))
    k('wait', '--for=jsonpath={.status.phase}=Bound', f'pvc/{name}', '--timeout=300s')
    pv_name = kget('pvc', name)['spec']['volumeName']
    pv = kget('pv', pv_name, namespace=None)
    image = f"{pv['spec']['csi']['volumeAttributes']['pool']}/{pv['spec']['csi']['volumeAttributes']['imageName']}"
    record.update(claim=name, pv=pv_name, image=image)
    writer = f'{name}-w'
    k('apply', '-f', '-', input=json.dumps(pod(writer, name, 2)))
    k('wait', '--for=condition=Ready', f'pod/{writer}', '--timeout=300s')
    record['writerNode'] = kget('pod', writer)['spec']['nodeName']
    record['writtenAt'] = t.now()
    record['written'] = t.sw.kubectl('exec', writer, '--', 'sh', '-c', WRITE).stdout.split('\n')
    cut = t.al.run([str(LAB / 'stop.sh'), '--node', '2', '--hard'])
    record['stopSh'] = (cut.stdout + cut.stderr).strip().splitlines()
    record['power'] = t.power_state(2)
    k('taint', 'node', NODES[2], f'{t.OUT_OF_SERVICE}=nodeshutdown:NoExecute', namespace=None)
    record['taintAt'] = t.now()
    record['writerGoneAt'] = until('the writer Pod gone', lambda: kget('pod', writer) is None, 300)
    record['detachedAt'] = until('the volume detached', lambda: not t.attachments(pv_name), 300)
    reader = f'{name}-r'
    k('apply', '-f', '-', input=json.dumps(pod(reader, name, 1)))
    k('wait', '--for=condition=Ready', f'pod/{reader}', '--timeout=300s')
    record['readerNode'] = kget('pod', reader)['spec']['nodeName']
    record['read'] = json.loads(t.sw.kubectl('exec', reader, '--', 'python3', '-c', READ).stdout)
    record['readAt'] = t.now()
    k('delete', 'pod', reader, '--wait=true', '--timeout=300s')
    until('the reader detached', lambda: not t.attachments(pv_name), 300)
    started = subprocess.run([str(LAB / 'start.sh'), '--nodes', '2', '--no-wait'], capture_output=True, text=True)
    record['startSh'] = {'exit': started.returncode, 'tail': (started.stdout + started.stderr).strip().splitlines()[-4:]}
    record['node2ReadyAt'] = until('the second node Ready', lambda: (t.node_view(2) or {}).get('ready') == 'True', 420)
    record['node2Rbd'] = t.guest_rbd(2)
    k('taint', 'node', NODES[2], f'{t.OUT_OF_SERVICE}-', namespace=None)
    record['nodePluginBackAt'] = until('the node plugin back', lambda: t.node_plugin_ready(2), 300)
    k('delete', 'pvc', name, '--wait=true')
    k('delete', 'pv', pv_name, '--wait=true', namespace=None)
    t.al.ceph_shell(f'rbd rm --no-progress {image}')
    record['removed'] = image.split('/')[1] not in t.al.ceph_shell(f"rbd ls {image.split('/')[0]}").split()
    record['endedAt'] = t.now()
    out.write_text(json.dumps(record, indent=1))
    print(json.dumps(record, indent=1))


if __name__ == '__main__':
    main()
