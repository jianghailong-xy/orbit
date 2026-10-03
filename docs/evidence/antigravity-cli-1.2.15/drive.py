#!/usr/bin/env python3
"""Experiment driver for agy against mockgemini (scratch, not committed).

usage: drive.py <name> <scenario.json>
scenario keys:
  args        extra agy args (default stream-json print mode); --gemini_dir is prepended unless "gd": false
  settings    dict merged over {"modelProvider":"gemini"}, written to <gd>/antigravity-cli/settings.json
  files       {"gd:rel" | "ws:rel" | "home:rel" | "/abs": str|json}
  env         extra env (null value removes)
  gd          path to reuse as gemini dir (default <run>/gd); false = plain HOME mode
  cwd         workspace (default <run>/ws)
  steps       [{"send": text} | {"send_raw": line} | {"wait_result": n, "timeout": s} | {"sleep": s}
               | {"signal": "INT", "group": bool} | {"close_stdin": true} | {"wait_exit": s}
               | {"wait_event": substr, "timeout": s} | {"ps": label}]
  mock_args, tunnel, keep_group, final_wait, agy
"""
import json, os, signal, subprocess, sys, threading, time, shutil

ROOT = '/var/tmp/agy-c0'
name, scen_path = sys.argv[1], sys.argv[2]
scen = json.load(open(scen_path))
run = os.path.join(ROOT, 'runs', name)
if not scen.get('keep_run_dir'):
    shutil.rmtree(run, ignore_errors=True)
os.makedirs(run, exist_ok=True)
home = scen.get('home') or os.path.join(run, 'home')
os.makedirs(home, exist_ok=True)
ws = scen.get('cwd') or os.path.join(run, 'ws')
os.makedirs(ws, exist_ok=True)
gd = scen.get('gd', os.path.join(run, 'gd'))
if gd:
    os.makedirs(os.path.join(gd, 'antigravity-cli'), exist_ok=True)

if 'settings' not in scen or scen['settings'] is not None:
    settings = {'modelProvider': 'gemini'}
    settings.update(scen.get('settings') or {})
    base = gd if gd else os.path.join(home, '.gemini')
    sp = os.path.join(base, 'antigravity-cli/settings.json')
    os.makedirs(os.path.dirname(sp), exist_ok=True)
    json.dump(settings, open(sp, 'w'), indent=2)
for rel, body in scen.get('files', {}).items():
    if rel.startswith('gd:'):
        p = os.path.join(gd, rel[3:])
    elif rel.startswith('ws:'):
        p = os.path.join(ws, rel[3:])
    elif rel.startswith('home:'):
        p = os.path.join(home, rel[5:])
    else:
        p = rel
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        f.write(body if isinstance(body, str) else json.dumps(body, indent=2))
    if p.endswith('.sh') or p.endswith('.py'):
        os.chmod(p, 0o755)
if scen.get('setup'):
    subprocess.run(['bash','-c',scen['setup']], cwd=ws, check=True, capture_output=True)
stamp = os.path.join(run, '.stamp')
open(stamp, 'w').close()
time.sleep(0.01)

mock_log = os.path.join(run, 'mock.jsonl')
url_file = os.path.join(run, 'mock.url')
if os.path.exists(url_file):
    os.remove(url_file)
margs = [os.path.join(ROOT, 'mockgemini'), '-log', mock_log, '-url-file', url_file] + scen.get('mock_args', [])
if scen.get('tunnel'):
    margs.append('-tunnel')
mock = subprocess.Popen(margs, stdout=subprocess.DEVNULL, stderr=open(os.path.join(run, 'mock.stderr'), 'w'))
for _ in range(200):
    if os.path.exists(url_file) and open(url_file).read().strip():
        break
    time.sleep(0.05)
url = open(url_file).read().strip()

env = {
    'PATH': '/root/.local/bin:/usr/local/bin:/usr/bin:/bin',
    'HOME': home,
    'TERM': 'dumb',
    'LANG': 'C.UTF-8',
    'GEMINI_API_KEY': 'mock-key-0123456789',
    'GOOGLE_GEMINI_BASE_URL': url,
    'HTTPS_PROXY': url, 'HTTP_PROXY': url, 'https_proxy': url, 'http_proxy': url,
}
env.update(scen.get('env', {}))
for k, v in list(env.items()):
    if v is None:
        del env[k]
