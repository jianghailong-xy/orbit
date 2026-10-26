#!/usr/bin/env python3
"""A02d: seed a real Orbit QA stack with A02c's DS1, A06's DS3 and the QA cards, through its HTTP API only.

  python3 stack.py seed --server URL       from an empty database: accounts, DS1, DS3 and the QA cards' objects
  python3 stack.py rebuild --server URL    after the database was reset: stop the service, seed, start the service
  python3 stack.py serve                   the fake runner (runs as the service below)
  python3 stack.py service start|stop|status   that service, as the transient systemd unit orbit-qa-fake-runner
  python3 stack.py card B01|B02|B03|B15    a pending card on demand (B01-B03 need the service running)
  python3 stack.py verify                  re-read the stack and compare it with the manifest; rewrites map.json/map.tsv
  python3 stack.py status                  what the stack holds now (never a password)

Every row is written by the server: owner calls use the seeded ADMIN's login, runner calls the fake runners'
tokens (stack_runner.py). Passwords and tokens stay in the state directory (default /root/orbit-qa, mode 700,
files 600) and are never printed. README.md, "Seeding a real stack", lists what is reproduced and what cannot be.
"""
import argparse
import fcntl
import importlib.util
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import datasets as ds  # noqa: E402
import stack_runner as sr  # noqa: E402
from stack_runner import Refusal, as_public, as_uuid  # noqa: E402

DEFAULT_STATE = Path(os.environ.get('ORBIT_QA_STATE', '/root/orbit-qa'))
UNIT = 'orbit-qa-fake-runner'
ADMIN = {'email': 'owner@ds1.orbit.test', 'name': 'DS1 Owner'}   # DS1's account (A02c), ADMIN
MEMBER = {'email': 'member@ds0.orbit.test', 'name': 'DS0 Member'}  # DS0's MEMBER account (A02c), left empty
COST_PER_TURN = 0.0731  # datasets.transcript: turn_end's costUsd grows by this much per turn
TASK_ACCEPTANCE = 'The change is covered by a passing test.'  # datasets: every task's acceptanceCriteria
PROJECT_INSTRUCTIONS = 'Keep each task small and land it with its tests.'
VERIFICATION_METHOD = 'Run the tests and read the report.'
SEED_NOTE = 'QA seed (A02d)'
CARD_RE = re.compile(r'\bqa card (b01|b02|b03)\b', re.IGNORECASE)
TOOL_FILES = ('stack.py', 'stack_runner.py', 'datasets.py', 'images.py')


def log(*parts):
    print(time.strftime('%H:%M:%S'), *parts, flush=True)


