# Copies the coordinator's task_evidence_decide call on P4.1 (input and server response) verbatim from the
# coordinator session transcript, with the evidence revision as task_evidence_list returns it.
import json, sys
TRANSCRIPT, TOOL_USE, EVIDENCE_LIST, OUT = sys.argv[1:5]
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
revs = [r for r in json.load(open(EVIDENCE_LIST))]
rev = next(r for r in revs if str(r['revision']) == '1')
assert decided['evidenceDigest'] == rev['evidenceDigest'] and decided['decision'] == 'CONFIRM' and decided['evidenceRevision'] == '1'
out = {
    'about': 'The coordinator decision on the evidence of P4.1 (34Za39Do3N6tkmIMP0GBP) that this registration cites, copied verbatim from Orbit records. '
             'evidenceRevisions: task_evidence_list(34Za39Do3N6tkmIMP0GBP) as read by this registration session on 2026-10-07 (one revision; the evidence body is omitted, its digest identifies it). '
             'decisionCall: the coordinator session 34b245G3NiwgVVUj2JFJw called task_evidence_decide on revision 1; the call input and the server response are copied from that session transcript (path in transcript).',
    'task': '34Za39Do3N6tkmIMP0GBP',
    'evidenceRevisions': [{k: r[k] for k in ('revision', 'id', 'evidenceDigest', 'submittedAt', 'sourceSessionId')} for r in revs],
    'transcript': TRANSCRIPT,
    'decisionCall': {'toolUseId': TOOL_USE, 'evidenceRevision': 1, 'call': call, 'response': response},
    'cited': {'taskId': decided['taskId'], 'evidenceRevision': int(decided['evidenceRevision']), 'evidenceDigest': decided['evidenceDigest'],
              'verdict': decided['decision'], 'decisionRecord': decided['id'], 'decidedAt': decided['decidedAt'],
              'decidingSessionId': decided['decidingSessionId'], 'document': 'p4.1/README.md'},
}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out['cited'], ensure_ascii=False))
print(decided['note'])
