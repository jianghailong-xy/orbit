#!/usr/bin/env python3
"""The long-running-loop acceptance drill (docs/long-running-loop-contract.md; task E of project 34pUaJboWdDFzjftkEso8),
on stack.sh's isolated real stack: this checkout's apiserver and runner-go, the host's Claude Code as the engine, and
fake-model.py instead of a model. Nothing here talks to a production server.

Who does what:
  - runner a holds session A: a loop of schedule_wakeup({recurring: true, everySeconds: 300, ...}) and, from the same
    opening turn, a bg_run of `sleep 7200` with wakeOnStall {afterSeconds: 1800}. About an hour in, between two ticks,
    runner a is killed with SIGKILL, and started again 25 minutes later. After two hours the loop is stopped with two
    calls of stop: true, and the session is watched for 16 minutes more.
  - runner b holds session B: a loop every 60 s whose ticks each hold their answer open 30 s (FAKE-SLOW), so runner b
    is killed in the middle of a tick's turn. It stays down until the auto-retry has given up on the session
    (MAX_OFFLINE_WAIT_MS, 30 minutes) and at least four ticks have found the session FAILED with no retry armed; then
    it comes back, and the loop has to bring the session back by itself (a revive), with nobody asking.
  - runner c is never killed. Its session C runs the same 7200-second sleep job (the stall wake over a full two hours
    on a runner that is there throughout) and is the agent that calls session_get on A and B while their runners are
    down and after they are back: the real mcp__orbit__session_get tool, from inside a session.
  - runners f1-f3 only heartbeat, so the cell has six runners and one runner's death is not read as a mass
    disconnection (a fifth or more of the cell), as it would not be on a production control plane.

Usage: drill.py setup | run | sample | status | dump OUT
  setup   owner account, the fake-model key, six runners (registered, configured, started, online), three workspaces
  run     the timeline; every step is recorded in the state file when done, so a second `run` resumes after it
  sample  every 10 s, the sessions, loops, turns and runners as the database has them (records/samples.jsonl)
  dump    the evidence files into OUT
Environment: LRL_DIR, LRL_API_PORT, LRL_FAKE_PORT as stack.sh; LRL_PROFILE=full (default) or smoke, a 12-minute pass
over the same steps with short intervals, for checking the drill itself.
"""

import calendar
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STACK = REPO / 'scripts/long-running-loops/stack.sh'
LRL_DIR = Path(os.environ.get('LRL_DIR', '/mnt/data/tmp/lrle'))
API_PORT = int(os.environ.get('LRL_API_PORT', '13910'))
FAKE_PORT = int(os.environ.get('LRL_FAKE_PORT', '13912'))
API = f'http://127.0.0.1:{API_PORT}/api'
PG = 'orbit-lrl-pg'
STATE = LRL_DIR / 'state/drill.json'
REC = LRL_DIR / 'records'
FAKE_LOG = LRL_DIR / 'logs/fake-model.jsonl'
API_LOG = LRL_DIR / 'logs/apiserver.log'
PUSH_LOG = LRL_DIR / 'logs/push-calls.jsonl'
RUNNERS = ('a', 'b', 'c', 'f1', 'f2', 'f3')
FAKE_KEY = 'sk-lrl-fake-model-not-a-key-0123456789'
# The tools the drill's turns call that no runner hook answers: allowed in each engine's own user settings, as a person
# who had allowed them would have. bg_run is allowed by the runner's own PreToolUse hook (bg-guard).
ALLOWED_TOOLS = ['mcp__orbit__schedule_wakeup', 'mcp__orbit__session_get']

PROFILES = {
    'full': dict(every_a=300, delay_a=150, until_a=14400, sleep=7200, stall_after=1800,
                 every_b=60, delay_b=60, slow_b=30, until_b=7200,
                 c_start=30, b_start=120, b_kill_after=600, b_get1_after_kill=1200,
                 b_restart_min=1800, b_refused_min=4, b_restart_cap=3600, b_get2_after_restart=180, b_stop_after_restart=360,
                 a_kill_after_tick=12, a_down=1500, a_get1_after_kill=1260, a_get2_after_restart=300, a_stop_at=7200, quiet=960),
    'smoke': dict(every_a=60, delay_a=30, until_a=3600, sleep=900, stall_after=60,
                  every_b=60, delay_b=60, slow_b=20, until_b=3600,
                  c_start=10, b_start=20, b_kill_after=150, b_get1_after_kill=60,
                  b_restart_min=120, b_refused_min=0, b_restart_cap=150, b_get2_after_restart=60, b_stop_after_restart=90,
                  a_kill_after_tick=3, a_down=150, a_get1_after_kill=100, a_get2_after_restart=60, a_stop_at=600, quiet=120),
}
P = PROFILES[os.environ.get('LRL_PROFILE', 'full')]


# ---- plumbing --------------------------------------------------------------------------------------------------------

def now_iso(epoch=None):
    epoch = time.time() if epoch is None else epoch
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(epoch)) + f'.{int(epoch % 1 * 1000):03d}Z'


