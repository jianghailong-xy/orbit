#!/usr/bin/env python3
"""Serves one generated A01 dataset (datasets.py) to the Orbit clients over plain HTTP on loopback (A02c).

  python3 dataset-server.py OUT/DS2 [--port 18780] [--decoy-port 18781]

A replay of the dataset's files, not a deployment. A GET with a file behind it answers that file's body as
generated; the reads that depend on the request (pages, search, one record) are cut from those files the
way the apiserver cuts them; the writes the A01 journeys need are accepted and recorded; anything else is
the apiserver's own 404, and GET /__stats lists it under `unmodelled` so a gap is visible rather than
papered over. Before serving, every file is checked against the dataset's manifest.json.

On a device: `adb reverse tcp:18780 tcp:18780`, then the server address http://127.0.0.1:18780 and an
account from the dataset's accounts.json. `--decoy-port` answers like a web server that is not Orbit
(DS0's wrong-server case). POST /__control switches a dataset's scenarios (README.md).
"""
import argparse
import base64
import hashlib
import hmac
import json
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
PUBLIC = re.compile(r'^[0-9A-Za-z]{1,22}$')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def canonical(identifier):
    """Either spelling of an id (UUID or base62, as PublicIdPipe accepts) as its base62 public id."""
    if UUID.match(identifier):
        n = int(identifier.replace('-', ''), 16)
        out = ''
        while n:
            n, r = divmod(n, 62)
            out = BASE62[r] + out
        return out or '0'
    return identifier if PUBLIC.match(identifier) else None


def uuid_of(public):
    """A base62 public id as its canonical UUID (@orbit/shared base62ToUuid)."""
    n = 0
    for ch in public:
        n = n * 62 + BASE62.index(ch)
    text = f'{n:032x}'
    return f'{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}'


def nest_error(status, message):
    error = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
             413: 'Payload Too Large', 500: 'Internal Server Error', 503: 'Service Unavailable'}[status]
    return {'message': message, 'error': error, 'statusCode': status}


class Dataset:
    """The files of one dataset, checked against its manifest and indexed for the routes."""

    def __init__(self, folder):
        self.folder = folder
        self.manifest = json.loads((folder / 'manifest.json').read_text())
        for entry in self.manifest['files']:
            data = (folder / entry['path']).read_bytes()
            if hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise SystemExit(f"{entry['path']} does not match {folder / 'manifest.json'}; regenerate the dataset")
        self.name = self.manifest['dataset']
        self.raw = {}
        self.accounts = self.load('accounts.json')
        self.scenarios = self.load('scenarios.json')

    def has(self, name):
        return (self.folder / name).is_file()

    def bytes(self, name):
        if name not in self.raw:
            self.raw[name] = (self.folder / name).read_bytes()
        return self.raw[name]

    def load(self, name):
        return json.loads(self.bytes(name)) if self.has(name) else None


# ---------------------------------------------------------------------------------------------- tokens

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


class Tokens:
    """HS256 JWTs like the apiserver's (sub, email, sid, iat, exp), signed with a key derived from the dataset's
    manifest, so a token outlives a restart of this server: a P01/P09 run can restart it without signing the
    device out. The clients treat the token as opaque; only this server reads it."""

    def __init__(self, manifest_bytes):
        self.key = hashlib.sha256(b'a02c-dataset-server\x00' + manifest_bytes).digest()

    def sign(self, claims):
        head = b64url(encode({'alg': 'HS256', 'typ': 'JWT'}))
        body = b64url(encode(claims))
        mac = hmac.new(self.key, f'{head}.{body}'.encode(), hashlib.sha256).digest()
        return f'{head}.{body}.{b64url(mac)}'

    def read(self, token):
        try:
            head, body, mac = token.split('.')
            want = hmac.new(self.key, f'{head}.{body}'.encode(), hashlib.sha256).digest()
            if not hmac.compare_digest(want, unb64url(mac)):
                return None
            return json.loads(unb64url(body))
        except (ValueError, json.JSONDecodeError):
            return None


# ---------------------------------------------------------------------------------------------- server

ACCESS_TTL = 7 * 24 * 3600  # ACCESS_TOKEN_TTL's default
SSE_REPLAY_CAP, SSE_GAP_CAP, KEEPALIVE = 200, 1000, 20.0
MAX_FILE = 25 * 1024 * 1024  # AttachmentsController's multer limit
GATEWAY_LIMIT = 30 * 1024 * 1024  # gateway/nginx.conf client_max_body_size 30m
LIVE_TYPES = {'text_delta', 'thinking_delta', 'tool_output', 'approval_request', 'approval_resolved',
              'queued_turns_changed', 'background_output', 'task_progress', 'resync', 'ping'}


def clip_payload(kind, payload, cap):
    """apiserver sessions/truncate-payload.ts for the event types it trims (JS lengths: these payloads are BMP)."""
    cut = [False]

    def clip(text):
        if len(text) <= cap:
            return text
        cut[0] = True
        return text[:cap]

    def deep(value):
        if isinstance(value, str):
            return clip(value)
        if isinstance(value, list):
            return [deep(v) for v in value]
        if isinstance(value, dict):
            return {k: deep(v) for k, v in value.items()}
        return value
    if not isinstance(payload, dict):
        return payload, False
    if kind == 'tool_result' and 'content' in payload:
        content = payload['content']
        if isinstance(content, str):
            content = clip(content)
        elif isinstance(content, list):
            content = [dict(b, text=clip(b['text'])) if isinstance(b, dict) and isinstance(b.get('text'), str) else b
                       for b in content]
        return ({**payload, 'content': content}, True) if cut[0] else (payload, False)
    if kind == 'tool_use' and 'input' in payload:
        value = deep(payload['input'])
        return ({**payload, 'input': value}, True) if cut[0] else (payload, False)
    return payload, False


def max_payload(raw):
    """parseMaxPayload: absent or invalid means none; anything set is at least 256."""
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    if n != n or n <= 0 or n == float('inf'):
        return None
    return max(int(n), 256)


