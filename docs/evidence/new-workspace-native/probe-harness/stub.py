#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see README.md): the slice of the Orbit API the iPhone and Mac apps read for
# New workspace on a machine that already has one (docs/mocks/new-workspace-form/02-apple-entry, owner A), adapted from
# docs/evidence/first-workspace-native/probe-harness/stub.py.
#
#   runners    orbit@austin (home /home/orbit, create-workdir/v2) holding the workspace `orbit`, and build-box holding
#              `wiki-site` (scene "two", the default); scene "one" is orbit@austin alone
#   dir-probe  contract §2: a question is pending for one read, then answered; only the path asked is answered.
#              /home/orbit/code/api is a git repository on `main`; anything else is not there
#   agents     POST /api/agents makes the workspace (workDir | newFolder), named as asked, on the machine asked
#
# `POST /__set` picks a scene ({"scene": "one" | "two"}); `POST /__reset` puts everything back; `GET /__log` is the
# request log with each written body as sorted JSON. Anything not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * 1440), "preferences": {"theme": "system"}}
HOME = "/home/orbit"
PROBES = {
    HOME + "/code/api": {"path": HOME + "/code/api", "exists": True, "isDir": True, "isGit": True, "branch": "main",
                         "isHome": False, "freeBytes": 412000000000},
}


def absent(path):
    return {"path": path, "exists": False, "isDir": False, "isGit": False, "branch": None, "isHome": False,
            "freeBytes": None}


STATE = {}
PUSHED = []


def workspace(wid, name, runner, work_dir):
    return {"id": wid, "name": name, "provider": "claude", "lastProvider": "claude", "lastEngine": "claude",
            "runnerId": runner, "enabled": True, "enableWorktree": True, "effort": "", "workDir": work_dir,
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def reset():
    STATE.clear()
    STATE.update(scene="two", made=[], asked={}, reads={})


reset()


def machine(rid, name, host):
    return {"id": rid, "name": name, "displayName": None, "hostname": host, "online": True, "status": "ONLINE",
            "version": "0.1.262", "maxConcurrent": 8, "activeSessions": 0, "lastHeartbeatAt": ago(0),
            "reposRoot": HOME + "/orbit-repos",
            "modelCatalog": {"claude": [{"value": "claude-opus-5-5", "label": "Opus 5.5"}]},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"},
            "capabilities": ["dir-probe/v1", "create-workdir/v1", "create-workdir/v2", "clone-workdir/v1"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.302", "auth": "yes"}]}


def runners():
    austin = machine("austin", "orbit@austin", "austin")
    return [austin] if STATE["scene"] == "one" else [austin, machine("build", "build-box", "build")]


def workspaces():
    base = [workspace("w-orbit", "orbit", "austin", HOME + "/orbit")]
    if STATE["scene"] != "one":
        base.append(workspace("w-wiki", "wiki-site", "build", HOME + "/wiki-site"))
    return base + STATE["made"]

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
            return self.control()
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
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "login":
            return self.send(200, {"status": None})
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "dir-probe":
            return self.probe_read(parts[2], parse_qs(parsed.query).get("path", [""])[0])
        if parts == ["api", "sessions"]:
            return self.send(200, [])
        if parts == ["api", "sessions", "counts"]:
            return self.send(200, [])
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [])
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def probe_read(self, runner, path):
        """§2.2: pending while the slot names this path, done with its answer after one read, idle otherwise."""
        if STATE["asked"].get(runner) != path:
            return self.send(200, {"path": path, "status": "idle", "result": None})
        STATE["reads"][runner] = STATE["reads"].get(runner, 0) + 1
        if STATE["reads"][runner] < 2:
            return self.send(200, {"path": path, "status": "pending", "result": None})
        # The runner expands ~ to its home before it looks.
        looked = HOME + path[1:] if path.startswith("~") else path
        return self.send(200, {"path": path, "status": "done", "result": PROBES.get(looked, absent(looked))})

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

    def control(self):
        """The account's control stream: what is pushed after it joins, keepalives between."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        seen = len(PUSHED)
        ticks = 0
        try:
            while True:
                for frame in PUSHED[seen:]:
                    seen += 1
                    self.wfile.write(("data: %s\n\n" % json.dumps(frame, ensure_ascii=False)).encode())
                    self.note("PUSHED %s to stream %d" % (frame["type"], self.client_address[1]))
                if ticks % 20 == 0:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                ticks += 1
                time.sleep(0.5)
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
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "dir-probe":
            STATE["asked"][parts[2]] = body.get("path")
            STATE["reads"][parts[2]] = 0
            return self.send(201, {"path": body.get("path"), "status": "pending"})
        if parts == ["api", "agents"]:
            return self.create(body)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def create(self, body):
        """POST /workspaces as the setup card sends it: a name, the machine, and one of workDir | newFolder."""
        folders = [k for k in ("workDir", "newFolder", "github") if body.get(k)]
        if not body.get("runnerId") or len(folders) != 1 or not (body.get("name") or "").strip():
            return self.send(400, {"statusCode": 400, "message": "a workspace needs a name, a runner and one folder"})
        work_dir = body.get("workDir") or HOME + "/" + (body.get("newFolder") or "")
        made = workspace("w-made-%d" % (len(STATE["made"]) + 1), body["name"], body["runnerId"], work_dir)
        STATE["made"].append(made)
        PUSHED.append({"type": "agent.changed", "agentId": made["id"], "ts": ago(0),
                       "data": {"workspaceId": made["id"], "affectsTaskRows": False}})
        return self.send(201, made)

    def do_PATCH(self):
        return self.refuse()

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
