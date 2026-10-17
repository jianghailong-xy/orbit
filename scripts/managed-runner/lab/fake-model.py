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


def texts(content):
    if isinstance(content, str):
        return [content]
    return [part.get('text', '') for part in content or [] if isinstance(part, dict) and part.get('type') == 'text']


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
        slow = re.search(r'FAKE-SLOW (\d+)', last)
        with lock:
            counter[0] += 1
            number = counter[0]
            with open(LOG, 'a') as log:
                log.write(json.dumps({'n': number, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'path': self.path, 'model': body.get('model'), 'stream': body.get('stream'),
                                      'messages': len(messages), 'lastUser': last[-300:], 'secrets': secrets,
                                      'slow': int(slow[1]) if slow else 0}) + '\n')
        text = (f'FAKE MODEL reply #{number}: this conversation has {len(messages)} message(s); '
                f'secrets seen: {", ".join(secrets) or "none"}.')
        usage = {'input_tokens': 10, 'output_tokens': 20}
        message = {'id': f'msg_fake_{number}', 'type': 'message', 'role': 'assistant', 'model': body.get('model'),
                   'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
        if not body.get('stream'):
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
