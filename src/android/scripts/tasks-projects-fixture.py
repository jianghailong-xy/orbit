#!/usr/bin/env python3
"""A11 controlled HTTP fixture; source contracts, not a real cross-client account.

Cards are inherited from the shared A08 corpus. /__stats exposes requests and final
resource records independently of UI assertions; /__control changes authority.
No production URL, credentials, Docker or device operation is used here.
"""
import argparse
import base64
import copy
import importlib.util
import io
import json
import pathlib
import socket
import time
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

spec = importlib.util.spec_from_file_location('cards_fixture', pathlib.Path(__file__).with_name('cards-fixture.py'))
cards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cards)
SID, PID, TID, WS = cards.SID, cards.PID, cards.TID, cards.WS
OUTSIDE, PREREQUISITE, LIST, PROJECT_PREREQUISITE = ['34ZaIKb2sLBtndX7DqxH' + end for end in ('H', 'I', 'J', 'K')]
IDS = dict(session=SID, project=PID, task=TID, outside=OUTSIDE, prerequisite=PREREQUISITE, list=LIST, projectPrerequisite=PROJECT_PREREQUISITE, workspace=WS)
NOW = '2026-10-05T00:00:00.000Z'
LOCK, state = cards.LOCK, cards.state
original_snapshot = cards.snapshot
original_normalize = cards.normalize


def normalize(path):
    path = original_normalize(path)
    for value in (OUTSIDE, PREREQUISITE, LIST, PROJECT_PREREQUISITE):
        path = path.replace(cards.storage_id(value), value)
    return path


cards.normalize = normalize


def task(identifier, title, project=None, status='OPEN', labels=None):
    return dict(id=identifier, title=title, description='A controlled **task description** with a [project](orbit-project:' + PID + ').',
                status=status, projectId=project, project=None, listId=LIST, assigneeId=WS,
                assignee=dict(id=WS, name='A11 workspace', runner=dict(id='fixture-runner')),
                list=dict(id=LIST, title='A11 release checklist'), provider='codex', model='gpt-6-astra',
                completionCriterion='EVIDENCE_JUDGMENT', completionPolicy='MANUAL', acceptanceCriteria='The source contract is checked.',
                acceptanceCommand=None, acceptanceExpectedExitCode=None, verifiesTaskId=None, verificationState=None,
                verifier=None, supersededByTaskId=None, terminalReason=None, running=False, queued=False,
                runnable=status == 'OPEN', blocked=False, dependencyState='NONE', autoRunWhenReady=False,
                runAt=None, priority=0, labels=labels or ['Mobile'], createdAt=NOW, updatedAt=NOW,
                creatorSessionId=SID, creatorType='USER', creatorId='a08-user', creatorAgent=None,
                attachments=[], sessions=[], comments=[], dependsOn=[], dependedOnBy=[], _count=dict(comments=0, sessions=0, subtasks=0),
                awaitingOwnerConfirmation=False, confirmationUnderReview=False, modelHint=None, modelHintOptions=[])


