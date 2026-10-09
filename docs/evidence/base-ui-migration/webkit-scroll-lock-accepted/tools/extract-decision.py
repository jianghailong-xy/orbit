"""Copies the coordinator's task_evidence_decide call on the scroll-lock batch (34cBi0yt6bFcSmbJFgDPj), input and
server response, verbatim from the coordinator session transcript, together with the evidence revisions as
task_evidence_list returned them to this registration session (read from this session's own transcript).
p4.1-accepted/tools/extract-decision.py with the evidence list taken from a transcript instead of a file.
Usage: extract-decision.py <coordinator transcript> <decide tool_use id> <this session's transcript> <out.json>"""
import json, sys
TASK, DOCUMENT = '34cBi0yt6bFcSmbJFgDPj', 'webkit-scroll-lock/README.md'
TRANSCRIPT, TOOL_USE, OWN, OUT = sys.argv[1:5]


def blocks(path):
    for line in open(path, 'rb'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        msg = o.get('message') or {}
        content = msg.get('content') if isinstance(msg, dict) else None
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict):
                    yield o, b


def text_of(b):
    c = b.get('content')
    return c if isinstance(c, str) else ''.join(x.get('text', '') for x in c if isinstance(x, dict))


call = response = None
for o, b in blocks(TRANSCRIPT):
    if b.get('type') == 'tool_use' and b.get('id') == TOOL_USE:
        call = {'timestamp': o.get('timestamp'), 'tool': b.get('name'), 'input': b.get('input')}
    if b.get('type') == 'tool_result' and b.get('tool_use_id') == TOOL_USE:
        response = {'timestamp': o.get('timestamp'), 'isError': bool(b.get('is_error')), 'text': text_of(b)}
assert call and response, 'decision call not found'
decided = json.loads(response['text'])

listing = {}
for o, b in blocks(OWN):
    if b.get('type') == 'tool_use' and b.get('name', '').endswith('task_evidence_list') and (b.get('input') or {}).get('taskId') == TASK:
        listing[b['id']] = o.get('timestamp')
    if b.get('type') == 'tool_result' and b.get('tool_use_id') in listing:
        listing[b['tool_use_id']] = (listing[b['tool_use_id']], json.loads(text_of(b)))
list_id, (listed_at, revs) = next((k, v) for k, v in listing.items() if isinstance(v, tuple))
rev = next(r for r in revs if str(r['revision']) == '1')
assert decided['taskId'] == TASK and decided['decision'] == 'CONFIRM' and decided['evidenceRevision'] == '1'
assert decided['evidenceDigest'] == rev['evidenceDigest'] and decided['evidenceId'] == rev['id']
out = {
    'about': f'The coordinator decision on the evidence of the WebKit scroll-lock batch ({TASK}) that this registration cites, copied verbatim from Orbit records. '
             f'evidenceRevisions: task_evidence_list({TASK}) as this registration session read it (tool_use {list_id}, {listed_at}; one revision; the evidence body is omitted, its digest identifies it). '
             'decisionCall: the coordinator session called task_evidence_decide on revision 1; the call input and the server response are copied from that session transcript (path in transcript).',
    'task': TASK,
    'evidenceRevisions': [{k: r[k] for k in ('revision', 'id', 'evidenceDigest', 'submittedAt', 'sourceSessionId')} for r in revs],
    'transcript': TRANSCRIPT,
    'decisionCall': {'toolUseId': TOOL_USE, 'evidenceRevision': 1, 'call': call, 'response': response},
    'cited': {'taskId': decided['taskId'], 'evidenceRevision': int(decided['evidenceRevision']), 'evidenceDigest': decided['evidenceDigest'],
              'verdict': decided['decision'], 'decisionRecord': decided['id'], 'decidedAt': decided['decidedAt'],
              'decidingSessionId': decided['decidingSessionId'], 'document': DOCUMENT},
}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out['cited'], ensure_ascii=False))
print(decided['note'])
