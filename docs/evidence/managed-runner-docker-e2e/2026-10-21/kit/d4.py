#!/usr/bin/env python3
"""D4's end-to-end driver (task 34hJ7RzpqTB13BmLR8uQv): accounts, sign-ins, the managed runner's state, a model key, sessions,
the database against Docker, cross-account requests and the data on a runner's volume, on the stack stack.sh runs.

Every command prints one JSON record and appends it to records/steps.jsonl. Passwords, tokens and the model key stay in
state/ (0700) or are read from their file at the moment they are sent; no record carries them.

  d4.py admin                                   the first account (POST /auth/bootstrap, itself a sign-in)
  d4.py account NAME                            the administrator makes NAME (POST /admin/users); no sign-in
  d4.py signin NAME [--parallel N] [--label L]  N sign-ins at once (POST /auth/login)
  d4.py watch NAME --until S[,S] [--timeout T]  GET /managed-runner once a second, with the container, until a state
  d4.py key NAME                                NAME's DeepSeek key as its own provider (POST /providers/mine)
  d4.py session NAME --prompt-file F            a session in NAME's default workspace, nothing named
  d4.py turn NAME SESSION --text-file F         the next message of a session
  d4.py wait NAME SESSION --answers N           until the session has N answers and its turn has ended
  d4.py binding NAME                            the runner's heartbeat and the default workspace's runner
  d4.py write NAME ACTION                       POST /managed-runner/ACTION as NAME (sleep, wake, ensure, retry)
  d4.py inventory LABEL                         the database's mappings against Docker's containers and volumes
  d4.py cross VICTIM STRANGER                   STRANGER tries every door at VICTIM's runner, workspace and volume
  d4.py channel-cross VICTIM STRANGER           the Docker channel, with the manager's token, asked to mix the two
  d4.py data seed|check NAME LABEL              files and SQLite on NAME's volume, through its running container
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

W = Path(os.environ.get('D4_DIR', '/mnt/data/tmp/34hJ7RzpqTB13BmLR8uQv'))
API = 'http://127.0.0.1:3714/api'
STATE = W / 'state'
RECORDS = W / 'records'
KEY_FILE = Path('/mnt/data/managed-runner-lab/secrets/deepseek-api-key')
EMAIL = '{}@d4.test'
DATA_DIR = '/var/lib/orbit/d4-data'


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def instance():
    return json.loads((W / 'mr/channel.json').read_text())['instanceId']


def out(step, record):
    record = {'step': step, 'at': record.pop('at', now()), **record}
    RECORDS.mkdir(parents=True, exist_ok=True)
    with (RECORDS / 'steps.jsonl').open('a') as f:
        f.write(json.dumps(record, default=str) + '\n')
    print(json.dumps(record, indent=1, default=str))
    return record


def http(method, path, body=None, token=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method)
    if data is not None:
        request.add_header('content-type', 'application/json')
    if token:
        request.add_header('authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw.decode(errors='replace')[:500]


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


def load(name):
    path = STATE / f'{name}.json'
    return json.loads(path.read_text()) if path.exists() else None


def save(name, found):
    private_write(STATE / f'{name}.json', json.dumps(found, indent=1))


def owner(name):
    found = load(name)
    if not found:
        raise SystemExit(f'no account {name}')
    return found


def psql(sql):
    """Rows as dicts, through the stack's own PostgreSQL container."""
    query = f"select coalesce(json_agg(t), '[]'::json) from ({sql}) t"
    text = subprocess.run(['docker', 'exec', 'd4-pg', 'psql', '-U', 'orbit', '-d', 'orbit', '-At', '-c', query],
                          check=True, capture_output=True, text=True).stdout
    return json.loads(text)


def docker_json(*args):
    text = subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout
    return json.loads(text) if text.strip() else []


# ---- accounts and sign-ins ----------------------------------------------------------------------

def sign_in(found):
    started = time.monotonic()
    at = now()
    status, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']})
    return {'at': at, 'ms': round((time.monotonic() - started) * 1000), 'status': status}, answer


