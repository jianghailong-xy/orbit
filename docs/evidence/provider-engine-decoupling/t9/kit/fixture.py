#!/usr/bin/env python3
"""T9 loopback fixture: the account and runner the provider/engine boards draw, served as the Orbit API the Android client
reads (docs/provider-engine-contract.md §6). Records every write. A controlled HTTP fixture, not a deployment."""
import argparse, json, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

WORKSPACE = '01a0cca7-8609-70ed-a0e2-d4b55b83e001'
RUNNER = '01a0cca7-8609-70ed-a0e2-d4b55b83e002'
S_DSH = '01a0cca7-8609-70ed-a0e2-d4b55b83e003'
S_GONE = '01a0cca7-8609-70ed-a0e2-d4b55b83e004'
CREATED = '01a0cca7-8609-70ed-a0e2-d4b55b83e005'
TASK = '01a0cca7-8609-70ed-a0e2-d4b55b83e006'
POOL = '01a0cca7-8609-70ed-a0e2-d4b55b83e007'
KEY_IDS = {'deepseek': '01a0cca7-8609-70ed-a0e2-d4b55b83e011', 'deepseek-2': '01a0cca7-8609-70ed-a0e2-d4b55b83e012',
           'glm': '01a0cca7-8609-70ed-a0e2-d4b55b83e013', 'claude-max': '01a0cca7-8609-70ed-a0e2-d4b55b83e014',
           'gemini': '01a0cca7-8609-70ed-a0e2-d4b55b83e015', 'moonshot': '01a0cca7-8609-70ed-a0e2-d4b55b83e016'}


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


DEEPSEEK_MODELS = [{'value': 'deepseek-v4-pro', 'label': 'DeepSeek V4 Pro', 'reasoningLevels': ['high']},
                   {'value': 'deepseek-v4-flash', 'label': 'DeepSeek V4 Flash'}]


def key(slug, label, runtime, preset, engines, default, models, base, **extra):
    return {'slug': slug, 'label': label, 'runtime': runtime, 'presetSlug': preset, 'engines': engines, 'defaultModel': default,
            'models': models, 'runsOnOpenCode': 'opencode' in engines, 'baseUrl': base, **extra}


KEYS = [
    key('deepseek', 'DeepSeek', 'claude', 'deepseek', ['claude', 'opencode', 'dsh'], 'deepseek-v4-pro', DEEPSEEK_MODELS,
        'https://api.deepseek.com/anthropic'),
    key('deepseek-2', 'DeepSeek 2', 'claude', 'deepseek', ['claude', 'opencode', 'dsh'], 'deepseek-v4-pro', DEEPSEEK_MODELS,
        'https://api.deepseek.com/anthropic'),
    key('glm', 'Z.AI (GLM)', 'claude', 'glm', ['claude', 'opencode'], 'glm-5.2', [{'value': 'glm-5.2', 'label': 'GLM-5.2'}],
        'https://api.z.ai/api/anthropic'),
    key('claude-max', 'Claude Max', 'claude', 'anthropic', ['claude'], '', [], 'https://api.anthropic.com', modelsFromRuntime=True),
    key('gemini', 'Gemini', 'antigravity', 'gemini', ['antigravity', 'opencode'], 'gemini-3.8-flash',
        [{'value': 'gemini-3.8-flash', 'label': 'Gemini 3.8 Flash'}], 'https://generativelanguage.googleapis.com'),
    key('moonshot', 'Kimi (Moonshot)', 'kimi', 'moonshot', ['kimi', 'opencode'], 'kimi-k2.7-code',
        [{'value': 'kimi-k2.7-code', 'label': 'Kimi K2.7 Code'}], 'https://api.moonshot.ai/v1'),
]


