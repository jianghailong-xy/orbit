#!/usr/bin/python3 -I
"""A scripted stand-in for the MODEL behind the real Claude Code CLI, for the revision 42 part one e2e (cases.mjs).

Not a model: no key, no network. It answers Anthropic's /v1/messages (streamed or not) on 127.0.0.1 so that the real
`claude` binary the runner launches, through an Orbit provider whose base URL names this server, completes real
turns: its own tool loop, its own Bash tool, its own MCP client and its own --resume of a session's history. The wire
shape (SSE events, ToolSearch before a deferred MCP tool) follows scripts/managed-runner/lab/fake-model.py.

What it answers is read off the conversation Claude Code sends, the turn's message (the last user text that is not a
tool result) first:

  E2E-MCP <id> <tool> <json>    call mcp__orbit__<tool> with that input (ToolSearch "select:" first when the tool is
                                deferred); the turn's answer quotes the result, and the result is logged as
                                {kind: "mcp", id, tool, isError, text}, the record lib.mjs#mcpAnswer waits for.
  E2E-DO: commit                one call of Claude Code's Bash tool in the session's checkout: append this task's work
                                file E2E_WORK_<task>.md, and with `E2E-SHARED: <file>` write that file as this task's
                                own line, commit both, and with `E2E-BARRIER <name> <n>` wait (at most 300 s) until <n>
                                runs have reached that barrier.
  Orbit could not land your work ...   the landing-fix turn (§12.5 W6). What to do is read from the EARLIER messages of
                                the same conversation, the `E2E-ONFIX: resolve|decline` the task's first turn carried:
                                found only if the CLI's --resume restored that history. `resolve`: one Bash call that
                                fetches, merges the branches the turn names ("1. Merge <target> and <upstream> ...")
                                into the session's branch, keeps both sides of every conflict and commits; `decline`:
                                no tool, the answer is DECLINE_WORDS; neither found: no tool, NO_HISTORY_WORDS.
  anything else                 a one-line acknowledgement.

A request with no tools is a side call of the CLI's: the Auto-mode permission classifier is answered
"<block>no</block>" (nothing blocked), anything else (titles, summaries) with a short line.
Every request is logged as one JSON line to LOG.

Usage: scripted-model.py PORT LOG
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import shlex
import sys
import threading
import time
import uuid

PORT, LOG = int(sys.argv[1]), sys.argv[2]
lock = threading.Lock()
counter = [0]
DECLINE_WORDS = ('LFX42 decline: this conflict is with another task\'s line in the same file, and which line stays is '
                 'not mine to decide, so I committed nothing. The coordinator should choose.')
NO_HISTORY_WORDS = 'LFX42: this conversation carries no E2E-ONFIX, so I do not know what my task asked; I committed nothing.'
IDENT = "-c user.name='LFX42 Scripted Model' -c user.email=model@lfx42.test"


def log(**rec):
    rec = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **rec}
    with lock, open(LOG, 'a') as f:
        f.write(json.dumps(rec) + '\n')


def parts(message):
    content = message.get('content')
    return [p for p in content if isinstance(p, dict)] if isinstance(content, list) else [{'type': 'text', 'text': content or ''}]


def texts(message):
    return [p.get('text') or '' for p in parts(message) if p.get('type') == 'text']


def results_of(message):
    found = []
    for p in parts(message):
        if p.get('type') == 'tool_result':
            inner = p.get('content')
            text = inner if isinstance(inner, str) else ' '.join(x.get('text', '') for x in inner or [] if isinstance(x, dict))
            found.append({'id': p.get('tool_use_id'), 'isError': bool(p.get('is_error')), 'text': text})
    return found


def turn_index(messages):
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get('role') == 'user' and not results_of(m) and any(t.strip() not in ('', '(no content)') for t in texts(m)):
            return i
    return None


def system_text(body):
    s = body.get('system')
    return s if isinstance(s, str) else ' '.join(x.get('text', '') for x in s or [] if isinstance(x, dict))


def work_command(text):
    shared = re.search(r'^E2E-SHARED:\s*(\S+)\s*$', text, re.M)
    bar = re.search(r'^E2E-BARRIER\s+(\S+)\s+(\d+)\s*$', text, re.M)
    lines = [
        'set -e',
        'f="E2E_WORK_${ORBIT_TASK_ID:-x}.md"',
        'printf -- "- %s %s\\n" "$(date -u +%FT%TZ)" "${ORBIT_TASK_ID:-x}" >> "$f"',
        'git add "$f"',
    ]
    if shared:
        name = shlex.quote(shared.group(1))
        lines += [f'printf "%s: this line is the work of this task\\n" "${{ORBIT_TASK_ID:-x}}" > {name}', f'git add {name}']
    lines += [f'git {IDENT} commit -q -m "e2e work for task ${{ORBIT_TASK_ID:-x}}"',
              'echo "LFX42-WORK committed $(git rev-parse HEAD) on $(git rev-parse --abbrev-ref HEAD)"']
    if bar:
        lines += ['python3 - "${LM_SCRATCH:-/tmp}/barrier-' + bar.group(1) + '" ' + bar.group(2) + " <<'PY'",
                  'import os, sys, time',
                  'path, n = sys.argv[1], int(sys.argv[2]); os.makedirs(path, exist_ok=True)',
                  "open(os.path.join(path, os.environ.get('ORBIT_TASK_ID') or str(os.getpid())), 'w').write(time.ctime())",
                  'end = time.time() + 300',
                  'while len(os.listdir(path)) < n and time.time() < end: time.sleep(1)',
                  "print('LFX42-BARRIER', path, sorted(os.listdir(path)))",
                  'sys.exit(0 if len(os.listdir(path)) >= n else 1)',
                  'PY']
    return {'command': '\n'.join(lines), 'timeout': 600000, 'description': 'LFX42: commit this task\'s work'}


def fix_command(text):
    m = re.search(r'^1\. Merge (\S+?)(?: and (\S+?))? into your branch', text, re.M)
    targets = [g for g in (m.groups() if m else ()) if g]
    quoted = ' '.join(shlex.quote(t) for t in targets)
    script = f'''set -e
git fetch -q origin
resolved=""
for t in {quoted}; do
  if ! out=$(git {IDENT} merge --no-edit "origin/$t" 2>&1); then
    files=$(git diff --name-only --diff-filter=U)
    [ -n "$files" ] || {{ echo "LFX42-FIX merge of origin/$t failed with no conflicted file: $out"; exit 1; }}
    for f in $files; do grep -vE '^(<<<<<<< |=======$|>>>>>>> )' "$f" > "$f.lfx42" || true; mv "$f.lfx42" "$f"; git add "$f"; done
    git {IDENT} commit -q --no-edit
    resolved="$resolved $files"
  fi
done
test -z "$(git status --porcelain)"
echo "LFX42-FIX merged {' '.join('origin/' + t for t in targets) or '(nothing named)'} into $(git rev-parse --abbrev-ref HEAD), kept both sides of${{resolved:- nothing}}, HEAD $(git rev-parse HEAD)"'''
    return {'command': script, 'timeout': 300000, 'description': 'LFX42: merge the line into this branch and commit the fix'}


def plan(messages, at):
    """(kind, steps, final words when no step is left) for the turn whose message is messages[at]."""
    text = '\n'.join(texts(messages[at]))
    calls = re.findall(r'^E2E-MCP\s+(\S+)\s+(\S+)\s+(\{.*\})\s*$', text, re.M)
    if calls:
        return 'mcp', [('mcp__orbit__' + tool, json.loads(raw), cid) for cid, tool, raw in calls], None
    if 'Orbit could not land your work' in text:
        earlier = '\n'.join(t for m in messages[:at] if m.get('role') == 'user' for t in texts(m))
        onfix = re.findall(r'^E2E-ONFIX:\s*(resolve|decline)\s*$', earlier, re.M)
        if not onfix:
            return 'fix-no-history', [], NO_HISTORY_WORDS
        if onfix[-1] == 'decline':
            return 'fix-decline', [], DECLINE_WORDS
        return 'fix-resolve', [('Bash', fix_command(text), None)], None
    if re.search(r'^E2E-DO:\s*commit', text, re.M):
        return 'work', [('Bash', work_command(text), None)], None
    return 'ack', [], 'LFX42 scripted model: acknowledged.'


def answer(body):
    """(content blocks, stop reason, log record)."""
    messages = body.get('messages') or []
    tools = {t.get('name') for t in body.get('tools') or [] if isinstance(t, dict)}
    if not tools:
        sys_text = system_text(body)
        classifier = 'security monitor' in sys_text.lower() or '<block>' in sys_text
        words = '<block>no</block>' if classifier else 'LFX42 scripted model'
        return [{'type': 'text', 'text': words}], 'end_turn', {'kind': 'classifier' if classifier else 'side-call'}
    at = turn_index(messages)
    if at is None:
        return [{'type': 'text', 'text': 'LFX42 scripted model: no message.'}], 'end_turn', {'kind': 'empty'}
    kind, steps, words = plan(messages, at)
    later = [p for m in messages[at + 1:] if m.get('role') == 'assistant' for p in parts(m) if p.get('type') == 'tool_use']
    made = [p for p in later if p.get('name') != 'ToolSearch']
    loaded = {q for p in later if p.get('name') == 'ToolSearch'
              for q in re.findall(r'mcp__\w+', str((p.get('input') or {}).get('query', '')))}
    names = {p.get('id'): p for p in later}
    results = [r for m in messages[at + 1:] if m.get('role') == 'user' for r in results_of(m)]
    last = results[-1] if results else None
    last_call = names.get(last['id']) if last else None
    rec = {'kind': kind, 'turn': ' '.join(texts(messages[at]))[:600], 'steps': len(steps), 'made': len(made),
           'shape': [[m.get('role'), [p.get('type') + (':' + (p.get('text') or '')[:24] if p.get('type') == 'text' else '')
                                      for p in parts(m)]] for m in messages[-6:]]}
    if last_call and last_call.get('name', '').startswith('mcp__orbit__'):
        step = next((s for s in steps if s[0] == last_call['name'] and s[1] == last_call.get('input')), None)
        if step:
            log(kind='mcp', id=step[2], tool=step[0][len('mcp__orbit__'):], arguments=step[1], isError=last['isError'],
                text=last['text'])
    if len(made) < len(steps):
        name, tool_input, _ = steps[len(made)]
        if name.startswith('mcp__') and name not in tools and name not in loaded:
            rec.update(tool='ToolSearch', toolFor=name)
            return [{'type': 'tool_use', 'id': f'toolu_lfx_{uuid.uuid4().hex[:20]}', 'name': 'ToolSearch',
                     'input': {'query': f'select:{name}', 'max_results': 5}}], 'tool_use', rec
        rec.update(tool=name)
        return [{'type': 'tool_use', 'id': f'toolu_lfx_{uuid.uuid4().hex[:20]}', 'name': name, 'input': tool_input}], 'tool_use', rec
    if words is None:
        done = [r for r in results if names.get(r['id'], {}).get('name') != 'ToolSearch']
        if kind == 'mcp':
            words = 'lm42 fake engine:\n' + '\n'.join(
                f'[{s[2]}] {s[0][len("mcp__orbit__"):]} -> {"ERROR " if r["isError"] else ""}{r["text"][:1500]}'
                for s, r in zip(steps, done))
        else:
            words = f'LFX42 scripted model ({kind}): ' + ' | '.join(r['text'][-400:] for r in done)
    rec.update(final=words[:300], results=[r['text'][-300:] for r in results])
    return [{'type': 'text', 'text': words}], 'end_turn', rec


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        model = re.search(r'/v1/models/([^/?]+)', self.path)
        if model:
            return self.reply(200, {'type': 'model', 'id': model[1], 'display_name': model[1], 'created_at': '2026-01-01T00:00:00Z'})
        if self.path.split('?')[0].endswith('/v1/models'):
            return self.reply(200, {'data': [], 'has_more': False, 'first_id': None, 'last_id': None})
        self.reply(404, {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'lfx42 scripted model'}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        path = self.path.split('?')[0]
        if path.endswith('/count_tokens'):
            return self.reply(200, {'input_tokens': 100})
        if not path.endswith('/v1/messages'):
            return self.do_GET()
        with lock:
            counter[0] += 1
            number = counter[0]
        try:
            content, stop, rec = answer(body)
        except Exception as e:  # noqa: BLE001 - say it, never hang the CLI
            content, stop, rec = [{'type': 'text', 'text': f'LFX42 scripted model error: {e}'}], 'end_turn', {'kind': 'error', 'error': str(e)}
        log(n=number, path=self.path, model=body.get('model'), stream=bool(body.get('stream')),
            messages=len(body.get('messages') or []), tools=len(body.get('tools') or []), **rec)
        usage = {'input_tokens': 10, 'output_tokens': 20, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        message = {'id': f'msg_lfx_{number}', 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                   'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
        if not body.get('stream'):
            message.update(content=content, stop_reason=stop)
            return self.reply(200, message)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def event(name, data):
            self.wfile.write(f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode())
            self.wfile.flush()
        try:
            event('message_start', {'type': 'message_start', 'message': message})
            for index, block in enumerate(content):
                if block['type'] == 'tool_use':
                    event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': {**block, 'input': {}}})
                    event('content_block_delta', {'type': 'content_block_delta', 'index': index,
                                                  'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}})
                else:
                    event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}})
                    event('content_block_delta', {'type': 'content_block_delta', 'index': index,
                                                  'delta': {'type': 'text_delta', 'text': block['text']}})
                event('content_block_stop', {'type': 'content_block_stop', 'index': index})
            event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                                    'usage': {'output_tokens': 20}})
            event('message_stop', {'type': 'message_stop'})
        except (BrokenPipeError, ConnectionResetError):
            log(n=number, disconnected=True)


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