def cmd_admin(args):
    if load('admin'):
        raise SystemExit('admin exists')
    found = {'email': EMAIL.format('admin'), 'password': uuid.uuid4().hex}
    started, at = time.monotonic(), now()
    status, answer = http('POST', '/auth/bootstrap', {**found, 'name': 'D4 admin'})
    if status not in (200, 201):
        raise SystemExit(f'bootstrap: {status} {answer}')
    found.update(admin=True, accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    save('admin', found)
    out('admin', {'at': at, 'status': status, 'ms': round((time.monotonic() - started) * 1000),
                  'user': {k: answer['user'].get(k) for k in ('id', 'email', 'role')}})


def cmd_account(args):
    if load(args.name):
        raise SystemExit(f'{args.name} exists')
    admin = owner('admin')
    found = {'email': EMAIL.format(args.name), 'password': uuid.uuid4().hex}
    status, answer = http('POST', '/admin/users', {**found, 'name': f'D4 {args.name}'}, token=admin['accessToken'])
    if status not in (200, 201):
        raise SystemExit(f'admin/users: {status} {answer}')
    found['user'] = answer.get('user', answer)
    save(args.name, found)
    user_id = found['user'].get('id')
    out('account', {'owner': args.name, 'status': status, 'user': {k: found['user'].get(k) for k in ('id', 'email', 'role')},
                    'managedRunnerRowsBeforeSignIn': psql(f"select count(*) as n from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{found['email']}'")[0]['n'],
                    'publicId': user_id})


def cmd_signin(args):
    found = owner(args.name)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        answers = list(pool.map(lambda _: sign_in(found), range(args.parallel)))
    good = [(t, a) for t, a in answers if t['status'] in (200, 201)]
    if good:
        last = good[-1][1]
        found.update(accessToken=last['accessToken'], refreshToken=last['refreshToken'], user=last['user'])
        save(args.name, found)
    tokens_work = []
    for _, answer in good:
        status, me = http('GET', '/users/me', token=answer['accessToken'])
        tokens_work.append(status == 200 and isinstance(me, dict) and me.get('id') == found['user']['id'])
    out('signin', {'owner': args.name, 'label': args.label, 'parallel': args.parallel,
                   'signIns': [t for t, _ in answers], 'everyTokenIsTheAccount': all(tokens_work) and len(tokens_work) == len(good),
                   'counts': counts(found['email'])})


def counts(email):
    """What exists for one account: mappings, runners, workspaces, containers, volumes."""
    row = psql(f"""select (select count(*) from managed_runner m where m.owner_id = u.id) as mappings,
                          (select count(*) from runner r where r.owner_id = u.id) as runners,
                          (select count(*) from workspace w where w.owner_id = u.id) as workspaces,
                          u.id as user_id
                     from "user" u where u.email = '{email}'""")[0]
    inst = instance()
    names = subprocess.run(['docker', 'ps', '-a', '--filter', f'label=orbit.managed-runner.instance={inst}', '--filter',
                            f'label=orbit.managed-runner.owner={row["user_id"]}', '--format', '{{.Names}}'],
                           check=True, capture_output=True, text=True).stdout.split()
    volumes = subprocess.run(['docker', 'volume', 'ls', '-q', '--filter', f'label=orbit.managed-runner.instance={inst}', '--filter',
                              f'label=orbit.managed-runner.owner={row["user_id"]}'], check=True, capture_output=True, text=True).stdout.split()
    return {'mappings': row['mappings'], 'runners': row['runners'], 'workspaces': row['workspaces'],
            'containers': names, 'volumes': volumes}


# ---- the managed runner's state ------------------------------------------------------------------

def status_of(name):
    code, status = http('GET', '/managed-runner', token=owner(name)['accessToken'])
    if code != 200:
        raise SystemExit(f'GET /managed-runner as {name}: {code} {status}')
    return status


def view(status):
    reason = status.get('reason') or {}
    return {k: status.get(k) for k in ('managementState', 'desiredState', 'revision', 'usable', 'heartbeatStatus', 'lastHeartbeatAt',
                                       'initialProvider', 'firstSessionProvider', 'runnerId', 'workspaceId')} | \
        {'reason': reason.get('code') if isinstance(reason, dict) else reason}


def cmd_watch(args):
    wanted = set(args.until.split(','))
    deadline = time.monotonic() + args.timeout
    timeline = []
    last = None
    while True:
        status = status_of(args.name)
        current = view(status)
        docker_view = docker_runner_state(args.name)
        snapshot = {**current, 'container': docker_view}
        if snapshot != last:
            timeline.append({'at': now(), **snapshot})
            last = snapshot
        # An entry is a state (READY) or a state with its reason (STARTING:MODEL_UNAVAILABLE).
        reached = current['managementState'] in wanted or f"{current['managementState']}:{current['reason']}" in wanted
        if reached or time.monotonic() > deadline:
            break
        time.sleep(1)
    out('watch', {'owner': args.name, 'until': sorted(wanted), 'reached': reached, 'timeline': timeline})
    if not reached:
        raise SystemExit(1)


def mapping_of(name):
    rows = psql(f"""select m.id, m.runner_id, m.default_workspace_id, m.management_state, m.desired_state, m.generation, m.revision,
                           m.attempt, m.pvc_name, m.pvc_uid, m.volume_handle, m.pod_name, m.pod_uid, m.last_error->>'code' as reason,
                           m.initial_provider, m.state_entered_at
                      from managed_runner m join "user" u on u.id = m.owner_id where u.email = '{EMAIL.format(name)}'""")
    return rows[0] if rows else None


def docker_runner_state(name):
    mapping = mapping_of(name)
    if not mapping:
        return None
    inst = instance()
    rows = subprocess.run(['docker', 'ps', '-a', '--filter', f'label=orbit.managed-runner.instance={inst}', '--filter',
                           f'label=orbit.managed-runner.runner={mapping["runner_id"]}', '--format',
                           '{{.Names}} {{.State}} g{{.Label "orbit.managed-runner.generation"}} {{.Label "orbit.managed-runner.uid"}}'],
                          check=True, capture_output=True, text=True).stdout.strip().splitlines()
    volumes = subprocess.run(['docker', 'volume', 'ls', '-q', '--filter', f'label=orbit.managed-runner.instance={inst}', '--filter',
                              f'label=orbit.managed-runner.runner={mapping["runner_id"]}'], check=True, capture_output=True,
                             text=True).stdout.split()
    return {'containers': rows, 'volumes': volumes}


# ---- a model key, sessions ------------------------------------------------------------------------

def cmd_key(args):
    found = owner(args.name)
    key = KEY_FILE.read_text().strip()
    if not key:
        raise SystemExit(f'{KEY_FILE} is empty')
    body = {'label': 'DeepSeek (owner key, D4)', 'presetSlug': 'deepseek', 'baseUrl': 'https://api.deepseek.com/anthropic', 'apiKey': key}
    at = now()
    status, answer = http('POST', '/providers/mine', body, token=found['accessToken'])
    del key, body
    if status not in (200, 201):
        raise SystemExit(f'providers/mine: {status} {answer.get("code") if isinstance(answer, dict) else "?"}')
    found.setdefault('keys', {})[answer['slug']] = {'id': answer['id'], 'at': at}
    save(args.name, found)
    out('key', {'at': at, 'owner': args.name, 'status': status,
                'provider': {k: answer.get(k) for k in ('id', 'slug', 'label', 'presetSlug', 'runtime', 'baseUrl', 'defaultModel', 'enabled', 'engines')}})


def cmd_session(args):
    found = owner(args.name)
    status = status_of(args.name)
    body = {'workspaceId': status['workspaceId'], 'prompt': Path(args.prompt_file).read_text(), 'title': args.title}
    if args.permission_mode:
        body['permissionMode'] = args.permission_mode
    at = now()
    code, answer = http('POST', '/sessions', body, token=found['accessToken'])
    if code in (200, 201):
        found.setdefault('sessions', {})[answer['id']] = {'at': at}
        save(args.name, found)
    out('session', {'at': at, 'owner': args.name, 'status': code, 'request': {k: v for k, v in body.items() if k != 'prompt'} | {'promptFile': args.prompt_file},
                    'answer': {k: answer.get(k) for k in ('id', 'status', 'provider', 'engine', 'model', 'workspaceId', 'assignedRunnerId', 'permissionMode', 'code', 'message')}
                    if isinstance(answer, dict) else answer,
                    'managed': view(status)})
    if code not in (200, 201):
        raise SystemExit(1)


def cmd_turn(args):
    found = owner(args.name)
    at = now()
    code, answer = http('POST', f'/sessions/{args.session}/turns', {'clientTurnId': str(uuid.uuid4()), 'content': Path(args.text_file).read_text()},
                        token=found['accessToken'])
    out('turn', {'at': at, 'owner': args.name, 'session': args.session, 'status': code, 'textFile': args.text_file,
                 'answer': {k: answer.get(k) for k in ('id', 'status', 'seq', 'code', 'message')} if isinstance(answer, dict) else answer,
                 'managed': view(status_of(args.name)), 'container': docker_runner_state(args.name)})
    if code not in (200, 201, 202):
        raise SystemExit(1)


def answer_text(event):
    payload = event.get('payload') if isinstance(event.get('payload'), dict) else event
    for key in ('text', 'content', 'message'):
        value = payload.get(key) if isinstance(payload, dict) else None
        if isinstance(value, str) and value.strip():
            return value
    return json.dumps(payload)[:2000]


def session_events(token, session):
    events, after = [], 0
    while True:
        code, page = http('GET', f'/sessions/{session}/events/page?after={after}&limit=200', token=token)
        batch = page.get('events', []) if isinstance(page, dict) else []
        events.extend(batch)
        if len(batch) < 200:
            return events
        after = batch[-1].get('seq', after + len(batch))


def cmd_wait(args):
    token = owner(args.name)['accessToken']
    deadline = time.monotonic() + args.timeout
    timeline, last = [], None
    while True:
        code, session = http('GET', f'/sessions/{args.session}', token=token)
        current = {k: session.get(k) for k in ('status', 'runStatus', 'sessionState', 'runState', 'provider', 'engine', 'model',
                                                'assignedRunnerId', 'runtimeSessionId', 'endReason')} if code == 200 else {'http': code}
        events = session_events(token, args.session)
        answers = [e for e in events if e.get('type') in ('assistant', 'assistant_message', 'turn_end', 'result')]
        texts = [e for e in events if e.get('type') in ('assistant', 'assistant_message')]
        ends = [e for e in events if e.get('type') in ('turn_end', 'result')]
        snapshot = {**current, 'events': len(events), 'turnEnds': len(ends)}
        if snapshot != last:
            timeline.append({'at': now(), **snapshot, 'container': docker_runner_state(args.name)})
            last = snapshot
        settled = current.get('runStatus') not in ('PENDING', 'RUNNING', 'QUEUED', 'CLAIMED', 'STARTING')
        if (len(ends) >= args.answers and settled) or current.get('status') == 'FAILED' or time.monotonic() > deadline:
            break
        time.sleep(2)
    kinds = {}
    for event in events:
        kinds[event.get('type')] = kinds.get(event.get('type'), 0) + 1
    path = RECORDS / 'sessions' / f'{args.session}.events.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(events, indent=1))
    row = psql(f"select s.status, s.assigned_runner_id, s.provider, s.engine, s.model, s.runtime_session_id, s.workspace_id, s.created_at "
               f"from session s where s.id = (select id from session where workspace_id = (select default_workspace_id from managed_runner m "
               f"join \"user\" u on u.id = m.owner_id where u.email = '{EMAIL.format(args.name)}') order by created_at limit 1)")
    result = out('wait', {'owner': args.name, 'session': args.session, 'timeline': timeline, 'types': kinds,
                          'answers': [answer_text(e)[:1500] for e in texts][-args.show:], 'turnEnds': [
                              {k: (e.get('payload') or {}).get(k) for k in ('isError', 'is_error', 'subtype', 'durationMs', 'model', 'stopReason')}
                              for e in ends], 'eventsFile': str(path.relative_to(W)), 'timedOut': time.monotonic() > deadline,
                          'firstSessionRow': row})
    if len(ends) < args.answers:
        raise SystemExit(1)


def cmd_binding(args):
    found = owner(args.name)
    status = status_of(args.name)
    code, runners = http('GET', '/runners', token=found['accessToken'])
    mine = [r for r in (runners if isinstance(runners, list) else runners.get('runners', [])) if r.get('id') == status['runnerId']] if code == 200 else []
    wcode, workspace = http('GET', f"/workspaces/{status['workspaceId']}", token=found['accessToken'])
    mapping = mapping_of(args.name)
    db = psql(f"""select r.id as runner_id, r.name, r.hostname, r.status, r.version, r.last_heartbeat_at,
                         w.id as workspace_id, w.name as workspace_name, w.runner_id as workspace_runner_id, w.work_dir
                    from managed_runner m join runner r on r.id = m.runner_id join workspace w on w.id = m.default_workspace_id
                   where m.id = '{mapping['id']}'""")[0]
    out('binding', {'owner': args.name, 'managed': view(status),
                    'runner': {k: (mine[0] if mine else {}).get(k) for k in ('id', 'name', 'status', 'lastHeartbeatAt', 'version', 'hostname', 'managed')},
                    'workspace': {'http': wcode, **({k: workspace.get(k) for k in ('id', 'name', 'runnerId', 'workDir')} if isinstance(workspace, dict) else {})},
                    'database': db,
                    'workspaceBoundToTheManagedRunner': db['workspace_runner_id'] == db['runner_id'] == mapping['runner_id'],
                    'container': docker_runner_state(args.name)})


def cmd_write(args):
    found = owner(args.name)
    status = status_of(args.name)
    body = {'idempotencyKey': f'{args.name}-{args.action}-{uuid.uuid4()}'}
    if args.action in ('sleep', 'retry'):
        body['revision'] = status['revision']
    at = now()
    code, answer = http('POST', f'/managed-runner/{args.action}', body, token=found['accessToken'])
    out('write', {'at': at, 'owner': args.name, 'action': args.action, 'status': code,
                  'before': view(status), 'answer': view(answer) if isinstance(answer, dict) and 'managementState' in answer else answer})


# ---- the database against Docker ---------------------------------------------------------------------

def cmd_inventory(args):
    inst = instance()
    mappings = psql("""select u.email, m.id, m.owner_id, m.runner_id, m.default_workspace_id, m.management_state, m.desired_state,
                              m.generation, m.revision, m.attempt, m.backend, m.cluster_key, m.pvc_name, m.pvc_uid, m.volume_handle,
                              m.pod_name, m.pod_uid, m.last_error->>'code' as reason, m.state_entered_at, w.runner_id as workspace_runner_id
                         from managed_runner m join "user" u on u.id = m.owner_id join workspace w on w.id = m.default_workspace_id
                        order by u.email""")
    users = psql('select u.email, u.id from "user" u order by u.email')
    runners = psql('select r.owner_id, count(*) as n from runner r group by r.owner_id')
    ids = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label=orbit.managed-runner.instance={inst}'], check=True,
                         capture_output=True, text=True).stdout.split()
    containers = docker_json('inspect', *ids) if ids else []
    names = subprocess.run(['docker', 'volume', 'ls', '-q', '--filter', f'label=orbit.managed-runner.instance={inst}'], check=True,
                           capture_output=True, text=True).stdout.split()
    volumes = docker_json('volume', 'inspect', *names) if names else []
    L = 'orbit.managed-runner.'
    by_container = {c['Name'].lstrip('/'): c for c in containers if c['Config']['Labels'].get(L + 'kind') == 'runner'}
    by_volume = {v['Name']: v for v in volumes}
    rows, problems = [], []
    for m in mappings:
        volume = by_volume.get(m['pvc_name'])
        vlabels = (volume or {}).get('Labels') or {}
        container = by_container.get(m['pod_name'] or f"mr-{m['runner_id']}")
        clabels = (container or {}).get('Config', {}).get('Labels', {}) if container else {}
        state = (container or {}).get('State', {})
        live = state.get('Status') in ('running', 'created', 'restarting', 'paused')
        checks = {
            'volume exists': volume is not None,
            'volume uid = pvc_uid': vlabels.get(L + 'uid') == m['pvc_uid'],
            'volume owner/runner = mapping': vlabels.get(L + 'owner') == m['owner_id'] and vlabels.get(L + 'runner') == m['runner_id'],
            'volume handle names it': m['volume_handle'] == f"docker:{inst}/{m['pvc_name']}/{m['pvc_uid']}",
            'workspace on the managed runner': m['workspace_runner_id'] == m['runner_id'],
        }
        if m['management_state'] in ('SLEEPING',):
            checks['no container while SLEEPING'] = container is None
        elif m['management_state'] in ('READY', 'STARTING', 'DRAINING'):
            checks['container exists'] = container is not None
            if container is not None:
                checks['container uid = pod_uid'] = clabels.get(L + 'uid') == m['pod_uid']
                checks['container generation = generation'] = clabels.get(L + 'generation') == str(m['generation'])
                checks['container on this volume'] = clabels.get(L + 'volume-uid') == m['pvc_uid']
                checks['container owner/runner = mapping'] = clabels.get(L + 'owner') == m['owner_id'] and clabels.get(L + 'runner') == m['runner_id']
                if m['management_state'] == 'READY':
                    checks['container running when READY'] = state.get('Status') == 'running'
        mounts = [x.get('Name') for x in (container or {}).get('Mounts', []) if x.get('Type') == 'volume']
        rows.append({'email': m['email'], 'state': m['management_state'], 'desired': m['desired_state'], 'generation': m['generation'],
                     'revision': m['revision'], 'reason': m['reason'], 'runner': m['runner_id'], 'volume': m['pvc_name'],
                     'pvc_uid': m['pvc_uid'], 'pod_uid': m['pod_uid'],
                     'docker': {'volume': bool(volume), 'volumeUid': vlabels.get(L + 'uid'), 'volumeCreated': (volume or {}).get('CreatedAt'),
                                'container': container['Name'].lstrip('/') if container else None,
                                'containerId': container['Id'][:12] if container else None,
                                'containerState': state.get('Status'), 'exitCode': state.get('ExitCode') if container else None,
                                'containerUid': clabels.get(L + 'uid'), 'containerGeneration': clabels.get(L + 'generation'),
                                'containerVolumeUid': clabels.get(L + 'volume-uid'), 'mounts': mounts,
                                'memoryBytes': (container or {}).get('HostConfig', {}).get('Memory'),
                                'nanoCpus': (container or {}).get('HostConfig', {}).get('NanoCpus'),
                                'pids': (container or {}).get('HostConfig', {}).get('PidsLimit')},
                     'checks': checks, 'agree': all(checks.values())})
        problems += [f"{m['email']}: {k}" for k, v in checks.items() if not v]
    mapped_volumes = {m['pvc_name'] for m in mappings}
    mapped_containers = {m['pod_name'] or f"mr-{m['runner_id']}" for m in mappings}
    stray_volumes = [v['Name'] for v in volumes if v['Labels'].get(L + 'kind') == 'data' and v['Name'] not in mapped_volumes]
    boot_volumes = [{'name': v['Name'], 'generation': v['Labels'].get(L + 'generation')} for v in volumes if v['Labels'].get(L + 'kind') != 'data']
    stray_containers = [n for n in by_container if n not in mapped_containers]
    per_volume = {}
    for c in containers:
        for x in c.get('Mounts', []):
            if x.get('Type') == 'volume' and (x.get('Name') or '').startswith('mr-data-'):
                per_volume.setdefault(x['Name'], []).append(c['Name'].lstrip('/'))
    one_per_owner = {u['email']: sum(1 for m in mappings if m['owner_id'] == u['id']) for u in users}
    runner_rows = {r['owner_id']: r['n'] for r in runners}
    result = {'label': args.label, 'instance': inst, 'accounts': len(users), 'mappings': len(mappings),
              'dockerContainers': len(by_container), 'dockerDataVolumes': sum(1 for v in volumes if v['Labels'].get(L + 'kind') == 'data'),
              'bootVolumes': boot_volumes, 'rows': rows, 'strayVolumes': stray_volumes, 'strayContainers': stray_containers,
              'containersPerDataVolume': per_volume, 'mappingsPerAccount': one_per_owner,
              'runnerRowsPerAccount': {u['email']: runner_rows.get(u['id'], 0) for u in users},
              'problems': problems, 'agree': not problems and not stray_volumes and not stray_containers
              and all(len(v) <= 1 for v in per_volume.values()) and all(n <= 1 for n in one_per_owner.values())}
    (RECORDS / 'inventory').mkdir(parents=True, exist_ok=True)
    (RECORDS / 'inventory' / f'{args.label}.json').write_text(json.dumps(result, indent=1, default=str))
    (RECORDS / 'inventory' / f'{args.label}.md').write_text(inventory_markdown(result))
    out('inventory', {'label': args.label, 'agree': result['agree'], 'problems': problems, 'strayVolumes': stray_volumes,
                      'strayContainers': stray_containers, 'table': inventory_markdown(result).splitlines()})


