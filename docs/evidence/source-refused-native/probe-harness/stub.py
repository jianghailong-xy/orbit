#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native SESSION page reads,
# for three sessions that all produced nothing, each for a different reason:
#
#   S1  a task session whose SOURCE was refused — source_state REFUSED, code BASE_REF_NOT_FOUND,
#       detail {ref, stderr, fixAction FIX_REF} — the project's integration line was never created.
#       The run is FAILED with the code as its error, as the refused-start task lands it.
#   S2  an ordinary session (no task) the reaper ended: error `runner offline`, 0 turns.
#   S3  an ordinary session whose engine is not on the machine: the runner's own install sentence.
#
# Project P1 carries one SOURCE_UNRESOLVED blocker so the project page's card can be photographed.
# Every request is logged with its body; anything not served is a 404 and shows up in not-served.txt.
# All data is made up.
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

TITLES = {"P0": "Coordinator control loop", "P1": "Runner hardening"}

REF = "refs/heads/project/34bZ3i4AvgJaaow5E9tH"
STDERR = "git: fatal: couldn't find remote ref " + REF

SESSIONS = {
    "S1": {
        "id": "S1", "publicId": "S1", "title": "Two-engine pin board: OpenCode row", "status": "FAILED",
        "runStatus": "FAILED", "runState": "FAILED", "sessionState": "FAILED",
        "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude",
        "taskId": "T1", "taskTitle": "Two-engine pin board: OpenCode row",
        "projectId": "P1", "projectTitle": TITLES["P1"],
        "error": "BASE_REF_NOT_FOUND: " + STDERR,
        "sourceState": "REFUSED", "sourceRefusalCode": "BASE_REF_NOT_FOUND",
        "sourceRefusalDetail": {"ref": REF, "refAuthority": "REMOTE", "remoteName": "origin",
                                "stderr": STDERR, "fixAction": "FIX_REF"},
        "runClaimedAt": ago(37), "engineStartedAt": None, "numTurns": 0,
        "createdAt": ago(37), "updatedAt": ago(37),
    },
    "S2": {
        "id": "S2", "publicId": "S2", "title": "把今天的抓取日志拉出来看看", "status": "FAILED",
        "runStatus": "FAILED", "runState": "FAILED", "sessionState": "FAILED",
        "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude",
        "taskId": None, "projectId": None, "projectTitle": None,
        "error": "runner offline",
        "sourceState": "UNBOUND",
        "runClaimedAt": ago(12), "engineStartedAt": None, "numTurns": 0,
        "createdAt": ago(12), "updatedAt": ago(12),
    },
    "S3": {
        "id": "S3", "publicId": "S3", "title": "Try the OpenCode engine on this box", "status": "FAILED",
        "runStatus": "FAILED", "runState": "FAILED", "sessionState": "FAILED",
        "agentId": "a1", "assignedRunnerId": "r1", "provider": "opencode",
        "taskId": None, "projectId": None, "projectTitle": None,
        "error": "OpenCode isn't installed on this runner and installing it failed (exit status 1) "
                 "— run `orbit doctor` on that machine. Tried:  npm install -g opencode-ai",
        "sourceState": "UNBOUND",
        "runClaimedAt": ago(4), "engineStartedAt": None, "numTurns": 0,
        "createdAt": ago(4), "updatedAt": ago(4),
    },
}

STATE = {}


def reset():
    STATE.clear()
    STATE.update(decisions=[])


reset()


def summary(pid, done, total):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for " + TITLES[pid] + ".", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "lastActivityAt": ago(30), "_count": {"tasks": total}, "startedAt": ago(19 * DAY),
            "taskCounts": {"done": done, "failed": 1, "total": total}}


def task(tid, title, status, level=0):
    return {"id": tid, "publicId": tid, "title": title, "status": status, "parentTaskId": None,
            "childCount": 0, "unmetCount": 0, "blocksCount": 0, "topoLevel": level,
            "dependencyState": "READY", "workState": "IDLE", "completionPolicy": "MANUAL",
            "autoRunWhenReady": True}


def criterion(cid, ordinal, text):
    return {"id": cid, "publicId": cid, "key": cid, "ordinal": ordinal, "text": text, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": "A pg spec and a screenshot."}


BLOCKER = {
    "id": "B1", "publicId": "B1", "kind": "SOURCE_UNRESOLVED", "owner": "USER", "severity": "HIGH",
    "requiredAction": "Create the project's integration line, or point its binding at a branch that exists.",
    "subjectTitle": None, "agentArgument": None,
    "detail": {"code": "BASE_REF_NOT_FOUND", "fixAction": "FIX_REF", "ref": REF, "taskIds": ["T1", "T2"]},
    "firstSeenAt": ago(37), "resolvedAt": None, "resolvedBy": None, "resolutionNote": None,
}


def document(pid):
    tasks = [task("T1", "Two-engine pin board: OpenCode row", "FAILED"),
             task("T2", "Both engines' pins in one place", "FAILED"),
             task("T3", "Retire the old pin script", "DONE")]
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Runners stay healthy on their own: a wedged drain restarts, images are pinned, and "
                    "every failure leaves a runbook entry.",
            "instructions": "Probe instructions.", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "coordinatorEnabled": True, "configRevision": "1", "coordinatorSessionId": None,
            "_count": {"tasks": len(tasks)}, "tasksByStatus": {"DONE": 1, "FAILED": 2},
            "acceptanceCriteriaItems": [criterion("34bCrit1", 1, "A wedged drain restarts within a minute.")],
            "blockers": {"open": [BLOCKER] if pid == "P1" else [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


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
                return self.send(200, list(SESSIONS.values()))
            if rest[0] in SESSIONS:
                sid, more = rest[0], rest[1:]
                if more == []:
                    return self.send(200, SESSIONS[sid])
                # The transcript of a run that never started: nothing, and no further pages.
                if more[0] == "events":
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks"):
                    return self.send(200, {} if more[0] != "owner-items" else {"needsYou": [],
                                                                               "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "projects"]:
            rest = parts[2:]
            if not rest:
                return self.send(200, [summary("P1", 1, 3)])
            if rest == ["sidebar"]:
                return self.send(200, [summary("P1", 1, 3)])
            pid = rest[0]
            if pid in TITLES:
                if len(rest) == 1:
                    return self.send(200, document(pid))
                if rest[1:] == ["tasks", "page"]:
                    return self.send(200, {"items": [task("T1", "Two-engine pin board: OpenCode row", "FAILED"),
                                                     task("T2", "Both engines' pins in one place", "FAILED"),
                                                     task("T3", "Retire the old pin script", "DONE")],
                                           "nextCursor": None})
                if rest[1:] == ["open-items"]:
                    return self.send(200, {"needsYou": [], "withCoordinator": []})
                if rest[1:] == ["handoffs"]:
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