agy = scen.get('agy', '/root/.local/bin/agy')
args = scen.get('args', ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json'])
if gd:
    args = ['--gemini_dir=' + gd] + args
argv = [agy] + args
json.dump({'argv': argv, 'env': {k: v for k, v in env.items() if k != 'GEMINI_API_KEY'}}, open(os.path.join(run, 'argv.json'), 'w'), indent=1)
t0 = time.time()
proc = subprocess.Popen(argv, cwd=ws, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, start_new_session=True)
events = []
lock = threading.Lock()
out_f = open(os.path.join(run, 'stdout.jsonl'), 'w')
err_f = open(os.path.join(run, 'stderr.txt'), 'w')

def rd_out():
    for raw in proc.stdout:
        line = raw.decode('utf-8', 'replace').rstrip('\n')
        t = round(time.time() - t0, 3)
        with lock:
            events.append((t, line))
        out_f.write(json.dumps({'t': t, 'line': line}) + '\n'); out_f.flush()

def rd_err():
    for raw in proc.stderr:
        t = round(time.time() - t0, 3)
        err_f.write(f'[{t}] ' + raw.decode('utf-8', 'replace')); err_f.flush()

th1 = threading.Thread(target=rd_out, daemon=True); th1.start()
th2 = threading.Thread(target=rd_err, daemon=True); th2.start()

def results():
    with lock:
        return sum(1 for _, l in events if l.startswith('{"event":"result"'))

log = open(os.path.join(run, 'steps.txt'), 'w')
def note(s):
    t = round(time.time() - t0, 3)
    log.write(f'[{t}] {s}\n'); log.flush()

def ps_tree(label):
    out = subprocess.run(['ps', '-eo', 'pid,ppid,pgid,sid,stat,etimes,args', '--forest'], capture_output=True, text=True).stdout
    keep = [l for l in out.splitlines() if (str(proc.pid) in l) or ('agy' in l and run in l) or ('webm' in l)]
    # members of the session/pgid
    rows = []
    for l in out.splitlines()[1:]:
        f = l.split(None, 6)
        if len(f) >= 7 and (f[2] == str(proc.pid) or f[3] == str(proc.pid) or f[1] == str(proc.pid)):
            rows.append(l)
    note(f'ps[{label}]:\n    ' + '\n    '.join(rows or ['<none>']))

for step in scen.get('steps', []):
    if 'send' in step or 'send_raw' in step:
        line = step.get('send_raw') or json.dumps({'event': 'user', 'message': {'content': step['send']}})
        note('send ' + line[:160])
        try:
            proc.stdin.write((line + '\n').encode()); proc.stdin.flush()
        except BrokenPipeError:
            note('stdin broken')
    elif 'wait_result' in step:
        deadline = time.time() + step.get('timeout', 120)
        while results() < step['wait_result'] and time.time() < deadline and proc.poll() is None:
            time.sleep(0.05)
        note(f'results={results()} exit={proc.poll()}')
    elif 'wait_event' in step:
        deadline = time.time() + step.get('timeout', 60)
        found = False
        while time.time() < deadline and not found:
            with lock:
                found = any(step['wait_event'] in l for _, l in events)
            if proc.poll() is not None:
                break
            time.sleep(0.02)
        note(f'wait_event {step["wait_event"]!r} found={found}')
    elif 'sleep' in step:
        time.sleep(step['sleep']); note(f'slept {step["sleep"]}')
    elif 'signal' in step:
        sig = getattr(signal, 'SIG' + step['signal'])
        if step.get('group', False):
            os.killpg(proc.pid, sig)
        else:
            proc.send_signal(sig)
        note(f'signal {step["signal"]} group={step.get("group", False)}')
    elif 'close_stdin' in step:
        try:
            proc.stdin.close()
        except Exception:
            pass
        note('stdin closed')
    elif 'wait_exit' in step:
        try:
            proc.wait(timeout=step['wait_exit'])
        except subprocess.TimeoutExpired:
            pass
        note(f'exit={proc.poll()}')
    elif 'ps' in step:
        ps_tree(step['ps'])

if proc.poll() is None:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=scen.get('final_wait', 15))
    except subprocess.TimeoutExpired:
        note('still running; SIGKILL group')
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
th1.join(2); th2.join(2)
note(f'final exit={proc.returncode}')
time.sleep(0.3)
leftover = subprocess.run(['ps', '-eo', 'pid,ppid,pgid,sid,stat,args'], capture_output=True, text=True).stdout.splitlines()
mine = [l for l in leftover[1:] if len(l.split(None, 5)) > 3 and (l.split(None, 5)[2] == str(proc.pid) or l.split(None, 5)[3] == str(proc.pid))]
note('leftover in pgid/sid: ' + (' | '.join(mine) if mine else 'none'))
if mine and not scen.get('keep_group'):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
if not scen.get('keep_mock'):
    mock.terminate(); mock.wait()
new_home = subprocess.run(['find', home, '-newer', stamp], capture_output=True, text=True).stdout.split()
note('new files under HOME: ' + (str(len(new_home)) + ' ' + ' '.join(new_home[:5]) if new_home else 'none'))
print(json.dumps({'run': run, 'exit': proc.returncode, 'events': len(events), 'results': results()}))
