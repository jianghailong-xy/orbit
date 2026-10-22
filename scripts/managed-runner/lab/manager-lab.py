#!/usr/bin/env python3
"""The managed runner manager against the lab's real k3s (task T04): what the database records and
what k3s holds, under concurrent provisioning, a lost answer, a partial create and a controller
restart, stops with and without a kubelet's report, an API server cut off, a VM restart, and owners
acting on each other's runner.

docs/managed-runner-lab.md, "Manager reconciliation (T04)". It drives the test control plane of
test-server.sh (127.0.0.1 only) and the lab's context and namespace; LAB_TEST_SERVER_DIR must name a
directory of its own (test-server-t04). Every command prints JSON and never a credential: owners'
tokens and passwords, runner credentials and the manager's token stay in files of mode 0600 there.
Owner state files have single-writer.py's shape, so its per-owner commands (`credential`, `storage`,
`signal`) work with LAB_T02A_OWNER=<name>.

  prepare --image REF [--from DIR]   the T02a CA and webhook token (the lab image trusts that CA, k3s
                                presents that token), the manager's identity (now with `patch` on
                                Pods) and the profile, whose API server is the gate below
  gate start|stop|status|arm|pass|log
                                api-gate.py on 127.0.0.1:16444 in front of the k3s API forward: the
                                manager's only way to k3s, so its log counts every request it made
  crash-on-claim SECONDS        wait for the armed gate to take a request, then SIGKILL both apiservers:
                                a controller that dies after its create committed and before it heard back
  replica start|stop|status     a second apiserver on 127.0.0.1:13720, the same database and profile:
                                a second manager replica
  owner NAME [--no-signin]      the first is bootstrapped (admin), the others made through the admin API;
                                --no-signin leaves the first sign-in (which provisions) to `signin`
  signin NAME [--parallel N]    N concurrent sign-ins of NAME (with the switch on, sign-in provisions)
  ensure NAME [--parallel N]    N concurrent explicit ensures
  action NAME retry|sleep|wake  the owner's write, at the revision just read
  status NAME                   the owner's GET /managed-runner and what the shared display makes of it
  view                          every mapping, every managed object in the namespace and the verdict
  consistency                   the same; exit 1 when the database and k3s disagree
  watch SECONDS [--until NAME=STATE[@GEN]]...
                                one line per change of any mapping, Pod or attachment; through the
                                guest's own k3s while the host cannot reach the API server
  stand-in-login NAME           a stored Claude Code login on the runner's volume with no access token
                                and a placeholder refresh token: the runner reports a runtime signed in,
                                so it can be READY; no session, model or Anthropic endpoint is involved
  kill-runner NAME              SIGKILL to the runner process inside its container (a crash)
  delete NAME [--force]         `kubectl delete pod` as an operator does it (or with --grace-period=0 --force)
  evict NAME                    the Eviction API, as `kubectl drain` does it for one Pod
  api-outage SECONDS            take the QEMU forward of the k3s API away for SECONDS, then put it back
  cross-user A B                what B's owner token, B's runner credential and a Pod in B's name can do to A's
  foreign save|check            the managed-looking objects in the namespace that are not this database's
                                (L0's and T02a's): their UIDs and resource versions, then unchanged?
  switch-check NAME SECONDS     with the switch unset or false: the server answers, NAME signs in, the
                                owner API refuses every write, no managed row is written, and for SECONDS
                                not one connection reaches the gate and no object in the namespace changes
"""

import argparse
import base64
import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_single_writer', LAB / 'single-writer.py')
sw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sw)

REPO = sw.REPO
ENV = sw.ENV
LAB_DIR = sw.LAB_DIR
SERVER = sw.SERVER
STATE = sw.STATE
NAMESPACE = sw.NAMESPACE
GATE_PORT = 16444
GATE_UNIT = 'orbit-mr-lab-api-gate'
GATE_DIR = SERVER / 'gate'
REPLICA_UNIT = 'orbit-mr-lab-api-b'
REPLICA_PORT = 13720
EMAIL = 't04-{}@lab.invalid'
QMP = LAB_DIR / 'run/qmp.sock'
STAND_IN_LOGIN = {'claudeAiOauth': {'accessToken': '', 'refreshToken': 'orbit-lab-stand-in-not-a-credential',
                                    'expiresAt': 4102444800000, 'scopes': [], 'subscriptionType': None}}
now = sw.now
out = sw.out


def require_own_server_dir():
    if SERVER.name != 'test-server-t04':
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {LAB_DIR}/test-server-t04 (T02a\'s and T03\'s databases stay untouched), not {SERVER}')


# ---- setup --------------------------------------------------------------------------------------