def inventory_markdown(result):
    lines = [f"Inventory `{result['label']}`: {result['mappings']} mappings; Docker: {result['dockerContainers']} runner containers, "
             f"{result['dockerDataVolumes']} data volumes (instance `{result['instance']}`). Agree: **{result['agree']}**.", '',
             '| account | state | gen | volume (DB) = Docker | volume UID (DB) = label | container (Docker) | container UID = pod_uid | gen label | state | agree |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for r in result['rows']:
        d = r['docker']
        lines.append(f"| {r['email']} | {r['state']} | {r['generation']} | {r['volume']} {'= present' if d['volume'] else '≠ (missing)'} | "
                     f"{(r['pvc_uid'] or '')[:8]} {'=' if d['volumeUid'] == r['pvc_uid'] else '≠'} {(d['volumeUid'] or '')[:8]} | "
                     f"{d['container'] or '(none)'} {d['containerId'] or ''} | "
                     f"{(r['pod_uid'] or '')[:8]} {'=' if d['containerUid'] == r['pod_uid'] else ('—' if not d['container'] else '≠')} {(d['containerUid'] or '')[:8]} | "
                     f"{d['containerGeneration'] or '—'} | {d['containerState'] or '—'} | {'yes' if r['agree'] else 'NO'} |")
    lines += ['', f"Stray data volumes (no mapping): {result['strayVolumes'] or 'none'}; stray runner containers: {result['strayContainers'] or 'none'}; "
                  f"boot volumes: {[b['name'] for b in result['bootVolumes']] or 'none'}.",
              f"Containers per data volume: { {k: len(v) for k, v in result['containersPerDataVolume'].items()} or 'none' }; "
              f"mappings per account: {result['mappingsPerAccount']}; runner rows per account: {result['runnerRowsPerAccount']}."]
    return '\n'.join(lines) + '\n'


# ---- cross-account requests -------------------------------------------------------------------------

def victim_snapshot(name):
    mapping = mapping_of(name)
    inst = instance()
    ids = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label=orbit.managed-runner.instance={inst}', '--filter',
                          f'label=orbit.managed-runner.runner={mapping["runner_id"]}'], check=True, capture_output=True, text=True).stdout.split()
    containers = [{'id': c['Id'][:12], 'name': c['Name'].lstrip('/'), 'state': c['State']['Status'], 'startedAt': c['State']['StartedAt'],
                   'generation': c['Config']['Labels'].get('orbit.managed-runner.generation'), 'uid': c['Config']['Labels'].get('orbit.managed-runner.uid')}
                  for c in (docker_json('inspect', *ids) if ids else [])]
    volume = docker_json('volume', 'inspect', mapping['pvc_name'])
    return {'mapping': {k: mapping[k] for k in ('management_state', 'desired_state', 'generation', 'revision', 'pvc_name', 'pvc_uid', 'pod_uid', 'attempt')},
            'containers': containers, 'volume': {k: volume[0].get(k) for k in ('Name', 'CreatedAt')} | {'uid': volume[0]['Labels'].get('orbit.managed-runner.uid')}}


