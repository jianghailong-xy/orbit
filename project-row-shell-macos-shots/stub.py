#!/usr/bin/env python3
"""Local stub control plane for the project-row-shell screenshot probe.

Answers only what the macOS client reads at sign-in and in a workspace's session list, from
fixtures in this file. Never touches a real Orbit server. Every request is logged to the file
named by argv[2].
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOG = open(sys.argv[2], "a", buffering=1) if len(sys.argv) > 2 else sys.stderr

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def iso(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


USER = {"id": "u1", "email": "probe@example.test", "name": "Probe Owner", "role": "OWNER",
        "preferences": {"showRecaps": False}}

AGENT = {"id": "w1", "name": "orbit", "runnerId": "r1", "status": "ONLINE",
         "createdAt": iso(600), "updatedAt": iso(1)}

RUNNER = {"id": "r1", "name": "probe-mac", "status": "ONLINE", "online": True,
          "lastHeartbeatAt": iso(0), "capabilities": [], "engines": []}

FOLDERS = [
    {"id": "f1", "workspaceId": "w1", "name": "Design docs"},
    {"id": "f2", "workspaceId": "w1", "name": "Bug fixes"},
]


def session(sid, title, folder=None, minutes=60, status="SUCCEEDED", membership=None,
            pinned=None):
    row = {
        "id": sid, "title": title, "status": status, "runStatus": status,
        "sessionState": "COMPLETED", "lifecycleState": "OPEN",
        "agentId": "w1", "agent": {"id": "w1", "name": "orbit"},
        "assignedRunnerId": "r1", "engine": "claude",
        "createdAt": iso(minutes), "updatedAt": iso(minutes // 6), "lastTurnAt": iso(minutes // 6),
        "pendingApprovals": 0, "pinnedAt": pinned,
    }
    if folder:
        row["folderId"] = folder
    if membership:
        row["projectMembership"] = membership
    return row


def membership(project, title, role):
    return {"projectId": project, "projectTitle": title, "projectStatus": "OPEN", "role": role}


# A pinned project: its coordinator is pinned, so the whole row sits in Pinned.
PINNED_COORDINATOR = membership("p1", "Session row shell", "COORDINATOR")
# A project with no coordinator at all: its one member is a row of its own, so the project is
# drawn by the coordinator-less item.
TASK_MEMBER = membership("p3", "Coordinator-less project", "TASK")
# A second project, not pinned.
PLAIN_COORDINATOR = membership("p2", "Project row follow-ups", "COORDINATOR")

SESSIONS = [
    session("c1", "Session row shell", minutes=6, membership=PINNED_COORDINATOR, pinned=iso(3)),
    session("c2", "Row follow-ups", minutes=24, membership=PLAIN_COORDINATOR),
    session("m3", "Wire the coordinator-less row", minutes=38, membership=TASK_MEMBER),
    session("s4", "Pinned plain session", minutes=50, pinned=iso(20)),
    session("s5", "Plain session without a pin", minutes=64),
    session("f1s", "Filed in Design docs", folder="f1", minutes=18),
    session("f2s", "Filed in Bug fixes", folder="f2", minutes=30),
    session("x1", "Tune the runner heartbeat", minutes=70),
    session("x2", "Audit the toast stack", minutes=80),
    session("x3", "Replay the console stream", minutes=90),
]
for i, name in enumerate([
    "Patch the diff gutter", "Read the merge queue", "Rename the worktree bar",
    "Sketch the wiki sidebar", "Check the login redirect", "Trim the session row",
]):
    SESSIONS.append(session(f"y{i + 1}", name, minutes=100 + i * 9))

PROJECTS = [
    {"id": "p1", "title": "Session row shell", "status": "OPEN", "workspaceId": "w1",
     "agentId": "w1", "createdAt": iso(900), "updatedAt": iso(5),
     "taskCounts": {"done": 2, "failed": 0, "total": 5}, "buckets": {"running": 0}},
    {"id": "p2", "title": "Project row follow-ups", "status": "OPEN", "workspaceId": "w1",
     "agentId": "w1", "createdAt": iso(900), "updatedAt": iso(20),
     "taskCounts": {"done": 1, "failed": 0, "total": 3}, "buckets": {"running": 0}},
    {"id": "p3", "title": "Coordinator-less project", "status": "OPEN", "workspaceId": "w1",
     "agentId": "w1", "createdAt": iso(900), "updatedAt": iso(30),
     "taskCounts": {"done": 0, "failed": 0, "total": 2}, "buckets": {"running": 0}},
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log(self, method, path, body=""):
        LOG.write(f"{method} {path} {body}\n")

    def do_GET(self):
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        self._log("GET", self.path)
        if path == "/api/users/me":
            return self._send(200, USER)
        if path == "/api/agents":
            return self._send(200, [AGENT])
        if path == "/api/runners":
            return self._send(200, [RUNNER])
        if path == "/api/session-folders":
            return self._send(200, FOLDERS)
        if path == "/api/sessions":
            view = (query.get("view") or ["open"])[0]
            if view == "open":
                return self._send(200, SESSIONS)
            return self._send(200, [])
        if path.startswith("/api/sessions/") and path.count("/") == 3:
            sid = path.rsplit("/", 1)[1]
            for row in SESSIONS:
                if row["id"] == sid:
                    return self._send(200, row)
            return self._send(404, {"error": "nope"})
        if path == "/api/sessions/counts":
            return self._send(200, {"open": len(SESSIONS), "completed": 0, "trash": 0})
        if path == "/api/projects/sidebar":
            return self._send(200, PROJECTS)
        if path == "/api/projects":
            return self._send(200, PROJECTS)
        if path.startswith("/api/projects/"):
            return self._send(404, {"error": "nope"})
        if path.startswith("/api/"):
            return self._send(200, [])
        return self._send(404, {"error": "nope"})

    def do_POST(self):
        url = urlparse(self.path)
        path = url.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self._log("POST", self.path, raw.decode(errors="replace"))
        if path == "/api/auth/login":
            return self._send(200, {"accessToken": "probe-token", "refreshToken": "probe-refresh",
                                    "user": USER})
        if path.startswith("/api/sessions/") and path.endswith("/move"):
            sid = path.split("/")[3]
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            for row in SESSIONS:
                if row["id"] == sid:
                    if body.get("folderId"):
                        row["folderId"] = body["folderId"]
                    else:
                        row.pop("folderId", None)
                    LOG.write(f"MOVED {sid} -> {body.get('folderId')}\n")
                    return self._send(200, {"ok": True})
            return self._send(404, {"error": "nope"})
        return self._send(200, {})

    def do_PATCH(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self._log("PATCH", self.path, raw.decode(errors="replace"))
        return self._send(200, {})

    def do_DELETE(self):
        self._log("DELETE", self.path)
        return self._send(200, {})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    LOG.write(f"STUB LISTENING {PORT}\n")
    server.serve_forever()
