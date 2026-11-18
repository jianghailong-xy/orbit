#!/usr/bin/env python3
"""Session guests, the guest's side: a loopback fixture for Shared with me and the guest view. Not a deployment.

The signed-in account (Bo) owns one empty workspace and no sessions; Ana shared three sessions with it — one running, one waiting on
Ana's approval, one ended. The owner's `GET /sessions/:id` answers 404 for each, as the server does for a session that is not yours;
the guest door (`/guest-sessions`) answers them. `POST /__control {"unshare": id}` takes one away, after which the door answers 404.
A guest message appends the guest's own `user` event (externalSender ORBIT_GUEST under Bo's name), restarts the run, and two seconds
later an assistant reply ends the turn."""
import argparse, json, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

RUNNING = '01a0cca7-8609-70ed-a0e2-d4b55b8c0001'
WAITING = '01a0cca7-8609-70ed-a0e2-d4b55b8c0002'
ENDED = '01a0cca7-8609-70ed-a0e2-d4b55b8c0003'
WORKSPACE = '01a0cca7-8609-70ed-a0e2-d4b55b8c0010'
RUNNER = '01a0cca7-8609-70ed-a0e2-d4b55b8c0011'
ME = {'id': 'guest-bo', 'email': 'bo@example.test', 'name': 'Bo'}


