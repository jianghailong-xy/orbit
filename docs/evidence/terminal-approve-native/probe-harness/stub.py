#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged into the app): the slice of the Orbit API the iPhone app reads
# signed in, plus the terminal doors (docs/terminal-session-design.md):
#
#   GET  /api/terminals/requests            one pending request: dev-laptop, code 7KQ-4MZ
#   POST /api/terminals/requests/:id/approve|deny   recorded; the request leaves the list
#   GET  /api/terminals                     two live terminals: dev-laptop and HPC
#   DELETE /api/terminals/:id               recorded; the terminal leaves the list
#
# Every request is logged with its body; anything not served is a 404 and shows up in not-served.txt.
# POST /__reset puts the state back. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": at(-90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "build-box", "displayName": "build-box",
          "online": True, "status": "ONLINE", "version": "0.1.254", "maxConcurrent": 4,
          "lastHeartbeatAt": at(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "shop-api", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/home/dev/code/shop-api",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

STATE = {}


def reset():
    STATE.clear()
    STATE.update(
        requests=[{"id": "34req1", "userCode": "7KQ-4MZ", "machineName": "dev-laptop", "runnerId": "r1",
                   "createdAt": at(-1), "expiresAt": at(9)}],
        terminals=[
            {"id": "34term1", "machineName": "dev-laptop", "runnerId": "r1", "createdAt": at(-2 * DAY),
             "approvedAt": at(-2 * DAY), "lastUsedAt": at(-3), "expiresAt": at(28 * DAY)},
            {"id": "34term2", "machineName": "HPC", "runnerId": "r2", "createdAt": at(-DAY),
             "approvedAt": at(-DAY), "lastUsedAt": None, "expiresAt": at(29 * DAY)},
        ],
        decisions=[],
    )


reset()

EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "projects", "projects/sidebar", "sessions", "wiki/spaces", "share-links", "access-tokens"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        self.note(fmt % args)

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return (self.rfile.read(n) if n else b"").decode(errors="replace")

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
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts == ["api", "terminals", "requests"]:
            return self.send(200, {"requests": STATE["requests"]})
        if parts == ["api", "terminals"]:
            return self.send(200, {"terminals": STATE["terminals"]})
        if parts == ["api", "owner-requests"]:
            return self.send(200, {"requests": []})
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": []})
        if parts == ["api", "share-links"]:
            return self.send(200, {"links": []})
        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        if parts[:1] == ["api"] and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        self.note("NOT SERVED %s" % self.path)
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

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY POST %s %s" % (self.path, raw))
        if len(parts) == 5 and parts[:3] == ["api", "terminals", "requests"] and parts[4] in ("approve", "deny"):
            rid, verb = parts[3], parts[4]
            STATE["decisions"].append((verb, rid))
            STATE["requests"] = [r for r in STATE["requests"] if r["id"] != rid]
            return self.send(200, {"id": rid, "status": "APPROVED" if verb == "approve" else "DENIED",
                                   "machineName": "dev-laptop", "userCode": "7KQ-4MZ", "decidedAt": at(0)})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.note("BODY DELETE %s" % self.path)
        if len(parts) == 3 and parts[:2] == ["api", "terminals"]:
            tid = parts[2]
            gone = [t for t in STATE["terminals"] if t["id"] == tid]
            STATE["terminals"] = [t for t in STATE["terminals"] if t["id"] != tid]
            if not gone:
                return self.send(404, {"statusCode": 404, "message": "terminal not found"})
            return self.send(200, dict(gone[0], revokedAt=at(0)))
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # No reverse lookup of our own name: on macOS it raises a local-network prompt over the app.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
