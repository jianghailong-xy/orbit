"""Lists every task_evidence_decide call on the scroll-lock batch task in the Claude session transcripts on this
host (input and the server response), so the CONFIRM this registration cites can be read off its source.
p4.1-accepted/tools/find-decision.py with the task id as a parameter. Usage: find-decision.py [task id]"""
import json, sys, glob
TASK = sys.argv[1] if len(sys.argv) > 1 else '34cBi0yt6bFcSmbJFgDPj'
hits = []
for f in sorted(glob.glob('/root/.orbit/claude-accounts/*/projects/*/*.jsonl')):
    try:
        data = open(f, 'rb').read()
    except Exception:
        continue
    if b'task_evidence_decide' not in data or TASK.encode() not in data:
        continue
    uses, results = {}, {}
    for line in data.splitlines():
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
            if b.get('type') == 'tool_use' and b.get('name', '').endswith('task_evidence_decide') and (b.get('input') or {}).get('taskId') == TASK:
                uses[b['id']] = (o.get('timestamp'), o.get('sessionId'), b)
            if b.get('type') == 'tool_result' and b.get('tool_use_id'):
                results[b['tool_use_id']] = (o.get('timestamp'), b)
    for k, (ts, sid, b) in uses.items():
        hits.append((f, k, ts, sid, b['input'], results.get(k)))
for f, k, ts, sid, inp, r in hits:
    print('FILE', f)
    print('TOOL_USE', k, ts, 'session', sid)
    print('INPUT', json.dumps(inp, ensure_ascii=False)[:800])
    if r:
        c = r[1].get('content')
        text = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c if isinstance(x, dict))
        print('RESULT', r[0], 'is_error', r[1].get('is_error'), text[:1200])
    else:
        print('RESULT none in this copy')
    print()