def cmd_cross(args):
    victim, stranger = owner(args.victim), owner(args.stranger)
    v_status = status_of(args.victim)
    v_map = mapping_of(args.victim)
    s_map_before = mapping_of(args.stranger)
    token = stranger['accessToken']
    rid, wid, rev = v_status['runnerId'], v_status['workspaceId'], v_status['revision']
    before = victim_snapshot(args.victim)
    started = now()
    attempts = []

    def attempt(label, method, path, body=None, expect=None):
        code, answer = http(method, path, body, token=token)
        attempts.append({'what': label, 'request': f'{method} {path}', 'body': body, 'status': code,
                         'code': answer.get('code') if isinstance(answer, dict) else None,
                         'answer': view(answer) if isinstance(answer, dict) and 'managementState' in answer else
                         ({k: answer.get(k) for k in ('code', 'message', 'statusCode')} if isinstance(answer, dict) else answer),
                         'expected': expect})

    names = {'runnerId': rid, 'workspaceId': wid, 'ownerId': victim['user']['id'], 'revision': rev}
    attempt("read the victim's managed runner", 'GET', '/managed-runner', expect="the stranger's own")
    for action in ('wake', 'sleep', 'retry', 'delete', 'ensure'):
        attempt(f"{action}, naming the victim's runner, workspace, owner and revision", 'POST', f'/managed-runner/{action}',
                {'idempotencyKey': f'cross-{action}-{uuid.uuid4()}', **names}, expect="refused, or the stranger's own mapping only")
    attempt("the victim's runner", 'GET', f'/runners/{rid}', expect='404')
    attempt("rename the victim's runner", 'PATCH', f'/runners/{rid}', {'name': 'taken'}, expect='404')
    attempt("the victim's runner's engine installs", 'GET', f'/runners/{rid}/install', expect='404')
    attempt("install an engine on the victim's runner", 'POST', f'/runners/{rid}/install', {'engine': 'claude'}, expect='404')
    attempt("sign an engine in on the victim's runner", 'POST', f'/runners/{rid}/login', {'engine': 'claude'}, expect='404')
    attempt("self-update the victim's runner", 'POST', f'/runners/{rid}/self-update', {}, expect='404')
    attempt("rotate the victim's runner credential", 'POST', f'/runners/{rid}/rotate-token', {}, expect='404')
    attempt("the victim's default workspace", 'GET', f'/workspaces/{wid}', expect='404')
    attempt("point the victim's workspace elsewhere", 'PATCH', f'/workspaces/{wid}', {'name': 'taken', 'workDir': '/var/lib/orbit/x'}, expect='404')
    attempt("a workspace on the victim's runner", 'POST', '/workspaces', {'name': 'on-their-runner', 'runnerId': rid, 'workDir': '/var/lib/orbit/x'}, expect='refused')
    attempt("a session in the victim's workspace (it would wake the victim's runner)", 'POST', '/sessions',
            {'workspaceId': wid, 'prompt': 'hello', 'title': 'cross'}, expect='refused')
    attempt("a session assigned to the victim's runner", 'POST', '/sessions',
            {'assignedRunnerId': rid, 'prompt': 'hello', 'title': 'cross'}, expect='refused')
    attempt("switch the victim's volume (administrators only)", 'POST', f'/admin/managed-runners/{rid}/volume-switch',
            {'idempotencyKey': f'cross-switch-{uuid.uuid4()}', 'revision': rev, 'volumeUid': v_map['pvc_uid'], 'reason': 'cross-account test'},
            expect='403')
    attempt("delete the victim's default workspace", 'DELETE', f'/workspaces/{wid}', expect='404')
    attempt("delete the victim's runner", 'DELETE', f'/runners/{rid}', expect='404')
    time.sleep(3)
    after = victim_snapshot(args.victim)
    s_map_after = mapping_of(args.stranger)
    events = [json.loads(line) for line in (RECORDS / 'docker-events.jsonl').read_text().splitlines()
              if line.strip() and json.loads(line).get('Actor', {}).get('Attributes', {}).get('orbit.managed-runner.runner') == v_map['runner_id']
              and json.loads(line).get('time', 0) >= dt.datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp() - 1]
    out('cross', {'victim': args.victim, 'stranger': args.stranger, 'startedAt': started, 'attempts': attempts,
                  'victimBefore': before, 'victimAfter': after, 'victimUnchanged': before == after,
                  'dockerEventsOnVictimDuringAttempts': [{k: e.get(k) for k in ('Type', 'Action', 'time')} for e in events],
                  'strangerMappingBefore': {k: (s_map_before or {}).get(k) for k in ('management_state', 'revision', 'generation')},
                  'strangerMappingAfter': {k: (s_map_after or {}).get(k) for k in ('management_state', 'revision', 'generation')}})


