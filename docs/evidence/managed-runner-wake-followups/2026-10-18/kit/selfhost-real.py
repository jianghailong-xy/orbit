#!/usr/bin/env python3
"""T06b: this branch's own runner binary as a SELF-MANAGED runner of the lab test server's root account,
to show that its claims are not held back for a heartbeat and its first beat is still the first tick.

  selfhost-real.py setup DIR     register a runner through the runner API (no `orbit register`, which would
                                 install a service), write its config.json into DIR/orbit-home (0600), make
                                 a workspace on it and queue one session there, before anything runs
  selfhost-real.py observe DIR   the runner row's heartbeat stamp, the session's claim and status, now

Prints JSON, never the runner token. LAB_TEST_SERVER_DIR must name test-server-t06b.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

REPO = Path(os.environ.get('T06B_REPO', '/root/.orbit/worktrees/54a4a7e8-e645-56e0-95e2-01e100985351'))
spec = importlib.util.spec_from_file_location('wake_lab', REPO / 'scripts/managed-runner/lab/wake-lab.py')
wl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wl)


def setup(directory):
    if wl.SERVER.name != 'test-server-t06b':
        raise SystemExit('LAB_TEST_SERVER_DIR must name test-server-t06b')
    home = directory / 'orbit-home'
    work = directory / 'work'
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    root = wl.owner_state('root')
    token = root['accessToken']
    status, enrollment = wl.http('POST', '/runners/enrollment-tokens', {'label': 't06b real self-managed runner'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'enrollment-tokens: {status} {enrollment}')
    registered_at = wl.now()
    status, registered = wl.http('POST', '/runner/register', {'enrollmentToken': enrollment['token'], 'name': 't06b-real-selfhost',
                                                              'hostname': 't06b-real-selfhost.lab.invalid', 'version': '0.1.0', 'maxConcurrent': 2})
    if status not in (200, 201):
        raise SystemExit(f'runner/register: {status} {registered}')
    config = {'serverUrl': f"http://127.0.0.1:{wl.sw.ENV['LAB_TEST_API_PORT']}", 'runnerId': registered['runnerId'],
              'runnerToken': registered['runnerToken'], 'name': 't06b-real-selfhost', 'labels': [], 'maxConcurrent': 2,
              'workDir': str(work)}
    path = home / 'config.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(config, handle)
    runners = wl.http('GET', '/runners', token=token)[1]
    runner = next(r for r in runners if r['name'] == 't06b-real-selfhost')
    status, workspace = wl.http('POST', '/workspaces', {'name': 't06b-real-selfhost', 'runnerId': runner['id'], 'workDir': str(work)}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'workspaces: {status} {workspace}')
    queued_at = wl.now()
    status, session = wl.http('POST', '/sessions', {'workspaceId': workspace['id'], 'prompt': 'T06-B-SELFHOST a session queued before the runner runs',
                                                     'title': 't06b self-managed'}, token=token)
    if status not in (200, 201):
        raise SystemExit(f'sessions: {status} {session}')
    state = {'runnerId': registered['runnerId'], 'runnerPublicId': runner['id'], 'workspaceId': workspace['id'], 'sessionId': session['id']}
    (directory / 'state.json').write_text(json.dumps(state))
    wl.out({'registeredAt': registered_at, 'queuedAt': queued_at, **state, 'session': {k: session.get(k) for k in ('status', 'provider', 'engine')}})


def observe(directory):
    state = json.loads((directory / 'state.json').read_text())
    rows = wl.sql_json(f"select r.last_heartbeat_at, r.status, r.capabilities_reported_at, s.run_claimed_at, s.status as session_status, s.error "
                       f"from runner r join session s on s.assigned_runner_id = r.id where r.id = {wl.quote(state['runnerId'])}")
    wl.out({'at': wl.now(), **(rows[0] if rows else {})})


if __name__ == '__main__':
    {'setup': setup, 'observe': observe}[sys.argv[1]](Path(sys.argv[2]))
