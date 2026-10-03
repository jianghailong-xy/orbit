import json, os, sys
R='/var/tmp/agy-c0/runs/'
keys=['command','write_ws','edit_ws','write_out','read_out','web']
def analyze(n):
    evs=[json.loads(json.loads(l)['line']) for l in open(R+n+'/stdout.jsonl') if json.loads(l)['line'].startswith('{')]
    init=[e for e in evs if e.get('event')=='init'][0]['init']
    turns=[]; cur=[]
    for e in evs:
        if e.get('event')=='step_update': cur.append(e['step_update'])
        if e.get('event')=='result': turns.append((cur, e['result'])); cur=[]
    rows=[]
    for k,(steps,res) in zip(keys,turns):
        tool=[s for s in steps if s.get('step_type')=='tool']
        last=tool[-1] if tool else None
        st=last['state'] if last else '-'
        info=(last or {}).get('tool_info',{})
        err=(info.get('error') or {}).get('message','')
        out='out' if info.get('output') else ''
        denied=','.join(d['action'] for d in res.get('denied_actions',[]) or [])
        cont='continued' if (res.get('response') or '').strip().endswith('finished') else 'ended'
        rows.append(f"  {k:9s} step={st:5s} {out:3s} denied=[{denied}] {cont:9s} {err[:110]}")
    side=[]
    ws=R+n+'/ws'
    side.append('cmd-ran.txt' if os.path.exists(ws+'/cmd-ran.txt') else '-')
    side.append('new.txt' if os.path.exists(ws+'/new.txt') else '-')
    side.append('existing='+open(ws+'/existing.txt').read().strip())
    side.append('outside/x.txt' if os.path.exists(R+n+'/outside/x.txt') else '-')
    print(f"== {n}  permission_mode={init.get('permission_mode')}  side-effects: {' '.join(side)}")
    print('\n'.join(rows))
for n in sys.argv[1:]: analyze(n)
