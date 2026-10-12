#!/usr/bin/env python3
"""P7 drill driver for the ISOLATED stack (127.0.0.1:2886, not production Orbit). Prints no key.
  drill.py state                              runners (version, provider:* claims, dsh engine), providers, workspaces
  drill.py new WS PROVIDER TITLE PROMPT [mode]  create a session (prints id/status or the refusal)
  drill.py turn SID TEXT                      send a follow-up turn
  drill.py wait SID [timeout] [minTurns]      wait for the turn to settle, print state + persisted events
  drill.py enable SLUG true|false             the per-provider entry switch (PATCH /providers/mine/:id)
  drill.py install RUNNER_NAME                POST /runners/:id/install {engine: dsh}
  drill.py procs                              engine processes on this host under the P7 runner homes
  drill.py dshhome                            fingerprint of runner-a's dsh-sessions (state kept across rollback)
"""
import hashlib, json, os, subprocess, sys, uuid
sys.path.insert(0, '/var/tmp/p7-stack')
from api import api

def rows(x, key):
    return x if isinstance(x, list) else (x or {}).get(key, x)

def runner_by_name(name):
    return next(r for r in rows(api('GET', '/runners'), 'runners') if r['name'] == name)

def ws_by_name(name):
    return next(w for w in rows(api('GET', '/workspaces'), 'workspaces') if w['name'] == name)

def state():
    for r in rows(api('GET', '/runners'), 'runners'):
        caps = [c for c in r.get('capabilities') or [] if c.startswith('provider:')]
        dsh = next((e for e in r.get('engines') or [] if e.get('engine') == 'dsh'), None)
        dsh = dsh and {k: dsh.get(k) for k in ('installed', 'version', 'auth', 'error', 'code', 'message') if dsh.get(k) is not None}
        print('runner', r['name'], 'online' if r.get('online') else 'offline', 'version', r.get('version'), caps,
              'dsh-engine', json.dumps(dsh, ensure_ascii=False))
    for p in rows(api('GET', '/providers/mine'), 'providers'):
        print('provider', p.get('slug'), 'runtime', p.get('runtime'), 'enabled', p.get('enabled'), 'hasApiKey', p.get('hasApiKey'))
    for w in rows(api('GET', '/workspaces'), 'workspaces'):
        print('workspace', w['name'], w['id'], 'runner', w.get('runnerId'), w.get('workDir'))

def main(a):
    cmd = a[0]
    if cmd == 'state':
        state()
    elif cmd == 'new':
        ws, prov, title, prompt = a[1], a[2], a[3], a[4]
        body = {'workspaceId': ws_by_name(ws)['id'], 'provider': prov, 'title': title, 'prompt': prompt,
                'permissionMode': a[5] if len(a) > 5 else 'auto'}
        s = api('POST', '/sessions', body)
        print(json.dumps({k: s.get(k) for k in ('id', 'status', 'provider', 'assignedRunnerId', 'httpError', 'body')
                          if k in s}, ensure_ascii=False))
    elif cmd == 'turn':
        s = api('POST', f'/sessions/{a[1]}/turns', {'clientTurnId': str(uuid.uuid4()), 'content': a[2]})
        print(json.dumps(s, ensure_ascii=False)[:600])
    elif cmd == 'wait':
        subprocess.run([sys.executable, '/var/tmp/p7-stack/wait.py', *a[1:]])
    elif cmd == 'enable':
        p = next(p for p in rows(api('GET', '/providers/mine'), 'providers') if p['slug'] == a[1])
        r = api('PATCH', f"/providers/mine/{p['id']}", {'enabled': a[2] == 'true'})
        print(json.dumps({k: r.get(k) for k in ('slug', 'runtime', 'enabled', 'httpError', 'body') if k in r}))
    elif cmd == 'install':
        r = api('POST', f"/runners/{runner_by_name(a[1])['id']}/install", {'engine': 'dsh'})
        print(json.dumps(r, ensure_ascii=False)[:800])
    elif cmd == 'procs':
        # only the descendants of the two P7 runner processes (this host also runs production sessions)
        out = subprocess.run(['ps', '-eo', 'pid=,ppid=,etime=,args='], capture_output=True, text=True).stdout
        procs = [l.split(None, 3) for l in out.splitlines() if len(l.split(None, 3)) == 4]
        mine = {p[0] for p in procs if p[3].startswith('/var/tmp/p7-stack/bin/orbit-') and p[3].endswith(' run')}
        grew = True
        while grew:
            more = {p[0] for p in procs if p[1] in mine} - mine
            grew = bool(more); mine |= more
        for p in procs:
            if p[0] in mine:
                print(p[0], p[1], p[2], p[3][:220])
        # a dsh ACP session id must never reach any process's argv (e.g. `claude --resume <id>`)
        for sid in a[1:]:
            hits = [p for p in procs if sid in p[3] and 'drill.py' not in p[3]]
            print('argv containing', sid, ':', len(hits))
    elif cmd == 'dshhome':
      for base in ('/var/tmp/p7-stack/runner-a/dsh-sessions', '/var/tmp/p7-stack/runner-b/dsh-sessions'):
        for sid in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            h = hashlib.sha256()
            for root, dirs, files in sorted(os.walk(os.path.join(base, sid))):
                dirs.sort()
                for f in sorted(files):
                    p = os.path.join(root, f)
                    h.update(p.encode()); h.update(open(p, 'rb').read())
            print(base.split('/')[-2], sid, h.hexdigest()[:16])
    else:
        sys.exit(__doc__)

if __name__ == '__main__':
    main(sys.argv[1:])
