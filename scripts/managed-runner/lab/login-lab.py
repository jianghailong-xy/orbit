#!/usr/bin/env python3
"""Sign-in provisioning against the lab's real k3s (task T05): a new account's sign-in to its first
session, concurrent and repeated sign-ins, an existing account's landing and deep links, a
provisioning that fails and is retried, and the switch unset or `false`.

docs/managed-runner-lab.md, "Sign-in provisioning (T05)". It drives the test control plane of
test-server.sh (127.0.0.1 only) and the lab's context and namespace through T04's manager-lab.py,
whose commands it also passes through (gate, replica, status, action, view, consistency, watch,
stand-in-login, api-outage, ensure, foreign). LAB_TEST_SERVER_DIR must name test-server-t05. Every
command prints JSON and never a credential: owners' tokens and passwords, runner credentials, model
keys and the manager's token stay in files of mode 0600 there, in the lab's Secrets and in the test
server's provider store.

  prepare --image REF [--from DIR]  T02a's CA and webhook token, the manager's identity and the profile
                                (the gate as its API server, budget for three runners)
  account NAME [--no-signin]    the first is bootstrapped (the admin), the others opened through the
                                admin API and then signed in, each sign-in timed
  signin NAME [--parallel N] [--replica]
                                N concurrent sign-ins, every other one to replica b with --replica
  veteran NAME                  an account that already works: a self-managed runner (enrolled,
                                registered, one heartbeat), two workspaces the owner reordered and a
                                session in one of them
  landing NAME (--save|--check) GET /workspaces in order, the web's own landing rule over it
                                (src/web/src/lib/workspaceOrder.ts) and every saved deep link
                                (GET /workspaces/:id, GET /sessions/:id); --check compares with --save
  off-check NAME... --label L   with the switch unset or false: each NAME signs in (made first if new);
                                nothing managed is written for anyone, nothing in the namespace changes
                                and no connection reaches the gate
  key NAME (--fake|--key-file F)
                                a DeepSeek-preset model key on NAME's account: fake-model.py's endpoint
                                (not a model), or the owner's key read from F into the test server
  session NAME --prompt TEXT [--provider SLUG]
                                a session in NAME's managed default workspace; no provider named is
                                what a first session from a client sends
  wait-session NAME SESSION [--timeout S]
                                until its first turn has an answer; the session, the runner that ran it,
                                its events and what fake-model.py was sent
  provisioned NAME              NAME's provisioning as recorded: the sign-in, the mapping, its PVC, PV,
                                Secret and Pod, the runner's heartbeats and engine report, the default
                                workspace's binding and READY
  until NAME STATE [--reason CODE] [--timeout S]
                                wait until NAME's mapping is in STATE (with that cause), each change printed
  gate-summary --since TS [--until TS]
                                what the manager sent k3s in that window, by request size (T04's bands)
  intent-fault on|off           a trigger refusing every managed_runner insert in the test database:
                                a sign-in whose intent cannot be written
  record start|stop             a recorder unit: one line per change of any mapping, its runner's
                                heartbeat and engine report and its Pod (timeline.jsonl)
"""

import argparse
import concurrent.futures
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
EMAIL = 't05-{}@lab.invalid'
RECORDER_UNIT = 'orbit-mr-lab-t05-recorder'
INTENT_FAULT = 't05_refuse_managed_intent'
now = sw.now
out = sw.out
http = ml.http


def require_own_server_dir():
    # test-server-t05b is a second, fresh deployment: its first user's bootstrap with the switch on.
    if SERVER.name not in ('test-server-t05', 'test-server-t05b'):
        raise SystemExit(f'LAB_TEST_SERVER_DIR must be {sw.LAB_DIR}/test-server-t05 or -t05b (the other tasks\' databases stay untouched), not {SERVER}')


def t05_mappings(found=None):
    """manager-lab.py's mappings, named by this task's account names."""
    found = original_mappings() if found is None else found
    for m in found:
        match = re.fullmatch(r't05-([a-z0-9]+)@lab\.invalid', m.get('email') or '')
        if match:
            m['owner'] = match.group(1)
    return found


original_mappings = ml.mappings
ml.mappings = t05_mappings
ml.EMAIL = EMAIL
ml.require_own_server_dir = require_own_server_dir


def owner_state(name):
    return ml.owner_state(name)


def save(name, value):
    sw.private_write(STATE / f'{name}.json', value)


def ms_since(started):
    return round((time.monotonic() - started) * 1000, 1)


# ---- setup --------------------------------------------------------------------------------------

