#!/usr/bin/env python3
"""T07b's additions to the lab tools (wake-lab.py, manager-lab.py, single-writer.py): what a runner's owner is
told while a READY runner restarts by itself on the lab's k3s, through the wait for its stopped Pod's volume to
detach. LAB_TEST_SERVER_DIR must name test-server-t07b. Prints JSON; never a credential.

  profile                 after `wake-lab.py prepare`: the runner container's memory limit 1Gi (T07's), so a real
                          out-of-memory kill is cheap
  watch NAME --out FILE [--interval S] [--seconds S]
                          every S seconds (default 0.5): NAME's status as the clients read it (GET
                          /api/managed-runner: its state and reason) and NAME's mapping row (generation, attempt,
                          the stored reason's code and the restart it carries), one JSON line per sample, until
                          READY is read again after a sample that was not READY, or --seconds pass
  oom NAME                inside NAME's runner container, a process that allocates until the kernel kills the
                          container (memory.oom.group): exit 137, OOMKilled, as the kubelet reports it (T07's)
  kill-starting NAME      once NAME's mapping is STARTING and its recorded Pod's `orbit run` has started, SIGKILL to
                          that process: a crash of a runner still starting, as in T07's crash loop
  detach-hold NAME on     a finalizer of this kit's on the VolumeAttachment of NAME's running Pod: once the Pod has
                          stopped, the attachment object outlives the detach (as a slow detach keeps it) until
  detach-hold NAME off [--after S]
                          ... this removes the finalizer: once the stored reason has been VOLUME_STILL_ATTACHED for
                          S seconds (default 10), or at once without a wait to see; prints the attachment's times
  ready-for NAME SECONDS  until NAME's mapping has been READY for SECONDS by the database's clock (twice the profile's
                          backoffMaxSeconds, and the next stop counts its attempts from one again)
  attachments NAME --out FILE [--seconds S]
                          every 0.5 s, the VolumeAttachments of NAME's PV (name, attached, deletion stamp,
                          finalizers), one JSON line per change, for --seconds (default 180)
  sequence FILE...        each file's samples as runs of the same (state, reason, carried restart), in order, with
                          when each began and how long it lasted, and what the three clients show for each: the
                          display the shared rule (src/shared managedRunnerDisplay) gives that status
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[5]
LAB = Path(os.environ.get('T07B_LAB_SCRIPTS', REPO / 'scripts/managed-runner/lab'))
spec = importlib.util.spec_from_file_location('wake_lab', LAB / 'wake-lab.py')
wl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wl)
ml, sw = wl.ml, wl.sw

HOG = ('import time\n'
       'held = []\n'
       'for _ in range(96):\n'
       '    held.append(bytearray(32 * 1024 * 1024))\n'
       '    time.sleep(0.05)\n'
       'print("still alive after 3 GiB")\n')


def require_dir():
    if sw.SERVER.name != 'test-server-t07b':
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {sw.LAB_DIR}/test-server-t07b, not {sw.SERVER}')


def cmd_profile(_args):
    require_dir()
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t07b'
    profile['runner']['resources']['runner']['limits']['memory'] = '1Gi'
    sw.private_write(sw.PROFILE, profile)
    sw.out({'at': sw.now(), 'profile': str(sw.PROFILE), 'runner': profile['runner']['resources'], 'capacity': profile['capacity'],
            'lifecycle': profile['lifecycle']})


def signed_in(name):
    """NAME's saved state, signed in again when its access token is refused."""
    found = ml.owner_state(name)
    status, answer = ml.http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    if status not in (200, 201):
        raise SystemExit(f'sign-in {name}: {status}')
    found.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    sw.private_write(sw.STATE / f'{name}.json', found)
    return found


ROW = ("select row_to_json(m) from (select management_state, desired_state, generation, attempt, revision, pod_uid, "
       "last_error->>'code' as code, last_error->'restart'->>'code' as carried, next_attempt_at, startup_deadline_at, "
       "state_entered_at from managed_runner where owner_id = '{owner}') m")


