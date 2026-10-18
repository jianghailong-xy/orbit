#!/usr/bin/env python3
"""T07's few additions to the lab tools (wake-lab.py, manager-lab.py, single-writer.py), for the states the
three clients have to show from a real server: a runner that runs out of memory, a volume held by an
attachment left behind, a volume deleted, and the profile T07 runs with. LAB_TEST_SERVER_DIR must name
test-server-t07. Prints JSON; never a credential.

  profile                 after `wake-lab.py prepare`: the runner container's memory limit 1Gi, so a real
                          out-of-memory kill is cheap (the budget stays one runner, 768Mi requested)
  oom NAME                inside NAME's runner container, a process that allocates until the kernel kills the
                          container (memory.oom.group): exit 137, reason OOMKilled, as the kubelet reports it
  va NAME on|off          a VolumeAttachment of NAME's PV that no Pod made (an attachment left behind), and its
                          removal: what the manager reads as a held volume (VOLUME_IN_USE)
  pvc-delete NAME         delete NAME's PVC while NAME sleeps (its PV and RBD image are kept: Retain)
  hold NAME               a session whose turn fake-model.py holds open for 30 minutes (FAKE-SLOW): NAME's runner
                          is busy, so it keeps the budget's one slot and another account waits for capacity
  release NAME            interrupt NAME's running turns, then the owner's sleep, asked again while the runner
                          is still busy (409 MANAGED_RUNNER_BUSY): the slot frees once it has slept
  loop NAME kill|oom [--times N]
                          N stops in a row (default 5, the profile's maxAttempts): each time, wait until the current
                          generation's Pod runs `orbit run`, then SIGKILL that process (kill) or run the container
                          out of memory (oom); a crash loop the manager restarts, then fails
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

LAB = Path(os.environ.get('T07_LAB_SCRIPTS', '/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40/scripts/managed-runner/lab'))
spec = importlib.util.spec_from_file_location('wake_lab', LAB / 'wake-lab.py')
wl = importlib.util.module_from_spec(spec)

spec.loader.exec_module(wl)
ml, sw = wl.ml, wl.sw

if sw.SERVER.name != 'test-server-t07':
    raise SystemExit(f'LAB_TEST_SERVER_DIR must be {sw.LAB_DIR}/test-server-t07, not {sw.SERVER}')

HOG = ('import time\n'
       'held = []\n'
       'for _ in range(96):\n'
       '    held.append(bytearray(32 * 1024 * 1024))\n'
       '    time.sleep(0.05)\n'
       'print("still alive after 3 GiB")\n')


def cmd_profile(_args):
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t07'
    profile['runner']['resources']['runner']['limits']['memory'] = '1Gi'
    sw.private_write(sw.PROFILE, profile)
    sw.out({'at': sw.now(), 'profile': str(sw.PROFILE), 'runner': profile['runner']['resources'], 'capacity': profile['capacity'],
            'lifecycle': profile['lifecycle']})


def cmd_oom(args):
    m, pod = ml.running_pod(args.name)
    name, uid = pod['metadata']['name'], pod['metadata']['uid']
    sent = sw.now()
    result = sw.kubectl('exec', '-i', name, '-c', 'runner', '--', 'python3', '-', input=HOG, check=False)
    seen, ended = sw.watch_pod_end(name, uid, 120)
    final = sw.kget('pod', name)
    terminated = None
    if final and final['metadata']['uid'] == uid:
        for status in final['status'].get('containerStatuses') or []:
            if status['name'] == 'runner':
                terminated = (status.get('state') or {}).get('terminated')
    sw.out({'owner': args.name, 'sentAt': sent, 'generation': m['generation'], 'pod': uid,
            'exec': {'code': result.returncode, 'stdout': result.stdout[-200:], 'stderr': result.stderr[-300:]},
            'timeline': seen, 'terminated': terminated and {k: terminated.get(k) for k in ('exitCode', 'reason', 'finishedAt')}})


def pv_of(name):
    m = ml.mapping_of(name)
    pvc = sw.kget('pvc', m['pvc_name'])
    if not pvc:
        raise SystemExit(f"{name}: no PVC {m['pvc_name']}")
    return m, pvc, pvc['spec']['volumeName']


def cmd_va(args):
    m, _pvc, pv = pv_of(args.name)
    va_name = f"t07-left-behind-{m['runner_id'][:8]}"
    if args.action == 'on':
        node = json.loads(sw.kubectl('get', 'nodes', '-o', 'json').stdout)['items'][0]['metadata']['name']
        manifest = {'apiVersion': 'storage.k8s.io/v1', 'kind': 'VolumeAttachment', 'metadata': {'name': va_name, 'labels': {'orbit.test': 't07'}},
                    'spec': {'attacher': 'rbd.csi.ceph.com', 'nodeName': node, 'source': {'persistentVolumeName': pv}}}
        result = sw.kubectl('apply', '-f', '-', input=json.dumps(manifest))
    else:
        result = sw.kubectl('delete', 'volumeattachment', va_name, '--wait=true', '--timeout=60s', check=False)
    time.sleep(2)
    listing = json.loads(sw.kubectl('get', 'volumeattachments', '-o', 'json').stdout)['items']
    sw.out({'owner': args.name, 'action': args.action, 'at': sw.now(), 'pv': pv, 'answer': (result.stdout or result.stderr).strip(),
            'attachmentsOfThePv': [{'name': va['metadata']['name'], 'node': va['spec']['nodeName'],
                                    'attached': (va.get('status') or {}).get('attached')}
                                   for va in listing if va['spec']['source'].get('persistentVolumeName') == pv]})


def cmd_pvc_delete(args):
    m, pvc, pv = pv_of(args.name)
    if m['management_state'] != 'SLEEPING':
        raise SystemExit(f"{args.name} is {m['management_state']}, not SLEEPING: its volume is not deleted under a runner")
    result = sw.kubectl('delete', 'pvc', pvc['metadata']['name'], '--wait=true', '--timeout=90s', check=False)
    sw.out({'owner': args.name, 'at': sw.now(), 'pvc': {'name': pvc['metadata']['name'], 'uid': pvc['metadata']['uid']}, 'pv': pv,
            'answer': (result.stdout or result.stderr).strip(), 'pvAfter': (sw.kget('pv', pv) or {}).get('status')})


def cmd_hold(args):
    result = wl.new_session(args.name, 'T07-HOLD FAKE-SLOW 1800 keep the runner busy', 't07 hold the slot')
    wl.remember(args.name, [result])
    sw.out({'owner': args.name, **result})


def cmd_release(args):
    token = wl.owner_state(args.name)['accessToken']
    sessions = wl.http('GET', '/sessions?view=open', token=token)[1]
    stopped = []
    for session in sessions if isinstance(sessions, list) else []:
        if session.get('status') in ('RUNNING', 'PENDING'):
            stopped.append({'id': session['id'], 'status': session['status'],
                            'interrupt': wl.http('POST', f"/sessions/{session['id']}/interrupt", {}, token=token)[0]})
    asked, deadline = [], time.monotonic() + 180
    while time.monotonic() < deadline:
        status = ml.status_of(args.name)
        code, answer = wl.http('POST', '/managed-runner/sleep', {'idempotencyKey': wl.uuid.uuid4().hex, 'revision': status.get('revision')},
                               token=token)
        asked.append({'at': sw.now(), 'state': status.get('managementState'), 'status': code,
                      'code': answer.get('code') if isinstance(answer, dict) else None})
        if code in (200, 202):
            break
        time.sleep(3)
    sw.out({'owner': args.name, 'interrupted': stopped, 'sleep': asked})


def orbit_running(name, seconds=240):
    """Until NAME's recorded Pod runs and its `orbit run` has started: (mapping, pod, pid)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            m, pod = ml.running_pod(name)
            listing = sw.pod_exec(pod['metadata']['name'], 'python3', '-c', ml.PROCESSES).stdout
            runner = [json.loads(line) for line in listing.splitlines() if line.strip()]
            runner = [p for p in runner if p['pid'] != 1 and os.path.basename((p['argv'] or [''])[0]) == 'orbit' and p['argv'][1:2] == ['run']]
            if len(runner) == 1:
                return m, pod, runner[0]['pid']
        except SystemExit:
            pass
        time.sleep(1)
    raise SystemExit(f'{name}: no running `orbit run` within {seconds} s')


