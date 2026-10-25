#!/usr/bin/env python3
"""Drive the real agy 1.4.3 against the local mock Gemini, offline (docs/antigravity-runtime-contract.md §17).

Usage: python3 -I drive.py <run-name> <script-file> [--raw] [--hooks] [--mcp] [--default-mode] [--print-hooks]

  --raw           use the mock built with MOCK_RAW_ARGS support (see README), which sends a scripted call's
                  arguments as written instead of only the ones the request declares
  --hooks         write <gd>/config/hooks.json: a PreToolUse hook that logs and allows, a PreInvocation that logs
  --mcp           write <gd>/config/mcp_config.json with fakemcp.py as server "fake"
  --default-mode  leave out --dangerously-skip-permissions (agy's own refusals, contract §5.2)
  --print-hooks   also run `agy --print=/hooks --output-format json` on the same directory first

Every run gets a fresh HOME, gemini dir and workspace under ROOT/runs/<run-name>, so nobody's ~/.gemini is
touched, and every agy start carries AGY_CLI_DISABLE_AUTO_UPDATE=true, so the binary is never replaced (§6).
"""
import json, os, subprocess, sys, tempfile, time

AGY = '/root/.local/bin/agy'
ROOT = '/var/tmp/agy143-doc'          # scratch root: runs/ and bin/ (the two mock builds) live here
HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    name, script_file = sys.argv[1], sys.argv[2]
    flags = set(sys.argv[3:])
    out = os.path.join(ROOT, 'runs', name)
    # A fresh directory per run: the mock appends to its log and the hook to its own, and a mock.url left by
    # an earlier run would point agy at a port nobody listens on.
    os.makedirs(out)
    home = tempfile.mkdtemp(prefix='home-', dir=out)
    gd = tempfile.mkdtemp(prefix='gd-', dir=out)
    ws = tempfile.mkdtemp(prefix='ws-', dir=out)
    os.makedirs(os.path.join(gd, 'antigravity-cli'), exist_ok=True)
    with open(os.path.join(gd, 'antigravity-cli', 'settings.json'), 'w') as f:
        json.dump({'modelProvider': 'gemini', 'enableTelemetry': False}, f)
    if '--hooks' in flags:
        os.makedirs(os.path.join(gd, 'config'), exist_ok=True)
        hook = os.path.join(HERE, 'hook.py')
        log = os.path.join(out, 'hooks.jsonl')
        with open(os.path.join(gd, 'config', 'hooks.json'), 'w') as f:
            json.dump({'exp': {
                'PreToolUse': [{'matcher': '', 'hooks': [{'type': 'command', 'timeout': 60,
                                'command': f"python3 -I {hook} PreToolUse {log}"}]}],
                'PreInvocation': [{'type': 'command', 'timeout': 30,
                                   'command': f"python3 -I {hook} PreInvocation {log}"}],
            }}, f)
    if '--mcp' in flags:
        os.makedirs(os.path.join(gd, 'config'), exist_ok=True)
        with open(os.path.join(gd, 'config', 'mcp_config.json'), 'w') as f:
            json.dump({'mcpServers': {'fake': {'command': 'python3',
                                               'args': ['-I', os.path.join(HERE, 'fakemcp.py'), 'fake']}}}, f)
    with open(os.path.join(ws, 'seed.txt'), 'w') as f:
        f.write('alpha\nbeta\n')
    mock = os.path.join(ROOT, 'bin', 'mockgemini-raw' if '--raw' in flags else 'mockgemini')
    url_file = os.path.join(out, 'mock.url')
    menv = dict(os.environ)
    if '--raw' in flags:
        menv['MOCK_RAW_ARGS'] = '1'
    mp = subprocess.Popen([mock, '-log', os.path.join(out, 'requests.jsonl'), '-url-file', url_file],
                          stdout=open(os.path.join(out, 'mock.stdout'), 'w'), stderr=subprocess.STDOUT, env=menv)
    for _ in range(100):
        if os.path.exists(url_file) and open(url_file).read().strip():
            break
        time.sleep(0.05)
    url = open(url_file).read().strip()
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': home, 'GEMINI_API_KEY': 'mock-key',
           'GOOGLE_GEMINI_BASE_URL': url, 'HTTPS_PROXY': url, 'AGY_CLI_DISABLE_AUTO_UPDATE': 'true'}
    argv = [AGY, f'--gemini_dir={gd}', '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
            '--disable-slash-commands', '--print-timeout=0s']
    if '--default-mode' not in flags:
        argv.append('--dangerously-skip-permissions')
    script = open(script_file).read().replace('@WS@', ws)
    stdin = json.dumps({'event': 'user', 'message': {'content': script}}) + '\n'
    if '--print-hooks' in flags:
        r = subprocess.run([AGY, f'--gemini_dir={gd}', '--print=/hooks', '--output-format', 'json'],
                           cwd=ws, env=env, capture_output=True, text=True, timeout=120)
        open(os.path.join(out, 'print-hooks.stdout'), 'w').write(r.stdout)
        open(os.path.join(out, 'print-hooks.stderr'), 'w').write(r.stderr)
    p = subprocess.run(argv, cwd=ws, env=env, input=stdin, capture_output=True, text=True, timeout=300)
    open(os.path.join(out, 'stdout.jsonl'), 'w').write(p.stdout)
    open(os.path.join(out, 'stderr.txt'), 'w').write(p.stderr)
    mp.terminate()
    mp.wait()
    new_home = sorted(os.path.relpath(os.path.join(d, f), home) for d, _, fs in os.walk(home) for f in fs)
    meta = {'argv': argv, 'exit': p.returncode, 'ws': ws, 'gd': gd, 'flags': sorted(flags),
            'files_under_home': new_home, 'workspace_after': sorted(os.listdir(ws))}
    open(os.path.join(out, 'meta.json'), 'w').write(json.dumps(meta, indent=1))
    print('exit', p.returncode, '| files under temp HOME:', len(new_home))


if __name__ == '__main__':
    main()
