#!/usr/bin/env python3
"""A08 controlled HTTP authority. Uses the shared/OrbitKit corpus, never a deployed account.
The journal records requests and the final fixture state independently of button visibility.
"""
import argparse, copy, json, pathlib, socket, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = pathlib.Path(__file__).resolve().parents[3]
CORPUS = json.loads((ROOT / 'src/shared/src/interaction-cards.fixture.json').read_text())
REVIEW = json.loads((ROOT / 'src/shared/src/interaction-cards-review.fixture.json').read_text())
OWNER_REVIEW = json.loads((ROOT / 'src/shared/src/owner-confirmation-review.fixture.json').read_text())
SID, PID, TID = (CORPUS[k] for k in ('sessionId', 'projectId', 'taskId'))
WS = '01a0cca7-8609-70ed-a0e2-d4b55b832b61'
# A08c cases beside the shared corpus: what the cards the corpus has no case for read from the server.
S2 = '34ZaIKKTQq8IdW0pn90xJ' # A second open session that needs you (the cross-session bar).
SECOND = {'id': S2, 'title': 'Second fixture session', 'workspaceId': WS, 'status': 'AWAITING_INPUT', 'runState': 'AWAITING_INPUT',
    'lifecycleState': 'OPEN', 'pendingApprovals': 1, 'agent': {'id': WS, 'name': 'Card fixture'}, 'lastTurnAt': '2026-10-04T00:00:00.000Z',
    'capabilities': CORPUS['snapshot']['detail']['capabilities']}
MERGE_CHECK = {'id': 'a9', 'sessionId': SID, 'toolName': 'orbit_project_update_integration', 'toolUseId': 'tool-a9', 'status': 'PENDING',
    'createdAt': '2026-10-04T00:00:00.000Z', 'input': {'projectId': PID, 'projectTitle': 'Card fixture project', # As mcp.go's projectMergeCheckCard files it.
    'currentMergeCheckCommand': './verify', 'currentMergeCheckTimeoutSeconds': None, 'mergeCheckCommand': 'npm test'}}
# The shared bar case for a confirmation the review found problems in afterwards: its receipt offers Reopen task.
RECEIPT_REVIEW = next(b['review'] for b in OWNER_REVIEW['bars'] if b['case'].startswith('you confirmed first, the review came later'))
DECISION = {'id': 'decision1', 'requestId': 'owner1', 'sessionId': SID, 'decision': 'CONFIRM', 'note': None, 'answers': [],
    'decidedAt': '2026-10-02T15:00:00.000Z', 'report': {'text': 'Here is the exact report.', 'reportedAt': '2026-10-02T14:50:00.000Z'},
    'review': RECEIPT_REVIEW}
REPLY = {'requestId': 'req1', 'outcome': 'REPLIED', 'fromSessionId': 's-asked', 'fromTitle': 'Session list performance',
    'requestPreview': 'Run one more read-only probe', 'replyText': 'All probes ran read-only', 'closedAt': '2026-10-06T09:40:00.000Z'}
QUEUE = [
    {'turnId': '01a0cca7-8609-70ed-a0e2-d4b55b832b70', 'kind': 'message', 'content': 'Check the second log before you answer', 'attachments': []},
    {'turnId': '01a0cca7-8609-70ed-a0e2-d4b55b832b71', 'kind': 'steer', 'content': 'Also look at the retry counter', 'attachments': []},
    {'turnId': '01a0cca7-8609-70ed-a0e2-d4b55b832b72', 'kind': 'message', 'content': '<orbit-session-reply request-id="req1">\nAll probes ran read-only\n</orbit-session-reply>',
     'attachments': [], 'sessionReplies': [REPLY], 'authoredByOrbit': True}]
REFUSED = {'status': 'FAILED', 'runState': 'FAILED', 'runStatus': 'FAILED', 'sourceState': 'REFUSED', 'sourceRefusalCode': 'BASE_REF_NOT_FOUND',
    'sourceRefusalDetail': {'fixAction': 'FIX_REF', 'ref': 'refs/heads/project/' + PID,
        'stderr': "git: fatal: couldn't find remote ref refs/heads/project/" + PID}}
