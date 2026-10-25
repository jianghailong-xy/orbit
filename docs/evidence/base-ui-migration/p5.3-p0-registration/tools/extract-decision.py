# Copies the coordinator's task_evidence_decide call on P5.3 (input and server response) verbatim from the
# coordinator session transcript, with the evidence revision as task_evidence_list returns it
# (p4.1-accepted/tools/extract-decision.py, for P5.3).
# Usage: python3 extract-decision.py <transcript.jsonl> <tool_use id> <evidence-list.json> <out.json>
import json, sys
TRANSCRIPT, TOOL_USE, EVIDENCE_LIST, OUT = sys.argv[1:5]
TASK = '34Za39Ov1yysHZaYL6wgJ'
call = response = None
for line in open(TRANSCRIPT, 'rb'):
    try:
        o = json.loads(line)
    except Exception:
        continue
    msg = o.get('message') or {}
    content = msg.get('content') if isinstance(msg, dict) else None
    if not isinstance(content, list):
        continue
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get('type') == 'tool_use' and b.get('id') == TOOL_USE:
            call = {'timestamp': o.get('timestamp'), 'tool': b.get('name'), 'input': b.get('input')}
        if b.get('type') == 'tool_result' and b.get('tool_use_id') == TOOL_USE:
            c = b.get('content')
            text = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c if isinstance(x, dict))
            response = {'timestamp': o.get('timestamp'), 'isError': bool(b.get('is_error')), 'text': text}
assert call and response, 'decision call not found'
decided = json.loads(response['text'])
revs = json.load(open(EVIDENCE_LIST))
rev = next(r for r in revs if str(r['revision']) == '1')
assert decided['taskId'] == TASK and call['input'].get('taskId') == TASK
assert decided['evidenceDigest'] == rev['evidenceDigest'] and decided['decision'] == 'CONFIRM' and decided['evidenceRevision'] == '1'
assert rev['decision']['decision'] == 'CONFIRM' and rev['decision']['note'] == decided['note'] == call['input']['note']
out = {
    'about': f'The coordinator decision on the evidence of P5.3 ({TASK}) that this registration cites, copied verbatim from Orbit records. '
             f'evidenceRevisions: `orbit task evidence-list {TASK} --json` as read by this registration session on 2026-10-10 (one revision; the evidence body is omitted, its digest identifies it). '
             'decisionCall: the coordinator session 34b245G3NiwgVVUj2JFJw called task_evidence_decide on revision 1; the call input and the server response are copied from that session transcript (path in transcript).',
    'task': TASK,
    'evidenceRevisions': [{**{k: r[k] for k in ('revision', 'id', 'evidenceDigest', 'submittedAt', 'sourceSessionId')},
                           'decision': {k: r['decision'][k] for k in ('decision', 'decidedAt', 'decidedByType')}} for r in revs],
    'transcript': TRANSCRIPT,
    'decisionCall': {'toolUseId': TOOL_USE, 'evidenceRevision': 1, 'call': call, 'response': response},
    'cited': {'taskId': decided['taskId'], 'evidenceRevision': int(decided['evidenceRevision']), 'evidenceDigest': decided['evidenceDigest'],
              'verdict': decided['decision'], 'decisionRecord': decided['id'], 'decidedAt': decided['decidedAt'],
              'decidingSessionId': decided.get('decidingSessionId'), 'document': 'p5.3/README.md'},
}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out['cited'], ensure_ascii=False))
