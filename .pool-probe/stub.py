#!/usr/bin/env python3
"""TEMPORARY evidence probe (shots branch only; see README.md).

The control plane the real iOS app signs in to: a stub on 127.0.0.1:8787 (the simulator shares the
host's loopback) that answers the reads the new-session draft makes, with the "Team Codex" fixture
the web side is being shot with. It writes the `POST /api/sessions` body it receives to
`<STUB_OUT>/session-create.json` — with `provider: "team-codex"` in it, that file is the evidence the
session was created on the shared pool.

Nothing here is a re-implementation of anything: the app runs unmodified, and this is only the
server's side of the conversation.

env: STUB_OUT (where session-create.json goes, default the working directory), STUB_PORT (8787).
"""
import json
import os
import socketserver
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STUB_PORT", "8787"))
OUT = os.environ.get("STUB_OUT", os.getcwd())


def _id(n):
    return f"0195c0de-0000-7000-8000-{n:012d}"


WIKOVA, ZHANG, CHEN, LIN = _id(1), _id(2), _id(3), _id(4)
POOL_ID, EMPTY_POOL_ID = _id(900), _id(901)
CLAUDE_POOL_ID = _id(800)
AGENT_ID, RUNNER_ID, SESSION_ID = _id(100), _id(200), _id(777)

WINDOW = {"start": "2026-09-01T00:00:00.000Z", "end": "2026-10-01T00:00:00.000Z"}


def spend(cost, others):
    return {"inputTokens": 0, "outputTokens": 0, "costUsd": cost, "othersCostUsd": others}


def person(user_id, name, role, keys, sessions, cost):
    return {"userId": user_id, "name": name, "role": role, "creator": user_id == WIKOVA,
            "you": user_id == WIKOVA, "keys": keys, "sessions": sessions,
            "usage": spend(cost, None)}


def key(n, label, hint, owner, name, others, state="ACTIVE", enabled=True, running=False, next=False):
    return {"id": _id(n), "label": label, "fingerprint": f"sk-…{hint}", "state": state,
            "enabled": enabled, "shareCap": 50,
            "contributor": {"userId": owner, "name": name, "you": owner == WIKOVA},
            "usage": spend(others, others), "running": running, "next": next}


# Team Codex as Wikova reads it — the same fixture the pure probe app draws and the same numbers the
# web side is shot with. The server names orbit-org-1 as the key a session starting now runs on.
TEAM = {
    "id": POOL_ID, "slug": "team-codex", "label": "Team Codex", "engine": "codex",
    "membersCanAdd": True, "ownKeyFirst": True, "viewerRole": "MEMBER", "window": WINDOW,
    "people": [person(WIKOVA, "Wikova", "ADMIN", 2, 23, 34),
               person(ZHANG, "Zhang Min", "MEMBER", 2, 19, 30),
               person(CHEN, "Chen Yu", "MEMBER", 1, 14, 24),
               person(LIN, "Lin Wei", "MEMBER", 0, 6, 12)],
    "keys": [key(11, "orbit-org-1", "AB12", WIKOVA, "Wikova", 12.40, next=True),
             key(12, "orbit-org-2", "7K2P", ZHANG, "Zhang Min", 31.00, running=True),
             key(13, "ios-build", "QZ03", CHEN, "Chen Yu", 50.00),
             key(14, "wikova-backup", "M4T7", WIKOVA, "Wikova", 6.20, state="INVALID"),
             key(15, "zhang-old", "31FD", ZHANG, "Zhang Min", 0.0, enabled=False)],
}

# A pool nobody can start on: the picker greys it out with the server's own words.
EMPTY_POOL = {"id": EMPTY_POOL_ID, "slug": "new-pool", "label": "New pool", "engine": "codex",
              "membersCanAdd": True, "ownKeyFirst": True, "viewerRole": "MEMBER", "window": WINDOW,
              "people": [person(WIKOVA, "Wikova", "ADMIN", 0, 0, 0)], "keys": []}

CLAUDE_POOL = {
    "id": CLAUDE_POOL_ID, "slug": "claude-accounts", "label": "Claude accounts",
    "members": [
        {"id": _id(801), "slug": "anthropic", "label": "jianghailong.rd@Claude",
         "presetSlug": "anthropic", "enabled": True,
         "planUsage": {"provider": "claude", "fiveHour": {"utilization": 18}},
         "state": "AVAILABLE", "next": True},
        {"id": _id(802), "slug": "anthropic-2", "label": "orbitd@Claude",
         "presetSlug": "anthropic", "enabled": True,
         "planUsage": {"provider": "claude", "fiveHour": {"utilization": 62}},
         "state": "AVAILABLE"},
    ],
}

