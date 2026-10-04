#!/usr/bin/env python3
"""A08 controlled HTTP authority. Uses the shared/OrbitKit corpus, never a deployed account.
The journal records requests and the final fixture state independently of button visibility.
"""
import argparse, copy, json, pathlib, socket, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = pathlib.Path(__file__).resolve().parents[3]
CORPUS = json.loads((ROOT / 'src/shared/src/interaction-cards.fixture.json').read_text())
SID, PID, TID = (CORPUS[k] for k in ('sessionId', 'projectId', 'taskId'))
WS = '01a0cca7-8609-70ed-a0e2-d4b55b832b61'
def storage_id(value):
    number = 0
    for char in value: number = number * 62 + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.index(char)
    return str(uuid.UUID(int=number))
def normalize(path):
    for value in (SID, PID, TID): path = path.replace(storage_id(value), value)
    return path
LOCK = threading.RLock()
state = {'case': 'a1', 'pending': True, 'denied': False, 'mode': '', 'journal': [], 'final': None}

def snapshot():
    value = copy.deepcopy(CORPUS['snapshot'])
    value['detail'].update(title='Card verification', workspaceId=WS)
    value['approvals'] = [a for a in value['approvals'] if a['id'] == state['case'] and state['pending']]
    stand = value['standing']
    if state['case'] != 'evidence' or not state['pending']: stand['evidenceDecisions']['pending'] = []
    stand['evidenceDecisions']['count'] = len(stand['evidenceDecisions']['pending'])
    if state['case'] != 'owner' or not state['pending']: stand['ownerConfirmation']['waiting'] = None
    if state['case'] != 'criteria' or not state['pending']: stand['criteriaDecisions']['pending'] = []
    if state['case'] != 'acceptance' or not state['pending']: stand['acceptanceConfirmation']['state'] = 'CONFIRMED'
    if state['case'] not in ('acceptance', 'start'): stand['project']['acceptanceCriteriaItems'] = []
    stand['openItems']['needsYou'] = [x for x in stand['openItems']['needsYou'] if x['itemId'] == state['case'] and state['pending']]
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
                if 'case' in body: state.update(case=body['case'], pending=True, denied=False, mode=body.get('mode', ''), final=None)
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
            if state['mode'] in ('lost-response', 'lost-response-pending'):
                row['lostResponse'] = True
                if state['mode'] == 'lost-response-pending': state['pending'] = True # Delayed authority read while the response is lost.
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            return self.reply(result)
    do_PATCH = do_POST
    def do_GET(self):
        url = urlparse(self.path); path = normalize(url.path); query = parse_qs(url.query)
        if path == '/__stats': return self.reply(copy.deepcopy(state))
        if path == '/__corpus': return self.reply(CORPUS)
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        if state['denied'] and path.startswith('/api/sessions/' + SID): return self.reply({}, 403)
        value = snapshot(); stand = value['standing']
        if path == '/api/users/me': return self.reply({'id':'a08-user','email':'a08@example.test','name':'A08'})
        if path == '/api/workspaces': return self.reply([{'id':WS,'name':'Card fixture','enabled':True}])
        if path == '/api/sessions': return self.reply([value['detail']] if query.get('view',['open'])[0] == 'open' else [])
        if path == '/api/sessions/' + SID: return self.reply(value['detail'])
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
        if path.endswith('/created-tasks'): return self.reply({'total':0,'running':0,'failed':0,'done':0,'items':[],'projects':[]})
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