def reset():
    old_journal = state.get('journal', [])
    generation = state.get('generation', 0) + 1
    state.update(case='normal', pending=True, denied=False, mode='', assignment=None, final=None,
                 denyTasks=False, denyProjects=False, readError=False, generation=generation, journal=old_journal,
                 runTriggers={}, mutations=0, streamDown=False)
    state.update(shares={}, watches=[], attachments={})
    state['tasks'] = {
        OUTSIDE: task(OUTSIDE, 'A11 task checklist', labels=['Mobile', 'Sprint, one']),
        PREREQUISITE: task(PREREQUISITE, 'A11 prerequisite', status='DONE', labels=['Mobile']),
        TID: task(TID, 'A11 project delivery', PID, labels=['Release']),
        PROJECT_PREREQUISITE: task(PROJECT_PREREQUISITE, 'A11 project prerequisite', PID, status='DONE', labels=['Release']),
    }
    state['tasks'][TID]['project'] = dict(id=PID, title='A11 Android launch', status='OPEN')
    state['tasks'][TID]['sessions'] = [dict(id=SID, title='A11 coordinator review', runState='AWAITING_INPUT', lifecycleState='OPEN', status='AWAITING_INPUT', provider='codex', model='gpt-6-astra', createdAt=NOW)]
    state['tasks'][TID]['dependsOn'] = [dict(taskId=TID, dependsOnTaskId=PROJECT_PREREQUISITE, dependsOnTask=dict(id=PROJECT_PREREQUISITE, title='A11 project prerequisite', status='DONE'))]
    state['tasks'][TID]['dependencyState'] = 'READY'
    state['tasks'][PROJECT_PREREQUISITE]['dependedOnBy'] = [dict(taskId=TID, dependsOnTaskId=PROJECT_PREREQUISITE, task=dict(id=TID, title='A11 project delivery', status='OPEN'))]
    state['lists'] = {LIST: dict(id=LIST, title='A11 release checklist', instructions='Follow the checked plan.', paused=False,
                               maxConcurrent=2, createdAt=NOW, updatedAt=NOW, _count=dict(tasks=4), tasksOutsideProjects=2,
                               runningTasks=0, completedTasks=2, failedTasks=0, doneCount=2, taskCount=4)}
    project = copy.deepcopy(cards.CORPUS['snapshot']['standing']['project'])
    project.update(title='A11 Android launch', goal='Ship **Tasks and Projects** with server authority.', instructions='Keep review decisions in their original conversation.',
                   startedAt=NOW, pausedAt=None, pauseReason=None, configRevision='1', maxConcurrentTasks=2, automatic=True,
                   coordinatorEnabled=True, coordinatorAgentId=WS, createdAt=NOW, updatedAt=NOW, lastActivityAt=NOW,
                   _count=dict(tasks=2), blockers=dict(open=[], resolved=[], resolvedCount=0), criteriaConfirmed=True)
    for criterion in project['acceptanceCriteriaItems']:
        criterion.update(key='cards', satisfied=False, landing='NONE', taskCount=1, doneCount=0, unmet=[dict(taskId=TID, title='A11 project delivery', status='OPEN')], heldUpBy=[], definitionId=criterion['id'])
    state['project'] = project
    state['integration'] = dict(line='PROJECT_BRANCH', lineAbsentReason=None, ref='project/a11', upstreamRef='main', source='EXPLICIT',
                                locked=False, startedAt=None, mergeCheckCommand='true', mergeCheckCommandAbsentReason=None,
                                mergeCheckTimeoutSeconds=600, escalationSeconds=3600, commitsAheadOfUpstream=1,
                                commitsAheadOfUpstreamAbsentReason=None, lastUpstreamSyncAt=NOW, lastUpstreamSyncAbsentReason=None,
                                integratingCount=0, queuedCount=0, mergeCheckOnTip='UNKNOWN', inFlight=None, landTasks=[])


def bump(resource=None):
    state['mutations'] += 1
    state['generation'] += 1
    if resource is not None:
        resource['updatedAt'] = f'2026-10-05T00:00:{state["mutations"] % 60:02d}.000Z'


def snapshot():
    value = original_snapshot()
    value['detail'].update(title='A11 coordinator review', workspaceId=WS)
    value['standing']['project'] = copy.deepcopy(state['project'])
    if state['case'] in ('start', 'own-start'):
        value['standing']['project']['startedAt'] = None
    view = value['standing']['ownerConfirmation']
    view.update(title=state['tasks'].get(TID, {}).get('title', 'A11 project delivery'))
    if state['case'] not in ('owner', 'owner-review'):
        view.update(completionCriterion='EVIDENCE_JUDGMENT', waiting=None)
    if state['mode'] == 'unknown':
        value['standing']['openItems']['needsYou'].append(dict(itemId='future-item', kind='FUTURE_ACTION', title='New server item',
            detailLine='Read the current server details.', assignee='OWNER', assigneeReason='DEFAULT', waitingSince=NOW,
            actions=['FUTURE_DECISION'], taskId=None, sessionId=None, question=None, facts=None))
    return value


cards.snapshot = snapshot
reset()


def counts(rows):
    result = {name: sum(row['status'] == status for row in rows) for name, status in (
        ('open', 'OPEN'), ('inProgress', 'IN_PROGRESS'), ('done', 'DONE'), ('failed', 'FAILED'), ('cancelled', 'CANCELLED'))}
    result.update(total=len(rows), running=sum(row['running'] for row in rows), queued=sum(row['queued'] for row in rows),
                  runnable=sum(row['runnable'] for row in rows), inProjects=dict(tasks=sum(r['projectId'] is not None for r in state['tasks'].values()), projects=1))
    return result


def scoped(query, filtered=False):
    rows = list(state['tasks'].values())
    for key in ('projectId', 'listId', 'assigneeId', 'creatorSessionId'):
        if key in query:
            expected = query[key][0]
            rows = [row for row in rows if (row.get(key) is None if expected == 'none' else row.get(key) == expected)]
    rows = [row for row in rows if all(label in row['labels'] for label in query.get('labels', []))]
    if filtered:
        status = query.get('status', [''])[0]
        if status == 'RUNNABLE': rows = [r for r in rows if r['runnable']]
        elif status == 'RUNNING': rows = [r for r in rows if r['running'] or r['queued']]
        elif status == 'ONGOING': rows = [r for r in rows if r['status'] in ('OPEN', 'IN_PROGRESS')]
        elif status: rows = [r for r in rows if r['status'] == status]
        term = query.get('q', [''])[0].lower()
        if term: rows = [r for r in rows if term in (r['title'] + ' ' + r['description']).lower()]
    return copy.deepcopy(rows)