def iso(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def user(text, sender=None):
    payload = {'text': text}
    if sender: payload['externalSender'] = {'source': 'ORBIT_GUEST', 'name': sender}
    return 'user', payload


class Session:
    def __init__(self, sid, title, run, minutes, waiting, events):
        self.id, self.title, self.run, self.minutes, self.waiting = sid, title, run, minutes, waiting
        self.shared = True
        self.events = []
        for kind, payload in events: self.append(kind, payload)

    def append(self, kind, payload):
        seq = len(self.events) + 1
        self.events.append({'seq': seq, 'type': kind, 'payload': payload, 'turnId': f't{seq}', 'ts': iso(0), 'truncated': False})

    def head(self):
        return {'title': self.title, 'ownerName': 'Ana', 'status': self.run, 'runStatus': self.run, 'sessionState': self.run,
                'runState': self.run, 'lifecycleState': 'OPEN', 'filingState': 'OPEN', 'waitingOnOwner': self.waiting}

    def summary(self):
        return {'id': self.id, 'title': self.title, 'ownerName': 'Ana', 'status': self.run, 'sessionState': self.run,
                'lifecycleState': 'OPEN', 'addedAt': iso(60 * 24 * 3), 'lastTurnAt': iso(self.minutes)}


lock = threading.RLock()
sessions = {}
calls = []


def reset():
    sessions.clear()
    sessions[RUNNING] = Session(RUNNING, 'Fix the login redirect\nThe callback drops the next= parameter', 'RUNNING', 2, False, [
        user('The sign-in callback loses where I was going. Can you look?'),
        ('assistant', {'text': 'Looking at the callback handler now.'}),
        user('It happens on the staging deployment too.', 'Cy'),
        ('tool_use', {'id': 'tool-1', 'name': 'Read', 'input': {'file_path': 'src/auth/callback.ts'}}),
        ('tool_result', {'toolUseId': 'tool-1', 'content': 'export function callback(req) { ... }'}),
        ('assistant', {'text': 'The callback rebuilds the URL without `next`. I am patching it and running the auth tests.'}),
    ])
    sessions[WAITING] = Session(WAITING, 'Upgrade the payment SDK', 'AWAITING_INPUT', 60, True, [
        user('Bump the payment SDK to v5 and fix what breaks.'),
        ('assistant', {'text': 'v5 renames `charge()` to `capture()`. I need to run the migration script, which asks for approval.'}),
    ])
    sessions[ENDED] = Session(ENDED, 'Write the release notes', 'CANCELLED', 60 * 24 * 2, False, [
        user('Draft release notes for 2.4 from the merged PRs.'),
        ('assistant', {'text': 'Here is a draft:\n\n- Faster sign-in\n- Dark mode for the dashboard\n- Fixed CSV export'}),
        user('Thanks! Can you add the API changes too?', 'Bo'),
        ('assistant', {'text': 'Added an **API changes** section with the two new endpoints.'}),
    ])


reset()


def reply_later(session):
    time.sleep(2)
    with lock:
        session.append('assistant', {'text': 'Done — the tests pass on my side. Anything else?'})
        session.run = 'AWAITING_INPUT'
        session.minutes = 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def reply(self, value, status=200):
        data = encoded(value)
        self.send_response(status); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def authorized(self):
        if self.headers.get('Authorization') != 'Bearer guest-fixture-access':
            self.reply({'message': 'expired'}, 401); return False
        return True

    def do_POST(self):
        path = urlparse(self.path).path
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.loads(raw or b'{}')
        if path == '/__control':
            with lock:
                if body.get('reset'): reset()
                if body.get('unshare') in sessions: sessions[body['unshare']].shared = False
            return self.reply({'ok': True})
        if path in ['/api/auth/login', '/api/auth/refresh']:
            return self.reply({'accessToken': 'guest-fixture-access', 'refreshToken': 'guest-fixture-refresh', 'user': ME})
        if path == '/api/auth/logout': return self.reply({})
        if not self.authorized(): return
        with lock:
            calls.append({'method': 'POST', 'path': self.path, 'body': body})
            parts = path.strip('/').split('/')
            if len(parts) == 4 and parts[:2] == ['api', 'guest-sessions'] and parts[3] == 'turns':
                session = sessions.get(parts[2])
                if not session or not session.shared: return self.reply({'code': 'GUEST_SESSION_NOT_SHARED'}, 404)
                if set(body) != {'clientTurnId', 'content'}: return self.reply({'message': 'text only'}, 400)
                revived = session.run not in ('QUEUED', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
                session.append(*user(body['content'], ME['name']))
                session.run = 'RUNNING'; session.waiting = False; session.minutes = 0
                threading.Thread(target=reply_later, args=(session,), daemon=True).start()
                return self.reply({'turnId': f'turn-{len(session.events)}', 'revived': revived}, 201)
        return self.reply({}, 404)

    def do_GET(self):
        url = urlparse(self.path); path = url.path; query = parse_qs(url.query)
        if path == '/__stats':
            with lock: return self.reply({'calls': calls})
        if path == '/api/auth/methods': return self.reply({'password': True, 'google': False})
        if not self.authorized(): return
        with lock: calls.append({'method': 'GET', 'path': self.path})
        if path == '/api/events' or path.endswith('/events') and path.startswith('/api/sessions/'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            try:
                for _ in range(120):
                    self.wfile.write(b'data: ' + encoded({'type': 'ping', 'seq': 9007199254740991, 'payload': {}}) + b'\n\n')
                    self.wfile.flush(); time.sleep(1)
            except (BrokenPipeError, ConnectionResetError): pass
            self.close_connection = True; return
        if path == '/api/users/me': return self.reply(ME)
        if path == '/api/workspaces': return self.reply([{'id': WORKSPACE, 'name': 'Bo’s laptop', 'runnerId': RUNNER, 'enabled': True}])
        if path == '/api/runners': return self.reply([{'id': RUNNER, 'name': 'Bo’s laptop', 'online': True}])
        if path == '/api/sessions': return self.reply([])
        parts = path.strip('/').split('/')
        # Not this account's: the owner's read refuses every one of Ana's sessions.
        if len(parts) >= 3 and parts[:2] == ['api', 'sessions']: return self.reply({'statusCode': 404, 'message': 'Session not found'}, 404)
        if path == '/api/guest-sessions':
            with lock: return self.reply({'sessions': [s.summary() for s in sessions.values() if s.shared]})
        if len(parts) >= 3 and parts[:2] == ['api', 'guest-sessions']:
            with lock:
                session = sessions.get(parts[2])
                if not session or not session.shared: return self.reply({'statusCode': 404, 'code': 'GUEST_SESSION_NOT_SHARED'}, 404)
                limit = int(query.get('limit', ['200'])[0])
                if len(parts) == 3:
                    return self.reply({**session.head(), 'events': session.events[-limit:], 'hasMore': len(session.events) > limit})
                if len(parts) == 5:
                    seq = int(parts[4])
                    return self.reply(next(e for e in session.events if e['seq'] == seq))
                if 'after' in query:
                    after = int(query['after'][0])
                    newer = [e for e in session.events if e['seq'] > after]
                    return self.reply({**session.head(), 'events': newer[:limit], 'after': newer[limit - 1]['seq'] if len(newer) > limit else None})
                before = int(query.get('before', ['0'])[0])
                older = [e for e in session.events if e['seq'] < before]
                return self.reply({'events': older[-limit:], 'hasMore': len(older) > limit})
        return self.reply([])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=18768)
    ThreadingHTTPServer(('127.0.0.1', parser.parse_args().port), Handler).serve_forever()