def channel_call(method, path, body=None):
    """The Docker channel over its unix socket, with its token: the manager's own door, not an account's."""
    import http.client
    import socket

    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.connect(str(W / 'mr/channel.sock'))

    connection = Connection('channel', timeout=60)
    headers = {'authorization': 'Bearer ' + (W / 'mr/token').read_text().strip()}
    data = None
    if body is not None:
        data = json.dumps(body)
        headers['content-type'] = 'application/json'
    connection.request(method, path, body=data, headers=headers)
    response = connection.getresponse()
    raw = response.read()
    try:
        return response.status, json.loads(raw) if raw else None
    except ValueError:
        return response.status, raw.decode(errors='replace')[:300]


def cmd_channel_cross(args):
    """With the manager's own credential, the channel still ties each container to its own runner's volume."""
    victim, stranger = mapping_of(args.victim), mapping_of(args.stranger)
    channel = json.loads((W / 'mr/channel.json').read_text())
    profile = json.loads((W / 'mr/profile.json').read_text())
    users = {r['email']: r['id'] for r in psql('select u.email, u.id from "user" u')}
    request = {'name': f"mr-{stranger['runner_id']}", 'image': channel['image'], 'ownerId': users[EMAIL.format(args.stranger)],
               'runnerId': stranger['runner_id'], 'generation': stranger['generation'] + 1,
               'volume': {'name': stranger['pvc_name'], 'uid': stranger['pvc_uid']},
               'resources': {'cpuMillis': 1000, 'memoryBytes': 2 ** 30, 'pids': 1024, 'tmpBytes': 512 * 2 ** 20},
               'runner': {'serverUrl': profile['runner']['serverUrl'], 'maxConcurrent': 2}, 'dryRun': True}
    before = victim_snapshot(args.victim)
    checks = []

    def ask(what, method, path, body=None):
        code, answer = channel_call(method, path, body)
        checks.append({'what': what, 'request': f'{method} {path}', 'status': code,
                       'code': answer.get('code') if isinstance(answer, dict) else None,
                       'message': (answer.get('message') or '')[:200] if isinstance(answer, dict) else answer})

    ask("the stranger's runner on the victim's volume (dry run)", 'POST', '/v1/containers',
        {**request, 'volume': {'name': victim['pvc_name'], 'uid': victim['pvc_uid']}})
    ask("a container under the victim's runner's name for the stranger (dry run)", 'POST', '/v1/containers',
        {**request, 'name': f"mr-{victim['runner_id']}"})
    ask("stop the victim's container with the stranger's instance UID", 'POST',
        f"/v1/containers/mr-{victim['runner_id']}/stop?uid={stranger['pod_uid']}")
    ask("remove the victim's container with the stranger's instance UID", 'DELETE',
        f"/v1/containers/mr-{victim['runner_id']}?uid={stranger['pod_uid']}")
    ask("remove the victim's data volume, by its own UID", 'DELETE', f"/v1/volumes/{victim['pvc_name']}?uid={victim['pvc_uid']}")
    ask("the stranger's own runner on its own volume (dry run, the control)", 'POST', '/v1/containers', request)
    time.sleep(2)
    after = victim_snapshot(args.victim)
    out('channel-cross', {'victim': args.victim, 'stranger': args.stranger, 'checks': checks, 'victimUnchanged': before == after,
                          'victimAfter': after})


