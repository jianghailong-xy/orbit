#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; adapted from source-refused-native): the session Settings sheet.
# The slice of the Orbit API the native SESSION page reads,
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

TITLES = {"P1": "Session page Settings"}
REF = "refs/heads/project/probe"

TAGS = [{"id": "t-web", "name": "web", "color": "#007AFF", "isSystem": False, "position": 0},
        {"id": "t-review", "name": "needs review", "color": "#FF9500", "isSystem": False, "position": 1}]

SETTINGS = {"env": {"DEBUG": "orbit:*", "LOG_LEVEL": "trace", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000"},
            "workspaceEnv": {"NODE_OPTIONS": "--max-old-space-size=6144", "GOCACHE": "/mnt/data/gocache"},
            "notifyTurnFinished": "inherit", "notifyNeedsYou": "on", "muted": False, "envPendingRestart": True}

SESSIONS = {
    "S1": {
        "id": "S1", "publicId": "S1", "title": "Session page settings", "status": "RUNNING",
        "runStatus": "RUNNING", "runState": "RUNNING", "sessionState": "RUNNING", "lifecycleState": "OPEN",
        "agentId": "a1", "agent": {"id": "a1", "name": "orbit-macos"}, "assignedRunnerId": "r1",
        "provider": "claude", "engine": "claude", "claudeAccount": "a2", "model": "claude-opus-5-5",
        "taskId": None, "projectId": None, "projectTitle": None, "sourceState": "SELECTED",
        "branch": "orbit/session-settings-sheet-26b4d0", "runtimeSessionId": "5f1b2c9e-7d41-4a8e-9a30-1c7e03def5c4",
        "numTurns": 23, "costUsd": 4.37, "tags": TAGS,
        "runClaimedAt": ago(3), "engineStartedAt": ago(3), "currentTurnStartedAt": ago(1),
        "createdAt": "2026-09-28T12:00:00.000Z", "updatedAt": ago(1), "lastTurnAt": ago(1),
        "lastUserText": "Add a Settings entry to the session page.",
    },
}

DETAIL_EXTRA = {
    "workspace": {"id": "a1", "name": "orbit-macos", "workDir": "~/.orbit/worktrees/01a1c927b5e04d7f"},
    "assignedRunner": {"id": "r1", "name": "HPC", "engines": [
        {"engine": "claude", "installed": True, "version": "2.4.1", "auth": "yes",
         "accounts": [{"id": "default"}, {"id": "a2", "name": "Max (2)"}]}]},
    "usage": {"inputTokens": 1710000, "outputTokens": 108000, "cacheReadTokens": 1490000,
              "cacheCreationTokens": 30000, "costUsd": 4.37, "numTurns": 23},
    "engineVersion": "2.4.1",
}

LINK = {"id": "L1", "kind": "SESSION", "token": "k3Rw9Tq2bXa7", "include": {}, "expiresAt": None,
        "revokedAt": None, "viewCount": 3, "lastViewedAt": None, "createdAt": ago(60), "updatedAt": ago(60),
        "state": "ACTIVE", "stateReason": None, "root": {"id": "S1", "title": "Session page settings"}}

STATE = {}


def reset():
    STATE.clear()
    import copy
    STATE.update(decisions=[], settings=copy.deepcopy(SETTINGS), link=dict(LINK))


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


EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools",
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
                    return self.send(200, dict(SESSIONS[sid], settings=STATE["settings"], **DETAIL_EXTRA))
                if more == ["share"]:
                    return self.send(200, {"link": STATE["link"], "counts": {"messages": 12, "toolCalls": 40}})
                # The transcript of a run that never started: nothing, and no further pages.
                if more[0] == "events":
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks"):
                    return self.send(200, {} if more[0] != "owner-items" else {"needsYou": [],
                                                                               "withCoordinator": []})
        if parts == ["api", "session-tags"]:
            return self.send(200, TAGS)
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

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, body = self.body()
        self.note("BODY PATCH %s %s" % (self.path, raw))
        if parts == ["api", "sessions", "S1", "settings"]:
            for k in ("env", "notifyTurnFinished", "notifyNeedsYou", "muted"):
                if k in body:
                    STATE["settings"][k] = body[k] if body[k] is not None else {}
            if "env" in body:
                STATE["settings"]["envPendingRestart"] = True
            return self.send(200, STATE["settings"])
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def do_PUT(self):
        raw, body = self.body()
        self.note("BODY PUT %s %s" % (self.path, raw))
        STATE["link"] = dict(LINK)
        return self.send(200, STATE["link"])

    def do_DELETE(self):
        self.note("DELETE %s" % self.path)
        STATE["link"] = None
        return self.send(204)

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
        if parts == ["api", "sessions", "S1", "restart"]:
            return self.send(202, {"queued": True, "afterTurn": True})
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