def cmd_prepare(args):
    require_own_server_dir()
    ml.cmd_prepare(args)
    profile = json.loads(sw.PROFILE.read_text())
    profile['resourceProfileId'] = 'orbit-mr-lab-t05'
    # Three runners at once, what the node holds: its allocatable is 3 CPU and 2592Mi, each runner asks 500m and 768Mi.
    profile['capacity'] = {'compute': {'cpu': '1500m', 'memory': '2304Mi', 'ephemeralStorage': '3Gi', 'pods': 3, 'attachments': 3},
                           'storage': {'usable': '14Gi', 'headroom': '2Gi'}, 'maxActiveUsers': 3}
    sw.private_write(sw.PROFILE, profile)
    out({'at': now(), 'profile': str(sw.PROFILE), 'value': profile})


# ---- accounts and sign-ins ----------------------------------------------------------------------

def admin_state():
    if not STATE.exists():
        return None
    return next((sw.state(p.stem) for p in sorted(STATE.glob('*.json')) if sw.state(p.stem).get('admin')), None)


def sign_in(found, port=None):
    started = time.monotonic()
    at = now()
    status, answer = http('POST', '/auth/login', {'email': found['email'], 'password': found['password']}, port=port)
    return {'at': at, 'ms': ms_since(started), 'status': status, 'port': port or int(sw.ENV['LAB_TEST_API_PORT'])}, answer


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
            status, answer = http('POST', '/auth/bootstrap', {**found, 'name': f'T05 lab {name}'})
            if status not in (200, 201):
                raise SystemExit(f'bootstrap: {status} {answer}')
            found.update(admin=True, accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
            found.setdefault('signIns', []).append({'at': at, 'ms': ms_since(started), 'status': status, 'bootstrap': True})
            save(name, found)
            out({'at': at, 'owner': name, 'admin': True, 'bootstrap': {'status': status, 'ms': found['signIns'][-1]['ms']},
                 'user': {k: answer['user'].get(k) for k in ('id', 'email')}})
            return
        status, answer = http('POST', '/admin/users', {**found, 'name': f'T05 lab {name}'}, token=admin['accessToken'])
        if status not in (200, 201):
            raise SystemExit(f'admin/users: {status} {answer}')
        found['user'] = answer.get('user', answer)
        created = True
        save(name, found)
        if args.no_signin:
            out({'at': now(), 'owner': name, 'created': True, 'signedIn': False})
            return
    timing, answer = sign_in(found)
    if timing['status'] not in (200, 201):
        raise SystemExit(f'sign-in {name}: {timing["status"]} {answer}')
    found.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    found.setdefault('signIns', []).append(timing)
    save(name, found)
    me = http('GET', '/users/me', token=found['accessToken'])
    out({'owner': name, 'created': created, 'signIn': timing, 'user': {k: answer['user'].get(k) for k in ('id', 'email')},
         'usersMe': {'status': me[0], 'id': (me[1] or {}).get('id') if isinstance(me[1], dict) else None}})


def cmd_signin(args):
    found = owner_state(args.name)
    replica = ml.REPLICA_PORT
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = [pool.submit(sign_in, found, replica if args.replica and i % 2 else None) for i in range(args.parallel)]
        answers = [f.result() for f in futures]
    good = [(t, a) for t, a in answers if t['status'] in (200, 201)]
    if good:
        last = good[-1][1]
        found.update(accessToken=last['accessToken'], refreshToken=last['refreshToken'])
    found.setdefault('signIns', []).extend(t for t, _ in answers)
    save(args.name, found)
    tokens_work = []
    for _, answer in good:
        status, me = http('GET', '/users/me', token=answer['accessToken'])
        tokens_work.append(status == 200 and isinstance(me, dict) and me.get('id') == found['user']['id'])
    out({'owner': args.name, 'parallel': args.parallel, 'replica': args.replica,
         'signIns': [t for t, _ in answers], 'everyTokenWorks': all(tokens_work) and len(tokens_work) == len(answers),
         'slowestMs': max(t['ms'] for t, _ in answers)})


# ---- an account that already works -------------------------------------------------------------

def cmd_veteran(args):
    found = owner_state(args.name)
    token = found['accessToken']
    status, enrollment = http('POST', '/runners/enrollment-tokens', {'label': f't05 {args.name} laptop'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'enrollment-tokens: {status} {enrollment}')
    status, registered = http('POST', '/runner/register', {'enrollmentToken': enrollment['token'], 'name': f'{args.name}-laptop',
                                                           'hostname': f'{args.name}-laptop.lab.invalid', 'version': '0.1.0', 'maxConcurrent': 2})
    if status not in (200, 201):
        raise SystemExit(f'runner/register: {status} {registered}')
    found['ownRunner'] = {'id': registered['runnerId'], 'token': registered['runnerToken']}
    beat = http('POST', '/runner/heartbeat', {'status': 'ONLINE', 'idleCapacity': 2, 'version': '0.1.0', 'runsAsRoot': False,
                                              'engines': [{'engine': 'claude', 'installed': True, 'version': '2.1.300', 'auth': 'yes'}]},
                token=registered['runnerToken'], headers={'x-orbit-runner-os': 'linux'})
    runners = http('GET', '/runners', token=token)[1]
    runner = next(r for r in runners if r['name'] == f'{args.name}-laptop')
    workspaces = []
    for name, work_dir in (('api', '/srv/api'), ('web', '/srv/web')):
        status, workspace = http('POST', '/workspaces', {'name': name, 'runnerId': runner['id'], 'workDir': work_dir}, token=token)
        if status not in (200, 201):
            raise SystemExit(f'workspaces: {status} {workspace}')
        workspaces.append(workspace)
    # The owner's own arrangement: web above api, the reverse of the order they were made in.
    reorder = http('POST', '/workspaces/reorder', {'ids': [workspaces[1]['id'], workspaces[0]['id']]}, token=token)
    status, session = http('POST', '/sessions', {'workspaceId': workspaces[0]['id'], 'prompt': 'existing work', 'title': 't05 existing work',
                                                 'provider': 'claude'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'sessions: {status} {session}')
    found['deepLinks'] = {'workspaces': [w['id'] for w in workspaces], 'sessions': [session['id']]}
    save(args.name, found)
    out({'at': now(), 'owner': args.name, 'runner': {k: runner.get(k) for k in ('id', 'name', 'status', 'online')},
         'heartbeat': beat[0], 'workspaces': [{k: w.get(k) for k in ('id', 'name', 'workDir', 'position')} for w in workspaces],
         'reorder': reorder[0], 'session': {k: session.get(k) for k in ('id', 'title', 'status', 'provider')}})


LANDING_PROBE = """
import { firstOpenableWorkspace, orderWorkspaces } from './src/lib/workspaceOrder.ts';
let s = '';
process.stdin.on('data', (c) => (s += c)).on('end', () => {
  const w = JSON.parse(s);
  console.log(JSON.stringify({ order: orderWorkspaces(w).map((x) => x.id), landing: firstOpenableWorkspace(w)?.id ?? null }));
});
"""


def web_landing(workspaces):
    """The web client's own rule (src/web/src/lib/workspaceOrder.ts), run by Node over the server's list."""
    result = subprocess.run(['node', '--input-type=module', '-e', LANDING_PROBE], cwd=REPO / 'src/web', input=json.dumps(workspaces),
                            capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'landing probe: {result.stderr.strip()[-400:]}')
    return json.loads(result.stdout)


# The fields of a workspace and a session the owner arranged or created, and the workspace's derived
# default (what its next session starts on). A session's run status is shown apart: it moves with its
# own runner, which a sign-in has nothing to do with.
WORKSPACE_KEYS = ('id', 'name', 'workDir', 'position', 'runnerId', 'targetRunnerId', 'createdAt', 'autoInitGit', 'enableWorktree',
                  'lastProvider', 'lastEngine')
SESSION_KEYS = ('id', 'title', 'workspaceId', 'assignedRunnerId', 'provider', 'engine', 'createdAt')


def landing_view(name):
    found = owner_state(name)
    token = found['accessToken']
    status, workspaces = http('GET', '/workspaces', token=token)
    if status != 200:
        raise SystemExit(f'GET /workspaces: {status} {workspaces}')
    links = {}
    for workspace_id in found.get('deepLinks', {}).get('workspaces', []):
        code, body = http('GET', f'/workspaces/{workspace_id}', token=token)
        links[f'/workspaces/{workspace_id}'] = {'status': code, 'body': {k: body.get(k) for k in WORKSPACE_KEYS} if code == 200 else body}
    runs = {}
    for session_id in found.get('deepLinks', {}).get('sessions', []):
        code, body = http('GET', f'/sessions/{session_id}', token=token)
        links[f'/sessions/{session_id}'] = {'status': code, 'body': {k: body.get(k) for k in SESSION_KEYS} if code == 200 else body}
        runs[session_id] = {k: body.get(k) for k in ('status', 'runStatus')} if code == 200 else None
    return {'list': [{k: w.get(k) for k in WORKSPACE_KEYS} for w in workspaces], 'web': web_landing(workspaces), 'deepLinks': links,
            'sessionRuns': runs}


def cmd_landing(args):
    view = landing_view(args.name)
    path = SERVER / 'landing' / f'{args.name}.json'
    if args.save:
        sw.private_write(path, view)
        out({'at': now(), 'owner': args.name, 'saved': str(path), **view})
        return
    saved = json.loads(path.read_text())
    before_ids = [w['id'] for w in saved['list']]
    kept = [w for w in view['list'] if w['id'] in before_ids]
    added = [w for w in view['list'] if w['id'] not in before_ids]
    order_before = [i for i in saved['web']['order']]
    order_now = [i for i in view['web']['order'] if i in before_ids]
    out({'at': now(), 'owner': args.name,
         'sameWorkspacesKept': kept == saved['list'],
         'sameOrderOfThoseWorkspaces': order_now == order_before,
         'added': added, 'addedSortLast': view['web']['order'][len(before_ids):] == [w['id'] for w in added],
         'webLandingBefore': saved['web']['landing'], 'webLandingNow': view['web']['landing'],
         'sameLanding': saved['web']['landing'] == view['web']['landing'],
         'deepLinksUnchanged': view['deepLinks'] == saved['deepLinks'],
         'deepLinks': {k: v['status'] for k, v in view['deepLinks'].items()},
         'differences': {k: {'before': saved['deepLinks'].get(k), 'now': v} for k, v in view['deepLinks'].items() if saved['deepLinks'].get(k) != v},
         'now': view})


# ---- the switch unset or false -------------------------------------------------------------------

def owner_counts():
    rows = sw.sql("select json_build_object('email', u.email, 'mappings', (select count(*) from managed_runner m where m.owner_id = u.id), "
                  "'runners', (select count(*) from runner r where r.owner_id = u.id), "
                  "'workspaces', (select count(*) from workspace w where w.owner_id = u.id)) from \"user\" u order by u.email")
    return {row['email']: {k: row[k] for k in ('mappings', 'runners', 'workspaces')} for row in map(json.loads, rows)}


def table_rows(query):
    return sw.sql(f'select row_to_json(t) from ({query}) t')


# What a sign-in could have made or changed: a runner's identity and credential, a workspace as the
# owner placed it, a mapping. Heartbeat columns move by themselves while a runner runs.
RUNNER_IDENTITY = 'select id, owner_id, name, token_hash, enrolled_at, max_concurrent from runner order by id'
WORKSPACE_PLACEMENT = 'select id, owner_id, name, runner_id, target_runner_id, work_dir, position, created_at from workspace order by id'
MAPPINGS = 'select id, owner_id, revision, management_state, desired_state, generation, pvc_uid, pod_uid from managed_runner order by id'


def cmd_off_check(args):
    switch = [line for line in (SERVER / 'secrets/api.env').read_text().splitlines() if line.startswith('ORBIT_MANAGED_RUNNERS_')]
    connections, before = ml.gate_connections(), ml.namespace_snapshot()
    counts_before = owner_counts()
    runners_before = table_rows(RUNNER_IDENTITY)
    workspaces_before = table_rows(WORKSPACE_PLACEMENT)
    mappings_before = table_rows(MAPPINGS)
    started = now()
    rows = []
    for name in args.names:
        existing = bool(sw.state(name))
        made = subprocess.run([sys.executable, '-I', str(Path(__file__)), 'account', name], capture_output=True, text=True, env=dict(os.environ))
        if made.returncode:
            raise SystemExit(f'account {name}: {made.stderr.strip()}')
        signed = json.loads(made.stdout)
        token = owner_state(name)['accessToken']
        status = http('GET', '/managed-runner', token=token)
        capabilities = http('GET', '/auth/capabilities', token=token)
        writes = {}
        for action in ('ensure', 'retry', 'wake', 'sleep', 'delete'):
            code, answer = http('POST', f'/managed-runner/{action}', {'idempotencyKey': str(uuid.uuid4()), 'revision': 1}, token=token)
            writes[action] = {'status': code, 'code': answer.get('code') if isinstance(answer, dict) else None}
        rows.append({'owner': name, 'account': 'existing' if existing else 'new', 'signIn': signed.get('signIn') or signed.get('bootstrap'),
                     'usersMe': signed.get('usersMe'), 'capabilities': capabilities[1],
                     'status': {'http': status[0], 'enabled': (status[1] or {}).get('enabled'), 'managementState': (status[1] or {}).get('managementState'),
                                'display': ml.display_of(status[1]) if status[0] == 200 else None},
                     'writes': writes})
    time.sleep(args.seconds)
    after = ml.namespace_snapshot()
    counts_after = owner_counts()
    signed = {EMAIL.format(name) for name in args.names}
    log = (SERVER / 'logs/apiserver.log').read_text(errors='replace').splitlines()
    result = {'at': started, 'label': args.label, 'switch': switch or ['(unset)'], 'signIns': rows,
              # Each account that signed in: what it held before (nothing, for a new one) and after.
              'signedInOwners': {email: {'before': counts_before.get(email, {'mappings': 0, 'runners': 0, 'workspaces': 0}),
                                         'after': counts_after.get(email)} for email in sorted(signed)},
              'mappingRows': len(table_rows(MAPPINGS)), 'mappingsUnchanged': mappings_before == table_rows(MAPPINGS),
              'runnerRowsUnchanged': runners_before == table_rows(RUNNER_IDENTITY),
              'workspaceRowsUnchanged': workspaces_before == table_rows(WORKSPACE_PLACEMENT),
              'waitedSeconds': args.seconds,
              'gateConnectionsDuring': ml.gate_connections() - connections, 'apiserverSocketsToTheApi': ml.api_sockets(),
              'namespaceUnchanged': before == after, 'namespaceObjects': len(after), 'changed': sorted(set(before) ^ set(after)),
              'managedLogLines': [line[-220:] for line in log if 'anaged' in line][-12:]}
    result['signedInOwnersUnchanged'] = all(v['before'] == v['after'] for v in result['signedInOwners'].values())
    out(result)
    if not (result['signedInOwnersUnchanged'] and result['mappingsUnchanged'] and result['runnerRowsUnchanged']
            and result['workspaceRowsUnchanged'] and result['namespaceUnchanged'] and not result['gateConnectionsDuring']):
        raise SystemExit(1)


# ---- a model key and a first session --------------------------------------------------------------

def cmd_key(args):
    found = owner_state(args.name)
    if args.fake:
        body = {'label': 'FAKE model (lab, not a model)', 'presetSlug': 'deepseek',
                'baseUrl': f"http://10.0.2.2:{sw.ENV['LAB_TEST_FAKE_MODEL_PORT']}/anthropic", 'apiKey': 'sk-lab-fake-model-not-a-key'}
    else:
        key = Path(args.key_file).read_text().strip()
        if not key:
            raise SystemExit(f'{args.key_file} is empty')
        body = {'label': 'DeepSeek (owner key, lab)', 'presetSlug': 'deepseek', 'baseUrl': 'https://api.deepseek.com/anthropic', 'apiKey': key}
    at = now()
    status, answer = http('POST', '/providers/mine', body, token=found['accessToken'])
    if status not in (200, 201):
        raise SystemExit(f'providers/mine: {status} {answer.get("code") if isinstance(answer, dict) else answer}')
    found.setdefault('keys', {})[answer['slug']] = {'id': answer['id'], 'kind': 'fake' if args.fake else 'deepseek', 'at': at}
    save(args.name, found)
    out({'at': at, 'owner': args.name, **{k: answer.get(k) for k in ('id', 'slug', 'label', 'presetSlug', 'runtime', 'baseUrl', 'defaultModel', 'enabled')}})


def default_workspace(name):
    status = ml.status_of(name)
    if not status.get('workspaceId'):
        raise SystemExit(f'{name} has no managed default workspace yet ({status.get("managementState")})')
    return status


def cmd_session(args):
    found = owner_state(args.name)
    status = default_workspace(args.name)
    body = {'workspaceId': status['workspaceId'], 'prompt': args.prompt, 'title': args.title or f't05 {args.name} first session'}
    if args.provider:
        body['provider'] = args.provider
    at = now()
    code, answer = http('POST', '/sessions', body, token=found['accessToken'])
    found.setdefault('sessions', {})
    if code in (200, 201):
        found['sessions'][answer['id']] = {'at': at, 'provider': args.provider, 'prompt': args.prompt}
        save(args.name, found)
    out({'at': at, 'owner': args.name, 'request': {k: v for k, v in body.items()}, 'status': code,
         'answer': {k: answer.get(k) for k in ('id', 'status', 'provider', 'engine', 'model', 'workspaceId', 'assignedRunnerId', 'code', 'message')}
         if isinstance(answer, dict) else answer,
         'managed': {k: status.get(k) for k in ('managementState', 'initialProvider', 'runnerId', 'workspaceId', 'usable')},
         'display': ml.display_of(status)})


def fake_model_lines(marker):
    path = SERVER / 'logs/fake-model.jsonl'
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if marker in line]


def cmd_wait_session(args):
    token = owner_state(args.name)['accessToken']
    deadline = time.monotonic() + args.timeout
    seen = []
    while True:
        code, session = http('GET', f'/sessions/{args.session}', token=token)
        view = {k: session.get(k) for k in ('status', 'runStatus', 'sessionState', 'runState', 'provider', 'engine', 'model',
                                            'assignedRunnerId', 'runtimeSessionId', 'endReason', 'error')} if code == 200 else {'http': code}
        if not seen or seen[-1][1] != view:
            seen.append((now(), view))
        page = http('GET', f'/sessions/{args.session}/events/page?after=0&limit=200', token=token)[1]
        events = page.get('events', []) if isinstance(page, dict) else []
        answered = [e for e in events if e.get('type') in ('assistant', 'assistant_message', 'message') and 'FAKE MODEL' in json.dumps(e)] \
            or [e for e in events if 'FAKE MODEL' in json.dumps(e) or (args.any_answer and e.get('type') in ('assistant', 'assistant_message'))]
        settled = view.get('runStatus') not in ('PENDING', 'RUNNING', 'QUEUED', None) or view.get('status') in ('FAILED', 'AWAITING_INPUT')
        if (answered and settled) or view.get('status') == 'FAILED' or time.monotonic() > deadline:
            break
        time.sleep(2)
    session_row = table_rows(f"select id, status, assigned_runner_id, provider, provider_builtin, engine, model, "
                             f"runtime_session_id, created_at from session where id = '{to_uuid(args.session)}'")
    kinds = {}
    for event in events:
        kinds[event.get('type')] = kinds.get(event.get('type'), 0) + 1
    prompt = (owner_state(args.name).get('sessions') or {}).get(args.session, {}).get('prompt') or ''
    marker = re.search(r'T05-[A-Z0-9-]+', prompt)
    result = {'at': now(), 'owner': args.name, 'session': args.session, 'timeline': seen, 'row': [json.loads(r) for r in session_row],
              'events': len(events), 'types': kinds, 'answers': [answer_text(e) for e in answered][:3],
              'fakeModelRequests': fake_model_lines(marker.group(0)) if marker else [], 'timedOut': time.monotonic() > deadline}
    sw.private_write(STATE / 'events' / f'{args.session}.json', json.dumps(events, indent=1))
    out(result)
    if not answered:
        raise SystemExit(1)


def answer_text(event):
    text = json.dumps(event)
    found = re.search(r'FAKE MODEL reply #\d+[^"\\]*', text)
    return found.group(0) if found else text[:300]


def to_uuid(public_id):
    if re.fullmatch(r'[0-9a-f-]{36}', public_id):
        return public_id
    script = "const {toUuid} = require(process.argv[1]); console.log(toUuid(process.argv[2]));"
    result = subprocess.run(['node', '-e', script, str(REPO / 'src/shared/dist/index.js'), public_id], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'toUuid: {result.stderr.strip()[-200:]}')
    return result.stdout.strip()


# ---- what a provisioning took ----------------------------------------------------------------------

def cmd_provisioned(args):
    found = owner_state(args.name)
    mapping = ml.mapping_of(args.name)
    runner = mapping['runner_id']
    pvc = sw.kget('pvc', mapping['pvc_name'])
    pv = sw.kget('pv', pvc['spec']['volumeName']) if pvc and pvc['spec'].get('volumeName') else None
    secret = sw.kget('secret', f'mr-boot-{runner}')
    pod = sw.kget('pod', f'mr-{runner}')
    statuses = ((pod or {}).get('status', {}).get('initContainerStatuses') or []) + ((pod or {}).get('status', {}).get('containerStatuses') or [])
    runner_row = json.loads(table_rows(f"select id, name, status, enrolled_at, {sw.runner_last_beat()} as last_heartbeat_at, "
                                       f"version, capabilities, engines "
                                       f"from runner where id = '{runner}'")[0])
    workspace = json.loads(table_rows(f"select id, name, runner_id, target_runner_id, work_dir, position, auto_init_git, enable_worktree, created_at "
                                      f"from workspace where id = '{mapping['default_workspace_id']}'")[0])
    created = table_rows(f"select created_at from managed_runner where id = '{mapping['id']}'")
    status = ml.status_of(args.name)
    engines = runner_row.get('engines') or []
    out({'at': now(), 'owner': args.name, 'signIns': found.get('signIns', [])[:3],
         'mapping': {'createdAt': json.loads(created[0])['created_at'], **{k: mapping.get(k) for k in (
             'id', 'management_state', 'desired_state', 'generation', 'attempt', 'initial_provider', 'last_error', 'state_entered_at',
             'pvc_name', 'pvc_uid', 'pv_uid', 'volume_handle', 'pod_uid', 'node_name')}},
         'pvc': pvc and {'uid': pvc['metadata']['uid'], 'createdAt': pvc['metadata']['creationTimestamp'], 'phase': pvc['status'].get('phase'),
                         'storageClass': pvc['spec'].get('storageClassName'), 'accessModes': pvc['spec'].get('accessModes')},
         'pv': pv and {'uid': pv['metadata']['uid'], 'createdAt': pv['metadata']['creationTimestamp'], 'driver': pv['spec']['csi']['driver'],
                       'image': pv['spec']['csi']['volumeAttributes'].get('imageName'), 'fsType': pv['spec']['csi'].get('fsType')},
         'bootstrapSecret': secret and {'createdAt': secret['metadata']['creationTimestamp'],
                                        'generation': (secret['metadata'].get('annotations') or {}).get('orbit.dev/generation')},
         'pod': pod and {'uid': pod['metadata']['uid'], 'createdAt': pod['metadata']['creationTimestamp'], 'startTime': pod['status'].get('startTime'),
                         'phase': pod['status'].get('phase'), 'node': pod['spec'].get('nodeName'),
                         'containers': [{'name': s['name'], 'state': s.get('state'), 'ready': s.get('ready')} for s in statuses]},
         'runner': {k: runner_row.get(k) for k in ('id', 'name', 'status', 'enrolled_at', 'last_heartbeat_at', 'version', 'capabilities')},
         'runnerEngines': [{k: e.get(k) for k in ('engine', 'installed', 'version', 'auth', 'installationError')} for e in engines],
         'defaultWorkspace': workspace, 'boundToTheManagedRunner': workspace['runner_id'] == runner and workspace['target_runner_id'] == runner,
         'status': {k: status.get(k) for k in ('managementState', 'desiredState', 'usable', 'initialProvider', 'reason', 'heartbeatStatus',
                                              'lastHeartbeatAt', 'runnerId', 'workspaceId', 'actions')},
         'display': ml.display_of(status)})


def cmd_until(args):
    """Wait until NAME's mapping is in STATE (and, with --reason, says that cause), printing each change."""
    deadline, seen = time.monotonic() + args.timeout, []
    while True:
        line = record_line().get(args.name)
        if line and (not seen or seen[-1][1] != line):
            seen.append((now(), line))
        if line and line['management_state'] == args.state and (args.reason is None or line['reason'] == args.reason):
            break
        if time.monotonic() > deadline:
            out({'owner': args.name, 'timeout': args.timeout, 'changes': seen})
            raise SystemExit(f'{args.name} not {args.state}/{args.reason} within {args.timeout} s')
        time.sleep(1)
    out({'owner': args.name, 'reached': {'state': args.state, 'reason': args.reason}, 'at': now(), 'changes': seen})


# What the manager sent k3s, by the size of a connection's largest TLS application-data record (the
# request): the sizes T04 measured through the same gate (docs/managed-runner-lab.md, api-gate.py).
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
         'largestRecordSizes': dict(sorted(sizes.items())), 'lost': [c for c in picked if c.get('lost')]})


