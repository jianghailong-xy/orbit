#!/usr/bin/env python3
"""TEMPORARY evidence probe: the three calls ShareSheet makes, answered for two sessions.

`new` starts unshared, `live` starts shared. GET /api/sessions/:id, POST and DELETE
/api/sessions/:id/share — the owner routes the real sheet reads and writes.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "Qm4kT9vR2mT7wLp4sYb8nZq1Xc6dVh0e"
shared = {"new": None, "live": TOKEN}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _parts(self):
        return self.path.split("?")[0].strip("/").split("/")

    def do_GET(self):
        parts = self._parts()
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            return self._send(200, {"id": parts[2], "shareToken": shared.get(parts[2])})
        self._send(404, {"message": "not found"})

    def do_POST(self):
        parts = self._parts()
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "share":
            shared[parts[2]] = shared.get(parts[2]) or TOKEN
            return self._send(201, {"shareToken": shared[parts[2]], "sharedAt": "2026-09-25T08:00:00.000Z"})
        self._send(404, {"message": "not found"})

    def do_DELETE(self):
        parts = self._parts()
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "share":
            shared[parts[2]] = None
            return self._send(200, {"ok": True})
        self._send(404, {"message": "not found"})

    def log_message(self, fmt, *args):
        print("stub:", self.command, self.path, flush=True)


ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
