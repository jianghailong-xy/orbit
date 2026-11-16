#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native setup card, the conversation's
# first line and Settings -> GitHub read for GitHub workspaces P3 (docs/github-workspace-design.md §8).
#
#   r2   a bare machine that clones (clone-workdir/v1, a Repos Folder): its setup card offers From GitHub.
#   S1   a conversation whose GitHub workspace is cloning (the stream relays 42%).
#   S2   ... whose clone failed with git's own words; S3 the App was removed; S4 the sign-in expired;
#   S5   ... cloned (READY): the created line with the repository; S6 failed with its reason not read yet.
#
# POST /__github {"mode": "disconnected"|"connected"} picks what GET /integrations/github answers.
# All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "ada@example.com", "name": "Ada", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
CLAUDE = [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]
CAPS = ["dir-probe/v1", "create-workdir/v1", "clone-workdir/v1"]


def runners():
    return [
        {"id": "r1", "name": "build-box", "displayName": "build-box", "online": True, "status": "ONLINE",
         "version": "0.1.261", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": CAPS,
         "reposRoot": "/Users/ada/orbit-repos", "engines": CLAUDE},
        {"id": "r2", "name": "studio-mac", "displayName": "studio-mac", "online": True, "status": "ONLINE",
         "version": "0.1.261", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": CAPS,
         "reposRoot": "/Users/ada/orbit-repos", "registerDir": "~", "engines": CLAUDE},
    ]


REPO_URL = "https://github.com/orbit-labs/orbit-web.git"
WORKSPACES = {
    "w1": ("orbit-web", "CLONING", None),
    "w2": ("orbit-web 2", "FAILED", "fatal: could not read from remote repository"),
    "w3": ("orbit-web 3", "FAILED", "Orbit's GitHub App is no longer installed on orbit-labs/orbit-web. Install it again or pick another repository."),
    "w4": ("orbit-web 4", "FAILED", "Your GitHub sign-in expired. Connect GitHub in Settings."),
    "w5": ("orbit-web 5", "READY", None),
    "w6": ("orbit-web 6", "FAILED", None),
}


def agent(wid):
    name, state, error = WORKSPACES[wid]
    return {"id": wid, "name": name, "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
            "enabled": True, "enableWorktree": True, "effort": "",
            "workDir": "/Users/ada/orbit-repos/" + name.replace(" ", "-"),
            "appendSystemPrompt": "", "workDirExists": state == "READY", "workDirIsGit": state == "READY",
            "repoUrl": REPO_URL, "cloneState": state, "cloneError": error}


def session(n):
    wid = "w%d" % n
    a = agent(wid)
    return {"id": "S%d" % n, "publicId": "S%d" % n, "title": "Fix the flaky login test", "status": "PENDING",
            "runStatus": "PENDING", "runState": "QUEUED", "sessionState": "QUEUED",
            "agentId": wid, "assignedRunnerId": "r1", "provider": "claude", "createdWorkspace": True,
            "agent": {"id": wid, "name": a["name"], "provider": None, "model": None, "effort": None,
                      "workDir": a["workDir"], "deletedAt": None, "repoUrl": REPO_URL,
                      "cloneState": a["cloneState"], "cloneError": a["cloneError"]},
            "numTurns": 0, "createdAt": ago(3), "updatedAt": ago(1)}


SESSIONS = {"S%d" % n: session(n) for n in range(1, 7)}
REPOS = [
    ("orbit-labs/orbit-web", True, 12), ("orbit-labs/orbit-api", True, 95), ("ada/dotfiles", False, 60 * 5),
    ("orbit-labs/runner", True, 60 * 30), ("ada/notes", False, 3 * DAY), ("orbit-labs/site", False, 9 * DAY),
    ("orbit-labs/design", True, 20 * DAY), ("ada/advent-2025", False, 40 * DAY), ("orbit-labs/old-cli", False, 300 * DAY),
]


def repos(q):
    rows = [{"id": 1000 + i, "fullName": n, "private": p, "defaultBranch": "main", "installationId": 7 if n.startswith("ada/") else 9,
             "pushedAt": ago(m)} for i, (n, p, m) in enumerate(REPOS)]
    return [r for r in rows if q.lower() in r["fullName"].lower()] if q else rows


