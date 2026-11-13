#!/usr/bin/env python3
"""A FAKE Anthropic-dialect model endpoint for the lab's model-free runner checks.

It is not a model and its answers are not engine acceptance: it lets Claude Code in the lab's
runner Pod complete turns without any key or outbound call, so that persistence, resumption and
drain can be checked deterministically before (and besides) a real session. Listens on 127.0.0.1
only; Pods reach it at http://10.0.2.2:PORT through the QEMU user network.

Every request is appended to the log as one JSON line: the message count and the last user text,
so a resumed engine visibly sends the history it reloaded from the persistent volume.
  - "FAKE-SLOW <seconds>" in the last user message holds the streamed answer open that long
    (pings meanwhile), for a turn that is in flight when the runner is asked to stop.
  - The answer quotes every "T03-SECRET <word>" found anywhere in the conversation it was sent.
  - "FAKE-BG <seconds>" in the last user message: the answer (once per conversation) is a call of the runner's own
    mcp__orbit__bg_run tool, `sleep <seconds>` as a job with wakeOnExit, so the runner hosts a real
    background job (task T06: a runner that may not sleep while it runs).
  - "FAKE-WAKEUP <seconds> <word>" in the last user message: a call (once per conversation) of mcp__orbit__schedule_wakeup,
    so the control plane holds a wakeup for the session that comes due <seconds> later.
  - "FAKE-APIERR <n> <word>" anywhere in the conversation: the first <n> requests that carry it are
    answered with Claude Code's own API-error sentence for an overloaded provider (529), which the
    control plane arms an automatic retry for; the request after them is answered as usual.
  - "FAKE-WRITE <word>" in the last user message: a call (once per word and conversation) of Claude Code's
    own Bash tool, run in the session's working directory (its Git worktree): it writes t08-<word>.txt,
    commits it and prints "T08-WROTE-<WORD> <commit> <file SHA-256 prefix>" (task T08).
  - "FAKE-HOLD <seconds>" in the last user message: the answer to a tool's result is held open that long
    (pings meanwhile), so the turn is still in flight after its tool ran (task T02c: a power cut in a turn
    whose engine has just committed).
  - "FAKE-LOOP <cycles> <files> <think ms> <word>" in the turn's message: an engine's tool loop (task D10). The answers
    are calls of Claude Code's Bash tool in the session's worktree, one after each tool result: <cycles> times an edit
    (src/), a `git add` and `git commit` that prints "D10-COMMIT <word> <k> rc=<exit> us=<microseconds>", and a build
    that writes <files> new files of 4-16 KiB under build/ (ignored by Git) and prints "D10-BUILD ... us=<microseconds>";
    then one more edit, left uncommitted for the runner's own commit, and a text answer. Every answer of the loop waits
    <think ms> first, as a model's step would.
  - A request whose last message carries a tool result is answered with text that quotes it.
  - A drill turn of the long-running-loop acceptance (scripts/long-running-loops/drill.py) lists tool calls in its
    message, made one after another, each after the previous one's result, then a text answer:
      "FAKE-RECUR <every> <until s> <word> [<slow s> <delay s>]": mcp__orbit__schedule_wakeup({recurring: true,
        everySeconds, prompt, reason, until}), until <until s> from now; with <slow s> > 0, the loop's prompt carries
        "FAKE-SLOW <slow s>", so the answer of every tick is held open that long, and <delay s> is its delaySeconds;
      "FAKE-STALL <seconds> <after> <word>": mcp__orbit__bg_run of `sleep <seconds>` as a job with wakeOnStall
        {afterSeconds: <after>};
      "FAKE-STOP <n> <word>": <n> calls of mcp__orbit__schedule_wakeup({stop: true}), one after another;
      "FAKE-GET <session id> <word>": mcp__orbit__session_get of that session.
    A call is made only in a request that offers its tool, or once a ToolSearch call of this conversation has loaded it
    (Claude Code defers MCP tools: the request lists only their names, and the answer calls ToolSearch with
    "select:<tool>" first). The log keeps those tools' results whole (toolResults), and
    the whole text of a turn that carries a <scheduled-wakeup> or <background-job-...> block (turnText).
  - Every "T06-<WORD>" (or T02's "T02-<WORD>", T02c's "T02C-<WORD>", T07's "T07-<WORD>", T08's "T08-<WORD>", T08x's
    "T08X-<WORD>", D10's "D10-<WORD>", the loop drill's "LRL-<WORD>") marker in the last user message is quoted after
    "Answering:", so a driver can tell which message an answer belongs to.
Usage: fake-model.py PORT LOG
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import sys
import threading
import time

PORT, LOG = int(sys.argv[1]), sys.argv[2]
lock = threading.Lock()
counter = [0]
failures = {}  # FAKE-APIERR word -> requests answered with the API error so far
slow_seen = set()  # FAKE-SLOW-ONCE words whose first answer has been held (drill copy, task 34sXBd0MjNidijPGNeaHP)
MARKERS = re.compile(r'(?:T0(?:2C|[2678]|8X)|D10|LRL)-[A-Z0-9-]+')


def texts(content):
    if isinstance(content, str):
        return [content]
    return [part.get('text', '') for part in content or [] if isinstance(part, dict) and part.get('type') == 'text']


def tool_results(message):
    """The text of each tool result the message carries (a user message answering a tool call)."""
    found = []
    for part in message.get('content') or [] if isinstance(message.get('content'), list) else []:
        if isinstance(part, dict) and part.get('type') == 'tool_result':
            inner = part.get('content')
            found.append(' '.join(texts(inner)) if not isinstance(inner, str) else inner)
    return found


def parts(message):
    content = message.get('content')
    return [p for p in content if isinstance(p, dict)] if isinstance(content, list) else [{'type': 'text', 'text': content or ''}]


def already_called(messages, name, same_input=None):
    """Whether an answer in this conversation already called the tool: one call per conversation and tool
    (and, given same_input, per input)."""
    return any(p.get('type') == 'tool_use' and p.get('name') == name and (same_input is None or p.get('input') == same_input)
               for m in messages if m.get('role') == 'assistant' for p in parts(m))


def tool_call(last, offered):
    """The tool call a FAKE-BG, FAKE-WRITE or FAKE-WAKEUP message asks for, as (name, input), or None."""
    background = re.search(r'FAKE-BG (\d+)', last)
    if background:
        return 'mcp__orbit__bg_run', {'command': f'sleep {background[1]}', 'kind': 'job', 'wakeOnExit': True}
    write = re.search(r'FAKE-WRITE (\w+)', last)
    if write:
        word = write[1].lower()
        name = f't08-{word}.txt'
        return 'Bash', {'command': f"printf 'T08 {word}\\n' > {name} && git add {name} && git commit -q -m 'T08 {word}' && "
                                   f"echo T08-WROTE-{word.upper()} $(git rev-parse HEAD) $(sha256sum {name} | cut -c1-16)",
                        'description': f'T08 lab: write and commit {name}'}
    wakeup = re.search(r'FAKE-WAKEUP (\d+) (\w+)', last)
    if wakeup:
        return 'mcp__orbit__schedule_wakeup', {'delaySeconds': int(wakeup[1]), 'reason': f'T06 lab: scheduled wake {wakeup[2]}',
                                              'prompt': f'T06-WOKE-{wakeup[2].upper()}: the scheduled wakeup came due'}
    return None


def loop_state(messages):
    """The FAKE-LOOP of the turn in flight, as (cycles, files, think seconds, word, tool calls made so far), or None. The
    turn's message is the last user message with text and no tool result; the loop's calls are the answers' Bash calls
    since, which its descriptions name."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get('role') != 'user' or tool_results(message) or not any(texts(message.get('content'))):
            continue
        found = [hit for hit in (re.search(r'FAKE-LOOP (\d+) (\d+) (\d+) (\w+)', t) for t in texts(message.get('content'))) if hit]
        if not found:
            return None
        cycles, files, think, word = int(found[-1][1]), int(found[-1][2]), int(found[-1][3]) / 1000, found[-1][4].lower()
        made = sum(1 for later in messages[index + 1:] if later.get('role') == 'assistant' for p in parts(later)
                   if p.get('type') == 'tool_use' and str((p.get('input') or {}).get('description', '')).startswith(f'D10 {word} '))
        return cycles, files, think, word, made
    return None


