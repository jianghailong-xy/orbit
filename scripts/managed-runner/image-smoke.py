#!/usr/bin/env python3
"""Optional isolated-container smoke; artificial fixtures are not real session acceptance."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

HOME = Path('/var/lib/orbit/home')
ORBIT = HOME / '.orbit'
WORKSPACE = HOME / 'orbit-repos/default'
SESSION = 'artificial-smoke-session'
RUNNER = 'artificial-smoke-runner'
TOKEN = 'artificial-smoke-runner-token'
ENGINES = ('codex', 'claude', 'kimi', 'opencode', 'agy', 'antigravity', 'gemini')
SKIPS = ['Kubernetes/Ceph mount and volume recovery: authorized test cluster unavailable',
         'Real first engine session: authorized test model and credentials not supplied',
         'Real engine continuation after container rebuild: no real session executed',
         'Active-turn container drain: this smoke exercises idle shutdown only']


def fixture_server():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def answer(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
            route = (self.command, self.path)
            result, valid = {}, self.headers.get('Authorization') == 'Bearer ' + TOKEN
            if route == ('POST', '/api/runner/register'):
                valid = (body.get('enrollmentToken') == 'artificial-smoke-enrollment'
                         and body.get('name') == RUNNER and body.get('maxConcurrent') == 1
                         and body.get('workDir') == str(WORKSPACE) and bool(body.get('version')))
                result = {'runnerId': RUNNER, 'runnerToken': TOKEN, 'name': RUNNER}
            elif route == ('POST', '/api/runner/heartbeat'):
                valid = valid and body.get('runsAsRoot') is False and 'idleCapacity' in body
            elif route == ('GET', '/api/runner/me'):
                result = {'id': RUNNER, 'workspaces': [], 'maxConcurrent': 1}
            elif route == ('GET', '/api/runner/sessions/reclaim'):
                rows = [{'sessionId': SESSION, 'title': 'ARTIFICIAL idle fixture',
                         'status': 'AWAITING_INPUT', 'provider': 'codex',
                         'workDir': str(WORKSPACE), 'branch': 'orbit/smoke-fixture',
                         'agent': {'provider': 'codex'}, 'runtimeSessionId': 'artificial-thread'}]
                result = {'sessions': rows if Path('/fixtures/reclaim-enabled').exists() else []}
            elif route == ('GET', '/api/runner/sessions/claim'):
                time.sleep(1)  # Empty long-poll; no turn is ever dispatched.
            elif route == ('POST', f'/api/runner/sessions/{SESSION}/takeover-leases'):
                valid = valid and bool(body.get('leaseOwner')) and 'expectedLeaseOwner' in body
                result = {'status': 'AWAITING_INPUT'}
            elif route == ('POST', '/api/runner/sessions/worktrees-removable'):
                valid = valid and isinstance(body.get('ids'), list)
                result = {'removable': []}
            else:
                valid = False
            print(json.dumps({'method': self.command, 'path': self.path, 'valid': valid,
                              'supervisedSessionIds': body.get('supervisedSessionIds', [])}), flush=True)
            data = json.dumps(result).encode()
            self.send_response(200 if valid else 400)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                pass

        do_GET = do_POST = answer
    server = ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
    print(json.dumps({'ready': True, 'fixture': 'ARTIFICIAL'}), flush=True)
    server.serve_forever()


def fixture_seed():
    os.umask(0o077)
    def git(*args):
        subprocess.run(['git', '-C', str(WORKSPACE), *args], check=True, capture_output=True)
    (WORKSPACE / 'sentinel.txt').write_text('ARTIFICIAL primary checkout\n')
    git('init', '-b', 'main')
    git('add', 'sentinel.txt')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture')
    worktree = ORBIT / 'worktrees' / SESSION
    git('worktree', 'add', '-b', 'orbit/smoke-fixture', str(worktree))
    files = {worktree / 'draft.txt': 'ARTIFICIAL uncommitted work\n',
             ORBIT / 'uploads' / SESSION / 'attachment.bin': 'ARTIFICIAL attachment bytes\n',
             ORBIT / 'runs' / SESSION / 'meta.json': json.dumps({'provider': 'codex',
                 'workDir': str(worktree), 'runtimeSessionId': 'artificial-thread'}),
             ORBIT / 'runs' / SESSION / 'codex-home/sessions/artificial.jsonl': 'ARTIFICIAL isolated history\n',
             HOME / '.codex/sessions/artificial.jsonl': 'ARTIFICIAL default engine history\n'}
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(content)
    partition = hashlib.sha256(str(HOME / '.codex').encode()).hexdigest()[:24]
    state = ORBIT / 'codex-state' / partition
    state.mkdir(mode=0o700)
    with sqlite3.connect(state / 'artificial.sqlite') as db:
        db.execute('CREATE TABLE artificial_fixture (label TEXT)')
        db.execute('INSERT INTO artificial_fixture VALUES (?)', ('not engine state',))


def fixture_snapshot():
    assert os.getuid() == os.getgid() == 10001
    assert re.search(r'^CapEff:\s+0+$', Path('/proc/self/status').read_text(), re.M)
    assert not any(Path(path).exists() for path in ('/var/run/docker.sock', '/run/docker.sock',
                   '/var/run/secrets/kubernetes.io/serviceaccount/token'))
    config = json.loads((ORBIT / 'config.json').read_text())
    assert config['runnerId'] == RUNNER and config['runnerToken'] == TOKEN
    assert (ORBIT.stat().st_mode & 0o777) == 0o700
    assert ((ORBIT / 'config.json').stat().st_mode & 0o777) == 0o600
    worktree = ORBIT / 'worktrees' / SESSION
    common = subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', '--git-common-dir'], text=True).strip()
    assert (worktree / common).resolve() == (WORKSPACE / '.git').resolve()
    selected = [ORBIT / 'config.json', ORBIT / 'container-identity.json', WORKSPACE / 'sentinel.txt',
                WORKSPACE / '.git/HEAD', ORBIT / 'worktrees' / SESSION / '.git',
                ORBIT / 'worktrees' / SESSION / 'draft.txt']
    selected += [p for root in (ORBIT / 'uploads', ORBIT / 'runs', ORBIT / 'codex-state', HOME / '.codex')
                 for p in root.rglob('*') if p.is_file()]
    records = [json.loads(line) for line in (ORBIT / 'fake-engine-calls.jsonl').read_text().splitlines()]
    assert records and all(not any(row['credentialEnv'].values()) and not any(row['credentialFiles'].values()) for row in records)
    assert all(row['fakeOnly'] for row in records), 'Engine probes must remain artificial'
    print(json.dumps({'fixture': 'ARTIFICIAL', 'runnerId': config['runnerId'],
                      'checksums': {str(p.relative_to(HOME)): hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in selected}, 'engineCalls': records}, sort_keys=True))


def fixture_tripwire():
    args = sys.argv[2:]
    row = {'engine': sys.argv[1], 'argv': args, 'fakeOnly': True,
           'credentialEnv': {key: bool(os.environ.get(key)) for key in
               ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CODEX_API_KEY', 'KIMI_API_KEY')},
           'credentialFiles': {str(path): path.exists() for path in
                               (HOME / '.codex/auth.json', HOME / '.claude.json')}}
    with (ORBIT / 'fake-engine-calls.jsonl').open('a') as output:
        output.write(json.dumps(row) + '\n')
    if args == ['--version']:
        print('ARTIFICIAL smoke engine 0.0.0')
        return
    raise SystemExit(1)  # Recorded fake, never reaches a real provider executable.


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    require(__debug__, 'Run without -O; this smoke requires its verification assertions')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment-file', required=True, type=Path)
    parser.add_argument('--image', required=True, help='Existing immutable image ID or repository@sha256 digest')
    parser.add_argument('--evidence-dir', required=True, type=Path)
    args = parser.parse_args()
    approved = json.loads(args.environment_file.read_text())
    endpoint = approved.get('dockerHost', '')
    parsed = urlsplit(endpoint)
    require(approved.get('approved') is True and approved.get('kind') == 'isolated-container-test', 'Explicit isolated-test approval required')
    require(isinstance(approved.get('environmentId'), str) and approved['environmentId'].strip(), 'Name the approved test environment')
    require(parsed.scheme in ('unix', 'tcp') and not (parsed.username or parsed.password or parsed.query or parsed.fragment), 'Unsupported Docker endpoint')
    require((parsed.scheme == 'unix' and not parsed.netloc and parsed.path.startswith('/')) or (
            parsed.scheme == 'tcp' and parsed.hostname and parsed.port), 'Docker endpoint must be explicit')
    require(os.path.realpath(parsed.path) not in ('/var/run/docker.sock', '/run/docker.sock'), 'Default privileged Docker socket forbidden')
    require(re.fullmatch(r'(sha256:|[^\s]+@sha256:)[0-9a-f]{64}', args.image), 'Use an immutable image reference')
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not any(evidence.iterdir()), 'Use a fresh evidence directory')
    fixture = evidence / 'fixtures'
    fixture.mkdir(mode=0o755)
    shutil.copyfile(__file__, fixture / 'image-smoke.py')
    (fixture / 'image-smoke.py').chmod(0o644)
    for engine in ENGINES:
        path = fixture / engine
        path.write_text(f'#!/bin/sh\nexec python3 /fixtures/image-smoke.py --fixture-tripwire {engine} "$@"\n')
        path.chmod(0o755)
    (fixture / 'enrollment').write_text('artificial-smoke-enrollment\n')
    (fixture / 'enrollment').chmod(0o444)
    client_home = evidence / 'docker-client'
    client_home.mkdir(mode=0o700)
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(client_home), 'DOCKER_CONFIG': str(client_home)}
    docker = shutil.which('docker', path=env['PATH'])
    require(docker, 'Docker CLI unavailable; no daemon operation was attempted')
    containers, volumes = [], []
    def call(*argv, timeout=330):
        command = [docker, '--host', endpoint, *argv]
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=timeout)
        with (evidence / 'commands.jsonl').open('a') as output:
            output.write(json.dumps({'argv': command, 'exitCode': result.returncode,
                                    'stdout': result.stdout, 'stderr': result.stderr}) + '\n')
        if result.returncode:
            raise RuntimeError(f'Docker {argv[0]} failed; inspect commands.jsonl')
        return result.stdout.strip()
    def create(network='none', entrypoint='python3', extra=(), command=()):
        cid = call('create', '--pull=never', '--network', network, '--user', '10001:10001',
                   '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
                   '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
                   '--mount', f'type=bind,src={fixture},dst=/fixtures,readonly',
                   '--entrypoint', entrypoint, *extra, args.image, *command)
        containers.append(cid)
        return cid
    try:
        image = json.loads(call('image', 'inspect', args.image))[0]
        assert image['Config']['User'] == '10001:10001', 'Image must default to UID/GID 10001'
        scope = {'environment': {key: approved[key] for key in ('approved', 'kind', 'environmentId', 'dockerHost')},
                 'imageId': image['Id'], 'fixture': 'ARTIFICIAL', 'skips': SKIPS,
                 'daemon': json.loads(call('version', '--format', '{{json .Server}}'))}
        mount = ('--mount', 'type=volume,src=' + call('volume', 'create', '--label', 'orbit.smoke=artificial',
                                                    'orbit-smoke-' + uuid.uuid4().hex) + ',dst=/var/lib/orbit')
        volumes.append(mount[1].split('src=')[1].split(',')[0])
        init = create(extra=(*mount, '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
                            '--cap-add', 'DAC_OVERRIDE'), entrypoint='/usr/local/bin/orbit-container', command=('init-volume',))
        call('start', '-a', init)
        version = create(command=('-c', "import json,subprocess;from pathlib import Path;print(json.dumps({'manifest':json.loads(Path('/usr/local/share/orbit/tool-versions.json').read_text()),'codex':subprocess.check_output(['codex','--version'],text=True).strip()}))"),
                         extra=('--env', 'HOME=/tmp/versions', '--env', 'CODEX_HOME=/tmp/versions/.codex'))
        scope['versions'] = json.loads(call('start', '-a', version))
        (evidence / 'scope.json').write_text(json.dumps(scope, indent=2) + '\n')
        mock = create(command=('/fixtures/image-smoke.py', '--fixture-server'))
        call('start', mock)
        deadline = time.monotonic() + 30
        while '"ready": true' not in call('logs', mock):
            assert time.monotonic() < deadline, 'Mock did not bind loopback'
            time.sleep(1)
        tripwires = tuple(arg for engine in ENGINES for arg in (
            '--mount', f'type=bind,src={fixture / engine},dst=/usr/local/bin/{engine},readonly'))
        common = (*mount, *tripwires,
                  '--env', 'ORBIT_RUNNER_SERVER_URL=http://127.0.0.1:8765', '--env', 'ORBIT_RUNNER_EXPECTED_ID=' + RUNNER)
        snapshots = []
        for attempt in range(2):
            first = ('--env', 'ORBIT_RUNNER_NAME=' + RUNNER, '--env', 'ORBIT_RUNNER_MAX_CONCURRENT=1',
                     '--env', 'ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE=/fixtures/enrollment') if attempt == 0 else ()
            before = call('logs', mock).count('/api/runner/heartbeat')
            runner = create('container:' + mock, '/usr/bin/tini', (*common, *first),
                            ('--', '/usr/local/bin/orbit-container', 'run'))
            call('start', runner)
            deadline = time.monotonic() + 90
            while True:
                api_log = call('logs', mock)
                fixture_live = f'"supervisedSessionIds": ["{SESSION}"]' in api_log
                if api_log.count('/api/runner/heartbeat') > before and (
                        fixture_live if attempt else '/api/runner/sessions/claim' in api_log):
                    break
                assert time.monotonic() < deadline, 'No mock heartbeat within 90 seconds'
                assert json.loads(call('inspect', runner))[0]['State']['Running'], 'Runner exited before heartbeat'
                time.sleep(1)
            call('stop', '--time', '240', runner)
            logs = call('logs', runner)
            (evidence / f'runner-{attempt + 1}.log').write_text(logs + '\n')
            assert 'draining session supervisors' in logs and json.loads(call('inspect', runner))[0]['State']['ExitCode'] == 0
            if attempt == 0:
                seed = create(extra=mount, command=('/fixtures/image-smoke.py', '--fixture-seed'))
                call('start', '-a', seed)
                (fixture / 'reclaim-enabled').touch()
            snap = create(extra=mount, command=('/fixtures/image-smoke.py', '--fixture-snapshot'))
            snapshots.append(json.loads(call('start', '-a', snap)))
            (evidence / f'snapshot-{attempt + 1}.json').write_text(json.dumps(snapshots[-1], indent=2) + '\n')
        assert snapshots[0]['checksums'] == snapshots[1]['checksums'], 'Retained fixture bytes changed'
        requests = [json.loads(line) for line in call('logs', mock).splitlines() if line.startswith('{')]
        assert all(row.get('valid', True) for row in requests), 'Unexpected API request or request shape'
        assert sum(row.get('path') == '/api/runner/register' for row in requests) == 1
        (evidence / 'mock-api.json').write_text(json.dumps(requests, indent=2) + '\n')
    finally:
        cleanup_failed = False
        for resource, argv in [(cid, ('rm', '--force', cid)) for cid in reversed(containers)] + [
                (volume, ('volume', 'rm', volume)) for volume in volumes]:
            try:
                call(*argv)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                cleanup_failed = True
                print(f'Cleanup failed for this smoke resource {resource}: {error}', file=sys.stderr)
    require(not cleanup_failed, 'Fixture checks passed but resource cleanup failed; inspect commands.jsonl')
    print('PASS: artificial isolated image enrollment, fixed-path persistence and idle shutdown')
    for skip in SKIPS:
        print('SKIP: ' + skip)


if __name__ == '__main__':
    actions = {'--fixture-server': fixture_server, '--fixture-seed': fixture_seed,
               '--fixture-snapshot': fixture_snapshot, '--fixture-tripwire': fixture_tripwire}
    if len(sys.argv) > 1 and sys.argv[1] in actions:
        action = actions[sys.argv.pop(1)]
        action()
    else:
        main()
