#!/usr/bin/env python3
"""Record what the Orbit test server answers the native apps (task T07), for replay to the real iOS and
macOS apps on a macOS runner that cannot reach this host.

The coordinator chose replay over a tunnel (task comment 34hsa5wd3tguMmM5fPn11 and its answer): a
recorder on the host asks the test server, as an account, every request the iPhone and Mac apps make
on the screens T07 drives -- at least as often as the apps do -- and keeps each answer with the time it
came. The apps' actions (a first session from the draft, a message, Retry) are sent by the recorder in
the apps' own request shapes, when told to (`act`), and kept as actions. Scenes are time windows cut
from one recording afterwards (`pack`), and replay.py serves them to the apps.

  t07rec.py run --account NAME --out DIR [--client ios] [--seconds S]
        record until DIR/stop exists (or S seconds); reads NAME's tokens from
        $LAB_TEST_SERVER_DIR/state/NAME.json (0600), refreshing them on a 401, and never writes them out
  t07rec.py act --out DIR KIND [--prompt P] [--session ID]
        KIND: first-session (POST /api/sessions as the draft sends it), message (the console's send:
        POST /api/sessions/:id/turns, or /resume for an ended session), retry (POST /api/managed-runner/retry)
  t07rec.py pack --out DIR --name SCENE --from ISO --to ISO --meta JSON --scenes DIR2
        one scene for replay.py: every exchange in the window (and the last one of each request before
        it), the streams' events, and the actions, with consecutive identical answers folded

Only what the apps would ask is asked: with the capability off, never GET /api/managed-runner. The
answers are written as the server sent them; replay.py shifts their timestamps, nothing else.
"""

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

BASE_HOST = '127.0.0.1'
BASE_PORT = int(os.environ.get('T07_API_PORT') or os.environ.get('LAB_TEST_API_PORT', '13710'))
SERVER = Path(os.environ.get('LAB_TEST_SERVER_DIR', '/mnt/data/managed-runner-lab/test-server-t07'))