def cmd_loop(args):
    stops = []
    for i in range(1, args.times + 1):
        m, pod, pid = orbit_running(args.name)
        name, uid = pod['metadata']['name'], pod['metadata']['uid']
        sent = sw.now()
        if args.how == 'kill':
            sw.pod_exec(name, 'kill', '-KILL', str(pid))
        else:
            sw.kubectl('exec', '-i', name, '-c', 'runner', '--', 'python3', '-', input=HOG, check=False)
        seen, ended = sw.watch_pod_end(name, uid, 120)
        final = sw.kget('pod', name)
        terminated = None
        if final and final['metadata']['uid'] == uid:
            for status in final['status'].get('containerStatuses') or []:
                if status['name'] == 'runner':
                    terminated = (status.get('state') or {}).get('terminated')
        after = ml.mapping_of(args.name)
        stop = {'n': i, 'how': args.how, 'sentAt': sent, 'generation': m['generation'], 'state': m['management_state'], 'pod': uid[:8],
                'terminated': terminated and {k: terminated.get(k) for k in ('exitCode', 'reason')},
                'after': {k: after[k] for k in ('management_state', 'generation', 'attempt')}}
        print(json.dumps(stop), flush=True)
        stops.append(stop)
        if after['management_state'] == 'FAILED':
            break
        time.sleep(2)
    sw.out({'owner': args.name, 'stops': stops})


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('profile')
    p = sub.add_parser('oom')
    p.add_argument('name')
    p = sub.add_parser('va')
    p.add_argument('name')
    p.add_argument('action', choices=('on', 'off'))
    p = sub.add_parser('pvc-delete')
    p.add_argument('name')
    for name in ('hold', 'release'):
        p = sub.add_parser(name)
        p.add_argument('name')
    p = sub.add_parser('loop')
    p.add_argument('name')
    p.add_argument('how', choices=('kill', 'oom'))
    p.add_argument('--times', type=int, default=5)
    args = parser.parse_args(sys.argv[1:])
    {'profile': cmd_profile, 'oom': cmd_oom, 'va': cmd_va, 'pvc-delete': cmd_pvc_delete, 'hold': cmd_hold,
     'release': cmd_release, 'loop': cmd_loop}[args.cmd](args)


if __name__ == '__main__':
    main()
