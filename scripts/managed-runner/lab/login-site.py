#!/usr/bin/env python3
"""A test site with a login, for the managed runner browser's saved logins (docs/runner-browser-design.md §5, §6).

  GET  /login   a password form, its field focused, so a viewer that types the password and Return signs in
  POST /login   the right password sets a persistent cookie (30 days) and goes to /; a wrong one is 403
  GET  /        "Signed in as NAME" with a valid cookie, else "Signed out"

The cookie is NAME.HMAC under a key made at start, so only this process's logins are valid. Every request is logged on
stdout as one JSON line (method, path, signedIn), which is how the lab tells what the runner's Chrome sent. Listens on
127.0.0.1 only: the lab's Pods reach it as 10.0.2.2 through the QEMU user network.

  login-site.py PORT PASSWORD [NAME]
"""
import hashlib
import hmac
import json
import secrets
import sys
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PORT, PASSWORD = int(sys.argv[1]), sys.argv[2]
NAME = sys.argv[3] if len(sys.argv) > 3 else 'erin'
KEY = secrets.token_bytes(32)
COOKIE = 'lab_login'


def token(name):
    return name + '.' + hmac.new(KEY, name.encode(), hashlib.sha256).hexdigest()


def page(title, body):
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title></head>'
            f'<body style="font: 48px sans-serif; margin: 80px">{body}</body></html>').encode()


class Site(BaseHTTPRequestHandler):
    def signed_in(self):
        jar = SimpleCookie(self.headers.get('Cookie', ''))
        value = jar[COOKIE].value if COOKIE in jar else ''
        return value if value and hmac.compare_digest(value, token(value.split('.')[0])) else ''

    def log_line(self, status, signed_in):
        print(json.dumps({'at': time.strftime('%H:%M:%S'), 'method': self.command, 'path': self.path, 'status': status,
                          'signedIn': bool(signed_in)}), flush=True)

    def answer(self, status, body, headers=()):
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        for k, v in headers:
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        who = self.signed_in()
        if self.path == '/login':
            self.answer(200, page('Lab login', '<form method="post" action="/login">Password '
                                  '<input name="password" type="password" autofocus style="font-size: 48px"></form>'))
        elif self.path == '/':
            name = who.split('.')[0]
            self.answer(200, page(f'Signed in as {name}', f'Signed in as {name}') if who else page('Signed out', 'Signed out'))
        else:
            self.answer(404, page('Not found', 'Not found'))
        self.log_line(200 if self.path in ('/', '/login') else 404, who)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        form = parse_qs(self.rfile.read(length).decode())
        if self.path == '/login' and hmac.compare_digest(form.get('password', [''])[0], PASSWORD):
            self.answer(303, b'', [('Location', '/'), ('Set-Cookie', f'{COOKIE}={token(NAME)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax')])
            self.log_line(303, True)
        else:
            self.answer(403, page('Wrong password', 'Wrong password'))
            self.log_line(403, False)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(('127.0.0.1', PORT), Site).serve_forever()