# ---- the data on a runner's volume ------------------------------------------------------------------

SEED = r'''
set -eu
D=%(dir)s
mkdir -p "$D"
head -c 4194304 /dev/urandom > "$D/blob-4m.bin"
head -c 65536 /dev/urandom > "$D/blob-64k.bin"
printf 'D4 note written %(at)s\n' > "$D/note.txt"
python3 - "$D/d4.sqlite" <<'PY'
import sqlite3, sys, os
db = sqlite3.connect(sys.argv[1])
db.execute('pragma journal_mode=wal')
db.execute('create table if not exists rows (id integer primary key, body text not null)')
db.executemany('insert into rows (body) values (?)', ((os.urandom(24).hex(),) for _ in range(5000)))
db.commit()
db.close()
PY
'''

CHECK = r'''
set -eu
D=%(dir)s
cd "$D"
python3 - <<'PY'
import hashlib, json, os, sqlite3, subprocess
files = {}
for name in sorted(os.listdir('.')):
    if os.path.isfile(name) and not name.endswith(('-wal', '-shm')):
        files[name] = hashlib.sha256(open(name, 'rb').read()).hexdigest()
db = sqlite3.connect('d4.sqlite')
integrity = db.execute('pragma integrity_check').fetchone()[0]
mode = db.execute('pragma journal_mode').fetchone()[0]
count = db.execute('select count(*) from rows').fetchone()[0]
digest = hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()
db.close()
print(json.dumps({'files': files, 'integrity': integrity, 'journalMode': mode, 'rows': count, 'dumpSha256': digest}))
PY
'''