def cmd_prepare(args):
    require_own_server_dir()
    source = Path(args.source)
    (SERVER / 'secrets').mkdir(mode=0o700, parents=True, exist_ok=True)
    copied = []
    # The lab image trusts T02a's CA (lab-ca-image.Dockerfile), and k3s presents T02a's webhook token
    # (its AdmissionConfiguration in the guest): keep both, so neither the image nor k3s changes.
    if not (SERVER / 'tls/server.pem').exists():
        shutil.copytree(source / 'tls', SERVER / 'tls', dirs_exist_ok=True)
        copied.append('tls')
    if not sw.WEBHOOK_TOKEN.exists():
        shutil.copy2(source / 'secrets/admission-webhook-token', sw.WEBHOOK_TOKEN)
        os.chmod(sw.WEBHOOK_TOKEN, 0o600)
        copied.append('secrets/admission-webhook-token')
    # The manager's identity: the ServiceAccount, its Role (with `patch` on Pods now) and its kubeconfig.
    identity = subprocess.run([sys.executable, '-I', str(LAB / 'single-writer.py'), 'identity'], capture_output=True, text=True,
                              env=dict(os.environ))
    if identity.returncode:
        raise SystemExit(f'identity: {identity.stderr.strip()}')
    kubeconfig = json.loads(sw.MANAGER_KUBECONFIG.read_text())
    for cluster in kubeconfig['clusters']:
        cluster['cluster']['server'] = f'https://127.0.0.1:{GATE_PORT}'
    sw.private_write(sw.MANAGER_KUBECONFIG, kubeconfig)
    profile = sw.lab_profile(args.image, sw.sha256_text(sw.webhook_token()))
    profile['resourceProfileId'] = 'orbit-mr-lab-t04'
    profile['kubernetes']['apiServer'] = f'https://127.0.0.1:{GATE_PORT}'
    # A budget an outage of a few minutes would exhaust under the old rule (5 attempts, 5-60 s apart).
    profile['lifecycle']['maxAttempts'] = 5
    sw.private_write(sw.PROFILE, profile)
    out({'at': now(), 'copiedFrom': str(source), 'copied': copied, 'identity': json.loads(identity.stdout),
         'profile': str(sw.PROFILE), 'value': profile})


def systemd(*args, check=True):
    result = subprocess.run(['systemctl', *args], capture_output=True, text=True)
    if check and result.returncode:
        raise SystemExit(f'systemctl {" ".join(args)}: {result.stderr.strip()}')
    return result


def active(unit):
    return systemd('is-active', unit, check=False).stdout.strip()


def cmd_gate(args):
    GATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    gate = [sys.executable, '-I', str(LAB / 'api-gate.py')]
    if args.action == 'start':
        if active(GATE_UNIT) != 'active':
            subprocess.run(['systemd-run', f'--unit={GATE_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=128M',
                            '-p', f"StandardOutput=append:{GATE_DIR / 'gate.out'}", '-p', f"StandardError=append:{GATE_DIR / 'gate.out'}",
                            *gate, 'serve', str(GATE_PORT), ENV['LAB_API_PORT'], str(GATE_DIR)], check=True)
            time.sleep(1)
    elif args.action == 'stop':
        systemd('stop', GATE_UNIT, check=False)
    elif args.action == 'arm':
        subprocess.run([*gate, 'arm', str(GATE_DIR), 'lose-answer', '--min-bytes', str(args.min_bytes), '--skip', str(args.skip),
                        '--then', str(args.then), '--hold', str(args.hold)], check=True, capture_output=True)
    elif args.action == 'pass':
        subprocess.run([*gate, 'pass', str(GATE_DIR)], check=True, capture_output=True)
    lines = (GATE_DIR / 'api-gate.jsonl').read_text().splitlines() if (GATE_DIR / 'api-gate.jsonl').exists() else []
    since = args.since or ''
    log = [json.loads(line) for line in lines if json.loads(line)['at'] >= since]
    control = json.loads((GATE_DIR / 'api-gate.json').read_text()) if (GATE_DIR / 'api-gate.json').exists() else None
    out({'at': now(), 'unit': active(GATE_UNIT), 'listen': f'127.0.0.1:{GATE_PORT}', 'control': control,
         'connections': len(log), 'lost': [c for c in log if c.get('lost')], 'refused': [c for c in log if (c.get('end') or '').startswith('upstream')],
         'log': log if args.action == 'log' else None})


def cmd_crash_on_claim(args):
    control_file = GATE_DIR / 'api-gate.json'
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline:
        control = json.loads(control_file.read_text())
        if control.get('claimedAt'):
            break
        time.sleep(0.05)
    else:
        raise SystemExit(f'the gate took no request within {args.seconds} s')
    killed = now()
    units = [unit for unit in ('orbit-mr-lab-api', REPLICA_UNIT) if active(unit) == 'active']
    for unit in units:
        systemd('kill', '--signal=SIGKILL', unit, check=False)
    out({'claimedAt': control['claimedAt'], 'killedAt': killed, 'units': units, 'control': control})


def cmd_replica(args):
    env_file = SERVER / 'secrets/api-b.env'
    if args.action == 'start':
        text = (SERVER / 'secrets/api.env').read_text()
        text = re.sub(r'^PORT=.*$', f'PORT={REPLICA_PORT}', text, flags=re.M)
        text = re.sub(r'^PUBLIC_ORIGIN=.*$', f'PUBLIC_ORIGIN=http://127.0.0.1:{REPLICA_PORT}', text, flags=re.M)
        sw.private_write(env_file, text)
        if active(REPLICA_UNIT) != 'active':
            subprocess.run(['systemd-run', f'--unit={REPLICA_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=1536M', '-p', 'OOMScoreAdjust=900',
                            '-p', f'EnvironmentFile={env_file}', '-p', f"WorkingDirectory={SERVER / 'home'}",
                            '-p', f"StandardOutput=append:{SERVER / 'logs/apiserver-b.log'}", '-p', f"StandardError=append:{SERVER / 'logs/apiserver-b.log'}",
                            '/usr/local/bin/node', '--require', str(REPO / 'src/android/scripts/a11-stack/loopback-only.cjs'),
                            str(REPO / 'src/apiserver/dist/main.js')], check=True)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            try:
                if http('GET', '/health', port=REPLICA_PORT)[0] == 200:
                    break
            except OSError:  # not listening yet (urllib's URLError is an OSError)
                pass
            time.sleep(3)
        else:
            raise SystemExit('replica b did not answer /api/health within 300 s')
    elif args.action == 'stop':
        systemd('stop', REPLICA_UNIT, check=False)
    managed = [line for line in env_file.read_text().splitlines() if line.startswith('ORBIT_MANAGED_RUNNERS_')] if env_file.exists() else []
    out({'at': now(), 'unit': active(REPLICA_UNIT), 'port': REPLICA_PORT, 'managedSwitch': managed})