# ---- faults --------------------------------------------------------------------------------------

def cmd_intent_fault(args):
    if args.action == 'on':
        sw.sql(f"create or replace function {INTENT_FAULT}() returns trigger language plpgsql as "
               f"$$ begin raise exception 'T05 lab fault: managed runner intent refused'; end $$")
        sw.sql(f'drop trigger if exists {INTENT_FAULT} on managed_runner')
        sw.sql(f'create trigger {INTENT_FAULT} before insert on managed_runner for each row execute function {INTENT_FAULT}()')
    else:
        sw.sql(f'drop trigger if exists {INTENT_FAULT} on managed_runner')
        sw.sql(f'drop function if exists {INTENT_FAULT}()')
    triggers = sw.sql(f"select tgname from pg_trigger where tgrelid = 'managed_runner'::regclass and tgname = '{INTENT_FAULT}'")
    out({'at': now(), 'fault': args.action, 'triggersNamedSo': triggers})


# ---- the recorder ---------------------------------------------------------------------------------

def record_line():
    rows = table_rows('select m.owner_id, u.email, m.management_state, m.desired_state, m.generation, m.attempt, m.initial_provider, '
                      "m.last_error->>'code' as reason, m.pod_uid, m.revision, r.status as runner_status, "
                      f"{sw.runner_last_beat('r')} as last_heartbeat_at, "
                      "(select string_agg((e->>'engine') || ':' || coalesce(e->>'auth', '?') || (case when (e->>'installed')::boolean then '' else '(absent)' end), ',') "
                      "   from jsonb_array_elements(case when jsonb_typeof(r.engines) = 'array' then r.engines else '[]'::jsonb end) e) as engines, "
                      'w.runner_id = m.runner_id as workspace_bound '
                      'from managed_runner m join "user" u on u.id = m.owner_id join runner r on r.id = m.runner_id '
                      'left join workspace w on w.id = m.default_workspace_id order by m.created_at')
    line = {}
    for raw in rows:
        m = json.loads(raw)
        match = re.fullmatch(r't05-([a-z0-9]+)@lab\.invalid', m['email'] or '')
        name = match.group(1) if match else m['email']
        line[name] = {k: m[k] for k in ('management_state', 'desired_state', 'generation', 'attempt', 'initial_provider', 'reason', 'revision',
                                        'runner_status', 'last_heartbeat_at', 'engines', 'workspace_bound')}
        line[name]['pod'] = (m['pod_uid'] or '')[:8] or None
    return line


