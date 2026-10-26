#!/usr/bin/env python3
"""A02d: a runner with no engine, which stack.py seeds and drives a QA Orbit stack with.

It speaks the runner's HTTP door as the Go runner does on the server the QA stack runs (src/runner-go at
9a4bf087f): register, heartbeat, claim a session, take its inbox leases, read its inbox, post its events,
complete its turns, ask approvals and wait for the answers. What a turn says is decided by a handler that
stack.py supplies: the scripted turns of a dataset, the QA cards, or a short echo.

A server only stores session events that a runner posted, so this is how a dataset's transcripts reach a
real server. Standard library only, Python 3.9 or later.
"""
import http.client
import json
import queue
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

# What the fake runner says it is. The DS1 manifest's runners report 0.1.236.
RUNNER_VERSION = '0.1.236'
# Sent on every runner call, as the Go runner sends them. No capability is declared: the server then keeps
# everything this runner cannot do away from it (steers, source pins, terminal handoffs, orchestration
# credentials). The write-protocol revision headers are left out on purpose: a headerless runner is the
# server's N-1 shape, accepted by every version since, where a declared revision must match the server's
# contract digest exactly and a newer server would refuse it.
RUNNER_HEADERS = {
    'x-orbit-runner-capabilities': '',
    'x-orbit-runner-os': 'linux',
    'x-orbit-supported-providers': 'claude,codex',
}
LONG_POLL_SECONDS = 45  # the server holds a claim, inbox or approval poll for 25 s
EVENT_BATCH_BYTES = 1 << 20  # the Go runner posts at most 2 MiB at a time; the server takes 10 MB
TURN_KINDS_ACKED_ON_DELIVERY = ('interrupt', 'end', 'diff', 'setconfig', 'reload', 'withdraw')


def now_iso():
    moment = datetime.now(timezone.utc)
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moment.microsecond // 1000:03d}Z'


def checked_server(server):
    """The server URL, refused when it is production: orbitd.io, or the production gateway's port 2086."""
    url = urlsplit(server)
    host = (url.hostname or '').lower()
    if url.scheme not in ('http', 'https') or not host:
        raise SystemExit(f'not a server URL: {server!r}')
    if host == 'orbitd.io' or host.endswith('.orbitd.io') or url.port == 2086:
        raise SystemExit(f'{server} is production: this tool only drives the QA stack (port 2087) or a local stack')
    return server.rstrip('/')


BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


def as_uuid(public_id):
    """A server id as a UUID: the runner door names sessions by UUID, owner reads answer base62 public ids."""
    if UUID_RE.match(public_id):
        return public_id.lower()
    n = 0
    for ch in public_id:
        n = n * 62 + BASE62.index(ch)
    text = f'{n:032x}'
    return f'{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}'


def as_public(uuid_text):
    """@orbit/shared uuidToBase62."""
    n = int(uuid_text.replace('-', ''), 16)
    out = ''
    while n:
        n, r = divmod(n, 62)
        out = BASE62[r] + out
    return out or '0'


class Refusal(Exception):
    """A request the server answered with a status of 300 or more, or did not answer at all (status 0)."""

    def __init__(self, method, path, status, body):
        super().__init__(f'{method} {path} -> {status or "no answer"} {body[:500]}')
        self.method, self.path, self.status, self.body = method, path, status, body

    @property
    def code(self):
        try:
            value = json.loads(self.body)
        except ValueError:
            return None
        if isinstance(value, dict):
            inner = value.get('message') if isinstance(value.get('message'), dict) else value
            return inner.get('code')
        return None


