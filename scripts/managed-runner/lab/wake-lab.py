#!/usr/bin/env python3
"""Wake on demand, idle sleep and capacity of managed runners against the lab's real k3s (task T06):
the three kinds of wake (a message, an executable task, scheduled work), a wait for capacity on a
small budget, a start that fails and is retried, sleep refused while a turn or a background job
runs, a scale to zero and the start after it, a disabled account, and the switch unset or `false`.

docs/managed-runner-lab.md, "Wake, sleep and capacity (T06)". It drives the test control plane of
test-server.sh (127.0.0.1 only) and the lab's context and namespace through T04's manager-lab.py,
whose commands it also passes through (gate, replica, status, action, view, consistency, watch,
kill-runner, foreign). LAB_TEST_SERVER_DIR must name test-server-t06, T06b's test-server-t06b, T07's
test-server-t07 or T07b's test-server-t07b.
Every command prints JSON and never a credential: owners' tokens and passwords, runner credentials,
the model key (fake-model.py's placeholder) and the manager's token stay in files of mode 0600
there, in the lab's Secrets and in the test server's provider store. Sessions run on fake-model.py,
which is not a model.

  prepare --image REF           T02a's CA and webhook token, T04's manager identity and the profile:
                                the gate as its API server, a budget of ONE runner, idle after 60 s
  account NAME [--no-signin]    the first is bootstrapped (the admin), the others opened through the
                                admin API and then signed in; each account's default permission mode
                                is Bypass, so fake-model.py's tool calls run unasked
  key NAME                      a DeepSeek-preset model key on NAME's account whose endpoint is
                                fake-model.py (T05's way to READY without a model)
  selfhost NAME                 a self-managed runner of NAME's (enrolled, registered through the
                                runner API, heartbeating Claude Code signed in) and a workspace on it
  selfhost-dispatch NAME --label L
                                a session on that workspace, claimed by that runner over the runner API
  session NAME --prompt P       a session in NAME's managed default workspace, nothing named
  message NAME SESSION... --prompt P
                                one turn to each session, all at once
  burst NAME --prompt P [--messages S,S] [--sessions N] [--tasks N]
                                every kind of demand at once: turns, new sessions and task runs
  task NAME --prompt P [--run-now] [--run-at-seconds S]
                                a task assigned to NAME's managed default workspace, run now or at a time
  answered NAME MARKER [--timeout S]
                                until fake-model.py's answer quoting MARKER is in one of NAME's sessions;
                                the turn's times (queued, delivered, answered) and who ran it
  until NAME STATE [--reason R] [--gen-above G] [--timeout S]
                                wait until NAME's mapping is in STATE, each change printed
  snapshot NAME                 NAME's mapping, runner, PVC, PV, attachments, Pod, workspace, sessions
  pool                          the capacity pool and every mapping's reservation
  turns NAME                    every turn of NAME's sessions with its times and status
  jobs NAME                     the background jobs NAME's sessions ran and how each ended
  probe NAME write|check RUN    data on the runner's volume: random bytes, a Git commit and SQLite rows
                                in WAL mode, compared after a wake (integrity_check)
  disable NAME on|off           the administrator disables or enables NAME's account
  quota on|off                  a ResourceQuota of zero Pods in the namespace: the cluster refuses the
                                next Pod create
  off-check --label L --seconds S [--message NAME:SESSION]... [--task NAME]...
                                with the switch unset or false: each demand is made, nothing managed is
                                written, no object in the namespace changes and no connection reaches
                                the gate for S seconds
  record start|stop             a recorder unit: one line per change of any mapping, runner heartbeat,
                                Pod, attachment, session or pool figure (timeline.jsonl)
  summary [--since TS]          the timeline's state changes per owner
  gate-summary --since TS [--until TS]
                                what the manager sent k3s in that window, by request size (T04's bands)
"""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

LAB = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lab_manager', LAB / 'manager-lab.py')
ml = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml)
sw = ml.sw

REPO = sw.REPO
SERVER = sw.SERVER
STATE = sw.STATE
NAMESPACE = sw.NAMESPACE
EMAIL = 't06-{}@lab.invalid'
NAME_RE = re.compile(r't06-([a-z0-9]+)@lab\.invalid')
RECORDER_UNIT = 'orbit-mr-lab-t06-recorder'
QUOTA = 't06-no-pods'
PROBE_ROOT = '/var/lib/orbit/home/t06-probe'
now = sw.now
out = sw.out
http = ml.http


# T06's directory, or T06b's (its follow-ups: the heartbeat before the first claim, a quota's wait, a
# first session queued while waiting for capacity), or T07's (the three clients against the lab), or T07b's
# (a restart's reason through the wait for its volume), each with its own database.
OWN_SERVER_DIRS = ('test-server-t06', 'test-server-t06b', 'test-server-t07', 'test-server-t07b')


def require_own_server_dir():
    if SERVER.name not in OWN_SERVER_DIRS:
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {sw.LAB_DIR}/test-server-t06, test-server-t06b, test-server-t07 or test-server-t07b (the other tasks\' databases stay untouched), not {SERVER}')


def name_of(email):
    match = NAME_RE.fullmatch(email or '')
    return match.group(1) if match else email


MAPPING_COLUMNS = sw.MAPPING_COLUMNS + ', lease_holder, demand_revision, last_demand_at, drain_demand_revision, stop_requested_at, stop_acknowledged_at'


def t06_mappings():
    rows = sw.sql(f'select row_to_json(m) from (select {MAPPING_COLUMNS}, '
                  '(select email from "user" u where u.id = managed_runner.owner_id) as email from managed_runner order by created_at) m')
    found = [json.loads(row) for row in rows]
    for m in found:
        m['owner'] = name_of(m.get('email'))
    return found


# manager-lab.py's views, gate and per-owner commands, with this task's names and directory.
ml.mappings = t06_mappings
ml.EMAIL = EMAIL
ml.require_own_server_dir = require_own_server_dir