class State:
    def __init__(self, dataset):
        self.lock = threading.RLock()
        self.dataset = dataset
        self.tokens = Tokens(dataset.bytes('manifest.json'))
        self.users = {a['email'].lower(): a for a in dataset.accounts}
        self.access_generation = 0  # DS0 expireAccess bumps it: every older access token is then 401
        self.disabled = set()       # DS0 disable: the account's tokens answer 401 then 403 ACCOUNT_DISABLED
        self.refresh_used = set()
        self.switches = {'unreachable': False, 'interruptDownloads': 0, 'uploadDelayMs': 0, 'revokedWorkspace': False,
                         'bulkStatus': False, 'failures': True}
        self.log, self.unmodelled = [], {}
        self.uploads, self.turns = {}, {}
        self.extra = {}             # session public id -> events appended by sends
        self.subscribers = []       # account streams: queues of control events
        self.admin_users = None
        self.started = time.time()
        self.routes = []
        for method, pattern, kind, target in dataset.load('routes.json') or []:
            regex = '^' + re.sub(r':(\w+)', r'(?P<\1>[^/]+)', pattern) + '$'
            self.routes.append((method, re.compile(regex), kind, target, pattern))
        self.records = {}

    def table(self, name):
        """A record file by canonical id (the body's own `id`, or `key` for keyed rows)."""
        if name not in self.records:
            out = {}
            for line in (self.dataset.bytes(name) if self.dataset.has(name) else b'').splitlines():
                if not line:
                    continue
                row = json.loads(line)
                out[row['key'] if 'key' in row and 'body' in row else row['id']] = line
            self.records[name] = out
        return self.records[name]

    def publish(self, event):
        with self.lock:
            for queue in list(self.subscribers):
                queue.append(event)

    def note(self, method, path, status, who):
        with self.lock:
            self.log.append({'t': round(time.time() - self.started, 3), 'method': method, 'path': path,
                             'status': status, 'account': who})
            del self.log[:-2000]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    state = None

    def log_message(self, *_):
        pass

    # Replies ----------------------------------------------------------------------------------------

    def send(self, status, body=b'', mime='application/json; charset=utf-8', headers=()):
        data = body if isinstance(body, bytes) else encode(body)
        self.send_response(status)
        if data:
            self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.state.note(self.command, self.path, status, getattr(self, 'who', None))
        return status

    def error(self, status, message):
        return self.send(status, nest_error(status, message))

    def unmodelled(self):
        key = f'{self.command} {urlparse(self.path).path}'
        with self.state.lock:
            self.state.unmodelled[key] = self.state.unmodelled.get(key, 0) + 1
        return self.error(404, f'Cannot {self.command} {urlparse(self.path).path}')

    def body(self):
        length = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(length) if length else b''

    def json_body(self):
        raw = self.body()
        try:
            return json.loads(raw or b'{}')
        except json.JSONDecodeError:
            return None

    # Entry points -----------------------------------------------------------------------------------

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PATCH(self):
        self.route('PATCH')

    def do_PUT(self):
        self.route('PUT')

    def do_DELETE(self):
        self.route('DELETE')

    def route(self, method):
        try:
            return self.dispatch(method)
        except (BrokenPipeError, ConnectionResetError):
            return None
        except Exception:  # a fixture bug answers like the apiserver's unhandled error, and says where
            import traceback
            traceback.print_exc()
            return self.error(500, 'Internal server error')

    def dispatch(self, method):
        url = urlparse(self.path)
        path, query = url.path, {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        self.who = None
        if path == '/__stats' and method == 'GET':
            return self.stats()
        if path == '/__control' and method == 'POST':
            return self.control()
        if self.state.switches['unreachable']:
            # The network went away (DS0 valid-cache case): drop the connection without an answer.
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return None
        if not path.startswith('/api/'):
            return self.unmodelled()
        public = {('GET', '/api/auth/methods'): self.auth_methods, ('POST', '/api/auth/login'): self.login,
                  ('POST', '/api/auth/refresh'): self.refresh, ('POST', '/api/auth/logout'): self.logout}
        if (method, path) in public:
            return public[(method, path)](query)
        account = self.authenticate(query if path == '/api/events' else {})
        if account is None:
            return None
        self.who = account['email']
        failure = self.failure(method, path)
        if failure:
            return self.error(failure, 'Injected failure (dataset scenario)' if failure >= 500 else 'Forbidden')
        handler = self.dynamic(method, path)
        if handler:
            return handler(account, query)
        for verb, regex, kind, target, pattern in self.state.routes:
            match = regex.match(path) if verb == method else None
            if match:
                return self.serve(kind, target, match, account)
        return self.unmodelled()

    # Auth -------------------------------------------------------------------------------------------

    def auth_methods(self, _):
        return self.send(200, {'password': True, 'google': False, 'googleSignup': False})

    def issue(self, account, sid):
        state = self.state
        now = int(time.time())
        user = account['user']
        access = state.tokens.sign({'sub': user['id'], 'email': account['email'], 'sid': sid, 'iat': now,
                                    'exp': now + ACCESS_TTL, 'gen': state.access_generation, 'typ': 'access'})
        refresh = state.tokens.sign({'sid': sid, 'email': account['email'], 'n': hashlib.sha256(
            f'{sid}{time.time_ns()}'.encode()).hexdigest()[:16], 'typ': 'refresh'})
        return {'accessToken': access, 'refreshToken': refresh,
                'user': {'id': user['id'], 'email': user['email'], 'name': user['name'], 'publicId': user['id']}}

    def login(self, _):
        body = self.json_body() or {}
        email, password = body.get('email'), body.get('password')
        if not isinstance(email, str) or '@' not in email:
            return self.send(400, {'message': ['email must be an email'], 'error': 'Bad Request', 'statusCode': 400})
        account = self.state.users.get(email.lower())
        if not account or password != account['password']:
            return self.error(401, 'invalid credentials')
        if account['email'] in self.state.disabled:
            return self.send(403, {'code': 'ACCOUNT_DISABLED',
                                   'message': 'This Orbit account is disabled. Ask an administrator to enable it again.'})
        self.who = account['email']
        sid = hashlib.sha256(f"{account['email']}{time.time_ns()}".encode()).hexdigest()[:32]
        return self.send(201, self.issue(account, sid))

    def refresh(self, _):
        body = self.json_body() or {}
        token = body.get('refreshToken')
        claims = self.state.tokens.read(token) if isinstance(token, str) else None
        if not claims or claims.get('typ') != 'refresh' or claims.get('email', '').lower() not in self.state.users:
            return self.error(401, 'invalid refresh token')
        account = self.state.users[claims['email'].lower()]
        self.who = account['email']
        if account['email'] in self.state.disabled:
            return self.send(403, {'code': 'ACCOUNT_DISABLED',
                                   'message': 'This Orbit account is disabled. Ask an administrator to enable it again.'})
        with self.state.lock:
            if token in self.state.refresh_used:
                return self.error(401, 'refresh token reuse detected')
            self.state.refresh_used.add(token)
        return self.send(201, self.issue(account, claims['sid']))

    def logout(self, _):
        body = self.json_body() or {}
        if not isinstance(body.get('refreshToken'), str):
            return self.send(400, {'message': ['refreshToken must be a string'], 'error': 'Bad Request', 'statusCode': 400})
        with self.state.lock:
            self.state.refresh_used.add(body['refreshToken'])
        return self.send(201, {'success': True})

    def authenticate(self, query):
        header = self.headers.get('Authorization') or ''
        token = header[7:] if header.startswith('Bearer ') else query.get('access_token')
        if not token:
            self.error(401, 'missing bearer token')
            return None
        claims = self.state.tokens.read(token)
        if not claims or claims.get('typ') != 'access' or claims.get('exp', 0) < time.time() \
                or claims.get('gen') != self.state.access_generation:
            self.error(401, 'invalid token')
            return None
        account = self.state.users.get(claims.get('email', '').lower())
        if not account:
            self.send(200, b'')  # a valid JWT for a deleted user: 200 with an empty body
            return None
        if account['email'] in self.state.disabled:
            self.error(401, 'account disabled')
            return None
        return account

    # Scenarios --------------------------------------------------------------------------------------

    def failure(self, method, path):
        """A scenario's answer for this request, if one applies; ids in the path may be UUIDs or base62."""
        scenarios = self.state.dataset.scenarios or {}
        path = '/'.join(canonical(part) if UUID.match(part) else part for part in path.split('/'))
        if self.state.switches['failures']:
            for row in scenarios.get('failures', []):
                if row['method'] == method and row['path'] == path:
                    return row['status']
        if self.state.switches['revokedWorkspace']:
            for prefix in scenarios.get('permissionChange', {}).get('forbiddenPaths', []):
                if path == prefix or path.startswith(prefix + '/'):
                    return 403
        return None

    def control(self):
        body = self.json_body()
        if not isinstance(body, dict):
            return self.error(400, 'control body must be a JSON object')
        state, changed = self.state, []
        with state.lock:
            for key in ('unreachable', 'interruptDownloads', 'uploadDelayMs', 'revokedWorkspace', 'bulkStatus', 'failures'):
                if key in body:
                    state.switches[key] = body[key]
                    changed.append(key)
            if body.get('expireAccess'):
                state.access_generation += 1
                changed.append('expireAccess')
            for email in body.get('disable', []):
                state.disabled.add(email.lower())
                changed.append('disable')
            for email in body.get('enable', []):
                state.disabled.discard(email.lower())
                changed.append('enable')
        if {'revokedWorkspace', 'bulkStatus'} & set(changed):
            # What the server publishes when rows change under the reader: every client re-reads its directory.
            self.state.publish({'type': 'session.updated', 'sessionId': '', 'agentId': None,
                                'ts': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()), 'data': {}})
        return self.send(200, {'ok': True, 'changed': changed, 'switches': state.switches,
                               'accessGeneration': state.access_generation, 'disabled': sorted(state.disabled)})

    def stats(self):
        state = self.state
        with state.lock:
            body = {'dataset': state.dataset.name, 'seed': state.dataset.manifest['seed'],
                    'switches': state.switches, 'accessGeneration': state.access_generation,
                    'disabled': sorted(state.disabled), 'unmodelled': state.unmodelled,
                    'uploads': {k: {f: v[f] for f in ('name', 'mime', 'size', 'sha256', 'sessionId')} for k, v in state.uploads.items()},
                    'turns': {k: v['receipt'] for k, v in state.turns.items()}, 'requests': state.log[-500:]}
        return self.send(200, body)

    # Routes the files cannot answer alone ---------------------------------------------------------------

    def dynamic(self, method, path):
        parts = path.split('/')[2:]  # after /api/
        if method == 'GET' and path == '/api/events':
            return self.account_stream
        if method == 'GET' and path == '/api/users/me':
            return lambda account, _: self.send(200, account['user'])
        if method == 'GET' and path == '/api/sessions':
            return self.session_list
        if method == 'GET' and path == '/api/sessions/search':
            return self.search
        if method == 'GET' and len(parts) == 3 and parts[0] == 'sessions' and parts[2] == 'move-targets':
            return lambda account, query: self.move_targets(account, parts[1])
        if method == 'GET' and path == '/api/tasks/evidence-decisions/pending':
            return self.evidence_queue
        tasks = {'/api/tasks/page': self.tasks_page, '/api/tasks/counts': self.tasks_counts,
                 '/api/tasks/active': self.tasks_active, '/api/tasks/labels': self.tasks_labels}
        if method == 'GET' and path in tasks:
            return tasks[path]
        if method == 'GET' and len(parts) == 2 and parts[0] == 'task-lists':
            return lambda account, query: self.task_list(account, parts[1], query)
        if method == 'GET' and len(parts) == 4 and parts[0] == 'projects' and parts[2:] == ['tasks', 'page']:
            return lambda account, query: self.project_tasks_page(account, parts[1], query)
        if path == '/api/attachments' and method == 'POST':
            return self.upload
        if len(parts) == 2 and parts[0] == 'attachments' and method == 'GET':
            return lambda account, query: self.download(account, parts[1])
        if parts[:1] == ['sessions'] and len(parts) >= 3 and method == 'GET' and parts[2] == 'events':
            if len(parts) == 3:
                return lambda account, query: self.session_stream(account, parts[1], query)
            if len(parts) == 4 and parts[3] == 'page':
                return lambda account, query: self.event_page(account, parts[1], query)
            if len(parts) == 5 and parts[4] == 'full':
                return lambda account, query: self.event_full(account, parts[1], parts[3])
        if parts[:1] == ['sessions'] and len(parts) == 3 and method == 'POST' and parts[2] in ('turns', 'resume'):
            return lambda account, query: self.send_turn(account, parts[1], parts[2])
        if method == 'GET' and parts[:2] == ['wiki', 'spaces'] and len(parts) == 3:
            return lambda account, query: self.wiki_space(account, parts[2], query)
        if method == 'GET' and parts[:2] == ['wiki', 'spaces'] and len(parts) == 4 and parts[3] == 'entries':
            return lambda account, query: self.wiki_entries(account, parts[2], query)
        if method == 'GET' and parts[:2] == ['wiki', 'spaces'] and len(parts) == 5 and parts[3] == 'topics':
            return lambda account, query: self.wiki_topic(account, parts[2], parts[4])
        if method == 'GET' and parts[:2] == ['wiki', 'entries'] and len(parts) == 3:
            return lambda account, query: self.wiki_entry(account, parts[2], query)
        if method == 'GET' and path == '/api/wiki/search':
            return self.wiki_search
        if method == 'GET' and path == '/api/watches':
            return self.watches
        if method == 'GET' and parts[:1] == ['watches'] and len(parts) == 2:
            return lambda account, query: self.watch(account, parts[1])
        if parts[:2] == ['admin', 'users']:
            return lambda account, query: self.admin(account, method, parts[2:])
        if method != 'GET':
            return self.write_ack
        return None

    def serve(self, kind, target, match, account):
        state = self.state
        if isinstance(target, dict) and 'byAccount' in target:
            target = target['byAccount'].get(account['email'])
            if target is None:
                return self.unmodelled()
        if kind == 'json':
            return self.send(200, target)
        if kind == 'empty':  # a handler that returned null: 200, no body, no Content-Type
            return self.send(200, b'')
        if kind == 'file':
            name = target
            if isinstance(target, dict):  # a file a scenario swaps: {"default": …, "when": {switch: file}}
                name = target['default']
                for switch, alternative in target.get('when', {}).items():
                    if state.switches.get(switch):
                        name = alternative
            return self.send(200, state.dataset.bytes(name))
        if kind in ('record', 'keyed'):
            identifier = canonical(match.group('id'))
            name, missing = target['file'], target['missing']
            if state.switches.get('bulkStatus') and target.get('bulk'):
                swapped = state.table(target['bulk']).get(identifier)
                if swapped is not None:
                    return self.send(200, swapped)
            line = state.table(name).get(identifier) if identifier else None
            if line is None:
                return self.error(404, missing)
            if kind == 'keyed':
                row = json.loads(line)
                return self.send(row.get('status', 200), encode(row['body']) if row['body'] is not None else b'')
            return self.send(200, line)
        return self.unmodelled()

    @staticmethod
    def prefix(account):
        """Where this account's files are: api/ for a one-account dataset, api/<name>/ for each DS0 account."""
        return account['files']

    def session_list(self, account, query):
        """GET /sessions?view=…: the view's file, narrowed like SessionsService.list (workspaceId/agentId, tagId,
        projectId, limit) and as a running scenario has changed it (bulkStatus, revokedWorkspace)."""
        view = {'active': 'open', 'archived': 'completed', 'deleted': 'trash'}.get(query.get('view'), query.get('view') or 'open')
        if view == 'system':
            return self.send(200, [])
        if view not in ('open', 'completed', 'trash'):
            return self.error(400, 'view must be open, completed or trash')
        prefix = self.prefix(account)
        scenarios = self.state.dataset.scenarios or {}
        name = f'{prefix}/sessions-{view}.json'
        bulk = scenarios.get('bulkStatusChange', {}).get('files', {})
        if self.state.switches['bulkStatus'] and view in bulk:
            name = bulk[view]
        filters = {k: canonical(query[k]) for k in ('workspaceId', 'agentId', 'tagId', 'projectId') if query.get(k)}
        revoked = scenarios.get('permissionChange', {}).get('workspace') if self.state.switches['revokedWorkspace'] else None
        if not filters and not query.get('limit') and not revoked:
            return self.send(200, self.state.dataset.bytes(name))
        rows = json.loads(self.state.dataset.bytes(name))
        workspace = filters.get('workspaceId') or filters.get('agentId')
        if workspace:
            rows = [r for r in rows if (r.get('workspace') or {}).get('id') == workspace]
        if filters.get('tagId'):
            rows = [r for r in rows if any(t['id'] == filters['tagId'] for t in r['tags'])]
        if filters.get('projectId'):
            rows = [r for r in rows if (r.get('projectMembership') or {}).get('projectId') == filters['projectId']]
        if revoked:
            rows = [r for r in rows if (r.get('workspace') or {}).get('id') != revoked]
        try:
            limit = int(query.get('limit') or 0)
        except ValueError:
            limit = 0
        return self.send(200, rows[:limit] if limit > 0 else rows)

    def move_targets(self, account, identifier):
        """GET /sessions/:id/move-targets (SessionsService.moveTargets), from the dataset's workspaces and folders."""
        public, line = self.session_line(identifier)
        if line is None:
            return self.error(404, 'session not found')
        detail = json.loads(line)
        prefix = self.prefix(account)
        workspaces = json.loads(self.state.dataset.bytes(f'{prefix}/workspaces.json'))
        folders = json.loads(self.state.dataset.bytes(f'{prefix}/session-folders.json'))
        counts = {}
        for view in ('open', 'completed'):
            for row in json.loads(self.state.dataset.bytes(f'{prefix}/sessions-{view}.json')):
                if row.get('folderId'):
                    counts[row['folderId']] = counts.get(row['folderId'], 0) + 1

        def folders_of(workspace):
            return [{'id': f['id'], 'name': f['name'], 'sessionCount': counts.get(f['id'], 0), 'publicId': f['id']}
                    for f in folders if f['workspaceId'] == workspace]
        here = (detail.get('workspace') or {}).get('id')
        running = detail.get('status') in ('RUNNING', 'PENDING')
        targets = []
        for w in workspaces:
            if w['id'] == here:
                continue
            runner = w.get('runner')
            online = bool(runner) and any(r.get('online') for r in json.loads(self.state.dataset.bytes(f'{prefix}/runners.json'))
                                          if r['id'] == w.get('runnerId'))
            reason = None if online and w.get('enabled') else ('This workspace is disabled.' if not w.get('enabled')
                                                              else 'Its runner is offline.' if runner else 'This workspace has no runner.')
            targets.append({'workspaceId': w['id'], 'name': w['name'], 'provider': w.get('provider', 'claude'),
                            'runnerId': w.get('runnerId'), 'runnerName': (runner or {}).get('displayName') or (runner or {}).get('name'),
                            'runnerOnline': online, 'workDir': w.get('workDir'), 'reason': reason,
                            'conversation': 'continues' if w.get('runnerId') and w.get('runnerId') == detail.get('assignedRunnerId') else 'rebuilt',
                            'folders': folders_of(w['id']), 'workspacePublicId': w['id'], 'runnerPublicId': w.get('runnerId'),
                            'agentId': w['id']})
        return self.send(200, {'workspaceId': here, 'folderId': detail.get('folderId'), 'folders': folders_of(here),
                               'reason': None, 'needsEnd': running, 'branch': detail.get('branch'), 'changedFiles': 0,
                               'unmergedFiles': 0, 'mergeTarget': None, 'targets': targets, 'workspacePublicId': here,
                               'folderPublicId': detail.get('folderId'), 'agentId': here})

    def write_ack(self, account, query):
        """A write no journey depends on: recorded in /__stats and answered as accepted, not applied."""
        self.body()
        return self.send(201 if self.command == 'POST' else 200, {'ok': True})

    def session_line(self, identifier):
        public = canonical(identifier)
        return public, self.state.table('api/session-details.jsonl').get(public) if public else None


    def events_of(self, public):
        state = self.state
        if 'events' not in state.records:
            grouped = {}
            if state.dataset.has('api/events.jsonl'):
                for line in state.dataset.bytes('api/events.jsonl').splitlines():
                    row = json.loads(line)
                    grouped.setdefault(row['session'], []).append(row['event'])
            state.records['events'] = grouped
        return state.records['events'].get(public, []) + state.extra.get(public, [])

    def event_page(self, account, identifier, query):
        public, line = self.session_line(identifier)
        if line is None:
            return self.error(404, 'session not found')
        events = [e for e in self.events_of(public) if e['type'] not in LIVE_TYPES]
        cap = max_payload(query.get('maxPayload'))

        def number(key):
            try:
                return int(float(query[key])) if query.get(key) not in (None, '') else None
            except ValueError:
                return None
        limit, tail, before, after, around = number('limit'), number('tail'), number('before'), number('after'), query.get('around')
        take = min(max(limit or tail or 200, 1), 500)
        if around is not None:
            anchor = canonical(around)
            index = next((i for i, e in enumerate(events) if anchor and (e.get('turnId') == anchor or str(e['seq']) == around)), None)
            if index is None:
                return self.error(404, 'record not found in this session')
            start = max(0, index - take // 2)
            page = events[start:start + take]
            body = {'events': page, 'hasMore': start > 0, 'before': page[0]['seq'] if start > 0 else None,
                    'after': page[-1]['seq'] if start + take < len(events) else None,
                    'anchor': {'kind': 'event', 'id': around, 'seq': events[index]['seq']}}
        elif after is not None:
            newer = [e for e in events if e['seq'] > after]
            page = newer[:take]
            body = {'events': page, 'hasMore': len(newer) > take, 'after': page[-1]['seq'] if len(newer) > take else None}
        else:
            older = [e for e in events if before is None or e['seq'] < before]
            page = older[-take:]
            body = {'events': page, 'hasMore': len(older) > take}
        if cap:
            out = []
            for e in body['events']:
                payload, cut = clip_payload(e['type'], e['payload'], cap)
                out.append({**e, 'payload': payload, **({'truncated': True} if cut else {})})
            body['events'] = out
        return self.send(200, body)

    def event_full(self, account, identifier, seq):
        public, line = self.session_line(identifier)
        if line is None:
            return self.error(404, 'session not found')
        try:
            wanted = int(float(seq))
        except ValueError:
            return self.error(400, 'seq must be a number')
        for e in self.events_of(public):
            if e['seq'] == wanted:
                return self.send(200, e)
        return self.error(404, 'event not found')

    def stream_head(self):
        self.send_response(200)
        for name, value in (('Content-Type', 'text/event-stream'), ('Connection', 'keep-alive'),
                            ('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0, no-transform'),
                            ('Pragma', 'no-cache'), ('Expire', '0'), ('X-Accel-Buffering', 'no'),
                            ('Transfer-Encoding', 'chunked')):
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        self.counter = 0
        self.chunk(b'\n')

    def chunk(self, data):
        self.wfile.write(b'%x\r\n%s\r\n' % (len(data), data))
        self.wfile.flush()

    def frame(self, value):
        self.counter += 1
        self.chunk(b'id: %d\ndata: %s\n\n' % (self.counter, encode(value)))

    def account_stream(self, account, query):
        """GET /api/events: control events as the server frames them, a ping every 20 s, nothing replayed."""
        queue = []
        with self.state.lock:
            self.state.subscribers.append(queue)
        self.state.note('GET', self.path, 200, account['email'])
        try:
            self.stream_head()
            next_ping = time.monotonic() + KEEPALIVE
            while not self.state.switches['unreachable']:
                while queue:
                    self.frame(queue.pop(0))
                if time.monotonic() >= next_ping:
                    self.frame({'type': 'ping'})
                    next_ping += KEEPALIVE
                time.sleep(0.1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with self.state.lock:
                if queue in self.state.subscribers:
                    self.state.subscribers.remove(queue)

    def session_stream(self, account, identifier, query):
        """GET /api/sessions/:id/events: the gap after sinceSeq (at most 1000, else one resync) or the newest 200,
        then what sends append, with a ping every 20 s."""
        public, line = self.session_line(identifier)
        if line is None:
            return self.error(403, 'session not found')
        cap = max_payload(query.get('maxPayload'))
        try:
            since = int(float(query.get('sinceSeq', '')))
        except ValueError:
            since = 0
        self.state.note('GET', self.path, 200, account['email'])

        def shaped(e):
            if not cap:
                return e
            payload, cut = clip_payload(e['type'], e['payload'], cap)
            return {**e, 'payload': payload, **({'truncated': True} if cut else {})}
        try:
            self.stream_head()
            events = self.events_of(public)
            if since > 0:
                gap = [e for e in events if e['seq'] > since]
                replay = [{'seq': 0, 'type': 'resync', 'payload': {}, 'turnId': None,
                           'ts': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}] if len(gap) > SSE_GAP_CAP else gap
            else:
                replay = events[-SSE_REPLAY_CAP:]
            last = max([since] + [e['seq'] for e in events])
            for e in replay:
                self.frame(shaped(e))
            next_ping = time.monotonic() + KEEPALIVE
            while not self.state.switches['unreachable']:
                for e in [e for e in self.events_of(public) if e['seq'] > last]:
                    self.frame(shaped(e))
                    last = e['seq']
                if time.monotonic() >= next_ping:
                    self.frame({'type': 'ping'})
                    next_ping += KEEPALIVE
                time.sleep(0.1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def search(self, account, query):
        """GET /sessions/search: the dataset's own answer for a fixed keyword (api/sessions-search.json), else a
        title-then-message substring search over the dataset, newest first, at most 50 (SessionsService.search)."""
        q = query.get('q', '')
        try:
            limit = min(max(int(query.get('limit') or 20), 1), 50)
        except ValueError:
            limit = 20
        fixed = self.state.dataset.load('api/sessions-search.json') or {}
        key = ' '.join(q.split())
        if key in fixed:
            body = dict(fixed[key])
            body['hits'] = body['hits'][:limit]
            return self.send(200, body)
        rows = []
        for view in ('open', 'completed'):
            if self.state.dataset.has(f'api/sessions-{view}.json'):
                rows += json.loads(self.state.dataset.bytes(f'api/sessions-{view}.json'))
        rows.sort(key=lambda r: r.get('lastTurnAt') or r['createdAt'], reverse=True)
        needle = key.lower()
        if not key:
            hits = [(r, 'recent', None) for r in rows]
        else:
            hits = [(r, 'title', r['title']) for r in rows if needle in (r['title'] or '').lower()]
            if len(key) >= 3:
                for r in rows:
                    if needle in (r['title'] or '').lower():
                        continue
                    for e in reversed(self.events_of(r['id'])):
                        text = e['payload'].get('text') if e['type'] in ('user', 'assistant') else None
                        if text and needle in text.lower():
                            at = text.lower().index(needle)
                            hits.append((r, 'message', ' '.join(text[max(0, at - 60):at + len(needle) + 60].split())))
                            break
        out = []
        for r, field, snippet in hits:
            agent = {'id': r['agent']['id'], 'name': r['agent']['name'], 'publicId': r['agent']['id']} if r.get('agent') else None
            out.append({'id': r['id'], 'title': r['title'], 'status': r['status'], 'runStatus': r['runStatus'],
                        'sessionState': r['sessionState'], 'runState': r['runState'], 'lifecycleState': r['lifecycleState'],
                        'filingState': r['filingState'], 'agent': agent, 'runnerId': r['assignedRunnerId'],
                        'taskId': r['taskId'], 'taskTitle': r['taskTitle'], 'lastTurnAt': r['lastTurnAt'],
                        'createdAt': r['createdAt'], 'completedAt': r['completedAt'], 'archivedAt': r['archivedAt'],
                        'deletedAt': r['deletedAt'], 'endReason': r['endReason'], 'matchField': field, 'snippet': snippet,
                        'sessionKind': 'CONVERSATION', 'publicId': r['id'], 'runnerPublicId': r['assignedRunnerId'],
                        'taskPublicId': r['taskId'], 'workspace': agent})
        total = len(out) if key else min(len(out), limit)
        return self.send(200, {'q': key, 'contentSearched': len(key) >= 3, 'total': total, 'hits': out[:limit]})

    def evidence_queue(self, account, query):
        session = canonical(query.get('decidingSessionId') or '')
        if not session:
            return self.error(400, 'decidingSessionId names the session these rows are read for')
        return self.send(200, {'readAt': self.state.dataset.manifest['anchor'], 'decidingSessionId': session, 'count': 0,
                               'oldestAgeSeconds': None, 'pending': [], 'waitingOnYou': [], 'waitingOnCoordinator': [],
                               'sentToCoordinator': [], 'decided': [], 'decidingSessionPublicId': session})

    # Tasks and projects ------------------------------------------------------------------------------

    def task_rows(self, account):
        """The account's task rows in page order (createdAt, id descending), as the bulk switch has them."""
        prefix = self.prefix(account)
        name = 'api/bulk/tasks.jsonl' if self.state.switches['bulkStatus'] and self.state.dataset.has('api/bulk/tasks.jsonl') \
            else f'{prefix}/tasks.jsonl'
        if name not in self.state.records:
            data = self.state.dataset.bytes(name) if self.state.dataset.has(name) else b''
            self.state.records[name] = [json.loads(line) for line in data.splitlines() if line]
        return self.state.records[name]

    def task_scope(self, account, query, fields=('listId', 'projectId', 'assigneeId', 'creatorSessionId')):
        rows = self.task_rows(account)
        for field in fields:
            value = query.get(field)
            if value is None or value == '':
                continue
            if value == 'none' and field in ('listId', 'projectId'):
                rows = [r for r in rows if r[field] is None]
            else:
                wanted = canonical(value)
                rows = [r for r in rows if r.get(field) == wanted]
        labels = self.labels_param()
        if labels:
            rows = [r for r in rows if all(label in r['labels'] for label in labels)]
        return rows

    def labels_param(self):
        """`labels`: one param is split on commas, repeated params are not (TasksController)."""
        values = parse_qs(urlparse(self.path).query, keep_blank_values=True).get('labels', [])
        if len(values) == 1:
            return [v.strip() for v in values[0].split(',') if v.strip()]
        return values

    @staticmethod
    def counts(rows):
        return {'total': len(rows), 'open': sum(r['status'] == 'OPEN' for r in rows),
                'inProgress': sum(r['status'] == 'IN_PROGRESS' for r in rows), 'done': sum(r['status'] == 'DONE' for r in rows),
                'failed': sum(r['status'] == 'FAILED' for r in rows), 'cancelled': sum(r['status'] == 'CANCELLED' for r in rows),
                'running': sum(bool(r['running']) for r in rows), 'queued': sum(bool(r['queued']) for r in rows),
                'runnable': sum(bool(r['runnable']) for r in rows)}

    @staticmethod
    def page(rows, query, default=100):
        """limit (1..200) and the base64url {createdAt,id} cursor of TasksService; limit+1 decides nextCursor."""
        raw = query.get('limit')
        try:
            limit = default if raw in (None, '') else int(raw)
        except ValueError:
            limit = -1
        if not 1 <= limit <= 200:
            return None, 'limit must be an integer from 1 to 200'
        start = 0
        if query.get('cursor'):
            try:
                cursor = json.loads(base64.urlsafe_b64decode(query['cursor'] + '=' * (-len(query['cursor']) % 4)))
                position = (cursor['createdAt'], uuid_of(canonical(cursor['id'])))
            except (ValueError, KeyError, TypeError, AttributeError):
                return None, 'invalid task cursor'
            start = next((i for i, r in enumerate(rows) if (r['createdAt'], uuid_of(r['id'])) < position), len(rows))
        chunk = rows[start:start + limit + 1]
        more = len(chunk) > limit
        chunk = chunk[:limit]
        cursor = None
        if more:
            last = chunk[-1]
            cursor = base64.urlsafe_b64encode(encode({'createdAt': last['createdAt'], 'id': uuid_of(last['id'])})).rstrip(b'=').decode()
        return (chunk, cursor), None

    def tasks_page(self, account, query):
        status = (query.get('status') or '').strip().upper()
        allowed = {'', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED', 'ONGOING', 'RUNNABLE', 'RUNNING'}
        if status not in allowed:
            return self.error(400, 'invalid task status')
        counts_mode = query.get('counts')
        if counts_mode not in (None, 'total', 'none'):
            return self.error(400, 'counts must be total or none when set')
        scope = self.task_scope(account, query)
        rows = scope
        if status in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED'):
            rows = [r for r in rows if r['status'] == status]
        elif status == 'ONGOING':
            rows = [r for r in rows if r['status'] in ('OPEN', 'IN_PROGRESS')]
        elif status == 'RUNNABLE':
            rows = [r for r in rows if r['runnable']]
        elif status == 'RUNNING':
            rows = [r for r in rows if r['running']]
        q = (query.get('q') or '').strip()[:200].lower()
        if q:
            rows = [r for r in rows if q in r['title'].lower()]
        if query.get('minPriority') not in (None,):
            try:
                floor = int(query['minPriority'])
            except ValueError:
                return self.error(400, 'minPriority must be an integer')
            rows = [r for r in rows if r['priority'] >= floor]
        result, problem = self.page(rows, query)
        if problem:
            return self.error(400, problem)
        items, cursor = result
        body = {'items': items, 'nextCursor': cursor}
        if counts_mode in (None, 'total'):
            body['total'] = len(rows)
        if counts_mode is None:
            body['counts'] = self.counts(scope)
        return self.send(200, body)

    def tasks_counts(self, account, query):
        scope = self.task_scope(account, query)
        body = self.counts(scope)
        if query.get('projectId') == 'none':
            inside = self.task_scope(account, {k: v for k, v in query.items() if k != 'projectId'})
            inside = [r for r in inside if r['projectId'] is not None]
            body['inProjects'] = {'tasks': len(inside), 'projects': len({r['projectId'] for r in inside})}
        return self.send(200, body)

    def tasks_active(self, account, query):
        rows = [r for r in self.task_scope(account, query, ('listId', 'projectId'))
                if r['running'] or r['queued'] or r['status'] in ('IN_PROGRESS', 'FAILED')]
        return self.send(200, {'items': rows[:50], 'total': len(rows), 'truncated': len(rows) > 50})

    def tasks_labels(self, account, query):
        rows = self.task_scope(account, query, ('listId', 'projectId', 'assigneeId'))
        tally = {}
        for r in rows:
            for label in r['labels']:
                t = tally.setdefault(label, {'label': label, 'total': 0, 'open': 0, 'inProgress': 0, 'done': 0,
                                             'failed': 0, 'cancelled': 0})
                t['total'] += 1
                key = {'OPEN': 'open', 'IN_PROGRESS': 'inProgress', 'DONE': 'done', 'FAILED': 'failed',
                       'CANCELLED': 'cancelled'}[r['status']]
                t[key] += 1
        items = sorted(sorted(tally.values(), key=lambda t: -t['total'])[:500], key=lambda t: t['label'])
        return self.send(200, {'items': items, 'labelTotal': len(tally), 'truncated': len(tally) > 500})

    def task_list(self, account, identifier, query):
        prefix = self.prefix(account)
        line = self.state.table(f'{prefix}/task-list-documents.jsonl').get(canonical(identifier) or '')
        if line is None:
            return self.error(404, 'task list not found')
        tasks = query.get('tasks')
        if tasks is not None and tasks.lower() != 'none':
            return self.error(400, "tasks must be 'none' when set")
        if tasks is not None:
            return self.send(200, line)
        document = json.loads(line)
        document['tasks'] = [r for r in self.task_rows(account) if r['listId'] == document['id']]
        return self.send(200, document)

    def project_tasks_page(self, account, identifier, query):
        prefix = self.prefix(account)
        project = canonical(identifier) or ''
        if self.state.table(f'{prefix}/project-documents.jsonl').get(project) is None:
            return self.error(404, 'project not found')
        name = f'{prefix}/project-task-rows.jsonl'
        if name not in self.state.records:
            grouped = {}
            for line in (self.state.dataset.bytes(name) if self.state.dataset.has(name) else b'').splitlines():
                row = json.loads(line)
                grouped.setdefault(row['project'], []).append(row['row'])
            self.state.records[name] = grouped
        rows = self.state.records[name].get(project, [])
        status = (query.get('status') or '').upper()
        if status:
            if status not in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED'):
                return self.error(400, 'status must be one of OPEN, IN_PROGRESS, DONE, CANCELLED, FAILED')
            rows = [r for r in rows if r['status'] == status]
        if query.get('parentId'):
            return self.error(404, 'parent task not found')
        result, problem = self.page(rows, query)
        if problem:
            return self.error(400, problem)
        items, cursor = result
        return self.send(200, {'items': items, 'nextCursor': cursor})

    # Wiki and watches --------------------------------------------------------------------------------

    def grouped(self, name, key, value):
        """A JSONL file of {key: …, value: …} lines, grouped by key (cached)."""
        if name not in self.state.records:
            out = {}
            for line in (self.state.dataset.bytes(name) if self.state.dataset.has(name) else b'').splitlines():
                row = json.loads(line)
                out.setdefault(row[key], []).append(row[value])
            self.state.records[name] = out
        return self.state.records[name]

    def wiki_space(self, account, identifier, query):
        """GET /wiki/spaces/:id[?include=usage]: the space document, with `usage` only when asked for."""
        line = self.state.table(f'{self.prefix(account)}/wiki-space-documents.jsonl').get(canonical(identifier) or '')
        if line is None:
            return self.error(404, 'no such wiki space')
        body = json.loads(line)
        if 'usage' in (query.get('include') or '').split(','):
            public = body.pop('publicId')
            body['usage'] = {'days': 7, 'sessionsPushed': 0, 'searches': 0, 'gets': 0, 'entries': []}
            body['publicId'] = public
        return self.send(200, body)

    def wiki_entries(self, account, identifier, query):
        space = canonical(identifier) or ''
        if self.state.table(f'{self.prefix(account)}/wiki-space-documents.jsonl').get(space) is None:
            return self.error(404, 'no such wiki space')
        rows = self.grouped(f'{self.prefix(account)}/wiki-entries.jsonl', 'space', 'row').get(space, [])
        for field in ('kind', 'status'):
            if query.get(field):
                rows = [r for r in rows if r[field] == query[field]]
        try:
            limit = min(max(int(query.get('limit') or 50), 1), 200)
        except ValueError:
            limit = 50
        return self.send(200, rows[:limit])

    def wiki_entry(self, account, identifier, query):
        line = self.state.table(f'{self.prefix(account)}/wiki-entry-details.jsonl').get(canonical(identifier) or '')
        if line is None:
            return self.error(404, 'no such wiki entry')
        body = json.loads(line)
        wanted = set((query.get('include') or '').split(','))
        for name in ('sources', 'history', 'exposure'):
            if name not in wanted:
                body.pop(name, None)
        return self.send(200, body)

    def wiki_topic(self, account, space, slug):
        for row in self.grouped(f'{self.prefix(account)}/wiki-topics.jsonl', 'space', 'body').get(canonical(space) or '', []):
            if row['slug'] == slug:
                return self.send(200, row)
        return self.error(404, 'no such wiki topic')

    def wiki_search(self, account, query):
        """GET /wiki/search: keyword hits over title, summary, topics and aliases (status active unless asked),
        at most 10, scored like a single retrieval leg (1/(60+rank))."""
        q = (query.get('q') or '').strip()
        if not q:
            return self.send(200, {'q': '', 'semantic': False, 'hits': []})
        prefix = self.prefix(account)
        spaces = self.state.table(f'{prefix}/wiki-space-documents.jsonl')
        if query.get('space') and canonical(query['space']) not in spaces:
            return self.error(404, 'no such wiki space')
        statuses = set((query.get('status') or 'active').split(','))
        needle = q.lower()
        hits = []
        for space, rows in self.grouped(f'{prefix}/wiki-entries.jsonl', 'space', 'row').items():
            if query.get('space') and space != canonical(query['space']):
                continue
            for r in rows:
                text = ' '.join([r['title'], r['summary']] + r['topics'] + r['aliases']).lower()
                if r['status'] in statuses and needle in text:
                    hits.append(r)
        try:
            limit = min(max(int(query.get('limit') or 10), 1), 10)
        except ValueError:
            limit = 10
        include = set((query.get('include') or '').split(','))
        out = []
        for rank, r in enumerate(hits[:limit], 1):
            hit = {'id': r['id'], 'kind': r['kind'], 'title': r['title'], 'summary': r['summary'], 'trust': r['trust'],
                   'anchorState': r['anchorState'], 'match': ['keyword'], 'score': round(1 / (60 + rank), 6)}
            if 'topics' in include:
                hit['topics'] = r['topics']
            hit['publicId'] = r['id']
            out.append(hit)
        return self.send(200, {'q': q, 'semantic': False, 'hits': out})

    def watch_rows(self, account):
        name = f'{self.prefix(account)}/watches.jsonl'
        if name not in self.state.records:
            data = self.state.dataset.bytes(name) if self.state.dataset.has(name) else b''
            self.state.records[name] = [json.loads(line) for line in data.splitlines() if line]
        return self.state.records[name]

    @staticmethod
    def live(row):
        """An ACTIVE watch as it reads now: the server evaluates it every minute, and a client calls an ACTIVE watch
        evaluated more than 180 s ago stale, so its evaluation clock is moved to the present (nothing else is)."""
        if row['state'] != 'ACTIVE':
            return row
        now = time.time()
        row = json.loads(encode(row))
        stamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now - 10))
        row['lastEvaluatedAt'] = stamp
        row['nextEvaluateAt'] = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now + 50))
        for target in row['targets']:
            target['lastEvaluatedAt'] = stamp
        return row

    @staticmethod
    def needs_attention(row):
        if row['state'] in ('REVOKED', 'UNRESOLVABLE') or (row['state'] == 'EXPIRED' and row['action'] == 'NOTIFY_USER'):
            return True
        deliveries = [d for m in row['matches'] for d in m['deliveries']] + row['expiryDeliveries']
        return any((d['state'] == 'DEAD_LETTER' and not (d.get('lastError') or '').startswith('WAKE_WITHDRAWN'))
                   or (d['state'] in ('PENDING', 'IN_FLIGHT') and d['attempts'] > 0) for d in deliveries)

    def watches(self, account, query):
        states = ('ACTIVE', 'PAUSED', 'MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE')
        rows = self.watch_rows(account)
        if query.get('state') is not None:
            if query['state'] not in states:
                return self.error(400, 'state is one of ' + ', '.join(states))
            rows = [r for r in rows if r['state'] == query['state']]
        if query.get('needsAttention') is not None:
            if query['needsAttention'] != 'true':
                return self.error(400, 'needsAttention must be true when set')
            rows = [r for r in rows if self.needs_attention(r)]
        return self.send(200, [self.live(r) for r in rows[:100]])

    def watch(self, account, identifier):
        wanted = canonical(identifier)
        for row in self.watch_rows(account):
            if row['id'] == wanted:
                return self.send(200, self.live(row))
        return self.error(404, 'watch not found')

    # Attachments and sends --------------------------------------------------------------------------

    def upload(self, account, query):
        from email.parser import BytesParser
        from email.policy import default as email_default
        length = int(self.headers.get('Content-Length') or 0)
        if length > GATEWAY_LIMIT:
            # What the deployment's nginx answers before the apiserver sees the body.
            self.close_connection = True
            return self.send(413, b'<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n'
                                  b'<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n'
                                  b'</body>\r\n</html>\r\n', mime='text/html')
        delay = self.state.switches['uploadDelayMs'] / 1000
        raw = bytearray()
        while len(raw) < length:
            piece = self.rfile.read(min(65536, length - len(raw)))
            if not piece:
                break
            raw += piece
            if delay:
                time.sleep(delay)  # uploadDelayMs per 64 KiB: an upload slow enough to cancel or kill mid-way
        kind = self.headers.get('Content-Type', '')
        if not kind.startswith('multipart/'):
            return self.error(400, 'file is required')
        message = BytesParser(policy=email_default).parsebytes(
            b'Content-Type: ' + kind.encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + bytes(raw))
        files = [p for p in message.iter_parts() if p.get_filename() is not None]
        if not files:
            return self.error(400, 'file is required')
        part = files[0]
        field = part.get_param('name', header='content-disposition')
        if field != 'file':
            return self.error(400, f'Unexpected file field - {field}')
        data = part.get_payload(decode=True) or b''
        if len(data) > MAX_FILE:
            return self.send(413, {'message': 'File too large', 'error': 'Payload Too Large', 'statusCode': 413})
        if not data:
            return self.error(400, 'empty file')
        session, task = query.get('sessionId'), query.get('taskId')
        if session and task:
            return self.error(400, 'an attachment is scoped to a session or a task, not both')
        if session and self.session_line(session)[1] is None:
            return self.error(404, 'session not found')
        mime = part.get_content_type() if part.get('Content-Type') else 'text/plain'
        identifier = canonical(new_uuid())
        with self.state.lock:
            self.state.uploads[identifier] = {'name': part.get_filename(), 'mime': mime, 'size': len(data),
                                              'sha256': hashlib.sha256(data).hexdigest(),
                                              'sessionId': canonical(session) if session else None, 'bytes': data}
        return self.send(201, {'id': identifier, 'publicId': identifier})

    def download(self, account, identifier):
        public = canonical(identifier)
        upload = self.state.uploads.get(public) if public else None
        if upload:
            data, mime = upload['bytes'], upload['mime']
        else:
            table = self.state.table('api/attachments.jsonl') if self.state.dataset.has('api/attachments.jsonl') else {}
            line = table.get(public) if public else None
            if line is None:
                return self.error(404, 'attachment not found')
            row = json.loads(line)
            data, mime = self.state.dataset.bytes(row['file']), row['mimeType']
        with self.state.lock:
            interrupt = self.state.switches['interruptDownloads'] > 0
            if interrupt:
                self.state.switches['interruptDownloads'] -= 1
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Disposition', 'inline')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.state.note('GET', self.path, 'interrupted' if interrupt else 200, account['email'])
        try:
            if interrupt:
                # The download breaks half way: the client reads a short body and has to fetch it again.
                self.wfile.write(data[:len(data) // 2])
                self.wfile.flush()
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
            else:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        return 200

    def send_turn(self, account, identifier, door):
        """POST /sessions/:id/turns (and /resume): idempotent on clientTurnId, attachments must be this session's
        uploads; the turn joins the transcript, with a short reply a second later."""
        body = self.json_body()
        public, line = self.session_line(identifier)
        if line is None:
            return self.error(404, 'session not found')
        if not isinstance(body, dict) or not isinstance(body.get('clientTurnId'), str):
            return self.send(400, {'message': ['clientTurnId must be a string'], 'error': 'Bad Request', 'statusCode': 400})
        if json.loads(line).get('lifecycleState') == 'TRASH':
            return self.error(409, 'the session is in Trash; restore it before sending a message')
        attachments = [canonical(a) for a in body.get('attachmentIds') or []]
        state = self.state
        with state.lock:
            known = state.turns.get(body['clientTurnId'])
            if known:
                if known['request'] != body:
                    return self.error(409, 'clientTurnId was already used with a different turn payload')
                return self.send(201, known['receipt'])
            if any(a not in state.uploads or state.uploads[a]['sessionId'] not in (None, public) for a in attachments):
                return self.error(400, 'one or more attachments are unknown or not yours')
            events = self.events_of(public)
            seq = (events[-1]['seq'] if events else 0) + 1
            turn = canonical(new_uuid())
            refs = [{'id': a, 'mime': state.uploads[a]['mime'], 'name': state.uploads[a]['name'], 'publicId': a}
                    for a in attachments]
            state.extra.setdefault(public, []).append({
                'seq': seq, 'type': 'user', 'payload': {'text': body.get('content', ''), **({'attachments': refs} if refs else {})},
                'turnId': turn, 'ts': now_iso(), 'turnPublicId': turn})
            receipt = {'turnId': turn, 'seq': seq, 'kind': body.get('kind') or 'message', 'placement': 'accepted',
                       'turnPublicId': turn, **({'revived': True} if door == 'resume' else {})}
            state.turns[body['clientTurnId']] = {'request': body, 'receipt': receipt}

        def reply():
            time.sleep(1.0)
            stamp = now_iso()
            with state.lock:
                extra = state.extra.setdefault(public, [])
                text = f'Received {len(refs)} attachment(s) and {len(body.get("content", ""))} characters.'
                extra.append({'seq': seq + 1, 'type': 'assistant', 'payload': {'text': text}, 'turnId': turn,
                              'ts': stamp, 'turnPublicId': turn})
                extra.append({'seq': seq + 2, 'type': 'turn_end', 'payload': {'subtype': 'success'}, 'turnId': turn,
                              'ts': stamp, 'turnPublicId': turn})
            state.publish({'type': 'session.updated', 'sessionId': public, 'agentId': None, 'ts': stamp, 'data': {},
                           'sessionPublicId': public, 'agentPublicId': None, 'workspaceId': None})
        threading.Thread(target=reply, daemon=True).start()
        return self.send(201, receipt)

    def admin(self, account, method, rest):
        if account['user'].get('role') != 'ADMIN':
            return self.error(403, 'admin only')
        state = self.state
        with state.lock:
            if state.admin_users is None:
                state.admin_users = [dict(a['admin']) for a in state.dataset.accounts if a.get('admin')]
            if method == 'GET' and not rest:
                return self.send(200, state.admin_users)
            body = self.json_body() or {}
            if method == 'POST' and not rest:
                identifier = canonical(new_uuid())
                row = {'id': identifier, 'email': body.get('email'), 'name': body.get('name') or body.get('email'),
                       'role': 'MEMBER', 'createdAt': now_iso(), 'disabledAt': None, 'avatarUpdatedAt': None,
                       'signInMethods': {'password': True, 'google': None}, 'lastActive': None, 'publicId': identifier}
                state.admin_users.append(row)
                return self.send(201, {**row, 'generatedPassword': 'generated-' + identifier[-8:]})
            target = next((u for u in state.admin_users if rest and u['id'] == canonical(rest[0])), None)
            if target is None:
                return self.error(404, 'user not found')
            if method == 'PATCH' and rest[1:] == ['role']:
                target['role'] = body.get('role', target['role'])
                return self.send(200, target)
            if method == 'DELETE' and len(rest) == 1:
                state.admin_users.remove(target)
                return self.send(200, {'success': True})
        return self.unmodelled()


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


def new_uuid():
    """A UUIDv7 from the clock, for what a run creates (uploads, turns): runtime rows, not dataset rows."""
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(hashlib.sha256(str(time.time_ns()).encode() + threading.current_thread().name.encode()).digest()[:10], 'big')
    value = ms << 80 | 7 << 76 | (rand >> 62 & 0xFFF) << 64 | 2 << 62 | rand & (1 << 62) - 1
    text = f'{value:032x}'
    return f'{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}'


class Decoy(BaseHTTPRequestHandler):
    """A web server that is not Orbit (DS0 wrong server): every path answers the same HTML page."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def answer(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length:
            self.rfile.read(length)
        page = b'<!doctype html><html><head><title>Welcome</title></head><body><h1>It works!</h1></body></html>\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = answer


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('dataset', type=Path, help='a generated dataset directory, e.g. OUT/DS2')
    parser.add_argument('--port', type=int, default=18780)
    parser.add_argument('--decoy-port', type=int, default=None, help='also answer as a web server that is not Orbit')
    args = parser.parse_args()
    dataset = Dataset(args.dataset.resolve())
    Handler.state = State(dataset)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    if args.decoy_port:
        decoy = ThreadingHTTPServer(('127.0.0.1', args.decoy_port), Decoy)
        decoy.daemon_threads = True
        threading.Thread(target=decoy.serve_forever, daemon=True).start()
    accounts = ', '.join(f"{a['email']} ({a['user'].get('role')})" for a in dataset.accounts)
    print(f"serving {dataset.name} from {args.dataset} on http://127.0.0.1:{args.port}"
          f"{f' (decoy on {args.decoy_port})' if args.decoy_port else ''}; accounts: {accounts}", flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