class Api:
    """JSON over one keep-alive connection per thread, to one Orbit server's /api."""

    def __init__(self, server):
        self.server = checked_server(server)
        url = urlsplit(self.server)
        self.tls = url.scheme == 'https'
        self.host, self.port = url.hostname, url.port or (443 if self.tls else 80)
        self.prefix = url.path.rstrip('/') + '/api'
        self.local = threading.local()

    def _connection(self, timeout):
        conn = getattr(self.local, 'conn', None)
        if conn is None:
            kind = http.client.HTTPSConnection if self.tls else http.client.HTTPConnection
            conn = self.local.conn = kind(self.host, self.port, timeout=timeout)
        conn.timeout = timeout
        if conn.sock is not None:
            conn.sock.settimeout(timeout)
        return conn

    def _drop(self):
        conn = getattr(self.local, 'conn', None)
        if conn is not None:
            conn.close()
        self.local.conn = None

    def call(self, method, path, token=None, body=None, headers=None, timeout=60, attempts=1):
        """One request; `attempts` > 1 retries a lost answer, a 5xx and a 429, so pass it only for calls that
        are safe to repeat (reads, and writes the server takes idempotently)."""
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        sent = {'accept': 'application/json', 'user-agent': 'orbit-qa-stack/1'}
        if data is not None:
            sent['content-type'] = 'application/json'
        if token:
            sent['authorization'] = 'Bearer ' + token
        sent.update(headers or {})
        for attempt in range(attempts):
            try:
                conn = self._connection(timeout)
                conn.request(method, self.prefix + path, body=data, headers=sent)
                answer = conn.getresponse()
                raw = answer.read()
                if (answer.getheader('connection') or '').lower() == 'close':
                    self._drop()
            except (OSError, http.client.HTTPException) as error:
                self._drop()
                if attempt + 1 < attempts:
                    time.sleep(min(20, 1.5 ** attempt))
                    continue
                raise Refusal(method, path, 0, f'{type(error).__name__}: {error}') from None
            if (answer.status >= 500 or answer.status == 429) and attempt + 1 < attempts:
                time.sleep(min(20, 1.5 ** attempt))
                continue
            text = raw.decode('utf-8', 'replace')
            if answer.status >= 300:
                raise Refusal(method, path, answer.status, text)
            return json.loads(text) if text else None
        raise AssertionError('unreachable')


class RunnerDoor:
    """One registered runner's half of the API: its token on every call, and the runner headers."""

    def __init__(self, api, name, token):
        self.api, self.name, self.token = api, name, token

    def call(self, method, path, body=None, timeout=60, attempts=4, headers=None):
        return self.api.call(method, path, token=self.token, body=body, timeout=timeout, attempts=attempts,
                             headers={**RUNNER_HEADERS, **(headers or {})})


class Live:
    """One session this process holds: its inbox generation, its event counter and its turns in flight."""

    def __init__(self, sid, runner):
        self.sid, self.runner = sid, runner
        self.generation = None
        self.seq = 0
        self.job = {}
        self.lock = threading.Lock()
        self.polling = False
        self.kicked = False
        self.inflight = {}  # turnId -> Turn
        self.ended = False


class Turn:
    """What a handler is given for one message turn: post its events, ask approvals, complete it."""

    def __init__(self, runner, live, inbox):
        self.fake, self.live, self.inbox = runner, live, inbox
        self.sid, self.turn_id = live.sid, inbox['turnId']
        self.content = inbox.get('content') or ''
        self.kind = inbox.get('kind')
        self.stopped = threading.Event()  # set by an interrupt or an end of the session
        self.stop_reason = None
        self.completed = False

    @property
    def door(self):
        return self.fake.doors[self.live.runner]

    @property
    def job(self):
        return self.live.job

    def post(self, events, at=None):
        """Posts (type, payload) pairs as this turn's events, numbered after the session's last one."""
        rows = []
        with self.live.lock:
            for kind, payload in events:
                self.live.seq += 1
                rows.append({'seq': self.live.seq, 'type': kind, 'ts': at or now_iso(), 'turnId': self.turn_id,
                             'payload': payload})
        self.fake.post_events(self.live, rows)
        return rows

    def complete(self, status='SUCCEEDED', **fields):
        body = {'turnId': self.turn_id, 'leaseOwner': self.fake.lease_owner, 'status': status, **fields}
        body.setdefault('runtimeSessionId', self.job.get('runtimeSessionId') or self.job.get('sessionUuid'))
        try:
            answer = self.door.call('POST', f'/runner/sessions/{self.sid}/turn-complete', body)
        finally:
            self.completed = True
        return answer

    def approval(self, body):
        """Files an approval in this turn and waits for its answer: the decision, or None when the turn was
        stopped (interrupted, or its session ended) before anybody answered."""
        made = self.door.call('POST', f'/runner/sessions/{self.sid}/approvals', body)
        approval_id = made['id']
        while not self.stopped.is_set() and not self.fake.stopping.is_set():
            decision = self.door.call('GET', f'/runner/sessions/{self.sid}/approvals/{approval_id}',
                                      timeout=LONG_POLL_SECONDS)
            if decision and decision.get('status') != 'PENDING':
                return decision
        return None


