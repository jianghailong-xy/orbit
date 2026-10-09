#!/usr/bin/env python3
"""Deterministic A06 DS3/DS4 reading + DS5 streaming fixture. Loopback only, no real accounts.
No launch-time full transcript: pages are generated on demand; manifest hashes all encoded rows.
"""
import argparse, hashlib, json, threading, time, uuid, zlib, struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

SESSION = '01a0cca7-8609-70ed-a0e2-d4b55b832b60'
WORKSPACE = '01a0cca7-8609-70ed-a0e2-d4b55b832b61'
ATTACHMENT = '01a0cca7-8609-70ed-a0e2-d4b55b832b62'
RECORD = '01a0cca7-8609-70ed-a0e2-d4b55b832b63'
TASK = '01a0cca7-8609-70ed-a0e2-d4b55b832b64'
ANCHORS = {RECORD: 4900, '01a0cca7-8609-70ed-a0e2-d4b55b832b65': 418,
           '01a0cca7-8609-70ed-a0e2-d4b55b832b66': 618, '01a0cca7-8609-70ed-a0e2-d4b55b832b67': 18}

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

def picture():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    raw = b''.join(b'\0' + bytes((y % 256, 92, 178)) * 1440 for y in range(2560))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 1440, 2560, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
IMAGE = picture()
RICH = ('# Reading fixture\n\nSelect these words and copy a portion of this paragraph. 中文选择复制。\n\n'
        '**Bold** and *italic*, ~~deleted~~, `inline code`, [Related task](orbit-task:' + TASK + ').\n\n'
        '- [x] Finished\n- [ ] Pending\n  - Nested item\n\n> Quoted paragraph\n\n'
        '| Name | Value |\n| :--- | ---: |\n| 中文 | **42** |\n| Pipe | a\\|b |\n\n'
        '```diff\n-old value\n+new value\n@@ section @@\n```\n\n'
        '![Fixed 1440 × 2560 image](orbit-attachment:' + ATTACHMENT + ')\n\n'
        '[Earlier record](orbit-session:' + SESSION + '?at=' + RECORD + ')\n\nEnd of rich message.')

# A06C: the reader's increments over one short session — the sticky question, engine stderr and notices, a
# transient provider error, a workflow's progress, the Orbit context card, an image file link and the worktree bar.
SHOT = '/root/.orbit/worktrees/' + SESSION + '/shots/runner.png'
NOTE = '\n\n<referenced-task id="' + TASK + '">\n  标题   Related reading task\n</referenced-task>'
PROGRESS = {'toolUseId': 'wf-1', 'taskType': 'local_workflow', 'usage': {'totalTokens': 0, 'toolUses': 12, 'durationMs': 1020000},
            'phases': [{'index': 0, 'title': 'Design'}, {'index': 1, 'title': 'Judge'}],
            'agents': [{'index': 0, 'label': 'design:sticky-header', 'phaseIndex': 0, 'state': 'done', 'toolCalls': 7,
                        'model': 'claude-opus-5-5', 'transcriptKey': 'agent-1'},
                       {'index': 1, 'label': 'judge:product', 'phaseIndex': 1, 'state': 'error', 'error': 'rate limited'}]}
