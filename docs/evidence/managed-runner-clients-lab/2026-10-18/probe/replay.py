#!/usr/bin/env python3
"""Serve the Orbit test server's recorded answers to the real iOS and macOS apps (task T07).

The macOS runner the apps run on cannot reach the HPC test server, and the coordinator chose replay over a
tunnel: t07rec.py recorded, on the host, every request the apps make with the time each answer came, and
this serves one recorded scene at a time on 127.0.0.1, on the scene's own clock.

  replay.py PORT LOGFILE SCENES_DIR

- A GET is answered with the latest recorded answer to the same request (method, path and query; the
  session list's `since` cursor is the one wildcard) at or before the scene's clock, or the earliest one.
  A request the recorder read only every 15 s or 30 s (the scene's `sampledEvery`, the provider list among
  them) changed somewhere in that time before the read that first shows it: that read is served once the
  clock is within that time of it, never past a write the app has not sent yet. So a list read every 2 s
  that already shows a change (a workspace's provider once a key is added) is never ahead of the slower
  one that shows the same change (the key in the provider list): the server never answered such a pair.
- The two event streams replay their recorded events at their recorded times (a session's stream from
  the `sinceSeq` the app names).
- An app's write (a first session, a message, Retry) must be the next recorded action of the same method
  and path, with the same key fields (the scene names them); the recorded answer is served and the
  clock moves to the action's time. Until the app sends it, the clock holds just before it: the recorded
  world waited for that action, so it waits for the app's. A read in the 3 s after a write gets the first
  answer recorded after it (the recorder sampled at most every 2 s), as the server answered the app then.
- Every timestamp in an answer is shifted by one constant (now - the recorded instant of the clock), so
  heartbeat ages, retry times and "updated" lines read as they did live. Nothing else is changed.
- A request the scene does not hold, or a write whose key fields differ, is a violation: it is answered
  404 and logged, and the test fails on any (GET /__violations).

Test controls: POST /__scene {"name": SCENE} loads and starts one (answers its meta); GET /__violations;
GET /__clock; POST /__mark (a line in the log); GET /__log; POST /__reset.
"""

import json
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from fnmatch import fnmatchcase
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = Path(sys.argv[2] if len(sys.argv) > 2 else 'requests.log')
SCENES = Path(sys.argv[3] if len(sys.argv) > 3 else 'scenes')
VOLATILE = {'idempotencyKey', 'clientTurnId'}
ISO = re.compile(r'"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z"')
LOCK = threading.RLock()
STATE = {'scene': None, 'generation': 0}


def parse_iso(text):
    return datetime.strptime(text.replace('Z', '+0000'), '%Y-%m-%dT%H:%M:%S.%f%z' if '.' in text else '%Y-%m-%dT%H:%M:%S%z').timestamp()


def log(line):
    stamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
    with LOCK, open(LOG, 'a') as f:
        f.write(f'{stamp} {line}\n')


class Scene:
    def __init__(self, data):
        self.name = data['name']
        self.meta = data.get('meta', {})
        self.t0 = parse_iso(data['t0'])
        self.duration = data.get('duration', 0)
        self.wild = data.get('rules', {}).get('wildcard', {})
        self.sse = data.get('rules', {}).get('sse', [])
        self.sampled = data.get('rules', {}).get('sampledEvery', {})
        self.index = {}
        for e in data['exchanges']:
            self.index.setdefault(self.key(e['m'], e['path']), []).append(e)
        for answers in self.index.values():
            answers.sort(key=lambda e: e['t'])
        self.streams = {s['path']: s for s in data['streams']}
        self.actions = data['actions']
        self.consumed = set()
        # Wall time and scene time of the last write the app sent (a recorded action), for the read after it.
        self.after_action = None
        self.violations = []
        self.notes = []
        self.requests = 0
        self.anchor_wall = time.time()
        self.anchor_rec = float(self.meta.get('start', 0))

    def key(self, method, raw):
        url = urlparse(raw)
        drop = set()
        for pattern, names in self.wild.items():
            if fnmatchcase(url.path, pattern):
                drop.update(names)
        query = sorted((k, v) for k, v in parse_qsl(url.query, keep_blank_values=True) if k not in drop)
        return f"{method} {url.path}{'?' + urlencode(query) if query else ''}"

    def next_action(self):
        return next((i for i in range(len(self.actions)) if i not in self.consumed), None)

    def clock(self):
        """The scene's time: from the last anchor, held just before an action the app has not sent yet."""
        now = self.anchor_rec + (time.time() - self.anchor_wall)
        pending = self.next_action()
        if pending is not None:
            now = min(now, self.actions[pending]['t'] - 0.05)
        return now

    def shift(self, text):
        delta = time.time() - (self.t0 + self.clock())

        def moved(match):
            at = datetime.fromtimestamp(parse_iso(match.group(1) + (match.group(2) or '') + 'Z') + delta, timezone.utc)
            fraction = match.group(2)
            body = at.strftime('%Y-%m-%dT%H:%M:%S')
            if fraction:
                digits = len(fraction) - 1
                body += '.' + f'{at.microsecond:06d}'[:digits].ljust(digits, '0')
            return f'"{body}Z"'
        return ISO.sub(moved, text)

    def violate(self, what, **detail):
        entry = {'at': round(self.clock(), 2), 'what': what, **detail}
        self.violations.append(entry)
        log(f'VIOLATION {json.dumps(entry, ensure_ascii=False)[:600]}')


