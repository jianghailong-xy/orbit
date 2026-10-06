#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads to draw a
# workspace's session list with one project row, that project's sessions page, and the drawer's
# open projects. Workspace a1 (orbit-develop, runner r1) holds a loose session (L1) and project P1's
# coordinator (C1) and one member (M1); workspace a2 (orbit-macos, runner r2) holds a loose session
# (L2) and another P1 member (M2). Read-only: every write is refused. Every request is logged;
# anything not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
PROJECT_TITLE = "Swipe probe project"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]
def runner(rid, name):
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.215", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_CATALOG}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agent(aid, name, rid):
    return {"id": aid, "name": name, "provider": "claude", "lastProvider": "claude", "runnerId": rid,
            "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/" + name,
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


RUNNERS = [runner("r1", "hpc"), runner("r2", "mac-mini")]
AGENTS = [agent("a1", "orbit-develop", "r1"), agent("a2", "orbit-macos", "r2")]
NAMES = {"a1": ("orbit-develop", "r1"), "a2": ("orbit-macos", "r2")}


def session(sid, title, minutes, text, role=None, aid="a1"):
    name, rid = NAMES[aid]
    s = {"id": sid, "title": title, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
         "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": aid,
         "agent": {"id": aid, "name": name}, "assignedRunnerId": rid, "provider": "claude",
         "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
         "projectId": None, "createdAt": ago(minutes + 30), "updatedAt": ago(minutes),
         "lastTurnAt": ago(minutes), "lastAssistantText": text, "pendingApprovals": 0, "tags": [],
         "folderId": None, "source": "USER"}
    if role:
        s["projectMembership"] = {"projectId": "P1", "projectTitle": PROJECT_TITLE, "projectStatus": "OPEN",
                                  "role": role}
    return s


SESSIONS = [
    session("L1", "A loose session", 5, "Nothing to do with the project."),
    session("C1", "Coordinate the swipe probe", 2, "Watching the member.", role="COORDINATOR"),
    session("M1", "Member task of the probe", 3, "Member reply.", role="TASK"),
    session("L2", "Loose session in orbit-macos", 6, "Only orbit-macos lists this.", aid="a2"),
    session("M2", "Member in orbit-macos", 4, "A member that lives in the other workspace.", role="TASK", aid="a2"),
]
PROJECT = {"id": "P1", "title": PROJECT_TITLE, "status": "OPEN", "goal": "Probe the back swipe.",
           "createdAt": ago(90), "updatedAt": ago(2), "lastActivityAt": ago(2), "counts": {"tasks": 3},
           "taskCounts": {"done": 1, "failed": 0, "total": 3}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, RUNNERS)
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in RUNNERS if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "projects"]:
            return self.send(200, [PROJECT])
        if parts == ["api", "projects", "sidebar"]:
            return self.send(200, [PROJECT])
        if parts == ["api", "sessions"]:
            if query.get("view", ["open"])[0] != "open":
                return self.send(200, [])
            if query.get("projectId", [None])[0] == "P1":
                return self.send(200, [s for s in SESSIONS if "projectMembership" in s])
            return self.send(200, SESSIONS)
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream()
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            row = next((s for s in SESSIONS if s["id"] == parts[2]), None)
            rest = parts[3:]
            if row is None:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, row)
            if rest == ["events", "page"]:
                return self.send(200, {"events": [], "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self):
        """An event stream with nothing to say: keepalives inside the clients' 45 s watchdog."""
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

    def refuse(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_POST(self):
        if urlparse(self.path).path == "/__reset":
            return self.send(200, {"ok": True})
        return self.refuse()

    do_PATCH = refuse
    do_PUT = refuse
    do_DELETE = refuse


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