CREATED = {'total': 3, 'running': 1, 'failed': 1, 'done': 1, 'projects': [], 'items': [
    {'id': '34ZaIKb2sLBtndX7DqxH1', 'title': 'Wire the drain watchdog', 'status': 'IN_PROGRESS', 'running': True, 'queued': False,
     'createdAt': '2026-10-09T08:00:00.000Z', 'projectId': PID, 'replaces': None},
    {'id': '34ZaIKb2sLBtndX7DqxH2', 'title': 'Fix the flaky reconnect spec', 'status': 'FAILED', 'running': False, 'queued': False,
     'createdAt': '2026-10-09T07:00:00.000Z', 'projectId': PID, 'replaces': {'id': '34ZaIKb2sLBtndX7DqxH0', 'title': 'Reconnect spec, first try'}},
    {'id': '34ZaIKb2sLBtndX7DqxH3', 'title': 'Write the release note', 'status': 'DONE', 'running': False, 'queued': False,
     'createdAt': '2026-10-08T07:00:00.000Z', 'projectId': PID, 'replaces': None}]}
# The block the control plane writes for a failed watch job (OrbitKit BackgroundWakeTests' shape), with a longer output tail.
WAKE = ('<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n'
    '    bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169\n      ended｜failed｜exit code 1\n'
    '      output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–350697\n      output tail:\n'
    '        Run npm test\n        FAIL src/sessions/reply.spec.ts\n        keeps the reply with its request (31 ms)\n'
    '        Tests: 1 failed, 212 passed\n        X Process completed with exit code 1.\n'
    '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; '
    'pass sinceOffset to read only what is new.\n</background-job-wake>')
def storage_id(value):
    number = 0
    for char in value: number = number * 62 + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.index(char)
    return str(uuid.UUID(int=number))
def normalize(path):
    for value in (SID, PID, TID, S2): path = path.replace(storage_id(value), value)
    return path
LOCK = threading.RLock()
state = {'case': 'a1', 'pending': True, 'denied': False, 'mode': '', 'assignment': None, 'journal': [], 'final': None, 'cancelled': []}