# ---- the test server ------------------------------------------------------------------------------

def http(method, path, body=None, token=None, port=None, headers=None, timeout=60):
    if port is None:
        return sw.call(method, path, body, token=token, headers=headers, timeout=timeout)
    saved = sw.API
    sw.API = f'http://127.0.0.1:{port}/api'
    try:
        return sw.call(method, path, body, token=token, headers=headers, timeout=timeout)
    finally:
        sw.API = saved


def owner_state(name):
    found = sw.state(name)
    if not found:
        raise SystemExit(f'run `owner {name}` first')
    return found


def cmd_owner(args):
    require_own_server_dir()
    name = args.name
    if not re.fullmatch(r'[a-z][a-z0-9]{0,15}', name):
        raise SystemExit('NAME: a lowercase word')
    found = sw.state(name)
    if found:
        status, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    else:
        found = {'email': EMAIL.format(name), 'password': uuid.uuid4().hex}
        admin = next((sw.state(p.stem) for p in sorted(STATE.glob('*.json')) if sw.state(p.stem).get('admin')), None) if STATE.exists() else None
        if admin is None:
            status, answer = http('POST', '/auth/bootstrap', {**found, 'name': f'T04 lab {name}'})
            found['admin'] = True
        else:
            status, answer = http('POST', '/admin/users', {**found, 'name': f'T04 lab {name}'}, token=admin['accessToken'])
            if status not in (200, 201):
                raise SystemExit(f'admin/users: {status} {answer}')
            if args.no_signin:
                sw.private_write(STATE / f'{name}.json', {**found, 'user': answer.get('user', answer)})
                out({'at': now(), 'owner': name, 'created': True, 'signedIn': False})
                return
            status, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    if status not in (200, 201):
        raise SystemExit(f'owner {name}: {status} {answer}')
    found.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    sw.private_write(STATE / f'{name}.json', found)
    out({'at': now(), 'owner': name, 'user': {k: answer['user'].get(k) for k in ('id', 'email')}, 'admin': bool(found.get('admin'))})


def parallel(count, task):
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        futures = [pool.submit(task, i) for i in range(count)]
        return [f.result() for f in futures]


def cmd_signin(args):
    found = owner_state(args.name)
    start = now()
    answers = parallel(args.parallel, lambda i: http('POST', '/auth/login', {'email': found['email'], 'password': found['password']}))
    good = [a for s, a in answers if s in (200, 201)]
    if good:
        found.update(accessToken=good[-1]['accessToken'], refreshToken=good[-1]['refreshToken'])
        sw.private_write(STATE / f'{args.name}.json', found)
    out({'at': start, 'owner': args.name, 'parallel': args.parallel, 'statuses': sorted(s for s, _ in answers)})


def cmd_ensure(args):
    token = owner_state(args.name)['accessToken']
    start = now()
    key = str(uuid.uuid4())
    answers = parallel(args.parallel, lambda i: http('POST', '/managed-runner/ensure', {'idempotencyKey': key if args.same_key else str(uuid.uuid4())},
                                                    token=token, port=REPLICA_PORT if args.replica and i % 2 else None))
    out({'at': start, 'owner': args.name, 'parallel': args.parallel, 'sameKey': args.same_key,
         'answers': [{'status': s, 'state': (a or {}).get('managementState'), 'revision': (a or {}).get('revision'),
                      'runnerId': (a or {}).get('runnerId'), 'code': (a or {}).get('code') if isinstance(a, dict) else None} for s, a in answers]})


def status_of(name):
    status, answer = http('GET', '/managed-runner', token=owner_state(name)['accessToken'])
    if status != 200:
        raise SystemExit(f'GET /managed-runner: {status} {answer}')
    return answer


def display_of(status):
    """What the shared display makes of a status: the words every client shows (src/shared/src/managedRunnerDisplay.ts)."""
    script = ("const {managedRunnerDisplay} = require(process.argv[1]); let s = '';"
              "process.stdin.on('data', (c) => (s += c)).on('end', () => console.log(JSON.stringify(managedRunnerDisplay(JSON.parse(s)))));")
    result = subprocess.run(['node', '-e', script, str(REPO / 'src/shared/dist/index.js')], input=json.dumps(status), capture_output=True, text=True)
    return json.loads(result.stdout) if result.returncode == 0 else {'error': result.stderr.strip()[-300:]}


def cmd_status(args):
    status = status_of(args.name)
    out({'at': now(), 'owner': args.name, 'status': status, 'display': display_of(status)})


def cmd_action(args):
    before = status_of(args.name)
    body = {'idempotencyKey': str(uuid.uuid4())}
    if args.action in ('retry', 'sleep'):
        body['revision'] = before.get('revision')
    status, answer = http('POST', f'/managed-runner/{args.action}', body, token=owner_state(args.name)['accessToken'])
    out({'at': now(), 'owner': args.name, 'action': args.action, 'before': {k: before.get(k) for k in ('managementState', 'desiredState', 'revision')},
         'status': status, 'answer': answer})


