#!/usr/bin/env python3
"""Self-test of replay.py against a synthetic scene: the clock, the hold before an action, the wildcard
cursor, an unrecorded request, a key field that differs, a session stream from sinceSeq, and the shift.

  python3 -I replay_selftest.py WORKDIR
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

KIT = Path(__file__).resolve().parent
WORK = Path(sys.argv[1])
SCENES = WORK / 'scenes'
SCENES.mkdir(parents=True, exist_ok=True)
T0 = '2026-10-18T01:00:00.000Z'
JSON = {'content-type': 'application/json'}
SCENE = {
    'name': 'selftest', 't0': T0, 'duration': 10, 'meta': {'surface': 'compose'},
    'exchanges': [
        {'t': 0, 'm': 'GET', 'path': '/api/managed-runner', 's': 200, 'h': JSON,
         'b': json.dumps({'managementState': 'WAITING_CAPACITY', 'lastHeartbeatAt': '2026-10-18T00:59:30.000Z',
                          'plain': '2026-10-18T01:00:00Z'})},
        {'t': 2, 'm': 'GET', 'path': '/api/managed-runner', 's': 200, 'h': JSON, 'b': json.dumps({'managementState': 'STARTING'})},
        {'t': 8, 'm': 'GET', 'path': '/api/managed-runner', 's': 200, 'h': JSON, 'b': json.dumps({'managementState': 'READY'})},
        {'t': 0, 'm': 'GET', 'path': '/api/sessions?view=open&since=', 's': 200, 'h': JSON,
         'b': json.dumps({'full': True, 'sessions': [], 'cursor': 'c1'})},
        # Read every 15 s: the key shows at 4 s, a second one at 6 s, after the action at 5 s.
        {'t': 0, 'm': 'GET', 'path': '/api/providers', 's': 200, 'h': JSON, 'b': json.dumps([])},
        {'t': 4, 'm': 'GET', 'path': '/api/providers', 's': 200, 'h': JSON, 'b': json.dumps(['k1'])},
        {'t': 6, 'm': 'GET', 'path': '/api/providers', 's': 200, 'h': JSON, 'b': json.dumps(['k1', 'k2'])},
    ],
    'streams': [{'path': '/api/sessions/S1/events', 's': 200, 'h': {}, 'events': [
        {'t': 0, 'seq': 1, 'raw': 'data: {"seq":1,"ts":"2026-10-18T01:00:00.500Z"}\n\n'},
        {'t': 6, 'seq': 2, 'raw': 'data: {"seq":2}\n\n'}]}],
    'actions': [{'t': 5, 'm': 'POST', 'path': '/api/sessions', 'body': {'prompt': 'T07 hello', 'agentId': 'W1', 'model': 'm1'},
                 'key': ['agentId', 'prompt', 'engine', 'provider', 'model'], 's': 201, 'h': JSON,
                 'b': json.dumps({'id': 'S1', 'status': 'PENDING'})}],
    'rules': {'wildcard': {'/api/sessions': ['since']}, 'sse': ['/api/events', '/api/sessions/*/events'],
              'sampledEvery': {'/api/providers': 15}},
}
PORT = 18765
BASE = f'http://127.0.0.1:{PORT}'
checks = []


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def check(name, ok, detail=''):
    checks.append((name, bool(ok), detail))


def state():
    return json.loads(call('GET', '/api/managed-runner')[1])['managementState']


def main():
    (SCENES / 'selftest.json').write_text(json.dumps(SCENE))
    log = WORK / 'requests.log'
    proc = subprocess.Popen([sys.executable, '-I', str(KIT / 'replay.py'), str(PORT), str(log), str(SCENES)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                call('GET', '/__clock')
                break
            except OSError:
                time.sleep(0.1)
        s, b = call('POST', '/__scene', {'name': 'selftest'})
        check('scene loads and names its actions', s == 200 and json.loads(b)['actions'][0]['body']['prompt'] == 'T07 hello', b[:200])
        doc = json.loads(call('GET', '/api/managed-runner')[1])
        check('the answer at the start', doc['managementState'] == 'WAITING_CAPACITY', doc)
        beat = datetime.strptime(doc['lastHeartbeatAt'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc).timestamp()
        check('timestamps shifted to now, keeping their 30 s age and their format',
              abs((time.time() - beat) - 30) < 2 and len(doc['plain']) == 20 and doc['plain'] != '2026-10-18T01:00:00Z',
              f"age {time.time() - beat:.1f} plain {doc['plain']}")
        keys = json.loads(call('GET', '/api/providers')[1])
        check('a request read every 15 s gets its next read early, but not one past an unsent write', keys == ['k1'], keys)
        time.sleep(2.3)
        check('the clock moves', state() == 'STARTING')
        s, b = call('GET', '/api/sessions?view=open&since=c1')
        check('the session cursor is a wildcard', s == 200 and json.loads(b)['cursor'] == 'c1', b)
        time.sleep(3.5)
        clock = json.loads(call('GET', '/__clock')[1])['clock']
        check('the clock holds before an action the app has not sent', 4.8 < clock < 5.0, clock)
        check('so a later answer is not served yet', state() == 'STARTING')
        s, _ = call('GET', '/api/not-recorded')
        check('an unrecorded request is a 404', s == 404)
        s, b = call('POST', '/api/sessions', {'prompt': 'another prompt', 'agentId': 'W1', 'model': 'm1', 'clientTurnId': 'x'})
        check('the write is answered with the recorded answer', s == 201 and json.loads(b)['id'] == 'S1', b)
        check('a read right after the write gets the first answer recorded after it', state() == 'READY')
        keys = json.loads(call('GET', '/api/providers')[1])
        check('once the write is sent, the read every 15 s after it is served', keys == ['k1', 'k2'], keys)
        started, got = time.time(), []
        with urllib.request.urlopen(BASE + '/api/sessions/S1/events?sinceSeq=0&maxPayload=2048', timeout=10) as r:
            while len(got) < 2:
                line = r.readline().decode()
                if line.startswith('data:'):
                    got.append((json.loads(line[5:]), round(time.time() - started, 1)))
        check('the stream sends what follows sinceSeq at once, and the rest at its time',
              got[0][0]['seq'] == 1 and got[0][1] < 0.6 and got[1][0]['seq'] == 2 and 0.6 < got[1][1] < 1.6, got)
        time.sleep(2.2)
        check('after the action the clock runs on to the next answers', state() == 'READY')
        v = json.loads(call('GET', '/__violations')[1])
        whats = [x['what'] for x in v['violations']]
        check('violations: the unrecorded request and the differing key field, nothing else',
              whats == ['unrecorded request', 'key fields differ']
              and v['violations'][1]['fields'] == {'prompt': {'app': 'another prompt', 'recorded': 'T07 hello'}}, v)
        s, _ = call('POST', '/api/sessions', {'prompt': 'T07 hello'})
        check('a second write with no action left is a violation', s == 404)
    finally:
        proc.terminate()
    ok = all(c[1] for c in checks)
    for name, passed, detail in checks:
        print(('ok   ' if passed else 'FAIL ') + name + ('' if passed else f'  -- {detail}'))
    print('ALL OK' if ok else 'FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
