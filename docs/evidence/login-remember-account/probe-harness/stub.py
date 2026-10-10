#!/usr/bin/env python3
"""TEMPORARY evidence probe (see README.md): the few routes the login page talks to.

GET  /api/auth/methods       what the server offers (Google on by default; /__set changes it, or
                             delays the answer, or fails it)
POST /api/auth/login         alex@example.com / "correct horse" signs in; anything else is a 401
GET  /api/users/me           Alex Morgan, with a photo
GET  /api/users/me/avatar    avatar.jpg (made up)
POST /api/auth/logout        the revoke on Sign out
POST /__reset, /__set, /__mark   the test's own controls

Everything else is a 404, logged, so requests.log shows what the page asked for and nothing more.
Nothing here is a real account; all of it is made up.
"""
import json
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HERE = os.path.dirname(os.path.abspath(__file__))
AVATAR = open(os.path.join(HERE, "avatar.jpg"), "rb").read()

PASSWORD = "correct horse"
USER = {
    "id": "u-alex",
    "email": "alex@example.com",
    "name": "Alex Morgan",
    "role": "USER",
    "createdAt": "2026-09-01T08:00:00.000Z",
    "avatarUpdatedAt": "2026-10-10T02:00:00.000Z",
}

DEFAULTS = {"google": True, "googleSignup": False, "methods_delay": 0.0, "methods_status": 200}
state = dict(DEFAULTS)
lock = threading.Lock()


def log(line):
    stamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    with lock, open(LOG, "a") as f:
        f.write(f"{stamp} {line}\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def send(self, status, payload=None, content_type="application/json"):
        data = b""
        if payload is not None:
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        if data:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)
        auth = "bearer" if self.headers.get("Authorization") else "-"
        log(f'"{self.command} {self.path}" {status} auth={auth}')

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/auth/methods":
            with lock:
                delay, status = state["methods_delay"], state["methods_status"]
                answer = {"password": True, "google": state["google"], "googleSignup": state["googleSignup"]}
            if delay:
                log(f'"GET {path}" held {delay}s')
                time.sleep(delay)
            if status != 200:
                return self.send(status, {"error": "unavailable"})
            return self.send(200, answer)
        if path == "/api/users/me":
            return self.send(200, USER)
        if path == "/api/users/me/avatar":
            return self.send(200, AVATAR, "image/jpeg")
        return self.send(404, {"error": "not served by the probe"})

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.body()
        if path == "/__reset":
            with lock:
                state.clear()
                state.update(DEFAULTS)
            return self.send(200, {"ok": True})
        if path == "/__set":
            with lock:
                state.update(json.loads(raw or b"{}"))
            return self.send(200, dict(state))
        if path == "/__mark":
            log(f"=== shot {raw.decode(errors='replace')}")
            return self.send(200, {"ok": True})
        if path == "/api/auth/login":
            creds = json.loads(raw or b"{}")
            # The body is logged without the password: only whether it was the right one.
            ok = creds.get("email") == USER["email"] and creds.get("password") == PASSWORD
            log(f'login attempt email={creds.get("email")} password_ok={ok}')
            if not ok:
                return self.send(401, {"error": "Invalid email or password"})
            return self.send(200, {"accessToken": "probe-access", "refreshToken": "probe-refresh", "user": USER})
        if path == "/api/auth/logout":
            return self.send(204)
        return self.send(404, {"error": "not served by the probe"})


if __name__ == "__main__":
    open(LOG, "a").close()
    log(f"stub on 127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
