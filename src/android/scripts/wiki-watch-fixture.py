#!/usr/bin/env python3
"""A12 loopback HTTP fixture; shared source projections plus explicit synthetic mutations.
This is not a deployed backend. Journal/state prove client wiring, never database or iOS parity.
Auth/session/record handling is inherited from A06, without a second reader implementation.
"""
import argparse, copy, importlib.util, json, socket, threading, uuid
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('a06_fixture', Path(__file__).with_name('transcript-fixture.py'))
BASE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BASE)

def corpus(name):
    return json.loads((ROOT / 'src/shared/src' / (name + '.fixture.json')).read_text())
DOCS, ARTICLES, HEALTH, REVIEW, STRIP = map(corpus, ['wiki-docs', 'wiki-articles', 'wiki-health', 'wiki-review-mode', 'watch-strip'])

def uid(suffix):
    return '01a0cca7-8609-70ed-a0e2-d4b55b832b' + suffix
SPACE, ENTRY, WATCH, CHANGESET, OP = map(uid, ['70', '72', '80', '90', '93'])
IDS = dict(space=SPACE, entry=ENTRY, session=BASE.SESSION, record=BASE.RECORD, watch=WATCH, changeset=CHANGESET, op=OP, task=BASE.TASK, source=uid('a1'))
AT = '2026-10-05T00:00:00.000Z'
LOCK = threading.RLock()
state = {}
REMAP = {'sp1': SPACE, 'space-1': SPACE, 'session-1': BASE.SESSION, 'se-maint': BASE.SESSION, 'se-job': BASE.SESSION,
         '0196b500-0000-7000-8000-000000000001': CHANGESET}
REMAP.update({f'e{i}': uid(str(70 + i)) for i in range(1, 8)})
REMAP.update({f'run1-op{i}': uid(str(90 + i)) for i in range(1, 8)})

def remap(value):
    if isinstance(value, dict): return {k: remap(v) for k, v in value.items()}
    if isinstance(value, list): return [remap(v) for v in value]
    return REMAP.get(value, value) if isinstance(value, str) else value

def normalize(path):
    # The real client canonicalizes UUID URLs to public IDs. Match both spellings.
    for value in list(IDS.values()) + list(REMAP.values()) + [uid('81'), uid('82')]:
        number, public = uuid.UUID(value).int, ''
        while number:
            number, digit = divmod(number, 62)
            public = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[digit] + public
        path = path.replace(public, value)
    return path

def make_watch(id_, status='ACTIVE', action='RESUME_SESSION'):
    return {'id': id_, 'observerType': 'SESSION' if action == 'RESUME_SESSION' else 'USER',
            'observerSessionId': BASE.SESSION if action == 'RESUME_SESSION' else None,
            'predicateVersion': 1, 'predicate': copy.deepcopy(STRIP['sentences'][0]['predicate']),
            'mode': 'ONE_SHOT', 'action': action, 'state': status, 'generation': 0,
            'expiresAt': '2026-11-01T00:00:00Z' if status != 'EXPIRED' else '2026-10-04T00:00:00Z',
            'lastEvaluatedAt': AT, 'createdAt': AT, 'updatedAt': AT,
            'targets': [{'targetKind': 'TASK', 'targetResourceId': BASE.TASK, 'state': 'OBSERVED',
                         'targetTitle': 'A12 watched task', 'targetEpoch': 1, 'lastEvaluatedAt': AT,
                         'targetStatus': {'status': 'IN_PROGRESS', 'running': True, 'queued': False}}], 'matches': [], 'expiryDeliveries': []}