def cmd_watch(args):
    require_dir()
    found = ml.owner_state(args.name)
    owner = wl.to_uuid(found['user']['id'])
    if not all(c in '0123456789abcdef-' for c in owner):
        raise SystemExit('an owner id that is not a UUID')
    token = found['accessToken']
    started, seen_down, samples = time.monotonic(), False, 0
    with open(args.out, 'a', encoding='utf-8') as sink:
        while time.monotonic() - started < args.seconds:
            at = sw.now()
            t0 = time.monotonic()
            status, answer = ml.http('GET', '/managed-runner', token=token, timeout=10)
            if status == 401:
                token = signed_in(args.name)['accessToken']
                continue
            read_ms = round((time.monotonic() - t0) * 1000, 1)
            try:
                rows = sw.sql(ROW.format(owner=owner))
                row = json.loads(rows[0]) if rows else None
            except (Exception, SystemExit) as error:  # PG restarting: the sample says so, the watch goes on
                row = {'error': str(error)[:200]}
            view = None
            if status == 200 and isinstance(answer, dict):
                reason = answer.get('reason') or {}
                view = {'managementState': answer.get('managementState'), 'desiredState': answer.get('desiredState'),
                        'reason': {'code': reason.get('code'), 'message': reason.get('message'), 'retryable': reason.get('retryable')} if reason else None,
                        'retryAfter': answer.get('retryAfter'), 'usable': answer.get('usable'), 'initialProvider': answer.get('initialProvider'),
                        'actions': answer.get('actions'), 'enabled': answer.get('enabled'), 'contractVersion': answer.get('contractVersion')}
            sink.write(json.dumps({'at': at, 'httpStatus': status, 'readMs': read_ms, 'status': view, 'row': row}) + '\n')
            sink.flush()
            samples += 1
            state = (view or {}).get('managementState')
            if state and state != 'READY':
                seen_down = True
            elif state == 'READY' and seen_down:
                break
            time.sleep(max(0.0, args.interval - (time.monotonic() - t0)))
    sw.out({'owner': args.name, 'out': args.out, 'samples': samples, 'endedAt': sw.now(), 'readyAgain': seen_down and state == 'READY'})


def cmd_oom(args):
    require_dir()
    m, pod = ml.running_pod(args.name)
    name, uid = pod['metadata']['name'], pod['metadata']['uid']
    sent = sw.now()
    result = sw.kubectl('exec', '-i', name, '-c', 'runner', '--', 'python3', '-', input=HOG, check=False)
    seen, _ended = sw.watch_pod_end(name, uid, 120)
    final = sw.kget('pod', name)
    terminated = None
    if final and final['metadata']['uid'] == uid:
        for status in final['status'].get('containerStatuses') or []:
            if status['name'] == 'runner':
                terminated = (status.get('state') or {}).get('terminated')
    sw.out({'owner': args.name, 'sentAt': sent, 'generation': m['generation'], 'pod': uid,
            'exec': {'code': result.returncode, 'stdout': result.stdout[-200:], 'stderr': result.stderr[-300:]},
            'timeline': seen, 'terminated': terminated and {k: terminated.get(k) for k in ('exitCode', 'reason', 'finishedAt')}})


def cmd_kill_starting(args):
    require_dir()
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            m, pod = ml.running_pod(args.name)
        except SystemExit:
            time.sleep(0.3)
            continue
        if m['management_state'] != 'STARTING':
            if m['management_state'] == 'READY':
                raise SystemExit(f'{args.name}: READY before its `orbit run` could be killed while starting')
            time.sleep(0.3)
            continue
        name, uid = pod['metadata']['name'], pod['metadata']['uid']
        listing = sw.kubectl('exec', name, '-c', 'runner', '--', 'python3', '-c', ml.PROCESSES, check=False).stdout
        runner = [json.loads(line) for line in listing.splitlines() if line.strip()]
        runner = [p for p in runner if p['pid'] != 1 and os.path.basename((p['argv'] or [''])[0]) == 'orbit' and p['argv'][1:2] == ['run']]
        if len(runner) != 1:
            time.sleep(0.3)
            continue
        sent = sw.now()
        sw.pod_exec(name, 'kill', '-KILL', str(runner[0]['pid']))
        seen, ended = sw.watch_pod_end(name, uid, 120)
        sw.out({'owner': args.name, 'sentAt': sent, 'signal': 'KILL', 'state': m['management_state'], 'generation': m['generation'],
                'attempt': m['attempt'], 'pod': uid, 'timeline': seen, 'ended': ended})
        return
    raise SystemExit(f'{args.name}: no `orbit run` of a STARTING Pod within 300 s')