def log(event, **fields):
    REC.mkdir(parents=True, exist_ok=True)
    line = {'at': now_iso(), 'event': event, **fields}
    with open(REC / 'timeline.jsonl', 'a') as f:
        f.write(json.dumps(line, default=str) + '\n')
    print(json.dumps(line, default=str), flush=True)


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE.parent, 0o700)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2, default=str))
    os.chmod(tmp, 0o600)
    tmp.replace(STATE)


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2))
    os.chmod(path, 0o600)


def http(method, path, body=None, token=None, timeout=60):
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def owner_call(state, method, path, body=None):
    """As the drill's owner, signing in again when the access token has expired."""
    status, answer = http(method, path, body, token=state['owner'].get('accessToken'))
    if status == 401:
        sign_in(state)
        status, answer = http(method, path, body, token=state['owner']['accessToken'])
    return status, answer


def sign_in(state):
    owner = state['owner']
    status, answer = http('POST', '/auth/login', {'email': owner['email'], 'password': owner['password']})
    if status not in (200, 201):
        raise SystemExit(f'sign-in: {status} {answer}')
    owner.update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
    save(state)


def must(result, what):
    status, answer = result
    if status not in (200, 201):
        raise SystemExit(f'{what}: {status} {answer}')
    return answer


def sql(query):
    result = subprocess.run(['docker', 'exec', PG, 'psql', '-U', 'orbit', '-d', 'orbit', '-At', '-v', 'ON_ERROR_STOP=1',
                             '-c', query], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'psql failed: {result.stderr.strip()[-500:]}')
    return [line for line in result.stdout.splitlines() if line]