PLAN_TOOLS = ('mcp__orbit__schedule_wakeup', 'mcp__orbit__bg_run', 'mcp__orbit__session_get')
PLAN = re.compile(r'FAKE-RECUR (\d+) (\d+) (\w+)(?: (\d+) (\d+)\b)?|FAKE-STALL (\d+) (\d+) (\w+)|FAKE-STOP (\d+) (\w+)|'
                  r'FAKE-GET (\S+) (\w+)')


def turn_message(messages):
    """The turn's message, as (index, text): the last user message with text and no tool result."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get('role') == 'user' and not tool_results(message) and any(texts(message.get('content'))):
            return index, ' '.join(texts(message.get('content')))
    return None, ''


def plan_steps(text, now):
    """The tool calls a drill turn's message lists, in order, as (name, input)."""
    steps = []
    for hit in PLAN.finditer(text):
        if hit[1]:
            word = hit[3].upper()
            prompt = f'LRL-TICK-{word}: a tick of the drill loop {word}; answer in one line.'
            if hit[4] and int(hit[4]) > 0:
                prompt += f' FAKE-SLOW {hit[4]} holds this answer open.'
            call = {'recurring': True, 'everySeconds': int(hit[1]), 'prompt': prompt, 'reason': f'LRL drill loop {word}',
                    'until': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now + int(hit[2])))}
            if hit[5]:
                call['delaySeconds'] = int(hit[5])
            steps.append(('mcp__orbit__schedule_wakeup', call))
        elif hit[6]:
            steps.append(('mcp__orbit__bg_run', {
                'command': f'sleep {hit[6]}', 'kind': 'job', 'wakeOnStall': {'afterSeconds': int(hit[7])},
                'description': f'LRL {hit[8].upper()}: a {hit[6]}-second sleep job, woken after {hit[7]} s without output'}))
        elif hit[9]:
            steps += [('mcp__orbit__schedule_wakeup', {'stop': True})] * int(hit[9])
        else:
            steps.append(('mcp__orbit__session_get', {'sessionId': hit[11]}))
    return steps


