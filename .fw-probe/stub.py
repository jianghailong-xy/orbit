#!/usr/bin/env python3
# Evidence probe (never merged; see README.md): the slice of the Orbit API the native clients read for an
# account whose machine has no workspace, and what docs/first-workspace-contract.md says about it.
#
#   runners    orbit@austin, in the shape the scene asks for
#   dir-probe  §2: a question is pending for one read, then answered; only the path asked is answered
#   sessions   §3: POST /sessions with assignedRunnerId + newWorkspace makes the workspace, its name the
#              folder's, and the conversation that follows carries createdWorkspace (§3.3)
#
# `POST /__set` picks a scene ({"scene": "bare" | "mixed" | "offline" | "old"}) or signs an engine in
# ({"sign": "claude"}, as a sign-in landing does); `POST /__reset` puts everything back; `GET /__log` is the
# request log with each written body as sorted JSON. Anything not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"

MESSAGE = "Fix the flaky login test in tests/auth — it fails about one run in five on CI."
REPLY = ("I’ll reproduce it first: running the auth tests 20 times in a row to catch the failing case, then "
         "I’ll read the test and the session-expiry code it touches.")


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * 1440), "preferences": {"theme": "system"}}
HOME = "/home/orbit"
PROBES = {
    "~/code/app": {"path": HOME + "/code/app", "exists": True, "isDir": True, "isGit": True, "branch": "main",
                   "isHome": False, "freeBytes": 412000000000},
    "/srv/shared": {"path": "/srv/shared", "exists": True, "isDir": True, "isGit": False, "branch": None,
                    "isHome": False, "freeBytes": 412000000000},
}


def absent(path):
    return {"path": path, "exists": False, "isDir": False, "isGit": False, "branch": None, "isHome": False,
            "freeBytes": None}


STATE = {}


def reset():
    STATE.clear()
    STATE.update(scene="bare", signed=[], workspaces=[], session=None, asked=None, reads=0, turns=[])


reset()


def austin():
    online = STATE["scene"] != "offline"
    return {"id": "austin", "name": "orbit@austin", "displayName": None, "hostname": "austin", "online": online,
            "status": "ONLINE" if online else "OFFLINE", "version": "0.1.240", "maxConcurrent": 16,
            "activeSessions": 0, "lastHeartbeatAt": ago(0), "reposRoot": HOME + "/orbit-repos",
            "registerDir": "~/code/app",
            "capabilities": [] if STATE["scene"] == "old" else ["dir-probe/v1", "create-workdir/v1"],
            "engines": [
                {"engine": "claude", "installed": True, "version": "2.1.302",
                 "auth": "yes" if "claude" in STATE["signed"] else "no"},
                {"engine": "codex", "installed": True, "version": "0.164.0",
                 "auth": "yes" if "codex" in STATE["signed"] else "no"},
            ]}


HPC = {"id": "hpc", "name": "hpc", "displayName": None, "hostname": "workstation", "online": True, "status": "ONLINE",
       "version": "0.1.240", "maxConcurrent": 4, "activeSessions": 0, "lastHeartbeatAt": ago(0), "capabilities": [],
       "engines": [{"engine": "claude", "installed": True, "version": "2.1.302", "auth": "yes"}]}