def reset():
    # The shared corpus's maintenance run, whole: Recently changed folds it into one row, its page counts it,
    # and its pending ops (run1-op3, run1-op7) are what Review lists.
    run = remap(copy.deepcopy(REVIEW['runs'][0]['view']))
    run['expiresAt'] = '2026-11-01T00:00:00Z'
    run['revertible'] = True
    entries = {entry['id']: entry for entry in run['entries']}
    entry = entries[ENTRY]
    entry.update(title='A12 Wiki source entry', summary='**Controlled** Wiki source with an original session record.')
    entry['sources'] = [{'id': uid('a1'), 'kind': 'turn', 'state': 'live', 'ref': BASE.SESSION,
                         'locator': {'turnId': BASE.RECORD}, 'quote': 'Protected record 110'}]
    entry['history'] = [{'id': uid('a4'), 'revision': 1, 'authorKind': 'maintenance', 'createdAt': AT}]
    entry['exposure'] = [{'id': uid('a2'), 'sessionId': BASE.SESSION, 'channel': 'get', 'at': AT}]
    entry['anchors'] = [{'type': 'path', 'path': 'src/android/README.md', 'check': {'state': 'verified', 'ref': 'a' * 40}}]
    doc = remap(copy.deepcopy(DOCS['docs']['doc']['read']))
    for footnote in doc['footnotes']:
        if footnote['kind'] in ('turn', 'event', 'tool_call'):
            footnote.update(sessionId=BASE.SESSION, recordId=BASE.RECORD, sessionTitle='Long conversation')
    versions = remap(copy.deepcopy(DOCS['plan']['versions']))
    plan = {'spaceId': SPACE, 'confirmed': versions['v1'], 'draft': None, 'proposals': [], 'job': None}
    state.clear()
    state.update(journal=[], denial=0, conflict=False, offline=False, prefix='/api/wiki', empty=False,
                 entries=entries, run=run, doc=doc, plan=plan, versions={'v1': versions['v1']},
                 watches={WATCH: make_watch(WATCH), uid('81'): make_watch(uid('81'), 'PAUSED'),
                          uid('82'): make_watch(uid('82'), 'EXPIRED', 'NOTIFY_USER')},
                 space={'id': SPACE, 'slug': 'a12-fixture', 'title': 'A12 controlled Wiki', 'repoUrlNorm': 'github.com/example/orbit',
                        'rootCommitSha': 'a' * 40, 'pendingOps': 1, 'settings': {'reviewMode': 'tiered', 'automaticSpotChecks': False,
                        'maintenance': {'enabled': False, 'workspaceId': BASE.WORKSPACE, 'provider': 'local-vllm', 'dailyRunLimit': 4, 'lookbackDays': 14}}},
                 docsPlan=True, idempotency={}, lostResponse=False)
    BASE.state.mode = 'REVIEW'
    BASE.state.record_denial = BASE.state.denial = BASE.state.page_denial = BASE.state.snapshot_status = 0
    BASE.state.extra = []
    BASE.state.epoch += 1

reset()

