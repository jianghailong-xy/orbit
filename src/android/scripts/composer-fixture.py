#!/usr/bin/env python3
"""A07 loopback contract fixture. Records authenticated requests and accepted state, not a deployment."""
import argparse, hashlib, json, re, socket, threading, time, uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

SESSION='01a0cca7-8609-70ed-a0e2-d4b55b832b60'
CREATED='01a0cca7-8609-70ed-a0e2-d4b55b832b70'
WORKSPACE='01a0cca7-8609-70ed-a0e2-d4b55b832b61'
RUNNER='01a0cca7-8609-70ed-a0e2-d4b55b832b68'
PROJECT='01a0cca7-8609-70ed-a0e2-d4b55b832b69'
def encoded(x): return json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()
class State:
    lock=threading.RLock()
    def __init__(self): self.reset()
    def reset(self):
        self.rows=[]; self.turns={}; self.attachments={}; self.calls=[]; self.attempts={}; self.controls=[]
        self.losses=0; self.uploadFailures=0; self.uploadDelay=0; self.denial=0; self.config={}; self.expired=False; self.rotation=0
        self.status='AWAITING_INPUT'; self.revision=0; self.creations=[]; self.downloads=[]; self.discussion=False
        self.rejectTurnOnce=False
    def detail(self):
        return {'id':SESSION,'title':'Composer conversation','workspaceId':WORKSPACE,'assignedRunnerId':RUNNER,
            'status':self.status,'runState':self.status,'lifecycleState':'OPEN','provider':'codex','model':'fixture-model',
            'permissionMode':'default','effort':'high','capabilities':{'canSend':self.status!='FAILED','canResume':self.status=='FAILED','canComplete':True},
            **({'projectId':PROJECT} if self.discussion else {}),**self.config}
    def stats(self):
        return {'scope':'controlled HTTP fixture; not deployed backend','uniqueTurns':len(self.turns),'attempts':self.attempts,
            'turns':self.turns,'attachments':{k:{a:b for a,b in v.items() if a!='bytes'} for k,v in self.attachments.items()},
            'calls':self.calls,'controls':self.controls,'config':self.config,'rotations':self.rotation,'creations':self.creations,'downloads':self.downloads}