def runner():
    return {
        'id': RUNNER, 'name': 'hpc', 'displayName': 'hpc', 'hostname': 'hpc', 'status': 'ONLINE', 'online': True,
        'version': '0.1.230', 'lastHeartbeatAt': now(), 'enrolledAt': '2026-09-01T00:00:00.000Z', 'maxConcurrent': 8,
        'activeSessions': 2, 'runsAsRoot': False, 'capabilities': ['provider:dsh', 'claude-account-move/v1'],
        'engines': [
            {'engine': 'claude', 'installed': True, 'version': '2.1.290 (Claude Code)', 'auth': 'yes',
             'accounts': [{'id': 'default', 'name': 'Default', 'auth': 'yes'}, {'id': '5c2e91a0', 'name': 'Work', 'auth': 'yes'}]},
            {'engine': 'codex', 'installed': True, 'version': '0.162.0', 'auth': 'yes'},
            {'engine': 'kimi', 'installed': False},
            {'engine': 'opencode', 'installed': True, 'version': '1.18.35'},
            {'engine': 'antigravity', 'installed': True, 'version': '1.3.2', 'auth': 'yes', 'authSource': 'google'},
            {'engine': 'dsh', 'installed': True, 'version': '0.2.0-rc.2', 'dsh': {'versionCompatible': True}}],
        'antigravity': {'supported': True, 'installed': True, 'envKeyAvailable': False, 'authSource': 'google', 'googleLogin': 'available'},
        'runtimeDefaultModels': {'claude': 'claude-opus-5-5', 'codex': 'gpt-5.6-sol', 'dsh': 'deepseek-v4-pro',
                                 'antigravity': 'gemini-3.8-flash'},
        'modelCatalog': {
            'claude': [{'value': 'claude-opus-5-5', 'label': 'Opus 5.5', 'reasoningLevels': ['low', 'medium', 'high', 'xhigh', 'max']},
                       {'value': 'claude-sonnet-5', 'label': 'Sonnet 5'}],
            'codex': [{'value': 'gpt-5.6-sol', 'label': 'gpt-5.6-sol', 'reasoningLevels': ['low', 'medium', 'high']}],
            'antigravity': [{'value': 'gemini-3.8-flash', 'label': 'Gemini 3.8 Flash'}],
            'opencode': [{'value': 'anthropic/claude-sonnet-5', 'label': 'anthropic/claude-sonnet-5'}],
            'dsh': [{'value': 'deepseek-v4-pro', 'label': 'DeepSeek V4 Pro', 'reasoningLevels': ['high', 'max']},
                    {'value': 'deepseek-v4-flash', 'label': 'DeepSeek V4 Flash'}]},
        'planUsage': {'claude': {'provider': 'claude', 'fiveHour': {'utilization': 23}, 'sevenDay': {'utilization': 12},
                                 'accounts': {'5c2e91a0': {'provider': 'claude', 'fiveHour': {'utilization': 57}}}}},
    }


class State:
    lock = threading.RLock()

    def __init__(self):
        self.reset()

    def reset(self):
        self.calls = []
        self.creations = []
        self.revision = 0
        self.no_deepseek = False
        self.sessions = {
            S_DSH: {'title': 'Fix the flaky worktree test', 'engine': 'dsh', 'provider': 'deepseek', 'model': 'deepseek-v4-pro'},
            S_GONE: {'title': 'Review the release notes', 'engine': 'dsh', 'provider': 'deepseek-old', 'model': 'deepseek-v4-pro'},
            CREATED: {'title': 'Created conversation', 'engine': 'dsh', 'provider': 'deepseek', 'model': 'deepseek-v4-pro'},
        }
        self.task = {'engine': None, 'provider': None, 'model': None}

    def keys(self):
        return [k for k in KEYS if not (self.no_deepseek and k['presetSlug'] == 'deepseek')]

    def session(self, sid):
        s = self.sessions[sid]
        return {'id': sid, 'title': s['title'], 'workspaceId': WORKSPACE, 'assignedRunnerId': RUNNER, 'status': 'AWAITING_INPUT',
                'runState': 'AWAITING_INPUT', 'lifecycleState': 'OPEN', 'engine': s['engine'], 'provider': s['provider'],
                'model': s['model'], 'permissionMode': s.get('permissionMode', 'default'), 'effort': s.get('effort', ''),
                'capabilities': {'canSend': True, 'canResume': False, 'canComplete': True},
                'createdAt': '2026-10-09T08:00:00.000Z', 'updatedAt': now(), 'lastActivityAt': now()}

    def task_json(self):
        return {'id': TASK, 'title': 'Fix the flaky worktree test', 'status': 'OPEN', 'description': 'Make worktree_test.go stable.',
                'assigneeId': WORKSPACE, 'assignee': {'id': WORKSPACE, 'name': 'orbit', 'runnerId': RUNNER},
                'creatorType': 'USER', 'createdAt': '2026-10-09T08:00:00.000Z', 'updatedAt': now(),
                'engine': self.task['engine'], 'provider': self.task['provider'], 'model': self.task['model'],
                'completionCriterion': 'EVIDENCE_JUDGMENT', 'labels': [], 'comments': [], 'sessions': [], 'dependsOn': [],
                'dependedOnBy': [], 'attachments': [], 'runnable': True}