PROVIDERS = [
    {"slug": "anthropic", "label": "jianghailong.rd@Claude", "runtime": "claude",
     "models": [], "presetSlug": "anthropic"},
    {"slug": "anthropic-2", "label": "orbitd@Claude", "runtime": "claude",
     "models": [], "presetSlug": "anthropic"},
    {"slug": "deepseek", "label": "DeepSeek", "runtime": "claude", "models": [],
     "presetSlug": "deepseek"},
]

AGENT = {"id": AGENT_ID, "name": "orbit", "lastProvider": "claude", "permissionMode": "default",
         "effort": "", "workDir": "~/orbit", "runnerId": RUNNER_ID, "enabled": True,
         "description": "the office"}

RUNNER = {
    "id": RUNNER_ID, "name": "wikova", "online": True, "version": "0.1.195",
    "runsAsRoot": False, "activeSessions": 0,
    "runtimeDefaultModels": {"claude": "claude-opus-5", "codex": "gpt-5.6-sol"},
    "engines": [{"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.283"},
                {"engine": "codex", "installed": True, "auth": "yes", "version": "0.48.0"},
                {"engine": "kimi", "installed": True, "auth": "yes", "version": "1.5.0"}],
    "modelCatalog": {
        "claude": [{"value": "claude-opus-5", "label": "Opus 5"},
                   {"value": "claude-sonnet-5", "label": "Sonnet 5"}],
        "codex": [{"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol",
                   "contextWindow": 400000, "reasoningLevels": ["low", "medium", "high"]},
                  {"value": "gpt-5.6", "label": "GPT-5.6", "contextWindow": 400000}],
    },
}


def session(body):
    """The session the stub says it created: on the provider the app asked for."""
    return {
        "id": SESSION_ID,
        "title": (body.get("prompt") or "New session").strip().splitlines()[0][:80],
        "status": "PENDING", "runStatus": "PENDING", "sessionState": "PENDING",
        "runState": "QUEUED", "lifecycleState": "OPEN",
        "agentId": body.get("agentId") or AGENT_ID,
        "assignedRunnerId": RUNNER_ID,
        "provider": body.get("provider") or "claude",
        "model": body.get("model"),
        "permissionMode": body.get("permissionMode"),
        "effort": body.get("effort"),
        "createdAt": "2026-09-28T08:04:00.000Z", "updatedAt": "2026-09-28T08:04:00.000Z",
        "lastTurnAt": "2026-09-28T08:04:00.000Z",
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # The runner is headless: a request log per call would only bury the test output.
    def log_message(self, *args):
        pass

    # --- plumbing ---------------------------------------------------------------

    def _send(self, body, status=200, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _record(self, body):
        path = os.path.join(OUT, "session-create.json")
        with open(path, "w") as fh:
            json.dump(body, fh, indent=2)
        print(f"==> wrote {path}: provider={body.get('provider')!r}", flush=True)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    # --- routes -----------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.endswith("/api/events"):
            return self._sse()
        routes = {
            "/api/users/me": {"id": WIKOVA, "email": "wikova@example.com", "name": "Wikova",
                              "role": "ADMIN", "createdAt": "2026-01-01T00:00:00.000Z"},
            "/api/agents": [AGENT],
            "/api/runners": [RUNNER],
            "/api/providers": PROVIDERS,
            "/api/providers/pools": [CLAUDE_POOL],
            "/api/providers/shared-pools": [TEAM, EMPTY_POOL],
            "/api/sessions": [],
            f"/api/sessions/{SESSION_ID}": session({"provider": "team-codex"}),
            f"/api/sessions/{SESSION_ID}/events/page": {"events": [], "hasMore": False},
            "/api/session-tags": [],
        }
        if path in routes:
            return self._send(routes[path])
        if path.startswith(f"/api/agents/"):
            return self._send(AGENT)
        if path.startswith(f"/api/runners/"):
            return self._send(RUNNER)
        # Every other list read the app makes on its way in (watches, tasks, task lists, projects,
        # wiki, share links): an empty list is an honest answer from a fresh account.
        return self._send([])

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()
        if path == "/api/auth/login":
            return self._send({
                "accessToken": "probe-access-token",
                "refreshToken": "probe-refresh-token",
                "user": {"id": WIKOVA, "email": body.get("email") or "wikova@example.com",
                         "name": "Wikova", "role": "ADMIN"},
            })
        if path == "/api/sessions":
            self._record(body)
            return self._send(session(body))
        return self._send({})

    def do_PATCH(self):
        self._body()
        self._send({})

    def do_PUT(self):
        self._body()
        self._send({})

    def do_DELETE(self):
        self._send({})

    def _sse(self):
        """GET /api/events: an idle control-plane stream, so the app's live channel is simply quiet."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(10)
        except Exception:
            return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # http.server's own server_bind calls getfqdn(), which on macOS 26 raises the "allow Python to
    # find devices on your local network" prompt. Nothing here needs a hostname.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


if __name__ == "__main__":
    print(f"stub control plane on 127.0.0.1:{PORT}, writing to {OUT}", flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