def fixture_module():
    """A06's transcript-fixture.py (DS3), loaded by path: its name is not a module name."""
    for path in (HERE / 'transcript-fixture.py', HERE.parent / 'transcript-fixture.py'):
        if path.exists():
            spec = importlib.util.spec_from_file_location('transcript_fixture', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise SystemExit('transcript-fixture.py (DS3) not found beside stack.py or in its parent directory')


# ------------------------------------------------------------------------------------------------- state

class State:
    """The state directory: accounts.json and runners.json (600), the id map, the held turns, the lock."""

    def __init__(self, root):
        self.root = Path(root)

    def prepare(self):
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    def path(self, name):
        return self.root / name

    def read(self, name, default=None):
        p = self.path(name)
        return json.loads(p.read_text()) if p.exists() else default

    def write(self, name, value, secret=False, text=None):
        self.prepare()
        p = self.path(name)
        tmp = p.with_name(p.name + '.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if secret else 0o644)
        with os.fdopen(fd, 'w') as f:
            f.write(text if text is not None else json.dumps(value, ensure_ascii=False, indent=1) + '\n')
        os.replace(tmp, p)

    def lock(self):
        """One process speaks for the fake runners at a time: `seed` and `serve` both hold this lock."""
        self.prepare()
        handle = open(self.path('runner.lock'), 'w')
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(f'another stack.py process holds {self.path("runner.lock")}; if it is the service: '
                             f'python3 {Path(__file__).name} service stop')
        return handle


class Owner:
    """The seeded ADMIN's half of the API (a login JWT, renewed on a 401)."""

    def __init__(self, api, account):
        self.api, self.account = api, account
        self.token = None
        self.lock = threading.Lock()

    def login(self):
        answer = self.api.call('POST', '/auth/login', body={'email': self.account['email'],
                                                            'password': self.account['password']}, attempts=3)
        self.token = answer['accessToken']
        return answer

    def call(self, method, path, body=None, attempts=1, timeout=60):
        if self.token is None:
            with self.lock:
                if self.token is None:
                    self.login()
        try:
            return self.api.call(method, path, token=self.token, body=body, attempts=attempts, timeout=timeout)
        except Refusal as error:
            if error.status != 401:
                raise
            with self.lock:
                self.login()
            return self.api.call(method, path, token=self.token, body=body, attempts=attempts, timeout=timeout)


def server_of(args, state):
    stack = state.read('stack.json') or {}
    server = getattr(args, 'server', None) or stack.get('server')
    if not server:
        raise SystemExit(f'no server recorded in {state.root}: pass --server')
    api = sr.Api(server)
    if stack.get('server') and api.server != stack['server']:
        raise SystemExit(f'{state.root} belongs to {stack["server"]}, not {api.server}: use another --state')
    return api


def owner_of(api, state):
    accounts = state.read('accounts.json')
    if not accounts:
        raise SystemExit(f'no accounts in {state.root}: run `seed` first')
    return Owner(api, accounts['admin'])


# ---------------------------------------------------------------------------------------------- runners

DS1_RUNNERS = {name: {'name': name, 'displayName': display, 'hostname': host, 'online': online, 'maxConcurrent': cap,
                      'engines': engines, 'labels': ['linux'] if i == 0 else ['macos'] if i == 1 else []}
               for i, (name, display, host, online, cap, engines) in enumerate(ds.RUNNERS)}


def engines_of(name):
    """A DS1 runner's `engines` heartbeat report: its manifest engines, installed and signed in."""
    return [{'engine': e, 'installed': True, 'version': v, 'auth': 'yes',
             'accounts': [{'id': 'default', 'name': 'Default', 'auth': 'yes'}]} for e, v in DS1_RUNNERS[name]['engines']]


def fake_runner(api, state, handler):
    """The fake runners, under a lease owner of this process's own, as each Go runner process has one: a later
    process takes the sessions over from it (takeover-leases), which hands it their running turns again."""
    creds = state.read('runners.json')
    if not creds:
        raise SystemExit(f'no runner tokens in {state.root}: run `seed` first')
    return sr.FakeRunner(api, creds['runners'], str(uuid.uuid4()), handler, log=log,
                         engines={name: engines_of(name) for name in creds['runners']},
                         idle_capacity={name: DS1_RUNNERS[name]['maxConcurrent'] for name in creds['runners']})


# --------------------------------------------------------------------------------------------- scripts

class TurnPlan:
    """One turn a session plays: its events (the first is the user's message; a callable gets the inbox content)
    and how it ends — SUCCEEDED, FAILED, or HOLD (left running, as a RUNNING session's last turn is)."""

    def __init__(self, events, ending='SUCCEEDED', error=None, complete=None):
        self.events, self.ending, self.error = events, ending, error
        self.complete = complete or {}
        self.done = threading.Event()

    @property
    def user_text(self):
        return self.events[0][1].get('text')


class Script:
    def __init__(self, label, plans):
        self.label, self.plans = label, plans
        self.next = 0
        self.driven = 0
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            if self.next >= len(self.plans):
                return None
            plan = self.plans[self.next]
            self.next += 1
            return plan


class Scripts:
    """Which script each session plays, by session UUID; a turn waits for its session's script to be filed."""

    def __init__(self):
        self.by_sid = {}
        self.cond = threading.Condition()

    def add(self, sid, script):
        with self.cond:
            self.by_sid[sid] = script
            self.cond.notify_all()

    def wait(self, sid, timeout):
        with self.cond:
            self.cond.wait_for(lambda: sid in self.by_sid, timeout)
            return self.by_sid.get(sid)


def echo_reply(text):
    first = ' '.join(text.split())[:160]
    return (f'QA fake runner: no engine runs on this stack, so this reply only confirms your message arrived '
            f'({len(text)} characters).\n\n> {first}\n\nSend "qa card B01", "qa card B02" or "qa card B03" in any session '
            'for a pending tool-permission, question or plan card.')


def notice(turn):
    """A message the server wrote (an evidence notice, a project event): acknowledged the way an agent ends its
    turn, in one line. Anything else is not a notice."""
    if not (turn.content.startswith('<orbit-') or turn.content.startswith('From Orbit · ')) \
            or turn.content.startswith('From Orbit · owner answer:'):
        return False
    turn.post([('user', {'text': turn.content}), ('assistant', {'text': 'Noted (QA fake runner).'})])
    turn.complete('SUCCEEDED', subtype='success', result='noted')
    return True


def hold(turn, forget=None):
    """Keeps a turn running until it is interrupted or its session ends, as a turn still working does."""
    turn.stopped.wait()
    if forget:
        forget(turn)
    if turn.stop_reason == 'interrupt':
        turn.post([('interrupt', {'requestId': str(uuid.uuid4())})])
        turn.complete('INTERRUPTED', subtype='interrupted', result='')


def finish(turn, plan):
    fields = {'subtype': 'success', 'costUsd': COST_PER_TURN, **plan.complete}
    replies = [p['text'] for k, p in plan.events if k == 'assistant'] if isinstance(plan.events, list) else []
    fields['result'] = replies[-1][:2000] if replies else ''
    if plan.ending == 'FAILED':
        fields.update(error=plan.error, subtype='error_during_execution')
    turn.complete(plan.ending, **{k: v for k, v in fields.items() if v is not None})


class SeedHandler:
    """The fake runner's turns while seeding: each session plays its script; anything else gets an echo."""

    def __init__(self, scripts, keep_held, script_wait=600):
        self.scripts, self.keep_held, self.script_wait = scripts, keep_held, script_wait

    def __call__(self, turn):
        if turn.kind == 'shell':
            turn.complete('SUCCEEDED', shellExitCode=0, shellOutput='', subtype='shell', result='')
            return
        script = self.scripts.wait(turn.sid, timeout=self.script_wait)
        plan = script.take() if script else None
        if plan is None and notice(turn):
            return
        if plan is None:
            log(f'unscripted turn in {turn.sid}: answered with an echo')
            turn.post([('user', {'text': turn.content}), ('assistant', {'text': echo_reply(turn.content)})])
            turn.complete('SUCCEEDED', result='echo', subtype='success')
            return
        turn.post(plan.events(turn) if callable(plan.events) else plan.events)
        if plan.ending == 'HOLD':
            self.keep_held(turn.sid, turn.turn_id)
            plan.done.set()
            hold(turn)
            return
        finish(turn, plan)
        plan.done.set()


def plans_of(world, s):
    """A DS1 session's turns from the manifest: one TurnPlan per turnId; the last ends as the session's status
    can on a real server (RUNNING holds its last turn; FAILED fails it; the README lists the rest)."""
    turns = []
    for e in world.events[s['id']]:
        if not turns or turns[-1][0] != e['turnId']:
            turns.append((e['turnId'], []))
        turns[-1][1].append((e['type'], json.loads(json.dumps(e['payload']))))
    plans = []
    for n, (_, rows) in enumerate(turns):
        last = n == len(turns) - 1
        complete = {'numTurns': n + 1}
        if s['branch']:
            complete.update(isolationStatus='worktree', baseSha=s['baseSha'], changedFiles=[], worktreeDirty=False,
                            branchMerged=False)
        ending, error = 'SUCCEEDED', None
        if last and s['status'] == 'RUNNING':
            ending = 'HOLD'
        elif last and s['status'] == 'FAILED':
            ending, error = 'FAILED', s['error']
        plans.append(TurnPlan(rows, ending, error, complete))
    return plans


def expected_session(s):
    """What a DS1 session's status should read on the stack, and why it differs when it does."""
    status, reason, view = s['status'], s['endReason'], s['view']
    if view == 'open' and status == 'PENDING':
        return 'AWAITING_INPUT', None, ('PENDING (queued at runner capacity) cannot be held without filling the runner, '
                                        'which would queue every other session on it')
    if view == 'open' and status == 'INTERRUPTED':
        return 'AWAITING_INPUT', None, 'INTERRUPTED is a legacy status this server no longer writes (an interrupted turn leaves AWAITING_INPUT)'
    if view == 'completed' and status == 'AWAITING_INPUT':
        return 'CANCELLED', 'completed', 'Complete ends a live session (CANCELLED, completed); AWAITING_INPUT plus completed cannot be made'
    return status, reason, None


# ----------------------------------------------------------------------------------------------- tasks

def task_plan(t):
    """How a DS1 task is filed and settled on a real server. DONE is never written directly: an owner
    confirmation or an evidence decision reaches it. Returns the creation route, the criterion it is filed
    with, how it reaches its status, and what of it cannot match the manifest."""
    status, criterion, in_project, creator = t['status'], t['criterion'], bool(t['project']), t['creatorType']
    runs = bool(t['sessions'])
    plan = {'initial': criterion, 'done': None, 'switch': False, 'park': False, 'notes': []}
    if status == 'DONE':
        if criterion == 'OWNER_CONFIRMED':
            plan['done'] = 'confirm'
        elif criterion == 'EVIDENCE_JUDGMENT' and runs:
            plan['done'] = 'evidence'
        else:
            plan.update(initial='OWNER_CONFIRMED', done='confirm')
            if criterion == 'EVIDENCE_JUDGMENT' and not in_project:
                plan['notes'].append('reaches DONE by owner confirmation and keeps OWNER_CONFIRMED: EVIDENCE_JUDGMENT '
                                     'outside a project needs a run to cite')
            else:
                plan['switch'] = True
                plan['notes'].append(f'reaches DONE by owner confirmation, then its criterion is set to {criterion} '
                                     '(the task shows that change)')
    elif criterion == 'EXECUTABLE' and runs:
        plan['park'] = True  # CANCELLED while its runs play, so no acceptance turn is queued into them
    plan['route'] = 'runner' if creator == 'AGENT' else 'owner'
    if plan['initial'] == 'EVIDENCE_JUDGMENT' and not in_project and creator == 'USER':
        plan['route'] = 'runner'
        plan['notes'].append('filed through the runner door (creator AGENT): the owner may not file '
                             'EVIDENCE_JUDGMENT outside a project')
    if plan['initial'] == 'EVIDENCE_JUDGMENT' and not in_project:
        plan['notes'].append('filed from the session "QA · cards (B01 B02 B03)": outside a project, the filing '
                             'session decides its evidence')
    if status in ('OPEN', 'IN_PROGRESS') and in_project:
        plan['notes'].append('autoRunWhenReady off: on, the server would start it at once')
    return plan


# -------------------------------------------------------------------------------------------- the seeder

class Seeder:
    def __init__(self, state, api, workers):
        self.state, self.api, self.workers = state, api, workers
        self.objects = []
        self.ids = {}  # manifest uuid (or key) -> stack public id
        self.notes = []
        self.scripts = Scripts()
        self.held = {}
        self.held_lock = threading.Lock()
        self.workspace_locks = {}
        self.runner = None
        self.owner = None
        self.world = None
        self.qa = {}

    # -- bookkeeping -------------------------------------------------------------------------------------

    def record(self, dataset, kind, key, stack_id, title, **extra):
        self.ids[key] = stack_id
        manifest_id = as_public(key) if sr.UUID_RE.match(key) else key
        row = {'dataset': dataset, 'kind': kind, 'manifestId': manifest_id, 'stackId': stack_id, 'title': title, **extra}
        self.objects.append(row)
        return row

    def keep_held(self, sid, turn_id):
        with self.held_lock:
            self.held[sid] = turn_id
            self.state.write('held.json', self.held)

    def sid(self, manifest_session):
        return as_uuid(self.ids[manifest_session['id']])

    def door(self, name='hpc-build-01'):
        return self.runner.doors[name]

    # -- accounts and runners ------------------------------------------------------------------------------

    def accounts(self):
        status = self.api.call('GET', '/auth/setup-status', attempts=3)
        if not status.get('needsSetup'):
            raise SystemExit('this stack already has accounts (GET /api/auth/setup-status: needsSetup false); seed '
                             'starts from an empty database: reset the stack first (README, "Reset")')
        admin = {**ADMIN, 'password': secrets.token_urlsafe(18)}
        member = {**MEMBER, 'password': secrets.token_urlsafe(18)}
        # Written before bootstrap: a seed that stops after it still leaves the password the account has.
        self.state.write('accounts.json', {'server': self.api.server, 'admin': admin, 'member': member}, secret=True)
        boot = self.api.call('POST', '/auth/bootstrap', body={'email': admin['email'], 'name': admin['name'],
                                                              'password': admin['password']})
        admin['id'] = boot['user']['id']
        self.owner = Owner(self.api, admin)
        self.owner.token = boot['accessToken']
        made = self.owner.call('POST', '/admin/users', {'email': member['email'], 'name': member['name'],
                                                         'password': member['password']})
        member['id'] = made['id']
        self.state.write('accounts.json', {'server': self.api.server, 'admin': admin, 'member': member}, secret=True)
        roles = {u['email']: u['role'] for u in self.owner.call('GET', '/admin/users')}
        self.record('accounts', 'user', 'admin', admin['id'], admin['email'], role=roles.get(admin['email']),
                    manifest='DS1 accounts.json: owner@ds1.orbit.test, ADMIN')
        self.record('accounts', 'user', 'member', member['id'], member['email'], role=roles.get(member['email']),
                    manifest='DS0 accounts.json: member@ds0.orbit.test, MEMBER (left empty, as in DS0)')
        log(f'accounts: {admin["email"]} {roles.get(admin["email"])}, {member["email"]} {roles.get(member["email"])}; '
            f'passwords in {self.state.path("accounts.json")}')

    def register_runners(self):
        world = self.world
        creds = {'runners': {}}
        for r in world.runners:
            spec = DS1_RUNNERS[r['name']]
            token = self.owner.call('POST', '/runners/enrollment-tokens', {'label': r['name'], 'ttlHours': 1})['token']
            made = self.api.call('POST', '/runner/register', body={
                'enrollmentToken': token, 'name': r['name'], 'hostname': r['hostname'], 'labels': spec['labels'],
                'maxConcurrent': r['maxConcurrent'], 'version': sr.RUNNER_VERSION})
            creds['runners'][r['name']] = {'runnerId': made['runnerId'], 'runnerToken': made['runnerToken']}
            public = made.get('runnerPublicId') or as_public(made['runnerId'])
            if r['displayName']:
                self.owner.call('PATCH', f'/runners/{public}', {'displayName': r['displayName']})
            self.record('DS1', 'runner', r['id'], public, r['name'],
                        expect={'online': r['online'], 'position': r['position']},
                        note=None if r['position'] is not None else 'position 2: a reorder places every runner')
        self.state.write('runners.json', creds, secret=True)
        self.owner.call('POST', '/runners/reorder', {'ids': [self.ids[r['id']] for r in world.runners]})
        self.runner = fake_runner(self.api, self.state, SeedHandler(self.scripts, self.keep_held))
        self.runner.start([r['name'] for r in world.runners], claimers=2)
        log(f'runners: {", ".join(r["name"] for r in world.runners)} registered and beating')

    # -- the directory ------------------------------------------------------------------------------------

    def directory(self):
        world = self.world
        for w in world.workspaces:
            body = {'name': w['name'], 'workDir': f"/srv/orbit/repos/{w['slug']}",
                    'repoUrl': f"git@example.test:orbit/{w['slug']}.git", 'enableWorktree': False}
            if w['description']:
                body['description'] = w['description']
            if w['effort']:
                body['effort'] = w['effort']
            if w['runner']:
                body['runnerId'] = self.ids[w['runner']['id']]
            made = self.owner.call('POST', '/workspaces', body)
            notes = []
            if w['model']:
                notes.append(f"model {w['model']}: the server no longer stores a workspace model")
            self.record('DS1', 'workspace', w['id'], made['id'], w['name'],
                        expect={'runner': w['runner']['name'] if w['runner'] else None, 'position': w['position'],
                                'enabled': w['enabled']}, note='; '.join(notes) or None)
            self.workspace_locks[w['id']] = threading.Lock()
        placed = sorted([w for w in world.workspaces if w['position'] is not None], key=lambda w: w['position'])
        self.owner.call('POST', '/workspaces/reorder', {'ids': [self.ids[w['id']] for w in placed]})
        tags = {t['name']: t for t in self.owner.call('GET', '/session-tags')}
        for t in world.tags:
            stack = tags[t['name']] if t['isSystem'] else self.owner.call('POST', '/session-tags', {'name': t['name'], 'color': t['color']})
            self.record('DS1', 'tag', t['id'], stack['id'], t['name'])
        for f in world.folders:
            made = self.owner.call('POST', '/session-folders', {'workspaceId': self.ids[f['workspaceId']], 'name': f['name']})
            self.record('DS1', 'folder', f['id'], made['id'], f['name'])
        for l in world.lists:
            made = self.owner.call('POST', '/task-lists', {'title': l['title']})
            self.owner.call('PATCH', f"/task-lists/{made['id']}", {'instructions': l['instructions'],
                                                                   'maxConcurrent': l['maxConcurrent']})
            self.record('DS1', 'task-list', l['id'], made['id'], l['title'], expect={'paused': l['paused']})
        log(f'directory: {len(world.workspaces)} workspaces, {len(world.tags)} tags, {len(world.folders)} folders, '
            f'{len(world.lists)} task lists')

    # -- projects -----------------------------------------------------------------------------------------

    def projects(self):
        """Every project; an open one opens its coordinator in the manifest coordinator's workspace, and that
        session plays the manifest coordinator's transcript (its first message is the server's brief)."""
        for p in sorted(self.world.projects, key=lambda p: p['created']):
            body = {'title': p['title'], 'goal': p['goal'], 'instructions': PROJECT_INSTRUCTIONS, 'maxConcurrentTasks': 3,
                    'acceptanceCriteriaItems': [{'text': c, 'verificationMethod': VERIFICATION_METHOD} for c in p['criteria']]}
            c = p['coordinator']
            made = self.owner.call('POST', '/projects', body)
            self.record('DS1', 'project', p['id'], made['id'], p['title'],
                        expect={'status': p['status'], 'started': bool(p['started']), 'coordinator': bool(c)},
                        note='started with Automatic off: on, the server would message its coordinator about every '
                             'task, adding turns to a DS1 transcript' if p['started'] and c else None)
            if p['started']:
                # Started before its coordinator opens: a coordinator open at the start is sent "project started",
                # a turn the DS1 transcript does not have; one opened after it reads the start in its brief.
                self.start_project(p, made['id'])
            if c:
                w = c['workspace']
                with self.workspace_locks[w['id']]:
                    self.owner.call('PATCH', f"/workspaces/{self.ids[w['id']]}", {'enableWorktree': bool(c['branch'])})
                    self.owner.call('POST', f"/projects/{made['id']}/coordinator", {'workspaceId': self.ids[w['id']]})
                coordinator = self.owner.call('GET', f"/projects/{made['id']}")['coordinatorSessionId']
                # The server writes the opening message (its brief); the transcript's user event is the manifest's.
                self.scripts.add(as_uuid(coordinator), Script(f"DS1 coordinator {c['index']}", plans_of(self.world, c)))
                self.record_session(c, coordinator, coordinates=made['id'])
                self.owner.call('PATCH', f'/sessions/{coordinator}', {'title': c['title']})
                config = {'model': ds.MODELS[c['provider']], 'permissionMode': c['permissionMode']}
                self.owner.call('PATCH', f'/sessions/{coordinator}/config', config)
                if c['folderId']:
                    self.owner.call('POST', f'/sessions/{coordinator}/move', {'folderId': self.ids[c['folderId']]})
        log(f'projects: {len(self.world.projects)} filed')

    def start_project(self, p, pid):
        digest = self.owner.call('GET', f'/projects/{pid}/acceptance/confirmation')['currentVersion']['digest']
        # Automatic off: on, the server messages the coordinator about every task that fails or waits, and each
        # message would be a turn added to a DS1 transcript.
        body = {'criteriaDigest': digest, 'line': 'PROJECT_BRANCH', 'automatic': False, 'maxConcurrentTasks': 3,
                'mergeCheckCommand': 'npm test'}
        try:
            self.owner.call('POST', f'/projects/{pid}/start', body)
        except Refusal as error:
            if error.code != 'INTEGRATION_REPOSITORY_UNKNOWN':
                raise
            body.update(line='MAIN', mergeCheckCommand=None)
            self.owner.call('POST', f'/projects/{pid}/start', body)
            self.note_on(p['id'], 'started on MAIN with no merge check: PROJECT_BRANCH needs a repository the stack does not have')

    def finish_projects(self):
        for p in self.world.projects:
            pid = self.ids[p['id']]
            if p['status'] == 'DONE':
                digest = self.owner.call('GET', f'/projects/{pid}/acceptance/confirmation')['currentVersion']['digest']
                self.owner.call('POST', f'/projects/{pid}/done', {'criteriaDigest': digest, 'acceptedGaps': []})
            elif p['status'] == 'CANCELLED':
                self.owner.call('PATCH', f'/projects/{pid}', {'status': 'CANCELLED'})

    def note_on(self, key, text):
        for row in self.objects:
            if row['manifestId'] == as_public(key):
                row['note'] = '; '.join(filter(None, [row.get('note'), text]))

    # -- tasks --------------------------------------------------------------------------------------------

    def tasks(self):
        for t in sorted(self.world.tasks, key=lambda t: t['created']):
            plan = t['_plan'] = task_plan(t)
            body = {'title': t['title'], 'description': t['description'], 'labels': t['labels'],
                    'modelHint': t['modelHint'], 'acceptanceCriteria': TASK_ACCEPTANCE,
                    'completionCriterion': plan['initial'], 'autoRunWhenReady': False}
            if plan['initial'] == 'EXECUTABLE':
                body.update(acceptanceCommand='npm test', acceptanceExpectedExitCode=0)
            if t['assignee']:
                body['assigneeId'] = self.ids[t['assignee']['id']]
            if t['list']:
                body['listId'] = self.ids[t['list']['id']]
            if t['project']:
                body['projectId'] = self.ids[t['project']['id']]
            if plan['route'] == 'runner':
                headers = {'x-orbit-workspace-id': self.ids[t['assignee']['id']]}
                if plan['initial'] == 'EVIDENCE_JUDGMENT' and not t['project']:
                    # Outside a project the session that files it decides its evidence: the QA cards session,
                    # which no DS1 transcript is.
                    headers['x-orbit-session-id'] = as_uuid(self.qa['cardsSession'])
                made = self.door().call('POST', '/runner/tasks', body, attempts=1, headers=headers)
            else:
                made = self.owner.call('POST', '/tasks', body)
            self.record('DS1', 'task', t['id'], made['id'], t['title'],
                        expect={'status': t['status'], 'criterion': t['criterion'] if plan['done'] != 'confirm' or plan['switch']
                                or t['criterion'] == 'OWNER_CONFIRMED' else 'OWNER_CONFIRMED',
                                'creatorType': 'AGENT' if plan['route'] == 'runner' else 'USER'},
                        note='; '.join(plan['notes']) or None)
            if t['priority']:
                self.owner.call('PATCH', f"/tasks/{made['id']}", {'priority': t['priority']})
            if plan['park']:
                self.owner.call('PATCH', f"/tasks/{made['id']}", {'status': 'CANCELLED'})
        for t in self.world.tasks:
            for d in t['dependsOn']:
                self.owner.call('POST', f"/tasks/{self.ids[t['id']]}/dependencies", {'dependsOnTaskId': self.ids[d['id']]})
        log(f'tasks: {len(self.world.tasks)} filed, {sum(len(t["dependsOn"]) for t in self.world.tasks)} prerequisites')

    def finish_tasks(self):
        decider = self.qa['cardsSession']  # independent of every DS1 task, and no DS1 transcript
        for t in sorted(self.world.tasks, key=lambda t: t['created']):
            plan, tid, status = t['_plan'], self.ids[t['id']], t['status']
            if status == 'DONE' and plan['done'] == 'confirm':
                self.owner.call('POST', f'/tasks/{tid}/owner-confirmation', {'decision': 'CONFIRM', 'note': SEED_NOTE})
                if plan['switch']:
                    patch = {'completionCriterion': t['criterion'], 'completionCriterionOverrideReason':
                             f'{SEED_NOTE}: DS1 records this DONE task under {t["criterion"]}; the seed reached DONE by owner confirmation'}
                    if t['criterion'] == 'EXECUTABLE':
                        patch.update(acceptanceCommand='npm test', acceptanceExpectedExitCode=0)
                    self.owner.call('PATCH', f'/tasks/{tid}', patch)
            elif status == 'DONE':
                run = t['sessions'][0]
                tool = next(e['payload']['id'] for e in self.world.events[run['id']] if e['type'] == 'tool_use')
                filed = self.owner.call('POST', f'/tasks/{tid}/evidence', {
                    'sourceSessionId': self.ids[run['id']],
                    'evidence': {'claim': f'{t["title"]}: done, and its run shows it.',
                                 'criterion': {'key': tid, 'text': TASK_ACCEPTANCE},
                                 'checks': [{'kind': 'TOOL_CALL', 'ref': tool}], 'gaps': []}})
                self.owner.call('POST', f'/tasks/{tid}/evidence/decision', {
                    'decision': 'CONFIRM', 'evidenceRevision': str(filed['revision']), 'decidingSessionId': decider})
            elif plan['park'] and status == 'OPEN':
                self.owner.call('PATCH', f'/tasks/{tid}', {'status': 'OPEN', 'supersededByTaskId': None, 'terminalReason': None})
            elif status in ('IN_PROGRESS', 'FAILED') or (status == 'CANCELLED' and not plan['park']):
                self.owner.call('PATCH', f'/tasks/{tid}', {'status': status})
            if t['project'] and status != 'OPEN':
                # DS1's project tasks run on their own; filed off, so that none ran before it was settled.
                self.owner.call('PATCH', f'/tasks/{tid}', {'autoRunWhenReady': True})
        log('tasks: statuses settled')

    # -- sessions -----------------------------------------------------------------------------------------

    def record_session(self, s, sid_public, **extra):
        status, reason, note = expected_session(s)
        notes = [note] if note else []
        if s['recapText']:
            notes.append('no recap: the server writes recaps with a model this stack does not have')
        self.record('DS1', 'session', s['id'], sid_public, s['title'],
                    expect={'status': status, 'endReason': reason, 'view': s['view'], 'events': len(self.world.events[s['id']]),
                            'pinned': bool(s['pinnedAt']), 'branch': bool(s['branch'])},
                    note='; '.join(notes) or None, **extra)

    def create_session(self, s):
        w = s['workspace']
        body = {'workspaceId': self.ids[w['id']], 'title': s['title'], 'prompt': self.world.events[s['id']][0]['payload']['text'],
                'engine': s['provider'], 'model': ds.MODELS[s['provider']], 'permissionMode': s['permissionMode']}
        if s['folderId']:
            body['folderId'] = self.ids[s['folderId']]
        if s['taskId']:
            body['taskId'] = self.ids[s['taskId']]
        # The workspace's worktree switch at creation decides whether the session has a branch: on only for
        # the sessions the manifest gives one (the server names it), off for the rest, which then have none.
        with self.workspace_locks[w['id']]:
            self.owner.call('PATCH', f"/workspaces/{self.ids[w['id']]}", {'enableWorktree': bool(s['branch'])})
            made = self.owner.call('POST', '/sessions', body)
        return made['id']

    def drive(self, sid_public, script, upto):
        """Plays the script's turns up to (not including) `upto`; the first is the session's opening message."""
        sid = as_uuid(sid_public)
        for n in range(script.driven, upto):
            plan = script.plans[n]
            if n > 0:
                # With an explicit intent, as the web sends one: the server then counts it as the owner's words.
                self.owner.call('POST', f'/sessions/{sid_public}/turns',
                                {'clientTurnId': f'qa-seed-{sid[:8]}-{n + 1}', 'content': plan.user_text,
                                 'intent': 'NEXT_TURN'}, attempts=3)
            if not plan.done.wait(timeout=600):
                raise SystemExit(f'turn {n + 1} of {script.label} ({sid_public}) did not finish in 10 min')
            script.driven = n + 1

    def sessions(self, before_last=None):
        """Every DS1 session: turns 1..n-1 in parallel, then each last turn in the manifest's order of last
        activity, so that the server's recency order is the manifest's."""
        world = self.world

        def open_one(s):
            if s['coordinates']:
                sid_public = self.ids[s['id']]
                script = self.scripts.wait(as_uuid(sid_public), timeout=0)
            else:
                sid_public = self.create_session(s)
                self.record_session(s, sid_public)
                script = Script(f"DS1 session {s['index']}", plans_of(world, s))
                self.scripts.add(as_uuid(sid_public), script)
            s['_script'] = script
            self.drive(sid_public, script, len(script.plans) - 1)

        order = sorted(world.sessions, key=lambda s: s['created'])
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for n, _ in enumerate(pool.map(open_one, order), 1):
                if n % 25 == 0:
                    log(f'sessions: {n}/{len(order)} opened')
        if before_last:
            before_last()
        for s in sorted(world.sessions, key=lambda s: s['lastTurn']):
            self.drive(self.ids[s['id']], s['_script'], len(s['_script'].plans))
        log(f'sessions: {len(world.sessions)} played')

    def finish_sessions(self):
        """Ends, completions, Trash, pins and tags, each in the manifest's order."""
        world = self.world
        for s in world.sessions:
            if s['view'] == 'open' and s['status'] == 'CANCELLED':
                self.owner.call('POST', f"/sessions/{self.ids[s['id']]}/end")
        for s in sorted([s for s in world.sessions if s['view'] == 'completed'], key=lambda s: s['completedAt']):
            if s['status'] == 'SUCCEEDED':
                self.finalize(s, 'SUCCEEDED')
            self.owner.call('POST', f"/sessions/{self.ids[s['id']]}/complete")
        for s in sorted([s for s in world.sessions if s['view'] == 'trash'], key=lambda s: s['deletedAt']):
            self.owner.call('DELETE', f"/sessions/{self.ids[s['id']]}")
        for s in sorted([s for s in world.sessions if s['pinnedAt']], key=lambda s: s['pinnedAt']):
            self.owner.call('POST', f"/sessions/{self.ids[s['id']]}/pin")
        for s in world.sessions:
            if s['tags']:
                self.owner.call('PUT', f"/sessions/{self.ids[s['id']]}/tags", {'tagIds': [self.ids[t['id']] for t in s['tags']]})
        self.wait_settled()

    def finalize(self, s, status):
        sid = self.sid(s)
        live = self.runner.sessions.get(sid)
        job = live.job if live else {}
        self.runner.doors[s['runner']['name']].call('POST', f'/runner/sessions/{sid}/finalize', {
            'status': status, 'leaseOwner': self.runner.lease_owner,
            'runtimeSessionId': job.get('runtimeSessionId') or job.get('sessionUuid')})
        if live:
            live.ended = True

    def wait_settled(self, timeout=180):
        """Until every ended, completed or trashed session has the terminal status its end leaves."""
        want = {self.ids[s['id']] for s in self.world.sessions
                if s['view'] in ('trash', 'completed') or s['status'] == 'CANCELLED'}
        deadline = time.time() + timeout
        while want and time.time() < deadline:
            for sid_public in list(want):
                if self.owner.call('GET', f'/sessions/{sid_public}', attempts=3)['status'] in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
                    want.discard(sid_public)
            if want:
                time.sleep(2)
        if want:
            self.notes.append(f'{len(want)} ended sessions had not settled after {timeout} s')

    # -- wiki ---------------------------------------------------------------------------------------------

    def wiki(self):
        world = self.world
        for sp in world.spaces:
            body = {'title': sp['title'], 'slug': sp['slug']}
            if sp['repo']:
                body['repoUrl'] = 'https://' + sp['repo']
            made = self.owner.call('POST', '/wiki/spaces', body)
            self.record('DS1', 'wiki-space', sp['id'], made['id'], sp['title'], expect={'slug': sp['slug']})
            for w in sp['workspaces']:
                self.owner.call('POST', f"/wiki/spaces/{made['id']}/workspaces", {'workspaceId': self.ids[w['id']]})
        callers = {sp['id']: [s for s in world.sessions if s['workspace'] in sp['workspaces'] and s['view'] != 'trash'
                              and not s['coordinates']] for sp in world.spaces}
        used = {}  # session -> agent ops so far (the server allows 15 per session)
        replaced = {e['supersededBy']['id'] for e in world.entries if e['status'] == 'superseded'}
        pending_confirm = []
        for e in sorted(world.entries, key=lambda e: (e['recorded'], e['id'])):
            if e['id'] in replaced:
                continue  # made by the superseding op of the entry it replaces
            trust = e['trust']
            entry = wiki_entry(e)
            notes = []
            if e['pinned']:
                notes.append('not pinned: the server has no route that pins an entry')
            if trust == 'owner' or e['kind'] == 'principle':
                if trust != 'owner':
                    notes.append(f'trust owner, not {trust}: only the owner may write a principle')
                made = self.wiki_ops(e['space'], [{'op': 'add', 'entry': entry}])
                stack_trust = 'owner'
            elif trust == 'proposed':
                continue  # filed after the mode turns manual, below
            else:
                quote = trust == 'auto' and e['kind'] in ('decision', 'convention')
                made = self.agent_add(e, entry, callers[e['space']['id']], used, quote)
                stack_trust = 'auto' if quote else 'unreviewed'
                if trust == 'auto' and not quote:
                    notes.append(f'trust unreviewed, not auto: a {e["kind"]} cannot be machine-verified through the API')
                if trust == 'confirmed':
                    pending_confirm.append((e, made))
                    stack_trust = 'confirmed'
            e['_stack'] = made
            row = self.record('DS1', 'wiki-entry', e['id'], made, e['title'],
                              expect={'status': e['status'], 'trust': stack_trust, 'kind': e['kind']},
                              note='; '.join(notes) or None)
            e['_row'] = row
        for e, made in pending_confirm:
            self.owner.call('POST', f'/wiki/entries/{made}/confirm')
        for e in sorted(world.entries, key=lambda e: e['recorded']):
            if e['status'] == 'superseded':
                n = e['supersededBy']
                current = self.owner.call('GET', f"/wiki/entries/{e['_stack']}")['currentRevision']
                answer = self.wiki_ops(e['space'], [{'op': 'supersede', 'entryId': e['_stack'], 'baseRevision': current,
                                                     'entry': wiki_entry(n)}], raw=True)
                newer = answer['ops'][0]['entryId']
                self.record('DS1', 'wiki-entry', n['id'], newer, n['title'],
                            expect={'status': n['status'], 'trust': 'owner', 'kind': n['kind']},
                            note=None if n['trust'] == 'owner' else f'trust owner, not {n["trust"]}: an owner op supersedes it')
            elif e['status'] == 'retired':  # (the generator retires a superseded entry that has no successor)
                current = self.owner.call('GET', f"/wiki/entries/{e['_stack']}")['currentRevision']
                self.wiki_ops(e['space'], [{'op': 'retire', 'entryId': e['_stack'], 'baseRevision': current,
                                            'reason': 'No longer true.'}])
        for sp in world.spaces:
            self.owner.call('PATCH', f"/wiki/spaces/{self.ids[sp['id']]}", {'reviewMode': 'manual'})
        for e in world.entries:
            if e['trust'] == 'proposed' and e['status'] == 'proposed':
                made = self.agent_add(e, wiki_entry(e), callers[e['space']['id']], used, False)
                self.record('DS1', 'wiki-entry', e['id'], made, e['title'], expect={'status': 'proposed', 'trust': 'proposed',
                                                                                     'kind': e['kind']})
        log(f'wiki: {len(world.spaces)} spaces, {len(world.entries)} entries')

    def wiki_ops(self, space, ops, raw=False):
        answer = self.owner.call('POST', f"/wiki/spaces/{self.ids[space['id']]}/changesets",
                                 {'ops': ops, 'rationale': f'{SEED_NOTE}: DS1 wiki entry'})
        return answer if raw else answer['ops'][0]['entryId']

    def agent_add(self, e, entry, callers, used, quote):
        caller = next(s for s in callers if used.get(s['id'], 0) < 15)
        used[caller['id']] = used.get(caller['id'], 0) + 1
        source = {'kind': 'turn', 'session': 'self'}
        if quote:
            text = [x for x in self.world.events[caller['id']] if x['type'] == 'user'][-1]['payload']['text']
            source['quote'] = text[:40]
        answer = self.door(caller['runner']['name']).call(
            'POST', '/runner/wiki/changesets', {'ops': [{'op': 'add', 'entry': entry, 'sources': [source]}],
                                                'rationale': f'{SEED_NOTE}: DS1 wiki entry'},
            attempts=1, headers={'x-orbit-session-id': self.sid(caller)})
        return answer['ops'][0]['entryId']

    # -- watches ------------------------------------------------------------------------------------------

    def watches(self):
        made_at = time.time()
        for n, w in enumerate(sorted(self.world.watches, key=lambda w: w['created'])):
            action = 'RESUME_SESSION' if w['observer'] else 'NOTIFY_USER'
            notes = []
            if w['observer'] and (w['state'] in ('MATCHED', 'EXPIRED') or self.holds(w)):
                action = 'NOTIFY_USER'
                notes.append('NOTIFY_USER: it matches (or expires) at once, and waking its observer would add a '
                             'turn to a DS1 transcript')
            ttl = 60 if w['state'] == 'EXPIRED' else max(3600, (w['expires'] - ds.ANCHOR) // 1000)
            body = {'predicateVersion': 1, 'predicate': {'kind': 'ALL', 'over': 'ALL_TARGETS', 'leaf': w['leaf']},
                    'targets': [{'kind': w['kind'], 'id': self.ids[t['id']]} for t in w['targets']],
                    'action': action, 'mode': 'ONE_SHOT', 'ttlSeconds': ttl, 'idempotencyKey': f'qa-ds1-watch-{n}'}
            if w['observer']:
                body['observerSessionId'] = self.ids[w['observer']['id']]
            made = self.owner.call('POST', '/watches', body)
            live = made.get('state') in ('ACTIVE', 'PAUSED')  # one whose predicate already held is MATCHED at once
            if w['state'] == 'PAUSED' and live:
                self.owner.call('POST', f"/watches/{made['id']}/pause")
            elif w['state'] == 'CANCELLED' and live:
                self.owner.call('POST', f"/watches/{made['id']}/cancel")
            self.record('DS1', 'watch', w['id'], made['id'], f"{w['leaf']} over {len(w['targets'])} {w['kind'].lower()}(s)",
                        expect={'state': w['state']}, note='; '.join(notes) or None)
        return made_at

    def holds(self, w):
        """Whether a watch's condition already holds for every target on the stack (it then matches when made)."""
        for t in w['targets']:
            if w['kind'] == 'TASK':
                status = self.owner.call('GET', f"/tasks/{self.ids[t['id']]}", attempts=3)['status']
                ok = {'TASK_DONE': status == 'DONE', 'TASK_FAILED': status == 'FAILED',
                      'TASK_TERMINAL': status in ('DONE', 'CANCELLED', 'FAILED')}[w['leaf']]
            else:
                d = self.owner.call('GET', f"/sessions/{self.ids[t['id']]}", attempts=3)
                ok = d['status'] not in ('PENDING', 'RUNNING') if w['leaf'] == 'SESSION_TURN_SETTLED' \
                    else d.get('runState') in ('SUCCEEDED', 'FAILED', 'ENDED')
            if not ok:
                return False
        return True

    # -- DS3 ----------------------------------------------------------------------------------------------

    def ds3(self):
        """DS3: A06's 10,000-event conversation (transcript-fixture.py), one turn per 20 events, in its own
        workspace, with its image uploaded and its task, session and record links pointing at the stack's ids."""
        fx = fixture_module()
        hpc = self.ids[self.world.runners[0]['id']]
        ws = self.owner.call('POST', '/workspaces', {'name': 'DS3 · Reader fixture', 'runnerId': hpc,
                                                     'workDir': '/srv/orbit/repos/ds3-reader', 'enableWorktree': True,
                                                     'description': 'DS3 (A06 transcript-fixture.py): one 10,000-event conversation'})
        task = self.owner.call('POST', '/tasks', {'title': 'Related reading task', 'description': '**Task description**',
                                                  'assigneeId': ws['id'], 'completionCriterion': 'OWNER_CONFIRMED',
                                                  'autoRunWhenReady': False})
        first = fx.event(1, 'DS3', True)
        session = self.owner.call('POST', '/sessions', {'workspaceId': ws['id'], 'title': 'Long conversation',
                                                       'prompt': first['payload']['text'], 'engine': 'claude',
                                                       'model': 'claude-opus-5-5', 'taskId': task['id']})
        sid = as_uuid(session['id'])
        picture = upload(self.door(), sid, fx.IMAGE, 'reading-fixture-1440x2560.png', 'image/png')
        self.record('DS3', 'workspace', fx.WORKSPACE, ws['id'], 'DS3 · Reader fixture', note="the fixture's workspace is named Reader fixture")
        self.record('DS3', 'task', fx.TASK, task['id'], 'Related reading task')
        self.record('DS3', 'attachment', fx.ATTACHMENT, picture, 'reading-fixture-1440x2560.png (1440x2560 PNG)')
        swap = {fx.ATTACHMENT: picture, fx.TASK: task['id'], fx.SESSION: session['id']}

        def rewrite(value):
            text = json.dumps(value, ensure_ascii=False)
            for old, new in swap.items():
                text = text.replace(old, new)
            return json.loads(text)

        cycles = 10000 // 20
        plans = []
        for cycle in range(cycles):
            rows = [fx.event(cycle * 20 + slot, 'DS3', True) for slot in range(1, 21)]
            complete = {'numTurns': cycle + 1}
            if cycle == cycles - 1:
                complete.update(isolationStatus='worktree', baseSha='a' * 40, worktreeDirty=True, branchMerged=False,
                                changedFiles=[{'path': 'reader.kt', 'additions': 12, 'deletions': 3, 'status': 'M'}])
            plans.append(TurnPlan([(r['type'], rewrite(r['payload'])) for r in rows], complete=complete))
        script = Script('DS3', plans)
        self.scripts.add(sid, script)
        self.drive(session['id'], script, cycles - 1)
        # The rich message (seq 9998) links the record at seq 4900. The API names no event by id, so the link
        # names the turn that holds it, which the server resolves to that turn's first event (seq 4881).
        record = self.owner.call('GET', f"/sessions/{session['id']}/events/page?after=4899&limit=1")['events'][0]
        swap[fx.RECORD] = record['turnPublicId']
        last = [fx.event(seq, 'DS3', True) for seq in range(9981, 10001)]
        plans[-1].events = [(r['type'], rewrite(r['payload'])) for r in last]
        self.drive(session['id'], script, cycles)
        self.record('DS3', 'session', fx.SESSION, session['id'], 'Long conversation',
                    expect={'status': 'AWAITING_INPUT', 'events': 10000},
                    note="the fixture serves it RUNNING (for A06's streaming tests); here its last turn has ended")
        self.record('DS3', 'record', fx.RECORD, record['turnPublicId'], 'the turn holding seq 4900 (the ?at= link in seq 9998)',
                    note='a turn id: the API exposes no event id, so the link lands on seq 4881, that turn\'s first event')
        log(f'DS3: "Long conversation" {session["id"]}, 10,000 events')

    # -- the QA cards' own objects ---------------------------------------------------------------------------

    def qa_objects(self):
        hpc = self.ids[self.world.runners[0]['id']]
        ws = self.owner.call('POST', '/workspaces', {
            'name': 'QA · cards', 'runnerId': hpc, 'workDir': '/srv/orbit/repos/qa-cards',
            'description': 'A02d: pending approval cards on demand (stack.py card B01|B02|B03|B15)'})
        intro = ('QA cards: send "qa card B01" (tool permission), "qa card B02" (question) or "qa card B03" (plan) here, '
                 'or in any session, and the fake runner raises that card. `stack.py card B15` asks the owner a '
                 'coordinator question on the project "QA · coordinator questions (B15)".')
        session = self.owner.call('POST', '/sessions', {'workspaceId': ws['id'], 'title': 'QA · cards (B01 B02 B03)',
                                                       'prompt': intro, 'engine': 'claude', 'model': 'claude-opus-5-5'})
        welcome = TurnPlan(lambda turn: [('user', {'text': turn.content}),
                                         ('assistant', {'text': 'Ready. Ask for a card with "qa card B01", "qa card B02" or "qa card B03".'})])
        script = Script('QA cards', [welcome])
        self.scripts.add(as_uuid(session['id']), script)
        self.drive(session['id'], script, 1)
        project = self.owner.call('POST', '/projects', {
            'title': 'QA · coordinator questions (B15)', 'workspaceId': ws['id'], 'maxConcurrentTasks': 1,
            'goal': 'Raise a coordinator question to the owner on demand: python3 stack.py card B15.',
            'acceptanceCriteriaItems': [{'text': 'The owner sees and answers a coordinator question.',
                                         'verificationMethod': 'Answer the question on the project page.'}]})
        coordinator = self.owner.call('GET', f"/projects/{project['id']}")['coordinatorSessionId']
        opening = TurnPlan(lambda turn: [('user', {'text': turn.content}),
                                         ('assistant', {'text': 'QA coordinator ready: `stack.py card B15` asks the owner a question here.'})])
        script = Script('QA coordinator', [opening])
        self.scripts.add(as_uuid(coordinator), script)
        self.drive(coordinator, script, 1)
        qa = self.qa = {'workspace': ws['id'], 'cardsSession': session['id'], 'project': project['id'],
                        'coordinator': coordinator}
        self.state.write('qa.json', qa)
        for kind, key, title in (('workspace', 'workspace', 'QA · cards'), ('session', 'cardsSession', 'QA · cards (B01 B02 B03)'),
                                 ('project', 'project', 'QA · coordinator questions (B15)'),
                                 ('session', 'coordinator', 'coordinator of QA · coordinator questions (B15)')):
            self.record('QA', kind, f'qa-{key}', qa[key], title)
        log('QA: cards workspace, session and B15 project ready')

    # -- the end ------------------------------------------------------------------------------------------

    def last_touches(self):
        world = self.world
        for w in world.workspaces:
            body = {'enableWorktree': True}
            if not w['enabled']:
                body['enabled'] = False
            self.owner.call('PATCH', f"/workspaces/{self.ids[w['id']]}", body)
        for l in world.lists:
            if l['paused']:
                self.owner.call('PATCH', f"/task-lists/{self.ids[l['id']]}", {'paused': True, 'note': SEED_NOTE})
        for r in world.runners:
            if not r['online']:
                self.runner.retire(r['name'])


def wiki_entry(e):
    """A DS1 entry as a changeset `add` carries it. Where the A02c fields fall short of contracts/wiki.contract.json
    the smallest addition makes them valid: a decision's decidedAt is a date, a pitfall's trigger names commands."""
    fields = json.loads(json.dumps(e['fields']))
    if e['kind'] == 'decision':
        fields['decidedAt'] = fields['decidedAt'][:10]
    if e['kind'] == 'pitfall':
        fields['trigger'] = {'paths': fields['trigger'].get('paths', []), 'commands': fields['trigger'].get('commands', [])}
    entry = {'kind': e['kind'], 'title': e['title'], 'summary': e['summary'], 'fields': fields, 'topics': e['topics']}
    if e['aliases']:
        entry['aliases'] = e['aliases']
    if e['anchors']:
        entry['anchors'] = e['anchors']
    return entry


def upload(door, sid, data, name, mime):
    boundary = 'qa-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f'Content-Type: {mime}\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    api = door.api
    conn = api._connection(120)
    conn.request('POST', f'{api.prefix}/runner/sessions/{sid}/attachments', body=body,
                 headers={**sr.RUNNER_HEADERS, 'authorization': 'Bearer ' + door.token,
                          'content-type': f'multipart/form-data; boundary={boundary}'})
    answer = conn.getresponse()
    raw = answer.read().decode()
    if answer.status >= 300:
        raise Refusal('POST', f'/runner/sessions/{sid}/attachments', answer.status, raw)
    return as_public(json.loads(raw)['id']) if sr.UUID_RE.match(json.loads(raw)['id']) else json.loads(raw)['id']


# ------------------------------------------------------------------------------------------------- seed

def run_seed(args):
    state = State(args.state)
    api = sr.Api(args.server)
    previous = state.read('stack.json')
    if previous and previous.get('server') != api.server:
        raise SystemExit(f'{state.root} belongs to {previous["server"]}: use another --state')
    handle = state.lock()
    started = time.time()
    for name in ('held.json', 'map.json', 'map.tsv', 'qa.json'):
        if state.path(name).exists():
            state.path(name).unlink()
    state.write('stack.json', {'server': api.server, 'seedStartedAt': sr.now_iso()})
    seeder = Seeder(state, api, args.workers)
    seeder.world, _ = ds.ds1_world()
    seeder.accounts()
    seeder.register_runners()
    seeder.directory()
    seeder.qa_objects()
    ds3 = threading.Thread(target=seeder.ds3, name='ds3', daemon=True)
    ds3.start()
    seeder.projects()
    seeder.tasks()
    seeder.sessions(before_last=ds3.join)
    seeder.finish_sessions()
    seeder.finish_tasks()
    seeder.finish_projects()
    seeder.wiki()
    watched = seeder.watches()
    seeder.last_touches()
    # An EXPIRED watch was made with the shortest life the server allows (60 s); its expiry is the evaluator's.
    time.sleep(max(0, watched + 75 - time.time()))
    state.write('stack.json', {'server': api.server, 'seedStartedAt': (state.read('stack.json') or {}).get('seedStartedAt'),
                               'seededAt': sr.now_iso(), 'seconds': round(time.time() - started)})
    seeder.runner.stop()
    map_rows = {'server': api.server, 'objects': seeder.objects, 'notes': seeder.notes}
    state.write('map.json', map_rows)
    handle.close()
    log(f'seeded in {round(time.time() - started)} s; checking it')
    return verify(state, api)


# ------------------------------------------------------------------------------------------------ serve

class ServeHandler:
    """The service's turns: a held DS1 turn stays running, "qa card B0x" raises that card, the owner's answer to
    a coordinator question is acknowledged, and anything else is answered with an echo."""

    def __init__(self, state, owner):
        self.state, self.owner = state, owner
        self.held = state.read('held.json') or {}
        self.lock = threading.Lock()

    def forget(self, turn):
        with self.lock:
            if self.held.get(turn.sid) == turn.turn_id:
                del self.held[turn.sid]
                self.state.write('held.json', self.held)

    def __call__(self, turn):
        if self.held.get(turn.sid) == turn.turn_id:
            hold(turn, self.forget)
            return
        if turn.kind == 'shell':
            turn.complete('SUCCEEDED', shellExitCode=0, subtype='shell', result='',
                          shellOutput='QA fake runner: shell commands are not run on this stack.\n')
            return
        card = CARD_RE.search(turn.content)
        if card:
            raise_card(card.group(1).upper(), turn, self.owner)
        elif notice(turn):
            pass
        elif turn.content.startswith('From Orbit · owner answer:'):
            turn.post([('user', {'text': turn.content}),
                       ('assistant', {'text': 'Thanks, I have your answer (QA fake runner).'})])
            turn.complete('SUCCEEDED', subtype='success', result='acknowledged')
        else:
            turn.post([('user', {'text': turn.content}), ('assistant', {'text': echo_reply(turn.content)})])
            turn.complete('SUCCEEDED', subtype='success', result='echo')


QUESTIONS = [
    {'question': 'Which build should the testers get first?', 'header': 'Build', 'multiSelect': False,
     'options': [{'label': 'Release APK', 'description': 'Signed, as it will ship'},
                 {'label': 'Debug APK', 'description': 'With logging and the fixture switches'}]},
    {'question': 'Which devices should run it?', 'header': 'Devices', 'multiSelect': True,
     'options': [{'label': 'Pixel 11 Pro XL'}, {'label': 'API 29 emulator'}, {'label': 'API 36 emulator'}]},
]
PLAN = ('## Plan: ship the reader fixes\n\n1. Rebuild the release APK from the candidate tag.\n'
        '2. Install it over the current build on the Pixel and on the API 29 emulator.\n'
        '3. Open "Long conversation" (DS3) on both and compare the first screen.\n\n'
        '| Step | Device | Expected |\n| --- | --- | --- |\n| 2 | Pixel | upgrade keeps the sign-in |\n'
        '| 3 | both | same messages and images |\n')


def raise_card(kind, turn, owner):
    """One QA card in this turn: the tool call a runtime would ask about, the approval, then what the answer
    leads to. The turn stays running while the card waits, as a real one does."""
    tool_id = 'toolu_qa_' + uuid.uuid4().hex[:20]
    if kind == 'B01':
        clear_push_rules(owner, turn.sid)
        name, payload = 'Bash', {'command': 'git push origin HEAD', 'description': 'Push the current branch'}
        intro = 'I need to push the branch; asking for permission first.'
    elif kind == 'B02':
        name, payload = 'AskUserQuestion', {'questions': QUESTIONS}
        intro = 'Two questions before I go on.'
    else:
        name, payload = 'ExitPlanMode', {'plan': PLAN}
        intro = 'Here is the plan; it waits for your approval.'
    turn.post([('user', {'text': turn.content}), ('assistant', {'text': intro}),
               ('tool_use', {'id': tool_id, 'name': name, 'input': payload})])
    decision = turn.approval({'toolName': name, 'input': payload, 'toolUseId': tool_id})
    if decision is None:
        if turn.stop_reason == 'interrupt':
            turn.post([('interrupt', {'requestId': str(uuid.uuid4())})])
            turn.complete('INTERRUPTED', subtype='interrupted', result='')
        return
    allowed = decision.get('behavior') == 'allow'
    message = decision.get('message') or ''
    if kind == 'B01':
        result = ('Everything up-to-date', False) if allowed else (f'Permission denied. {message}'.strip(), True)
        rules = decision.get('rememberRules') or []
        reply = ('Pushed.' + (' You also allowed it from now on: ' + ', '.join(r.get('toolName', '') + (':' + r['ruleContent'] if r.get('ruleContent') else '') for r in rules) if rules else '')) \
            if allowed else 'Not pushed: you denied it.' + (f' Your note: {message}' if message else '')
    elif kind == 'B02':
        answers = decision.get('answers') or {}
        said = '; '.join(f'"{q}" = {", ".join(a)}' for q, a in answers.items())
        result = (f'User has answered your questions: {said}.', False) if allowed else (f'The user did not answer. {message}'.strip(), True)
        reply = f'Thanks. You answered: {said}.' if allowed else 'No answers, so I will wait.' + (f' Your note: {message}' if message else '')
    else:
        result = ('User has approved your plan. You can now start coding.', False) if allowed \
            else (f'The user wants to keep planning. {message}'.strip(), True)
        reply = 'Approved: running the plan (nothing runs on this QA stack).' if allowed else 'Keeping on planning.' + (f' Your note: {message}' if message else '')
    turn.post([('tool_result', {'toolUseId': tool_id, 'content': result[0], 'isError': result[1]}),
               ('assistant', {'text': reply})])
    turn.complete('SUCCEEDED', subtype='success', result=reply)


def clear_push_rules(owner, sid):
    """A standing "always allow git push" on the session's workspace would answer B01 by itself; it goes first,
    so the card is asked every time."""
    try:
        workspace = owner.call('GET', f'/sessions/{as_public(sid)}')['workspaceId']
        for rule in owner.call('GET', f'/workspaces/{workspace}/permission-rules') or []:
            if rule.get('toolName') == 'Bash' and (rule.get('ruleContent') or '').startswith('git push'):
                owner.call('DELETE', f"/workspaces/{workspace}/permission-rules/{rule['id']}")
    except Refusal as error:
        log(f'B01: could not clear standing rules: {error}')


def run_serve(args):
    state = State(args.state)
    api = server_of(args, state)
    handle = state.lock()
    owner = owner_of(api, state)
    handler = ServeHandler(state, owner)
    runner = fake_runner(api, state, handler)
    online = [name for name in runner.doors if DS1_RUNNERS[name]['online']]
    runner.start(online)
    for name in online:
        for job in runner.reclaim(name):
            if job.get('sessionId') in handler.held:
                runner.keep.add(job['sessionId'])
    log(f'serving {", ".join(online)} on {api.server}; holding {len(handler.held)} running turns')
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.wait(30):
        for sid in list(handler.held):
            live = runner.sessions.get(sid)
            if live is not None and not live.polling and not live.ended:
                runner.keep.add(sid)
                runner.poll_soon(live)
    runner.stop()
    handle.close()


# ------------------------------------------------------------------------------------------------- cards

def run_card(args):
    state = State(args.state)
    api = server_of(args, state)
    owner = owner_of(api, state)
    qa = state.read('qa.json') or {}
    if args.kind in ('B01', 'B02', 'B03'):
        sid = args.session or qa.get('cardsSession')
        body = {'clientTurnId': f'qa-card-{uuid.uuid4()}', 'content': f'qa card {args.kind}'}
        try:
            owner.call('POST', f'/sessions/{sid}/turns', body)
        except Refusal as error:
            if error.status != 409:
                raise
            owner.call('POST', f'/sessions/{sid}/resume', body)
        print(f'{args.kind}: asked in session {sid}; the fake runner service raises the card '
              f'({"running" if service_active() else "NOT running: start it with `service start`"})')
        return
    pid = args.project or qa.get('project')
    coordinator = owner.call('GET', f'/projects/{pid}')['coordinatorSessionId']
    creds = state.read('runners.json')
    door = sr.RunnerDoor(api, 'hpc-build-01', creds['runners']['hpc-build-01']['runnerToken'])
    asked = door.call('POST', f'/runner/projects/{pid}/owner-questions', {
        'question': 'Ship the Android candidate to the internal testers before the release notes are final?',
        'options': [{'label': 'Ship now', 'description': 'Testers get it today; the notes follow.'},
                    {'label': 'Wait for the notes', 'description': 'One build with complete notes.'}],
        'recommendedOption': 1, 'ifUnanswered': 'I will wait for the notes.',
        'clientQuestionId': f'qa-b15-{uuid.uuid4()}'}, attempts=1, headers={'x-orbit-session-id': coordinator})
    print(f"B15: coordinator question {asked['itemId']} is open on project {pid}")


# ----------------------------------------------------------------------------------------------- verify

def verify(state, api):
    """Reads every mapped object back and compares it with what the seed expected; map.json gets each object's
    stack state, map.tsv the table. Exit status 1 when anything differs from what was expected."""
    owner = owner_of(api, state)
    data = state.read('map.json')
    if not data:
        raise SystemExit(f'no map in {state.root}: run `seed` first')
    world, _ = ds.ds1_world()
    events = {ds.base62(s['id']): world.events[s['id']] for s in world.sessions}
    sessions = {}
    for view in ('open', 'completed', 'trash'):
        for row in owner.call('GET', f'/sessions?view={view}', attempts=3):
            sessions[row['id']] = {**row, 'view': view}
    tasks = {}
    cursor = None
    while True:
        page = owner.call('GET', '/tasks/page?limit=200' + (f'&cursor={cursor}' if cursor else ''), attempts=3)
        for row in page.get('items', []):
            tasks[row['id']] = row
        cursor = page.get('nextCursor')
        if not cursor:
            break
    problems = 0
    for row in data['objects']:
        expect, actual = row.get('expect') or {}, {}
        kind, sid = row['kind'], row['stackId']
        if kind == 'session' and row['dataset'] == 'DS1':
            s = sessions.get(sid) or {}
            actual = {'status': s.get('status'), 'endReason': s.get('endReason'), 'view': s.get('view'),
                      'pinned': bool(s.get('pinnedAt')), 'branch': bool(owner.call('GET', f'/sessions/{sid}', attempts=3).get('branch'))}
            stored = owner.call('GET', f'/sessions/{sid}/events/page?tail=250', attempts=3)['events']
            want = events[row['manifestId']]
            same = len(stored) == len(want) and all(a['seq'] == b['seq'] and a['type'] == b['type'] and a['payload'] == b['payload']
                                                    for a, b in zip(stored, want))
            actual['events'] = len(stored) if same else f'{len(stored)} (differs from the manifest)'
        elif kind == 'session' and row['dataset'] == 'DS3':
            d = owner.call('GET', f'/sessions/{sid}', attempts=3)
            last = owner.call('GET', f'/sessions/{sid}/events/page?tail=1', attempts=3)['events']
            actual = {'status': d['status'], 'events': last[0]['seq'] if last else 0}
        elif kind == 'task' and row['dataset'] == 'DS1':
            t = tasks.get(sid) or owner.call('GET', f'/tasks/{sid}', attempts=3)
            actual = {'status': t.get('status'), 'criterion': t.get('completionCriterion'), 'creatorType': t.get('creatorType')}
        elif kind == 'project':
            p = owner.call('GET', f'/projects/{sid}', attempts=3)
            actual = {'status': p['status'], 'started': bool(p.get('startedAt')), 'coordinator': bool(p.get('coordinatorSessionId'))}
        elif kind == 'task-list':
            actual = {'paused': owner.call('GET', f'/task-lists/{sid}?tasks=none', attempts=3).get('paused')}
        elif kind == 'workspace' and row['dataset'] == 'DS1':
            w = next((x for x in owner.call('GET', '/workspaces', attempts=3) if x['id'] == sid), {})
            actual = {'runner': (w.get('runner') or {}).get('name'), 'position': w.get('position'), 'enabled': w.get('enabled')}
        elif kind == 'runner':
            r = next((x for x in owner.call('GET', '/runners', attempts=3) if x['id'] == sid), {})
            actual = {'online': r.get('online'), 'position': r.get('position')}
            expect = {**expect, 'position': r.get('position') if expect.get('position') is None else expect['position']}
        elif kind == 'wiki-entry':
            e = owner.call('GET', f'/wiki/entries/{sid}', attempts=3)
            actual = {'status': e.get('status'), 'trust': e.get('trust'), 'kind': e.get('kind')}
        elif kind == 'wiki-space':
            actual = {'slug': owner.call('GET', f'/wiki/spaces/{sid}', attempts=3).get('slug')}
        elif kind == 'watch':
            w = next((x for x in owner.call('GET', '/watches?limit=200', attempts=3) if x['id'] == sid), {})
            actual = {'state': w.get('state')}
        row['actual'] = actual
        differs = {k: (expect.get(k), actual.get(k)) for k in expect if k in actual and expect.get(k) != actual.get(k)}
        if row['kind'] == 'watch' and differs:
            row['deviation'] = 'state follows its targets on the stack: ' + ', '.join(f'{k} {v[0]} -> {v[1]}' for k, v in differs.items())
            differs = {}
        row['ok'] = not differs
        if differs:
            row['differs'] = differs
            problems += 1
    data['verifiedAt'] = sr.now_iso()
    data['problems'] = problems
    state.write('map.json', data)
    state.write('map.tsv', None, text=map_tsv(data))
    kinds = {}
    for row in data['objects']:
        kinds.setdefault((row['dataset'], row['kind']), [0, 0])
        kinds[(row['dataset'], row['kind'])][0] += 1
        kinds[(row['dataset'], row['kind'])][1] += 0 if row.get('ok', True) else 1
    for (dataset, kind), (n, bad) in sorted(kinds.items()):
        log(f'{dataset:8} {kind:12} {n:4}' + (f'  {bad} differ' if bad else ''))
    log(f'map: {state.path("map.tsv")} ({len(data["objects"])} rows, {problems} differing from what the seed expected)')
    return 1 if problems else 0


def map_tsv(data):
    lines = ['dataset\tkind\tmanifest id\tstack id\ttitle\tok\texpected\tactual\tnote']
    for row in data['objects']:
        lines.append('\t'.join(str(x) for x in (
            row['dataset'], row['kind'], row['manifestId'], row['stackId'], row['title'].replace('\t', ' '),
            'yes' if row.get('ok', True) else 'NO', json.dumps(row.get('expect') or {}, ensure_ascii=False),
            json.dumps(row.get('actual') or {}, ensure_ascii=False),
            '; '.join(filter(None, [row.get('note'), row.get('deviation')])))))
    return '\n'.join(lines) + '\n'


# --------------------------------------------------------------------------------------------- service

def service_active():
    return subprocess.run(['systemctl', 'is-active', '--quiet', UNIT]).returncode == 0


def run_service(args):
    state = State(args.state)
    if args.action == 'stop':
        if service_active():
            subprocess.run(['systemctl', 'stop', UNIT], check=True)
        print(f'{UNIT}: stopped')
    elif args.action == 'status':
        subprocess.run(['systemctl', 'status', '--no-pager', '--lines=15', UNIT])
    else:
        if service_active():
            raise SystemExit(f'{UNIT} is already running')
        server = server_of(args, state).server
        tools = state.path('bin')
        tools.mkdir(parents=True, exist_ok=True)
        for name in TOOL_FILES:
            shutil.copy2(HERE / name, tools / name)
        subprocess.run(['systemd-run', f'--unit={UNIT}', '--collect', '--property=Restart=on-failure',
                        '--property=RestartSec=10', '--setenv=PYTHONUNBUFFERED=1', sys.executable, '-I',
                        str(tools / 'stack.py'), '--state', str(state.root), 'serve', '--server', server], check=True)
        print(f'{UNIT}: started (journalctl -u {UNIT} -f)')


def run_rebuild(args):
    service = argparse.Namespace(state=args.state, server=args.server, action='stop')
    run_service(service)
    code = run_seed(args)
    run_service(argparse.Namespace(state=args.state, server=args.server, action='start'))
    return code


def run_status(args):
    state = State(args.state)
    api = server_of(args, state)
    owner = owner_of(api, state)
    health = api.call('GET', '/health', attempts=3)
    runners = owner.call('GET', '/runners', attempts=3)
    counts = {view: len(owner.call('GET', f'/sessions?view={view}', attempts=3)) for view in ('open', 'completed', 'trash')}
    accounts = state.read('accounts.json')
    print(json.dumps({'server': api.server, 'health': health, 'accounts': [accounts['admin']['email'], accounts['member']['email']],
                      'passwords': str(state.path('accounts.json')), 'sessions': counts,
                      'runners': {r['name']: r['status'] for r in runners}, 'service': 'active' if service_active() else 'inactive',
                      'map': str(state.path('map.tsv')), 'seed': state.read('stack.json')}, indent=1, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--state', default=str(DEFAULT_STATE), help='state directory (default %(default)s)')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('seed', 'rebuild'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--server', required=True, help='the stack, e.g. http://217.216.108.220:2087')
        cmd.add_argument('--workers', type=int, default=8, help='sessions played at once (default %(default)s)')
    serve = sub.add_parser('serve')
    serve.add_argument('--server')
    service = sub.add_parser('service')
    service.add_argument('action', choices=('start', 'stop', 'status'))
    service.add_argument('--server')
    card = sub.add_parser('card')
    card.add_argument('kind', choices=('B01', 'B02', 'B03', 'B15'))
    card.add_argument('--session', help='B01-B03: the session to ask in (default: QA · cards)')
    card.add_argument('--project', help='B15: the project whose coordinator asks (default: QA · coordinator questions)')
    card.add_argument('--server')
    for name in ('verify', 'status'):
        sub.add_parser(name).add_argument('--server')
    args = parser.parse_args()
    if args.command == 'seed':
        return run_seed(args)
    if args.command == 'rebuild':
        return run_rebuild(args)
    if args.command == 'serve':
        return run_serve(args)
    if args.command == 'service':
        return run_service(args)
    if args.command == 'card':
        return run_card(args)
    if args.command == 'verify':
        state = State(args.state)
        return verify(state, server_of(args, state))
    return run_status(args)


if __name__ == '__main__':
    sys.exit(main())