def graph(project=False, focus=None):
    rows = [r for r in state['tasks'].values() if r['projectId'] == PID] if project else list(state['tasks'].values())
    if not project:
        connected = {focus}
        while True:
            before = len(connected)
            for row in rows:
                for edge in row['dependsOn']:
                    if row['id'] in connected or edge['dependsOnTaskId'] in connected:
                        connected.update((row['id'], edge['dependsOnTaskId']))
            if len(connected) == before: break
        rows = [row for row in rows if row['id'] in connected]
    ids = {r['id'] for r in rows}
    edges = [dict(sourceTaskId=e['dependsOnTaskId'], targetTaskId=r['id']) for r in rows for e in r['dependsOn'] if e['dependsOnTaskId'] in ids]
    if project:
        return dict(projectId=PID, taskCount=len(rows), edgeCount=len(edges), truncated=False,
                    marks=[dict(kind='TASK', id=r['id'], taskId=r['id'], title=r['title'], status=r['status'], running=r['running'], queued=r['queued'], taskCount=1,
                                statusCounts={r['status']: 1}, members=[], samples=[], expandable=False) for r in rows],
                    edges=[dict(sourceMarkId=e['sourceTaskId'], targetMarkId=e['targetTaskId']) for e in edges])
    return dict(focusTaskId=focus, nodes=[dict(id=r['id'], title=r['title'], status=r['status'], depth=0 if r['id'] == focus else 1,
                                             running=r['running'], queued=r['queued']) for r in rows], edges=edges, truncated=False,
                counts=dict(upstream=len(state['tasks'][focus]['dependsOn']), downstream=len(state['tasks'][focus]['dependedOnBy'])))


def project_buckets():
    rows = [r for r in state['tasks'].values() if r['projectId'] == PID]
    return dict(running=sum(r['running'] for r in rows), ready=sum(r['runnable'] for r in rows), blocked=sum(r['blocked'] for r in rows),
                awaitingVerification=0, done=sum(r['status'] == 'DONE' for r in rows), failed=sum(r['status'] == 'FAILED' for r in rows),
                cancelled=sum(r['status'] == 'CANCELLED' for r in rows), integrating=0, onIntegrationLine=0, onUpstream=0, doneNotIntegrated=0, waitingForLanding=0)


def project_row(row):
    # The project page's row, with the work fields the server derives (`ProjectTaskRow`).
    work = 'RUNNING' if row['running'] or row['queued'] else 'READY' if row['runnable'] else row['status'] if row['status'] in ('DONE', 'FAILED', 'CANCELLED') else 'BLOCKED'
    blocks = sum(1 for other in state['tasks'].values() for edge in other['dependsOn'] if edge['dependsOnTaskId'] == row['id'])
    unmet = sum(1 for edge in row['dependsOn'] if edge['dependsOnTask']['status'] != 'DONE')
    return dict(row, workState=work, topoLevel=1 if row['dependsOn'] else 0, unmetCount=unmet, blocksCount=blocks, landingWaitCount=0, integration=None)