def a06c_events():
    rows = []
    def add(kind, payload): rows.append({'seq': len(rows) + 1, 'type': kind, 'payload': payload, 'ts': '2026-10-09T00:00:00.000Z'})
    add('user', {'text': 'First question: plan the reader increments'})
    for i in range(8): add('assistant', {'text': f'Plan step {i + 1}: ' + ('long reading text. ' * 40)})
    add('user', {'text': 'Second question: ship the reader' + NOTE, 'controlPlaneNote': NOTE})
    add('system', {'stderr': '--dangerously-skip-permissions cannot be used with root/sudo privileges\n'})
    add('system', {'stderr': '2026-10-03T15:27:44.249024Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized',
                   'diagnostic': {'component': 'model_catalog', 'phase': 'startup', 'severity': 'WARN', 'impact': 'degraded', 'recoverable': True, 'code': 'codex_model_catalog_auth'}})
    add('system', {'subtype': 'init', 'notice': 'Switched to Wikova · Pro — the 5-hour window on Zhang Min · Plus is spent', 'noticeKind': 'pool-member-switched'})
    add('error', {'message': 'exceeded retry limit, last status: 429 Too Many Requests, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2'})
    add('tool_use', {'id': 'wf-1', 'name': 'Workflow', 'input': {'script': "export const meta = {\n  name: 'a06c-review',\n  description: 'Review the reader increments',\n}\n"}})
    add('tool_result', {'toolUseId': 'wf-1', 'content': 'Workflow launched in background. Task ID: w2f3yv1s8\nSummary: Review the reader increments\nTranscript dir: /x'})
    add('tool_use', {'id': 'agent-1', 'name': 'Agent', 'parentToolUseId': 'wf-1', 'input': {'prompt': 'Design the sticky header'}})
    add('tool_use', {'id': 'read-1', 'name': 'Read', 'parentToolUseId': 'agent-1', 'input': {'file_path': 'src/reader/StickyQuestions.kt'}})
    add('tool_result', {'toolUseId': 'read-1', 'parentToolUseId': 'agent-1', 'content': 'package io.orbitd.android.reader'})
    add('background_task', {'toolUseId': 'wf-1', 'shellId': 'w2f3yv1s8', 'status': 'completed',
                            'summary': 'Dynamic workflow "Review the reader increments" completed', 'progress': PROGRESS})
    add('assistant', {'text': 'Saved the screenshot: [runner.png](' + SHOT + ').'})
    for i in range(6): add('assistant', {'text': f'Follow-up {i + 1}: ' + ('closing notes. ' * 30)})
    add('assistant', {'text': 'Latest answer A06C. Select these words.'})
    return rows
A06C = a06c_events()

def event(seq, mode='DS3', full=False):
    if mode == 'A06C':
        return A06C[seq - 1]
    if mode == 'REVIEW':
        kind, payload = 'assistant', {'text': f'Protected record {seq}'}
        if seq == 414: kind, payload = 'turn_end', {'subtype': 'completed'}
        if seq == 415: kind, payload = 'user', {'text': 'Question without a reply'}
        if seq == 416: kind, payload = 'turn_end', {'subtype': 'error_during_execution'}
        if seq == 417: payload['text'] = f'[![Task preview](orbit-attachment:{ATTACHMENT})](orbit-task:{TASK})'
        if seq == 418: payload['text'] = f'[![Web preview](orbit-attachment:{ATTACHMENT})](https://example.test/related)'
        if seq == 419: payload['text'] = 'Protected full message' + ('\ncomplete text' * 300 if full else ' preview')
        if seq == 420: payload['text'] = 'Protected latest 420'
        return {'seq': seq, 'type': kind, 'payload': payload, 'truncated': seq == 419 and not full, 'ts': '2026-10-04T00:00:00.000Z'}
    slot = (seq - 1) % 20
    cycle = (seq - 1) // 20
    if slot == 0:
        kind, payload = 'user', {'text': f'Question {seq}: fixed conversation', 'attachments': []}
    elif 1 <= slot <= 8:
        kind, payload = 'tool_use', {'id': f'tool-{cycle}-{slot}', 'name': 'Read', 'input': {'path': f'file-{cycle}-{slot}.kt'}}
    elif 9 <= slot <= 16:
        kind, payload = 'tool_result', {'toolUseId': f'tool-{cycle}-{slot-8}', 'content': f'Output {seq}\n' + ('line of output\n' * 160), 'isError': False}
    elif slot in (17, 18):
        kind, payload = 'assistant', {'text': f'Message {seq}: stable reading content. 中文。'}
        if mode == 'DS3' and slot == 17:
            if cycle < 20: payload['text'] = '# Long markdown\n\n' + ('中文长段落 **重点** and a [link](https://example.org).\n\n' * 600)
            elif cycle < 30: payload['text'] = '| ' + ' | '.join(f'H{i}' for i in range(8)) + ' |\n|' + ' --- |' * 8 + '\n' + ''.join('| ' + ' | '.join(f'{r}:{c}' for c in range(8)) + ' |\n' for r in range(30))
            elif cycle < 40: payload['text'] = '```kotlin\n' + ''.join(f'val line{i} = "中文 {i}"\n' for i in range(500)) + '```'
            elif cycle < 59: payload['text'] = f'![Image {cycle-40}](orbit-attachment:{ATTACHMENT})'
    else:
        kind, payload = 'turn_end', {}
    # The most recent two replies provide fixed feature targets without changing the event mix.
    if mode == 'DS3' and seq == 9982: payload.update(id='agent-499', name='Task')
    if mode == 'DS3' and seq == 9990: payload['toolUseId'] = 'agent-499'
    if mode == 'DS3' and (9983 <= seq <= 9989 or 9991 <= seq <= 9997): payload['parentToolUseId'] = 'agent-499'
    if mode == 'DS3' and seq == 9998: payload['text'] = RICH
    if mode == 'DS3' and seq == 9999: payload['text'] = 'Latest answer 9999. Select these words for native partial copy.'
    if mode == 'DS4':
        payload['fixturePadding'] = 'x' * 1000
        if kind == 'tool_result': payload['content'] = 'x' * (512 * 1024 if seq == 99990 else 128)
    value = {'seq': seq, 'type': kind, 'payload': payload, 'turnId': str(uuid.UUID(int=cycle+1)), 'ts': '2026-10-04T00:00:00.000Z'}
    if not full and kind == 'tool_result' and len(encoded(payload)) > 2048:
        value['payload'] = {**payload, 'content': str(payload['content'])[:512]}
        value['truncated'] = True
    return value

