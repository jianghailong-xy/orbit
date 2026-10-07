# task_evidence_decide calls recorded by Codex sessions (event_msg item_completed McpToolCall).
import json, sys, subprocess, re
ids = set(sys.argv[1:])
p = subprocess.run(['grep', '-rl', '--include=*.jsonl', 'task_evidence_decide', '/root/.codex/sessions'], capture_output=True, text=True)
seen = {}
for f in [x for x in p.stdout.split('\n') if x]:
    for line in open(f, encoding='utf-8', errors='replace'):
        if 'task_evidence_decide' not in line or 'McpToolCall' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        it = (o.get('payload') or {}).get('item') or {}
        if it.get('type') != 'McpToolCall' or it.get('tool') != 'task_evidence_decide':
            continue
        a = it.get('arguments') or {}
        if a.get('taskId') not in ids:
            continue
        res = it.get('result') or {}
        txt = ''
        if isinstance(res, dict):
            txt = ''.join(c.get('text', '') for c in res.get('content', []) if isinstance(c, dict))
        else:
            txt = json.dumps(res, ensure_ascii=False)
        seen[it.get('id')] = {'file': f, 'ts': o.get('timestamp'), 'input': a, 'result': txt}
res = sorted(seen.values(), key=lambda v: (v['input']['taskId'], v['ts']))
for v in res:
    t = v['result']
    m = re.search(r'"decision"\s*:\s*"(\w+)"', t); rev = re.search(r'"evidenceRevision"\s*:\s*"?(\d+)', t)
    print(v['input']['taskId'], v['ts'], 'in:', v['input'].get('decision'), v['input'].get('evidenceRevision'), '| out:', m and m.group(1), rev and rev.group(1), '|', t[:140].replace('\n', ' '))
json.dump(res, open('/root/.orbit/uploads/4825540a-7870-5715-ba49-c850eac0e081/decisions-codex-raw.json', 'w'), ensure_ascii=False, indent=1)