def tool_loaded(messages, name):
    """Whether an answer in this conversation loaded the deferred tool with ToolSearch."""
    return any(p.get('type') == 'tool_use' and p.get('name') == 'ToolSearch' and name in str((p.get('input') or {}).get('query', ''))
               for m in messages if m.get('role') == 'assistant' for p in parts(m))


def plan_state(messages):
    """A drill turn in flight, as (steps, calls made so far), or None: the calls are the answers' calls of the plan's
    tools since the turn's message."""
    index, text = turn_message(messages)
    steps = plan_steps(text, time.time()) if index is not None else []
    if not steps:
        return None
    made = sum(1 for later in messages[index + 1:] if later.get('role') == 'assistant' for p in parts(later)
               if p.get('type') == 'tool_use' and p.get('name') in PLAN_TOOLS)
    return steps, made


def named_tool_results(messages):
    """The plan tools' results the last message carries, whole, as [{name, text}]."""
    names = {p.get('id'): p.get('name') for m in messages if m.get('role') == 'assistant' for p in parts(m)
             if p.get('type') == 'tool_use'}
    found = []
    for part in parts(messages[-1]) if messages and messages[-1].get('role') == 'user' else []:
        if part.get('type') == 'tool_result' and names.get(part.get('tool_use_id')) in PLAN_TOOLS:
            inner = part.get('content')
            found.append({'name': names[part.get('tool_use_id')], 'isError': bool(part.get('is_error')),
                          'text': inner if isinstance(inner, str) else ' '.join(texts(inner))})
    return found


def loop_steps(cycles):
    """A loop's tool calls in order: each cycle edits, commits and builds; the last edit is left for the runner to commit."""
    return [(kind, k) for k in range(cycles) for kind in ('edit', 'commit', 'build')] + [('edit', cycles)]