PAYMENTS = {"id": "payments", "name": "payments-api", "provider": "claude", "lastProvider": "claude", "lastEngine": "claude",
            "runnerId": "hpc", "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/payments-api",
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def runners():
    return [HPC, austin()] if STATE["scene"] == "mixed" else [austin()]


def workspaces():
    return ([PAYMENTS] if STATE["scene"] == "mixed" else []) + STATE["workspaces"]


def session():
    s = STATE["session"]
    workspace = STATE["workspaces"][0]
    return {"id": "S1", "title": "Fix the flaky login test", "status": "RUNNING", "runStatus": "RUNNING",
            "runState": "RUNNING", "lifecycleState": "OPEN", "agentId": workspace["id"],
            "workspaceId": workspace["id"], "agent": workspace, "workspace": workspace,
            "assignedRunnerId": "austin", "engine": s["engine"], "provider": s["provider"], "model": s.get("model"),
            "effort": s.get("effort") or "", "permissionMode": s.get("permissionMode") or "default", "taskId": None,
            "createdAt": ago(1), "updatedAt": ago(0), "lastTurnAt": ago(0), "tags": [], "folderId": None,
            "source": "USER", "pendingApprovals": 0, "engineTurnActive": False, "lastAssistantText": REPLY,
            "createdWorkspace": True}


def events():
    return [
        {"seq": 1, "type": "user", "ts": ago(1), "turnId": "t1", "payload": {"text": STATE["session"]["prompt"]}},
        {"seq": 2, "type": "assistant", "ts": ago(0), "turnId": "t1", "payload": {"text": REPLY, "messageId": "m1"}},
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

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
            return json.loads(raw.decode() or "{}")
        except ValueError:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
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
            return self.stream([])
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "auth", "capabilities"]:
            return self.send(200, {})
        if parts == ["api", "agents"]:
            return self.send(200, workspaces())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [w for w in workspaces() if w["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"statusCode": 404, "message": "no such workspace"})
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in runners() if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"statusCode": 404, "message": "runner not found"})
        if parts == ["api", "runners", "austin", "login"]:
            return self.send(200, {"status": None})
        if parts == ["api", "runners", "austin", "dir-probe"]:
            return self.probe_read(parse_qs(parsed.query).get("path", [""])[0])
        if parts == ["api", "sessions"]:
            query = parsed.query
            if STATE["session"] and "view=completed" not in query and "view=trash" not in query:
                return self.send(200, [session()])
            return self.send(200, [])
        if parts == ["api", "sessions", "counts"]:
            return self.send(200, [])
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "S1"] and STATE["session"]:
            rest = parts[3:]
            if rest == []:
                return self.send(200, session())
            if rest == ["events"]:
                return self.stream(events())
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [])
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def probe_read(self, path):
        """§2.2: pending while the slot names this path, done with its answer after one read, idle otherwise."""
        if STATE["asked"] != path:
            return self.send(200, {"path": path, "status": "idle", "result": None})
        STATE["reads"] += 1
        if STATE["reads"] < 2:
            return self.send(200, {"path": path, "status": "pending", "result": None})
        return self.send(200, {"path": path, "status": "done", "result": PROBES.get(path, absent(path))})

    def stream(self, frames):
        """A session's events as SSE `data:` frames, then keepalives inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for e in frames:
                self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            if "scene" in body:
                STATE["scene"] = body["scene"]
            if "sign" in body:
                STATE["signed"].append(body["sign"])
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if parts == ["api", "runners", "austin", "dir-probe"]:
            if STATE["scene"] == "offline":
                return self.send(400, {"statusCode": 400, "message": "Runner is offline — it can only look while connected"})
            STATE["asked"] = body.get("path")
            STATE["reads"] = 0
            return self.send(201, {"path": STATE["asked"], "status": "pending"})
        if parts == ["api", "runners", "austin", "login"]:
            return self.send(201, {"status": "pending", "engine": body.get("engine")})
        if parts == ["api", "sessions"]:
            return self.create(body)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def create(self, body):
        """§3: the machine and a folder, no workspace; the three made together."""
        folder = body.get("newWorkspace") or {}
        if body.get("agentId") or not body.get("assignedRunnerId") or len([k for k in folder if folder[k]]) != 1:
            return self.send(400, {"statusCode": 400, "message": "newWorkspace needs assignedRunnerId and one folder"})
        engine = body.get("engine")
        if engine not in STATE["signed"]:
            return self.send(409, {"statusCode": 409, "code": "ENGINE_SIGNED_OUT",
                                   "message": "%s is signed out on orbit@austin" % engine})
        work_dir = folder.get("workDir") or HOME + "/orbit-repos/" + folder["newFolder"]
        STATE["workspaces"] = [{"id": "w1", "name": work_dir.rsplit("/", 1)[-1], "provider": body.get("provider"),
                                "lastProvider": body.get("provider"), "lastEngine": engine, "runnerId": "austin",
                                "enabled": True, "enableWorktree": False, "effort": "", "workDir": work_dir,
                                "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
        STATE["session"] = body
        return self.send(201, session())

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if parts == ["api", "agents", "w1"] and STATE["workspaces"]:
            STATE["workspaces"][0]["name"] = body.get("name", STATE["workspaces"][0]["name"])
            return self.send(200, STATE["workspaces"][0])
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def refuse(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

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