def scene():
    return STATE['scene']


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # every request is logged by the handlers themselves
        pass

    def reply(self, status, body='', headers=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        for k, v in (headers or {'content-type': 'application/json'}).items():
            if k.lower() in ('content-type', 'etag') or k.lower().startswith('x-orbit-'):
                self.send_header(k, v)
        if not any(k.lower() == 'content-type' for k in (headers or {})):
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n).decode('utf-8', 'replace') if n else ''

    # ---- controls ----

    def control(self, method, path, raw=''):
        if path == '/__scene' and method == 'POST':
            order = json.loads(raw or '{}')
            data = json.loads((SCENES / f"{order['name']}.json").read_text())
            with LOCK:
                STATE['scene'] = Scene(data)
                STATE['generation'] += 1
            log(f"SCENE {order['name']} loaded: {len(data['exchanges'])} answers, {len(data['actions'])} actions, {data.get('duration')} s")
            return self.reply(200, json.dumps({'name': data['name'], 'meta': data.get('meta', {}), 'duration': data.get('duration'),
                                                'actions': [{'m': a['m'], 'path': a['path'], 't': a['t'],
                                                             'body': {k: a['body'].get(k) for k in a['key']}} for a in data['actions']]}))
        if path == '/__violations':
            sc = scene()
            return self.reply(200, json.dumps({'scene': sc.name if sc else None, 'violations': sc.violations if sc else [],
                                                'notes': sc.notes if sc else [], 'requests': sc.requests if sc else 0,
                                                'actionsLeft': [a['path'] for i, a in enumerate(sc.actions) if i not in sc.consumed] if sc else []}))
        if path == '/__clock':
            sc = scene()
            return self.reply(200, json.dumps({'scene': sc.name if sc else None, 'clock': round(sc.clock(), 2) if sc else None,
                                                'duration': sc.duration if sc else None}))
        if path == '/__mark':
            log(f'MARK {raw}')
            return self.reply(200, '{"ok":true}')
        if path == '/__log':
            return self.reply(200, json.dumps({'log': LOG.read_text() if LOG.exists() else ''}))
        if path == '/__reset':
            with LOCK:
                STATE['scene'] = None
                STATE['generation'] += 1
            return self.reply(200, '{"ok":true}')
        return self.reply(404, '{"error":"no such control"}')

    # ---- replay ----

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/__'):
            return self.control('GET', path)
        sc = scene()
        if sc is None:
            log(f'NO-SCENE GET {self.path}')
            return self.reply(503, '{"error":"no scene loaded"}')
        with LOCK:
            sc.requests += 1
        if any(fnmatchcase(path, p) for p in sc.sse):
            return self.stream(sc, path)
        with LOCK:
            key = sc.key('GET', self.path)
            answers = sc.index.get(key)
            clock = sc.clock()
            if not answers:
                sc.violate('unrecorded request', request=key)
                return self.reply(404, json.dumps({'statusCode': 404, 'message': 'not recorded in this scene'}))
            # A request read only every 15 s or 30 s: its next read once the clock is within that time of it, never
            # past a write the app has not sent (the clock holds just before it).
            horizon = clock + next((s for p, s in sc.sampled.items() if fnmatchcase(path, p)), 0)
            pending = sc.next_action()
            if pending is not None:
                horizon = min(horizon, max(clock, sc.actions[pending]['t'] - 0.05))
            chosen = answers[0]
            for e in answers:
                if e['t'] <= horizon:
                    chosen = e
                else:
                    break
            # A read within 3 s of the app's write: the server already answered with the write's effect, and the
            # recorder sampled every request at most every 2 s, so the first answer recorded after the write (up to
            # 3 s after it) is what the server said then.
            if sc.after_action and time.time() - sc.after_action[0] < 3:
                written = sc.after_action[1]
                later = [e for e in answers if written <= e['t'] <= written + 3]
                if later and chosen['t'] < written:
                    chosen = later[0]
            body = sc.shift(chosen['b'])
        log(f"GET {self.path} -> {chosen['s']} (recorded at {chosen['t']}, clock {clock:.1f})")
        return self.reply(chosen['s'], body, chosen['h'])

    def stream(self, sc, path):
        recorded = None
        for pattern in sc.sse:
            if fnmatchcase(path, pattern):
                recorded = sc.streams.get(path)
        query = dict(parse_qsl(urlparse(self.path).query))
        since = int(query['sinceSeq']) if query.get('sinceSeq', '').isdigit() else None
        if recorded is None:
            with LOCK:
                sc.violate('unrecorded stream', request=f'GET {self.path}')
            return self.reply(404, '{"statusCode":404,"message":"not recorded in this scene"}')
        generation = STATE['generation']
        self.send_response(recorded['s'])
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        clock = sc.clock()
        log(f'STREAM {self.path} opened at clock {clock:.1f} ({len(recorded["events"])} recorded events)')
        sent, last_ping = set(), time.time()
        if path == '/api/events':
            # A live connection to the control-plane stream sees only what comes after it, after the
            # preamble the server sends on connecting (the latest one recorded).
            past = [i for i, e in enumerate(recorded['events']) if e['t'] <= clock]
            preamble = [i for i in past if recorded['events'][i].get('preamble')]
            if preamble:
                self.wfile.write(sc.shift(recorded['events'][preamble[-1]]['raw']).encode())
            sent.update(past)
        try:
            while STATE['generation'] == generation:
                clock = sc.clock()
                for i, e in enumerate(recorded['events']):
                    if i in sent:
                        continue
                    if since is not None and e.get('seq') is not None and e['seq'] <= since:
                        sent.add(i)
                        continue
                    if e.get('preamble'):
                        sent.add(i)
                        continue
                    if e['t'] <= clock:
                        self.wfile.write(sc.shift(e['raw']).encode())
                        sent.add(i)
                self.wfile.flush()
                if time.time() - last_ping > 15:
                    self.wfile.write(b': ping\n\n')
                    self.wfile.flush()
                    last_ping = time.time()
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError):
            pass
        log(f'STREAM {self.path} closed ({len(sent)} sent)')

    def write(self, method):
        path = urlparse(self.path).path
        raw = self.body()
        if path.startswith('/__'):
            return self.control(method, path, raw)
        sc = scene()
        if sc is None:
            log(f'NO-SCENE {method} {self.path} {raw[:300]}')
            return self.reply(503, '{"error":"no scene loaded"}')
        with LOCK:
            sc.requests += 1
            pending = sc.next_action()
            action = sc.actions[pending] if pending is not None else None
            if action is None or action['m'] != method or action['path'] != path:
                sc.violate('unrecorded write', request=f'{method} {path}', body=raw[:400],
                           expected=f"{action['m']} {action['path']}" if action else None)
                return self.reply(404, json.dumps({'statusCode': 404, 'message': 'not recorded in this scene'}))
            try:
                sent = json.loads(raw or '{}')
            except ValueError:
                sent = {}
            differ = {k: {'app': sent.get(k), 'recorded': action['body'].get(k)} for k in action['key'] if sent.get(k) != action['body'].get(k)}
            if differ:
                sc.violate('key fields differ', request=f'{method} {path}', fields=differ)
            others = {k: {'app': sent.get(k), 'recorded': action['body'].get(k)}
                      for k in set(sent) | set(action['body']) if k not in action['key'] and k not in VOLATILE and sent.get(k) != action['body'].get(k)}
            if others:
                sc.notes.append({'request': f'{method} {path}', 'otherFields': others})
            sc.consumed.add(pending)
            sc.anchor_rec, sc.anchor_wall = action['t'], time.time()
            sc.after_action = (time.time(), action['t'])
            body = sc.shift(action['b'])
        log(f"{method} {path} {raw[:300]} -> {action['s']} (the recorded action at {action['t']})")
        return self.reply(action['s'], body, action['h'])

    def do_POST(self):
        return self.write('POST')

    def do_PATCH(self):
        return self.write('PATCH')

    def do_PUT(self):
        return self.write('PUT')

    def do_DELETE(self):
        return self.write('DELETE')


class LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True

    # HTTPServer.server_bind resolves its own name, which on macOS raises the local-network prompt.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'localhost', self.server_address[1]


if __name__ == '__main__':
    server = LoopbackServer(('127.0.0.1', PORT), Handler)
    print(f'replay listening on 127.0.0.1:{PORT}, scenes in {SCENES}', flush=True)
    server.serve_forever()