state = State()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, value, status=200):
        data = encoded(value)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        if self.headers.get('Authorization') != 'Bearer t9-fixture-access':
            self.reply({'message': 'expired'}, 401)
            return False
        return True

    def do_POST(self):
        self.mutate('POST')

    def do_PATCH(self):
        self.mutate('PATCH')

    def do_DELETE(self):
        self.mutate('DELETE')

    def mutate(self, method):
        path = urlparse(self.path).path
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.loads(raw or b'{}')
        if path == '/__control':
            with state.lock:
                if body.get('reset'):
                    state.reset()
                if 'noDeepSeek' in body:
                    state.no_deepseek = bool(body['noDeepSeek'])
                state.revision += 1
            return self.reply({'ok': True})
        if path in ('/api/auth/login', '/api/auth/refresh'):
            return self.reply({'accessToken': 't9-fixture-access', 'refreshToken': 't9-fixture-refresh',
                               'user': {'id': 't9-user', 'email': 't9@example.test', 'name': 'T9'}})
        if path == '/api/auth/logout':
            return self.reply({})
        if not self.authorized():
            return
        with state.lock:
            state.revision += 1
            state.calls.append({'method': method, 'path': path, 'body': body})
            if path == '/api/sessions' and method == 'POST':
                state.creations.append(body)
                return self.reply({'id': CREATED})
            parts = path.strip('/').split('/')
            if len(parts) == 4 and parts[1] == 'sessions' and parts[3] in ('config', 'account') and parts[2] in state.sessions:
                for field in ('provider', 'model', 'effort', 'permissionMode'):
                    if field in body:
                        state.sessions[parts[2]][field] = body[field]
                return self.reply({'ok': True})
            if path == f'/api/tasks/{TASK}' and method == 'PATCH':
                for field in ('engine', 'provider', 'model'):
                    if field in body:
                        state.task[field] = body[field]
                return self.reply(state.task_json())
        return self.reply({'ok': True})

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == '/__stats':
            return self.reply({'scope': 'T9 controlled HTTP fixture; not a deployed backend', 'calls': state.calls,
                               'creations': state.creations, 'task': state.task,
                               'sessions': {k: {f: v[f] for f in ('engine', 'provider', 'model')} for k, v in state.sessions.items()}})
        if not self.authorized():
            return
        if path == '/api/events' or (path.startswith('/api/sessions/') and path.endswith('/events')):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                seen = -1
                for _ in range(600):
                    if path == '/api/events' and seen != state.revision:
                        seen = state.revision
                        for sid in state.sessions:
                            self.wfile.write(b'data: ' + encoded({'type': 'session.updated', 'sessionId': sid, 'data': {}}) + b'\n\n')
                    self.wfile.write(b'data: ' + encoded({'type': 'ping', 'seq': 9007199254740991, 'payload': {}}) + b'\n\n')
                    self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True
            return
        workspace = {'id': WORKSPACE, 'name': 'orbit', 'runnerId': RUNNER, 'enabled': True, 'provider': 'claude',
                     'lastProvider': 'claude', 'lastEngine': 'claude', 'model': 'claude-opus-5-5', 'effort': '', 'position': 0}
        if path == '/api/workspaces':
            return self.reply([workspace])
        if path == f'/api/workspaces/{WORKSPACE}':
            return self.reply(workspace)
        if path == '/api/sessions':
            view = parse_qs(url.query).get('view', ['open'])[0]
            return self.reply([state.session(s) for s in (S_DSH, S_GONE)] if view == 'open' else [])
        for sid in state.sessions:
            if path == f'/api/sessions/{sid}':
                return self.reply(state.session(sid))
        if path.endswith('/events/page'):
            sid = path.split('/')[3]
            rows = [{'seq': 1, 'type': 'user', 'turnId': 't1', 'payload': {'text': 'Look at why CI is red'}}] if sid in (S_DSH, S_GONE) else []
            return self.reply({'events': rows, 'hasMore': False})
        if path == '/api/runners':
            return self.reply([runner()])
        if path == f'/api/runners/{RUNNER}':
            return self.reply(runner())
        if path == '/api/providers':
            return self.reply([{k: v for k, v in row.items() if k != 'baseUrl'} for row in state.keys()])
        if path == '/api/providers/mine':
            return self.reply([{**row, 'id': KEY_IDS[row['slug']], 'hasApiKey': True, 'enabled': True} for row in state.keys()])
        if path.startswith('/api/providers/mine/') and path.endswith('/balance'):
            return self.reply({'ok': True, 'balances': [{'currency': 'CNY', 'totalBalance': '110.00', 'grantedBalance': '10.00',
                                                         'toppedUpBalance': '100.00'}], 'isAvailable': True, 'fetchedAt': now(), 'sharedWith': []})
        if path == '/api/providers/pools':
            return self.reply([{'id': POOL, 'slug': 'claude-accounts', 'label': 'Claude accounts', 'engine': 'claude',
                                'members': [], 'strategy': 'SOONEST_RESET'}])
        if path == f'/api/tasks/{TASK}':
            return self.reply(state.task_json())
        return self.reply([])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18791)
    args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
