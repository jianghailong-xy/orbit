#!/usr/bin/env python3
# Changing-data fake Orbit server for the macOS sidebar crash driver (evidence probe, never merged).
#
# Serves the slice of the API the signed-in macOS shell reads, and keeps changing it: every
# CHURN seconds a background thread flips the workspace/runner shape (a workspace appears or
# leaves a machine, a whole machine with no workspace comes and goes, session rows change), and
# every open control stream gets `agent.changed` events so the app reloads the Workspaces list
# underneath the clicks. The sidebar List is reloaded continuously while the driver switches rows.
#
# Login accepts any email/password and answers real-looking tokens, so the app signs in through
# its own LoginView — this is a server, not a probe hook.
#
# Usage: stub.py [port] [log] [churn-seconds]
import json
import os
import random
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
CHURN = float(sys.argv[3]) if len(sys.argv) > 3 else 0.18
# How long an agents read takes; a wide window keeps a reload in flight under the clicks.
AGENT_DELAY = (float(os.environ.get("AGENT_DELAY_MIN", "0.03")),
               float(os.environ.get("AGENT_DELAY_MAX", "0.20")))
# Optional extra structural churn: the Wiki row appearing and disappearing (the beta.242 row).
WIKI_FLICKER = os.environ.get("WIKI_FLICKER") == "1"