class State:
    lock = threading.RLock()
    mode = 'DS3'
    denial = 0
    page_denial = 0
    record_denial = 0
    snapshot_status = 0
    stream = False
    stream_started = 0.
    delta_count = 0
    epoch = 0
    requests = []
    posts = []
    extra = []
    merge = None
    merge_at = 0.
    merge_target = 'main'
    @property
    def base(self): return len(A06C) if self.mode == 'A06C' else 420 if self.mode == 'REVIEW' else 10000 if self.mode == 'DS3' else 100000
    @property
    def count(self): return self.base + len(self.extra)
state = State()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, value, status=200, mime='application/json'):
        data = value if isinstance(value, bytes) else encoded(value)
        self.send_response(status); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(data))); self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        path = urlparse(self.path).path
        if path == '/__control':
            with state.lock:
                if body.get('reset'):
                    state.mode = body.get('mode', 'DS3'); state.extra = []; state.denial = 0; state.stream = False; state.delta_count = 0; state.epoch += 1
                    state.page_denial = 0; state.record_denial = 0; state.snapshot_status = 0
                    state.merge = None; state.merge_target = 'main'; state.posts = []
                if 'denial' in body: state.denial = body['denial']
                for key in ('page_denial', 'record_denial', 'snapshot_status'):
                    if key in body: setattr(state, key, body[key])
                if 'stream' in body: state.stream = body['stream']; state.stream_started = time.monotonic()
                if body.get('disconnect'): state.epoch += 1
                if body.get('append'):
                    seq = state.count + 1
                    state.extra.append({'seq': seq, 'type': 'assistant', 'payload': {'text': f'New final answer {seq}'}})
            return self.reply({'ok': True})
        if path in ('/api/auth/login', '/api/auth/refresh'):
            return self.reply({'accessToken':'a06-fixture-access','refreshToken':'a06-fixture-refresh','user':{'id':'a06-user','email':'a06@example.test','name':'A06'}})
        if path == '/api/auth/logout': return self.reply({})
        if path.startswith('/api/sessions/' + SESSION + '/'):
            # The worktree bar's requests: recorded, and a merge answered by the "runner" a second later.
            action = path[len('/api/sessions/' + SESSION + '/'):]
            with state.lock:
                state.posts.append({'path': action, 'body': body})
                if action == 'merge':
                    state.merge = 'pending'; state.merge_at = time.monotonic(); state.merge_target = body.get('targetBranch') or 'main'
            return self.reply({})
        self.reply({}, 404)
    def do_GET(self):
        url = urlparse(self.path); path = url.path; query = parse_qs(url.query)
        if path == '/__stats': return self.reply({'mode': state.mode, 'deltaCount': state.delta_count, 'count': state.count, 'requests': state.requests, 'posts': state.posts})
        if self.headers.get('Authorization') != 'Bearer a06-fixture-access': return self.reply({}, 401)
        with state.lock:
            state.requests.append({'at':time.monotonic(), 'path':self.path})
        if state.denial and path.startswith('/api/sessions/' + SESSION): return self.reply({}, state.denial)
        if state.snapshot_status and path == '/api/sessions/' + SESSION: return self.reply({}, state.snapshot_status)
        if state.page_denial and path.endswith('/events/page') and 'before' in query: return self.reply({}, state.page_denial)
        if state.record_denial and (path.endswith('/full') or path.endswith('/events/page') and 'around' in query): return self.reply({}, state.record_denial)
        if path == '/api/users/me': return self.reply({'id':'a06-user','email':'a06@example.test','name':'A06'})
        session = {'id':SESSION,'title':'Long conversation','workspaceId':WORKSPACE,'status':'RUNNING','runState':'RUNNING','lifecycleState':'OPEN',
                   'branch':'orbit/a06-reading','baseSha':'a'*40,'isolationStatus':'isolated','worktreeDirty':True,
                   'changedFiles':[{'path':'reader.kt','additions':12,'deletions':3}], 'taskId':TASK, 'capabilities':{'canComplete':True}}
        if state.mode == 'A06C':
            if state.merge == 'pending' and time.monotonic() - state.merge_at > 1.0: state.merge = 'merged'
            session.update({'status': 'AWAITING_INPUT', 'runState': 'AWAITING_INPUT', 'isolationStatus': 'worktree', 'branch': 'orbit/a06c-reader-85cfd1', 'worktreeDirty': False,
                            'mergeTargets': ['main', 'develop'], 'mergeStatus': state.merge,
                            'changedFiles': [{'path': 'src/reader/WorktreeBar.kt', 'additions': 12, 'deletions': 3, 'status': 'M'},
                                             {'path': 'docs/shots/new.png', 'additions': -1, 'deletions': -1, 'status': 'A'},
                                             {'path': 'dist/app.zip', 'additions': -1, 'deletions': -1, 'status': 'A'}]})
            if state.merge: session['mergeTarget'] = state.merge_target
            if path.endswith('/diff'): return self.reply({'patches': [{'path': 'src/reader/WorktreeBar.kt',
                'patch': 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old bar\n+new bar\n context'}]})
            if path.endswith('/worktree-file'):
                wanted = query.get('path', [''])[0]
                if wanted == 'docs/shots/new.png': return self.reply(IMAGE, mime='image/png')
                if wanted == 'dist/app.zip': return self.reply(b'PK\x03\x04a06c', mime='application/zip')
                return self.reply({'message': 'Not found'}, 404)
            if path.endswith('/artifacts') and query.get('path', [''])[0] == SHOT: return self.reply(IMAGE, mime='image/png')
            if path.endswith('/background'): return self.reply([{'shellId': 'w2f3yv1s8', 'toolUseId': 'wf-1', 'kind': 'workflow', 'command': '',
                'description': 'Review the reader increments', 'status': 'done', 'progress': PROGRESS}])
        if path == '/api/sessions': return self.reply([session] if query.get('view',['open'])[0] == 'open' else [])
        if path == '/api/workspaces': return self.reply([{'id':WORKSPACE,'name':'Reader fixture','enabled':True}])
        if path == '/api/sessions/' + SESSION: return self.reply(session)
        if path == '/api/tasks/' + TASK: return self.reply({'id':TASK,'title':'Related reading task','sessionId':SESSION,'description':'**Task description**'})
        if path == '/api/tasks/' + TASK + '/owner-confirmation': return self.reply(None)
        if path == '/api/attachments/' + ATTACHMENT: return self.reply(IMAGE, mime='image/png')
        if path.endswith('/diff'): return self.reply({'patches':[{'path':'reader.kt','patch':'--- a/reader.kt\n+++ b/reader.kt\n@@ -1 +1 @@\n-old\n+new'}]})
        if path.endswith('/background'): return self.reply([
            {'shellId':'shell-1','toolUseId':'bg-1','kind':'shell','command':'build project','status':'done','latestOutput':'Background result\nBUILD SUCCESSFUL'},
            {'shellId':'shell-2','toolUseId':'bg-2','kind':'agent','command':'Review documentation','status':'running','latestOutput':'Checking references'}])
        if path.endswith('/events/page'):
            total = state.count
            if 'around' in query:
                anchor = ANCHORS.get(query['around'][0])
                if state.mode == 'REVIEW' and query['around'][0] == RECORD: anchor = 110
                if anchor is None: return self.reply({}, 404)
                start = max(1,anchor-90); end = start+199
            elif 'before' in query: end = int(query['before'][0])-1; start=max(1,end-199)
            elif 'after' in query: start=int(query['after'][0])+1; end=min(total,start+199)
            else: end=total; start=max(1,end-int(query.get('tail',['200'])[0])+1)
            base = state.base
            rows = [event(i,state.mode) if i<=base else state.extra[i-base-1] for i in range(start,end+1)]
            value = {'events':rows,'hasMore':start>1,'before':start if start>1 else None,'after':end if end<total else None}
            if 'around' in query: value['anchor']={'kind':'event','id':query['around'][0],'seq':anchor}
            return self.reply(value)
        if path.endswith('/full'):
            try: seq=int(path.split('/')[-2])
            except ValueError: return self.reply({},404)
            return self.reply(event(seq,state.mode,True))
        if path.endswith('/events'):
            is_session = '/sessions/' in path
            epoch = state.epoch
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Connection','close'); self.end_headers()
            sent_extra = len(state.extra)
            next_tick = time.monotonic()
            try:
                while epoch == state.epoch:
                    if is_session and state.stream:
                        value={'type':'text_delta','seq':0,'payload':{'delta':'流'}}
                        state.delta_count += 1
                    else: value={'type':'ping','seq':0,'sessionId':''}
                    self.wfile.write(b'data: '+encoded(value)+b'\n\n'); self.wfile.flush()
                    if is_session and len(state.extra)>sent_extra:
                        for extra in state.extra[sent_extra:]: self.wfile.write(b'data: '+encoded(extra)+b'\n\n')
                        sent_extra=len(state.extra); self.wfile.flush()
                    if is_session and state.stream and state.delta_count % 1200 == 0:
                        seq = state.count + 1
                        durable = {'seq':seq,'type':'assistant','payload':{'text':'Stream final '+str(seq)+'\n'+('流'*1200)}}
                        state.extra.append(durable)
                        self.wfile.write(b'data: '+encoded(durable)+b'\n\n')
                        for i in range(max(1, seq-4), seq+1):
                            base = 10000 if state.mode == 'DS3' else 100000
                            duplicate = event(i,state.mode) if i <= base else state.extra[i-base-1]
                            self.wfile.write(b'data: '+encoded(duplicate)+b'\n\n')
                        if state.delta_count == 6000: self.wfile.write(b'data: {"type":"resync","seq":0}\n\n')
                        self.wfile.flush(); state.epoch += 1
                    next_tick += .05 if is_session and state.stream else .2
                    time.sleep(max(0, next_tick-time.monotonic()))
            except (BrokenPipeError,ConnectionResetError): pass
            self.close_connection = True
            return
        return self.reply([])

def manifest(output):
    output.mkdir(parents=True,exist_ok=True)
    for mode,count in [('DS3',10000),('DS4',100000),('REVIEW',420)]:
        digest=hashlib.sha256(); size=0; types={}; maximum=0
        for i in range(1,count+1):
            row=event(i,mode,True); data=encoded(row)+b'\n'; size+=len(data); maximum=max(maximum,len(data)); digest.update(data); types[row['type']]=types.get(row['type'],0)+1
        (output/(mode+'.json')).write_text(json.dumps({'dataset':mode,'events':count,'encodedJsonlBytes':size,'sha256':digest.hexdigest(),'maxEncodedEventBytes':maximum,'types':types,'imageBytes':len(IMAGE),'imageSha256':hashlib.sha256(IMAGE).hexdigest(),'imageDimensions':[1440,2560]},indent=2)+'\n')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=18766); parser.add_argument('--manifest',type=Path)
    args=parser.parse_args()
    if args.manifest: manifest(args.manifest)
    else: ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