class Handler(cards.Handler):
    def reply(self, body, code=200):
        if getattr(self, '_journal_row', None) is not None:
            self._journal_row['status'] = code
        return super().reply(body, code)

    def journal(self, path, query=None, body=None):
        self._journal_row = dict(method=self.command, path=path, case=state['case'], query=query or {}, body=body)
        state['journal'].append(self._journal_row)

    def do_GET(self):
        self._journal_row = None
        url = urlparse(self.path)
        path, query = normalize(url.path), parse_qs(url.query)
        if path == '/__ids': return self.reply(IDS)
        if path == '/__stats':
            with LOCK: return self.reply(copy.deepcopy(state))
        if not path.startswith('/api/'): return super().do_GET()
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        if path == '/api/events':
            if state.get('streamDown'): return self.reply(dict(message='Controlled stream outage'), 503)
            return self.control_stream()
        with LOCK:
            self.journal(path, query)
            if state['readError'] and (path.startswith('/api/tasks') or path.startswith('/api/projects')):
                return self.reply(dict(message='Controlled read failure'), 503)
            if state['denyTasks'] and path.startswith('/api/tasks/') and path != '/api/tasks/evidence-decisions/pending':
                return self.reply(dict(message='Permission denied'), 403)
            if state['denyProjects'] and path.startswith('/api/projects/'):
                return self.reply(dict(message='Permission denied'), 403)
            if path == '/api/workspaces': return self.reply([dict(id=WS, name='A11 workspace', enabled=True, runnerId='fixture-runner', workDir='/fixture', lastProvider='codex')])
            if path == '/api/runners': return self.reply([dict(id='fixture-runner', name='A11 fixture runner', status='ONLINE')])
            if path == '/api/runners/fixture-runner': return self.reply(dict(id='fixture-runner', name='A11 fixture runner', status='ONLINE', supportedProviders=['codex'], modelCatalog={'codex': [dict(value='gpt-6-astra', label='GPT-6 Astra')]}))
            if path == '/api/providers': return self.reply([])
            if path == '/api/watches': return self.reply(state['watches'])
            if path.startswith('/api/watches/'):
                watch = next((w for w in state['watches'] if w['id'] == path.split('/')[-1]), None)
                return self.reply(watch or dict(message='Watch not found'), 200 if watch else 404)
            if path.startswith('/api/attachments/'):
                attachment = state['attachments'].get(path.split('/')[-1])
                if attachment is None: return self.reply(dict(message='Attachment not found'), 404)
                data = base64.b64decode(attachment['data'])
                self._journal_row['status'] = 200
                self.send_response(200); self.send_header('Content-Type', attachment['mimeType']); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
                return
            if path.endswith('/share') and (path.startswith('/api/tasks/') or path.startswith('/api/projects/')):
                return self.reply(dict(link=state['shares'].get(path), counts=dict(tasks=2 if path.startswith('/api/projects/') else 1, comments=0, files=0, runs=1, transcripts=1)))
            if path in ('/api/projects', '/api/projects/sidebar'):
                project = copy.deepcopy(state['project'])
                if state['case'] in ('start', 'own-start'): project['startedAt'] = None
                project.update(buckets=project_buckets(), attention=dict(ownerItems=[], coordinatorItems=None, userBlockers=0, systemBlockers=0, coordinatorBlockers=0),
                               integration=dict(line=state['integration']['line'], activeJobCount=state['integration']['integratingCount'], queuedJobCount=0, commitsAheadOfUpstream=1),
                               coordinatorActivity=dict(working=False, lastTurnAt=NOW))
                return self.reply([project])
            if path == '/api/task-lists': return self.reply(list(state['lists'].values()))
            if path == '/api/task-lists/' + LIST: return self.reply(state['lists'][LIST])
            if path == '/api/tasks/page':
                rows = scoped(query, True)
                start, limit = int(query.get('cursor', ['0'])[0]), min(int(query.get('limit', ['100'])[0]), 200)
                body = dict(items=rows[start:start + limit], nextCursor=str(start + limit) if len(rows) > start + limit else None)
                mode = query.get('counts', ['full'])[0]
                if mode != 'none': body['total'] = len(rows)
                if mode == 'full': body['counts'] = counts(scoped(query))
                return self.reply(body)
            if path == '/api/tasks/counts': return self.reply(counts(scoped(query)))
            if path == '/api/tasks/active':
                rows = [r for r in scoped(query) if r['running'] or r['queued'] or r['status'] in ('IN_PROGRESS', 'FAILED')]
                return self.reply(dict(items=rows, total=len(rows), truncated=False))
            if path == '/api/tasks/labels':
                rows = scoped(query)
                return self.reply(dict(items=[dict(label=label, **{k: v for k, v in counts([r for r in rows if label in r['labels']]).items() if k in ('total', 'open', 'inProgress', 'done', 'failed', 'cancelled')})
                                              for label in sorted({label for r in rows for label in r['labels']})],
                                       labelTotal=len({label for r in rows for label in r['labels']}), truncated=False))
            if path.startswith('/api/tasks/'):
                parts = path.split('/')[3:]
                row = state['tasks'].get(parts[0])
                if row is not None:
                    if len(parts) == 1 or parts[1:] == ['row']: return self.reply(row)
                    if parts[1:] == ['dependency-graph']: return self.reply(graph(focus=parts[0]))
                    if parts[1:] == ['attribution']:
                        return self.reply(dict(taskId=row['id'], owning=dict(projectId=PID, title='A11 Android launch', status=state['project']['status']) if row['projectId'] else None,
                                               owningAbsentReason=None if row['projectId'] else 'FILED_UNDER_NO_PROJECT',
                                               discovery=dict(recorded=False, absentReason='NO_DISCOVERY_RECORDED', project=None, triggerEvent=None, task=None, session=None, authority='EVIDENCE_ONLY'), crossing=None, crossingAbsentReason='NO_CROSSING_DECLARED',
                                               blocker=None, blockerAbsentReason='NOTHING_BLOCKING_ATTRIBUTION'))
                    if parts[1:] == ['owner-confirmation'] and parts[0] != TID:
                        return self.reply(dict(taskId=row['id'], title=row['title'], completionCriterion=row['completionCriterion'], status=row['status'], projectId=row['projectId'],
                                               acceptanceCriteria=row['acceptanceCriteria'], waiting=None, decisions=[], reviewerReturns=[]))
                elif parts[0] != 'evidence-decisions': return self.reply(dict(message='Task not found'), 404)
            if path.startswith('/api/projects/' + PID):
                suffix = path[len('/api/projects/' + PID):]
                if suffix == '/panorama': return self.reply(dict(buckets=project_buckets(), shape=dict(taskCount=2, edgeCount=1)))
                if suffix == '/integration': return self.reply(state['integration'])
                if suffix == '/dependency-graph': return self.reply(graph(project=True))
                if suffix == '/tasks/page': return self.reply(dict(items=[project_row(r) for r in state['tasks'].values() if r['projectId'] == PID], nextCursor=None))
                if suffix == '/panorama/ready':
                    rows = [r for r in state['tasks'].values() if r['projectId'] == PID and (r['runnable'] or r['running'] or r['queued'])]
                    return self.reply(dict(total=len(rows), readyCount=sum(r['runnable'] for r in rows), runningCount=sum(r['running'] for r in rows), queuedCount=sum(r['queued'] for r in rows), pausedCount=0,
                                           items=[dict(taskId=r['id'], title=r['title'], status=r['status'], runState='RUNNING' if r['running'] else 'QUEUED' if r['queued'] else 'READY',
                                                       sessionId=SID if r['running'] or r['queued'] else None, pausedList=None, downstreamBlocked=0) for r in rows], impactTruncated=None))
                if suffix == '/coordinator/status':
                    return self.reply(dict(projectId=PID, readAt=NOW, state='LIVE',
                        coordination=dict(sessionId=SID, session=snapshot()['detail'], coordinatorGeneration='1', workspaceId=WS, workspaceName='A11 workspace', agentName='A11 workspace',
                                          wakeups=dict(state='NONE', at=None), fuse=dict(selfStartedToday=0, limit=10, paused=False, episodeId=None)),
                        openability=dict(canOpen=True, willCreate=False, refusalCode=None, refusalDetail=None, requiredAction=None, landing=dict(workspaceId=WS, workspaceName='A11 workspace'))))
            if path.endswith('/events/page'):
                return self.reply(dict(events=[dict(seq=1, type='user', payload=dict(text='A11 source conversation')),
                                                dict(seq=2, type='assistant', payload=dict(text='[Open A11 task](orbit-task:' + OUTSIDE + ')\n\n[Open A11 project](orbit-project:' + PID + ')\n\nProject work: [A11 project delivery](orbit-task:' + TID + ').')),
                                                dict(seq=3, type='turn_end', payload={})], hasMore=False, after=None))
        return super().do_GET()

    def control_stream(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        previous = state['generation']
        try:
            while not state.get('streamDown'):
                generation = state['generation']
                value = dict(type='task.changed', sessionId=SID, data=dict(taskId=OUTSIDE)) if generation != previous else dict(type='ping')
                self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                self.wfile.flush()
                previous = generation
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError): pass

    def do_POST(self):
        self._journal_row = None
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        url = urlparse(self.path)
        path = normalize(url.path)
        if path == '/api/attachments' and self.command == 'POST': return self.upload(raw, parse_qs(url.query))
        body = json.loads(raw or b'{}')
        if path == '/__control':
            with LOCK:
                if body.get('reset'): reset()
                for key in ('case', 'mode', 'pending', 'denied', 'denyTasks', 'denyProjects', 'readError', 'assignment', 'streamDown'):
                    if key in body: state[key] = body[key]
                if 'case' in body: state['pending'] = body.get('pending', True)
                if 'task' in body:
                    patch = dict(body['task']); identifier = patch.pop('id', OUTSIDE)
                    state['tasks'][identifier].update(patch)
                if 'project' in body: state['project'].update(body['project'])
                if 'integration' in body: state['integration'].update(body['integration'])
                if state['case'] in ('owner', 'owner-review'):
                    state['tasks'][TID].update(completionCriterion='OWNER_CONFIRMED', status='IN_PROGRESS', awaitingOwnerConfirmation=True, runnable=False)
                if body.get('mode') == 'unknown': state['tasks'][OUTSIDE].update(status='FUTURE_STATUS', runnable=False)
                bump()
            return self.reply(dict(ok=True))
        if path.startswith('/api/auth/'):
            return self.delegate_post(raw)
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        with LOCK:
            local = path.startswith('/api/tasks/') and '/owner-confirmation' not in path and '/evidence/' not in path
            local = local or path.startswith('/api/task-lists/') or path in ('/api/projects/' + PID, '/api/projects/' + PID + '/integration',
                '/api/projects/' + PID + '/pause', '/api/projects/' + PID + '/resume', '/api/projects/' + PID + '/coordinator', '/api/projects/' + PID + '/coordinator/replace')
            local = local or (path == '/api/projects/' + PID + '/start' and state['case'] == 'own-start') or path.startswith('/api/projects/' + PID + '/blockers/')
            local = local or path.endswith('/share') or path == '/api/watches' or path.startswith('/api/attachments/')
            if not local: return self.delegate_post(raw)
            self.journal(path, body=body)
            if state['mode'] == 'forbidden' or state['denyTasks'] and path.startswith('/api/tasks/') or state['denyProjects'] and path.startswith('/api/projects/'):
                return self.reply(dict(message='Permission denied'), 403)
            if state['mode'] == 'conflict':
                return self.reply(dict(code='STALE_CONFIG_REVISION' if path.startswith('/api/projects/') else 'TASK_ACTIVE_RUN', message='The resource changed on another client.', requiredAction='Refresh the current record.', sessionId=SID), 409)
            result, code = self.mutate(path, body)
            if code < 400:
                state['final'] = copy.deepcopy(result)
                self._journal_row['final'] = copy.deepcopy(result)
                if state['mode'] == 'lost-response':
                    self._journal_row.update(status=200, lostResponse=True)
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR); self.connection.close()
                    return
            return self.reply(result, code)

    def delegate_post(self, raw):
        original = self.rfile
        self.rfile = io.BytesIO(raw)
        try: return super().do_POST()
        finally: self.rfile = original

    def mutate(self, path, body):
        if path.endswith('/share'):
            link = state['shares'].get(path)
            if self.command == 'DELETE': state['shares'].pop(path, None); bump(); return dict(ok=True), 200
            if self.command != 'PUT': return dict(message='Unsupported share method'), 405
            if link is None:
                link = dict(id='fixture-share', token='a11-controlled-public-token', state='ACTIVE', include=dict(taskPages=True, commentsAndFiles=True, conversations=True, toolOutput=True),
                            expiresAt=None, viewCount=0, lastViewedAt=None, createdAt=NOW, updatedAt=NOW,
                            root=dict(id=path.split('/')[-2], title='Controlled share', status='OPEN'))
            if 'include' in body: link['include'].update(body['include'])
            if 'expiresAt' in body: link['expiresAt'] = body['expiresAt']
            bump(link); state['shares'][path] = link; return link, 200
        if path == '/api/watches':
            existing = next((w for w in state['watches'] if w.get('idempotencyKey') == body.get('idempotencyKey')), None)
            if existing: return existing, 200
            if body.get('action') != 'NOTIFY_USER' or body.get('predicate', {}).get('leaf') not in ('TASK_TERMINAL', 'TASK_DONE', 'TASK_FAILED'):
                return dict(message='Unsupported controlled watch predicate'), 400
            watch = dict(body, id='34ZaIKb2sLBtndX7DqxHL', state='ARMED', createdAt=NOW, updatedAt=NOW, expiresAt='2026-10-06T00:00:00.000Z',
                         lastEvaluatedAt=NOW, triggeredAt=None, failure=None)
            state['watches'].append(watch); bump(); return watch, 200
        if path.startswith('/api/attachments/'):
            identifier = path.split('/')[-1]
            if identifier not in state['attachments']: return dict(message='Attachment not found'), 404
            del state['attachments'][identifier]
            for row in state['tasks'].values(): row['attachments'] = [a for a in row['attachments'] if a['id'] != identifier]
            bump(); return {}, 200
        if path == '/api/task-lists/' + LIST + '/console': return dict(sessionId=SID), 200
        if path == '/api/task-lists/' + LIST:
            state['lists'][LIST].update(body); bump(state['lists'][LIST]); return state['lists'][LIST], 200
        project = state['project']
        if path == '/api/projects/' + PID:
            if self.command == 'DELETE': return dict(code='PROJECT_NOT_EMPTY', message='Project still contains tasks.'), 409
            if any(key in body for key in ('automatic', 'maxConcurrentTasks')):
                if body.get('expectedConfigRevision') != project['configRevision']: return dict(code='STALE_CONFIG_REVISION', message='Reload the project settings.'), 409
                project['configRevision'] = str(int(project['configRevision']) + 1)
            project.update({k: v for k, v in body.items() if k != 'expectedConfigRevision'})
            if body.get('status') == 'DONE' and not all(c.get('satisfied') for c in project['acceptanceCriteriaItems']): project['status'] = 'OPEN'
            if 'automatic' in body: project['coordinatorEnabled'] = body['automatic']
            bump(project); return project, 200
        if path == '/api/projects/' + PID + '/integration':
            if 'line' in body and state['integration']['locked']: return dict(code='INTEGRATION_LINE_LOCKED', message='Integration has started.'), 409
            patch = dict(body)
            if 'exceptionEscalationSeconds' in patch: patch['escalationSeconds'] = patch.pop('exceptionEscalationSeconds')
            state['integration'].update(patch); bump(); return state['integration'], 200
        if path in ('/api/projects/' + PID + '/pause', '/api/projects/' + PID + '/resume'):
            project['pausedAt'] = NOW if path.endswith('/pause') else None
            project['pauseReason'] = 'OWNER' if project['pausedAt'] else None
            bump(project); return dict(projectId=PID, pausedAt=project['pausedAt'], pauseReason=project['pauseReason']), 200
        if '/coordinator' in path: return dict(projectId=PID, sessionId=SID, created=False, workspaceId=WS), 200
        if path == '/api/projects/' + PID + '/start':
            required = ('criteriaDigest', 'line', 'automatic', 'maxConcurrentTasks', 'mergeCheckCommand', 'requestId')
            if any(key not in body for key in required): return dict(message='Every start setting is required'), 400
            if body['criteriaDigest'] != cards.CORPUS['snapshot']['standing']['acceptanceConfirmation']['currentVersion']['digest']:
                return dict(code='CRITERIA_DIGEST_MOVED', message='The criteria changed; read them again.'), 409
            if body['requestId'] is not None: return dict(message='No start request is open'), 409
            if 'projectBranchName' in body and body['line'] != 'PROJECT_BRANCH': return dict(message='A branch name needs a project branch'), 400
            state['case'] = 'normal'
            project.update(startedAt=NOW, coordinatorEnabled=body['automatic'], automatic=body['automatic'], maxConcurrentTasks=body['maxConcurrentTasks'],
                           configRevision=str(int(project['configRevision']) + 1))
            state['integration'].update(line=body['line'], mergeCheckCommand=body['mergeCheckCommand'])
            bump(project); return dict(projectId=PID, startedAt=NOW), 200
        if path.startswith('/api/projects/' + PID + '/blockers/') and path.endswith('/resolve'):
            identifier = path.split('/')[-2]
            blocker = next((b for b in project['blockers']['open'] if b['id'] == identifier), None)
            if blocker is None: return dict(code='BLOCKER_NOT_OPEN', message='This blocker is no longer open.'), 409
            if not str(body.get('reason', '')).strip(): return dict(message='A reason is required'), 400
            project['blockers']['open'].remove(blocker)
            project['blockers']['resolved'].insert(0, dict(blocker, resolvedAt=NOW, resolvedBy='USER', resolutionNote=body['reason']))
            project['blockers']['resolvedCount'] += 1
            bump(project); return dict(blocker, resolvedAt=NOW, resolvedBy='USER', resolutionNote=body['reason']), 200
        parts = path.split('/')[3:]
        if parts[0].startswith('batch-'):
            results = []
            skipped = []
            for identifier in body.get('taskIds', []):
                if identifier not in state['tasks']: continue
                action = parts[0][6:]
                row = state['tasks'][identifier]
                if action == 'delete': del state['tasks'][identifier]
                elif action == 'assign': row.update(assigneeId=body.get('assigneeId'), assignee=None if body.get('assigneeId') is None else dict(id=WS, name='A11 workspace', runner=dict(id='fixture-runner')))
                elif action == 'stop': row.update(running=False, queued=False, status='OPEN', runnable=True)
                elif action == 'execute':
                    if not body.get('triggerId'): return dict(message='triggerId required'), 400
                    if not row['runnable']:
                        skipped.append(dict(id=identifier, title=row['title'], reason='The task is not runnable'))
                        continue
                    row.update(running=True, runnable=False, status='IN_PROGRESS')
                results.append(dict(id=identifier, ok=True, sessionId=SID))
            bump()
            if parts[0] == 'batch-execute': return dict(dispatched=len(results), failed=[], skipped=skipped, results=results), 200
            if parts[0] == 'batch-stop': return dict(stopped=len(results), failed=[]), 200
            if parts[0] == 'batch-delete': return dict(deleted=len(results)), 200
            return dict(updated=len(results)), 200
        row = state['tasks'].get(parts[0])
        if row is None: return dict(message='Task not found'), 404
        if len(parts) == 1:
            if self.command == 'DELETE': del state['tasks'][parts[0]]; bump(); return {}, 200
            if body.get('status') == 'DONE': return dict(code='DIRECT_TASK_DONE_REFUSED', criterion=row['completionCriterion'], requiredAction='SUBMIT_EVIDENCE', message='Completion is derived by the declared criterion.'), 403
            if body.get('status') == 'OPEN' and row.get('terminalReason') and ('terminalReason' not in body or body.get('terminalReason') is not None or 'supersededByTaskId' not in body or body.get('supersededByTaskId') is not None):
                return dict(code='TASK_RETIRED', message='Clear both retirement fields when reopening.'), 409
            row.update(body)
            if 'status' in body: row.update(runnable=body['status'] == 'OPEN', running=False, queued=False)
            bump(row); return row, 200
        if parts[1] == 'execute':
            trigger = body.get('triggerId')
            if not trigger: return dict(message='triggerId required'), 400
            if trigger in state['runTriggers']: return state['runTriggers'][trigger], 200
            if not row['runnable']: return dict(code='TASK_ACTIVE_RUN' if row['running'] else 'TASK_NOT_RUNNABLE', sessionId=SID, message='The task cannot start another run.'), 409
            row.update(running=True, queued=False, runnable=False, status='IN_PROGRESS', runAt=None)
            result = dict(sessionId=SID, taskId=row['id'])
            state['runTriggers'][trigger] = result; bump(row); return result, 200
        if parts[1] == 'comments':
            comment = dict(id='comment-' + str(state['mutations']), body=body.get('body', ''), creatorType='USER', creatorId='a08-user', createdAt=NOW)
            row['comments'].append(comment); row['_count']['comments'] = len(row['comments']); bump(row); return comment, 200
        if parts[1] == 'dependencies':
            identifier = parts[2] if len(parts) > 2 else body.get('dependsOnTaskId')
            if identifier not in state['tasks']: return dict(message='Prerequisite not found'), 404
            if identifier == row['id']: return dict(message='Task cannot depend on itself'), 400
            other = state['tasks'][identifier]
            if self.command == 'DELETE':
                row['dependsOn'] = [edge for edge in row['dependsOn'] if edge['dependsOnTaskId'] != identifier]
                other['dependedOnBy'] = [edge for edge in other['dependedOnBy'] if edge['taskId'] != row['id']]
            elif not any(edge['dependsOnTaskId'] == identifier for edge in row['dependsOn']):
                ref = lambda value: {key: value[key] for key in ('id', 'title', 'status')}
                row['dependsOn'].append(dict(taskId=row['id'], dependsOnTaskId=identifier, dependsOnTask=ref(other)))
                other['dependedOnBy'].append(dict(taskId=row['id'], dependsOnTaskId=identifier, task=ref(row)))
            row['blocked'] = any(edge['dependsOnTask']['status'] != 'DONE' for edge in row['dependsOn'])
            row['dependencyState'] = 'BLOCKED' if row['blocked'] else 'READY' if row['dependsOn'] else 'NONE'
            row['runnable'] = not row['blocked'] and row['status'] == 'OPEN'
            bump(row); return row, 200
        return dict(message='No fixture route'), 404

    def upload(self, raw, query):
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access': return self.reply({}, 401)
        with LOCK:
            identifier = query.get('taskId', [''])[0]
            if identifier not in state['tasks']: return self.reply(dict(message='Task not found'), 404)
            self.journal('/api/attachments', query)
            if state['denyTasks'] or state['mode'] == 'forbidden': return self.reply(dict(message='Permission denied'), 403)
            parsed = BytesParser(policy=email_policy).parsebytes(('Content-Type: ' + self.headers.get('Content-Type', '') + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + raw)
            file = next((part for part in parsed.iter_parts() if part.get_param('name', header='content-disposition') == 'file'), None)
            if file is None: return self.reply(dict(message='file field required'), 400)
            content = file.get_payload(decode=True)
            if len(content) > 25 * 1024 * 1024: return self.reply(dict(message='File too large'), 413)
            attachment_id = '34ZaIKb2sLBtndX7DqxHM'
            metadata = dict(id=attachment_id, fileName=file.get_filename() or 'input', mimeType=file.get_content_type(), sizeBytes=len(content), createdAt=NOW)
            state['attachments'][attachment_id] = dict(metadata, data=base64.b64encode(content).decode())
            state['tasks'][identifier]['attachments'].append(metadata)
            self._journal_row['body'] = dict(fileName=metadata['fileName'], mimeType=metadata['mimeType'], sizeBytes=len(content))
            bump(state['tasks'][identifier]); return self.reply(dict(id=attachment_id))

    do_PATCH = do_POST
    do_DELETE = do_POST
    do_PUT = do_POST


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18771)
    args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
