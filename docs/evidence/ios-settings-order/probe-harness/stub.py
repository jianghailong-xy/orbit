#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see ../README.md): the slice of the Orbit API the iPhone's
# Settings sheet reads, for one account (Alex) with two machines, one of them offline, so Machines &
# models has something that needs you. Adapted from the session-recap probe's stub
# (docs/evidence/session-recap-native/probe-harness/stub.py).
#
# The account's preferences name the theme, the permission mode (auto) and orchestration (on), and
# leave the other three unset: smart model selection then reads off, suggested replies and session
# recaps on — the defaults a fresh account sees on the Sessions page.
#
# Every request is logged with its body; anything not served is a 404 and shows up in
# not-served.txt. The probe presses no switch, so any write is answered 409 and lands in writes.txt.
# All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "alex@example.com", "name": "Alex", "role": "MEMBER", "createdAt": ago(90 * DAY),
        "preferences": {"theme": "system", "defaultPermissionMode": "auto", "enableOrchestration": True}}
AGENT = {"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def runners():
    # Stamped at request time: the iOS pages call a machine offline once its heartbeat is over 90 s
    # old, and a UI run lasts minutes (the account-swipe probe's lesson).
    online = {"id": "r1", "name": "workstation", "displayName": "workstation", "online": True, "status": "ONLINE",
              "version": "0.1.120", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
              "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
    offline = {"id": "r2", "name": "spare-box", "displayName": "spare-box", "online": False, "status": "OFFLINE",
               "version": "0.1.120", "maxConcurrent": 2, "lastHeartbeatAt": ago(3 * DAY), "capabilities": [],
               "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
    return [online, offline]


# Lists the signed-in shell and the sheet ask for on their own; an empty list is what a new account gets.
EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "projects", "projects/sidebar", "tasks", "skills", "sessions"]


def log(line):
    with open(LOG, "a") as f:
        f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], line))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(fmt % args)

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__log"]:
            try:
                data = open(LOG, "rb").read()
            except OSError:
                data = b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in runners() if r["id"] == parts[2]]
            if found:
                return self.send(200, found[0])
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "share-links"]:
            return self.send(200, {"links": []})
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": []})
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        log("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
        """A control stream with nothing to say: keepalives inside the clients' watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def write_verb(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode(errors="replace") if n else ""
        if parts == ["__reset"]:
            log("RESET (nothing is mutable in this stub)")
            return self.send(200, {"ok": True})
        log("BODY %s %s %s" % (self.command, self.path, raw))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    do_POST = write_verb
    do_PATCH = write_verb
    do_PUT = write_verb
    do_DELETE = write_verb


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name, a reverse lookup that on macOS raises the
    # "find devices on local networks" prompt over the app being photographed.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    log("stub on :%d pid=%d" % (PORT, os.getpid()))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