def stamp(minutes=0):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": stamp(90 * DAY), "preferences": {"theme": "system"}}
RUNNERS = {
    "r1": {"id": "r1", "name": "studio.local", "displayName": "studio.local", "online": True,
           "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 4,
           "lastHeartbeatAt": stamp(0), "capabilities": [],
           "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]},
    "r2": {"id": "r2", "name": "mini.local", "displayName": "mini.local", "online": True,
           "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 2,
           "lastHeartbeatAt": stamp(0), "capabilities": [],
           "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]},
}

# The workspace list changes shape underneath the sidebar: `a1` is always there, `a2` joins and
# leaves studio.local, and `a3` is a runner-less (Shared) workspace that appears less often. The
# names never change, so the driver can find each row while the set around it moves.
AGENTS = {
    "a1": {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude",
           "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
           "workDir": "/srv/orbit", "appendSystemPrompt": "", "workDirExists": True,
           "workDirIsGit": True},
    "a2": {"id": "a2", "name": "atlas", "provider": "claude", "lastProvider": "claude",
           "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
           "workDir": "/srv/atlas", "appendSystemPrompt": "", "workDirExists": True,
           "workDirIsGit": True},
    "a3": {"id": "a3", "name": "shared-laptop", "provider": "claude", "lastProvider": "claude",
           "enabled": True, "enableWorktree": True, "effort": "",
           "workDir": "/srv/shared", "appendSystemPrompt": "", "workDirExists": True,
           "workDirIsGit": True},
}


def session(sid, agent, title, status, minutes):
    return {"id": sid, "publicId": sid, "title": title, "status": status,
            "runStatus": status, "runState": status, "sessionState": status,
            "agentId": agent, "assignedRunnerId": "r1", "provider": "claude",
            "taskId": None, "projectId": None, "projectTitle": None,
            "sourceState": "UNBOUND", "numTurns": 2,
            "createdAt": stamp(minutes), "updatedAt": stamp(minutes)}


STATE = {"flip": 0, "changes": 0, "started": stamp(0)}
LOCK = threading.Lock()
STREAMS = []          # open control-stream handlers; the churn thread writes to them
STREAMS_LOCK = threading.Lock()


def mutate():
    """Keep the server's answer different from the last one — that is what reloads the sidebar."""
    while True:
        time.sleep(CHURN)
        with LOCK:
            STATE["flip"] += 1
            STATE["changes"] += 1


def agents_now():
    with LOCK:
        flip = STATE["flip"]
    ids = ["a1"]
    if flip % 2 == 0:
        ids.append("a2")
    if flip % 3 == 0:
        ids.append("a3")
    return [AGENTS[i] for i in ids]


def runners_now():
    with LOCK:
        flip = STATE["flip"]
    out = [RUNNERS["r1"]]
    if flip % 2 == 1:
        out.append(RUNNERS["r2"])
    return out


def sessions_now():
    with LOCK:
        flip = STATE["flip"]
    rows = [session("S1", "a1", "Sidebar crash: click driver", "RUNNING", 3),
            session("S2", "a1", "Audit the retry buttons", "AWAITING_INPUT", 40)]
    if flip % 2 == 0:
        rows.append(session("S3", "a2", "Atlas: first pass", "RUNNING", 7))
    return rows


def summary(pid, n):
    return {"id": pid, "publicId": pid, "title": "Project " + pid, "status": "OPEN",
            "goal": "Probe project.", "createdAt": stamp(20 * DAY), "updatedAt": stamp(1),
            "taskCount": n, "buckets": {"open": n, "done": 0, "failed": 0, "cancelled": 0},
            "lastActivityAt": stamp(1), "attention": None, "integration": None,
            "coordinatorActivity": None, "taskCounts": {"done": 0, "failed": 0, "total": n},
            "doneBy": None, "acceptedGaps": [], "startedAt": None, "startedAtRead": True,
            "mainBranch": "main"}


def task_row(tid, title, status):
    return {"id": tid, "publicId": tid, "title": title, "status": status, "parentTaskId": None,
            "childCount": 0, "unmetCount": 0, "blocksCount": 0, "topoLevel": 0,
            "dependencyState": "READY", "workState": "IDLE", "completionPolicy": "MANUAL",
            "autoRunWhenReady": True}


EMPTY = {"providers", "providers/mine", "providers/pools", "providers/shared-pools",
         "session-tags", "session-folders", "task-lists", "watches", "tasks/active",
         "tasks/counts", "notifications", "share-links", "access-tokens", "managed-runner",
         "runners/enrollment-tokens", "wiki/review", "tasks/evidence-decisions/pending"}


def log(line):
    with open(LOG, "a") as f:
        f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # every request is logged in note(); the default line is noise

    def send(self, status, body=None, headers=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return raw.decode(), json.loads(raw.decode() or "{}")
        except ValueError:
            return raw.decode(errors="replace"), {}

    # -- GET -------------------------------------------------------------------------------------

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        log("GET %s" % self.path)
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
        if parts == ["__state"]:
            with LOCK:
                return self.send(200, dict(STATE))
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "auth", "methods"]:
            return self.send(200, {"password": True, "google": False, "googleSignup": False})
        if parts == ["api", "auth", "setup-status"]:
            return self.send(200, {"needsSetup": False})
        if parts == ["api", "auth", "capabilities"]:
            return self.send(200, {})
        if parts == ["api", "agents"]:
            # The reload the control events drive: a delay so a read is in flight while the
            # driver is switching rows.
            time.sleep(random.uniform(*AGENT_DELAY))
            return self.send(200, agents_now())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            a = AGENTS.get(parts[2])
            return self.send(200, a) if a else self.send(404, {"message": "no such workspace"})
        if parts == ["api", "runners"]:
            return self.send(200, runners_now())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            r = RUNNERS.get(parts[2])
            return self.send(200, r) if r else self.send(404, {"message": "no such runner"})
        if parts == ["api", "sessions"]:
            time.sleep(random.uniform(0.02, 0.12))
            return self.send(200, sessions_now())
        if parts == ["api", "sessions", "counts"]:
            return self.send(200, {})
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, more = parts[2], parts[3:]
            rows = {r["id"]: r for r in sessions_now()}
            if sid in rows:
                if not more:
                    return self.send(200, rows[sid])
                if more[0] in ("events/page", "events"):
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("approvals", "background", "owner-items", "created-tasks",
                               "turns", "move-targets", "retry-message"):
                    return self.send(200, {} if more[0] != "owner-items"
                                     else {"needsYou": [], "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            with LOCK:
                flip = STATE["flip"]
            if WIKI_FLICKER and flip % 4 == 3:
                # The server says this account has no Wiki for a beat: the row leaves and returns.
                return self.send(403, {"statusCode": 403, "code": "WIKI_DISABLED",
                                       "message": "the wiki is off for this account"})
            spaces = [{"id": "w1", "slug": "orbit", "title": "orbit", "pendingOps": flip % 4,
                       "planWaiting": 0, "chatWaiting": 0, "workspaceIds": ["a1"],
                       "createdAt": stamp(30 * DAY), "updatedAt": stamp(1)}]
            if flip % 2 == 0:
                spaces.append({"id": "w2", "slug": "atlas", "title": "atlas", "pendingOps": 0,
                               "planWaiting": 0, "chatWaiting": 0, "workspaceIds": ["a2"],
                               "createdAt": stamp(20 * DAY), "updatedAt": stamp(2)})
            return self.send(200, spaces)
        if len(parts) >= 3 and parts[:2] == ["api", "wiki"] and parts[2] == "spaces":
            return self.send(200, {"id": "w1", "slug": "orbit", "title": "orbit"})
        if parts == ["api", "projects"] or parts == ["api", "projects", "sidebar"]:
            return self.send(200, [summary("P1", 3)])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            pid = parts[2]
            if len(parts) == 3:
                return self.send(200, summary(pid, 3))
            tail = parts[3:]
            if tail == ["tasks", "page"]:
                return self.send(200, {"items": [], "nextCursor": None})
            if tail == ["open-items"]:
                return self.send(200, {"needsYou": [], "withCoordinator": []})
            return self.send(200, [])
        if parts == ["api", "tasks", "page"] or parts == ["api", "tasks"]:
            return self.send(200, {"items": [], "nextCursor": None})
        rel = "/".join(parts[1:]) if len(parts) > 1 else ""
        if rel in EMPTY:
            return self.send(200, [])
        self.send(404, {"statusCode": 404, "code": "PROBE_NOT_SERVED",
                        "message": "the probe does not serve " + self.path})

    def stream(self):
        """Control stream: `agent.changed` often enough that the sidebar reloads under the clicks."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with STREAMS_LOCK:
            STREAMS.append(self)
        try:
            while True:
                body = json.dumps({"type": "agent.changed", "sessionId": "", "agentId": None,
                                   "ts": stamp(0), "data": {"affectsTaskRows": False}})
                self.wfile.write(("data: " + body + "\n\n").encode())
                self.wfile.flush()
                # A project/task nudge too, so the other lists keep reloading.
                other = json.dumps({"type": "project.changed", "sessionId": "", "agentId": None,
                                    "ts": stamp(0)})
                self.wfile.write(("data: " + other + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.30)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            with STREAMS_LOCK:
                if self in STREAMS:
                    STREAMS.remove(self)

    # -- POST ------------------------------------------------------------------------------------

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, body = self.body()
        log("POST %s %s" % (self.path, raw[:300]))
        if parts == ["__reset"]:
            with LOCK:
                STATE["flip"] = 0
                STATE["changes"] = 0
            return self.send(200, {"ok": True})
        if parts == ["api", "auth", "login"]:
            return self.send(201, {"accessToken": "probe-access", "refreshToken": "probe-refresh",
                                   "user": USER})
        if parts == ["api", "auth", "refresh"]:
            return self.send(201, {"accessToken": "probe-access", "refreshToken": "probe-refresh"})
        if parts == ["api", "auth", "logout"]:
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe changes nothing"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # Avoid the reverse lookup that raises the local-network prompt over the app under test.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    threading.Thread(target=mutate, daemon=True).start()
    log("== changing-data stub on 127.0.0.1:%d, churn %.2fs ==" % (PORT, CHURN))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
