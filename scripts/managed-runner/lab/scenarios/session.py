"""One session on erin's managed runner, in a new folder there, on the named key; then wait until its turn has ended
and save its events to $LAB_OUT/sessions/<id>.json.

  LAB_TEST_SERVER_DIR=... LAB_OUT=... python3 session.py PROVIDER FOLDER TITLE PROMPT
  LAB_TEST_SERVER_DIR=... LAB_OUT=... python3 session.py --wait SESSION_ID   (wait again for a session already made)

The session runs with bypassPermissions, so the engine asks nothing; Orbit's own owner cards still appear.
"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('ll', LAB / 'login-lab.py')
ll = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ll)
OUT = Path(os.environ['LAB_OUT']) / 'sessions'
OUT.mkdir(parents=True, exist_ok=True)
tok = ll.owner_state('erin')['accessToken']

if sys.argv[1] == '--wait':
    sid = sys.argv[2]
else:
    provider, folder, title, prompt = sys.argv[1:5]
    runner = ll.ml.status_of('erin')['runnerId']
    body = {'prompt': prompt, 'title': title, 'provider': provider, 'assignedRunnerId': runner,
            'newWorkspace': {'runnerId': runner, 'newFolder': folder}, 'permissionMode': 'bypassPermissions'}
    code, answer = ll.http('POST', '/sessions', body, token=tok)
    print('POST /sessions', code, {k: answer.get(k) for k in ('id', 'status', 'provider', 'engine', 'model', 'workspaceId', 'code', 'message')}
          if isinstance(answer, dict) else answer, flush=True)
    if code not in (200, 201):
        raise SystemExit(1)
    sid = answer['id']

deadline = time.monotonic() + 900
last = None
while True:
    code, s = ll.http('GET', f'/sessions/{sid}', token=tok)
    view = {k: s.get(k) for k in ('status', 'runStatus', 'engine', 'provider', 'model', 'endReason')}
    if view != last:
        print(ll.now()[11:19], view, flush=True)
        last = view
    if view['runStatus'] not in ('PENDING', 'RUNNING', 'QUEUED', None) or view['status'] in ('FAILED', 'AWAITING_INPUT', 'ENDED'):
        break
    if time.monotonic() > deadline:
        print('timed out')
        break
    time.sleep(5)
events, after = [], 0
while True:
    page = ll.http('GET', f'/sessions/{sid}/events/page?after={after}&limit=200', token=tok)[1]
    batch = page.get('events', []) if isinstance(page, dict) else []
    events += batch
    if len(batch) < 200:
        break
    after = batch[-1].get('seq', after + len(batch))
(OUT / f'{sid}.json').write_text(json.dumps({'session': s, 'events': events}, indent=1))
kinds = {}
for e in events:
    kinds[e.get('type')] = kinds.get(e.get('type'), 0) + 1
print('session', sid, 'events', len(events), kinds)
for e in events:
    text = json.dumps(e.get('payload', e))
    if 'browser' in text.lower() or e.get('type') in ('assistant', 'assistant_message', 'result'):
        print(' ', e.get('seq'), e.get('type'), text[:2000])