HOLD = 'orbit.dev/t07b-detach-held'


def attachments_of(name):
    m = ml.mapping_of(name)
    pvc = sw.kget('pvc', m['pvc_name'])
    if not pvc or not pvc['spec'].get('volumeName'):
        raise SystemExit(f"{name}: no bound PVC {m['pvc_name']}")
    pv = pvc['spec']['volumeName']
    listed = json.loads(sw.kubectl('get', 'volumeattachments', '-o', 'json').stdout)
    return pv, [va for va in listed['items'] if va['spec']['source'].get('persistentVolumeName') == pv]


def va_view(va):
    return {'name': va['metadata']['name'], 'node': va['spec'].get('nodeName'), 'attached': (va.get('status') or {}).get('attached'),
            'deletionTimestamp': va['metadata'].get('deletionTimestamp'), 'finalizers': va['metadata'].get('finalizers') or []}


def cmd_detach_hold(args):
    require_dir()
    pv, found = attachments_of(args.name)
    if args.action == 'on':
        m, pod = ml.running_pod(args.name)
        mine = [va for va in found if va['spec'].get('nodeName') == pod['spec'].get('nodeName')]
        if len(mine) != 1:
            raise SystemExit(f'{args.name}: expected one attachment of {pv} on its node, found {[va_view(v) for v in found]}')
        va = mine[0]
        if HOLD not in (va['metadata'].get('finalizers') or []):
            sw.kubectl('patch', 'volumeattachment', va['metadata']['name'], '--type=json', '-p',
                       json.dumps([{'op': 'add', 'path': '/metadata/finalizers/-', 'value': HOLD}]))
        sw.out({'at': sw.now(), 'owner': args.name, 'pv': pv, 'pod': pod['metadata']['uid'], 'generation': m['generation'],
                'attachment': va_view(json.loads(sw.kubectl('get', 'volumeattachment', va['metadata']['name'], '-o', 'json').stdout))})
        return
    held = [va for va in found if HOLD in (va['metadata'].get('finalizers') or [])]
    if len(held) != 1:
        raise SystemExit(f'{args.name}: expected one attachment of {pv} held by {HOLD}, found {[va_view(v) for v in found]}')
    name = held[0]['metadata']['name']
    owner = wl.to_uuid(ml.owner_state(args.name)['user']['id'])
    waited, since = [], None
    started = time.monotonic()
    while args.after > 0 and time.monotonic() - started < 300:
        code = (sw.sql(f"select coalesce(last_error->>'code', '') from managed_runner where owner_id = '{owner}'") or [''])[0]
        if code == 'VOLUME_STILL_ATTACHED':
            since = since or time.monotonic()
            if not waited:
                waited.append({'at': sw.now(), 'storedReason': code})
            if time.monotonic() - since >= args.after:
                break
        time.sleep(0.5)
    va = json.loads(sw.kubectl('get', 'volumeattachment', name, '-o', 'json').stdout)
    index = va['metadata']['finalizers'].index(HOLD)
    released = sw.now()
    sw.kubectl('patch', 'volumeattachment', name, '--type=json', '-p', json.dumps([
        {'op': 'test', 'path': f'/metadata/finalizers/{index}', 'value': HOLD},
        {'op': 'remove', 'path': f'/metadata/finalizers/{index}'},
    ]))
    gone = None
    for _ in range(120):
        if sw.kubectl('get', 'volumeattachment', name, '-o', 'json', check=False).returncode:
            gone = sw.now()
            break
        time.sleep(0.5)
    sw.out({'owner': args.name, 'pv': pv, 'heldUntil': released, 'waitSeen': waited, 'attachmentBeforeRelease': va_view(va), 'attachmentGoneAt': gone})


def cmd_ready_for(args):
    require_dir()
    owner = wl.to_uuid(ml.owner_state(args.name)['user']['id'])
    started = time.monotonic()
    while time.monotonic() - started < 600:
        row = sw.sql(f"select management_state || ' ' || extract(epoch from now() - state_entered_at)::int from managed_runner where owner_id = '{owner}'")
        state, seconds = row[0].split() if row else ('', '0')
        if state == 'READY' and int(seconds) >= args.seconds:
            sw.out({'at': sw.now(), 'owner': args.name, 'state': state, 'readyForSeconds': int(seconds)})
            return
        time.sleep(1)
    raise SystemExit(f'{args.name}: not READY for {args.seconds} s within 600 s')