def github():
    base = {"available": True, "installUrl": "https://github.com/apps/orbit/installations/new"}
    if STATE["github"] == "disconnected":
        return dict(base, connected=False, login=None, connectedAt=None, needsReconnect=False, installations=[],
                    workspaceCount=0, workspaces=[])
    return dict(base, connected=True, login="ada", connectedAt="2026-11-03T10:00:00.000Z", needsReconnect=False,
                installations=[{"id": 7, "account": "ada", "type": "User", "repositorySelection": "selected", "repositoryCount": 4},
                               {"id": 9, "account": "orbit-labs", "type": "Organization", "repositorySelection": "all", "repositoryCount": 11}],
                workspaceCount=3,
                workspaces=[{"id": "w5", "name": "orbit-web", "machine": "build-box", "repository": "orbit-labs/orbit-web", "cloneState": "READY", "credential": "github-app"},
                            {"id": "w7", "name": "dotfiles", "machine": "studio-mac", "repository": "ada/dotfiles", "cloneState": "READY", "credential": "machine"},
                            {"id": "w1", "name": "orbit-api", "machine": "build-box", "repository": "orbit-labs/orbit-api", "cloneState": "CLONING", "credential": None}])


STATE = {}


def reset():
    STATE.clear()
    STATE.update(github="connected", probes={})


reset()

EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

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
        raw = self.rfile.read(n) if n else b""
        try:
            return raw.decode(), json.loads(raw.decode() or "{}")
        except ValueError:
            return raw.decode(errors="replace"), {}

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        query = parse_qs(url.query)
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
            return self.send(200, [agent(w) for w in WORKSPACES])
        if len(parts) == 3 and parts[:2] == ["api", "agents"] and parts[2] in WORKSPACES:
            return self.send(200, agent(parts[2]))
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            for r in runners():
                if r["id"] == parts[2]:
                    return self.send(200, r)
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "dir-probe":
            path = (query.get("path") or [""])[0]
            taken = path.endswith("/taken") or path.endswith("/orbit-api")
            if path not in STATE["probes"]:
                return self.send(200, {"path": path, "status": "idle"})
            return self.send(200, {"path": path, "status": "done", "result": {
                "path": path, "exists": taken, "isDir": taken, "isGit": taken, "branch": "main" if taken else None,
                "isHome": False, "freeBytes": 100000000000, "error": None}})
        if parts == ["api", "integrations", "github"]:
            return self.send(200, github())
        if parts == ["api", "integrations", "github", "repos"]:
            return self.send(200, {"repositories": repos((query.get("q") or [""])[0]), "nextCursor": None})
        if len(parts) == 6 and parts[:4] == ["api", "integrations", "github", "repos"] and parts[5] == "branches":
            return self.send(200, {"defaultBranch": "main", "branches": ["main", "dev", "release/1.4", "fix/login"]})
        if parts == ["api", "integrations", "github", "start"]:
            return self.send(200, {"authorizationUrl": "https://github.com/login/oauth/authorize?probe=1"})
        if len(parts) >= 2 and parts[:2] == ["api", "sessions"]:
            rest = parts[2:]
            if rest == []:
                return self.send(200, list(SESSIONS.values()))
            if rest[0] in SESSIONS:
                sid, more = rest[0], rest[1:]
                if more == []:
                    return self.send(200, SESSIONS[sid])
                if more == ["events", "page"]:
                    return self.send(200, {"events": [], "hasMore": False})
                if more[0] == "events":
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("turns", "background", "approvals", "schedule-cards"):
                    return self.send(200, [])
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks"):
                    return self.send(200, {} if more[0] != "owner-items" else {"needsYou": [], "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if parts[:2] == ["api", "projects"]:
            return self.send(200, [])
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if parts[:1] == ["api"] and len(parts) == 2 and parts[1] in ("tasks", "task-lists"):
            return self.send(200, [])
        if parts[:2] == ["api", "tasks"] and parts[2:] == ["page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
        """The control stream: keepalives, and S1's clone at 42% (agent.changed names the workspace agentId)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        frame = {"type": "agent.changed", "sessionId": "", "agentId": None, "ts": ago(0),
                 "data": {"agentId": "w1", "clone": {"state": "CLONING", "progress": 42}, "affectsTaskRows": False}}
        try:
            while True:
                self.wfile.write(b"data: " + json.dumps(frame).encode() + b"\n\n")
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(3)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__github"]:
            STATE["github"] = body.get("mode", "connected")
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, raw))
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "dir-probe":
            STATE["probes"][body.get("path", "")] = True
            return self.send(200, {"path": body.get("path", ""), "status": "pending"})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING", "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # The reverse lookup HTTPServer.server_bind does raises macOS's local-network prompt over the app.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
