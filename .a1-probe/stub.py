#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the login page touches, one
# server per port so each launch of the app meets one kind of server:
#   8765  Google on, Google opens accounts (signupPolicy OPEN)       -> button + sign-up line
#   8766  Google on, existing accounts only                          -> button, no sign-up line
#   8767  Google off (GOOGLE_NOT_CONFIGURED)                          -> no button
#   8768  a server from before Google sign-in: /auth/methods is a 404 -> no button
#   8769  Google on, but the exchange refuses GOOGLE_ACCOUNT_NOT_FOUND
# /api/auth/google/start stands in for the server AND Google: it checks what a native client must
# send (client=native, an S256 challenge, a client_state) and answers at once with the 302 the real
# callback ends in, orbit://auth/google?ticket=T&state=<client_state>. The exchange burns the ticket
# and checks S256(codeVerifier) against the challenge before answering like POST /auth/login.
# Every request is logged to the file named on the command line; GET /__log answers what each port
# saw (the UI test reads it), POST /__reset forgets it. All data is made up.
import base64
import hashlib
import json
import re
import secrets
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

LOG = sys.argv[1] if len(sys.argv) > 1 else "requests.log"
PORTS = {
    8765: {"google": True, "googleSignup": True},
    8766: {"google": True, "googleSignup": False},
    8767: {"google": False, "googleSignup": False},
    8768: None,
    8769: {"google": True, "googleSignup": False, "refuse": "GOOGLE_ACCOUNT_NOT_FOUND"},
}
USER = {"id": "u1", "email": "ada@example.com", "name": "Ada Lovelace", "role": "MEMBER",
        "createdAt": "2026-10-06T12:00:00.000Z", "preferences": {"theme": "system"}}
S256 = re.compile(r"^[A-Za-z0-9_-]{43}$")
VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")

LOCK = threading.Lock()
STATE = {}


def reset():
    with LOCK:
        STATE.update(flows={}, seen={str(p): [] for p in PORTS})


reset()


def s256(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s :%d %s\n" % (datetime.now().strftime("%H:%M:%S"), self.server.server_port, fmt % args))

    def note(self, line):
        with LOCK:
            STATE["seen"][str(self.server.server_port)].append(line)
        with open(LOG, "a") as f:
            f.write("%s :%d   %s\n" % (datetime.now().strftime("%H:%M:%S"), self.server.server_port, line))

    def send(self, status, body=None, headers=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    @property
    def mode(self):
        return PORTS[self.server.server_port]

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["__log"]:
            with LOCK:
                return self.send(200, STATE["seen"])
        if parts == ["api", "auth", "methods"]:
            self.note("GET /api/auth/methods")
            if self.mode is None:
                return self.send(404, {"message": "Cannot GET /api/auth/methods", "error": "Not Found", "statusCode": 404})
            return self.send(200, {"password": True, "google": self.mode["google"],
                                   "googleSignup": self.mode["googleSignup"]})
        if parts == ["api", "auth", "google", "start"]:
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            state = q.get("client_state", "")
            ok = q.get("client") == "native" and S256.match(q.get("code_challenge", "")) and 0 < len(state) <= 512
            self.note("START client=%s challenge=%s state=%s -> %s" % (
                q.get("client"), "S256" if S256.match(q.get("code_challenge", "")) else "BAD",
                "present" if state else "MISSING", "ok" if ok else "REFUSED"))
            if not ok:
                return self.send(400, {"message": "not a native start"})
            if self.mode is None or not self.mode["google"]:
                return self.send(302, None, {"Location": "orbit://auth/google?error=GOOGLE_NOT_CONFIGURED&state=" + quote(state, safe="")})
            ticket = secrets.token_urlsafe(32)
            with LOCK:
                STATE["flows"][ticket] = q["code_challenge"]
            return self.send(302, None, {"Location": "orbit://auth/google?ticket=%s&state=%s" % (quote(ticket, safe=""), quote(state, safe=""))})
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["api", "auth", "google", "exchange"]:
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = {}
            ticket, verifier = body.get("ticket", ""), body.get("codeVerifier", "")
            with LOCK:
                challenge = STATE["flows"].pop(ticket, None)  # burned on first presentation
            pkce = challenge is not None and bool(VERIFIER.match(verifier)) and s256(verifier) == challenge
            self.note("EXCHANGE ticket=%s pkce=%s" % ("known" if challenge else "UNKNOWN", "ok" if pkce else "MISMATCH"))
            if not pkce:
                return self.send(400, {"statusCode": 400, "code": "GOOGLE_FLOW_MISMATCH",
                                       "message": "This Google sign-in has expired, was already used, or was started elsewhere — sign in again"})
            if self.mode.get("refuse"):
                return self.send(403, {"statusCode": 403, "code": self.mode["refuse"],
                                       "message": "No Orbit account signs in with this Google account — ask an administrator to create one for your email address"})
            return self.send(201, {"accessToken": "probe-access-" + secrets.token_hex(8),
                                   "refreshToken": "probe-refresh-" + secrets.token_hex(8), "user": USER})
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    servers = [LoopbackServer(("127.0.0.1", port), Handler) for port in PORTS]
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print("stub listening on 127.0.0.1:%s (python %s)" % (",".join(map(str, PORTS)), sys.version.split()[0]), flush=True)
    servers[0].serve_forever()