# ---- the database and k3s, side by side -------------------------------------------------------------

def mappings():
    rows = sw.sql(f'select row_to_json(m) from (select {sw.MAPPING_COLUMNS}, lease_holder, '
                  '(select email from "user" u where u.id = managed_runner.owner_id) as email from managed_runner order by created_at) m')
    found = [json.loads(row) for row in rows]
    for m in found:
        match = re.fullmatch(r't04-([a-z0-9]+)@lab\.invalid', m.get('email') or '')
        m['owner'] = match.group(1) if match else m.get('email')
    return found


def guest_kubectl(*args):
    """The guest's own k3s, over SSH: what the API server holds while the host cannot reach it."""
    result = sw.ssh('sudo k3s kubectl ' + ' '.join(args), check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-300:])
    return result.stdout


def cluster_objects():
    try:
        namespaced = json.loads(sw.kubectl('get', 'pods,pvc,secrets,configmaps', '-o', 'json').stdout)['items']
        cluster = json.loads(sw.kubectl('get', 'pv,volumeattachments', '-o', 'json').stdout)['items']
        via = 'host'
    except SystemExit:
        namespaced = json.loads(guest_kubectl('-n', NAMESPACE, 'get', 'pods,pvc,secrets,configmaps', '-o', 'json'))['items']
        cluster = json.loads(guest_kubectl('get', 'pv,volumeattachments', '-o', 'json'))['items']
        via = 'guest'
    by = lambda kind: [o for o in namespaced + cluster if o['kind'] == kind]
    return {'via': via, 'pods': by('Pod'), 'pvcs': by('PersistentVolumeClaim'), 'secrets': by('Secret'),
            'configmaps': by('ConfigMap'), 'pvs': by('PersistentVolume'), 'attachments': by('VolumeAttachment')}


