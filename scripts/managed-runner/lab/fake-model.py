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
  - A request whose last message carries a tool result is answered with text that quotes it.
  - Every "T06-<WORD>" (or T07's "T07-<WORD>") marker in the last user message is quoted after
    "Answering:", so a driver can tell which message an answer belongs to.
Usage: fake-model.py PORT LOG
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import sys
import threading
import time

PORT, LOG = int(sys.argv[1]), sys.argv[2]
lock = threading.Lock()
counter = [0]
failures = {}  # FAKE-APIERR word -> requests answered with the API error so far


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


def already_called(messages, name):
    """Whether an answer in this conversation already called the tool: one call per conversation and tool."""
    return any(p.get('type') == 'tool_use' and p.get('name') == name for m in messages if m.get('role') == 'assistant' for p in parts(m))


def tool_call(last, offered):
    """The tool call a FAKE-BG or FAKE-WAKEUP message asks for, as (name, input), or None."""
    background = re.search(r'FAKE-BG (\d+)', last)
    if background:
        return 'mcp__orbit__bg_run', {'command': f'sleep {background[1]}', 'kind': 'job', 'wakeOnExit': True}
    wakeup = re.search(r'FAKE-WAKEUP (\d+) (\w+)', last)
    if wakeup:
        return 'mcp__orbit__schedule_wakeup', {'delaySeconds': int(wakeup[1]), 'reason': f'T06 lab: scheduled wake {wakeup[2]}',
                                              'prompt': f'T06-WOKE-{wakeup[2].upper()}: the scheduled wakeup came due'}
    return None


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
        if call and already_called(messages, call[0]):
            call = None
        shape = [[m.get('role'), [p.get('type') for p in parts(m)]] for m in messages[-3:]]
        slow = None if results else re.search(r'FAKE-SLOW (\d+)', last)
        apierr = None if results else re.search(r'FAKE-APIERR (\d+) (\w+)', conversation)
        with lock:
            counter[0] += 1
            number = counter[0]
            failing = False
            if apierr and failures.get(apierr[2], 0) < int(apierr[1]):
                failures[apierr[2]] = failures.get(apierr[2], 0) + 1
                failing = True
            kind = 'tool_result_reply' if results else 'api_error' if failing else 'tool_use' if call else 'text'
            with open(LOG, 'a') as log:
                log.write(json.dumps({'n': number, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'path': self.path, 'model': body.get('model'), 'stream': body.get('stream'),
                                      'messages': len(messages), 'lastUser': last[-300:], 'secrets': secrets,
                                      'slow': int(slow[1]) if slow else 0, 'kind': kind, 'tool': call[0] if call else None,
                                      'offered': offered, 'toolResult': results[0][:300] if results else None, 'shape': shape,
                                      'apiErrors': {apierr[2]: failures.get(apierr[2], 0)} if apierr else None}) + '\n')
        if results:
            text = f'FAKE MODEL reply #{number}: tool result received: {results[0][:160]}'
        elif failing:
            # Claude Code's own sentence once its retries of an overloaded provider are spent.
            text = ('API Error: 529 {"type":"error","error":{"type":"overloaded_error",'
                    f'"message":"Overloaded (FAKE MODEL {apierr[2]} {failures[apierr[2]]}/{apierr[1]})"}}}}')
        else:
            text = (f'FAKE MODEL reply #{number}: this conversation has {len(messages)} message(s); '
                    f'secrets seen: {", ".join(secrets) or "none"}.')
            markers = re.findall(r'T0[67]-[A-Z0-9-]+', last)
            if markers:
                text += f' Answering: {" ".join(markers)}'
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
            deadline = time.monotonic() + (int(slow[1]) if slow else 0)
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


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