class Handler(BASE.Handler):
    def send_response(self, code, message=None):
        if getattr(self, 'journal_row', None) is not None: self.journal_row['status'] = code
        super().send_response(code, message)

    def begin(self, body=None):
        self.journal_row = {'method': self.command, 'path': self.path, 'body': body, 'status': None}
        state['journal'].append(self.journal_row)

    def drop(self):
        self.journal_row['status'] = 'disconnected'
        self.close_connection = True
        self.connection.shutdown(socket.SHUT_RDWR)
        self.connection.close()

    def refusal(self, path, write=False):
        if self.headers.get('Authorization') != 'Bearer a06-fixture-access':
            self.reply({'message': 'Fixture login required'}, 401); return True
        if path.startswith(state['prefix']):
            if state['offline']:
                self.drop(); return True
            if state['denial']:
                self.reply({'message': 'A12 controlled access refusal'}, state['denial']); return True
            if write and state['conflict']:
                self.reply({'code': 'WIKI_REVISION_CONFLICT' if '/wiki/' in path else 'WATCH_STATE_CHANGED', 'message': 'This item changed. Refresh and review it again.'}, 409); return True
        return False

    def do_GET(self):
        url = urlparse(self.path); path = normalize(url.path); query = parse_qs(url.query)
        self.journal_row = None
        if path == '/__ids': return self.reply(IDS)
        if path == '/__stats':
            with LOCK:
                return self.reply({**copy.deepcopy(state), 'entry': copy.deepcopy(state['entries'][ENTRY]), 'watch': copy.deepcopy(state['watches'][WATCH]), 'ids': IDS})
        self.begin()
        if path.startswith(('/api/wiki', '/api/watches')):
            if self.refusal(path): return
            with LOCK:
                value = self.read_module(path, query)
                return self.reply(value, 404 if value is None else 200)
        return super().do_GET()

    def read_module(self, path, query):
        if path == '/api/watches':
            watches = list(state['watches'].values())
            if state['empty']: return []
            if 'state' in query: watches = [w for w in watches if w['state'] == query['state'][0]]
            if 'needsAttention' in query: watches = [w for w in watches if w['state'] in ('EXPIRED', 'REVOKED', 'UNRESOLVABLE')]
            return watches
        if path.startswith('/api/watches/'): return state['watches'].get(path.rsplit('/', 1)[-1])
        if path == '/api/wiki/spaces': return [] if state['empty'] else [state['space']]
        if path == '/api/wiki/search':
            q = query.get('q', [''])[0].lower()
            return {'q': q, 'hits': [dict({k: e.get(k) for k in ('id', 'kind', 'title', 'summary', 'trust', 'anchorState')}, match=['keyword'], score=1.0) for e in state['entries'].values()
                             if not state['empty'] and e['status'] == 'active' and q in (e['title'] + e['summary']).lower()]}
        if path == '/api/wiki/review':
            return [state['run']] if not state['empty'] and any(op['decision'] == 'pending' for op in state['run']['ops']) else []
        if path == '/api/wiki/changesets/' + CHANGESET: return state['run']
        if path.startswith('/api/wiki/entries/'): return state['entries'].get(path.rsplit('/', 1)[-1])
        prefix = '/api/wiki/spaces/' + SPACE
        if path == prefix: return state['space']
        tail = path.removeprefix(prefix)
        if path == tail: return None
        if tail == '/entries': return list(state['entries'].values())
        if tail == '/timeline':
            # One owner edit (an op row) over the maintenance run's applied ops (one run row).
            items = [{'opId': uid('a3'), 'op': 'amend', 'decision': 'auto_applied', 'origin': 'owner', 'at': AT, 'entryId': ENTRY,
                      'title': state['entries'][ENTRY]['title'], 'kind': state['entries'][ENTRY].get('kind'), 'status': 'active',
                      'trust': state['entries'][ENTRY].get('trust')}]
            for op in state['run']['ops']:
                if op['decision'] != 'auto_applied': continue
                entry = state['entries'].get(op.get('resultEntryId') or op.get('entryId')) or {}
                items.append({'opId': op['id'], 'op': op['op'], 'decision': 'auto_applied', 'origin': 'maintenance', 'at': state['run']['createdAt'],
                              'entryId': entry.get('id'), 'title': entry.get('title'), 'kind': entry.get('kind'), 'status': entry.get('status'),
                              'trust': entry.get('trust'), 'appliedByMode': 'automatic', 'changesetId': CHANGESET, 'changesetAppliedByMode': 'automatic'})
            return {'items': items}
        if tail == '/health': return {**copy.deepcopy(HEALTH['cases'][0]['health']), 'spaceId': SPACE, 'entries': len(state['entries'])}
        if tail == '/docs':
            directory = remap(copy.deepcopy(DOCS['docs']['directory']['read']))
            if not state['docsPlan']: directory.update(plan=None, categories=[])
            return directory
        if tail.startswith('/docs/'):
            slug = tail.rsplit('/', 1)[-1]
            if slug == state['doc']['slug']: return state['doc']
            unwritten = remap(copy.deepcopy(DOCS['docs']['notWritten']['read']))
            return unwritten if slug == unwritten['slug'] else None
        if tail == '/doc-index': return {'spaceId': SPACE, 'plan': copy.deepcopy(DOCS['docs']['directory']['read']['plan']) if state['docsPlan'] else None, 'items': copy.deepcopy(DOCS['docs']['index']['items']) if state['docsPlan'] else []}
        if tail == '/articles': return {**copy.deepcopy(ARTICLES['directory']['read']), 'spaceId': SPACE}
        if tail == '/article-index': return {'spaceId': SPACE, 'items': copy.deepcopy(ARTICLES['index']['items'])}
        if tail.startswith('/topics/'): return {'entries': list(state['entries'].values())}
        if tail.startswith('/articles/'):
            parts = tail.split('/')
            return {'spaceId': SPACE, 'topic': {'slug': parts[2], 'title': '会话'}, 'part': int(parts[3]) if len(parts) > 3 else 0,
                    'title': 'A12 article', 'kind': 'article', 'blocks': [{'heading': None, 'sentences': [{'text': 'Controlled article with original entry.', 'notes': [1]}]}],
                    'footnotes': [{'n': 1, 'entryId': ENTRY, 'revision': state['entries'][ENTRY]['currentRevision'], 'entry': state['entries'][ENTRY]}], 'entries': list(state['entries'].values())}
        if tail == '/plan': return state['plan']
        if tail == '/plan/versions': return {'spaceId': SPACE, 'versions': list(state['versions'].values())}
        if tail.startswith('/plan/versions/'): return next((v for v in state['versions'].values() if str(v['version']) == tail.rsplit('/', 1)[-1]), None)
        return None

    def do_POST(self):
        path = normalize(urlparse(self.path).path)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        self.journal_row = None
        if path == '/__control':
            with LOCK:
                if body.get('reset'): reset()
                for key in ('denial', 'conflict', 'offline', 'prefix', 'empty', 'docsPlan', 'lostResponse'):
                    if key in body: state[key] = body[key]
                for key in ('record_denial', 'page_denial', 'snapshot_status'):
                    if key in body: setattr(BASE.state, key, body[key])
                if 'entry' in body: state['entries'][ENTRY].update(body['entry'])
                if 'watch' in body: state['watches'][WATCH].update(body['watch'])
                if 'draft' in body:
                    draft = remap(copy.deepcopy(DOCS['plan']['versions'].get(body['draft'])))
                    state['plan']['draft'] = draft
                    if draft: state['versions']['v' + str(draft['version'])] = draft
                if body.get('proposals'): state['plan']['proposals'] = remap(copy.deepcopy(DOCS['plan']['proposals']))
            return self.reply({'ok': True})
        self.begin(body)
        if path in ('/api/auth/login', '/api/auth/refresh'):
            return self.reply({'accessToken': 'a06-fixture-access', 'refreshToken': 'a06-fixture-refresh', 'user': {'id': 'a06-user', 'email': 'a06@example.test', 'name': 'A12 fixture'}})
        if path == '/api/auth/logout': return self.reply({})
        if self.refusal(path, write=True): return
        with LOCK:
            result, status = self.mutate(path, body)
            self.journal_row['final'] = copy.deepcopy(result)
            if state['lostResponse'] and status == 200:
                self.journal_row['committedBeforeDisconnect'] = True
                self.drop(); return
            self.reply(result, status)

    do_PATCH = do_POST

    def link_previews(self, body):
        # The cards a page names: the inherited session and task are this account's; anything else is unavailable.
        out = []
        for ref in body.get('refs', []):
            kind, id_ = ref.get('kind'), normalize('/' + ref.get('id', '')).lstrip('/')
            if kind == 'session' and id_ == BASE.SESSION: out.append({'kind': kind, 'id': ref['id'], 'state': 'ok', 'session': {'title': 'Long conversation'}})
            elif kind == 'task' and id_ == BASE.TASK: out.append({'kind': kind, 'id': ref['id'], 'state': 'ok', 'task': {'title': 'Related reading task'}})
            else: out.append({'kind': kind, 'id': ref.get('id'), 'state': 'unavailable'})
        return {'previews': out}, 200

    def mutate(self, path, body):
        if path == '/api/link-previews': return self.link_previews(body)
        if path.startswith('/api/watches/'):
            id_, action = path.split('/')[-2:]
            watch = state['watches'].get(id_)
            if watch is None: return {}, 404
            expected, target = {'pause': ('ACTIVE', 'PAUSED'), 'resume': ('PAUSED', 'ACTIVE'), 'cancel': (watch['state'], 'CANCELLED')}.get(action, ('', ''))
            if watch['state'] not in ('ACTIVE', 'PAUSED') or watch['state'] != expected: return {'code': 'WATCH_STATE_CHANGED'}, 409
            watch.update(state=target, updatedAt=AT)
            return watch, 200
        if path == '/api/watches':
            key = body.get('idempotencyKey')
            if key in state['idempotency']: return state['idempotency'][key], 200
            watch = make_watch(uid('83'), action='NOTIFY_USER')
            watch.update({k: copy.deepcopy(body[k]) for k in ('predicate', 'predicateVersion', 'mode', 'action') if k in body})
            state['watches'][watch['id']] = watch
            state['idempotency'][key] = watch
            return watch, 200
        if path == '/api/wiki/spaces/' + SPACE and self.command == 'PATCH':
            settings = copy.deepcopy(body.get('settings', {}))
            if 'maintenance' in settings:
                settings['maintenance'] = {**state['space']['settings']['maintenance'], **settings['maintenance']}
            state['space']['settings'].update(settings)
            return state['space'], 200
        if path.startswith('/api/wiki/entries/'):
            id_, action = path.split('/')[-2:]; entry = state['entries'].get(id_)
            if entry is None: return {}, 404
            if entry['status'] != 'active' or entry['trust'] not in ('auto', 'unreviewed'): return {'code': 'WIKI_REVISION_CONFLICT'}, 409
            if action == 'confirm': entry.update(trust='confirmed', currentRevision=entry['currentRevision'] + 1)
            elif action == 'reject': entry.update(status='rejected', rejectionReason=body.get('reason'))
            else: return {}, 404
            return {}, 200
        if path == '/api/wiki/spaces/' + SPACE + '/changesets':
            key = body.get('idempotencyKey')
            if key in state['idempotency']: return state['idempotency'][key], 200
            op = body.get('ops', [{}])[0]; entry = state['entries'].get(op.get('entryId'))
            if entry is None: return {}, 404
            if op.get('baseRevision') != entry['currentRevision']: return {'code': 'WIKI_REVISION_CONFLICT'}, 409
            if op['op'] == 'amend': entry.update(op['changes']); entry['currentRevision'] += 1
            elif op['op'] == 'retire': entry.update(status='retired', retiredAt=AT)
            elif op['op'] == 'supersede':
                new = dict(entry, **op['entry']); new.update(id=uid('78'), currentRevision=1)
                state['entries'][new['id']] = new; entry.update(status='superseded', supersededById=new['id'])
            result = {'changesetId': CHANGESET, 'replayed': False, 'ops': [{'seq': 0, 'status': 'applied', 'entryId': entry['id'], 'revision': entry['currentRevision'], 'reasons': []}]}
            state['idempotency'][key] = result
            return result, 200
        if path == '/api/wiki/changesets/' + CHANGESET + '/decide':
            for answer in body.get('decisions', []):
                op = next((o for o in state['run']['ops'] if o['id'] == normalize(answer.get('opId', ''))), None)
                if op is None or op['decision'] != 'pending': return {'code': 'WIKI_ALREADY_DECIDED'}, 409
                op.update(decision='rejected' if answer['action'] == 'reject' else 'accepted', decisionReason=answer.get('reason'))
                if answer.get('edited'): state['entries'][ENTRY].update(answer['edited'])
            state['space']['pendingOps'] = sum(o['decision'] == 'pending' for o in state['run']['ops'])
            return state['run'], 200
        if path == '/api/wiki/changesets/' + CHANGESET + '/revert':
            state['run']['revertible'] = False
            return {'reverted': 1, 'kept': 0}, 200
        if '/plan/versions/' in path and path.endswith('/confirm'):
            draft = state['plan'].get('draft')
            if draft is None or str(draft['version']) != path.split('/')[-2]: return {'code': 'WIKI_PLAN_STALE'}, 409
            draft.update(status='confirmed', confirmedAt=AT); state['plan'].update(confirmed=draft, draft=None)
            return draft, 200
        if path.endswith('/plan/edits'):
            latest = max(state['versions'].values(), key=lambda v: v['version'])
            if body.get('baseVersion') != latest['version']: return {'code': 'WIKI_PLAN_STALE'}, 409
            draft = copy.deepcopy(latest)
            doc = next((d for d in draft['docs'] if d['slug'] == body.get('docSlug')), None)
            if doc is None: return {}, 404
            if body.get('doc'): doc.update(body['doc'])
            elif body.get('section'):
                section = next((x for x in doc['sections'] if x['key'] == body.get('sectionKey')), None)
                if section is None: return {}, 404
                section.update(body['section'])
            else: return {'message': 'Missing plan edit'}, 400
            draft.update(version=latest['version'] + 1, status='draft', origin='owner', baseVersion=latest['version'], confirmedAt=None)
            state['versions']['v' + str(draft['version'])] = draft
            state['plan']['draft'] = draft
            return draft, 200
        if path.startswith('/api/wiki/plan-proposals/') and path.endswith('/decide'):
            proposal = next((p for p in state['plan']['proposals'] if p['id'] == path.split('/')[-2]), None)
            if proposal is None: return {}, 404
            if proposal['status'] != 'pending': return {'code': 'WIKI_PLAN_STALE'}, 409
            if body.get('action') not in ('accept', 'reject'): return {'message': 'Unknown decision'}, 400
            draft = None
            if body['action'] == 'accept':
                latest = max(state['versions'].values(), key=lambda v: v['version'])
                draft = copy.deepcopy(latest)
                changed = copy.deepcopy(proposal['change']['doc'])
                draft['docs'] = [d for d in draft['docs'] if d['slug'] != changed['slug']] + [changed]
                draft.update(version=latest['version'] + 1, status='draft', baseVersion=latest['version'], confirmedAt=None)
                state['versions']['v' + str(draft['version'])] = draft
                state['plan']['draft'] = draft
            proposal.update(status='accepted' if body['action'] == 'accept' else 'rejected', decidedAt=AT)
            return {'proposal': proposal, 'draft': draft}, 200
        if path.endswith('/plan/redraft'):
            state['plan']['job'] = remap(copy.deepcopy(DOCS['plan']['jobs']['held']))
            state['plan']['job']['instructions'] = body.get('instructions')
            return {'created': True, 'job': state['plan']['job']}, 200
        return {}, 404

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=18770); args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