state=State()
class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args): pass
    def reply(self,value,status=200,mime='application/json'):
        data=value if isinstance(value,bytes) else encoded(value)
        self.send_response(status); self.send_header('Content-Type',mime); self.send_header('Content-Length',str(len(data))); self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass
    def authorized(self):
        token='Bearer a07-fixture-access'+str(state.rotation)
        if state.expired or self.headers.get('Authorization')!=token:
            self.reply({'message':'expired'},401); return False
        if state.denial and self.path.startswith('/api/sessions/'):
            self.reply({'message':'permission revoked'},state.denial); return False
        return True
    def do_POST(self): self.mutate('POST')
    def do_PATCH(self): self.mutate('PATCH')
    def do_DELETE(self): self.mutate('DELETE')
    def mutate(self,method):
        url=urlparse(self.path); path=url.path
        raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
        multipart=self.headers.get('Content-Type','').startswith('multipart/')
        body={} if multipart else json.loads(raw or b'{}')
        if path=='/__control':
            with state.lock:
                if body.get('reset'): state.reset()
                for k in ['losses','uploadFailures','uploadDelay','denial','status','expired','discussion','rejectTurnOnce']:
                    if k in body: setattr(state,k,body[k])
            return self.reply({'ok':True})
        if path in ['/api/auth/login','/api/auth/refresh']:
            if path.endswith('refresh'): state.rotation+=1; state.expired=False
            return self.reply({'accessToken':'a07-fixture-access'+str(state.rotation),'refreshToken':'a07-fixture-refresh'+str(state.rotation),
                'user':{'id':'a07-user','email':'a07@example.test','name':'A07'}})
        if path=='/api/auth/logout': return self.reply({})
        if not self.authorized(): return
        state.revision+=1
        state.calls.append({'method':method,'path':self.path,'bodySha256':hashlib.sha256(raw).hexdigest(),
            'body':body if not multipart else {'multipartBytes':len(raw)}})
        if path=='/api/sessions' and method=='POST':
            for field in ['codexAccount','claudeAccount']:
                if field in body and not re.fullmatch(r'default|[0-9a-f]{8}',body[field]):
                    return self.reply({'message':f'{field} must be default or an account id'},400)
            state.creations.append(body); return self.reply({'id':CREATED})
        if path=='/api/attachments':
            time.sleep(state.uploadDelay)
            if state.uploadFailures>0: state.uploadFailures-=1; return self.reply({'message':'injected upload failure'},503)
            msg=BytesParser(policy=default).parsebytes(('Content-Type: '+self.headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
            part=next(p for p in msg.iter_parts() if p.get_param('name',header='content-disposition')=='file')
            data=part.get_payload(decode=True)
            if not data or len(data)>25*1024*1024: return self.reply({'message':'invalid size'},400)
            key=str(uuid.uuid4()); state.attachments[key]={'name':part.get_filename(),'mime':part.get_content_type(),'size':len(data),
                'sha256':hashlib.sha256(data).hexdigest(),'sessionId':parse_qs(url.query).get('sessionId',[None])[0], 'bytes':data,'references':[]}
            return self.reply({'id':key})
        if path.endswith('/turns') and method=='POST' or path.endswith('/resume'):
            key=body['clientTurnId']
            with state.lock:
                state.attempts[key]=state.attempts.get(key,0)+1
                if key in state.turns and state.turns[key]['request']!=body: return self.reply({'message':'same key changed body'},409)
                if key not in state.turns and path.endswith('/turns') and state.rejectTurnOnce:
                    state.rejectTurnOnce=False; state.status='FAILED'
                    return self.reply({'message':'the session has ended'},409)
                if key not in state.turns:
                    turn=str(uuid.uuid4()); state.turns[key]={'turnId':turn,'request':body,'endpoint':path,'kind':'steer' if state.status=='RUNNING' else 'message'}
                    atts=[]
                    for aid in body.get('attachmentIds',[]):
                        att=state.attachments[aid]; att['references'].append(turn)
                        atts.append({'id':aid,'name':att['name'],'mime':att['mime']})
                    state.rows.append({'seq':len(state.rows)+1,'type':'user','turnId':turn,'payload':{'text':body['content'],'attachments':atts}})
                answer=state.turns[key]
                if state.attempts[key]<=state.losses:
                    self.close_connection=True
                    try: self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    return
            return self.reply({'turnId':answer['turnId'],'status':'PENDING','kind':answer['kind']})
        if path.endswith('/config') or path.endswith('/account'):
            state.config.update(body); return self.reply({'ok':True})
        if path.endswith('/interrupt'):
            state.status='AWAITING_INPUT'; state.controls.append({'action':'interrupt'}); return self.reply({'ok':True})
        if '/turns/' in path and method=='DELETE':
            turn=path.split('/')[-1]; state.controls.append({'action':'withdraw','turnId':turn})
            state.turns={k:v for k,v in state.turns.items() if v['turnId']!=turn}; return self.reply({'ok':True})
        if path.endswith('/retry-message') or path.endswith('/auto-retry'):
            state.controls.append({'action':path.split('/')[-1],'method':method}); return self.reply({'turnId':'retry-turn'})
        return self.reply({'message':'unsupported path'},404)
    def do_GET(self):
        url=urlparse(self.path); path=url.path
        if path=='/__stats': return self.reply(state.stats())
        if not self.authorized(): return
        if path=='/api/events' or path in [f'/api/sessions/{SESSION}/events',f'/api/sessions/{CREATED}/events']:
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            try:
                revision=-1; last_seq=0
                for i in range(120):
                    if path!='/api/events':
                        for row in list(state.rows):
                            if row['seq']>last_seq:
                                self.wfile.write(b'data: '+encoded(row)+b'\n\n'); last_seq=row['seq']
                    value={'type':'session.updated','sessionId':SESSION,'data':{}} if path=='/api/events' and revision!=state.revision else {'type':'ping','seq':9007199254740991,'payload':{}}
                    revision=state.revision
                    self.wfile.write(b'data: '+encoded(value)+b'\n\n'); self.wfile.flush(); time.sleep(1)
            except (BrokenPipeError,ConnectionResetError): pass
            self.close_connection=True; return
        if path=='/api/workspaces': return self.reply([{'id':WORKSPACE,'name':'Composer fixture','runnerId':RUNNER,'enabled':True}])
        if path==f'/api/workspaces/{WORKSPACE}': return self.reply({'id':WORKSPACE,'name':'Composer fixture','runnerId':RUNNER,'provider':'codex','model':'fixture-model'})
        if path=='/api/sessions': return self.reply([state.detail()] if parse_qs(url.query).get('view',['open'])[0]=='open' else [])
        if path==f'/api/sessions/{SESSION}': return self.reply(state.detail())
        if path==f'/api/sessions/{CREATED}': return self.reply({**state.detail(),'id':CREATED,'title':'Created conversation'})
        if path.endswith('/events/page'): return self.reply({'events':state.rows[-200:],'hasMore':False})
        if path.endswith('/turns'): return self.reply([{'id':v['turnId'],'turnId':v['turnId'],'content':v['request']['content'],'kind':v['kind']} for v in state.turns.values() if v['kind']!='steer'])
        if path.endswith('/retry-message'): return self.reply({'text':'last failed message'})
        if path.startswith('/api/attachments/'):
            att=state.attachments.get(path.split('/')[-1])
            if att: state.downloads.append({'path':path,'sha256':att['sha256']})
            return self.reply(att['bytes'],mime=att['mime']) if att else self.reply({},404)
        if path=='/api/runners': return self.reply([{'id':RUNNER,'name':'Fixture runner','online':True,'runsAsRoot':False,'capabilities':['codex-account-move/v1'],
            'planUsage':{'codex':{'primary':{'utilization':23},'secondary':{'utilization':42},'fetchedAt':'2026-10-04T00:00:00Z','accounts':{'1a2b3c4d':{'primary':{'utilization':71}}}},'claude':{'primary':{'utilization':11}}},
            'modelCatalog':{'codex':[{'value':'fixture-model','label':'Fixture One','reasoningLevels':['low','high'],'serviceTiers':['priority'],'permissionModes':['default','plan']},{'value':'fixture-model-2','label':'Fixture Two'}],'claude':[{'value':'claude-model','label':'Claude model'}]},
            'engines':[{'engine':'codex','installed':True,'auth':'yes','accounts':[{'id':'default','name':'Default','auth':'yes'},{'id':'1a2b3c4d','name':'Second account','auth':'yes'},{'id':'deadbeef','name':'Expired account','auth':'no'}]}, {'engine':'claude','installed':True,'auth':'yes','accounts':[{'id':'default','name':'Default','auth':'yes'},{'id':'abcd1234','name':'Claude account','auth':'yes'}]}]}])
        if path=='/api/providers': return self.reply([{'slug':'custom-codex','label':'Custom account','runtime':'codex','models':[{'value':'custom-model','label':'Custom model'}]}])
        if path==f'/api/projects/{PROJECT}': return self.reply({'id':PROJECT,'title':'Composer discussion','acceptanceCriteriaItems':[{'ordinal':0,'text':'Keep the discussion draft'}]})
        if path==f'/api/projects/{PROJECT}/acceptance/confirmation': return self.reply({'state':'UNCONFIRMED','currentVersion':{'digest':'fixture-criteria-seal'}})
        if path.endswith('/confirmation-under-review'): return self.reply(None)
        return self.reply([])
if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--port',type=int,default=18767); p.add_argument('--manifest'); a=p.parse_args()
    if a.manifest:
        Path(a.manifest).mkdir(parents=True,exist_ok=True); Path(a.manifest,'scope.json').write_text(json.dumps({'scope':'A07 controlled HTTP','session':SESSION,'workspace':WORKSPACE,'fixtureSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})); raise SystemExit
    ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
