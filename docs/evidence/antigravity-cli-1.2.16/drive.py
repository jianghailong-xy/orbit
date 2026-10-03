#!/usr/bin/env python3
"""Drive agy over stream-json against mockgemini. Usage: drive.py <scenario.json>
scenario: {name, flags:[...], hooks:{...}|null, settings:{...}, ctl:{...}, messages:[...], env:{...}, keep_dir:bool, timeout:secs}
"""
import json, os, subprocess, sys, time, threading, shutil, signal
ROOT = '/var/tmp/agy-p3'
sc = json.load(open(sys.argv[1]))
name = sc['name']
run = os.path.join(ROOT, 'runs', name)
shutil.rmtree(run, ignore_errors=True)
os.makedirs(run)
home = os.path.join(run, 'home'); os.makedirs(home)
gd = os.path.join(run, 'gd'); os.makedirs(os.path.join(gd, 'antigravity-cli')); os.makedirs(os.path.join(gd, 'config'))
work = os.path.join(run, 'work'); os.makedirs(work)
subprocess.run(['git', 'init', '-q', work])
settings = {'modelProvider': 'gemini', 'enableTelemetry': False}
settings.update(sc.get('settings', {}))
json.dump(settings, open(os.path.join(gd, 'antigravity-cli', 'settings.json'), 'w'))
if sc.get('hooks') is not None:
    hooks = json.dumps(sc['hooks']).replace('$HOOK', ROOT + '/hook.py')
    open(os.path.join(gd, 'config', 'hooks.json'), 'w').write(hooks)
if sc.get('mcp') is not None:
    json.dump(sc['mcp'], open(os.path.join(gd, 'config', 'mcp_config.json'), 'w'))
os.makedirs(os.path.join(ROOT, 'sharedbin'), exist_ok=True)
try:
    os.symlink(os.path.join(ROOT, 'sharedbin'), os.path.join(gd, 'antigravity-cli', 'bin'))
except FileExistsError:
    pass
json.dump(sc.get('ctl', {}), open(os.path.join(run, 'ctl.json'), 'w'))
mocklog = os.path.join(run, 'mock.jsonl'); urlf = os.path.join(run, 'mock.url')
mock = subprocess.Popen([ROOT + '/mockgemini', '-log', mocklog, '-url-file', urlf, '-chunk-delay', '5ms'], stdout=subprocess.DEVNULL)
for _ in range(200):
    if os.path.exists(urlf) and open(urlf).read().strip():
        break
    time.sleep(0.05)
url = open(urlf).read().strip()
env = {'PATH': os.environ['PATH'], 'HOME': home, 'GEMINI_API_KEY': 'mock-key-0123456789', 'GOOGLE_GEMINI_BASE_URL': url,
       'HTTPS_PROXY': url, 'HTTP_PROXY': url, 'https_proxy': url, 'http_proxy': url, 'AGY_CLI_DISABLE_AUTO_UPDATE': 'true',
       'HOOKLOG': os.path.join(run, 'hooks.log'), 'HOOKCTL': os.path.join(run, 'ctl.json'), 'EXP_RUN': name, 'ORBIT_SESSION_ID': 'exp-' + name}
env.update(sc.get('env', {}))
CONV = {'id': ''}
def subst(s):
    return s.replace('$WORK', work).replace('$RUN', run).replace('$GD', gd).replace('$CONV', CONV['id'])
if sc.get('print'):
    args = ['agy', '--gemini_dir=' + gd] + [subst(a) for a in sc['print']]
    t0 = time.time()
    p = subprocess.run(args, cwd=work, env=env, capture_output=True, text=True, timeout=sc.get('timeout', 120))
    print('EXIT', p.returncode, 'in %.2fs' % (time.time() - t0))
    print('STDOUT', p.stdout[:20000])
    print('STDERR', p.stderr[-3000:])
    mock.terminate()
    sys.exit(0)