def snapshot():
    value = copy.deepcopy(CORPUS['snapshot'])
    value['detail'].update(title='Card verification', workspaceId=WS)
    if state['case'] == 'run-start': value['detail'].update(REFUSED)
    value['approvals'] = [a for a in value['approvals'] + [MERGE_CHECK] if a['id'] == state['case'] and state['pending']]
    for approval in value['approvals']:
        if approval['id'] == 'a4':
            if state['mode'] == 'single-preview': approval['input']['preview'] = copy.deepcopy(REVIEW['taskCreatePreview'])
            elif state['mode'] == 'single-no-preview': approval['input']['listTitle'] = 'Legacy list'
            elif state['mode'] == 'single-no-lists': approval['input']['preview'] = dict(REVIEW['taskCreatePreview'], lists=[])
    stand = value['standing']
    if state['case'] != 'evidence' or not state['pending']: stand['evidenceDecisions']['pending'] = []
    stand['evidenceDecisions']['count'] = len(stand['evidenceDecisions']['pending'])
    if state['case'] not in ('owner', 'owner-review') or not state['pending']: stand['ownerConfirmation']['waiting'] = None
    elif state['case'] == 'owner-review': stand['ownerConfirmation']['waiting']['review']['review']['needsYou'] = copy.deepcopy(REVIEW['reviewQuestions'])
    if state['case'] == 'owner-receipt':
        # Confirmed, then the review found a problem; the task settled DONE until Reopen task is recorded.
        stand['ownerConfirmation'].update(status='DONE' if state['pending'] else 'OPEN', decisions=[copy.deepcopy(DECISION)])
    if state['case'] != 'criteria' or not state['pending']: stand['criteriaDecisions']['pending'] = []
    if state['case'] != 'acceptance' or not state['pending']: stand['acceptanceConfirmation']['state'] = 'CONFIRMED'
    if state['case'] not in ('acceptance', 'start'): stand['project']['acceptanceCriteriaItems'] = []
    stand['openItems']['needsYou'] = [x for x in stand['openItems']['needsYou'] if x['itemId'] == state['case'] and state['pending']]
    if state['assignment'] is not None and state['pending']:
        item = next(x for x in CORPUS['snapshot']['standing']['openItems']['needsYou'] if x['itemId'] == 'x1')
        item = dict(item, **REVIEW['exceptionAssignmentChanges'][state['assignment']])
        stand['openItems']['needsYou'] = [item] if item['assignee'] == 'OWNER' else []
        stand['openItems']['withCoordinator'] = [item] if item['assignee'] == 'COORDINATOR' else []
    stand['openItems']['startRequest'] = CORPUS['startItem'] if state['case'] == 'start' and state['pending'] else None
    if state['case'] != 'promotion': stand['promotion'] = None
    elif not state['pending']: stand['promotion']['state'] = 'CONFIRMED'
    return value

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, body, code=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        path = normalize(urlparse(self.path).path)
        if path == '/__control':
            with LOCK:
                if 'case' in body: state.update(case=body['case'], pending=True, denied=False, mode=body.get('mode', ''), assignment=0 if body.get('mode', '').startswith('assignment-') else None, final=None, cancelled=[])
                if 'assignment' in body: state['assignment'] = body['assignment']
                if 'mode' in body: state['mode'] = body['mode']
                if 'pending' in body: state['pending'] = body['pending']
                if 'denied' in body: state['denied'] = body['denied']
            return self.reply({'ok': True})
        if path in ('/api/auth/login', '/api/auth/refresh'):
            return self.reply({'accessToken':'a08-fixture-access','refreshToken':'a08-fixture-refresh','user':{'id':'a08-user','email':'a08@example.test','name':'A08'}})
        if path == '/api/auth/logout': return self.reply({})
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        with LOCK:
            row = {'method': self.command, 'path': path, 'body': body, 'case': state['case']}
            state['journal'].append(row)
            if state['mode'] == 'forbidden':
                state['denied'] = True; row['status'] = 403
                return self.reply({'message':'Permission denied'}, 403)
            if not state['pending']:
                row['status'] = 409
                return self.reply({'code':'ALREADY_HANDLED','requiredAction':'Read the current record.'}, 409)
            state['pending'] = False
            if state['case'].startswith('a') and state['case'] != 'acceptance':
                result = {'id':state['case'],'status': 'DENIED' if state['mode'] == 'other-end' or body.get('behavior') == 'deny' else 'ALLOWED'}
            elif state['case'] == 'promotion': result = {'state':'CONFIRMED','sourceSha':body.get('sourceSha')}
            else: result = {'recorded': True, 'decision':body.get('decision'), 'requestId':body.get('requestId')}
            state['final'] = result; row['final'] = result; row['status'] = 200
            if state['assignment'] is not None and path.endswith('/return-to-coordinator'):
                returned = REVIEW['exceptionAssignmentChanges'][state['assignment'] + 1]
                result = {'itemId':'x1', 'assignee':'COORDINATOR', 'waitingSince':returned['waitingSince'], 'escalateAt':returned['escalateAt']}
                state['final'] = result; row['final'] = result
                state['pending'] = True # Delayed standing read; control advances the committed assignment, then its escalation.
            elif state['case'] == 'queue' and self.command == 'DELETE' and '/turns/' in path:
                state['cancelled'].append(path.rsplit('/', 1)[1]) # Withdrawn: the next queue read no longer lists it.
            elif state['assignment'] is not None and path.endswith('/resolve'):
                result = {'itemId':'x1', 'state':'RESOLVED', 'resolution':'HANDLED'}
                state['final'] = result; row['final'] = result
            if state['mode'] in ('lost-response', 'lost-response-pending', 'assignment-lost'):
                row['lostResponse'] = True
                if state['mode'] == 'lost-response-pending': state['pending'] = True # Delayed authority read while the response is lost.
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            return self.reply(result)
    do_PATCH = do_POST
    do_DELETE = do_POST
    def do_GET(self):
        url = urlparse(self.path); path = normalize(url.path); query = parse_qs(url.query)
        if path == '/__stats': return self.reply(copy.deepcopy(state))
        if path == '/__corpus': return self.reply(CORPUS)
        if path == '/__review-corpus': return self.reply(REVIEW)
        if path == '/__a08c': return self.reply({'secondSession': SECOND, 'mergeCheck': MERGE_CHECK, 'decision': DECISION, 'queue': QUEUE,
            'refused': REFUSED, 'created': CREATED, 'wake': WAKE})
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        if state['denied'] and path.startswith('/api/sessions/' + SID): return self.reply({}, 403)
        value = snapshot(); stand = value['standing']
        if path == '/api/users/me': return self.reply({'id':'a08-user','email':'a08@example.test','name':'A08'})
        if path == '/api/workspaces': return self.reply([{'id':WS,'name':'Card fixture','enabled':True}])
        if path == '/api/sessions':
            if query.get('view',['open'])[0] != 'open': return self.reply([])
            return self.reply([value['detail']] + ([SECOND] if state['mode'] == 'elsewhere' else []))
        if path == '/api/sessions/' + SID: return self.reply(value['detail'])
        if path.startswith('/api/sessions/' + S2):
            # The session the bar takes you to: its own words and the approval it waits on.
            if path == '/api/sessions/' + S2: return self.reply(SECOND)
            if path.endswith('/events/page'):
                return self.reply({'events':[{'seq':1,'type':'user','payload':{'text':'Deploy the second fixture'}},{'seq':2,'type':'assistant','payload':{'text':'The second session waits on you.'}}],'hasMore':False,'after':None})
            if path.endswith('/approvals'):
                return self.reply([dict(a, id='b1', sessionId=S2) for a in CORPUS['snapshot']['approvals'] if a['id'] == 'a1'])
            if not path.endswith('/events'): return self.reply([])
        if path == '/api/sessions/' + SID + '/turns' and state['case'] == 'queue':
            return self.reply([turn for turn in QUEUE if turn['turnId'] not in state['cancelled']])
        if path.endswith('/events/page') and state['case'] == 'wake':
            return self.reply({'events':[{'seq':1,'type':'user','payload':{'text':WAKE,'controlPlaneNote':WAKE}},{'seq':2,'type':'assistant','payload':{'text':'Review the Orbit card below.'}},{'seq':3,'type':'turn_end','payload':{}}], 'hasMore':False,'after':None})
        if path.endswith('/events/page'):
            attachment_only = {'text':'','attachments':[{'id':'01a0cca7-8609-70ed-a0e2-d4b55b832b65','mime':'text/plain','name':'card-notes.txt'}]}
            return self.reply({'events':[{'seq':1,'type':'user','payload':attachment_only if state['case'] == 'attachment-only' else {'text':'Controlled card verification'}},{'seq':2,'type':'assistant','payload':{'text':'Review the Orbit card below.'}},{'seq':3,'type':'turn_end','payload':{}}], 'hasMore':False,'after':None})
        if path.endswith('/approvals'): return self.reply(value['approvals'])
        if path == '/api/tasks/evidence-decisions/pending': return self.reply(stand['evidenceDecisions'])
        if path == '/api/tasks/' + TID + '/owner-confirmation': return self.reply(stand['ownerConfirmation'])
        project_paths = {'':'project','/acceptance/criteria-decisions/pending':'criteriaDecisions','/acceptance/confirmation':'acceptanceConfirmation','/open-items':'openItems','/promotions/current':'promotion'}
        for suffix, key in project_paths.items():
            if path == '/api/projects/' + PID + suffix: return self.reply(stand[key])
        if path.endswith('/dependency-graph'): return self.reply({'taskCount':1,'truncated':False,'marks':[{'kind':'TASK','id':TID,'taskId':TID,'title':'Check cards','status':'OPEN'}],'edges':[]})
        if path.endswith('/created-tasks'): return self.reply(CREATED if state['case'] == 'created' else {'total':0,'running':0,'failed':0,'done':0,'items':[],'projects':[]})
        if path.endswith('/events'):
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            try:
                while True:
                    self.wfile.write(b': keepalive\n\n'); self.wfile.flush(); time.sleep(1)
            except (BrokenPipeError, ConnectionResetError): pass
            return
        self.reply([])

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=18768); args=parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