RUNNER_DBS = r'''
set -eu
python3 - <<'PY'
import json, os, sqlite3
found = []
for root, dirs, names in os.walk('/var/lib/orbit'):
    if root.startswith('/var/lib/orbit/d4-data'):
        continue
    for name in names:
        if name.endswith(('.db', '.sqlite', '.sqlite3')):
            path = os.path.join(root, name)
            try:
                db = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
                result = db.execute('pragma quick_check').fetchone()[0]
                db.close()
            except Exception as error:
                result = f'{error.__class__.__name__}: {error}'
            found.append({'path': path, 'check': result})
print(json.dumps(found))
PY
'''


ENGINE = r"""
set -eu
python3 - "%(sid)s" "%(prefix)s" <<'PY2'
import glob, hashlib, json, sys
sid, prefix = sys.argv[1], int(sys.argv[2] or 0)
found = {}
for path in glob.glob('/var/lib/orbit/home/.claude/projects/*/' + sid + '.jsonl'):
    data = open(path, 'rb').read()
    found = {'path': path, 'bytes': len(data), 'lines': data.count(b'\n'), 'sha256': hashlib.sha256(data).hexdigest(),
             'prefixSha256': hashlib.sha256(data[:prefix]).hexdigest() if prefix else None}
first = []
for path in sorted(glob.glob('/var/lib/orbit/home/.orbit/worktrees/*/d4-first.txt')):
    data = open(path, 'rb').read()
    first.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'text': data.decode(errors='replace').strip()})
print(json.dumps({'engineSession': found, 'd4First': first}))
PY2
"""


