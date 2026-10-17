import json, sys, glob, os
TASK = '34Za39Do3N6tkmIMP0GBP'
hits = []
for f in glob.glob('/root/.orbit/claude-accounts/*/projects/*/*.jsonl'):
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
                uses[b['id']] = (o.get('timestamp'), b)
            if b.get('type') == 'tool_result' and b.get('tool_use_id'):
                results[b['tool_use_id']] = (o.get('timestamp'), b)
    for k, (ts, b) in uses.items():
        r = results.get(k)
        hits.append((f, k, ts, b['input'], r))
for f, k, ts, inp, r in hits:
    print('FILE', f)
    print('TOOL_USE', k, ts)
    print('INPUT', json.dumps(inp, ensure_ascii=False)[:600])
    if r:
        c = r[1].get('content')
        text = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c if isinstance(x, dict))
        print('RESULT', r[0], 'is_error', r[1].get('is_error'), text[:900])
    print()
