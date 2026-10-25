#!/usr/bin/env python3
"""T06b's additions to scripts/managed-runner/lab/wake-lab.py (whose state, owners and helpers it uses),
for the first session of a new account whose managed runner waits for capacity. Prints JSON, never a
credential (owners' tokens stay in wake-lab.py's 0600 state files).

  first-session NAME --prompt P [--provider SLUG]   a session in NAME's managed default workspace, with
                                                    nothing named or naming SLUG; its answer as given
  default NAME                                      the default workspace as GET /workspaces lists it, the
                                                    owner's managed runner status, and whether its runner
                                                    row has ever stored an engine report

LAB_TEST_SERVER_DIR must name test-server-t06b.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path

REPO = Path(os.environ.get('T06B_REPO', '/root/.orbit/worktrees/54a4a7e8-e645-56e0-95e2-01e100985351'))
spec = importlib.util.spec_from_file_location('wake_lab', REPO / 'scripts/managed-runner/lab/wake-lab.py')
wl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wl)


def require_t06b():
    if wl.SERVER.name != 'test-server-t06b':
        raise SystemExit(f'LAB_TEST_SERVER_DIR must name test-server-t06b, not {wl.SERVER}')


def cmd_first_session(args):
    require_t06b()
    found = wl.owner_state(args.name)
    status = wl.default_workspace(args.name)
    body = {'workspaceId': status['workspaceId'], 'prompt': args.prompt, 'title': args.prompt[:60]}
    if args.provider:
        body['provider'] = args.provider
    at = wl.now()
    code, answer = wl.http('POST', '/sessions', body, token=found['accessToken'])
    result = {'at': at, 'kind': 'session', 'status': code, 'managedState': status.get('managementState'),
              'named': args.provider, 'answer': {k: answer.get(k) for k in ('id', 'status', 'provider', 'engine', 'assignedRunnerId', 'code', 'message')}
              if isinstance(answer, dict) else answer}
    wl.remember(args.name, [result])
    wl.out({'owner': args.name, **result})


def cmd_default(args):
    require_t06b()
    found = wl.owner_state(args.name)
    status = wl.ml.status_of(args.name)
    code, workspaces = wl.http('GET', '/workspaces', token=found['accessToken'])
    workspace = next((w for w in workspaces if w.get('id') == status.get('workspaceId')), None) if code == 200 else None
    runner = wl.sql_json(f"select r.engines is null as never_reported, r.status, r.last_heartbeat_at from runner r "
                         f"join managed_runner m on m.runner_id = r.id join \"user\" u on u.id = m.owner_id "
                         f"where u.email = {wl.quote(wl.EMAIL.format(args.name))}")
    wl.out({'at': wl.now(), 'owner': args.name,
            'status': {k: status.get(k) for k in ('managementState', 'desiredState', 'reason', 'retryAfter', 'initialProvider', 'usable', 'actions')},
            'workspace': {k: workspace.get(k) for k in ('id', 'name', 'lastProvider', 'lastEngine', 'providerBuiltin')} if workspace else None,
            'runner': runner[0] if runner else None})


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    first = sub.add_parser('first-session')
    first.add_argument('name')
    first.add_argument('--prompt', required=True)
    first.add_argument('--provider')
    sub.add_parser('default').add_argument('name')
    args = parser.parse_args()
    {'first-session': cmd_first_session, 'default': cmd_default}[args.command](args)


if __name__ == '__main__':
    main()