def managed_looking(objects):
    """Every object in the namespace named as a managed runner's: mr-data-<uuid>, mr-<uuid>, mr-boot-<uuid>, mr-fence-<uuid>."""
    pattern = re.compile(r'^mr-(data-|boot-|fence-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    return [o for key in ('pvcs', 'pods', 'secrets', 'configmaps') for o in objects[key] if pattern.match(o['metadata']['name'])]


def verdict(objects=None):
    rows = mappings()
    objects = objects or cluster_objects()
    named = lambda key, name: next((o for o in objects[key] if o['metadata']['name'] == name), None)
    pvs = {pv['metadata']['name']: pv for pv in objects['pvs']}
    problems, report = [], []
    for m in rows:
        runner, notes = m['runner_id'], []
        say = lambda problem: problems.append(f"{m['owner']}: {problem}")
        pvc = named('pvcs', m['pvc_name'])
        pv = pvs.get((pvc or {}).get('spec', {}).get('volumeName') or '')
        pod = named('pods', f'mr-{runner}')
        secret = named('secrets', f'mr-boot-{runner}')
        using = [p['metadata']['name'] for p in objects['pods']
                 if any((v.get('persistentVolumeClaim') or {}).get('claimName') == m['pvc_name'] for v in p['spec'].get('volumes', []))]
        attachments = [va['metadata']['name'] for va in objects['attachments'] if pv and va['spec']['source'].get('persistentVolumeName') == pv['metadata']['name']]
        annotations = lambda o: (o or {}).get('metadata', {}).get('annotations') or {}
        if m['pvc_uid']:
            if not pvc:
                (notes if (m['last_error'] or {}).get('code') == 'PVC_MISSING' else problems).append(f"{m['owner']}: PVC {m['pvc_name']} is gone")
            elif pvc['metadata']['uid'] != m['pvc_uid']:
                say(f"PVC {m['pvc_name']} has UID {pvc['metadata']['uid']}, recorded {m['pvc_uid']}")
        if pvc and (annotations(pvc).get('orbit.dev/owner-id') != m['owner_id'] or annotations(pvc).get('orbit.dev/runner-id') != runner):
            say('the PVC names another owner or runner')
        if m['pv_uid'] and (not pv or pv['metadata']['uid'] != m['pv_uid'] or pv['spec']['csi']['volumeHandle'] != m['volume_handle']):
            say('the PV is not the recorded one')
        if m['pod_uid']:
            if not pod:
                (notes if m['management_state'] == 'FENCING' else problems).append(f"{m['owner']}: the recorded Pod {m['pod_uid']} is gone")
            elif pod['metadata']['uid'] != m['pod_uid']:
                say(f"Pod mr-{runner} is {pod['metadata']['uid']}, recorded {m['pod_uid']}")
            elif annotations(pod).get('orbit.dev/generation') != str(m['generation']):
                say(f"the Pod is of generation {annotations(pod).get('orbit.dev/generation')}, the mapping at {m['generation']}")
        elif pod:
            pending = m['resource_operation_kind'] == 'CREATE_POD' and m['resource_operation_state'] == 'PENDING'
            (notes if pending else problems).append(f"{m['owner']}: Pod {pod['metadata']['uid']} is under the name, none recorded"
                                                    + (' (its create is pending)' if pending else ''))
        if len(using) > 1:
            say(f'{len(using)} Pods use the volume: {using}')
        if using and using != [f'mr-{runner}']:
            say(f'the volume is used by {using}')
        if m['management_state'] in ('STARTING', 'READY', 'DRAINING') and m['pod_uid'] and annotations(secret).get('orbit.dev/generation') != str(m['generation']):
            say(f"the bootstrap Secret is of generation {annotations(secret).get('orbit.dev/generation')}, the mapping at {m['generation']}")
        report.append({
            'owner': m['owner'], 'state': m['management_state'], 'desired': m['desired_state'], 'generation': m['generation'],
            'attempt': m['attempt'], 'reason': (m['last_error'] or {}).get('code'), 'runnerId': runner,
            'pvc': pvc and {'uid': pvc['metadata']['uid'], 'phase': pvc['status'].get('phase'), 'recorded': m['pvc_uid']},
            'pv': pv and {'uid': pv['metadata']['uid'], 'handle': pv['spec']['csi']['volumeHandle'], 'recorded': [m['pv_uid'], m['volume_handle']]},
            'pod': pod and {'uid': pod['metadata']['uid'], 'phase': pod['status'].get('phase'), 'generation': annotations(pod).get('orbit.dev/generation'),
                            'deleting': bool(pod['metadata'].get('deletionTimestamp')), 'finalizers': pod['metadata'].get('finalizers'),
                            'recorded': m['pod_uid']},
            'secretGeneration': annotations(secret).get('orbit.dev/generation'), 'podsUsingTheVolume': using, 'attachments': attachments,
            'notes': notes,
        })
    for key in ('pvc_name', 'pvc_uid', 'volume_handle', 'runner_id', 'owner_id'):
        values = [m[key] for m in rows if m[key]]
        if len(values) != len(set(values)):
            problems.append(f'two mappings share a {key}')
    ours = {m['runner_id'] for m in rows}
    foreign = [{'kind': o['kind'], 'name': o['metadata']['name'], 'uid': o['metadata']['uid'], 'resourceVersion': o['metadata']['resourceVersion']}
               for o in managed_looking(objects) if o['metadata']['name'][-36:] not in ours]
    return {'at': now(), 'via': objects['via'], 'mappings': report, 'problems': problems, 'foreign': foreign}


def cmd_view(args):
    result = verdict()
    out(result)
    if args.command == 'consistency' and result['problems']:
        raise SystemExit(1)


def compact_line(objects):
    rows = mappings()
    line = {}
    for m in rows:
        runner = m['runner_id']
        pod = next((p for p in objects['pods'] if p['metadata']['name'] == f'mr-{runner}'), None)
        pv = next((p['spec'].get('volumeName') for p in objects['pvcs'] if p['metadata']['name'] == m['pvc_name']), None)
        using = [p for p in objects['pods'] if any((v.get('persistentVolumeClaim') or {}).get('claimName') == m['pvc_name'] for v in p['spec'].get('volumes', []))]
        line[m['owner']] = {
            'state': m['management_state'], 'desired': m['desired_state'], 'gen': m['generation'], 'attempt': m['attempt'],
            'reason': (m['last_error'] or {}).get('code'), 'podUid': (m['pod_uid'] or '')[:8] or None,
            'pod': pod and f"{pod['metadata']['uid'][:8]}:{pod['status'].get('phase')}{':deleting' if pod['metadata'].get('deletionTimestamp') else ''}"
                           f"{':held' if 'orbit.dev/managed-runner-stop-report' in (pod['metadata'].get('finalizers') or []) else ''}",
            'onVolume': len(using), 'attachments': sum(1 for va in objects['attachments'] if pv and va['spec']['source'].get('persistentVolumeName') == pv),
            'proof': (m['fencing_receipt'] or {}).get('kind'), 'op': f"{m['resource_operation_kind']}:{m['resource_operation_state']}",
            'lease': (m.get('lease_holder') or '')[:8] or None,
        }
    return line


def cmd_watch(args):
    deadline, last, maximum = time.monotonic() + args.seconds, None, {}
    wanted = []
    for item in args.until:
        name, _, rest = item.partition('=')
        state, _, generation = rest.partition('@')
        wanted.append((name, state, int(generation) if generation else 0))
    while time.monotonic() < deadline:
        try:
            objects = cluster_objects()
            line, via = compact_line(objects), objects['via']
        except Exception as error:  # the database or the guest too: say so and look again
            line, via = {'error': str(error)[-200:]}, None
        for name, value in line.items():
            if isinstance(value, dict):
                maximum[name] = max(maximum.get(name, 0), value['onVolume'])
        if line != last:
            print(json.dumps({'at': now(), 'via': via, **line}, sort_keys=True), flush=True)
            last = line
        if wanted and all(isinstance(line.get(n), dict) and line[n]['state'] == s and line[n]['gen'] >= g for n, s, g in wanted):
            print(json.dumps({'at': now(), 'reached': args.until, 'mostPodsOnAVolume': maximum}), flush=True)
            return
        time.sleep(0.5)
    print(json.dumps({'at': now(), 'timeout': args.seconds, 'mostPodsOnAVolume': maximum}), flush=True)
    if wanted:
        raise SystemExit(f'not {args.until} within {args.seconds} s')


# ---- what is done to a runner -----------------------------------------------------------------

def mapping_of(name):
    found = [m for m in mappings() if m['owner'] == name]
    if len(found) != 1:
        raise SystemExit(f'expected one mapping of {name}, found {len(found)}')
    return found[0]


def running_pod(name):
    m = mapping_of(name)
    pod = sw.kget('pod', f"mr-{m['runner_id']}")
    if not pod or pod['status'].get('phase') != 'Running' or pod['metadata']['uid'] != m['pod_uid']:
        raise SystemExit(f'{name}: the recorded Pod is not running')
    return m, pod


def cmd_stand_in_login(args):
    m, pod = running_pod(args.name)
    text = json.dumps(STAND_IN_LOGIN)
    sw.pod_exec(pod['metadata']['name'], 'sh', '-c', 'umask 077 && mkdir -p "$CLAUDE_CONFIG_DIR" && cat > "$CLAUDE_CONFIG_DIR/.credentials.json"', input=text)
    listed = sw.pod_exec(pod['metadata']['name'], 'sh', '-c', 'ls -ln "$CLAUDE_CONFIG_DIR/.credentials.json" && sha256sum "$CLAUDE_CONFIG_DIR/.credentials.json"').stdout
    out({'at': now(), 'owner': args.name, 'pod': pod['metadata']['uid'], 'generation': m['generation'], 'written': listed.split('\n'),
         'contentSha256': hashlib.sha256(text.encode()).hexdigest(), 'content': STAND_IN_LOGIN})


PROCESSES = '''import json, os
for pid in sorted((p for p in os.listdir('/proc') if p.isdigit()), key=int):
    try:
        argv = [a.decode(errors='replace') for a in open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\\0') if a]
    except OSError:
        continue
    if int(pid) != os.getpid():
        print(json.dumps({'pid': int(pid), 'argv': argv[:4]}))
'''


def cmd_kill_runner(args):
    m, pod = running_pod(args.name)
    name = pod['metadata']['name']
    # The container's processes by their argv (tini is PID 1; the runner is `orbit run`, which the entrypoint execs).
    listing = sw.pod_exec(name, 'python3', '-c', PROCESSES).stdout
    processes = [json.loads(line) for line in listing.splitlines() if line.strip()]
    runner = [p for p in processes if p['pid'] != 1 and p['argv'][:2] and os.path.basename(p['argv'][0]) == 'orbit' and p['argv'][1:2] == ['run']]
    if len(runner) != 1:
        raise SystemExit(f'expected one `orbit run` process, found {processes}')
    pid = str(runner[0]['pid'])
    sent = now()
    sw.pod_exec(name, 'kill', '-KILL', pid)
    seen, ended = sw.watch_pod_end(name, pod['metadata']['uid'], 120)
    out({'owner': args.name, 'sentAt': sent, 'signal': 'KILL', 'pid': pid, 'processes': processes, 'pod': pod['metadata']['uid'],
         'generation': m['generation'], 'timeline': seen, 'ended': ended})


def cmd_delete(args):
    m = mapping_of(args.name)
    pod = sw.kget('pod', f"mr-{m['runner_id']}")
    if not pod:
        raise SystemExit('no Pod to delete')
    flags = ['--grace-period=0', '--force'] if args.force else []
    sent = now()
    result = sw.kubectl('delete', 'pod', pod['metadata']['name'], *flags, '--wait=false', check=False)
    after = sw.kget('pod', pod['metadata']['name'])
    out({'owner': args.name, 'requestedAt': sent, 'force': args.force, 'pod': pod['metadata']['uid'], 'generation': m['generation'],
         'answer': (result.stdout or result.stderr).strip(), 'objectRightAfter': sw.pod_view(after),
         'finalizersRightAfter': (after or {}).get('metadata', {}).get('finalizers')})


def cmd_evict(args):
    m = mapping_of(args.name)
    name = f"mr-{m['runner_id']}"
    pod = sw.kget('pod', name)
    if not pod:
        raise SystemExit('no Pod to evict')
    eviction = {'apiVersion': 'policy/v1', 'kind': 'Eviction', 'metadata': {'name': name, 'namespace': NAMESPACE}}
    sent = now()
    result = sw.kubectl('create', '--raw', f'/api/v1/namespaces/{NAMESPACE}/pods/{name}/eviction', '-f', '-', input=json.dumps(eviction), check=False)
    after = sw.kget('pod', name)
    out({'owner': args.name, 'requestedAt': sent, 'pod': pod['metadata']['uid'], 'generation': m['generation'],
         'answer': (result.stdout or result.stderr).strip()[:500], 'objectRightAfter': sw.pod_view(after),
         'conditionsRightAfter': (after or {}).get('status', {}).get('conditions')})


def qmp(*args):
    result = subprocess.run([sys.executable, '-I', str(LAB / 'qmp.py'), str(QMP), *args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'qmp {" ".join(args)}: {result.stderr.strip() or result.stdout.strip()}')
    return result.stdout.strip()


def cmd_api_outage(args):
    api = ENV['LAB_API_PORT']
    removed = now()
    try:
        qmp('hostfwd-remove', api)
        probe = subprocess.run(['curl', '-sk', '-o', '/dev/null', '-w', '%{http_code} %{errormsg}', f'https://127.0.0.1:{api}/readyz'],
                               capture_output=True, text=True).stdout
        time.sleep(args.seconds)
    finally:
        # Put back whatever happened above: the forward must never stay away.
        restored = now()
        qmp('hostfwd-add', api, '6443')
    sw.wait_api(120)
    out({'removedAt': removed, 'probeWhileRemoved': probe, 'restoredAt': restored, 'readyAgainAt': now(), 'seconds': args.seconds})


# ---- one owner and another -------------------------------------------------------------------

def cmd_cross_user(args):
    a, b = mapping_of(args.a), mapping_of(args.b)
    b_token = owner_state(args.b)['accessToken']
    a_status, b_status = status_of(args.a), status_of(args.b)
    before = {k: a[k] for k in ('revision', 'management_state', 'generation', 'pod_uid', 'pvc_uid')}
    rows = []

    def ask(label, method, path, body=None, token=b_token, headers=None):
        status, answer = http(method, path, body, token=token, headers=headers)
        code = answer.get('code') if isinstance(answer, dict) else None
        rows.append({'case': label, 'route': f'{method} /api{path}', 'status': status, 'code': code,
                     'message': (answer.get('message') if isinstance(answer, dict) else str(answer))[:200] if status >= 300 else None})

    ask("B reads its managed runner: its own, never A's", 'GET', '/managed-runner')
    rows[-1]['runnerId'] = b_status['runnerId']
    rows[-1]['isA'] = b_status['runnerId'] == a_status['runnerId']
    # The owner API names no mapping: every write is the caller's own. B's retry, wake and sleep, at A's revision.
    ask("B's retry at A's revision", 'POST', '/managed-runner/retry', {'idempotencyKey': str(uuid.uuid4()), 'revision': a_status['revision']})
    ask("B's sleep at A's revision", 'POST', '/managed-runner/sleep', {'idempotencyKey': str(uuid.uuid4()), 'revision': a_status['revision']})
    # A's runner and workspace by their ids, with B's token.
    ask("B reads A's runner", 'GET', f"/runners/{a_status['runnerId']}")
    ask("B rotates A's runner's token", 'POST', f"/runners/{a_status['runnerId']}/rotate-token", {})
    ask("B deletes A's runner", 'DELETE', f"/runners/{a_status['runnerId']}")
    ask("B reads A's default workspace", 'GET', f"/workspaces/{a_status['workspaceId']}")
    ask("B deletes A's default workspace", 'DELETE', f"/workspaces/{a_status['workspaceId']}")
    # B's runner credential, from B's bootstrap Secret, as A's instance at the runner door (a read only).
    secret = sw.kget('secret', f"mr-boot-{b['runner_id']}")
    credential = base64.b64decode(secret['data']['token']).decode()
    instance = {'X-Orbit-Runner-Capabilities': sw.INSTANCE_CAPABILITY, 'X-Orbit-Managed-Runner-Generation': str(a['generation']),
                'X-Orbit-Managed-Runner-Pod-Uid': a['pod_uid'] or str(uuid.uuid4())}
    ask("B's runner credential naming A's instance", 'GET', '/runner/me', token=credential, headers=instance)
    ask("B's runner credential naming A's instance, claiming", 'GET', '/runner/sessions/claim', token=credential, headers=instance)
    # A Pod in B's name on A's volume, and one under A's name with B's identity: what the admission guard says (dry runs, as the manager).
    pod = sw.kget('pod', f"mr-{a['runner_id']}") or {}
    guard = []
    if pod:
        base = sw.contender(f"mr-{b['runner_id']}", a, pod, labelled=True)
        base['metadata']['annotations'] = {**base['metadata']['annotations'], 'orbit.dev/owner-id': b['owner_id'], 'orbit.dev/runner-id': b['runner_id']}
        guard.append({'case': "B's fixed name and identity, A's volume", **sw.dry_run(base, manager=True)})
        named = sw.contender(f"mr-{a['runner_id']}", a, pod, labelled=True)
        named['metadata']['annotations'] = {**named['metadata']['annotations'], 'orbit.dev/owner-id': b['owner_id']}
        guard.append({'case': "A's fixed name and volume, B as the owner", **sw.dry_run(named, manager=True)})
    after = mapping_of(args.a)
    out({'at': now(), 'a': args.a, 'b': args.b, 'answers': rows, 'admission': guard,
         'aBefore': before, 'aAfter': {k: after[k] for k in before}, 'aUnchanged': before == {k: after[k] for k in before},
         'bCredentialSha256Prefix': sw.sha256_text(credential)[:12]})


def namespace_snapshot():
    objects = cluster_objects()
    return sorted(f"{o['kind']}/{o['metadata']['name']} {o['metadata']['uid']} rv={o['metadata']['resourceVersion']}"
                  + (f" {o['status'].get('phase')}" if o['kind'] == 'Pod' else '')
                  for key in ('pods', 'pvcs', 'secrets', 'configmaps', 'attachments') for o in objects[key])


def gate_connections():
    path = GATE_DIR / 'api-gate.jsonl'
    return len(path.read_text().splitlines()) if path.exists() else 0


def api_sockets():
    """TCP connections the apiserver units' processes hold to the gate or the k3s API forward."""
    found = []
    for unit in ('orbit-mr-lab-api', REPLICA_UNIT):
        pid = systemd('show', '-p', 'MainPID', '--value', unit, check=False).stdout.strip()
        if pid and pid != '0':
            sockets = subprocess.run(['ss', '-Htnp'], capture_output=True, text=True).stdout.splitlines()
            found += [line for line in sockets if f'pid={pid},' in line and (f':{GATE_PORT} ' in line or f":{ENV['LAB_API_PORT']} " in line)]
    return found


def cmd_switch_check(args):
    switch = [line for line in (SERVER / 'secrets/api.env').read_text().splitlines() if line.startswith('ORBIT_MANAGED_RUNNERS_')]
    connections, before, rows_before = gate_connections(), namespace_snapshot(), sw.sql('select count(*) from managed_runner')[0]
    started = now()
    health = http('GET', '/health')
    signin = subprocess.run([sys.executable, '-I', str(Path(__file__)), 'owner', args.name], capture_output=True, text=True, env=dict(os.environ))
    if signin.returncode:
        raise SystemExit(f'owner {args.name}: {signin.stderr.strip()}')
    token = owner_state(args.name)['accessToken']
    status = http('GET', '/managed-runner', token=token)
    writes = {}
    for action in ('ensure', 'retry', 'wake', 'sleep', 'delete'):
        code, answer = http('POST', f'/managed-runner/{action}', {'idempotencyKey': str(uuid.uuid4()), 'revision': 0}, token=token)
        writes[action] = {'status': code, 'code': answer.get('code') if isinstance(answer, dict) else None}
    time.sleep(args.seconds)
    after = namespace_snapshot()
    log = (SERVER / 'logs/apiserver.log').read_text(errors='replace').splitlines()
    out({'at': started, 'switch': switch or ['(unset)'], 'health': health[0], 'signedIn': json.loads(signin.stdout)['owner'],
         'status': {'http': status[0], 'enabled': (status[1] or {}).get('enabled'), 'managementState': (status[1] or {}).get('managementState'),
                    'display': display_of(status[1]) if status[0] == 200 else None},
         'writes': writes, 'managedRowsBefore': rows_before, 'managedRowsAfter': sw.sql('select count(*) from managed_runner')[0],
         'runnerRows': sw.sql('select count(*) from runner')[0], 'waitedSeconds': args.seconds,
         'gateConnectionsDuring': gate_connections() - connections, 'apiserverSocketsToTheApi': api_sockets(),
         'namespaceUnchanged': before == after, 'namespaceObjects': len(after),
         'changed': sorted(set(before) ^ set(after)),
         'managedLogLines': [line[-220:] for line in log if 'anaged' in line][-12:]})


def cmd_foreign(args):
    path = SERVER / 'foreign-baseline.json'
    current = verdict()['foreign']
    if args.action == 'save':
        sw.private_write(path, current)
        out({'at': now(), 'saved': current})
        return
    baseline = json.loads(path.read_text())
    out({'at': now(), 'baseline': baseline, 'now': current, 'unchanged': sorted(map(json.dumps, baseline)) == sorted(map(json.dumps, current))})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('--image', required=True)
    prepare.add_argument('--from', dest='source', default=str(LAB_DIR / 'test-server-t02a'))
    gate = sub.add_parser('gate')
    gate.add_argument('action', choices=('start', 'stop', 'status', 'arm', 'pass', 'log'))
    gate.add_argument('--min-bytes', type=int, default=1600)
    gate.add_argument('--skip', type=int, default=0)
    gate.add_argument('--then', type=int, default=0)
    gate.add_argument('--hold', type=float, default=0)
    gate.add_argument('--since')
    sub.add_parser('replica').add_argument('action', choices=('start', 'stop', 'status'))
    sub.add_parser('crash-on-claim').add_argument('seconds', type=int)
    owner = sub.add_parser('owner')
    owner.add_argument('name')
    owner.add_argument('--no-signin', action='store_true')
    signin = sub.add_parser('signin')
    signin.add_argument('name')
    signin.add_argument('--parallel', type=int, default=1)
    ensure = sub.add_parser('ensure')
    ensure.add_argument('name')
    ensure.add_argument('--parallel', type=int, default=1)
    ensure.add_argument('--same-key', action='store_true')
    ensure.add_argument('--replica', action='store_true', help='every other request to replica b')
    action = sub.add_parser('action')
    action.add_argument('name')
    action.add_argument('action', choices=('retry', 'sleep', 'wake'))
    sub.add_parser('status').add_argument('name')
    sub.add_parser('view')
    sub.add_parser('consistency')
    watch = sub.add_parser('watch')
    watch.add_argument('seconds', type=int)
    watch.add_argument('--until', action='append', default=[])
    sub.add_parser('stand-in-login').add_argument('name')
    sub.add_parser('kill-runner').add_argument('name')
    delete = sub.add_parser('delete')
    delete.add_argument('name')
    delete.add_argument('--force', action='store_true')
    sub.add_parser('evict').add_argument('name')
    sub.add_parser('api-outage').add_argument('seconds', type=int)
    cross = sub.add_parser('cross-user')
    cross.add_argument('a')
    cross.add_argument('b')
    sub.add_parser('foreign').add_argument('action', choices=('save', 'check'))
    switch = sub.add_parser('switch-check')
    switch.add_argument('name')
    switch.add_argument('seconds', type=int)
    args = parser.parse_args()
    {'prepare': cmd_prepare, 'gate': cmd_gate, 'replica': cmd_replica, 'crash-on-claim': cmd_crash_on_claim, 'owner': cmd_owner, 'signin': cmd_signin, 'ensure': cmd_ensure,
     'action': cmd_action, 'status': cmd_status, 'view': cmd_view, 'consistency': cmd_view, 'watch': cmd_watch,
     'stand-in-login': cmd_stand_in_login, 'kill-runner': cmd_kill_runner, 'delete': cmd_delete, 'evict': cmd_evict,
     'api-outage': cmd_api_outage, 'cross-user': cmd_cross_user, 'foreign': cmd_foreign, 'switch-check': cmd_switch_check}[args.command](args)


if __name__ == '__main__':
    main()