def cmd_record_loop(args):
    deadline, last = time.monotonic() + args.seconds, None
    while time.monotonic() < deadline:
        try:
            line = record_line()
            objects = ml.cluster_objects()
            for name, value in line.items():
                pod = next((p for p in objects['pods'] if p['metadata']['uid'].startswith(value['pod'] or '-')), None)
                value['podPhase'] = pod and pod['status'].get('phase')
        except (Exception, SystemExit) as error:  # the database or the guest (sql() exits): say so and look again
            line = {'error': str(error)[-200:]}
        if line != last:
            print(json.dumps({'at': now(), **line}, sort_keys=True), flush=True)
            last = line
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


PASS_THROUGH = ('gate', 'replica', 'status', 'action', 'view', 'consistency', 'watch', 'stand-in-login', 'api-outage', 'ensure', 'foreign')


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
    signin = sub.add_parser('signin')
    signin.add_argument('name')
    signin.add_argument('--parallel', type=int, default=1)
    signin.add_argument('--replica', action='store_true')
    sub.add_parser('veteran').add_argument('name')
    landing = sub.add_parser('landing')
    landing.add_argument('name')
    group = landing.add_mutually_exclusive_group(required=True)
    group.add_argument('--save', action='store_true')
    group.add_argument('--check', action='store_true')
    off = sub.add_parser('off-check')
    off.add_argument('names', nargs='+')
    off.add_argument('--label', required=True)
    off.add_argument('--seconds', type=int, default=60)
    key = sub.add_parser('key')
    key.add_argument('name')
    which = key.add_mutually_exclusive_group(required=True)
    which.add_argument('--fake', action='store_true')
    which.add_argument('--key-file')
    session = sub.add_parser('session')
    session.add_argument('name')
    session.add_argument('--prompt', required=True)
    session.add_argument('--provider')
    session.add_argument('--title')
    wait = sub.add_parser('wait-session')
    wait.add_argument('name')
    wait.add_argument('session')
    wait.add_argument('--timeout', type=int, default=300)
    wait.add_argument('--any-answer', action='store_true', help='a real model: any assistant answer counts')
    sub.add_parser('provisioned').add_argument('name')
    until = sub.add_parser('until')
    until.add_argument('name')
    until.add_argument('state')
    until.add_argument('--reason')
    until.add_argument('--timeout', type=int, default=300)
    summary = sub.add_parser('gate-summary')
    summary.add_argument('--since', required=True)
    summary.add_argument('--until')
    sub.add_parser('intent-fault').add_argument('action', choices=('on', 'off'))
    record = sub.add_parser('record')
    record.add_argument('action', choices=('start', 'stop'))
    record.add_argument('--seconds', type=int, default=14400)
    sub.add_parser('record-loop').add_argument('seconds', type=int)
    args = parser.parse_args()
    {'prepare': cmd_prepare, 'account': cmd_account, 'signin': cmd_signin, 'veteran': cmd_veteran, 'landing': cmd_landing,
     'off-check': cmd_off_check, 'key': cmd_key, 'session': cmd_session, 'wait-session': cmd_wait_session,
     'provisioned': cmd_provisioned, 'until': cmd_until, 'gate-summary': cmd_gate_summary, 'intent-fault': cmd_intent_fault, 'record': cmd_record, 'record-loop': cmd_record_loop}[args.command](args)


if __name__ == '__main__':
    main()
