#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native session LIST reads,
# for six sessions in one workspace: five running and one asking the owner a question. All data is
# made up. `POST /__tick` is activity only: five sessions stream (lastTurnAt and the preview line
# move) and nothing the owner would notice changes (listedAt does not). The list is served in
# listedAt order, as the server does.
import json
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
USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "longdeMac-mini.local", "displayName": "longdeMac-mini.local",
          "online": True, "status": "ONLINE", "version": "0.1.120", "maxConcurrent": 4,
          "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}



def listed(minutes_ago):
    return ago(minutes_ago)


# (id, title, run state, pending approvals, listed minutes ago, preview before, preview after)
ROWS = [
    ("S1", "UI copy check", "RUNNING", 0, 22, "streaming...", "editing view..."),
    ("S2", "Agent title position", "RUNNING", 0, 55, "watching CI", "CI 5/7"),
    ("S3", "Runner default workspace", "RUNNING", 0, 62, "watching CI", "CI 3/7"),
    ("S4", "Runner preinstall agent", "RUNNING", 0, 80, "waiting for Mac", "Mac back online"),
    ("S5", "Runner full view", "RUNNING", 0, 95, "rebasing", "tests..."),
    ("S6", "Alert cause", "AWAITING_INPUT", 1, 130, "asks: restart runner?", "asks: restart runner?"),
]
STATE = {"ticked": False}


def reset():
    STATE["ticked"] = False


def sessions():
    out = []
    for i, (sid, title, state, approvals, mins, before, after) in enumerate(ROWS):
        ticked = STATE["ticked"] and sid in ("S3", "S4", "S5", "S2", "S1")
        # Before the tick each row's last activity is its listing time; after it, the older rows
        # streamed most recently, in reverse order of the list.
        turn = ago(len(ROWS) - i) if ticked else ago(mins)
        running = state == "RUNNING"
        row = {"id": sid, "publicId": sid, "title": title, "status": state, "runStatus": state,
               "runState": state, "sessionState": state, "lifecycleState": "OPEN",
               "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude",
               "taskId": None, "projectId": None, "projectTitle": None,
               "pendingApprovals": approvals, "numTurns": 3,
               "createdAt": ago(mins + 5), "updatedAt": turn, "lastTurnAt": turn,
               "listedAt": listed(mins),
               "lastAssistantText": after if ticked else before, "pinnedAt": None}
        if running:
            row["currentTurnStartedAt"] = ago(mins)
            row["engineTurnActive"] = True
        out.append(row)
    return out


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
        if len(parts) >= 2 and parts[:2] == ["api", "sessions"]:
            rest = parts[2:]
            if rest == []:
                return self.send(200, sessions())
            by_id = {s["id"]: s for s in sessions()}
            if rest[0] in by_id:
                sid, more = rest[0], rest[1:]
                if more == []:
                    return self.send(200, by_id[sid])
                # The transcript of a run that never started: nothing, and no further pages.
                if more[0] == "events":
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks"):
                    return self.send(200, {} if more[0] != "owner-items" else {"needsYou": [],
                                                                               "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "projects"] and len(parts) <= 3:
            return self.send(200, [])
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if parts[:1] == ["api"] and len(parts) >= 2 and parts[1] in ("tasks", "task-lists") and len(parts) == 2:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "tasks"] and parts[2:] == ["page"]:
            return self.send(200, {"items": [], "nextCursor": None})
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
        raw, body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__tick"]:
            STATE["ticked"] = True
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, raw))
        # The one press this probe lets through: "Start it again" on the refused run, which is a
        # new run on the task (SR34). Recorded, and answered as the door does.
        if len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "execute":
            STATE["decisions"].append(("execute", parts[2], raw))
            return self.send(201, {"sessionId": "S9", "runId": "R9"})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
    # macOS raises the "Allow "Python" to find devices on local networks?" prompt — over the app
    # being photographed. It sat in the middle of the first Mac picture taken on CI (run
    # 37614770864) and threw the shot away; the crossings probe's stub carries this override and
    # this one was written without it.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