args = ['agy', '--gemini_dir=' + gd, '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--disable-slash-commands', '--print-timeout=0s'] + sc.get('flags', [])
t0 = time.time()
proc = subprocess.Popen(args, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
out = open(os.path.join(run, 'stdout.jsonl'), 'w')
results = []
lock = threading.Condition()
def rd():
    for line in proc.stdout:
        ts = time.time() - t0
        out.write(line); out.flush()
        try:
            ev = json.loads(line)
        except Exception:
            print('%7.3f RAW %s' % (ts, line.strip()[:300])); continue
        e = ev.get('event')
        if e == 'step_update':
            s = ev['step_update']
            ti = s.get('tool_info') or {}
            extra = ''
            if ti:
                extra = ' tool=%s params=%s out=%s err=%s' % (ti.get('name'), json.dumps(ti.get('parameters'))[:200], json.dumps(ti.get('output'))[:200], json.dumps(ti.get('error'))[:300])
            if s.get('text_delta'):
                extra += ' text=%r' % s['text_delta'][:120]
            print('%7.3f step %s %s %s%s' % (ts, s.get('step_index'), s.get('step_type'), s.get('state'), extra))
        elif e == 'result':
            r = ev['result']
            print('%7.3f RESULT status=%s err=%r resp=%r denied=%s' % (ts, r.get('status'), r.get('error'), (r.get('response') or '')[:200], r.get('denied_actions')))
            with lock:
                results.append(r); lock.notify_all()
        elif e == 'init':
            CONV['id'] = ev.get('conversation_id') or ''
            print('%7.3f INIT %s mode=%s tools=%d' % (ts, ev.get('conversation_id'), ev['init'].get('permission_mode'), len(ev['init'].get('tools') or [])))
            json.dump(ev, open(os.path.join(run, 'init.json'), 'w'))
        else:
            print('%7.3f %s' % (ts, line.strip()[:300]))
    with lock:
        lock.notify_all()
errlines = []
def rde():
    for line in proc.stderr:
        errlines.append('%7.3f %s' % (time.time() - t0, line.rstrip()))
threading.Thread(target=rd, daemon=True).start()
threading.Thread(target=rde, daemon=True).start()
for i, m in enumerate(sc['messages']):
    if isinstance(m, dict) and 'sleep' in m:
        time.sleep(m['sleep']); continue
    if isinstance(m, dict) and 'signal' in m:
        os.killpg(proc.pid, getattr(signal, m['signal'])); continue
    if isinstance(m, dict) and 'ctl' in m:
        json.dump(m['ctl'], open(os.path.join(run, 'ctl.json'), 'w')); continue
    if isinstance(m, dict) and 'shell' in m:
        print('SHELL', subprocess.run(subst(m['shell']), shell=True, capture_output=True, text=True).stdout); continue
    want = len(results) + 1
    proc.stdin.write(json.dumps({'event': 'user', 'message': {'content': subst(m)}}) + '\n'); proc.stdin.flush()
    print('%7.3f >>> sent message %d' % (time.time() - t0, i))
    with lock:
        deadline = time.time() + sc.get('timeout', 120)
        while len(results) < want and proc.poll() is None and time.time() < deadline:
            lock.wait(1)
try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(sc.get('timeout', 120))
except subprocess.TimeoutExpired:
    print('TIMEOUT; killing'); os.killpg(proc.pid, signal.SIGKILL); proc.wait()
time.sleep(0.3)
print('EXIT', proc.returncode, 'after %.2fs' % (time.time() - t0))
print('STDERR:')
for l in errlines[-40:]:
    print('  ', l[:400])
mock.terminate()
hl = os.path.join(run, 'hooks.log')
if os.path.exists(hl):
    print('HOOKS:')
    for l in open(hl):
        r = json.loads(l)
        p = r['payload']
        print('  %.3f %s pid=%s ppid=%s pgid=%s keys=%s tc=%s inv=%s argv=%s' % (r['t'] - t0, r['event'], r['pid'], r['ppid'], r['pgid'], sorted(p.keys()) if isinstance(p, dict) else '?', json.dumps(p.get('toolCall'))[:300] if isinstance(p, dict) else '', p.get('invocationNum') if isinstance(p, dict) else '', r['argv'][1:]))