def iso(t=None):
    return datetime.fromtimestamp(time.time() if t is None else t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')[:-4] + 'Z'


def parse_iso(text):
    return datetime.strptime(text.replace('Z', '+0000'), '%Y-%m-%dT%H:%M:%S.%f%z').timestamp()


class Tokens:
    """The account's tokens from the lab state file; refreshed on a 401, kept in memory only."""

    def __init__(self, name):
        self.name = name
        state = json.loads((SERVER / 'state' / f'{name}.json').read_text())
        self.lock = threading.Lock()
        if state.get('accessToken'):
            self.access, self.refresh = state['accessToken'], state['refreshToken']
        else:
            # An account opened without a sign-in: this is its sign-in (an app's), with the lab's password.
            conn = http.client.HTTPConnection(BASE_HOST, BASE_PORT, timeout=20)
            conn.request('POST', '/api/auth/login', json.dumps({'email': state['email'], 'password': state['password']}),
                         {'Content-Type': 'application/json'})
            res = conn.getresponse()
            answer = json.loads(res.read() or b'{}')
            conn.close()
            if res.status not in (200, 201):
                raise RuntimeError(f'sign-in {name}: {res.status}')
            self.access, self.refresh = answer['accessToken'], answer['refreshToken']
            self.signed_in_at = iso()

    def renew(self):
        with self.lock:
            conn = http.client.HTTPConnection(BASE_HOST, BASE_PORT, timeout=20)
            conn.request('POST', '/api/auth/refresh', json.dumps({'refreshToken': self.refresh}),
                         {'Content-Type': 'application/json'})
            res = conn.getresponse()
            body = res.read()
            conn.close()
            if res.status not in (200, 201):
                raise RuntimeError(f'refresh {self.name}: {res.status}')
            answer = json.loads(body)
            self.access = answer['accessToken']
            self.refresh = answer.get('refreshToken', self.refresh)


class Log:
    """One JSON line per exchange, stream event, action or note, with wall time `t` (epoch seconds)."""

    def __init__(self, path):
        self.f = open(path, 'a', buffering=1)
        self.lock = threading.Lock()

    def write(self, record):
        record.setdefault('t', time.time())
        with self.lock:
            self.f.write(json.dumps(record, ensure_ascii=False) + '\n')


KEEP_HEADERS = ('content-type', 'etag')


def request(tokens, client, method, path, body=None, timeout=30):
    """One request as the app sends it (X-Orbit-Client, Bearer); a 401 renews the token once."""
    for attempt in (1, 2):
        conn = http.client.HTTPConnection(BASE_HOST, BASE_PORT, timeout=timeout)
        headers = {'X-Orbit-Client': client, 'Authorization': f'Bearer {tokens.access}'}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        started = time.time()
        try:
            conn.request(method, path, data, headers)
            res = conn.getresponse()
            raw = res.read()
            status = res.status
            kept = {k.lower(): v for k, v in res.getheaders() if k.lower() in KEEP_HEADERS or k.lower().startswith('x-orbit-')}
        finally:
            conn.close()
        if status == 401 and attempt == 1:
            tokens.renew()
            continue
        return started, status, kept, raw.decode('utf-8', 'replace')
    raise AssertionError('unreachable')


# ---- what the apps ask, and how often ----------------------------------------------------------

# Read about every 15 s: what the apps read at launch and on their slower floors.
SLOW = [
    '/api/users/me', '/api/auth/capabilities', '/api/providers', '/api/providers/pools', '/api/providers/shared-pools',
    '/api/providers/mine', '/api/session-tags', '/api/session-folders', '/api/task-lists',
    '/api/tasks/page?limit=1&listId=none&projectId=none&counts=total', '/api/wiki/spaces', '/api/projects',
    '/api/projects/sidebar', '/api/watches', '/api/watches?state=ACTIVE', '/api/watches?state=PAUSED',
    '/api/watches?needsAttention=true', '/dl/version.json', '/api/sessions/counts',
]
# Read every 2 s: the managed status (only with the capability), the lists the console and the drafts follow.
FAST = ['/api/agents', '/api/runners', '/api/sessions?view=open', '/api/sessions?view=open&since=']
# The requests read less often than every 2 s, by URL path, and how long the recorder took between two reads of each: a
# change one of them shows happened somewhere in that time before the read. replay.py serves the read from there.
SAMPLED_EVERY = {**{p.split('?')[0]: 15 for p in SLOW}, '/api/providers/mine/*/balance': 30}
# Per session in the Open list, every 2 s: what a console reads.
CONSOLE = [
    '/api/sessions/{id}', '/api/sessions/{id}/events/page?tail=200&maxPayload=2048', '/api/sessions/{id}/turns?view=active',
    '/api/sessions/{id}/approvals?status=PENDING', '/api/sessions/{id}/created-tasks', '/api/sessions/{id}/background',
    '/api/tasks/evidence-decisions/pending?decidingSessionId={id}', '/api/sessions/{id}/retry-message',
]


class Recorder:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / 'cmd').mkdir(exist_ok=True)
        self.tokens = Tokens(args.account)
        self.client = f'{args.client}/1.0'
        self.log = Log(self.out / 'recording.jsonl')
        self.due = {}
        self.offered = None
        self.sessions = []          # Open-list session ids of the managed default workspace and others
        self.streams = {}           # path -> thread
        self.managed = {}           # the last status read
        self.agents = []
        self.providers = []
        self.keys = []
        self.stop = threading.Event()

    def note(self, **fields):
        self.log.write({'kind': 'note', **fields})

    def get(self, path):
        started, status, headers, body = request(self.tokens, self.client, 'GET', path)
        self.log.write({'kind': 'exchange', 't': started, 'm': 'GET', 'path': path, 's': status, 'h': headers, 'b': body,
                        'ms': round((time.time() - started) * 1000)})
        return status, body

    def every(self, path, seconds):
        now = time.monotonic()
        if self.due.get(path, 0) <= now:
            self.due[path] = now + seconds
            return True
        return False

    def poll_once(self):
        for path in SLOW:
            if self.every(path, 15):
                status, body = self.get(path)
                if path == '/api/auth/capabilities':
                    try:
                        member = json.loads(body).get('managedRunners') if status == 200 else None
                        self.offered = bool(member and member.get('enabled') is True and member.get('contractVersion') == 1)
                    except ValueError:
                        self.offered = False
                if path == '/api/providers' and status == 200:
                    self.providers = json.loads(body)
                if path == '/api/providers/mine' and status == 200:
                    self.keys = json.loads(body)
        if self.offered and self.every('/api/managed-runner', 2):
            status, body = self.get('/api/managed-runner')
            if status == 200:
                self.managed = json.loads(body)
        for path in FAST:
            if self.every(path, 2):
                status, body = self.get(path)
                if path == '/api/agents' and status == 200:
                    self.agents = json.loads(body)
                if path == '/api/sessions?view=open' and status == 200:
                    self.sessions = [s['id'] for s in json.loads(body)][:6]
        if self.offered and self.managed.get('runnerId') and self.every('runner-detail', 5):
            self.get(f"/api/runners/{self.managed['runnerId']}")
        if self.offered and self.managed.get('workspaceId') and self.every('agent-detail', 5):
            self.get(f"/api/agents/{self.managed['workspaceId']}")
        for key in self.keys:
            if key.get('id') and self.every(f"balance-{key['id']}", 30):
                self.get(f"/api/providers/mine/{key['id']}/balance")
        for sid in self.sessions:
            for template in CONSOLE:
                path = template.format(id=sid)
                if self.every(path, 2 if 'retry-message' not in path else 5):
                    self.get(path)
            self.ensure_stream(f'/api/sessions/{sid}/events', 'sinceSeq=0&maxPayload=2048')
        self.ensure_stream('/api/events', '')

    # ---- server-sent events: one reader per stream, every block kept with its arrival time ----

    def ensure_stream(self, path, query):
        thread = self.streams.get(path)
        if thread and thread.is_alive():
            return
        thread = threading.Thread(target=self.read_stream, args=(path, query), daemon=True)
        self.streams[path] = thread
        thread.start()

    def read_stream(self, path, query):
        full = path + (f'?{query}' if query else '')
        while not self.stop.is_set():
            conn = http.client.HTTPConnection(BASE_HOST, BASE_PORT, timeout=120)
            try:
                conn.request('GET', full, headers={'X-Orbit-Client': self.client, 'Authorization': f'Bearer {self.tokens.access}',
                                                   'Accept': 'text/event-stream', 'Cache-Control': 'no-cache'})
                res = conn.getresponse()
                headers = {k.lower(): v for k, v in res.getheaders() if k.lower() in KEEP_HEADERS or k.lower().startswith('x-orbit-')}
                self.log.write({'kind': 'stream-open', 'path': path, 'q': query, 's': res.status, 'h': headers})
                if res.status == 401:
                    self.tokens.renew()
                    continue
                if res.status != 200:
                    self.log.write({'kind': 'stream-body', 'path': path, 'b': res.read().decode('utf-8', 'replace')})
                    time.sleep(5)
                    continue
                block = []
                while not self.stop.is_set():
                    line = res.readline()   # through the response: it takes the chunked encoding off
                    if not line:
                        break
                    text = line.decode('utf-8', 'replace')
                    block.append(text)
                    if text in ('\n', '\r\n'):
                        raw = ''.join(block)
                        block = []
                        seq = None
                        for part in raw.splitlines():
                            if part.startswith('data:'):
                                try:
                                    seq = json.loads(part[5:].strip()).get('seq')
                                except (ValueError, AttributeError):
                                    pass
                            elif part.startswith('id:') and seq is None:
                                value = part[3:].strip()
                                seq = int(value) if value.isdigit() else None
                        self.log.write({'kind': 'stream-event', 'path': path, 'seq': seq, 'raw': raw})
                self.log.write({'kind': 'stream-closed', 'path': path})
            except (OSError, http.client.HTTPException) as error:
                self.log.write({'kind': 'stream-error', 'path': path, 'error': str(error)[:200]})
                time.sleep(2)
            finally:
                conn.close()

    # ---- the apps' actions, on command ----

    def run_commands(self):
        for cmd in sorted((self.out / 'cmd').glob('*.json')):
            done = cmd.with_suffix('.done')
            if done.exists():
                continue
            order = json.loads(cmd.read_text())
            try:
                result = self.act(order)
            except Exception as error:  # say it, keep recording
                result = {'error': str(error)[:300]}
            done.write_text(json.dumps(result, ensure_ascii=False))

    def act(self, order):
        kind = order['kind']
        if kind == 'first-session':
            # The draft's send (ConsoleModel.createDraftSession): the prompt, the workspace, the model once the
            # provider is resolved, the mode and the effort; engine and provider only for an explicit pick.
            workspace = self.managed.get('workspaceId')
            agent = next((a for a in self.agents if a.get('id') == workspace), {})
            provider = agent.get('lastProvider') or agent.get('provider') or 'claude'
            configured = next((p for p in self.providers if p.get('slug') == provider), None)
            body = {'prompt': order['prompt'], 'agentId': workspace, 'permissionMode': order.get('permissionMode', 'auto'),
                    'effort': order.get('effort', '')}
            if configured and configured.get('defaultModel'):
                body['model'] = configured['defaultModel']
            return self.send('POST', '/api/sessions', body, ['agentId', 'prompt', 'engine', 'provider', 'model'])
        if kind == 'message':
            sid = order['session']
            _, detail = self.get(f'/api/sessions/{sid}')
            session = json.loads(detail)
            caps = session.get('capabilities') or {}
            ended = (session.get('status') or '').upper() in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPLETED', 'ENDED')
            if ended or caps.get('resumeBlockedReason') == 'RUNNER_OFFLINE':
                body = {'clientTurnId': str(uuid.uuid4()), 'content': order['prompt'], 'kind': 'message'}
                return self.send('POST', f'/api/sessions/{sid}/resume', body, ['content', 'kind'])
            body = {'clientTurnId': str(uuid.uuid4()), 'content': order['prompt'], 'kind': 'message'}
            return self.send('POST', f'/api/sessions/{sid}/turns', body, ['content', 'kind'])
        if kind == 'retry':
            body = {'idempotencyKey': str(uuid.uuid4()), 'revision': self.managed.get('revision')}
            return self.send('POST', '/api/managed-runner/retry', body, ['revision'])
        raise ValueError(f'unknown action {kind}')

    def send(self, method, path, body, key):
        started, status, headers, answer = request(self.tokens, self.client, method, path, body)
        self.log.write({'kind': 'action', 't': started, 'm': method, 'path': path, 'body': body, 'key': key,
                        's': status, 'h': headers, 'b': answer})
        # What the apps read at once after a write: the managed status (work sent to a runner that is not up)
        # and the Open list.
        if self.offered:
            self.get('/api/managed-runner')
        self.get('/api/sessions?view=open')
        return {'status': status, 'path': path, 'answer': answer[:400]}

    def run(self):
        self.note(event='start', account=self.args.account, client=self.client, at=iso(),
                  signedInHere=getattr(self.tokens, 'signed_in_at', None))
        deadline = time.monotonic() + self.args.seconds if self.args.seconds else None
        while not (self.out / 'stop').exists() and (deadline is None or time.monotonic() < deadline):
            try:
                self.poll_once()
                self.run_commands()
            except Exception as error:  # the server restarting: note it and go on
                self.note(event='error', error=str(error)[:300])
                time.sleep(2)
            time.sleep(0.5)
        self.stop.set()
        self.note(event='stop', at=iso())