class FakeRunner:
    """Heartbeats and claims for its runners, takes the sessions it is handed and hands their message turns
    to `handler(turn)`, one thread per turn. Interrupts and ends reach the turn as `turn.stopped`."""

    def __init__(self, api, runners, lease_owner, handler, log=print, engines=None, idle_capacity=None):
        self.api = api
        self.doors = {name: RunnerDoor(api, name, cfg['runnerToken']) for name, cfg in runners.items()}
        self.lease_owner = lease_owner
        self.handler = handler
        self.log = log
        self.engines = engines or {}
        self.idle_capacity = idle_capacity or {}
        self.sessions = {}
        self.keep = set()  # sessions whose inbox is read even while idle (a held turn comes back on its lease)
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.retired = set()  # runners that went offline: no more beats or claims
        self.threads = []
        self.errors = queue.Queue()

    # ---------------------------------------------------------------------------------------------- runners

    def start(self, online, claimers=1):
        """Beats for each runner in `online`, and claims for it on `claimers` long polls at once (the server hands
        each claim a different session)."""
        for name in online:
            self.beat(name)
            for loop in [self._heartbeats] + [self._claims] * claimers:
                thread = threading.Thread(target=loop, args=(name,), name=f'{loop.__name__}-{name}', daemon=True)
                thread.start()
                self.threads.append(thread)

    def stop(self):
        self.stopping.set()

    def retire(self, name):
        """Takes one runner offline, as a machine that shuts down does: its last beat says OFFLINE."""
        self.retired.add(name)
        self.doors[name].call('POST', '/runner/heartbeat', {
            'status': 'OFFLINE', 'idleCapacity': 0, 'version': RUNNER_VERSION, 'runsAsRoot': False,
            'leaseOwner': self.lease_owner, 'draining': False, 'engines': self.engines.get(name, [])}, timeout=30)

    def beat(self, name):
        held = [sid for sid, live in list(self.sessions.items()) if live.runner == name and live.inflight]
        answer = self.doors[name].call('POST', '/runner/heartbeat', {
            'status': 'ONLINE', 'idleCapacity': self.idle_capacity.get(name, 4), 'version': RUNNER_VERSION,
            'runsAsRoot': False, 'leaseOwner': self.lease_owner, 'draining': False,
            'engines': self.engines.get(name, []), 'supervisedSessionIds': held}, timeout=30)
        # An end (or a complete, or a move to Trash) asked of a session this process holds: its inbox has the
        # `end` turn, which an idle session has nobody polling for.
        for sid in (answer or {}).get('cancelSessionIds') or []:
            live = self.sessions.get(sid)
            if live is not None and not live.ended:
                self.poll_soon(live)
        return answer

    def _heartbeats(self, name):
        while not self.stopping.wait(10) and name not in self.retired:
            try:
                self.beat(name)
            except Exception as error:  # a missed beat is retried in 10 s; the server allows 90
                self.log(f'heartbeat {name}: {error}')

    def _claims(self, name):
        while not self.stopping.is_set() and name not in self.retired:
            try:
                job = self.doors[name].call('GET', '/runner/sessions/claim', timeout=LONG_POLL_SECONDS)
            except Refusal as error:
                self.log(f'claim {name}: {error}')
                self.stopping.wait(3)
                continue
            if job and job.get('sessionId'):
                try:
                    self.adopt(name, job)
                except Exception as error:
                    self.log(f'adopt {job["sessionId"]}: {error}')
                    self.errors.put(error)

    # --------------------------------------------------------------------------------------------- sessions

    def adopt(self, name, job):
        sid = job['sessionId']
        with self.lock:
            live = self.sessions.get(sid)
            if live is None or live.ended:
                live = self.sessions[sid] = Live(sid, name)
        with live.lock:
            live.job = job
            live.seq = max(live.seq, int(job.get('maxSeq') or 0))
        if live.generation is None:
            self._take(live, job.get('leaseOwner'))
        self.poll_soon(live)

    def reclaim(self, name):
        """Takes back the open sessions a previous process of this runner held (same lease owner)."""
        answer = self.doors[name].call('GET', '/runner/sessions/reclaim', timeout=60)
        rows = answer.get('sessions') if isinstance(answer, dict) else answer
        for job in rows or []:
            try:
                self.adopt(name, job)
            except Refusal as error:
                self.log(f'reclaim {job.get("sessionId")}: {error}')
        return rows or []

    def _take(self, live, seen_owner):
        door = self.doors[live.runner]
        if (seen_owner or None) != self.lease_owner:
            door.call('POST', f'/runner/sessions/{live.sid}/takeover-leases',
                      {'leaseOwner': self.lease_owner, 'expectedLeaseOwner': seen_owner})
        generation = str(uuid.uuid4())
        door.call('POST', f'/runner/sessions/{live.sid}/activate-leases',
                  {'leaseGeneration': generation, 'leaseOwner': self.lease_owner})
        live.generation = generation

    def poll_soon(self, live):
        with live.lock:
            if live.polling:
                live.kicked = True
                return
            live.polling, live.kicked = True, False
        thread = threading.Thread(target=self._poll, args=(live,), name=f'inbox-{live.sid[:8]}', daemon=True)
        thread.start()

    def _poll(self, live):
        """Reads the session's inbox while it has a turn in flight, or was just claimed or kicked; an idle
        session is not polled (its next message comes with a claim, its end with a heartbeat)."""
        door = self.doors[live.runner]
        try:
            while not self.stopping.is_set():
                try:
                    turn = door.call('GET', f'/runner/sessions/{live.sid}/inbox?leaseGeneration={live.generation}',
                                     timeout=LONG_POLL_SECONDS)
                except Refusal as error:
                    if live.ended or error.status == 409 and 'no longer open' in error.body:
                        live.ended = True
                        return
                    if error.status in (403, 404, 409):
                        self.log(f'inbox {live.sid}: {error}; taking the leases again')
                        self._take(live, self.lease_owner)
                        continue
                    raise
                if not turn or not turn.get('turnId'):
                    with live.lock:
                        if not live.inflight and not live.kicked and live.sid not in self.keep:
                            live.polling = False
                            return
                        live.kicked = False
                    continue
                self._dispatch(live, turn)
                if live.ended:
                    return
        except Exception as error:
            self.log(f'inbox {live.sid}: {error}')
            self.errors.put(error)
        finally:
            with live.lock:
                live.polling = False

    def _dispatch(self, live, inbox):
        kind = inbox.get('kind')
        if kind in ('message', 'shell'):
            with live.lock:
                if inbox['turnId'] in live.inflight:
                    return  # a lease re-delivery of the turn still running
                turn = live.inflight[inbox['turnId']] = Turn(self, live, inbox)
            thread = threading.Thread(target=self._run_turn, args=(live, turn), name=f'turn-{live.sid[:8]}', daemon=True)
            thread.start()
        elif kind in ('interrupt', 'end'):
            for turn in list(live.inflight.values()):
                turn.stop_reason = kind
                turn.stopped.set()
            if kind == 'end':
                self._finalize(live)
        elif kind == 'steer':  # never handed to a runner that declares no steer capability
            self.doors[live.runner].call('POST', f'/runner/sessions/{live.sid}/turn-complete', {
                'turnId': inbox['turnId'], 'leaseOwner': self.lease_owner, 'status': 'FAILED', 'subtype': 'steer',
                'result': 'this runner takes no mid-turn messages'})
        elif kind not in TURN_KINDS_ACKED_ON_DELIVERY:
            self.doors[live.runner].call('POST', f'/runner/sessions/{live.sid}/turn-complete', {
                'turnId': inbox['turnId'], 'leaseOwner': self.lease_owner, 'status': 'FAILED',
                'subtype': 'unknown_kind', 'result': f'this runner does not understand turns of kind {kind!r}'})

    def _run_turn(self, live, turn):
        try:
            self.handler(turn)
        except Exception as error:
            self.log(f'turn {turn.turn_id} of {live.sid}: {type(error).__name__}: {error}')
            self.errors.put(error)
        finally:
            with live.lock:
                live.inflight.pop(turn.turn_id, None)

    def _finalize(self, live):
        """The session was ended (End, Complete or Trash): settle it as the runner does, CANCELLED."""
        live.ended = True
        job = live.job or {}
        self.doors[live.runner].call('POST', f'/runner/sessions/{live.sid}/finalize', {
            'status': 'CANCELLED', 'leaseOwner': self.lease_owner,
            'runtimeSessionId': job.get('runtimeSessionId') or job.get('sessionUuid')})

    def post_events(self, live, rows):
        door = self.doors[live.runner]
        batch, size = [], 0
        for row in rows:
            encoded = len(json.dumps(row, ensure_ascii=False).encode())
            if batch and size + encoded > EVENT_BATCH_BYTES:
                door.call('POST', f'/runner/sessions/{live.sid}/events', {'leaseOwner': self.lease_owner, 'events': batch})
                batch, size = [], 0
            batch.append(row)
            size += encoded
        if batch:
            door.call('POST', f'/runner/sessions/{live.sid}/events', {'leaseOwner': self.lease_owner, 'events': batch})
