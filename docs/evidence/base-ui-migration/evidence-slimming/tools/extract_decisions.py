# Extract task_evidence_decide calls (input + result) for the given task ids from Claude/Codex transcripts.
import json, sys, subprocess, re
ids = set(sys.argv[1:])
roots = ['/root/.orbit/claude-accounts', '/root/.claude/projects', '/root/.codex/sessions', '/root/.orbit/codex-state']
files = []
for r in roots:
    p = subprocess.run(['grep', '-rl', '--include=*.jsonl', 'task_evidence_decide', r], capture_output=True, text=True)
    files += [f for f in p.stdout.split('\n') if f and '/subagents/' not in f]
out = {}
for f in files:
    calls = {}
    try:
        lines = open(f, encoding='utf-8', errors='replace').read().split('\n')
    except Exception:
        continue
    for line in lines:
        if 'task_evidence_decide' not in line and 'tool_result' not in line and 'function_call_output' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        msg = o.get('message') or {}
        content = msg.get('content') if isinstance(msg, dict) else None
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict): continue
                if b.get('type') == 'tool_use' and str(b.get('name', '')).endswith('task_evidence_decide'):
                    inp = b.get('input') or {}
                    if inp.get('taskId') in ids:
                        calls[b['id']] = {'file': f, 'ts': o.get('timestamp'), 'input': inp}
                elif b.get('type') == 'tool_result' and b.get('tool_use_id') in calls:
                    c = b.get('content')
                    if isinstance(c, list):
                        c = ''.join(x.get('text', '') for x in c if isinstance(x, dict))
                    calls[b['tool_use_id']]['result'] = c
        # codex rollout format
        p = o.get('payload') or {}
        if isinstance(p, dict) and p.get('type') == 'function_call' and 'task_evidence_decide' in str(p.get('name', '')):
            try:
                inp = json.loads(p.get('arguments') or '{}')
            except Exception:
                inp = {}
            if inp.get('taskId') in ids:
                calls[p.get('call_id')] = {'file': f, 'ts': o.get('timestamp'), 'input': inp}
        if isinstance(p, dict) and p.get('type') == 'function_call_output' and p.get('call_id') in calls:
            calls[p['call_id']]['result'] = p.get('output')
    for k, v in calls.items():
        out[k] = v
res = sorted(out.values(), key=lambda v: (v['input'].get('taskId'), str(v.get('ts'))))
for v in res:
    r = v.get('result')
    rs = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
    m = re.search(r'"decision"\s*:\s*"(\w+)"', rs or '')
    rev = re.search(r'"evidenceRevision"\s*:\s*"?(\d+)', rs or '')
    print(v['input'].get('taskId'), v['ts'], 'in:', v['input'].get('decision'), 'evRev(in):', v['input'].get('evidenceRevision') or v['input'].get('revision') or v['input'].get('evidenceId'),
          '| out:', m.group(1) if m else None, 'rev', rev.group(1) if rev else None, '|', (rs or '')[:160].replace('\n', ' '), '|', v['file'][-60:])
json.dump(res, open(sys.argv[0].rsplit('/', 1)[0] + '/../decisions-raw.json', 'w'), ensure_ascii=False, indent=1)