def cmd_attachments(args):
    require_dir()
    last, started = None, time.monotonic()
    with open(args.out, 'a', encoding='utf-8') as sink:
        while time.monotonic() - started < args.seconds:
            pv, found = attachments_of(args.name)
            view = sorted((va_view(va) for va in found), key=lambda v: v['name'])
            if view != last:
                sink.write(json.dumps({'at': sw.now(), 'pv': pv, 'attachments': view}) + '\n')
                sink.flush()
                last = view
            time.sleep(0.5)


DISPLAY = r"""
const { managedRunnerDisplay } = require(process.argv[1]);
const statuses = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(statuses.map((s) => {
  const d = managedRunnerDisplay(s);
  return d && { kind: d.kind, title: d.title, detail: d.detail, retry: d.retry, acceptsWork: d.acceptsWork };
})));
"""


def stamp(at):
    return time.mktime(time.strptime(at[:19], '%Y-%m-%dT%H:%M:%S')) + float('0.' + at[20:23] if len(at) > 20 else 0)


def cmd_sequence(args):
    report = []
    for path in args.files:
        samples = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
        runs = []
        for s in samples:
            st, row = s.get('status') or {}, s.get('row') or {}
            key = (st.get('managementState'), (st.get('reason') or {}).get('code'), row.get('carried'))
            if runs and runs[-1]['key'] == key:
                runs[-1]['until'] = s['at']
                runs[-1]['samples'] += 1
                runs[-1]['generations'] = sorted({*runs[-1]['generations'], row.get('generation')} - {None})
                continue
            runs.append({'key': key, 'from': s['at'], 'until': s['at'], 'samples': 1, 'status': st, 'attempt': row.get('attempt'),
                         'generations': [row['generation']] if row.get('generation') is not None else []})
        # What the three clients draw for each run's status: the shared display, from this checkout's build.
        full = [{**r['status'], 'reason': r['status'].get('reason'), 'runnerId': 'r', 'workspaceId': 'w', 'revision': 1,
                 'heartbeatStatus': None, 'lastHeartbeatAt': None, 'firstSessionProvider': r['status'].get('initialProvider')} for r in runs]
        shown = subprocess.run(['node', '-e', DISPLAY, str(REPO / 'src/shared/dist/index.js')], input=json.dumps(full),
                               capture_output=True, text=True, check=True)
        displays = json.loads(shown.stdout)
        report.append({'file': path, 'samples': len(samples), 'from': samples[0]['at'] if samples else None, 'until': samples[-1]['at'] if samples else None,
                       'runs': [{'state': r['key'][0], 'reason': r['key'][1], 'carriedRestart': r['key'][2], 'from': r['from'], 'until': r['until'],
                                 'seconds': round(stamp(r['until']) - stamp(r['from']), 1), 'samples': r['samples'], 'attempt': r['attempt'],
                                 'generations': r['generations'], 'display': d} for r, d in zip(runs, displays)]})
    sw.out(report)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('profile')
    watch = sub.add_parser('watch')
    watch.add_argument('name')
    watch.add_argument('--out', required=True)
    watch.add_argument('--interval', type=float, default=0.5)
    watch.add_argument('--seconds', type=float, default=900)
    sub.add_parser('oom').add_argument('name')
    sub.add_parser('kill-starting').add_argument('name')
    hold = sub.add_parser('detach-hold')
    hold.add_argument('name')
    hold.add_argument('action', choices=('on', 'off'))
    hold.add_argument('--after', type=float, default=10)
    ready = sub.add_parser('ready-for')
    ready.add_argument('name')
    ready.add_argument('seconds', type=int)
    attached = sub.add_parser('attachments')
    attached.add_argument('name')
    attached.add_argument('--out', required=True)
    attached.add_argument('--seconds', type=float, default=180)
    sequence = sub.add_parser('sequence')
    sequence.add_argument('files', nargs='+')
    args = parser.parse_args()
    {'profile': cmd_profile, 'watch': cmd_watch, 'oom': cmd_oom, 'kill-starting': cmd_kill_starting, 'detach-hold': cmd_detach_hold, 'ready-for': cmd_ready_for,
     'attachments': cmd_attachments, 'sequence': cmd_sequence}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