def sql_json(query):
    rows = sql(f'select coalesce(json_agg(row_to_json(t)), \'[]\'::json) from ({query}) t')
    return json.loads(rows[0]) if rows else []


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def to_uuid(public_id):
    if re.fullmatch(r'[0-9a-f-]{36}', public_id):
        return public_id
    script = 'const {toUuid} = require(process.argv[1]); console.log(toUuid(process.argv[2]));'
    result = subprocess.run(['node', '-e', script, str(REPO / 'src/shared/dist/index.js'), public_id],
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def stack(*args):
    result = subprocess.run(['bash', str(STACK), *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'stack.sh {" ".join(args)}: {result.returncode} {result.stderr.strip()[-800:]}')
    return result.stdout + result.stderr


def sleep_until(epoch, why):
    remaining = epoch - time.time()
    if remaining > 0:
        log('wait', until=now_iso(epoch), seconds=round(remaining), why=why)
        while time.time() < epoch:
            time.sleep(min(5, max(0.2, epoch - time.time())))


def wait_for(predicate, timeout, what, every=2):
    deadline = time.time() + timeout
    while True:
        found = predicate()
        if found:
            return found
        if time.time() > deadline:
            raise RuntimeError(f'timed out after {timeout} s waiting for {what}')
        time.sleep(every)


def runner_beat_sql(alias='r'):
    return f'greatest((select p.last_beat_at from runner_presence p where p.runner_id = {alias}.id), {alias}.last_heartbeat_at)'


def runner_online(runner_uuid):
    rows = sql_json(f"select extract(epoch from now() - {runner_beat_sql()}) as silent_s, r.capabilities_reported_at "
                    f"from runner r where r.id = {quote(runner_uuid)}")
    return bool(rows) and rows[0]['silent_s'] is not None and rows[0]['silent_s'] < 60 and rows[0]['capabilities_reported_at']


def unit_processes(name):
    unit = f'orbit-lrl-runner-{name}'
    group = subprocess.run(['systemctl', 'show', '-P', 'ControlGroup', unit], capture_output=True, text=True).stdout.strip()
    procs = Path(f'/sys/fs/cgroup{group}/cgroup.procs')
    if not group or not procs.exists():
        return []
    found = []
    for pid in procs.read_text().split():
        out = subprocess.run(['ps', '-o', 'pid=,ppid=,lstart=,args=', '-p', pid], capture_output=True, text=True).stdout.strip()
        if out:
            found.append(out[:220])
    return found


def sleep_jobs():
    """Every `sleep` process on the host started by a drill job, with the cgroup it lives in."""
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if args[0] != b'sleep' or len(args) < 2 or args[1] != str(P['sleep']).encode():
                continue
            found.append({'pid': int(proc.name), 'cgroup': (proc / 'cgroup').read_text().strip()})
        except OSError:
            continue
    return found


def fake_lines():
    if not FAKE_LOG.exists():
        return []
    lines = []
    for raw in FAKE_LOG.read_text().splitlines():
        try:
            lines.append(json.loads(raw))
        except ValueError:
            pass
    return lines


def plan_lines(marker, after_n=0):
    """fake-model.py's lines of the drill turn carrying marker (its turn's markers, or the last user text)."""
    return [line for line in fake_lines() if line.get('n', 0) > after_n and
            (marker in (line.get('turnMarkers') or []) or marker in (line.get('lastUser') or ''))]


def last_fake_n():
    numbered = [line['n'] for line in fake_lines() if 'n' in line]
    return max(numbered) if numbered else 0


# ---- setup -------------------------------------------------------------------------------------------------------------

def cmd_setup(_args):
    state = load()
    REC.mkdir(parents=True, exist_ok=True)
    if 'owner' not in state:
        state['owner'] = {'email': 'lrl-drill-owner@lab.invalid', 'password': uuid.uuid4().hex}
        answer = must(http('POST', '/auth/bootstrap', {**state['owner'], 'name': 'LRL drill owner'}), 'bootstrap')
        state['owner'].update(accessToken=answer['accessToken'], refreshToken=answer['refreshToken'], user=answer['user'])
        save(state)
        log('owner', created=True, user=answer['user'].get('id'))
    else:
        sign_in(state)
    if 'provider' not in state:
        key = must(owner_call(state, 'POST', '/providers/mine', {
            'label': 'FAKE model on loopback (drill, not a model)', 'presetSlug': 'deepseek',
            'baseUrl': f'http://127.0.0.1:{FAKE_PORT}/anthropic', 'apiKey': FAKE_KEY}), 'providers/mine')
        state['provider'] = {k: key.get(k) for k in ('id', 'slug', 'label', 'presetSlug', 'baseUrl', 'defaultModel', 'runtime')}
        save(state)
        log('provider', **state['provider'])
    runners = state.setdefault('runners', {})
    for name in RUNNERS:
        if name in runners:
            continue
        enrollment = must(owner_call(state, 'POST', '/runners/enrollment-tokens', {'label': f'lrl drill {name}'}), 'enrollment')
        registered = must(http('POST', '/runner/register', {'enrollmentToken': enrollment['token'], 'name': f'lrl-{name}',
                                                            'hostname': f'lrl-{name}.lab.invalid', 'version': '0.1.0',
                                                            'maxConcurrent': 2}), 'runner/register')
        directory = LRL_DIR / 'r' / name
        for sub in ('home', 'oh', 'work'):
            (directory / sub).mkdir(parents=True, exist_ok=True)
            os.chmod(directory / sub, 0o700)
        private_write(directory / 'oh/config.json', {
            'serverUrl': f'http://127.0.0.1:{API_PORT}', 'runnerId': registered['runnerId'],
            'runnerToken': registered['runnerToken'], 'name': f'lrl-{name}', 'labels': [], 'maxConcurrent': 2,
            'workDir': str(directory / 'work')})
        # The engine's user settings (HOME/.claude/settings.json): the two Orbit tools the drill's turns call, allowed.
        private_write(directory / 'home/.claude/settings.json', {'permissions': {'allow': ALLOWED_TOOLS}})
        runners[name] = {'uuid': registered['runnerId'], 'name': f'lrl-{name}', 'dir': str(directory)}
        save(state)
        log('runner-registered', name=name, runner=registered['runnerId'])
    for name in RUNNERS:
        print(stack('runner-start', name).strip())
    for name in RUNNERS:
        wait_for(lambda: runner_online(runners[name]['uuid']), 180, f'runner {name} online with its capabilities')
    listed = must(owner_call(state, 'GET', '/runners'), 'runners')
    for name in RUNNERS:
        runners[name]['id'] = next(r['id'] for r in listed if r['name'] == f'lrl-{name}')
    engines = sql_json(f"select r.name, r.engines, r.version from runner r order by r.name")
    log('runners-online', runners=[{'name': e['name'], 'version': e['version'],
                                    'claude': [{k: x.get(k) for k in ('installed', 'version', 'auth')}
                                               for x in (e['engines'] or []) if x.get('engine') == 'claude']} for e in engines])
    workspaces = state.setdefault('workspaces', {})
    for name in ('a', 'b', 'c'):
        if name in workspaces:
            continue
        workspace = must(owner_call(state, 'POST', '/workspaces', {
            'name': f'lrl-{name}', 'runnerId': runners[name]['id'], 'workDir': str(LRL_DIR / 'r' / name / 'work/repo'),
            'autoInitGit': True}), 'workspaces')
        workspaces[name] = {'id': workspace['id'], 'runnerId': runners[name]['id']}
        save(state)
        log('workspace', name=name, id=workspace['id'])
    save(state)
    log('setup-done', profile=os.environ.get('LRL_PROFILE', 'full'))


# ---- the timeline ----------------------------------------------------------------------------------------------------

def create_session(state, name, prompt):
    session = must(owner_call(state, 'POST', '/sessions', {
        'workspaceId': state['workspaces'][name]['id'], 'title': f'LRL drill {name.upper()}', 'prompt': prompt,
        'provider': state['provider']['slug'], 'permissionMode': 'default'}), 'sessions')
    entry = {'id': session['id'], 'uuid': to_uuid(session['id']), 'createdAt': now_iso()}
    state.setdefault('sessions', {})[name] = entry
    save(state)
    return entry


def send(state, name, content):
    session = state['sessions'][name]
    client_turn_id = str(uuid.uuid4())
    answer = must(owner_call(state, 'POST', f"/sessions/{session['id']}/turns",
                             {'clientTurnId': client_turn_id, 'content': content, 'intent': 'NEXT_TURN'}), 'turns')
    return {'clientTurnId': client_turn_id, 'sentAt': now_iso(), 'answer': {k: answer.get(k) for k in ('id', 'placement', 'status')}
            if isinstance(answer, dict) else answer}


def loop_of(session_uuid):
    rows = sql_json(f"select id, state, every_seconds, first_due_at, until_at, created_at, ticks_fired, ticks_missed, revive_streak, "
                    f"ended_reason, ended_at, alerted_at from session_wakeup_loop where session_id = {quote(session_uuid)} "
                    f"order by created_at desc limit 1")
    return rows[0] if rows else None


def await_plan(marker, results, after_n, timeout):
    """Until fake-model.py answered the drill turn `marker` with its plan done, having been sent `results` tool results;
    those results, whole."""
    def done():
        lines = plan_lines(marker, after_n)
        finished = [line for line in lines if line.get('kind') == 'plan_done']
        if not finished:
            return None
        collected = [r for line in lines for r in (line.get('toolResults') or [])]
        return collected if len(collected) >= results else None
    return wait_for(done, timeout, f'the plan of {marker}')


def compact(state, name, label):
    session = state['sessions'][name]
    status, answer = owner_call(state, 'GET', f"/sessions/{session['id']}/compact")
    path = REC / f'compact-{label}.json'
    path.write_text(json.dumps({'at': now_iso(), 'status': status, 'session': answer}, indent=2))
    return {'file': path.name, 'status': status, 'wakeups': answer.get('wakeups') if isinstance(answer, dict) else None}


def observer_get(state, target, label):
    """Session C's agent calls mcp__orbit__session_get on the target session; its result, whole, from the model's side."""
    marker = f'LRL-C-GET-{label}'
    before = last_fake_n()
    sent = send(state, 'c', f"{marker} FAKE-GET {state['sessions'][target]['id']} {label}")
    results = await_plan(marker, 1, before, 300)
    text = results[0]['text']
    path = REC / f'session-get-{label}.txt'
    path.write_text(text)
    parsed = None
    try:
        parsed = json.loads(text)
    except ValueError:
        pass
    return {'sent': sent, 'file': path.name, 'isError': results[0]['isError'],
            'wakeups': parsed.get('wakeups') if isinstance(parsed, dict) else None,
            'status': parsed.get('status') if isinstance(parsed, dict) else None}


def turns_of(session_uuid):
    return sql_json(f"select seq, client_turn_id, kind, status, created_at, delivered_at, answered_at from conversation_turn "
                    f"where session_id = {quote(session_uuid)} order by seq")


def idle(session_uuid):
    rows = sql_json(f"select s.status, (select count(*) from conversation_turn t where t.session_id = s.id and t.status in "
                    f"('PENDING', 'IN_FLIGHT')) as open_turns from session s where s.id = {quote(session_uuid)}")
    return rows[0]


def next_midpoint(loop, after_epoch):
    """The first moment halfway between two ticks of the loop at or after after_epoch."""
    first = iso_epoch(loop['first_due_at'])
    every = loop['every_seconds']
    k = max(0, math.ceil((after_epoch - first - every / 2) / every))
    return first + k * every + every / 2


def iso_epoch(value):
    """An ISO 8601 time as PostgreSQL's JSON or this drill writes it: with Z, with an offset, or with neither (a
    `timestamp` column, which Prisma writes in UTC)."""
    hit = re.fullmatch(r'(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?', value)
    if not hit:
        raise ValueError(f'not a time: {value!r}')
    base = calendar.timegm(time.strptime(f'{hit[1]}T{hit[2]}', '%Y-%m-%dT%H:%M:%S')) + (float(hit[3]) if hit[3] else 0)
    zone = hit[4]
    if zone and zone != 'Z':
        sign = -1 if zone[0] == '+' else 1
        digits = zone[1:].replace(':', '')
        base += sign * (int(digits[:2]) * 3600 + int(digits[2:4] or 0) * 60)
    return base


def refused_revives(session_uuid, since_epoch):
    """The apiserver's log lines of ticks that found the session FAILED, with no retry armed, and could not revive it."""
    if not API_LOG.exists():
        return 0
    count = 0
    for line in API_LOG.read_text(errors='replace').splitlines():
        if f'could not revive session {session_uuid}' in line:
            stamp = re.search(r'(\d{1,2}/\d{1,2}/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M)', line)
            if stamp is None:
                count += 1
                continue
            when = time.mktime(time.strptime(stamp[1], '%m/%d/%Y, %I:%M:%S %p'))
            if when >= since_epoch - 1:
                count += 1
    return count


def disarmed_since(session_uuid):
    """When the samples first show the session FAILED with no retry armed after having had one, or None."""
    samples = REC / 'samples.jsonl'
    if not samples.exists():
        return None
    armed = False
    for raw in samples.read_text().splitlines():
        try:
            sample = json.loads(raw)
        except ValueError:
            continue
        for session in sample.get('sessions') or []:
            if session['id'] != session_uuid:
                continue
            if session['status'] == 'FAILED' and session['retryAt']:
                armed = True
            elif armed and session['status'] == 'FAILED' and not session['retryAt'] and not session['retryClaimedAt']:
                return iso_epoch(sample['at'])
    return None


def cmd_run(_args):
    state = load()
    timeline = state.setdefault('timeline', {})

    def step(name, action):
        if name in timeline:
            return timeline[name]
        log('step', name=name)
        result = action()
        timeline[name] = {'doneAt': now_iso(), **(result or {})}
        save(state)
        log('step-done', name=name, result=timeline[name])
        return timeline[name]

    # Session A: the loop and the 7200-second sleep job, from one opening turn.
    def a_start():
        before = last_fake_n()
        session = create_session(state, 'a', f"LRL-A-START FAKE-RECUR {P['every_a']} {P['until_a']} A 0 {P['delay_a']} "
                                              f"FAKE-STALL {P['sleep']} {P['stall_after']} A")
        state['t0'] = time.time()
        save(state)
        results = await_plan('LRL-A-START', 2, before, 300)
        loop = wait_for(lambda: loop_of(session['uuid']), 60, 'loop A')
        state['loops'] = {**state.get('loops', {}), 'a': loop['id']}
        save(state)
        return {'session': session, 'receipts': results, 'loop': loop}
    a = step('a.start', a_start)
    t0 = state['t0']

    def c_start():
        before = last_fake_n()
        session = create_session(state, 'c', f"LRL-C-START FAKE-STALL {P['sleep']} {P['stall_after']} C")
        results = await_plan('LRL-C-START', 1, before, 300)
        return {'session': session, 'receipts': results}
    sleep_until(t0 + P['c_start'], 'session C starts')
    step('c.start', c_start)

    def b_start():
        before = last_fake_n()
        session = create_session(state, 'b', f"LRL-B-START FAKE-RECUR {P['every_b']} {P['until_b']} B {P['slow_b']} {P['delay_b']}")
        results = await_plan('LRL-B-START', 1, before, 300)
        loop = wait_for(lambda: loop_of(session['uuid']), 60, 'loop B')
        state['loops'] = {**state.get('loops', {}), 'b': loop['id']}
        save(state)
        return {'session': session, 'receipts': results, 'loop': loop}
    sleep_until(t0 + P['b_start'], 'session B starts')
    step('b.start', b_start)

    # Runner b dies in the middle of a tick's turn: one that has been with the engine for 5 to 20 s.
    def b_kill():
        sb = state['sessions']['b']['uuid']

        def mid_turn():
            rows = sql_json(f"select seq, client_turn_id, status, delivered_at, extract(epoch from clock_timestamp() - delivered_at) "
                            f"as running_s from conversation_turn where session_id = {quote(sb)} and status = 'IN_FLIGHT' "
                            f"and client_turn_id like 'bg-wake:wakeup:%' order by seq desc limit 1")
            return rows[0] if rows and 5 <= rows[0]['running_s'] <= 20 else None
        turn = wait_for(mid_turn, 600, 'a tick turn of B in flight', every=0.5)
        processes = unit_processes('b')
        killed = stack('runner-kill', 'b')
        state['bKilledAt'] = time.time()
        save(state)
        after = sql_json(f"select seq, status, delivered_at, answered_at from conversation_turn where session_id = {quote(sb)} "
                         f"and seq = {turn['seq']}")
        return {'turnAtKill': turn, 'turnAfterKill': after, 'processes': processes, 'kill': killed,
                'killedAt': now_iso(state['bKilledAt'])}
    sleep_until(t0 + P['b_kill_after'], 'runner b is killed mid-turn')
    step('b.kill', b_kill)
    killed_b = state['bKilledAt']

    sleep_until(killed_b + P['b_get1_after_kill'], 'session_get of B while runner b is down')
    step('c.get.b1', lambda: {'compact': compact(state, 'b', 'b1'), 'observer': observer_get(state, 'b', 'B1')})

    # Runner b comes back only once the auto-retry has disarmed and ticks have found the session FAILED and unarmed.
    def b_restart():
        sb = state['sessions']['b']['uuid']
        cap = killed_b + P['b_restart_cap']

        def ready():
            if time.time() >= cap:
                return 'cap'
            if time.time() < killed_b + P['b_restart_min']:
                return None
            disarmed = disarmed_since(sb)
            if disarmed is None and P['b_refused_min'] > 0:
                return None
            return 'ready' if refused_revives(sb, disarmed or killed_b) >= P['b_refused_min'] else None
        why = wait_for(ready, P['b_restart_cap'] + 60, 'B ready for its runner to return', every=5)
        disarmed = disarmed_since(sb)
        refused = refused_revives(sb, disarmed or killed_b)
        compact_before = compact(state, 'b', 'b-before-restart')
        started = stack('runner-start', 'b')
        state['bRestartedAt'] = time.time()
        save(state)
        return {'why': why, 'disarmedAt': now_iso(disarmed) if disarmed else None, 'refusedRevivesBeforeRestart': refused,
                'downSeconds': round(state['bRestartedAt'] - killed_b), 'compactBefore': compact_before, 'start': started.strip(),
                'restartedAt': now_iso(state['bRestartedAt'])}
    step('b.restart', b_restart)
    restarted_b = state['bRestartedAt']

    def b_revived():
        sb = state['sessions']['b']['uuid']
        turn = wait_for(lambda: next((t for t in turns_of(sb) if t['delivered_at'] and iso_epoch(t['delivered_at']) > restarted_b), None),
                        600, 'the first turn of B delivered after its runner returned', every=2)
        return {'turn': turn, 'processes': unit_processes('b')}
    step('b.revived', b_revived)

    sleep_until(restarted_b + P['b_get2_after_restart'], 'session_get of B after runner b returned')
    step('c.get.b2', lambda: {'compact': compact(state, 'b', 'b2'), 'observer': observer_get(state, 'b', 'B2')})

    def b_stop():
        before = last_fake_n()
        sent = send(state, 'b', 'LRL-B-STOP FAKE-STOP 2 B')
        results = await_plan('LRL-B-STOP', 2, before, 300)
        return {'sent': sent, 'receipts': results, 'loop': loop_of(state['sessions']['b']['uuid'])}
    sleep_until(restarted_b + P['b_stop_after_restart'], 'loop B is stopped')
    step('b.stop', b_stop)

    # Runner a dies while session A is idle: halfway between two ticks.
    loop_a = loop_of(state['sessions']['a']['uuid'])
    first_a = iso_epoch(loop_a['first_due_at'])

    def a_kill():
        sa = state['sessions']['a']['uuid']
        at = next_midpoint(loop_a, max(time.time(), first_a + P['a_kill_after_tick'] * P['every_a'] + 1))
        sleep_until(at, 'runner a is killed between two ticks')
        standing = idle(sa)
        if standing['open_turns'] or standing['status'] != 'AWAITING_INPUT':
            log('a-not-idle-yet', standing=standing)
            standing = wait_for(lambda: (lambda s: s if not s['open_turns'] and s['status'] == 'AWAITING_INPUT' else None)(idle(sa)),
                                90, 'session A idle', every=1)
        others = sql_json(f"select r.name, extract(epoch from now() - {runner_beat_sql()}) as silent_s from runner r order by r.name")
        background = owner_call(state, 'GET', f"/sessions/{state['sessions']['a']['id']}/background")[1]
        processes = unit_processes('a')
        killed = stack('runner-kill', 'a')
        state['aKilledAt'] = time.time()
        save(state)
        return {'standing': standing, 'runners': others, 'processes': processes, 'kill': killed, 'killedAt': now_iso(state['aKilledAt']),
                'turns': turns_of(sa)[-3:], 'sleepJobsAfterKill': sleep_jobs(), 'backgroundBeforeKill': background}
    step('a.kill', a_kill)
    killed_a = state['aKilledAt']

    sleep_until(killed_a + P['a_get1_after_kill'], 'session_get of A while runner a is down')
    step('c.get.a1', lambda: {'compact': compact(state, 'a', 'a1'), 'observer': observer_get(state, 'a', 'A1')})

    def a_restart():
        compact_before = compact(state, 'a', 'a-before-restart')
        started = stack('runner-start', 'a')
        state['aRestartedAt'] = time.time()
        save(state)
        return {'compactBefore': compact_before, 'start': started.strip(), 'restartedAt': now_iso(state['aRestartedAt']),
                'downSeconds': round(state['aRestartedAt'] - killed_a)}
    sleep_until(killed_a + P['a_down'], 'runner a returns')
    step('a.restart', a_restart)
    restarted_a = state['aRestartedAt']

    def a_recovered():
        sa = state['sessions']['a']['uuid']
        turn = wait_for(lambda: next((t for t in turns_of(sa) if t['delivered_at'] and iso_epoch(t['delivered_at']) > restarted_a), None),
                        600, 'the first turn of A delivered after its runner returned', every=2)
        background = owner_call(state, 'GET', f"/sessions/{state['sessions']['a']['id']}/background")[1]
        return {'turn': turn, 'processes': unit_processes('a'), 'backgroundAfterRestart': background, 'sleepJobs': sleep_jobs()}
    step('a.recovered', a_recovered)

    sleep_until(restarted_a + P['a_get2_after_restart'], 'session_get of A after runner a returned')
    step('c.get.a2', lambda: {'compact': compact(state, 'a', 'a2'), 'observer': observer_get(state, 'a', 'A2')})

    def a_stop():
        at = next_midpoint(loop_a, max(time.time(), t0 + P['a_stop_at']))
        sleep_until(at, 'loop A is stopped: two calls of stop: true')
        before = last_fake_n()
        sent = send(state, 'a', 'LRL-A-STOP FAKE-STOP 2 A')
        results = await_plan('LRL-A-STOP', 2, before, 300)
        sa = state['sessions']['a']['uuid']
        stop_turn = wait_for(lambda: next((t for t in turns_of(sa) if t['client_turn_id'] == sent['clientTurnId'] and t['answered_at']), None),
                             300, 'the stop turn answered')
        state['aStoppedAt'] = time.time()
        save(state)
        return {'sent': sent, 'receipts': results, 'stopTurn': stop_turn, 'loop': loop_of(sa)}
    step('a.stop', a_stop)
    stopped_a = state['aStoppedAt']

    def a_quiet():
        sa = state['sessions']['a']['uuid']
        last_seq = timeline['a.stop']['stopTurn']['seq']
        sleep_until(stopped_a + P['quiet'], 'no new turn of A after the stop')
        later = [t for t in turns_of(sa) if t['seq'] > last_seq]
        pending = sql_json(f"select id, state, due_at from session_scheduled_wakeup where session_id = {quote(sa)} and state = 'PENDING'")
        return {'watchedSeconds': round(time.time() - stopped_a), 'turnsAfterStop': later, 'pendingWakeups': pending,
                'loop': loop_of(sa)}
    step('a.quiet', a_quiet)
    log('run-done')


# ---- the sampler -------------------------------------------------------------------------------------------------------

def snapshot(state):
    ids = [s['uuid'] for s in (state.get('sessions') or {}).values()]
    in_list = ', '.join(quote(i) for i in ids) or "'00000000-0000-0000-0000-000000000000'"
    query = f"""select json_build_object('at', clock_timestamp(),
      'sessions', coalesce((select json_agg(json_build_object('id', s.id, 'title', s.title, 'status', s.status, 'retryAt', s.retry_at,
          'retryClaimedAt', s.retry_claimed_at, 'retryAttempts', s.retry_attempts, 'finishedAt', s.finished_at,
          'endReason', s.end_reason, 'cancelRequestedAt', s.cancel_requested_at, 'error', left(s.error, 160),
          'runningBgJobs', s.running_bg_jobs) order by s.title) from session s where s.id in ({in_list})), '[]'::json),
      'loops', coalesce((select json_agg(json_build_object('id', l.id, 'sessionId', l.session_id, 'state', l.state,
          'ticksFired', l.ticks_fired, 'ticksMissed', l.ticks_missed, 'reviveStreak', l.revive_streak, 'alertedAt', l.alerted_at,
          'endedReason', l.ended_reason) order by l.created_at) from session_wakeup_loop l), '[]'::json),
      'turns', coalesce((select json_agg(x) from (select t.session_id as "sessionId", count(*) as n, max(t.seq) as "lastSeq",
          count(*) filter (where t.status = 'PENDING') as pending, count(*) filter (where t.status = 'IN_FLIGHT') as "inFlight"
          from conversation_turn t where t.session_id in ({in_list}) group by t.session_id) x), '[]'::json),
      'runners', coalesce((select json_agg(json_build_object('name', r.name, 'status', r.status,
          'lastBeat', {runner_beat_sql()}) order by r.name) from runner r), '[]'::json))"""
    return json.loads(sql(query)[0])


def cmd_sample(_args):
    REC.mkdir(parents=True, exist_ok=True)
    while not (REC / 'sampler.stop').exists():
        try:
            line = snapshot(load())
            with open(REC / 'samples.jsonl', 'a') as f:
                f.write(json.dumps(line) + '\n')
        except Exception as error:  # a sample missed is a gap in the record, never a reason to stop recording
            with open(REC / 'sampler-errors.log', 'a') as f:
                f.write(f'{now_iso()} {error}\n')
        time.sleep(10)


def cmd_status(_args):
    state = load()
    print(json.dumps({'t0': now_iso(state['t0']) if state.get('t0') else None, 'steps': list((state.get('timeline') or {}).keys()),
                      'sessions': state.get('sessions'), 'loops': state.get('loops')}, indent=2))
    try:
        print(json.dumps(snapshot(state), indent=2))
    except Exception as error:
        print(f'no snapshot: {error}')


# ---- the evidence ------------------------------------------------------------------------------------------------------

def tick_rows(loop_uuid):
    return sql_json(f"""select w.id, w.due_at, w.state, w.settled_at, w.created_at, w.delay_seconds, w.client_turn_id,
        t.seq as turn_seq, t.status as turn_status, t.created_at as turn_created_at, t.delivered_at, t.answered_at,
        l.first_due_at, l.every_seconds
      from session_scheduled_wakeup w join session_wakeup_loop l on l.id = w.loop_id
      left join conversation_turn t on t.session_id = w.session_id and t.client_turn_id = w.client_turn_id
      where w.loop_id = {quote(loop_uuid)} order by w.due_at, w.created_at""")


def tick_table(rows):
    out = ['| tick | due_at | state | turn (seq) | turn created | delivered_at | delivered − due | answered_at |',
           '| ---: | --- | --- | ---: | --- | --- | ---: | --- |']
    for row in rows:
        number = math.ceil(round(iso_epoch(row['due_at']) - iso_epoch(row['first_due_at']), 3) / row['every_seconds']) + 1
        late = f"{iso_epoch(row['delivered_at']) - iso_epoch(row['due_at']):.1f} s" if row['delivered_at'] else ''
        out.append(f"| {number} | {row['due_at']} | {row['state']} | {row['turn_seq'] if row['turn_seq'] is not None else ''} | "
                   f"{row['turn_created_at'] or ''} | {row['delivered_at'] or ''} | {late} | {row['answered_at'] or ''} |")
    return '\n'.join(out)


def cmd_dump(args):
    out = Path(args[0])
    out.mkdir(parents=True, exist_ok=True)
    state = load()
    sessions = state.get('sessions') or {}
    loops = state.get('loops') or {}
    written = []

    def write(name, content):
        (out / name).write_text(content if isinstance(content, str) else json.dumps(content, indent=2, default=str) + '\n')
        written.append(name)

    for name, loop_id in loops.items():
        rows = tick_rows(loop_id)
        write(f'ticks-{name}.json', rows)
        write(f'ticks-{name}.md', tick_table(rows) + '\n')
    for name, session in sessions.items():
        write(f'turns-{name}.json', sql_json(
            f"select seq, client_turn_id, kind, status, created_at, delivered_at, answered_at, content from conversation_turn "
            f"where session_id = {quote(session['uuid'])} order by seq"))
        write(f'wakes-{name}.json', sql_json(
            f"select id, client_turn_id, job_id, trigger, kind, command, description, status, exit_code, reason, elapsed_ms, idle_ms, "
            f"last_output_at, created_at, updated_at from background_job_wake where session_id = {quote(session['uuid'])} order by created_at"))
        status, background = owner_call(state, 'GET', f"/sessions/{session['id']}/background")
        write(f'background-{name}.json', {'status': status, 'background': background})
        status, detail = owner_call(state, 'GET', f"/sessions/{session['id']}/compact")
        write(f'compact-{name}-final.json', {'status': status, 'session': detail})
    write('loops.json', sql_json('select * from session_wakeup_loop order by created_at'))
    write('scheduled-wakeups-one-shot.json', sql_json('select * from session_scheduled_wakeup where loop_id is null order by created_at'))
    write('runners.json', sql_json(f"select r.id, r.name, r.status, r.version, {runner_beat_sql()} as last_beat from runner r order by r.name"))
    # The engine's own view: every request fake-model.py answered (no secrets: it never sees one but the fake key's name).
    write('fake-model.jsonl', FAKE_LOG.read_text() if FAKE_LOG.exists() else '')
    blocks = [line for line in fake_lines() if line.get('turnText')]
    write('wake-blocks.md', '\n'.join(f"## request {line['n']} at {line['at']} ({line['kind']})\n\n```text\n{line['turnText']}\n```\n"
                                       for line in blocks))
    write('push-calls.jsonl', PUSH_LOG.read_text() if PUSH_LOG.exists() else '')
    for name in ('timeline.jsonl', 'samples.jsonl'):
        source = REC / name
        write(name, source.read_text() if source.exists() else '')
    for source in sorted(REC.glob('compact-*.json')) + sorted(REC.glob('session-get-*.txt')):
        write(source.name, source.read_text())
    lines = API_LOG.read_text(errors='replace').splitlines() if API_LOG.exists() else []
    keep = re.compile(r'ScheduledWakeup|AutoRetry|Reaper|runner offline|wakeup loop|could not revive|its owner is told|'
                      r'BackgroundJob|stall|mass disconnection', re.I)
    write('apiserver-excerpt.log', '\n'.join(line for line in lines if keep.search(line)) + '\n')
    for name in RUNNERS[:3]:
        source = LRL_DIR / 'r' / name / 'runner.log'
        if source.exists():
            text = source.read_text(errors='replace')
            write(f'runner-{name}.log', text if len(text) < 400_000 else text[-400_000:])
    build = LRL_DIR / 'build.json'
    write('build.json', build.read_text() if build.exists() else '{}')
    write('state-public.json', {'t0': now_iso(state['t0']) if state.get('t0') else None, 'profile': os.environ.get('LRL_PROFILE', 'full'),
                                'parameters': P, 'sessions': sessions, 'loops': loops,
                                'runners': {k: {x: v.get(x) for x in ('uuid', 'id', 'name')} for k, v in (state.get('runners') or {}).items()},
                                'workspaces': state.get('workspaces'), 'provider': state.get('provider'),
                                'timeline': state.get('timeline')})
    print(json.dumps({'out': str(out), 'files': written}, indent=2))


COMMANDS = {'setup': cmd_setup, 'run': cmd_run, 'sample': cmd_sample, 'status': cmd_status, 'dump': cmd_dump}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        raise SystemExit(__doc__)
    COMMANDS[sys.argv[1]](sys.argv[2:])