def cmd_act(args):
    out = Path(args.out) / 'cmd'
    n = len(list(out.glob('*.json')))
    order = {'kind': args.kind, 'prompt': args.prompt, 'session': args.session, 'at': iso()}
    path = out / f'{n:04d}.json'
    path.write_text(json.dumps(order))
    deadline = time.monotonic() + 60
    while not path.with_suffix('.done').exists():
        if time.monotonic() > deadline:
            raise SystemExit(f'the recorder did not take {path.name} within 60 s')
        time.sleep(0.2)
    print(path.with_suffix('.done').read_text())


# ---- scenes -------------------------------------------------------------------------------------

CHUNK_LINE = re.compile(r'^[0-9a-fA-F]+\r\n$')


def clean_block(raw):
    """An event block as the server wrote it. Recordings made before 06:14Z on 2026-10-18 read the socket under the
    HTTP chunked encoding, so a block can carry a chunk-size line or the CRLF that ends a chunk; neither is part of
    the event stream (SSE lines are `field: value` or `:comment`), so they are dropped."""
    kept = [line for line in raw.splitlines(keepends=True) if not CHUNK_LINE.match(line) and line != '\r\n']
    text = ''.join(kept)
    return text if text.strip() else ''


def cmd_pack(args):
    start, end = parse_iso(args.start), parse_iso(args.end)
    records = [json.loads(line) for line in (Path(args.out) / 'recording.jsonl').read_text().splitlines() if line.strip()]
    exchanges, before = [], {}
    for r in records:
        if r['kind'] != 'exchange' or r['s'] in (0,):
            continue
        if r['t'] < start:
            before[r['path']] = r
        elif r['t'] <= end:
            exchanges.append(r)
    # The answer each request had when the scene begins, then the window's, consecutive repeats folded.
    seed = [dict(r, t=start) for r in before.values()]
    folded, last = [], {}
    for r in sorted(seed, key=lambda r: r['path']) + exchanges:
        digest = hashlib.sha256((str(r['s']) + json.dumps(r['h'], sort_keys=True) + r['b']).encode()).hexdigest()
        if last.get(r['path']) == digest:
            continue
        last[r['path']] = digest
        folded.append({'t': round(r['t'] - start, 3), 'm': r['m'], 'path': r['path'], 's': r['s'], 'h': r['h'], 'b': r['b']})
    streams, opened = {}, {}
    for r in records:
        if r['kind'] == 'stream-open' and r['t'] <= end:
            streams.setdefault(r['path'], {'path': r['path'], 's': r['s'], 'h': r['h'], 'events': []})
            opened[r['path']] = r['t']
        if r['kind'] == 'stream-event' and r['t'] <= end and r['path'] in streams:
            # What the server sends as a connection opens is its preamble, sent again to every connection.
            preamble = r['path'] == '/api/events' and r['t'] - opened.get(r['path'], 0) < 1.0
            # A session's history from before the window counts as there when it begins; the global stream's
            # past is not replayed to a new connection, except its preamble.
            if r['t'] < start and r['path'] == '/api/events' and not preamble:
                continue
            raw = clean_block(r['raw'])
            if not raw:
                continue
            if not raw.endswith('\n\n'):
                raw = raw.rstrip('\n') + '\n\n'
            event = {'t': round(max(r['t'], start) - start, 3), 'seq': r['seq'], 'raw': raw}
            if preamble:
                event['preamble'] = True
            # A session's stream read again from sinceSeq=0 (a reconnect) repeats what it sent: each seq once.
            if r['seq'] is not None and any(e['seq'] == r['seq'] for e in streams[r['path']]['events']):
                continue
            streams[r['path']]['events'].append(event)
    actions = [{'t': round(r['t'] - start, 3), 'm': r['m'], 'path': r['path'], 'body': r['body'], 'key': r['key'], 's': r['s'],
                'h': r['h'], 'b': r['b']} for r in records if r['kind'] == 'action' and start <= r['t'] <= end]
    scene = {'name': args.name, 'recordedFrom': args.start, 'recordedTo': args.end, 'duration': round(end - start, 3),
             't0': args.start, 'meta': json.loads(args.meta), 'exchanges': folded, 'streams': list(streams.values()),
             'actions': actions,
             'rules': {'wildcard': {'/api/sessions': ['since']}, 'sse': ['/api/events', '/api/sessions/*/events'],
                       'sampledEvery': SAMPLED_EVERY}}
    target = Path(args.scenes) / f'{args.name}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(scene, ensure_ascii=False))
    print(json.dumps({'scene': args.name, 'exchanges': len(folded), 'distinct': len({e['path'] for e in folded}),
                      'streams': {s['path']: len(s['events']) for s in streams.values()}, 'actions': len(actions),
                      'bytes': target.stat().st_size, 'path': str(target)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('run')
    p.add_argument('--account', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--client', default='ios', choices=('ios', 'macos'))
    p.add_argument('--seconds', type=int, default=0)
    p = sub.add_parser('act')
    p.add_argument('--out', required=True)
    p.add_argument('kind', choices=('first-session', 'message', 'retry'))
    p.add_argument('--prompt')
    p.add_argument('--session')
    p = sub.add_parser('pack')
    p.add_argument('--out', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--from', dest='start', required=True)
    p.add_argument('--to', dest='end', required=True)
    p.add_argument('--meta', default='{}')
    p.add_argument('--scenes', required=True)
    args = parser.parse_args()
    if args.cmd == 'run':
        Recorder(args).run()
    elif args.cmd == 'act':
        cmd_act(args)
    else:
        cmd_pack(args)


if __name__ == '__main__':
    main()