def container_name(name):
    return f"mr-{mapping_of(name)['runner_id']}"


def in_runner(name, script):
    return subprocess.run(['docker', 'exec', '-i', '-u', '10001:10001', container_name(name), 'bash', '-s'], input=script,
                          check=True, capture_output=True, text=True).stdout


def cmd_data(args):
    at = now()
    if args.action == 'seed':
        in_runner(args.name, SEED % {'dir': DATA_DIR, 'at': at})
    check = json.loads(in_runner(args.name, CHECK % {'dir': DATA_DIR}).strip().splitlines()[-1])
    dbs = json.loads(in_runner(args.name, RUNNER_DBS).strip().splitlines()[-1])
    mapping = mapping_of(args.name)
    sid = psql(f"select runtime_session_id from session where workspace_id = '{mapping['default_workspace_id']}' "
               f"and runtime_session_id is not null order by created_at limit 1")
    sid = sid[0]['runtime_session_id'] if sid else ''
    prefix = 0
    if args.compare:
        prefix = json.loads((RECORDS / 'data' / f'{args.name}-{args.compare}.json').read_text()).get('engine', {}).get('engineSession', {}).get('bytes', 0)
    engine = json.loads(in_runner(args.name, ENGINE % {'sid': sid, 'prefix': prefix}).strip().splitlines()[-1]) if sid else {}
    record = {'at': at, 'owner': args.name, 'action': args.action, 'label': args.label,
              'container': container_name(args.name), 'generation': mapping['generation'], 'volume': mapping['pvc_name'],
              'volumeUid': mapping['pvc_uid'], 'seeded': check, 'runnerSqliteFiles': dbs, 'runtimeSessionId': sid, 'engine': engine}
    (RECORDS / 'data').mkdir(parents=True, exist_ok=True)
    (RECORDS / 'data' / f'{args.name}-{args.label}.json').write_text(json.dumps(record, indent=1))
    if args.compare:
        base = json.loads((RECORDS / 'data' / f'{args.name}-{args.compare}.json').read_text())
        record['sameAs'] = {'label': args.compare, 'files': base['seeded']['files'] == check['files'],
                            'rows': base['seeded']['rows'] == check['rows'], 'dump': base['seeded']['dumpSha256'] == check['dumpSha256'],
                            'generationThen': base['generation'], 'volumeUidSame': base['volumeUid'] == mapping['pvc_uid'],
                            'runtimeSessionIdSame': base.get('runtimeSessionId') == sid,
                            'engineSessionFileSame': (base.get('engine') or {}).get('engineSession', {}).get('path') == engine.get('engineSession', {}).get('path'),
                            'engineSessionAppendedOnly': (base.get('engine') or {}).get('engineSession', {}).get('sha256') == engine.get('engineSession', {}).get('prefixSha256'),
                            'd4FirstSame': (base.get('engine') or {}).get('d4First') == engine.get('d4First')}
    out('data', record)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('admin').set_defaults(fn=cmd_admin)
    s = sub.add_parser('account'); s.add_argument('name'); s.set_defaults(fn=cmd_account)
    s = sub.add_parser('signin'); s.add_argument('name'); s.add_argument('--parallel', type=int, default=1); s.add_argument('--label', default=''); s.set_defaults(fn=cmd_signin)
    s = sub.add_parser('watch'); s.add_argument('name'); s.add_argument('--until', required=True); s.add_argument('--timeout', type=int, default=600); s.set_defaults(fn=cmd_watch)
    s = sub.add_parser('key'); s.add_argument('name'); s.set_defaults(fn=cmd_key)
    s = sub.add_parser('session'); s.add_argument('name'); s.add_argument('--prompt-file', required=True); s.add_argument('--title', default='D4 first session')
    s.add_argument('--permission-mode'); s.set_defaults(fn=cmd_session)
    s = sub.add_parser('turn'); s.add_argument('name'); s.add_argument('session'); s.add_argument('--text-file', required=True); s.set_defaults(fn=cmd_turn)
    s = sub.add_parser('wait'); s.add_argument('name'); s.add_argument('session'); s.add_argument('--answers', type=int, default=1)
    s.add_argument('--timeout', type=int, default=600); s.add_argument('--show', type=int, default=3); s.set_defaults(fn=cmd_wait)
    s = sub.add_parser('binding'); s.add_argument('name'); s.set_defaults(fn=cmd_binding)
    s = sub.add_parser('write'); s.add_argument('name'); s.add_argument('action', choices=['sleep', 'wake', 'ensure', 'retry']); s.set_defaults(fn=cmd_write)
    s = sub.add_parser('inventory'); s.add_argument('label'); s.set_defaults(fn=cmd_inventory)
    s = sub.add_parser('cross'); s.add_argument('victim'); s.add_argument('stranger'); s.set_defaults(fn=cmd_cross)
    s = sub.add_parser('channel-cross'); s.add_argument('victim'); s.add_argument('stranger'); s.set_defaults(fn=cmd_channel_cross)
    s = sub.add_parser('data'); s.add_argument('action', choices=['seed', 'check']); s.add_argument('name'); s.add_argument('label')
    s.add_argument('--compare'); s.set_defaults(fn=cmd_data)
    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