def owner_state(name):
    return ml.owner_state(name)


def save(name, value):
    sw.private_write(STATE / f'{name}.json', value)


def ms_since(started):
    return round((time.monotonic() - started) * 1000, 1)


def sql_json(query):
    return [json.loads(row) for row in sw.sql(f'select row_to_json(t) from ({query}) t')]


def quote(value):
    if not re.fullmatch(r'[0-9A-Za-z_.:@ %-]*', value):
        raise SystemExit(f'refusing to put {value!r} in SQL')
    return f"'{value}'"


def to_uuid(public_id):
    if re.fullmatch(r'[0-9a-f-]{36}', public_id):
        return public_id
    script = "const {toUuid} = require(process.argv[1]); console.log(toUuid(process.argv[2]));"
    result = subprocess.run(['node', '-e', script, str(REPO / 'src/shared/dist/index.js'), public_id], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'toUuid: {result.stderr.strip()[-200:]}')
    return result.stdout.strip()


# ---- setup --------------------------------------------------------------------------------------

def cmd_prepare(args):
    require_own_server_dir()
    ml.cmd_prepare(args)
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t06'
    # ONE runner at a time (each asks 500m and 768Mi, one Pod, one attachment, 1Gi of /tmp): a second
    # account's runner has to wait for capacity. Storage for five volumes of 2Gi beside 2Gi headroom.
    profile['capacity'] = {'compute': {'cpu': '500m', 'memory': '768Mi', 'ephemeralStorage': '1Gi', 'pods': 1, 'attachments': 1},
                           'storage': {'usable': '12Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 1}
    # Idle after a minute, so a scale to zero takes minutes, not a week; a start has 15 minutes.
    profile['lifecycle'].update(idleSeconds=60, startupDeadlineSeconds=900, maxAttempts=5)
    sw.private_write(sw.PROFILE, profile)
    out({'at': now(), 'profile': str(sw.PROFILE), 'value': profile})


# ---- accounts and sign-ins ----------------------------------------------------------------------

def admin_state():
    if not STATE.exists():
        return None
    return next((sw.state(p.stem) for p in sorted(STATE.glob('*.json')) if sw.state(p.stem).get('admin')), None)


def cmd_account(args):
    require_own_server_dir()
    name = args.name
    if not re.fullmatch(r'[a-z][a-z0-9]{0,15}', name):
        raise SystemExit('NAME: a lowercase word')
    found = sw.state(name)
    created = False
    if not found:
        found = {'email': EMAIL.format(name), 'password': uuid.uuid4().hex}
        admin = admin_state()
        if admin is None:
            started, at = time.monotonic(), now()
            status, answer = http('POST', '/auth/bootstrap', {**found, 'name': f'T06 lab {name}'})
            if status not in (200, 201):
                raise SystemExit(f'bootstrap: {status} {answer}')
            found.update(admin=True, accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
            found.setdefault('signIns', []).append({'at': at, 'ms': ms_since(started), 'status': status, 'bootstrap': True})
            save(name, found)
            out({'at': at, 'owner': name, 'admin': True, 'bootstrap': {'status': status, 'ms': found['signIns'][-1]['ms']},
                 'user': {k: answer['user'].get(k) for k in ('id', 'email')}, 'preferences': bypass(found)})
            return
        status, answer = http('POST', '/admin/users', {**found, 'name': f'T06 lab {name}'}, token=admin['accessToken'])
        if status not in (200, 201):
            raise SystemExit(f'admin/users: {status} {answer}')
        found['user'] = answer.get('user', answer)
        created = True
        save(name, found)
        if args.no_signin:
            out({'at': now(), 'owner': name, 'created': True, 'signedIn': False})
            return
    started, at = time.monotonic(), now()
    status, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    if status not in (200, 201):
        raise SystemExit(f'sign-in {name}: {status} {answer}')
    found.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    found.setdefault('signIns', []).append({'at': at, 'ms': ms_since(started), 'status': status})
    save(name, found)
    out({'owner': name, 'created': created, 'signIn': found['signIns'][-1], 'user': {k: answer['user'].get(k) for k in ('id', 'email')},
         'preferences': bypass(found)})


def bypass(found):
    """Bypass as the account's default permission mode: fake-model.py's tool calls (bg_run, schedule_wakeup) run unasked."""
    status, answer = http('PATCH', '/users/me/preferences', {'defaultPermissionMode': 'bypassPermissions'}, token=found['accessToken'])
    return {'status': status, 'defaultPermissionMode': ((answer or {}).get('preferences') or {}).get('defaultPermissionMode')
            if isinstance(answer, dict) else None}


def cmd_key(args):
    found = owner_state(args.name)
    body = {'label': 'FAKE model (lab, not a model)', 'presetSlug': 'deepseek',
            'baseUrl': f"http://10.0.2.2:{sw.ENV['LAB_TEST_FAKE_MODEL_PORT']}/anthropic", 'apiKey': 'sk-lab-fake-model-not-a-key'}
    at = now()
    status, answer = http('POST', '/providers/mine', body, token=found['accessToken'])
    if status not in (200, 201):
        raise SystemExit(f'providers/mine: {status} {answer.get("code") if isinstance(answer, dict) else answer}')
    found.setdefault('keys', {})[answer['slug']] = {'id': answer['id'], 'kind': 'fake', 'at': at}
    save(args.name, found)
    out({'at': at, 'owner': args.name, **{k: answer.get(k) for k in ('id', 'slug', 'label', 'presetSlug', 'runtime', 'baseUrl', 'defaultModel', 'enabled')}})


# ---- a self-managed runner -------------------------------------------------------------------------

SELF_HEADERS = {'x-orbit-runner-os': 'linux', 'x-orbit-supported-providers': 'claude'}
SELF_ENGINES = [{'engine': 'claude', 'installed': True, 'version': '2.1.300', 'auth': 'yes'}]


def self_beat(token):
    return http('POST', '/runner/heartbeat', {'status': 'ONLINE', 'idleCapacity': 2, 'version': '0.1.0', 'runsAsRoot': False,
                                              'engines': SELF_ENGINES}, token=token, headers=SELF_HEADERS)


def cmd_selfhost(args):
    found = owner_state(args.name)
    token = found['accessToken']
    status, enrollment = http('POST', '/runners/enrollment-tokens', {'label': f't06 {args.name} self-managed'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'enrollment-tokens: {status} {enrollment}')
    status, registered = http('POST', '/runner/register', {'enrollmentToken': enrollment['token'], 'name': f'{args.name}-selfhost',
                                                           'hostname': f'{args.name}-selfhost.lab.invalid', 'version': '0.1.0', 'maxConcurrent': 2})
    if status not in (200, 201):
        raise SystemExit(f'runner/register: {status} {registered}')
    beat = self_beat(registered['runnerToken'])
    runners = http('GET', '/runners', token=token)[1]
    runner = next(r for r in runners if r['name'] == f'{args.name}-selfhost')
    status, workspace = http('POST', '/workspaces', {'name': 'selfhost', 'runnerId': runner['id'], 'workDir': '/srv/selfhost'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'workspaces: {status} {workspace}')
    found['selfhost'] = {'runnerId': runner['id'], 'runnerUuid': registered['runnerId'], 'token': registered['runnerToken'], 'workspaceId': workspace['id']}
    save(args.name, found)
    out({'at': now(), 'owner': args.name, 'runner': {k: runner.get(k) for k in ('id', 'name', 'status', 'online')}, 'heartbeat': beat[0],
         'workspace': {k: workspace.get(k) for k in ('id', 'name', 'runnerId', 'workDir')}})


def cmd_selfhost_dispatch(args):
    found = owner_state(args.name)
    own = found['selfhost']
    beat = self_beat(own['token'])
    marker = f'T06-SELF-{args.label.upper()}'
    at = now()
    status, session = http('POST', '/sessions', {'workspaceId': own['workspaceId'], 'prompt': f'{marker} a self-managed session',
                                                 'title': f't06 self-managed {args.label}', 'provider': 'claude'}, token=found['accessToken'])
    if status not in (200, 201):
        raise SystemExit(f'sessions: {status} {session}')
    claimed_at = now()
    code, claim = http('GET', '/runner/sessions/claim', token=own['token'], headers=SELF_HEADERS, timeout=90)
    claimed = isinstance(claim, dict) and to_uuid(session['id']) in (claim.get('sessionId'), claim.get('id'))
    after = http('GET', f"/sessions/{session['id']}", token=found['accessToken'])[1]
    ended = http('POST', f"/sessions/{session['id']}/end", {}, token=found['accessToken'])
    out({'at': at, 'owner': args.name, 'label': args.label, 'heartbeat': beat[0],
         'session': {k: session.get(k) for k in ('id', 'status', 'provider', 'engine', 'assignedRunnerId')},
         'claim': {'at': claimed_at, 'status': code, 'sessionId': (claim or {}).get('sessionId') if isinstance(claim, dict) else None,
                   'claimedTheSession': claimed},
         'afterClaim': {k: (after or {}).get(k) for k in ('status', 'runStatus', 'assignedRunnerId')}, 'ended': ended[0]})
    if not claimed:
        raise SystemExit(1)


# ---- demand ---------------------------------------------------------------------------------------

def default_workspace(name):
    status = ml.status_of(name)
    if not status.get('workspaceId'):
        raise SystemExit(f'{name} has no managed default workspace yet ({status.get("managementState")})')
    return status


def new_session(name, prompt, title=None):
    found = owner_state(name)
    status = default_workspace(name)
    body = {'workspaceId': status['workspaceId'], 'prompt': prompt, 'title': title or prompt[:60]}
    at = now()
    code, answer = http('POST', '/sessions', body, token=found['accessToken'])
    return {'at': at, 'kind': 'session', 'status': code, 'managedState': status.get('managementState'),
            'answer': {k: answer.get(k) for k in ('id', 'status', 'provider', 'engine', 'assignedRunnerId', 'code', 'message')}
            if isinstance(answer, dict) else answer}


def new_turn(name, session, prompt):
    found = owner_state(name)
    at = now()
    code, answer = http('POST', f'/sessions/{session}/turns', {'clientTurnId': str(uuid.uuid4()), 'content': prompt}, token=found['accessToken'])
    return {'at': at, 'kind': 'turn', 'session': session, 'status': code,
            'answer': {k: answer.get(k) for k in ('id', 'status', 'seq', 'code', 'message')} if isinstance(answer, dict) else answer}


def new_task(name, prompt, run_now=False, run_at_seconds=None, title=None):
    found = owner_state(name)
    status = default_workspace(name)
    # Outside a project: OWNER_CONFIRMED, which nobody confirms here and which runs nothing on the runner
    # after the session (an EXECUTABLE acceptance command would be more work for the runner to do).
    body = {'title': title or prompt[:80], 'description': prompt, 'assigneeId': status['workspaceId'],
            'completionCriterion': 'OWNER_CONFIRMED', 'ownerConfirmationReason': 'OWNER_TRADE_OFF',
            'acceptanceCriteria': 'T06 lab: the run is claimed by the managed runner and answered.'}
    if run_at_seconds is not None:
        body['runAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + run_at_seconds))
    at = now()
    code, task = http('POST', '/tasks', body, token=found['accessToken'])
    result = {'at': at, 'kind': 'task', 'status': code, 'runAt': body.get('runAt'),
              'task': {k: task.get(k) for k in ('id', 'status', 'runAt', 'assigneeId', 'code', 'message')} if isinstance(task, dict) else task}
    if run_now and code in (200, 201):
        started = now()
        run_code, run = http('POST', f"/tasks/{task['id']}/execute", {}, token=found['accessToken'])
        result['execute'] = {'at': started, 'status': run_code,
                             'answer': {k: run.get(k) for k in ('id', 'status', 'sessionId', 'code', 'message')} if isinstance(run, dict) else run}
    return result


def remember(name, results):
    found = owner_state(name)
    for r in results:
        if r['kind'] == 'session' and r['status'] in (200, 201):
            found.setdefault('sessions', {})[r['answer']['id']] = {'at': r['at']}
        if r['kind'] == 'task' and r['status'] in (200, 201):
            found.setdefault('tasks', {})[r['task']['id']] = {'at': r['at'], 'runAt': r.get('runAt')}
    save(name, found)


def cmd_session(args):
    result = new_session(args.name, args.prompt, args.title)
    remember(args.name, [result])
    out({'owner': args.name, **result})


def cmd_message(args):
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(args.sessions))) as pool:
        results = list(pool.map(lambda s: new_turn(args.name, s, args.prompt), args.sessions))
    out({'owner': args.name, 'turns': results})


def cmd_burst(args):
    jobs = [lambda s=s, i=i: new_turn(args.name, s, f'{args.prompt}-M{i} a message') for i, s in enumerate(args.messages or [])]
    jobs += [lambda i=i: new_session(args.name, f'{args.prompt}-S{i} a new session') for i in range(args.sessions)]
    jobs += [lambda i=i: new_task(args.name, f'{args.prompt}-T{i} a task run', run_now=True) for i in range(args.tasks)]
    before = ml.mapping_of(args.name)
    started = now()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        results = list(pool.map(lambda job: job(), jobs))
    remember(args.name, results)
    out({'owner': args.name, 'at': started, 'demands': len(jobs), 'mappingBefore': {k: before[k] for k in ('management_state', 'generation', 'revision', 'demand_revision')},
         'results': results})


def cmd_task(args):
    result = new_task(args.name, args.prompt, args.run_now, args.run_at_seconds, args.title)
    remember(args.name, [result])
    out({'owner': args.name, **result})


# ---- what happened to a piece of work --------------------------------------------------------------

def owner_id(name):
    return owner_state(name)['user']['id']


def cmd_answered(args):
    """Until fake-model.py's answer quoting MARKER is in one of NAME's sessions, then that work's times."""
    owner = to_uuid(owner_id(args.name))
    needle = f'Answering: {args.marker}'
    deadline = time.monotonic() + args.timeout
    while True:
        rows = sql_json(f"select e.session_id, e.seq, e.type, e.created_at, e.ingested_at, e.ingested_by_runner_id from run_event e "
                        f"join session s on s.id = e.session_id where s.owner_id = {quote(owner)} and e.payload::text like "
                        f"{quote('%' + needle + '%')} order by e.ingested_at limit 1")
        if rows or time.monotonic() > deadline:
            break
        time.sleep(1)
    if not rows:
        out({'owner': args.name, 'marker': args.marker, 'timeout': args.timeout, 'answered': False})
        raise SystemExit(f'no answer quoting {args.marker} within {args.timeout} s')
    event = rows[0]
    session = event['session_id']
    turns = sql_json(f"select id, seq, client_turn_id, kind, status, created_at, delivered_at, answered_at, left(content, 160) as content "
                     f"from conversation_turn where session_id = {quote(session)} and content like {quote('%' + args.marker + '%')} order by seq")
    row = sql_json(f"select id, status, title, assigned_runner_id, task_id, provider, engine, retry_at, retry_attempts, created_at "
                   f"from session where id = {quote(session)}")[0]
    model = [json.loads(line) for line in (SERVER / 'logs/fake-model.jsonl').read_text().splitlines() if args.marker in line] \
        if (SERVER / 'logs/fake-model.jsonl').exists() else []
    out({'owner': args.name, 'marker': args.marker, 'answered': True, 'answerEvent': event, 'session': row, 'turns': turns,
         'modelRequests': [{k: m.get(k) for k in ('n', 'at', 'messages', 'kind', 'tool', 'apiErrors')} for m in model]})


def record_line():
    rows = sql_json('select m.owner_id, u.email, u.disabled_at, m.management_state, m.desired_state, m.generation, m.attempt, m.revision, '
                    "m.demand_revision, m.last_error->>'code' as reason, m.pod_uid, m.next_attempt_at, m.stop_requested_at, m.stop_acknowledged_at, "
                    "m.reservation->'compute' is not null and m.reservation->'compute' <> 'null'::jsonb as compute_held, "
                    f"r.status as runner_status, {sw.runner_last_beat('r')} as last_heartbeat_at, r.managed_workload "
                    'from managed_runner m join "user" u on u.id = m.owner_id join runner r on r.id = m.runner_id order by m.created_at')
    line = {}
    for m in rows:
        workload = m.get('managed_workload') or {}
        counts = '/'.join(str(workload.get(k, '-')) for k in ('activeTurns', 'backgroundJobs', 'operations', 'unflushedEvents'))
        line[name_of(m['email'])] = {
            'state': m['management_state'], 'desired': m['desired_state'], 'gen': m['generation'], 'attempt': m['attempt'], 'rev': m['revision'],
            'demand': m['demand_revision'], 'reason': m['reason'], 'pod': (m['pod_uid'] or '')[:8] or None,
            'drain': ('accepted' if m['stop_acknowledged_at'] else 'asked') if m['stop_requested_at'] else None,
            'compute': m['compute_held'], 'disabled': bool(m['disabled_at']), 'runner': m['runner_status'],
            'beat': (m['last_heartbeat_at'] or '')[11:19] or None, 'work': counts if workload else None,
            'idle': workload.get('idleSeconds') if workload else None,
        }
    sessions = sql_json('select u.email, s.id, s.status, s.retry_at is not null as retry_armed, s.retry_attempts, '
                        "(select count(*) from conversation_turn t where t.session_id = s.id and t.status = 'PENDING') as pending "
                        'from session s join "user" u on u.id = s.owner_id join managed_runner m on m.runner_id = s.assigned_runner_id '
                        'order by s.created_at')
    for s in sessions:
        entry = line.setdefault(name_of(s['email']), {}).setdefault('sessions', {})
        entry[s['id'][:8]] = s['status'] + (f"+{s['pending']}q" if s['pending'] else '') + (f"+retry{s['retry_attempts']}" if s['retry_armed'] else '')
    pool = sql_json('select cpu_millis_reserved, memory_bytes_reserved, pods_reserved, active_users_reserved, durable_bytes_reserved, revision from managed_runner_capacity')
    line['pool'] = [{k: v for k, v in p.items()} for p in pool]
    return line


def cluster_line(objects):
    pods = {}
    for pod in objects['pods']:
        if not pod['metadata']['name'].startswith('mr-'):
            continue
        statuses = pod['status'].get('containerStatuses') or []
        states = ','.join(f"{s['name']}:{next(iter((s.get('state') or {'?': 0}).keys()))}" for s in statuses)
        pods[pod['metadata']['name'][3:11]] = (f"{pod['metadata']['uid'][:8]}:{pod['status'].get('phase')}"
                                              f"{':deleting' if pod['metadata'].get('deletionTimestamp') else ''}:{states}")
    attachments = {va['spec']['source'].get('persistentVolumeName', '?')[:12]: bool((va.get('status') or {}).get('attached'))
                   for va in objects['attachments']}
    return {'pods': pods, 'attachments': attachments}


def cmd_record_loop(args):
    deadline, last = time.monotonic() + args.seconds, None
    while time.monotonic() < deadline:
        try:
            line = record_line()
            line['k8s'] = cluster_line(ml.cluster_objects())
            line['gate'] = ml.gate_connections()
        except (Exception, SystemExit) as error:  # the database or the guest (sql() exits): say so and look again
            line = {'error': str(error)[-200:]}
        compare = {k: v for k, v in line.items() if k != 'gate'}
        if compare != last:
            print(json.dumps({'at': now(), **line}, sort_keys=True), flush=True)
            last = compare
        time.sleep(1)


def cmd_record(args):
    log = SERVER / 'timeline.jsonl'
    if args.action == 'start':
        if ml.active(RECORDER_UNIT) != 'active':
            subprocess.run(['systemd-run', f'--unit={RECORDER_UNIT}', '--collect', '--quiet', '-p', 'MemoryMax=256M',
                            '-p', f'Environment=LAB_TEST_SERVER_DIR={SERVER}', '-p', f'StandardOutput=append:{log}', '-p', f'StandardError=append:{log}',
                            sys.executable, '-I', str(Path(__file__)), 'record-loop', str(args.seconds)], check=True)
    else:
        ml.systemd('stop', RECORDER_UNIT, check=False)
    out({'at': now(), 'unit': ml.active(RECORDER_UNIT), 'log': str(log), 'lines': len(log.read_text().splitlines()) if log.exists() else 0})


def cmd_until(args):
    deadline, seen = time.monotonic() + args.timeout, []
    while True:
        try:
            m = ml.mapping_of(args.name)
            line = {k: m[k] for k in ('management_state', 'desired_state', 'generation', 'attempt', 'revision', 'demand_revision')}
            line['reason'] = (m['last_error'] or {}).get('code')
            line['pod'] = (m['pod_uid'] or '')[:8] or None
            line['drain'] = ('accepted' if m['stop_acknowledged_at'] else 'asked') if m['stop_requested_at'] else None
        except SystemExit as error:  # no mapping yet
            line = {'error': str(error)}
        if not seen or seen[-1][1] != line:
            seen.append((now(), line))
        if line.get('management_state') == args.state and (args.reason is None or line['reason'] == args.reason) \
                and line['generation'] > args.gen_above:
            break
        if time.monotonic() > deadline:
            out({'owner': args.name, 'timeout': args.timeout, 'changes': seen})
            raise SystemExit(f'{args.name} not {args.state}/{args.reason} within {args.timeout} s')
        time.sleep(0.5)
    out({'owner': args.name, 'reached': {'state': args.state, 'reason': args.reason}, 'at': now(), 'changes': seen})


def snapshot(name):
    m = ml.mapping_of(name)
    objects = ml.cluster_objects()
    runner = m['runner_id']
    pvc = next((p for p in objects['pvcs'] if p['metadata']['name'] == m['pvc_name']), None)
    pv = next((p for p in objects['pvs'] if pvc and p['metadata']['name'] == pvc['spec'].get('volumeName')), None)
    pod = next((p for p in objects['pods'] if p['metadata']['name'] == f'mr-{runner}'), None)
    attachments = [va for va in objects['attachments'] if pv and va['spec']['source'].get('persistentVolumeName') == pv['metadata']['name']]
    runner_row = sql_json(f"select id, name, status, enrolled_at, {sw.runner_last_beat()} as last_heartbeat_at, "
                          f"left(token_hash, 12) as token_hash_prefix, capabilities "
                          f"from runner where id = {quote(runner)}")[0]
    workspace = sql_json(f"select id, name, runner_id, target_runner_id, work_dir, auto_init_git, enable_worktree from workspace "
                         f"where id = {quote(m['default_workspace_id'])}")[0]
    sessions = sql_json(f"select id, status, left(title, 50) as title, retry_at, retry_attempts, task_id from session "
                        f"where assigned_runner_id = {quote(runner)} order by created_at")
    return {
        'at': now(), 'owner': name,
        'mapping': {k: m.get(k) for k in ('id', 'management_state', 'desired_state', 'generation', 'revision', 'attempt', 'last_error',
                                          'pvc_name', 'pvc_uid', 'pv_uid', 'volume_handle', 'pod_name', 'pod_uid', 'node_name', 'reservation',
                                          'initial_provider', 'demand_revision', 'last_demand_at', 'state_entered_at')},
        'runner': runner_row, 'defaultWorkspace': workspace,
        'pvc': pvc and {'uid': pvc['metadata']['uid'], 'phase': pvc['status'].get('phase'), 'volumeName': pvc['spec'].get('volumeName'),
                        'createdAt': pvc['metadata']['creationTimestamp']},
        'pv': pv and {'uid': pv['metadata']['uid'], 'handle': pv['spec']['csi']['volumeHandle'],
                      'image': pv['spec']['csi']['volumeAttributes'].get('imageName'), 'reclaim': pv['spec'].get('persistentVolumeReclaimPolicy')},
        'attachments': [{'name': va['metadata']['name'], 'attached': (va.get('status') or {}).get('attached'),
                         'deleting': bool(va['metadata'].get('deletionTimestamp'))} for va in attachments],
        'pod': sw.pod_view(pod) if pod else None,
        'podsUsingTheClaim': [p['metadata']['name'] for p in objects['pods']
                              if any((v.get('persistentVolumeClaim') or {}).get('claimName') == m['pvc_name'] for v in p['spec'].get('volumes', []))],
        'sessions': sessions,
        'status': {k: v for k, v in ml.status_of(name).items() if k in ('managementState', 'desiredState', 'usable', 'reason', 'retryAfter',
                                                                         'heartbeatStatus', 'actions', 'revision')},
    }


def cmd_snapshot(args):
    view = snapshot(args.name)
    view['display'] = ml.display_of(ml.status_of(args.name))
    out(view)


def cmd_pool(_args):
    out({'at': now(), 'pool': sql_json('select * from managed_runner_capacity'),
         'reservations': [{'owner': m['owner'], 'state': m['management_state'], 'reservation': m['reservation']} for m in t06_mappings()]})


def cmd_turns(args):
    owner = to_uuid(owner_id(args.name))
    out({'at': now(), 'owner': args.name, 'turns': sql_json(
        f"select left(t.session_id::text, 8) as session, t.seq, left(t.client_turn_id, 24) as client_turn, t.kind, t.status, t.created_at, "
        f"t.delivered_at, t.answered_at, left(t.content, 70) as content from conversation_turn t join session s on s.id = t.session_id "
        f"where s.owner_id = {quote(owner)} order by t.created_at")})


def cmd_jobs(args):
    owner = to_uuid(owner_id(args.name))
    out({'at': now(), 'owner': args.name,
         'wakes': sql_json(f"select left(w.session_id::text, 8) as session, w.job_id, w.trigger, w.kind, w.command, w.status, w.exit_code, w.reason, "
                           f"w.created_at, w.updated_at from background_job_wake w join session s on s.id = w.session_id "
                           f"where s.owner_id = {quote(owner)} order by w.created_at"),
         'sessions': sql_json(f"select left(id::text, 8) as session, status, running_bg_jobs, running_bg_shells, engine_turn_active from session "
                              f"where owner_id = {quote(owner)} and (cardinality(running_bg_jobs) > 0 or cardinality(running_bg_shells) > 0 "
                              f"or engine_turn_active)")})


# ---- data on the volume ----------------------------------------------------------------------------

PROBE = r'''
import hashlib, json, os, sqlite3, subprocess, sys
action, root = sys.argv[1], sys.argv[2]
os.makedirs(root, exist_ok=True)
db = os.path.join(root, 'rows.sqlite')
blob = os.path.join(root, 'random.bin')
repo = os.path.join(root, 'repo')
if action == 'write':
    with open(blob, 'wb') as f:
        f.write(os.urandom(8 * 1024 * 1024)); f.flush(); os.fsync(f.fileno())
    c = sqlite3.connect(db)
    c.execute('pragma journal_mode=wal'); c.execute('pragma synchronous=full')
    c.execute('create table if not exists r (n integer primary key, v text)')
    for n in range(500):
        c.execute('insert into r (v) values (?)', (hashlib.sha256(os.urandom(16)).hexdigest(),))
        c.commit()
    c.close()
    subprocess.run(['git', 'init', '-q', repo], check=True)
    with open(os.path.join(repo, 'note.txt'), 'w') as f:
        f.write('T06 probe ' + root + '\n')
    subprocess.run(['git', '-C', repo, 'add', '.'], check=True)
    subprocess.run(['git', '-C', repo, 'commit', '-q', '-m', 'T06 probe'], check=True)
c = sqlite3.connect(db)
rows = c.execute('select count(*), coalesce(max(n), 0) from r').fetchone()
digest = hashlib.sha256(''.join(v for (v,) in c.execute('select v from r order by n')).encode()).hexdigest()
check = c.execute('pragma integrity_check').fetchone()[0]
c.close()
head = subprocess.run(['git', '-C', repo, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
fsck = subprocess.run(['git', '-C', repo, 'fsck', '--full'], capture_output=True, text=True).returncode
mount = [l.split()[:3] for l in open('/proc/mounts') if ' /var/lib/orbit ' in l]
print(json.dumps({'randomSha256': hashlib.sha256(open(blob, 'rb').read()).hexdigest(), 'rows': rows[0], 'maxRow': rows[1],
                  'rowsSha256': digest, 'integrityCheck': check, 'gitHead': head, 'gitFsckExit': fsck, 'mount': mount}))
'''

IDENTITY = r'''
import json, pathlib
orbit = pathlib.Path('/var/lib/orbit/home/.orbit')
def read(name):
    p = orbit / name
    return json.loads(p.read_text()) if p.exists() else None
config = read('config.json') or {}
repos = pathlib.Path('/var/lib/orbit/home/orbit-repos')
print(json.dumps({'runnerId': config.get('runnerId'), 'managedInstance': read('managed-instance.json'),
                  'worktrees': sorted(p.name for p in (orbit / 'worktrees').iterdir()) if (orbit / 'worktrees').exists() else [],
                  'repos': sorted(p.name for p in repos.iterdir()) if repos.exists() else []}))
'''


def cmd_probe(args):
    m, pod = ml.running_pod(args.name)
    root = f'{PROBE_ROOT}/{args.run}'
    if not re.fullmatch(r'[a-z0-9-]+', args.run):
        raise SystemExit('RUN: lowercase letters, digits and hyphens')
    name = pod['metadata']['name']
    result = json.loads(sw.pod_exec(name, 'python3', '-c', PROBE, args.action, root).stdout)
    identity = json.loads(sw.pod_exec(name, 'python3', '-c', IDENTITY).stdout)
    found = owner_state(args.name)
    probes = found.setdefault('probes', {})
    view = {'at': now(), 'owner': args.name, 'action': args.action, 'run': args.run, 'pod': pod['metadata']['uid'],
            'generation': m['generation'], 'data': result, 'volume': identity}
    if args.action == 'write':
        probes[args.run] = view
        save(args.name, found)
    else:
        written = probes.get(args.run)
        if not written:
            raise SystemExit(f'no probe {args.run} written')
        same = {k: written['data'][k] == result[k] for k in ('randomSha256', 'rows', 'rowsSha256', 'gitHead')}
        view.update(writtenAt=written['at'], writtenByGeneration=written['generation'], writtenByPod=written['pod'], same=same,
                    sameRunnerId=written['volume']['runnerId'] == identity['runnerId'], allSame=all(same.values()) and result['integrityCheck'] == 'ok')
    out(view)
    if args.action == 'check' and not view['allSame']:
        raise SystemExit(1)


# ---- the administrator and the cluster ---------------------------------------------------------------

def cmd_disable(args):
    admin = admin_state()
    target = owner_state(args.name)
    at = now()
    status, answer = http('PATCH', f"/admin/users/{target['user']['id']}/disabled", {'disabled': args.action == 'on'}, token=admin['accessToken'])
    out({'at': at, 'owner': args.name, 'disabled': args.action == 'on', 'status': status,
         'answer': {k: answer.get(k) for k in ('id', 'email', 'disabledAt')} if isinstance(answer, dict) else answer})


def cmd_quota(args):
    quota = {'apiVersion': 'v1', 'kind': 'ResourceQuota', 'metadata': {'name': QUOTA, 'namespace': NAMESPACE,
                                                                     'labels': {'orbit.dev/lab': 't06'}}, 'spec': {'hard': {'pods': '0'}}}
    at = now()
    if args.action == 'on':
        sw.kubectl('apply', '-f', '-', input=json.dumps(quota))
    else:
        sw.kubectl('delete', 'resourcequota', QUOTA, '--ignore-not-found')
    out({'at': at, 'quota': args.action, 'now': sw.kget('resourcequota', QUOTA)})


# ---- the switch unset or false -----------------------------------------------------------------------

def cmd_off_check(args):
    switch = [line for line in (SERVER / 'secrets/api.env').read_text().splitlines() if line.startswith('ORBIT_MANAGED_RUNNERS_')]
    connections, before = ml.gate_connections(), ml.namespace_snapshot()
    rows_before = sql_json(f'select {MAPPING_COLUMNS} from managed_runner order by id')
    pool_before = sql_json('select * from managed_runner_capacity')
    started = now()
    demands = []
    for item in args.message:
        name, _, session = item.partition(':')
        demands.append({'owner': name, **new_turn(name, session, f'T06-OFF-{args.label.upper()}-{session[:6].upper()} a message while the switch is {args.label}')})
    for name in args.task:
        result = new_task(name, f'T06-OFF-{args.label.upper()}-TASK a task run while the switch is {args.label}', run_now=True)
        remember(name, [result])
        demands.append({'owner': name, **result})
    writes = {}
    for name in sorted({d['owner'] for d in demands}):
        token = owner_state(name)['accessToken']
        writes[name] = {}
        for action in ('ensure', 'retry', 'wake', 'sleep', 'delete'):
            code, answer = http('POST', f'/managed-runner/{action}', {'idempotencyKey': str(uuid.uuid4()), 'revision': 1}, token=token)
            writes[name][action] = {'status': code, 'code': answer.get('code') if isinstance(answer, dict) else None}
    time.sleep(args.seconds)
    after = ml.namespace_snapshot()
    rows_after = sql_json(f'select {MAPPING_COLUMNS} from managed_runner order by id')
    log = (SERVER / 'logs/apiserver.log').read_text(errors='replace').splitlines()
    result = {'at': started, 'label': args.label, 'switch': switch or ['(unset)'], 'demands': demands, 'ownerWrites': writes,
              'waitedSeconds': args.seconds, 'mappingRows': len(rows_after), 'mappingsUnchanged': rows_before == rows_after,
              'changedMappings': [b['id'] for b, a in zip(rows_before, rows_after) if a != b],
              'poolUnchanged': pool_before == sql_json('select * from managed_runner_capacity'),
              'gateConnectionsDuring': ml.gate_connections() - connections, 'apiserverSocketsToTheApi': ml.api_sockets(),
              'namespaceUnchanged': before == after, 'namespaceObjects': len(after), 'changed': sorted(set(before) ^ set(after)),
              'managedLogLines': [line[-220:] for line in log if 'anaged' in line][-12:]}
    out(result)
    if not (result['mappingsUnchanged'] and result['namespaceUnchanged'] and result['poolUnchanged'] and not result['gateConnectionsDuring']):
        raise SystemExit(1)


# ---- the timeline ----------------------------------------------------------------------------------

def cmd_summary(args):
    path = SERVER / 'timeline.jsonl'
    lines = [json.loads(line) for line in path.read_text().splitlines() if line.startswith('{')] if path.exists() else []
    lines = [line for line in lines if line['at'] >= (args.since or '') and 'error' not in line]
    changes, last = {}, {}
    for line in lines:
        for owner, value in line.items():
            if not isinstance(value, dict) or 'state' not in value:
                continue
            key = (value['state'], value['gen'], value['reason'], value['drain'], value['pod'])
            if last.get(owner) != key:
                changes.setdefault(owner, []).append({'at': line['at'], 'state': value['state'], 'gen': value['gen'], 'reason': value['reason'],
                                                      'drain': value['drain'], 'pod': value['pod'], 'attempt': value['attempt']})
                last[owner] = key
    pods, last_pods = [], None
    for line in lines:
        current = (line.get('k8s') or {}).get('pods')
        if current != last_pods:
            pods.append({'at': line['at'], 'pods': current, 'attachments': (line.get('k8s') or {}).get('attachments')})
            last_pods = current
    out({'since': args.since, 'lines': len(lines), 'states': changes, 'pods': pods})


GATE_BANDS = (('PVC create', 1590, 1650), ('Secret create', 1650, 1720), ('Pod create', 3950, 4100), ('admission probe', 4100, 4250))


def cmd_gate_summary(args):
    path = ml.GATE_DIR / 'api-gate.jsonl'
    lines = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    picked = [c for c in lines if c['at'] >= args.since and (args.until is None or c['at'] <= args.until)]
    kinds, sizes = {}, {}
    for connection in picked:
        largest = max((length for kind, length in connection['records'] if kind == 23), default=0)
        kind = next((name for name, low, high in GATE_BANDS if low <= largest < high), 'other (reads, patches, deletes)')
        kinds[kind] = kinds.get(kind, 0) + 1
        sizes[largest] = sizes.get(largest, 0) + 1
    out({'at': now(), 'since': args.since, 'until': args.until, 'connections': len(picked), 'byKind': kinds,
         'largestRecordSizes': dict(sorted(sizes.items()))})


PASS_THROUGH = ('gate', 'replica', 'status', 'action', 'view', 'consistency', 'watch', 'kill-runner', 'foreign')


def main():
    if len(sys.argv) > 1 and sys.argv[1] in PASS_THROUGH:
        require_own_server_dir()
        return ml.main()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('--image', required=True)
    prepare.add_argument('--from', dest='source', default=str(sw.LAB_DIR / 'test-server-t02a'))
    account = sub.add_parser('account')
    account.add_argument('name')
    account.add_argument('--no-signin', action='store_true')
    sub.add_parser('key').add_argument('name')
    sub.add_parser('selfhost').add_argument('name')
    dispatch = sub.add_parser('selfhost-dispatch')
    dispatch.add_argument('name')
    dispatch.add_argument('--label', required=True)
    session = sub.add_parser('session')
    session.add_argument('name')
    session.add_argument('--prompt', required=True)
    session.add_argument('--title')
    message = sub.add_parser('message')
    message.add_argument('name')
    message.add_argument('sessions', nargs='+')
    message.add_argument('--prompt', required=True)
    burst = sub.add_parser('burst')
    burst.add_argument('name')
    burst.add_argument('--prompt', required=True)
    burst.add_argument('--messages', type=lambda v: [s for s in v.split(',') if s])
    burst.add_argument('--sessions', type=int, default=0)
    burst.add_argument('--tasks', type=int, default=0)
    task = sub.add_parser('task')
    task.add_argument('name')
    task.add_argument('--prompt', required=True)
    task.add_argument('--title')
    task.add_argument('--run-now', action='store_true')
    task.add_argument('--run-at-seconds', type=int)
    answered = sub.add_parser('answered')
    answered.add_argument('name')
    answered.add_argument('marker')
    answered.add_argument('--timeout', type=int, default=300)
    until = sub.add_parser('until')
    until.add_argument('name')
    until.add_argument('state')
    until.add_argument('--reason')
    until.add_argument('--gen-above', type=int, default=-1)
    until.add_argument('--timeout', type=int, default=300)
    sub.add_parser('snapshot').add_argument('name')
    sub.add_parser('pool')
    sub.add_parser('turns').add_argument('name')
    sub.add_parser('jobs').add_argument('name')
    probe = sub.add_parser('probe')
    probe.add_argument('name')
    probe.add_argument('action', choices=('write', 'check'))
    probe.add_argument('run')
    disable = sub.add_parser('disable')
    disable.add_argument('name')
    disable.add_argument('action', choices=('on', 'off'))
    sub.add_parser('quota').add_argument('action', choices=('on', 'off'))
    off = sub.add_parser('off-check')
    off.add_argument('--label', required=True)
    off.add_argument('--seconds', type=int, default=60)
    off.add_argument('--message', action='append', default=[])
    off.add_argument('--task', action='append', default=[])
    record = sub.add_parser('record')
    record.add_argument('action', choices=('start', 'stop'))
    record.add_argument('--seconds', type=int, default=21600)
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    summary = sub.add_parser('summary')
    summary.add_argument('--since')
    gate_summary = sub.add_parser('gate-summary')
    gate_summary.add_argument('--since', required=True)
    gate_summary.add_argument('--until')
    args = parser.parse_args()
    if args.command not in ('record-loop',):
        require_own_server_dir()
    {'prepare': cmd_prepare, 'account': cmd_account, 'key': cmd_key, 'selfhost': cmd_selfhost, 'selfhost-dispatch': cmd_selfhost_dispatch,
     'session': cmd_session, 'message': cmd_message, 'burst': cmd_burst, 'task': cmd_task, 'answered': cmd_answered, 'until': cmd_until,
     'snapshot': cmd_snapshot, 'pool': cmd_pool, 'turns': cmd_turns, 'jobs': cmd_jobs, 'probe': cmd_probe, 'disable': cmd_disable,
     'quota': cmd_quota, 'off-check': cmd_off_check, 'record': cmd_record, 'record-loop': cmd_record_loop, 'summary': cmd_summary,
     'gate-summary': cmd_gate_summary}[args.command](args)


if __name__ == '__main__':
    main()
