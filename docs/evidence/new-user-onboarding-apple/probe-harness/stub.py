#!/usr/bin/env python3
# Evidence probe (never merged; see README.md): the slice of the Orbit API the native clients read as a new
# account first signs in (docs/mocks/new-user-onboarding). Scenes (`POST /__set {"scene": …}`):
#
#   managed        the server offers managed runners; the owner's is preparing (shared fixture
#                  "preparing: requested"), its default workspace mapped, its runner row offline
#   managed-up     the same runner READY ("available"), online, Claude Code installed and signed out
#   managed-ready  the same, Claude Code signed in
#   bare           no managed runners; one machine, mia-macbook, online, with no workspace
#   none           no managed runners and no machine at all
#
# `{"history": true}` gives the account one Completed session (and the Open list stays empty): the account is
# not new, and every page must read as it did before. `POST /__reset` puts everything back; `GET /__log` is the
# request log. Anything not served is a 404; any other write is refused. All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = json.load(open(os.path.join(HERE, "..", "src", "shared", "src", "managed-runner-states.fixture.json")))


def fixture(name):
    return [s for s in FIXTURE["states"] if s["name"] == name][0]["status"]


PREPARING = fixture("preparing: requested")
AVAILABLE = fixture("available")
MANAGED_RUNNER = PREPARING["runnerId"]
DEFAULT_WORKSPACE = PREPARING["workspaceId"]
assert AVAILABLE["runnerId"] == MANAGED_RUNNER and AVAILABLE["workspaceId"] == DEFAULT_WORKSPACE


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


USER = {"id": "u1", "email": "mia@example.com", "name": "Mia Chen", "role": "MEMBER",
        "createdAt": ago(5), "preferences": {"theme": "system"}}
STATE = {}


def reset():
    STATE.clear()
    STATE.update(scene="none", history=False)


reset()


def managed():
    return STATE["scene"].startswith("managed")


def engines(signed):
    return [{"engine": "claude", "installed": True, "version": "2.1.302", "auth": "yes" if signed else "no"},
            {"engine": "codex", "installed": True, "version": "0.164.0", "auth": "no"}]


def machine(rid, name, online, signed):
    return {"id": rid, "name": name, "displayName": None, "hostname": name, "online": online,
            "status": "ONLINE" if online else "OFFLINE", "version": "0.1.250", "maxConcurrent": 4,
            "activeSessions": 0, "lastHeartbeatAt": ago(0) if online else None, "reposRoot": "/home/mia/orbit-repos",
            "registerDir": None, "capabilities": ["dir-probe/v1", "create-workdir/v1"] if online else [],
            "modelCatalog": {"claude": [{"value": "claude-opus-5-5", "label": "Opus 5.5"}]} if online else None,
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"} if online else None,
            "engines": engines(signed) if online else None}


def runners():
    scene = STATE["scene"]
    if scene == "managed":
        return [machine(MANAGED_RUNNER, "managed-mia", False, False)]
    if scene == "managed-up":
        return [machine(MANAGED_RUNNER, "managed-mia", True, False)]
    if scene == "managed-ready":
        return [machine(MANAGED_RUNNER, "managed-mia", True, True)]
    if scene == "bare":
        return [machine("austin", "mia-macbook", True, False)]
    return []


def workspaces():
    if not managed():
        return []
    return [{"id": DEFAULT_WORKSPACE, "name": "default", "provider": "claude", "lastProvider": "claude",
             "lastEngine": "claude", "runnerId": MANAGED_RUNNER, "enabled": True, "enableWorktree": False,
             "effort": "", "workDir": "/home/orbit/default", "appendSystemPrompt": "", "workDirExists": True,
             "workDirIsGit": False}]


def status():
    return PREPARING if STATE["scene"] == "managed" else AVAILABLE


def old_session():
    return {"id": "S0", "title": "Rename the photos by date", "status": "COMPLETED", "runStatus": "COMPLETED",
            "runState": "COMPLETED", "lifecycleState": "COMPLETED", "agentId": "gone", "workspaceId": "gone",
            "engine": "claude", "provider": "claude", "model": None, "effort": "", "permissionMode": "default",
            "taskId": None, "createdAt": ago(3 * 1440), "updatedAt": ago(3 * 1440), "lastTurnAt": ago(3 * 1440),
            "completedAt": ago(3 * 1440), "tags": [], "folderId": None, "source": "USER", "pendingApprovals": 0,
            "engineTurnActive": False, "lastAssistantText": "Done."}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def send(self, status_code, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status_code)
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
        query = parse_qs(parsed.query)
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
            return self.control()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "auth", "capabilities"]:
            return self.send(200, {"managedRunners": {"enabled": True, "contractVersion": 1}} if managed() else {})
        if parts == ["api", "managed-runner"]:
            return self.send(200, status()) if managed() else self.send(404, {"statusCode": 404, "message": "off"})
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
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "login":
            return self.send(200, {"status": None})
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            if STATE["history"] and view == "completed":
                return self.send(200, [old_session()])
            return self.send(200, [])
        if parts == ["api", "sessions", "counts"]:
            return self.send(200, [])
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [])
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def control(self):
        """The account's control stream: keepalives only."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
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
            for key in ("scene", "history"):
                if key in body:
                    STATE[key] = body[key]
            return self.send(200, {"ok": True})
        with open(LOG, "a") as f:
            f.write("%s BODY %s %s\n" % (datetime.now().strftime("%H:%M:%S"), self.path,
                                         json.dumps(body, sort_keys=True, ensure_ascii=False)))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def refuse(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PUT = refuse
    do_PATCH = refuse
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