def loop_call(kind, k, word, files):
    if kind == 'edit':
        command = (f"mkdir -p src && {{ grep -qx build/ .gitignore 2>/dev/null || echo build/ >> .gitignore; }} && "
                   f"date -u +%FT%T.%NZ >> src/log-{word}.txt && printf 'version={k}\\n' > src/version.txt && echo D10-EDITED {word} {k}")
    elif kind == 'commit':
        command = (f"s=$(date +%s%N); git add -A .gitignore src && git commit -q -m 'D10 {word} {k}'; rc=$?; e=$(date +%s%N); "
                   f"echo D10-COMMIT {word} {k} rc=$rc us=$(( (e - s) / 1000 ))")
    else:
        command = (f"s=$(date +%s%N); rm -rf build && python3 -c \"import os, sys; n = int(sys.argv[1]); os.makedirs('build/obj'); "
                   f"[open('build/obj/o%d.o' % i, 'wb').write(os.urandom(4096 + i * 2731 % 12288)) for i in range(n)]\" {files}; "
                   f"rc=$?; e=$(date +%s%N); echo D10-BUILD {word} {k} files={files} rc=$rc us=$(( (e - s) / 1000 ))")
    return 'Bash', {'command': command, 'description': f'D10 {word} {kind} {k}'}


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
        with lock, open(LOG, 'a') as log:
            log.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                  'method': self.command, 'path': self.path}) + '\n')
        model = re.search(r'/v1/models/([^/?]+)', self.path)
        if model:
            return self.reply(200, {'type': 'model', 'id': model[1], 'display_name': model[1],
                                    'created_at': '2026-01-01T00:00:00Z'})
        self.reply(404, {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'fake model'}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if self.path.endswith('/count_tokens'):
            return self.reply(200, {'input_tokens': 100})
        if not self.path.split('?')[0].endswith('/v1/messages'):
            return self.do_GET()
        messages = body.get('messages') or []
        users = [t for m in messages if m.get('role') == 'user' for t in texts(m.get('content'))]
        last = users[-1] if users else ''
        conversation = ' '.join(t for m in messages for t in texts(m.get('content')))
        secrets = sorted(set(re.findall(r'T03-SECRET (\w+)', conversation)))
        # The last user message, which Claude Code (2.1.300) follows with a `system` one.
        last_user = max((i for i, m in enumerate(messages) if m.get('role') == 'user'), default=None)
        last_assistant = max((i for i, m in enumerate(messages) if m.get('role') == 'assistant'), default=-1)
        results = tool_results(messages[last_user]) if last_user is not None and last_user > last_assistant else []
        offered = sorted(t.get('name') for t in body.get('tools') or [] if isinstance(t, dict)
                         and t.get('name') in ('mcp__orbit__bg_run', 'mcp__orbit__schedule_wakeup'))
        call = None if results else tool_call(last, offered)
        if call and already_called(messages, call[0], call[1] if call[0] == 'Bash' else None):
            call = None
        loop = loop_state(messages)
        if loop:
            steps = loop_steps(loop[0])
            call = loop_call(*steps[loop[4]], loop[3], loop[1]) if loop[4] < len(steps) else None
        plan = None if loop else plan_state(messages)
        offered_all = {t.get('name') for t in body.get('tools') or [] if isinstance(t, dict)}
        if plan:
            following = plan[0][plan[1]] if plan[1] < len(plan[0]) else None
            call = None
            if following and (following[0] in offered_all or tool_loaded(messages, following[0])):
                call = following
            elif following and 'ToolSearch' in offered_all:
                # Claude Code (2.1.316) defers MCP tools: only their names are listed, and a tool is called once
                # ToolSearch has loaded its schema, as a model has to.
                call = ('ToolSearch', {'query': f'select:{following[0]}', 'max_results': 5})
        _, turn_text = turn_message(messages)
        wake_text = turn_text if not results and ('<scheduled-wakeup>' in turn_text or '<background-job-' in turn_text) else None
        shape = [[m.get('role'), [p.get('type') for p in parts(m)]] for m in messages[-3:]]
        slow = None if results else (re.search(r'FAKE-SLOW (\d+)', last) or re.search(r'FAKE-SLOW (\d+)', turn_text))
        # "FAKE-SLOW-ONCE <seconds> <word>" in the last user message: only the first request carrying <word> is held.
        once = None if results else re.search(r'FAKE-SLOW-ONCE (\d+) (\w+)', last)
        hold = re.search(r'FAKE-HOLD (\d+)', ' '.join(users)) if results else None
        apierr = None if results else re.search(r'FAKE-APIERR (\d+) (\w+)', conversation)
        with lock:
            counter[0] += 1
            number = counter[0]
            failing = False
            if once:
                if once[2] in slow_seen:
                    once = None
                else:
                    slow_seen.add(once[2])
            if apierr and failures.get(apierr[2], 0) < int(apierr[1]):
                failures[apierr[2]] = failures.get(apierr[2], 0) + 1
                failing = True
            kind = ('loop_tool_use' if call else 'loop_done') if loop else \
                ('plan_tool_use' if call else 'plan_done' if plan[1] >= len(plan[0]) else 'plan_not_offered') if plan else \
                'tool_result_reply' if results else 'api_error' if failing else 'tool_use' if call else 'text'
            with open(LOG, 'a') as log:
                log.write(json.dumps({'n': number, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'path': self.path, 'model': body.get('model'), 'stream': body.get('stream'),
                                      'messages': len(messages), 'lastUser': last[-300:], 'secrets': secrets,
                                      'slow': int(slow[1]) if slow else int(once[1]) if once else 0, 'hold': int(hold[1]) if hold else 0, 'kind': kind, 'tool': call[0] if call else None,
                                      'offered': offered, 'toolResult': results[0][:300] if results else None, 'shape': shape,
                                      'apiErrors': {apierr[2]: failures.get(apierr[2], 0)} if apierr else None,
                                      'loop': {'word': loop[3], 'made': loop[4], 'of': len(steps)} if loop else None,
                                      'plan': {'steps': [name for name, _ in plan[0]], 'made': plan[1],
                                               'offered': sorted(offered_all & set(PLAN_TOOLS))} if plan else None,
                                      'toolResults': named_tool_results(messages) or None, 'turnText': wake_text,
                                      'turnMarkers': MARKERS.findall(turn_text) or None}) + '\n')
        if loop and not call:
            text = f'FAKE MODEL reply #{number}: loop {loop[3]} done after {loop[4]} tool calls.'
            markers = MARKERS.findall(last)
            if markers:
                text += f' Answering: {" ".join(markers)}'
        elif plan and not call:
            text = (f'FAKE MODEL reply #{number}: plan done after {plan[1]} tool call(s)' if plan[1] >= len(plan[0]) else
                    f'FAKE MODEL reply #{number}: {plan[0][plan[1]][0]} is not offered to this request')
            text += f'; last result: {results[0][:160]}.' if results else '.'
            markers = MARKERS.findall(turn_text)
            if markers:
                text += f' Answering: {" ".join(markers)}'
        elif results:
            text = f'FAKE MODEL reply #{number}: tool result received: {results[0][:160]}'
        elif failing:
            # Claude Code's own sentence once its retries of an overloaded provider are spent.
            text = ('API Error: 529 {"type":"error","error":{"type":"overloaded_error",'
                    f'"message":"Overloaded (FAKE MODEL {apierr[2]} {failures[apierr[2]]}/{apierr[1]})"}}}}')
        else:
            text = (f'FAKE MODEL reply #{number}: this conversation has {len(messages)} message(s); '
                    f'secrets seen: {", ".join(secrets) or "none"}.')
            markers = MARKERS.findall(last) or MARKERS.findall(turn_text)
            if markers:
                text += f' Answering: {" ".join(markers)}'
        if loop:
            # Drill copy (task 34sXBd0MjNidijPGNeaHP): once /work/fake-fast exists, a loop's steps no longer wait.
            time.sleep(0 if os.path.exists('/work/fake-fast') else loop[2])
        usage = {'input_tokens': 10, 'output_tokens': 20}
        message = {'id': f'msg_fake_{number}', 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                   'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
        tool_use = None
        if call and not failing:
            tool_use = {'type': 'tool_use', 'id': f'toolu_fake_{number}', 'name': call[0], 'input': call[1]}
        if not body.get('stream'):
            if tool_use:
                message.update(content=[tool_use], stop_reason='tool_use')
            else:
                message.update(content=[{'type': 'text', 'text': text}], stop_reason='end_turn')
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
            if tool_use:
                event('content_block_start', {'type': 'content_block_start', 'index': 0,
                                              'content_block': {**tool_use, 'input': {}}})
                event('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                              'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tool_use['input'])}})
                event('content_block_stop', {'type': 'content_block_stop', 'index': 0})
                event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None},
                                        'usage': {'output_tokens': 20}})
                event('message_stop', {'type': 'message_stop'})
                return
            event('content_block_start', {'type': 'content_block_start', 'index': 0,
                                          'content_block': {'type': 'text', 'text': ''}})
            deadline = time.monotonic() + (int(slow[1]) if slow else int(once[1]) if once else int(hold[1]) if hold else 0)
            while time.monotonic() < deadline:
                time.sleep(min(5, max(0, deadline - time.monotonic())))
                event('ping', {'type': 'ping'})
            event('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                          'delta': {'type': 'text_delta', 'text': text}})
            event('content_block_stop', {'type': 'content_block_stop', 'index': 0})
            event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                                    'usage': {'output_tokens': 20}})
            event('message_stop', {'type': 'message_stop'})
        except (BrokenPipeError, ConnectionResetError):
            with lock, open(LOG, 'a') as log:
                log.write(json.dumps({'n': number, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'disconnected': True}) + '\n')


ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
